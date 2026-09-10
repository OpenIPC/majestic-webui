// The data-channel feed: the header it unwraps, the parts it joins, and the
// session it runs on stubs — a camera that declines, one that is busy, one
// that never opens, one that opens and sends nothing, and one that works and
// loses frames. Every outcome is judged by what reaches the consumer and
// what is remembered, because those are the two things a page acts on.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const A = (f) => path.join(__dirname, '..', 'www', 'a', f);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function header(kind, flags, part, parts, seq, queueMs, payload) {
	const u8 = new Uint8Array(16 + payload.length);
	u8[0] = 0xA5; u8[1] = 1; u8[2] = kind; u8[3] = flags;
	u8[4] = part >> 8; u8[5] = part & 255; u8[6] = parts >> 8; u8[7] = parts & 255;
	u8[8] = seq >>> 24; u8[9] = (seq >>> 16) & 255; u8[10] = (seq >>> 8) & 255; u8[11] = seq & 255;
	u8[12] = queueMs >> 8; u8[13] = queueMs & 255;
	u8.set(payload, 16);
	return u8.buffer;
}
const bytes = (s) => new TextEncoder().encode(s);

function load(o) {
	o = o || {};
	const env = { sockets: [], pcs: [], store: {}, now: 1000000 };
	function WebSocket(url) {
		this.url = url; this.readyState = 1; this.sent = [];
		env.sockets.push(this);
		setTimeout(() => { if (this.onopen) this.onopen(); }, 0);
	}
	WebSocket.prototype.send = function (d) { this.sent.push(JSON.parse(d)); };
	WebSocket.prototype.close = function () { this.readyState = 3; };
	function Channel() { this.readyState = 'connecting'; this.sent = []; }
	Channel.prototype.send = function (d) { this.sent.push(d); };
	Channel.prototype.close = function () { this.readyState = 'closed'; };
	function RTCPeerConnection(cfg) {
		this.cfg = cfg; this.remote = null; this.iceConnectionState = 'new'; this.closed = false;
		env.pcs.push(this);
	}
	RTCPeerConnection.prototype.createDataChannel = function (label, opts) {
		this.dc = new Channel(); this.dcOpts = opts; return this.dc;
	};
	RTCPeerConnection.prototype.createOffer = function () { return Promise.resolve({ sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' }); };
	RTCPeerConnection.prototype.setLocalDescription = function (d) { this.localDescription = d; return Promise.resolve(); };
	RTCPeerConnection.prototype.setRemoteDescription = function (d) { this.remote = d; return Promise.resolve(); };
	RTCPeerConnection.prototype.addIceCandidate = function () { return Promise.resolve(); };
	RTCPeerConnection.prototype.getStats = function () { return Promise.resolve({ forEach() {} }); };
	RTCPeerConnection.prototype.close = function () { this.closed = true; };
	const localStorage = {
		getItem: (k) => (k in env.store ? env.store[k] : null),
		setItem: (k, v) => { env.store[k] = String(v); },
		removeItem: (k) => { delete env.store[k]; },
	};
	const win = { RTCPeerConnection: RTCPeerConnection, MJ_FEED: o.feed };
	const timers = { pending: [] };
	const ctx = {
		window: win, RTCPeerConnection: RTCPeerConnection, WebSocket: WebSocket,
		localStorage: localStorage, location: { protocol: 'http:', host: 'camera' },
		TextDecoder: TextDecoder, TextEncoder: TextEncoder, Uint8Array: Uint8Array, DataView: DataView,
		ArrayBuffer: ArrayBuffer, Date: { now: () => env.now },
		setTimeout: (fn, ms) => { const t = { fn, at: env.now + ms, id: timers.pending.length + 1 }; timers.pending.push(t); return t.id; },
		clearTimeout: (id) => { timers.pending = timers.pending.filter((t) => t.id !== id); },
		setInterval: () => 0, clearInterval: () => {},
		console: console, JSON: JSON, Promise: Promise, RegExp: RegExp, Object: Object, Array: Array, String: String, parseInt: parseInt, isFinite: isFinite,
	};
	ctx.globalThis = ctx;
	vm.createContext(ctx);
	for (const f of ['preview-signal.js', 'preview-transport.js', 'preview-datachannel.js']) vm.runInContext(fs.readFileSync(A(f), 'utf8'), ctx);
	env.DC = win.MajesticDataChannel;
	env.T = win.MajesticTransport;
	// Advance the fake clock and fire what became due.
	env.tick = async (ms) => {
		env.now += ms;
		const due = timers.pending.filter((t) => t.at <= env.now);
		timers.pending = timers.pending.filter((t) => t.at > env.now);
		due.forEach((t) => t.fn());
		await sleep(2);
	};
	env.sock = () => env.sockets[env.sockets.length - 1];
	env.pc = () => env.pcs[env.pcs.length - 1];
	env.reply = (m) => env.sock().onmessage({ data: JSON.stringify(m) });
	return env;
}

const ANSWER_OK = 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=sctp-port:5000\r\n';
const ANSWER_DECLINED = 'v=0\r\nm=application 0 UDP/DTLS/SCTP webrtc-datachannel\r\n';

(async () => {
	group('the header');
	{
		const env = load();
		const m = env.DC.unwrap(header(3, 0x09, 0, 1, 42, 7, bytes('moof')));
		check('kind, flags, parts, seq, queue delay read big-endian', m && m.kind === 3 && m.flags === 9 && m.part === 0 && m.parts === 1 && m.seq === 42 && m.queueMs === 7);
		check('payload follows the 16-byte header', m && new TextDecoder().decode(m.payload) === 'moof');
		check('a short message is not ours', env.DC.unwrap(new Uint8Array([1, 2, 3]).buffer) === null);
		const bad = header(3, 0, 0, 1, 1, 0, bytes('x')); new Uint8Array(bad)[0] = 0x55;
		check('another magic is not ours', env.DC.unwrap(bad) === null);
	}

	group('parts');
	{
		const env = load();
		const r = env.DC.reassembler();
		check('a single part is complete at once', r.push(env.DC.unwrap(header(3, 0, 0, 1, 1, 0, bytes('one')))) !== null);
		check('the second part of two, alone, waits', r.push(env.DC.unwrap(header(3, 0, 1, 2, 2, 0, bytes('B')))) === null);
		const whole = r.push(env.DC.unwrap(header(3, 0, 0, 2, 2, 0, bytes('A'))));
		check('parts join in index order whatever order they arrived', whole && new TextDecoder().decode(whole) === 'AB');
		// The camera sends in order, so a message that completes after a
		// partial — split or not — is proof the partial's missing parts
		// will never come; it goes then, not when the next split message
		// happens to complete, or a lost part per keyframe would pile up.
		r.push(env.DC.unwrap(header(3, 0, 0, 2, 5, 0, bytes('x'))));
		check('a partial left by a lost part waits', r.stats().pending === 1);
		r.push(env.DC.unwrap(header(3, 0, 0, 1, 6, 0, bytes('y'))));
		check('a later single-part message evicts the stale partial', r.stats().pending === 0 && r.stats().partsDropped === 1);
		r.push(env.DC.unwrap(header(3, 0, 0, 2, 7, 0, bytes('x'))));
		r.push(env.DC.unwrap(header(3, 0, 0, 2, 8, 0, bytes('p'))));
		r.push(env.DC.unwrap(header(3, 0, 1, 2, 8, 0, bytes('q'))));
		check('and so does a later split message completing', r.stats().pending === 0 && r.stats().partsDropped === 2);
		check('more parts than a message can have are refused', r.push(env.DC.unwrap(header(3, 0, 0, 100, 9, 0, bytes('z')))) === null && r.stats().partsDropped === 3);
	}

	group('eligibility');
	{
		let env = load();
		check('eligible with WebRTC, the signalling module and no memory', env.DC.eligible() === true);
		env.T.remember(env.DC.FEED_KEY);
		check('a fresh demotion makes the WebSocket first', env.DC.eligible() === false);
		env.now += 7 * 60 * 60 * 1000;
		check('an expired demotion is cleared and the channel tried again', env.DC.eligible() === true && env.store['mj-feed-auto'] === undefined);
		env.store['mj-feed-auto'] = String(env.now + 60 * 60 * 1000);
		check('a demotion from the future is a clock that moved: cleared', env.DC.eligible() === true && env.store['mj-feed-auto'] === undefined);
		env = load({ feed: 'websocket' });
		check('MJ_FEED=websocket forces the socket', env.DC.eligible() === false);
		env = load({ feed: 'datachannel' });
		env.T.remember(env.DC.FEED_KEY);
		check('MJ_FEED=datachannel forces the channel past a demotion', env.DC.eligible() === true);
	}

	group('a camera that declines the section');
	{
		const env = load();
		const f = env.DC.open({ stream: 1 });
		const closes = [];
		f.onclose = (e) => closes.push(e.reason);
		await sleep(5);
		check('signalling opened on the exact stream', env.sock().url === 'ws://camera/ws/webrtc?stream=1');
		check('one pre-negotiated unordered channel, id 0, no retransmits', env.pc().dcOpts.negotiated === true && env.pc().dcOpts.id === 0 && env.pc().dcOpts.ordered === false && env.pc().dcOpts.maxRetransmits === 0);
		check('the offer went out on the socket', env.sock().sent[0] && env.sock().sent[0].req === 'offer');
		env.reply({ reply: 'answer', data: ANSWER_DECLINED });
		await sleep(2);
		check('closed as declined', closes.length === 1 && closes[0] === 'declined');
		check('the declined answer was never applied', env.pc().remote === null);
		check('peer connection and socket both closed', env.pc().closed && env.sock().readyState === 3);
		check('the demotion is remembered', /^\d+$/.test(env.store['mj-feed-auto'] || ''));
		check('and this page does not try again', env.DC.eligible() === false);
	}

	group('busy is never remembered');
	{
		const env = load();
		const f = env.DC.open({ stream: 0 });
		const closes = [];
		f.onclose = (e) => closes.push(e.reason);
		await sleep(5);
		env.reply({ reply: 'busy', data: 'full' });
		await sleep(2);
		check('busy closes the feed and writes nothing', closes[0] === 'busy' && env.store['mj-feed-auto'] === undefined);
	}

	group('timeouts');
	{
		let env = load();
		let f = env.DC.open({ stream: 0 });
		let closes = [];
		f.onclose = (e) => closes.push(e.reason);
		await sleep(5);
		env.reply({ reply: 'answer', data: ANSWER_OK });
		await sleep(2);
		check('a real answer is applied', env.pc().remote && env.pc().remote.sdp === ANSWER_OK);
		await env.tick(6001);
		check('a channel that never opens times out and is remembered', closes[0] === 'timeout' && /^\d+$/.test(env.store['mj-feed-auto'] || ''));

		env = load();
		f = env.DC.open({ stream: 0 });
		closes = [];
		const opens = [];
		f.onopen = () => opens.push(1);
		f.onclose = (e) => closes.push(e.reason);
		await sleep(5);
		env.reply({ reply: 'answer', data: ANSWER_OK });
		env.pc().dc.readyState = 'open';
		env.pc().dc.onopen();
		check('the channel opening opens the feed', opens.length === 1 && f.readyState === 1);
		await env.tick(3001);
		check('an open channel that sends nothing closes as no-message', closes[0] === 'no-message');
	}

	group('a working feed');
	{
		const env = load();
		const f = env.DC.open({ stream: 0 });
		const got = [], metas = [], closes = [];
		f.onmeta = (m) => metas.push(m);
		f.onmessage = (e) => got.push(e.data);
		f.onclose = (e) => closes.push(e.reason);
		await sleep(5);
		env.reply({ reply: 'answer', data: ANSWER_OK });
		env.reply({ reply: 'served', channel: 0, data: 0, transport: 'data' });
		env.reply({ reply: 'stats', data: 'ice=up dc=up dcq=1/2 sr=123:1788954000000' });
		env.pc().dc.readyState = 'open';
		env.pc().dc.onopen();
		const dc = env.pc().dc;
		dc.onmessage({ data: header(1, 0, 0, 1, 1, 3, bytes('{"type":"init","codec":"h265"}')) });
		dc.onmessage({ data: header(2, 0, 0, 1, 1, 3, bytes('ftypmoov')) });
		dc.onmessage({ data: header(3, 0x01, 0, 1, 1, 4, bytes('moof1')) });
		dc.onmessage({ data: header(3, 0x00, 0, 1, 2, 4, bytes('moof2')) });
		check('the init text arrives as a string', typeof got[0] === 'string' && JSON.parse(got[0]).type === 'init');
		check('the init segment arrives as bytes', got[1] instanceof ArrayBuffer && new TextDecoder().decode(got[1]) === 'ftypmoov');
		check('onmeta precedes onmessage with kind and keyframe', metas.length === 4 && metas[0].kind === 1 && metas[1].kind === 2 && metas[2].kind === 3 && metas[2].key === true && metas[3].key === false);
		check('the camera\'s queue delay is passed on', metas[2].queueMs === 4);
		// A hole the camera did not flag: seq 3 lost, 4 arrives.
		dc.onmessage({ data: header(3, 0x00, 0, 1, 4, 0, bytes('moof4')) });
		check('a hole in seq is reported as a gap', metas[4].gap === true && f.stats().seqGaps === 1);
		check('and a keyframe is asked for, on the channel and on the socket', dc.sent.some((s) => /idr/.test(s)) && env.sock().sent.some((s) => s.req === 'idr'));
		const asked = env.sock().sent.filter((s) => s.req === 'idr').length;
		dc.onmessage({ data: header(3, 0x00, 0, 1, 6, 0, bytes('moof6')) });
		check('a second hole within three seconds asks nothing', env.sock().sent.filter((s) => s.req === 'idr').length === asked);
		// The camera's own flag: no request from this end.
		env.now += 5000;
		dc.onmessage({ data: header(3, 0x02, 0, 1, 7, 0, bytes('moof7')) });
		check('a camera-flagged gap is passed on and needs no request', metas[metas.length - 1].gap === true && f.stats().camGaps === 1 && env.sock().sent.filter((s) => s.req === 'idr').length === asked);
		// A hole the camera flagged on the very message that follows it: its
		// own drop, its own keyframe already asked for. Asking again would
		// cost the link a second keyframe.
		env.now += 5000;
		dc.onmessage({ data: header(3, 0x03, 0, 1, 9, 0, bytes('moof9')) });
		check('a hole the camera flagged asks nothing either', f.stats().seqGaps === 3 && f.stats().camGaps === 2 && env.sock().sent.filter((s) => s.req === 'idr').length === asked);
		// Late: an older seq after a newer one is dropped.
		const before = got.length;
		dc.onmessage({ data: header(3, 0x00, 0, 1, 5, 0, bytes('moof5')) });
		check('a late frame is dropped', got.length === before && f.stats().late === 1);
		const st = f.stats();
		check('stats carry the feed, the served reply, the camera line and its clock', st.feed === 'datachannel' && st.served && st.served.transport === 'data' && st.cam.dc === 'up' && st.clock && st.clock.wallMs === 1788954000000);
		check('an unmeasured RTT is absent, not zero', st.rttMs === null);
		f.send('{"request":"idr"}');
		check('the consumer\'s own request goes to the signalling socket too', env.sock().sent.filter((s) => s.req === 'idr').length === asked + 1);
		dc.onclose();
		check('a session that worked and ended blocks this page only', closes[0] === 'closed' && env.store['mj-feed-auto'] === undefined && env.DC.eligible() === false);
	}

	group('a two-part frame');
	{
		const env = load();
		const f = env.DC.open({ stream: 0 });
		const got = [];
		f.onmessage = (e) => got.push(e.data);
		await sleep(5);
		env.reply({ reply: 'answer', data: ANSWER_OK });
		env.pc().dc.readyState = 'open';
		env.pc().dc.onopen();
		const dc = env.pc().dc;
		dc.onmessage({ data: header(3, 0x01, 1, 2, 1, 0, bytes('B')) });
		dc.onmessage({ data: header(3, 0x01, 0, 2, 1, 0, bytes('A')) });
		check('delivered once, joined, whatever order the parts came in', got.length === 1 && new TextDecoder().decode(got[0]) === 'AB');
		f.close();
		check('the consumer\'s close tears everything down', f.readyState === 3 && env.pc().closed);
	}

	done();
})();
