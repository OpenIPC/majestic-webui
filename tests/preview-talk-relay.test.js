// preview-talk-relay.js: the Live page's half of Talk on plain HTTP (#762).
//
// Admitted for the reason talkback.test.js is. Each failure here is silent:
// - a socket left open after its window closed is a session slot on the
//   camera held for nobody;
// - a window that outlives the Talk button or the page is a microphone the
//   person believes is off;
// - a frame forwarded from the wrong window or origin is any page on the
//   Internet speaking to the camera's signalling through this one.
// Seeing any of them takes a popup, a camera and the timing of a close. Here
// the window, the socket and the clock are stubs that record what was asked.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const SRC = path.join(__dirname, '..', 'www', 'a', 'preview-talk-relay.js');
const ORIGIN = 'https://talk.share.openipc.cloud';
const NS = 'mj-talk/1';

function makeEnv(o) {
	o = o || {};
	const env = { sockets: [], listeners: {}, timers: [], opened: [], mic: [] };
	const popup = env.popup = {
		closed: false, posted: [], closedByOpener: false,
		postMessage(m, target) { this.posted.push({ m: JSON.parse(JSON.stringify(m)), target }); },
		close() { this.closedByOpener = true; this.closed = true; },
	};
	class WS {
		constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.closedBy = false; env.sockets.push(this); }
		send(d) { this.sent.push(d); }
		close() { this.closedBy = true; this.readyState = 3; }
		// What the camera's end does.
		up() { this.readyState = 1; if (this.onopen) this.onopen(); }
		say(d) { if (this.onmessage) this.onmessage({ data: d }); }
		drop() { this.readyState = 3; if (this.onclose) this.onclose(); }
	}
	const win = {
		isSecureContext: o.secure === true,
		location: { protocol: 'http:', host: '192.0.2.10' },
		open(url, name, features) { env.opened.push({ url, name, features }); return o.blocked ? null : popup; },
		addEventListener(t, f) { (env.listeners[t] = env.listeners[t] || []).push(f); },
		removeEventListener(t, f) { env.listeners[t] = (env.listeners[t] || []).filter((x) => x !== f); },
		setInterval(f) { env.timers.push(f); return env.timers.length; },
		clearInterval(id) { env.timers[id - 1] = null; },
		WebSocket: WS,
	};
	if (o.rtc !== false) win.RTCPeerConnection = function () {};
	const ctx = Object.assign({ window: win, console, location: win.location, WebSocket: WS,
		setInterval: win.setInterval, clearInterval: win.clearInterval }, {});
	ctx.globalThis = ctx;
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx);
	env.R = win.MajesticTalkRelay;
	env.win = win;
	// A message to the page, from the popup unless said otherwise.
	env.from = (m, extra) => {
		const e = Object.assign({ source: popup, origin: ORIGIN, data: Object.assign({ ns: NS }, m) }, extra || {});
		for (const f of (env.listeners.message || []).slice()) f(e);
	};
	env.tick = () => { for (const f of env.timers.slice()) if (f) f(); };
	env.posts = (t) => popup.posted.filter((p) => p.m.t === t);
	env.open = () => env.R.open({ stream: 1, camera: 'garage', onMic: (s, why) => env.mic.push(s + (why ? ':' + why : '')) });
	return env;
}

function blocked() {
	group('a blocked window is said, and nothing is left behind');
	const env = makeEnv({ blocked: true });
	const s = env.open();
	check('reported off, with the way out', env.mic.length === 1 && /^off:.*pop-ups/.test(env.mic[0]), env.mic.join('|'));
	check('not active', s.active() === false);
	check('no listener left', !(env.listeners.message || []).length);
}

function opensTheWindow() {
	group('Talk opens the talk window, and nothing else until it asks');
	const env = makeEnv();
	const s = env.open();
	check('one window, at the talk origin, by name', env.opened.length === 1 &&
		env.opened[0].url === ORIGIN + '/' && env.opened[0].name === 'mj-talk', JSON.stringify(env.opened));
	check('the control says the window is open', env.mic.join('|') === 'window');
	check('active', s.active() === true);
	check('no socket before the window asks', env.sockets.length === 0);
}

