// ICE restart (preview-ice.js) in both players that negotiate over
// /ws/webrtc, driven against stubs on a fake clock.
//
// It earns a test on the admission rule: a restart either brings the same
// session back or quietly turns into the reconnect it replaced, and the two
// look alike on screen. Reaching either on a real camera needs a network path
// that dies on demand and stays dead for exactly as long as the case needs,
// which no browser can be made to do. Every case is judged by what crossed
// the socket and what the peer connection was told, because those are what
// the camera acts on.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const A = (f) => path.join(__dirname, '..', 'www', 'a', f);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function load(files) {
	const env = { sockets: [], pcs: [], now: 0, states: [], bytes: 0 };
	let seq = 0, pending = [];

	function WebSocket(url) {
		this.url = url; this.readyState = 1; this.sent = [];
		env.sockets.push(this);
		// The real clock: the socket opens on its own, not when the test
		// advances the fake one.
		setTimeout(() => { if (this.onopen) this.onopen(); }, 0);
	}
	WebSocket.prototype.send = function (d) { this.sent.push(JSON.parse(d)); };
	WebSocket.prototype.close = function () { this.readyState = 3; };

	function Channel() { this.readyState = 'connecting'; }
	Channel.prototype.send = function () {};
	Channel.prototype.close = function () { this.readyState = 'closed'; };

	function RTCPeerConnection() {
		this.iceConnectionState = 'new';
		this.signalingState = 'stable';
		this.offers = []; this.remotes = []; this.added = [];
		this.restarts = 0; this.closed = false;
		env.pcs.push(this);
	}
	const P = RTCPeerConnection.prototype;
	P.addTransceiver = function () { return {}; };
	P.getTransceivers = function () { return []; };
	P.createDataChannel = function () { this.dc = new Channel(); return this.dc; };
	P.restartIce = function () { this.restarts++; };
	P.createOffer = function (o) {
		this.offers.push(o || null);
		return Promise.resolve({ type: 'offer', sdp: 'offer' + this.offers.length });
	};
	P.setLocalDescription = function (d) {
		this.localDescription = d;
		this.signalingState = 'have-local-offer';
		return Promise.resolve();
	};
	P.setRemoteDescription = function (d) {
		this.remotes.push(d.sdp);
		this.signalingState = 'stable';
		return Promise.resolve();
	};
	P.addIceCandidate = function (c) { this.added.push(c.candidate); return Promise.resolve(); };
	P.getStats = function () {
		const b = env.bytes;
		return Promise.resolve({
			forEach(fn) { fn({ type: 'inbound-rtp', kind: 'video', bytesReceived: b }); },
		});
	};
	P.close = function () { this.closed = true; };
	// The browser's ICE agent moving, and telling whoever listens.
	P.ice = function (s) {
		this.iceConnectionState = s;
		if (this.oniceconnectionstatechange) this.oniceconnectionstatechange();
	};

	const add = (fn, ms, every) => {
		const t = { fn, at: env.now + (ms || 0), every, id: ++seq };
		pending.push(t);
		return t.id;
	};
	const cancel = (id) => { pending = pending.filter((t) => t.id !== id); };
	const win = { RTCPeerConnection, isSecureContext: true };
	const ctx = {
		window: win, RTCPeerConnection, WebSocket,
		location: { protocol: 'http:', host: 'camera' },
		setTimeout: (fn, ms) => add(fn, ms, 0),
		clearTimeout: cancel,
		setInterval: (fn, ms) => add(fn, ms, ms),
		clearInterval: cancel,
		console, JSON, Promise, Date: { now: () => env.now },
		localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
		TextDecoder, TextEncoder, Uint8Array, DataView, ArrayBuffer, Set,
	};
	ctx.globalThis = ctx;
	vm.createContext(ctx);
	for (const f of files) vm.runInContext(fs.readFileSync(A(f), 'utf8'), ctx);
	env.win = win;

	// Advance the fake clock to `ms` from now, firing each timer in order
	// and letting the promises it started settle before the next.
	env.tick = async (ms) => {
		const end = env.now + ms;
		for (;;) {
			const due = pending.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
			if (!due) break;
			env.now = due.at;
			if (due.every) due.at += due.every; else cancel(due.id);
			due.fn();
			await sleep(1);
		}
		env.now = end;
		await sleep(1);
	};
	env.timers = () => pending.filter((t) => !t.every).length;
	env.sock = () => env.sockets[env.sockets.length - 1];
	env.pc = () => env.pcs[env.pcs.length - 1];
	env.reply = (m) => env.sock().onmessage({ data: JSON.stringify(m) });
	env.offers = () => env.sock().sent.filter((m) => m.req === 'offer');
	return env;
}

