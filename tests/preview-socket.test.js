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
				return {
					updating: false, mode: '', buffered: { length: 0 },
					addEventListener() {}, appendBuffer() {}, remove() {}, abort() {},
				};
			},
			removeSourceBuffer() {}, endOfStream() {},
		};
		env.ms = ms;
		return ms;
	};
	MediaSourceStub.isTypeSupported = () => true;

	const win = { MediaSource: MediaSourceStub };
	const ctx = {
		window: win,
		MediaSource: MediaSourceStub,
		WebSocket: makeSockets(env),
		URL: { createObjectURL: () => 'blob:stub', revokeObjectURL() {} },
		location: { protocol: 'http:', host: 'camera' },
		console: console, JSON: JSON, Promise: Promise,
		setTimeout, clearTimeout, setInterval, clearInterval,
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

	done();
})();
