// The MSE player's socket lifecycle: exactly one /ws/video session per player,
// no matter which door the reconnect came through.
//
// This one is here because the failure is invisible from the browser. A socket
// nobody closes goes on being served: the camera keeps encoding for it, keeps
// sending to it, and keeps counting it among the viewers it has. The tab shows
// a picture the whole time — the *new* session's picture — so the only place
// the damage is visible is the camera's own client count, and by the time
// anyone reads that, the link is carrying five copies of the stream and the
// blinking that started it has become self-inflicted (majestic-webui#298: ten
// sessions for one viewer, one per blink).
//
// Neither path below can be reproduced on demand in a browser. One needs the
// decoder to raise an error, which needs a stream damaged in transit; the
// other needs a close handshake slower than 300 ms, which needs a bad link.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const SRC = path.join(__dirname, '..', 'www', 'a', 'preview.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A socket that records what was done to it. `closed` and the handler slots
// are the whole subject: a discarded socket must be shut AND silenced.
function makeSockets(env) {
	return function WebSocketStub(url) {
		const s = {
			url: url, readyState: 1, closed: false, binaryType: '',
			onopen: null, onmessage: null, onclose: null, onerror: null,
			close() { this.closed = true; this.readyState = 3; },
			// Deliver an event the way the browser would: through whatever
			// handler is attached *now*. A silenced socket has none, which is
			// exactly what the second group is checking.
			fire(ev, arg) { const h = this['on' + ev]; if (h) h(arg); },
			silent() {
				return !this.onopen && !this.onmessage &&
					!this.onclose && !this.onerror;
			},
		};
		env.sockets.push(s);
		return s;
	};
}

// The element the player owns. freshVideo() clones and replaces it on every
// (re)connect, so the test has to follow the current node the same way the DOM
// does — anything holding the first one is holding a detached node.
function makeVideo(env) {
	function node() {
		const v = {
			muted: false, volume: 1, src: '', paused: false,
			videoWidth: 1280, videoHeight: 720,
			buffered: { length: 0 },
			handlers: {},
			addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); },
			removeEventListener(ev, fn) {
				this.handlers[ev] = (this.handlers[ev] || []).filter((f) => f !== fn);
			},
			removeAttribute() { this.src = ''; },
			load() {}, play() { return Promise.resolve(); },
			cloneNode() { return node(); },
			getVideoPlaybackQuality() { return { totalVideoFrames: 0, droppedVideoFrames: 0 }; },
			fire(ev) {
				(this.handlers[ev] || []).slice().forEach((f) => f({ target: this }));
			},
		};
		v.parentNode = {
			replaceChild(fresh) { env.video = fresh; },
		};
		return v;
	}
	env.video = node();
	return env.video;
}

function load() {
	const env = { sockets: [], states: [] };
	const video = makeVideo(env);

	const MediaSourceStub = function () {
		const ms = {
			readyState: 'open',
			listeners: {},
			addEventListener(ev, fn) { ms.listeners[ev] = fn; },
			addSourceBuffer() {
				const sb = {
					updating: false, mode: '', buffered: { length: 0 }, appends: 0,
					addEventListener() {}, appendBuffer() { this.appends++; },
					remove() {}, abort() {},
				};
				env.sb = sb;
				return sb;
			},
			removeSourceBuffer() {}, endOfStream() {},
		};
		env.ms = ms;
		env.msCount = (env.msCount || 0) + 1;
		return ms;
	};
	MediaSourceStub.isTypeSupported = () => true;

	const win = { MediaSource: MediaSourceStub };
	env.docHandlers = {};
	const ctx = {
		window: win,
		document: {
			addEventListener(t, fn) { (env.docHandlers[t] = env.docHandlers[t] || []).push(fn); },
			removeEventListener(t, fn) { env.docHandlers[t] = (env.docHandlers[t] || []).filter((f) => f !== fn); },
		},
		MediaSource: MediaSourceStub,
		WebSocket: makeSockets(env),
		URL: { createObjectURL: () => 'blob:stub', revokeObjectURL() {} },
		location: { protocol: 'http:', host: 'camera' },
		console: console, JSON: JSON, Promise: Promise,
		setTimeout, clearTimeout, setInterval, clearInterval,
		Uint8Array,
	};
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx);

	env.player = win.MajesticVideo.attach(video, {
		onState: (s, d) => env.states.push(d ? s + ' ' + d : s),
	});
	// The socket is live and the camera has sent its init frame: from here the
	// player is playing, which is the state every one of these starts from.
	env.play = () => {
		const s = env.sockets[env.sockets.length - 1];
		s.fire('open');
		s.fire('message', { data: JSON.stringify({ type: 'init', codec: 'h264', codecString: 'avc1.4d001f' }) });
		if (env.ms && env.ms.listeners.sourceopen) env.ms.listeners.sourceopen();
	};
	env.live = () => env.sockets.filter((s) => !s.closed);
	return env;
}

