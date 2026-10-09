// The MSE player's live-edge rule: a seek forward is made for drift, never for
// the lag a pipeline needs in order to run at all.
//
// This one is here because the failure looks like a slow camera. Chrome's
// hardware H.264 decoder sizes its reorder window from the SPS, and a stream
// whose SPS carries no bitstream_restriction gets the level's whole DPB -- 16
// frames on the level 5.1 1080p an Ingenic T31 emits, 1.7 s at the ~9 fps it
// delivers. The old rule seeked whenever the buffer ran more than 1.0 s ahead
// of the playhead; each seek flushed a decoder that had not yet produced a
// frame, and the picture arrived only when an IDR flushed the DPB, once per
// GOP. Measured on the lab T31 in Chrome with VA-API: 12 frames and 46 seeks in
// 46 s, while WebRTC from the same camera played from the first second. The
// HiSilicon beside it never showed it -- its 7-frame window is 0.35 s at 20 fps
// -- so nothing in the lab reproduces this without a T31 and a GPU, and a
// browser reports nothing at all: readyState sits at HAVE_METADATA, and every
// seek is one the page asked for.
//
// The pipeline is modelled by two numbers: D, the lag a decoder and renderer
// need before a frame is on screen (the playhead advances only when the
// buffer's end is D past it), and a stall or a refused play(), which hold the
// playhead still without being the pipeline's doing.
//
// The same file covers the catch-up below that budget (majestic-webui#644):
// the excess a start leaves in the buffer is drained by playbackRate, never by
// a seek. In the model the playhead advances by a fragment's duration times
// the rate, but never past end - D; reaching that bound while playing fast is
// a starved element, which fires 'waiting' as a browser does -- and, as
// Chromium does on a thin buffer, the model also fires it for no reason at all
// when asked to (env.spurious), because catch-up must not read it as a verdict.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const SRC = path.join(__dirname, '..', 'www', 'a', 'preview.js');
const tick = () => new Promise((r) => setTimeout(r, 0));

