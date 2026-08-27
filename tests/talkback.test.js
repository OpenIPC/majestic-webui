// preview-webrtc.js's talkback state machine, driven against stubs.
//
// Every case asks the same question: did the microphone stop? A capture that
// outlives the control able to stop it is the worst thing this player can do,
// and each of these is a route to it that review found in the debug page this
// replaced — a permission grant that outlives the mode it was asked for, two
// clicks racing into two grants, a track that ends on its own, a camera that
// declines the direction after the browser has already lit the microphone.
//
// Stubs rather than a browser because the interesting states are all timing:
// a prompt still open while something else changes underneath it. A real
// getUserMedia cannot be held pending on demand; this one can.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const SRC = path.join(__dirname, '..', 'www', 'a', 'preview-webrtc.js');

// --- stubs ---------------------------------------------------------------
function makeTrack(kind) {
	return {
		kind: kind, stopped: false, onended: null,
		stop() { this.stopped = true; },
	};
}

function makeEnv(o) {
	o = o || {};
	const env = { grants: [], sockets: [], pcs: [], gumCalls: 0 };

	env.pending = [];   // unresolved getUserMedia promises, resolved by hand

	const navigator = {};
	if (!o.noGum) {
		navigator.mediaDevices = {
			getUserMedia() {
				env.gumCalls++;
				return new Promise((res, rej) => env.pending.push({ res, rej }));
			},
		};
	}

	function Transceiver(dir, track) {
		this.currentDirection = dir;
		this.sender = { track: track || null };
		this.receiver = { track: track || makeTrack('audio') };
	}

	function RTCPeerConnection() {
		this.transceivers = [];
		this.closed = false;
		env.pcs.push(this);
	}
	RTCPeerConnection.prototype.addTransceiver = function (what, opts) {
		const dir = (opts && opts.direction) || 'sendrecv';
		const track = typeof what === 'object' ? what : null;
		// What the camera answers, per the test's scenario: 'sendrecv' when it
		// accepts talkback, 'recvonly' (from our side) when it declines.
		const negotiated = track
			? (o.localDirection ||
				(o.cameraTakesTalkback === false ? 'recvonly' : 'sendrecv'))
			: dir;
		const t = new Transceiver(negotiated, track);
		this.transceivers.push(t);
		return t;
	};
	RTCPeerConnection.prototype.getTransceivers = function () { return this.transceivers; };
	RTCPeerConnection.prototype.createOffer = function () { return Promise.resolve({ sdp: 'x' }); };
	RTCPeerConnection.prototype.setLocalDescription = function () {
		this.localDescription = { sdp: 'x' };
		return Promise.resolve();
	};
	RTCPeerConnection.prototype.setRemoteDescription = function () { return Promise.resolve(); };
	RTCPeerConnection.prototype.addIceCandidate = function () { return Promise.resolve(); };
	RTCPeerConnection.prototype.getStats = function () { return Promise.resolve({ forEach() {} }); };
	RTCPeerConnection.prototype.close = function () { this.closed = true; };

	function WebSocket(url) {
		this.url = url; this.readyState = 1; this.sent = [];
		env.sockets.push(this);
		setTimeout(() => { if (this.onopen) this.onopen(); }, 0);
	}
	WebSocket.prototype.send = function (d) { this.sent.push(d); };
	WebSocket.prototype.close = function () { this.readyState = 3; };

	const win = {
		RTCPeerConnection: RTCPeerConnection,
		isSecureContext: o.secure !== false,
	};
	const ctx = {
		window: win, navigator: navigator, WebSocket: WebSocket,
		RTCPeerConnection: RTCPeerConnection,
		location: { protocol: 'https:', host: 'cam' },
		setTimeout, clearTimeout, setInterval, clearInterval, console,
	};
	ctx.globalThis = ctx;
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx);
	env.MajesticWebRTC = win.MajesticWebRTC;
	env.video = { muted: true, volume: 1, srcObject: null, play: () => Promise.resolve() };
	return env;
}

const tick = (n) => new Promise(r => setTimeout(r, n || 5));

// --- cases ---------------------------------------------------------------
async function reentrancy() {
	group('two clicks while the prompt is up start one grant');
	const env = makeEnv();
	const mic = [];
	const p = env.MajesticWebRTC.attach(env.video, { onMic: (s, w) => mic.push([s, w]) });
	await tick();
	p.setMic(true);
	p.setMic(true);
	p.setMic(true);
	check('one getUserMedia', env.gumCalls === 1, env.gumCalls + ' calls');
	check('reported asking', mic.some(m => m[0] === 'asking'));
	const t = makeTrack('audio');
	env.pending[0].res({ getAudioTracks: () => [t], getTracks: () => [t] });
	await tick(400);
	// Capturing, but the camera has not answered: 'live', not 'on'.
	check('reported live, not on', mic.some(m => m[0] === 'live') &&
		!mic.some(m => m[0] === 'on'), JSON.stringify(mic));
	check('track kept', !t.stopped);
	const sock = env.sockets[env.sockets.length - 1];
	sock.onmessage({ data: JSON.stringify({ reply: 'answer', data: 'sdp' }) });
	await tick(30);
	check('on only after the answer', mic.some(m => m[0] === 'on'),
		JSON.stringify(mic));
	// Accepted talkback opens the camera's audio with it, so the element is
	// unmuted — but only now, not at the moment of capture.
	check('unmuted on acceptance', env.video.muted === false);
	p.destroy();
}