function onlyThatWindow() {
	group('only the window this page opened, at the talk origin, is heard');
	const env = makeEnv();
	env.open();
	env.from({ t: 'hello' }, { origin: 'https://evil.example' });
	env.from({ t: 'hello' }, { source: {} });
	env.from({ t: 'open', sid: 1 }, { origin: 'http://192.0.2.10' });
	check('a stranger\'s hello gets no answer', env.posts('camera').length === 0);
	check('a stranger\'s open opens no socket', env.sockets.length === 0);
	env.from({ t: 'hello' }, { data: { ns: 'other', t: 'hello' } });
	check('another protocol is not this one', env.posts('camera').length === 0);
	env.from({ t: 'hello' });
	const c = env.posts('camera');
	check('the window is told which camera', c.length === 1 && c[0].m.name === 'garage');
	check('and only the talk origin may read it', c[0].target === ORIGIN);
}

const AUDIO_OFFER = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\n' +
	'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=mid:0\r\na=sendrecv\r\na=rtpmap:111 opus/48000/2\r\n';
const frame = (req, data) => JSON.stringify({ req, data });

function carriesTextFrames() {
	group('the socket carries the window\'s signalling, text only, both ways');
	const env = makeEnv();
	env.open();
	env.from({ t: 'open', sid: 1 });
	check('one socket, for the stream asked', env.sockets.length === 1 &&
		/\/ws\/webrtc\?stream=1$/.test(env.sockets[0].url), env.sockets[0] && env.sockets[0].url);
	const ws = env.sockets[0];
	env.from({ t: 'send', data: frame('offer', AUDIO_OFFER) });
	check('nothing sent before the socket is up', ws.sent.length === 0);
	ws.up();
	check('the window hears it is up, with its session', env.posts('up').length === 1 && env.posts('up')[0].m.sid === 1);
	env.from({ t: 'send', data: frame('offer', AUDIO_OFFER) });
	env.from({ t: 'send', data: frame('candidate', 'candidate:1 1 udp 2130706431 192.0.2.20 5000 typ host') });
	env.from({ t: 'send', data: { req: 'offer' } });
	env.from({ t: 'send', data: 'x'.repeat(256 * 1024 + 1) });
	check('the offer and the candidate go to the camera; an object and an oversize one do not',
		ws.sent.length === 2, ws.sent.length);
	ws.say('{"reply":"answer","data":"v=0"}');
	ws.say(new Uint8Array(4));
	const r = env.posts('recv');
	check('the camera\'s text reaches the window, with its session; binary does not',
		r.length === 1 && r[0].m.data === '{"reply":"answer","data":"v=0"}' && r[0].m.sid === 1);
}

function onlyWhatTalkNeeds() {
	group('the window can ask the camera for Talk and nothing more');
	const env = makeEnv();
	env.open();
	env.from({ t: 'open', sid: 1 });
	const ws = env.sockets[0];
	ws.up();
	const video = AUDIO_OFFER + 'm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:1\r\na=recvonly\r\n';
	const data = AUDIO_OFFER + 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:1\r\n';
	const videoOnly = AUDIO_OFFER.replace('m=audio 9 UDP/TLS/RTP/SAVPF 111', 'm=video 9 UDP/TLS/RTP/SAVPF 96');
	for (const [what, d] of [['an offer with video', frame('offer', video)], ['an offer with a data channel', frame('offer', data)],
		['a video-only offer', frame('offer', videoOnly)], ['another request', frame('idr', '')],
		['a request with no data', JSON.stringify({ req: 'candidate' })], ['not JSON', 'offer']]) {
		env.from({ t: 'send', data: d });
		check(what + ' never reaches the camera', ws.sent.length === 0, ws.sent.join(' | ').slice(0, 80));
	}
	env.from({ t: 'send', data: frame('offer', AUDIO_OFFER) });
	check('an audio-only offer does', ws.sent.length === 1);
	env.from({ t: 'open' });
	check('an open with no session number opens nothing', env.sockets.length === 1);
}

