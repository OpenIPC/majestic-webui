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
	function node() {
		const v = {
			muted: false, volume: 1, src: '', paused: true,
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
			cloneNode() { return node(); },
			getVideoPlaybackQuality() { return { totalVideoFrames: 0, droppedVideoFrames: 0 }; },
		};
		v.parentNode = { replaceChild(fresh) { env.video = fresh; } };
		return v;
	}
	env.video = node();
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
	env.hold = false;
	env.frag = async function () {
		env.end = +(env.end + 0.1).toFixed(2);
		if (!env.hold && !env.refuse && env.end - env.D > env.ct)
			env.ct = +Math.min(env.ct + 0.1, env.end - env.D).toFixed(2);
		s.fire('message', { data: new ArrayBuffer(8) });
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

	done();
})();