function load(opts) {
	opts = opts || {};
	const env = { sockets: [], seeks: [], seekEnds: [], start: 0, end: 0, ct: 0, refuse: false };
	// The player resets this element in place on every (re)connect (freshVideo
	// clears src/srcObject and reloads); it is never cloned or replaced, so the
	// single node the test holds is the one the player keeps using.
	env.video = {
		muted: false, volume: 1, src: '', srcObject: null, paused: true, playbackRate: 1,
		videoWidth: 1920, videoHeight: 1080,
		buffered: {
			get length() { return env.end > 0 ? 1 : 0; },
			start() { return env.start; },
			end() { return env.end; },
		},
		get currentTime() { return env.ct; },
		set currentTime(t) { env.seeks.push(+t.toFixed(2)); env.seekEnds.push(env.end); env.ct = t; },
		handlers: {},
		addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); },
		removeEventListener() {},
		removeAttribute() {}, load() {},
		play() {
			if (env.refuse) return Promise.reject(new Error('NotAllowedError'));
			this.paused = false;
			return Promise.resolve();
		},
		getVideoPlaybackQuality() { return { totalVideoFrames: 0, droppedVideoFrames: 0 }; },
	};
	const MediaSourceStub = function () {
		const ms = {
			readyState: 'open', listeners: {},
			addEventListener(ev, fn) { ms.listeners[ev] = fn; },
			addSourceBuffer() {
				return { updating: false, mode: '', buffered: { length: 0 },
					addEventListener() {}, appendBuffer() {}, remove() {}, abort() {} };
			},
			removeSourceBuffer() {}, endOfStream() {},
		};
		env.ms = ms;
		return ms;
	};
	MediaSourceStub.isTypeSupported = () => true;
	const win = { MediaSource: MediaSourceStub };
	const ctx = {
		window: win, MediaSource: MediaSourceStub,
		WebSocket: function (url) {
			const s = { url, readyState: 1, onopen: null, onmessage: null, onclose: null, onerror: null,
				close() { this.readyState = 3; },
				fire(ev, arg) { const h = this['on' + ev]; if (h) h(arg); } };
			env.sockets.push(s);
			return s;
		},
		URL: { createObjectURL: () => 'blob:stub', revokeObjectURL() {} },
		location: { protocol: 'http:', host: 'camera' },
		console, JSON, Promise, Math,
		setTimeout, clearTimeout, setInterval, clearInterval, Uint8Array,
	};
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx);
	env.player = win.MajesticVideo.attach(env.video, { onState() {} });
	const s = env.sockets[0];
	s.fire('open');
	s.fire('message', { data: JSON.stringify({ type: 'init', codec: 'h264', codecString: 'avc1.4d0033', width: 1920, height: 1080 }) });
	env.ms.listeners.sourceopen();

	// One fragment from the camera: 0.1 s more in the buffer. Then the
	// pipeline: unless held, the playhead advances by the same 0.1 s -- at
	// real time, never faster, which is why a stall's lost seconds stay
	// lost -- but only while the buffer's end is D past it.
	env.D = opts.D === undefined ? 0.3 : opts.D;
	// F: one fragment's duration. startAfter: fragments that arrive before the
	// playhead first moves -- what play() and the first decode take, and the
	// excess a start leaves in the buffer.
	env.F = opts.F || 0.1;
	let startAfter = opts.startAfter | 0;
	env.hold = false;
	env.stalls = 0; env.fastFrags = 0;
	env.frag = async function () {
		env.end = +(env.end + env.F).toFixed(4);
		const rate = env.video.playbackRate;
		if (rate > 1) env.fastFrags++;
		let starved = false;
		if (startAfter > 0) startAfter--;
		else if (!env.hold && !env.refuse && env.end - env.D > env.ct) {
			const want = env.ct + env.F * rate, lim = env.end - env.D;
			starved = rate > 1 && want > lim + 1e-9;
			env.ct = +Math.min(want, lim).toFixed(4);
		}
		s.fire('message', { data: new ArrayBuffer(8) });
		if (env.spurious && rate > 1) starved = true;
		if (starved) {
			env.stalls++;
			(env.video.handlers.waiting || []).forEach((fn) => fn());
		}
		await tick();
	};
	env.frags = async function (n) { for (let i = 0; i < n; i++) await env.frag(); };
	return env;
}