(async () => {
	group('a video error replaces the session rather than adding to it');
	{
		const env = load();
		env.play();
		check('one session to start with', env.sockets.length === 1, env.sockets.length + '');

		// What a decode error looks like from here: the element says it has
		// stopped, and the player rebuilds. The socket it was reading is the
		// thing that must not survive that.
		env.video.fire('error');
		check('the failed session was closed at once', env.sockets[0].closed);
		check('and silenced, so its own close cannot answer for the player',
			env.sockets[0].silent());

		await sleep(1300); // the first backoff
		check('a replacement was opened', env.sockets.length === 2, env.sockets.length + '');
		check('and it is the only one the camera is serving',
			env.live().length === 1, env.live().length + ' live');
		env.player.destroy();
	}

	group('a late close cannot take the live session down with it');
	{
		const env = load();
		env.play();
		const first = env.sockets[0];

		// Main/Sub, or unmute: stop, then reopen 300 ms later. On a link where
		// the close handshake takes longer than that, the browser fires the
		// first socket's close event when the second one is already carrying
		// the picture.
		env.player.setStream(1);
		await sleep(500);
		check('the second session is open', env.sockets.length === 2, env.sockets.length + '');
		env.play();

		check('the first was closed and silenced', first.closed && first.silent());
		first.fire('close');   // it lands now — too late to mean anything
		await sleep(1300);     // longer than a backoff: a reconnect would show
		check('no third session was opened', env.sockets.length === 2, env.sockets.length + '');
		check('and the live one is still the live one',
			env.live().length === 1 && !env.sockets[1].closed);
		env.player.destroy();
	}

	group('the camera closing a session still brings the player back');
	{
		const env = load();
		env.play();
		env.sockets[0].close();      // as the reaper does: shut, then the event
		env.sockets[0].fire('close');
		await sleep(1300);
		check('it reconnected', env.sockets.length === 2, env.sockets.length + '');
		check('with one live session', env.live().length === 1, env.live().length + ' live');
		env.player.destroy();
	}

	group('destroy leaves nothing behind');
	{
		const env = load();
		env.play();
		env.player.destroy();
		check('the socket is closed', env.sockets[0].closed);
		check('and silenced, so the ladder does not restart from the grave',
			env.sockets[0].silent());
		await sleep(1300);
		check('nothing reconnected', env.sockets.length === 1, env.sockets.length + '');
	}

	group('a re-sent init identical to the running one keeps the decoder');
	{
		// Some encoders emit the parameter sets on every keyframe, so the
		// camera re-announces the stream — the same init frame, over and over.
		// Rebuilding MediaSource for each one resets the decoder and blanks the
		// picture once per keyframe: the Safari flash and jerky H.265 of
		// majestic-webui#269 / #335. The running decoder has to be kept, and
		// the redundant init segment (the binary moov that follows the frame)
		// dropped rather than re-appended.
		const env = load();
		env.play();
		check('one decoder built to start with', env.msCount === 1, env.msCount + '');
		const s = env.sockets[0];
		s.fire('message', { data: { byteLength: 100 } });
		check('a media fragment is appended', env.sb.appends === 1, env.sb.appends + '');

		// The camera re-announces the same stream.
		s.fire('message', { data: JSON.stringify(
			{ type: 'init', codec: 'h264', codecString: 'avc1.4d001f' }) });
		check('no second decoder was built', env.msCount === 1, env.msCount + '');
		check('the picture kept the same buffer', env.sb.appends === 1, env.sb.appends + '');

		// The binary moov that follows the redundant frame is dropped, not
		// appended; the next real fragment resumes.
		s.fire('message', { data: { byteLength: 200 } });
		check('the redundant init segment was not appended', env.sb.appends === 1, env.sb.appends + '');
		s.fire('message', { data: { byteLength: 100 } });
		check('fragments after it keep flowing', env.sb.appends === 2, env.sb.appends + '');
		env.player.destroy();
	}

	group('a real reconfigure still rebuilds the decoder');
	{
		// A changed codec, resolution or audio track changes the mime the
		// decoder is configured from, and that genuinely needs a new
		// MediaSource — the guard above must not swallow it.
		const env = load();
		env.play();
		check('one decoder to start with', env.msCount === 1, env.msCount + '');
		const s = env.sockets[0];
		s.fire('message', { data: JSON.stringify(
			{ type: 'init', codec: 'h264', codecString: 'avc1.640028' }) });
		if (env.ms && env.ms.listeners.sourceopen) env.ms.listeners.sourceopen();
		check('a changed init built a second decoder', env.msCount === 2, env.msCount + '');
		env.player.destroy();
	}

	group('a resolution change with the same codec still rebuilds');
	{
		// The fallback mime is codecString alone, so a channel resized without a
		// codec change keeps the same mime. The guard must not read that as a
		// re-announcement: the new size needs a new decoder.
		const env = load();
		const s = env.sockets[0];
		s.fire('open');
		s.fire('message', { data: JSON.stringify(
			{ type: 'init', codec: 'h264', codecString: 'avc1.4d001f', width: 1920, height: 1080 }) });
		if (env.ms && env.ms.listeners.sourceopen) env.ms.listeners.sourceopen();
		check('one decoder for the first size', env.msCount === 1, env.msCount + '');

		s.fire('message', { data: JSON.stringify(
			{ type: 'init', codec: 'h264', codecString: 'avc1.4d001f', width: 1280, height: 720 }) });
		if (env.ms && env.ms.listeners.sourceopen) env.ms.listeners.sourceopen();
		check('a resolution change rebuilt the decoder', env.msCount === 2, env.msCount + '');
		env.player.destroy();
	}

	group('a disconnect after a redundant init does not strand the reconnect');
	{
		// A redundant init arms "drop the next binary" for the moov that follows
		// it. If the socket drops before that binary arrives, the flag must be
		// cleared, or the replacement connection's real init segment is dropped
		// and playback can never start.
		const env = load();
		env.play();
		const s0 = env.sockets[0];
		// The camera re-announces, but the socket dies before the moov lands.
		s0.fire('message', { data: JSON.stringify(
			{ type: 'init', codec: 'h264', codecString: 'avc1.4d001f' }) });
		s0.fire('close');
		await sleep(1300); // the reconnect backoff
		check('a replacement socket opened', env.sockets.length === 2, env.sockets.length + '');

		env.play(); // the replacement's fresh init + sourceopen
		env.sockets[1].fire('message', { data: { byteLength: 300 } }); // its moov
		check('the replacement init segment was appended, not dropped',
			env.sb.appends === 1, env.sb.appends + '');
		env.player.destroy();
	}

	group('a decoder that cannot take the stream falls through instead of looping');
	{
		// Safari can reject a conformant HEVC with MEDIA_ERR_DECODE about a
		// second in; rebuilding the same MSE decoder reproduces it forever (the
		// ~2s flash of majestic-webui#335). After two strikes the player must
		// stop and hand the page an `undecodable` verdict so the chain can try
		// the software decoder or MJPEG.
		const env = load();
		env.play();
		check('one session to start with', env.sockets.length === 1, env.sockets.length + '');

		// First decode error: still worth one rebuild (it might be a one-off).
		env.video.error = { code: 3 };
		env.video.fire('error');
		await sleep(1300); // the reconnect backoff
		check('rebuilt once after the first decode error', env.sockets.length === 2, env.sockets.length + '');
		env.play();

		// Second strike in quick succession: give up on this decoder.
		env.video.error = { code: 3 };
		env.video.fire('error');
		check('fell through with an undecodable verdict',
			env.states.indexOf('mjpeg undecodable h264') >= 0, env.states.join(','));
		await sleep(1300);
		check('and did not open a third session', env.sockets.length === 2, env.sockets.length + '');
		check('no session is left live', env.live().length === 0, env.live().length + ' live');
		env.player.destroy();
	}

	group('a stream switch does not inherit the previous stream\'s decode strike');
	{
		// One decode error on Main, then the viewer switches to Sub within the
		// window: a single error on the new stream must not fall through, because
		// the switch is a fresh decode context.
		const env = load();
		env.play();
		env.video.error = { code: 3 };
		env.video.fire('error');   // strike 1 on the first stream
		await sleep(1300);
		env.player.setStream(1);   // deliberate switch -> resets the count
		await sleep(400);
		env.play();
		env.video.error = { code: 3 };
		env.video.fire('error');   // strike 1 on the new stream, not 2
		check('the switched stream was not routed away',
			env.states.indexOf('mjpeg undecodable h264') < 0, env.states.join(','));
		await sleep(1300);
		check('it rebuilt for the new stream instead', env.live().length === 1, env.live().length + ' live');
		env.player.destroy();
	}

	group('a lone decode error is not treated as an inability');
	{
		// One decode glitch, then clean playback, must not fall through — the
		// count only fires on failures close together in time.
		const env = load();
		env.play();
		env.video.error = { code: 3 };
		env.video.fire('error');
		await sleep(1300);
		check('it rebuilt rather than fell through',
			env.states.indexOf('mjpeg undecodable h264') < 0 && env.sockets.length === 2,
			env.states.join(',') + ' / ' + env.sockets.length);
		env.player.destroy();
	}

	group('a muted MSE picture that stays paused arms a gesture to start it (#317, Opera)');
	{
		const env = load();
		env.play();
		// Opera resolves play() without starting it, so the picture is a muted
		// paused frame. A media frame arrives in that state.
		env.video.muted = true;
		env.video.paused = true;
		let played = 0;
		env.video.play = () => { played++; return Promise.resolve(); };
		env.sockets[env.sockets.length - 1].fire('message', { data: { byteLength: 100 } });
		check('a one-shot gesture retry was armed', (env.docHandlers.pointerdown || []).length === 1,
			JSON.stringify((env.docHandlers.pointerdown || []).length));
		// The page is told once that the picture is parked waiting for a tap, so
		// it can raise the play affordance (#317).
		check('the page was told the picture is waiting for a gesture',
			env.states.filter((s) => s === 'gesture').length === 1, env.states.join(','));
		// Another paused frame must not re-announce it: the affordance is up, and
		// a second 'gesture' would be noise.
		env.sockets[env.sockets.length - 1].fire('message', { data: { byteLength: 100 } });
		check('a further paused frame does not re-announce it',
			env.states.filter((s) => s === 'gesture').length === 1, env.states.join(','));
		// The viewer taps: play() is called, and this time it starts.
		env.video.paused = false;
		env.docHandlers.pointerdown[0]();
		check('the tap called play()', played >= 1, played + ' plays');
		check('and the one-shot listener removed itself', (env.docHandlers.pointerdown || []).length === 0);
		// Only the element's own 'playing' event proves the picture moved; that is
		// what takes the affordance down, so the page hears 'resumed' then.
		check('nothing claimed it resumed before it actually played',
			env.states.indexOf('resumed') < 0, env.states.join(','));
		env.video.fire('playing');
		check('the page was told the picture resumed once it played',
			env.states.filter((s) => s === 'resumed').length === 1, env.states.join(','));
		env.player.destroy();
	}

	group('an MSE picture that is playing arms no gesture (no regression)');
	{
		const env = load();
		env.play();
		// Playing: not paused. A frame must not arm any gesture listener.
		env.video.muted = true;
		env.video.paused = false;
		env.sockets[env.sockets.length - 1].fire('message', { data: { byteLength: 100 } });
		check('nothing armed while playing', (env.docHandlers.pointerdown || []).length === 0,
			JSON.stringify((env.docHandlers.pointerdown || []).length));
		check('and the page is not told to raise the play affordance',
			env.states.indexOf('gesture') < 0, env.states.join(','));
		// The element still fires 'playing' as it runs; with no gesture armed that
		// must stay silent, or an ordinary autoplay start would emit 'resumed'.
		env.video.fire('playing');
		check('an ordinary playing element emits no resumed', env.states.indexOf('resumed') < 0,
			env.states.join(','));
		env.player.destroy();
	}

	done();
})();
