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
// The signalling socket is a module of its own now (preview-signal.js),
// loaded into the same context first, the way the pages load it.
const SIG = path.join(__dirname, '..', 'www', 'a', 'preview-signal.js');

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
	env.docHandlers = {};
	const document = {
		addEventListener(t, fn) { (env.docHandlers[t] = env.docHandlers[t] || []).push(fn); },
		removeEventListener(t, fn) { env.docHandlers[t] = (env.docHandlers[t] || []).filter((f) => f !== fn); },
	};
	const ctx = {
		window: win, navigator: navigator, WebSocket: WebSocket, document: document,
		RTCPeerConnection: RTCPeerConnection,
		location: { protocol: 'https:', host: 'cam' },
		setTimeout, clearTimeout, setInterval, clearInterval, console,
	};
	ctx.globalThis = ctx;
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(SIG, 'utf8'), ctx);
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

async function playRetriesOnGesture() {
	group('a muted video refused autoplay retries on the first user gesture (#317)');
	// Opera for Android refuses autoplay of the muted WebRTC picture on a fresh
	// load; the picture is ready but paused. The player must retry play() on the
	// first user gesture rather than leave it paused for ever.
	const env = makeEnv();
	let plays = 0, reject = true;
	const vh = {};
	const video = {
		muted: true, volume: 1, srcObject: null,
		play() { plays++; return reject ? Promise.reject({ name: 'NotAllowedError' }) : Promise.resolve(); },
		addEventListener(ev, fn) { (vh[ev] = vh[ev] || []).push(fn); },
		removeEventListener(ev, fn) { vh[ev] = (vh[ev] || []).filter((f) => f !== fn); },
		fire(ev) { (vh[ev] || []).slice().forEach((f) => f({ target: this })); },
	};
	env.MajesticWebRTC.attach(video, {});
	await tick();
	check('a peer connection was made', env.pcs.length >= 1, env.pcs.length + '');
	// The camera's video track arrives; play() is attempted and refused.
	env.pcs[0].ontrack({ streams: [{}], track: { kind: 'video' } });
	await tick();
	check('play() was attempted and refused', plays === 1, plays + ' plays');
	check('a gesture retry was armed', (env.docHandlers.pointerdown || []).length === 1,
		JSON.stringify(Object.keys(env.docHandlers)));
	// A second attempt (as a reconnect would make) is also refused: it must
	// re-arm afresh, not be blocked by the first arming nor stack a second
	// listener.
	env.pcs[0].ontrack({ streams: [{}], track: { kind: 'video' } });
	await tick();
	check('play() attempted again', plays === 2, plays + ' plays');
	check('still exactly one retry (re-armed, not stacked or blocked)',
		(env.docHandlers.pointerdown || []).length === 1);
	// The viewer taps: play() is retried, and this time it is allowed. The retry
	// is NOT removed on the tap -- only the picture actually starting takes it
	// down, so a tap that does not start it (below) can be followed by another.
	reject = false;
	env.docHandlers.pointerdown[0]();
	check('play() was retried on the gesture', plays === 3, plays + ' plays');
	check('the retry stays armed until the picture plays',
		(env.docHandlers.pointerdown || []).length === 1);
	video.fire('playing');
	check('once it plays the listener is removed', (env.docHandlers.pointerdown || []).length === 0);
}

async function playResolvesButStaysPaused() {
	group('a muted video whose play() resolves but stays paused keeps retrying across taps (#317, Opera)');
	// Opera for Android resolves play() without starting playback: the .catch
	// never runs, so only the paused-state observer can save it -- and, the
	// reporter's case, the TAP's play() no more starts the picture than autoplay
	// did. A one-shot retry would remove itself on that first dead tap and leave
	// every later tap doing nothing, the picture parked under an affordance it
	// cannot dismiss. The retry must stay armed until the picture truly plays.
	const env = makeEnv();
	let plays = 0;
	const vh = {};
	const video = {
		muted: true, volume: 1, srcObject: null, paused: true,
		play() { plays++; return Promise.resolve(); },   // resolves, yet paused stays true
		addEventListener(ev, fn) { (vh[ev] = vh[ev] || []).push(fn); },
		removeEventListener(ev, fn) { vh[ev] = (vh[ev] || []).filter((f) => f !== fn); },
		fire(ev) { (vh[ev] || []).slice().forEach((f) => f({ target: this })); },
	};
	env.MajesticWebRTC.attach(video, {});
	await tick();
	env.pcs[0].ontrack({ streams: [{}], track: { kind: 'video' } });
	await tick();
	check('play() resolved (no reject-path arm)', plays === 1, plays + ' plays');
	check('nothing armed yet — play() did not reject', (env.docHandlers.pointerdown || []).length === 0,
		JSON.stringify((env.docHandlers.pointerdown || []).length));
	// The paused-state observer fires ~800ms on and, seeing it still paused, arms.
	await tick(850);
	check('a gesture retry armed from the observed paused state',
		(env.docHandlers.pointerdown || []).length === 1,
		JSON.stringify((env.docHandlers.pointerdown || []).length));
	// The viewer taps, but the picture still does not start (paused stays true).
	// The retry must NOT remove itself.
	env.docHandlers.pointerdown[0]();
	check('the tap retried play()', plays === 2, plays + ' plays');
	check('and the retry is still armed for the next tap',
		(env.docHandlers.pointerdown || []).length === 1,
		JSON.stringify((env.docHandlers.pointerdown || []).length));
	// A second tap retries again; when the picture finally starts, its own
	// 'playing' event is what takes the retry down.
	env.docHandlers.pointerdown[0]();
	check('a second tap retried again', plays === 3, plays + ' plays');
	video.paused = false;
	video.fire('playing');
	check('once it plays the retry is removed', (env.docHandlers.pointerdown || []).length === 0,
		JSON.stringify((env.docHandlers.pointerdown || []).length));
}