(async () => {
	group('a pipeline that has shown nothing is not seeked');
	{
		// The T31 under Chrome's hardware decoder: 3 s of buffer arrive and the
		// playhead never moves. The old rule seeked at 1.0 s and every second
		// after, and each seek was the reason the playhead never moved.
		const env = load({ D: Infinity });
		await env.frags(30);
		check('buffer ran 3 s ahead', env.end === 3, env.end + '');
		check('no seek was made', env.seeks.length === 0, JSON.stringify(env.seeks));
	}

	group('the lag a pipeline runs at is learned, not cut every second');
	{
		// A 2.0 s pipeline: the first frames are 2 s behind the buffer, and
		// that is the floor -- the old rule seeked once a second for it, and
		// each seek was another 2 s of nothing.
		const env = load({ D: 2.0 });
		await env.frags(125);
		check('never seeked', env.seeks.length === 0, JSON.stringify(env.seeks));
		check('playing 2 s behind', +(env.end - env.ct).toFixed(2) === 2 && env.ct > 5, env.end + ' ' + env.ct);
	}

	group('drift is still cut');
	{
		const env = load({ D: 0.3 });
		await env.frags(30);
		check('a 0.3 s pipeline is within budget: no seek', env.seeks.length === 0, JSON.stringify(env.seeks));
		// A stall: 1.5 s of fragments arrive while the playhead is held.
		env.hold = true;
		await env.frags(15);
		env.hold = false;
		await env.frags(3);
		check('playback resumed 1.8 s behind and was seeked once', env.seeks.length === 1, JSON.stringify(env.seeks));
		check('to the live edge', env.seeks[0] === +(env.seekEnds[0] - 0.1).toFixed(2), env.seeks[0] + ' vs end ' + env.seekEnds[0]);
		await env.frags(30);
		check('and settled there', env.seeks.length === 1 && +(env.end - env.ct).toFixed(2) === 0.3, JSON.stringify(env.seeks) + ' lag ' + (env.end - env.ct).toFixed(2));
	}

	group('a start refused autoplay is not learned as the pipeline\'s lag');
	{
		const env = load({ D: 0.3 });
		env.refuse = true;
		await env.frags(25);
		check('nothing moved while play() was refused', env.ct === 0 && env.seeks.length === 0, env.ct + ' ' + JSON.stringify(env.seeks));
		env.refuse = false;
		await env.frags(3);
		check('the click\'s first frames were 2.5 s behind: seeked once', env.seeks.length === 1, JSON.stringify(env.seeks));
		await env.frags(30);
		check('then within budget, no more', env.seeks.length === 1 && +(env.end - env.ct).toFixed(2) === 0.3, JSON.stringify(env.seeks) + ' lag ' + (env.end - env.ct).toFixed(2));
	}

	group('a playhead outside the buffer is moved whether or not it was moving');
	{
		const env = load({ D: Infinity });
		await env.frags(20);
		env.start = 1.0;
		await env.frag();
		check('under the buffer start: seeked', env.seeks.length === 1 && env.seeks[0] >= 1.0, JSON.stringify(env.seeks));
	}

	group('the excess a start leaves is drained by playing fast, not seeked (#644)');
	{
		// Chromium on a gk7205v300 at 1080p55: a decoder that needs ~20 ms,
		// and a start that left ~80 ms more in the buffer. At 1x the old rule
		// kept that 80 ms for the whole session.
		const env = load({ D: 0.02, F: 0.02, startAfter: 4 });
		await env.frags(5);
		const first = +(env.end - env.ct).toFixed(3);
		await env.frags(200);
		const last = +(env.end - env.ct).toFixed(3);
		check('started well behind', first >= 0.08, first + '');
		check('played fast to drain it', env.fastFrags > 0, env.fastFrags + '');
		check('down to the target', last <= 0.05 + 0.02, last + '');
		check('back at 1x', env.video.playbackRate === 1, env.video.playbackRate + '');
		check('without a seek or a stall', env.seeks.length === 0 && env.stalls === 0, JSON.stringify(env.seeks) + ' stalls ' + env.stalls);
	}

	group('underruns while draining do not stop the drain');
	{
		// Chromium: a 'waiting' on every few fragments while the buffer is
		// thin, frames shown all the same.
		const env = load({ D: 0.02, F: 0.02, startAfter: 4 });
		env.spurious = true;
		await env.frags(200);
		check('stalls were reported', env.stalls > 0, env.stalls + '');
		check('drained to the target all the same', +(env.end - env.ct).toFixed(3) <= 0.07, (env.end - env.ct).toFixed(3));
	}

	group('a pipeline that needs its lag is left alone once that is clear');
	{
		// The T31 under a hardware decoder: 2 s behind by necessity. Playing
		// fast gains nothing; after one window of no progress, 1x for good.
		const env = load({ D: 2.0 });
		await env.frags(60);
		check('tried, briefly', env.fastFrags > 0 && env.fastFrags <= 30, env.fastFrags + '');
		check('at 1x since', env.video.playbackRate === 1, env.video.playbackRate + '');
		const tried = env.fastFrags;
		await env.frags(100);
		check('and never again', env.fastFrags === tried, env.fastFrags + ' vs ' + tried);
		check('never seeked', env.seeks.length === 0, JSON.stringify(env.seeks));
		check('playing 2 s behind', +(env.end - env.ct).toFixed(2) === 2, (env.end - env.ct).toFixed(2));
	}

	group('a rebuild does not inherit a catch-up');
	{
		const env = load({ D: 0.02, F: 0.02, startAfter: 4 });
		await env.frags(6);
		check('catching up', env.video.playbackRate > 1, env.video.playbackRate + '');
		// A reconnect: the socket closes and the pipeline is torn down.
		env.sockets[0].fire('close', {});
		check('back at 1x', env.video.playbackRate === 1, env.video.playbackRate + '');
	}

	done();
})();