async function destroyedDuringPrompt() {
	group('destroyed while the prompt is up releases the grant');
	const env = makeEnv();
	const p = env.MajesticWebRTC.attach(env.video, {});
	await tick();
	p.setMic(true);
	p.destroy();
	const t = makeTrack('audio');
	env.pending[0].res({ getAudioTracks: () => [t], getTracks: () => [t] });
	await tick(20);
	check('track stopped', t.stopped);
}

async function cameraDeclines() {
	group('a camera that will not take audio releases the microphone');
	const env = makeEnv({ cameraTakesTalkback: false });
	const mic = [];
	const p = env.MajesticWebRTC.attach(env.video, { onMic: (s, w) => mic.push([s, w]) });
	await tick();
	p.setMic(true);
	const t = makeTrack('audio');
	const before = env.sockets.length;
	env.pending[0].res({ getAudioTracks: () => [t], getTracks: () => [t] });
	// setMic renegotiates by reopening, which is on a 300 ms timer: the answer
	// has to go to the session that carries the microphone, not the one before
	// it.
	await tick(400);
	check('renegotiated', env.sockets.length > before,
		env.sockets.length + ' sockets');
	const sock = env.sockets[env.sockets.length - 1];
	if (sock && sock.onmessage) {
		sock.onmessage({ data: JSON.stringify({ reply: 'answer', data: 'sdp' }) });
	}
	await tick(30);
	check('track stopped', t.stopped);
	check('told why', mic.some(m => m[0] === 'off' && /not accepting/.test(m[1] || '')),
		JSON.stringify(mic));
	check('never claimed on', !mic.some(m => m[0] === 'on'), JSON.stringify(mic));
	// The refusal must not leave sound playing that the page calls muted.
	check('element still muted', env.video.muted === true);
	p.destroy();
}

async function trackEndsOnItsOwn() {
	group('a microphone unplugged mid-session clears the control');
	const env = makeEnv();
	const mic = [];
	const p = env.MajesticWebRTC.attach(env.video, { onMic: (s, w) => mic.push([s, w]) });
	await tick();
	p.setMic(true);
	const t = makeTrack('audio');
	env.pending[0].res({ getAudioTracks: () => [t], getTracks: () => [t] });
	await tick(20);
	check('onended installed', typeof t.onended === 'function');
	mic.length = 0;
	t.onended();
	await tick(10);
	check('reported off', mic.some(m => m[0] === 'off'), JSON.stringify(mic));
	p.destroy();
}

async function destroyStopsMic() {
	group('destroy() stops a live microphone');
	const env = makeEnv();
	const p = env.MajesticWebRTC.attach(env.video, {});
	await tick();
	p.setMic(true);
	const t = makeTrack('audio');
	env.pending[0].res({ getAudioTracks: () => [t], getTracks: () => [t] });
	await tick(20);
	check('alive before destroy', !t.stopped);
	p.destroy();
	check('stopped after destroy', t.stopped);
}

async function insecureContext() {
	group('no getUserMedia says which of the two reasons it is');
	const env = makeEnv({ noGum: true, secure: false });
	const mic = [];
	const p = env.MajesticWebRTC.attach(env.video, { onMic: (s, w) => mic.push([s, w]) });
	await tick();
	check('micSupported false', p.micSupported() === false);
	p.setMic(true);
	check('blamed HTTPS', mic.some(m => m[0] === 'off' && /HTTPS/.test(m[1] || '')),
		JSON.stringify(mic));
	p.destroy();
}

async function refused() {
	group('a refused permission leaves nothing running');
	const env = makeEnv();
	const mic = [];
	const p = env.MajesticWebRTC.attach(env.video, { onMic: (s, w) => mic.push([s, w]) });
	await tick();
	p.setMic(true);
	env.pending[0].rej({ name: 'NotAllowedError' });
	await tick(20);
	check('reported refused', mic.some(m => m[0] === 'off' && /refused/.test(m[1] || '')),
		JSON.stringify(mic));
	// And the guard has to clear, or the button is dead for the session.
	p.setMic(true);
	check('can ask again', env.gumCalls === 2, env.gumCalls + ' calls');
	p.destroy();
}

async function cameraTakesMicButSendsNothing() {
	group('a camera that takes the microphone but returns no audio');
	// It answers recvonly, so this end settles on sendonly. That is talkback
	// working, and must not read as a refusal.
	const env = makeEnv({ localDirection: 'sendonly' });
	const mic = [];
	const p = env.MajesticWebRTC.attach(env.video, { onMic: (s, w) => mic.push([s, w]) });
	await tick();
	p.setMic(true);
	const t = makeTrack('audio');
	env.pending[0].res({ getAudioTracks: () => [t], getTracks: () => [t] });
	await tick(400);
	const sock = env.sockets[env.sockets.length - 1];
	sock.onmessage({ data: JSON.stringify({ reply: 'answer', data: 'sdp' }) });
	await tick(30);
	check('track kept', !t.stopped);
	check('reported on', mic.some(m => m[0] === 'on'), JSON.stringify(mic));
	check('not called a refusal',
		!mic.some(m => m[0] === 'off' && /not accepting/.test(m[1] || '')));
	p.destroy();
}

(async () => {
	for (const t of [reentrancy, cameraTakesMicButSendsNothing, destroyedDuringPrompt, cameraDeclines,
		trackEndsOnItsOwn, destroyStopsMic, insecureContext, refused]) {
		await t();
	}
	done();
})();