function aFreshSocket() {
	group('a second open replaces the socket, and the old one says nothing');
	const env = makeEnv();
	env.open();
	env.from({ t: 'open', sid: 1 });
	const old = env.sockets[0];
	old.up();
	env.from({ t: 'open', sid: 2 });
	check('the old socket is closed', old.closedBy === true);
	check('a new one opened', env.sockets.length === 2);
	old.drop();
	old.say('{"reply":"candidate"}');
	check('the old one\'s close and words do not reach the window',
		env.posts('down').length === 0 && env.posts('recv').length === 0);
	env.sockets[1].up();
	check('the new one speaks for its own session', env.posts('up').slice(-1)[0].m.sid === 2);
	env.sockets[1].drop();
	check('the current one\'s close does, with its session',
		env.posts('down').length === 1 && env.posts('down')[0].m.sid === 2);
}

function states() {
	group('the window\'s states drive the control; its off ends everything');
	const env = makeEnv();
	const s = env.open();
	env.from({ t: 'state', s: 'asking' });
	env.from({ t: 'state', s: 'live' });
	env.from({ t: 'state', s: 'on' });
	env.from({ t: 'state', s: 'bogus' });
	check('asking is the window\'s own, live and on are passed', env.mic.join('|') === 'window|window|live|on', env.mic.join('|'));
	env.from({ t: 'open', sid: 1 });
	env.sockets[0].up();
	env.from({ t: 'state', s: 'off', why: 'permission refused' });
	check('off, with the window\'s reason', env.mic[env.mic.length - 1] === 'off:permission refused');
	check('the socket is closed', env.sockets[0].closedBy === true);
	check('the window is not told to stop (it stopped)', env.posts('stop').length === 0);
	check('not active', s.active() === false);
	env.from({ t: 'open', sid: 1 });
	check('a late message opens nothing', env.sockets.length === 1);
	check('no listener left', !(env.listeners.message || []).length && !(env.listeners.pagehide || []).length);
}

function closedWindow() {
	group('a window the person closed is noticed, and its socket closed');
	const env = makeEnv();
	const s = env.open();
	env.from({ t: 'open', sid: 1 });
	env.sockets[0].up();
	env.tick();
	check('still running while open', s.active() === true);
	env.popup.closed = true;
	env.tick();
	check('off, once', env.mic.filter((m) => m.startsWith('off')).length === 1 && env.mic[env.mic.length - 1] === 'off');
	check('the socket is closed', env.sockets[0].closedBy === true);
	env.tick();
	check('the poll is stopped', env.mic.filter((m) => m.startsWith('off')).length === 1);
}

function stopAndLeave() {
	for (const how of ['stop', 'pagehide']) {
		group('Talk off, or leaving the page, stops and closes the window (' + how + ')');
		const env = makeEnv();
		const s = env.open();
		env.from({ t: 'open', sid: 1 });
		env.sockets[0].up();
		if (how === 'stop') s.stop(); else for (const f of env.listeners.pagehide.slice()) f({});
		check('the window is told to stop', env.posts('stop').length === 1);
		check('and closed', env.popup.closedByOpener === true);
		check('the socket is closed', env.sockets[0].closedBy === true);
		check('off', env.mic[env.mic.length - 1] === 'off');
		s.stop();
		check('a second stop does nothing', env.posts('stop').length === 1 && env.mic.filter((m) => m === 'off').length === 1);
	}
}

function availability() {
	group('offered only where the page cannot capture and the window can');
	check('plain HTTP with WebRTC', makeEnv().R.available() === true);
	check('a secure page has its own microphone', makeEnv({ secure: true }).R.available() === false);
	check('no WebRTC, no window', makeEnv({ rtc: false }).R.available() === false);
}

for (const t of [blocked, opensTheWindow, onlyThatWindow, carriesTextFrames, onlyWhatTalkNeeds, aFreshSocket, states,
	closedWindow, stopAndLeave, availability]) {
	t();
}
done();