async function playbackStartsArmsNothing() {
	group('a muted video that actually starts playing arms no retry (no Chrome regression) (#317)');
	const env = makeEnv();
	let plays = 0;
	const video = {
		muted: true, volume: 1, srcObject: null, paused: true,
		play() { plays++; video.paused = false; return Promise.resolve(); },  // starts playing
	};
	env.MajesticWebRTC.attach(video, {});
	await tick();
	env.pcs[0].ontrack({ streams: [{}], track: { kind: 'video' } });
	await tick(850);
	check('played, so the paused-state observer armed nothing',
		(env.docHandlers.pointerdown || []).length === 0,
		JSON.stringify((env.docHandlers.pointerdown || []).length));
}

async function gestureAndResumedStates() {
	group('the parked picture is announced to the page, and cleared once it plays (#317)');
	// The same Opera case as playResolvesButStaysPaused, but watching what the
	// page is told: it needs one 'gesture' to raise the tap affordance and one
	// 'resumed' — driven by the element's own 'playing' event, not by the retry —
	// to take it back down.
	const env = makeEnv();
	const states = [];
	const handlers = {};
	let plays = 0;
	const video = {
		muted: true, volume: 1, srcObject: null, paused: true,
		play() { plays++; return Promise.resolve(); },
		addEventListener(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
		removeEventListener(ev, fn) { handlers[ev] = (handlers[ev] || []).filter((f) => f !== fn); },
		fire(ev) { (handlers[ev] || []).slice().forEach((f) => f({ target: this })); },
	};
	env.MajesticWebRTC.attach(video, { onState: (s) => states.push(s) });
	await tick();
	env.pcs[0].ontrack({ streams: [{}], track: { kind: 'video' } });
	// The paused-state observer arms at ~800ms; the announcement is then held
	// back a further debounce, so a picture about to play does not flash it.
	await tick(850);
	check('the retry armed but the affordance is not announced yet',
		(env.docHandlers.pointerdown || []).length === 1 && states.indexOf('gesture') < 0,
		states.join(',') + ' | arms=' + (env.docHandlers.pointerdown || []).length);
	await tick(600);
	check('the page was told the picture is waiting for a gesture, once',
		states.filter((s) => s === 'gesture').length === 1, states.join(','));
	check('nothing claimed it resumed before it actually played',
		states.indexOf('resumed') < 0, states.join(','));
	// The tap starts it and the element fires 'playing' — that is what clears it.
	video.paused = false;
	env.docHandlers.pointerdown[0]();
	check('the tap retried play()', plays >= 2, plays + ' plays');
	check('a play() resolving is still not a resumed', states.indexOf('resumed') < 0, states.join(','));
	video.fire('playing');
	check('the page was told the picture resumed once it played',
		states.filter((s) => s === 'resumed').length === 1, states.join(','));
}

async function pausedTimerClearedOnDestroy() {
	group('the paused-state timer is cleared on destroy, arming nothing later (#317)');
	const env = makeEnv();
	const video = {
		muted: true, volume: 1, srcObject: null, paused: true,
		play() { return Promise.resolve(); },
	};
	const p = env.MajesticWebRTC.attach(video, {});
	await tick();
	env.pcs[0].ontrack({ streams: [{}], track: { kind: 'video' } });
	await tick();
	p.destroy();
	await tick(850);
	check('no gesture armed after destroy', (env.docHandlers.pointerdown || []).length === 0,
		JSON.stringify((env.docHandlers.pointerdown || []).length));
}

async function playsBeforeDebounceNoFlash() {
	group('a WebRTC picture that plays right after a refused muted play() never flashes the affordance (#317)');
	// The reject-path arms the retry at once so a tap works, but the
	// announcement is debounced: a picture that then plays must not flash it.
	const env = makeEnv();
	const states = [];
	const handlers = {};
	let plays = 0;
	const video = {
		muted: true, volume: 1, srcObject: null, paused: true,
		play() { plays++; return plays === 1 ? Promise.reject(new DOMException('x', 'NotAllowedError')) : Promise.resolve(); },
		addEventListener(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
		removeEventListener(ev, fn) { handlers[ev] = (handlers[ev] || []).filter((f) => f !== fn); },
		fire(ev) { (handlers[ev] || []).slice().forEach((f) => f({ target: this })); },
	};
	env.MajesticWebRTC.attach(video, { onState: (s) => states.push(s) });
	await tick();
	env.pcs[0].ontrack({ streams: [{}], track: { kind: 'video' } });
	await tick();
	check('the refused muted play() armed the retry at once',
		(env.docHandlers.pointerdown || []).length === 1,
		JSON.stringify((env.docHandlers.pointerdown || []).length));
	check('but nothing is announced yet', states.indexOf('gesture') < 0, states.join(','));
	// The picture plays before the debounce is out.
	await tick(150);
	video.paused = false;
	video.fire('playing');
	await tick(600);
	check('no flash — the affordance never appeared', states.indexOf('gesture') < 0, states.join(','));
	check('and nothing was announced as resumed (it was never up)',
		states.indexOf('resumed') < 0, states.join(','));
}

(async () => {
	for (const t of [reentrancy, cameraTakesMicButSendsNothing, destroyedDuringPrompt, cameraDeclines,
		trackEndsOnItsOwn, destroyStopsMic, insecureContext, refused, playRetriesOnGesture,
		playResolvesButStaysPaused, playbackStartsArmsNothing, gestureAndResumedStates,
		playsBeforeDebounceNoFlash, pausedTimerClearedOnDestroy]) {
		await t();
	}
	done();
})();