const WEBRTC = ['preview-signal.js', 'preview-ice.js', 'preview-webrtc.js'];
const FEED = ['preview-signal.js', 'preview-transport.js', 'preview-ice.js', 'preview-datachannel.js'];

// A WebRTC player whose session has negotiated, connected and played.
async function playing() {
	const env = load(WEBRTC);
	const video = {
		muted: true, volume: 1, srcObject: null, paused: false,
		play: () => Promise.resolve(), addEventListener() {}, removeEventListener() {},
	};
	env.player = env.win.MajesticWebRTC.attach(video, { onState: (s) => env.states.push(s) });
	await sleep(5);
	env.reply({ reply: 'answer', data: 'answer1' });
	await sleep(1);
	env.pc().ice('connected');
	env.bytes = 1000;
	await env.tick(1000);
	return env;
}

// Media keeps arriving, a tick at a time.
async function flow(env, ms) {
	for (let t = 0; t < ms; t += 1000) { env.bytes += 1000; await env.tick(1000); }
}

(async () => {
	group('webrtc: a path down for more than two seconds is restarted');
	{
		const env = await playing();
		const pc = env.pc();
		check('the session played and offered once', env.states.includes('playing') && env.offers().length === 1);
		pc.ice('disconnected');
		await env.tick(1900);
		check('no restart inside the grace', env.offers().length === 1 && pc.restarts === 0);
		await env.tick(200);
		check('then exactly one restart offer, on the same socket', env.offers().length === 2 && env.sockets.length === 1);
		check('asked for with restartIce() and iceRestart', pc.restarts === 1 && pc.offers[1] && pc.offers[1].iceRestart === true);
		check('the same peer connection', env.pcs.length === 1 && !pc.closed);
		// A late candidate of the old generation, then the answer and the
		// new one's, which wait for the answer to be applied.
		env.reply({ reply: 'candidate', data: 'old', mid: '0' });
		check('a candidate while the offer is outstanding is held', !pc.added.includes('old'));
		env.reply({ reply: 'answer', data: 'answer2' });
		env.reply({ reply: 'candidate', data: 'new1', mid: '0' });
		check('and so is one that arrives while the answer is applied', !pc.added.includes('new1'));
		await sleep(2);
		check('the answer is applied', pc.remotes.length === 2 && pc.remotes[1] === 'answer2');
		check('the new generation\'s candidates follow it, the old one\'s do not', pc.added.includes('new1') && !pc.added.includes('old'));
		env.reply({ reply: 'candidate', data: 'new2', mid: '0' });
		await sleep(1);
		check('once applied, candidates go straight in', pc.added.includes('new2'));
		pc.ice('connected');
		await flow(env, 40000);
		check('connected ends it: no further offer', env.offers().length === 2 && env.sockets.length === 1);
		check('nothing reconnected', env.pcs.length === 1 && !pc.closed);
		env.player.destroy();
	}

	group('webrtc: a blip shorter than the grace costs nothing');
	{
		const env = await playing();
		env.pc().ice('disconnected');
		await env.tick(1000);
		env.pc().ice('connected');
		await flow(env, 5000);
		check('no restart offer', env.offers().length === 1);
		env.player.destroy();
	}

	group('webrtc: two failed attempts fall back to a new session');
	{
		const env = await playing();
		const pc = env.pc();
		pc.ice('failed');
		await sleep(2);
		check('failed restarts at once, without the grace', env.offers().length === 2);
		await env.tick(15000);
		check('a second attempt after 15 s', env.offers().length === 3 && pc.offers[2].iceRestart === true);
		check('still the same session', !pc.closed && env.sockets.length === 1);
		await env.tick(15000);
		check('then the session is retired', pc.closed && env.sockets[0].readyState === 3);
		await env.tick(1000);
		check('and a new one opened, as a reconnect does', env.sockets.length === 2 && env.pcs.length === 2);
		check('which starts with an ordinary offer', env.pc().offers.length === 1 && !env.pc().offers[0]);
		env.player.destroy();
	}

	group('webrtc: a stale answer is dropped');
	{
		const env = await playing();
		const pc = env.pc();
		pc.ice('failed');
		await sleep(2);
		// The first attempt's offer goes unanswered; the second supersedes it.
		await env.tick(15000);
		check('two restart offers out', env.offers().length === 3);
		env.reply({ reply: 'answer', data: 'late-for-first' });
		await sleep(2);
		check('the superseded offer\'s answer is not applied', pc.remotes.length === 1 && pc.signalingState === 'have-local-offer');
		env.reply({ reply: 'answer', data: 'for-second' });
		await sleep(2);
		check('the current offer\'s is', pc.remotes.length === 2 && pc.remotes[1] === 'for-second');
		env.reply({ reply: 'answer', data: 'nobody-asked' });
		await sleep(2);
		check('one arriving in stable is ignored, not an error', pc.remotes.length === 2 && !env.states.includes('fallback') && !pc.closed);
		env.player.destroy();
	}

	group('webrtc: the attempt timer finding ICE connected is done');
	{
		const env = await playing();
		const pc = env.pc();
		pc.ice('disconnected');
		await env.tick(2100);
		check('restart offered', env.offers().length === 2);
		env.reply({ reply: 'answer', data: 'answer2' });
		// Chrome may say nothing for a restart of a path that was never
		// really down: the state changes with no event.
		pc.iceConnectionState = 'connected';
		await flow(env, 16000);
		check('no second attempt', env.offers().length === 2 && !pc.closed);
		// And the count was reset: a later loss gets both attempts again.
		pc.ice('failed');
		await sleep(2);
		await env.tick(15000);
		check('a later loss gets its own two attempts', env.offers().length === 4 && !pc.closed);
		env.player.destroy();
	}

	group('webrtc: the stall detector stands down while ICE is down');
	{
		let env = await playing();
		let pc = env.pc();
		// The control: with ICE up, eight seconds of nothing retires it.
		await env.tick(9000);
		check('a stall with ICE connected still reconnects', pc.closed);
		env.player.destroy();

		env = await playing();
		pc = env.pc();
		pc.ice('disconnected');
		await env.tick(14000);
		check('no frames for 14 s with ICE disconnected: the session stands', !pc.closed && env.sockets.length === 1);
		check('the restart owns it', env.offers().length === 2);
		env.player.destroy();
	}

	group('webrtc: a closed signalling socket means a new session');
	{
		const env = await playing();
		const pc = env.pc();
		env.sock().readyState = 3;
		pc.ice('disconnected');
		await env.tick(2100);
		check('no offer into a dead socket, the session is retired', env.offers().length === 1 && pc.closed);
		env.player.destroy();
	}

	group('webrtc: a session that never played is not restarted');
	{
		const env = load(WEBRTC);
		const video = { muted: true, play: () => Promise.resolve(), addEventListener() {}, removeEventListener() {} };
		const p = env.win.MajesticWebRTC.attach(video, {});
		await sleep(5);
		env.reply({ reply: 'answer', data: 'answer1' });
		await sleep(1);
		env.pc().ice('failed');
		await sleep(1);
		check('failed before media is a reconnect, as before', env.pc().closed && env.offers().length === 1);
		p.destroy();
	}

	group('webrtc: teardown takes every timer with it');
	{
		const env = await playing();
		env.pc().ice('disconnected');
		await env.tick(500);
		env.player.destroy();
		check('no timer left behind', env.timers() === 0, env.timers() + ' left');
		await env.tick(20000);
		check('and nothing offered afterwards', env.offers().length === 1);
	}

	group('feed: a working channel restarts ICE instead of ending');
	{
		const env = load(FEED);
		const f = env.win.MajesticDataChannel.open({ stream: 0 });
		const closes = [];
		f.onclose = (e) => closes.push(e.reason);
		await sleep(5);
		env.reply({ reply: 'answer', data: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' });
		await sleep(1);
		const pc = env.pc();
		pc.ice('connected');
		pc.dc.readyState = 'open';
		pc.dc.onopen();
		const msg = new Uint8Array(20); msg[0] = 0xA5; msg[1] = 1; msg[2] = 3; msg[7] = 1; msg[11] = 1;
		pc.dc.onmessage({ data: msg.buffer });
		pc.ice('disconnected');
		await env.tick(2100);
		check('one restart offer with iceRestart, on the same socket', env.offers().length === 2 && pc.offers[1].iceRestart === true && env.sockets.length === 1);
		env.reply({ reply: 'answer', data: 'restart-answer' });
		await sleep(2);
		check('its answer is applied, not read as a declined section', pc.remotes[pc.remotes.length - 1] === 'restart-answer' && closes.length === 0);
		pc.ice('connected');
		await env.tick(20000);
		check('connected: the feed is still open', f.readyState === 1 && closes.length === 0);
		pc.ice('failed');
		await env.tick(30001);
		check('two attempts that fail end it as a working feed ends', closes.length === 1 && closes[0] === 'closed' && pc.closed);
		check('and nothing durable is remembered', env.win.MajesticTransport && !env.win.MajesticDataChannel.durable('closed'));
	}

	group('feed: ICE failing before anything arrived is still ice-failed');
	{
		const env = load(FEED);
		const f = env.win.MajesticDataChannel.open({ stream: 0 });
		const closes = [];
		f.onclose = (e) => closes.push(e.reason);
		await sleep(5);
		env.pc().ice('failed');
		check('no restart, the same ending as before', closes[0] === 'ice-failed' && env.offers().length === 1);
	}

	done();
})();
