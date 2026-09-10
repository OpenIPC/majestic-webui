// The live bitstream over an RTCDataChannel: a FEED, not a fourth transport.
//
// The MSE player (preview.js) and the software rung (preview-wasm.js) drink
// the /ws/video stream — one text `init`, the init segment, then one fMP4
// fragment per frame. A camera that can also carry those same messages over
// a WebRTC data channel lets a lost packet cost one frame instead of the
// growing delay a WebSocket turns it into, and
// finds its way to the camera by ICE — through a NAT, or a relay — where a
// WebSocket needs a route. Nothing about the picture changes, so nothing
// about the transport picker does either: this is tried first inside the
// rung that was going to read /ws/video anyway, and the WebSocket is the
// in-rung fallback. The picker keeps naming the transport exactly once.
//
// What open() returns looks like a WebSocket to its consumer — readyState,
// binaryType, onopen/onmessage/onclose/onerror, send(), close() — plus one
// thing a socket cannot say: onmeta(meta), fired BEFORE onmessage with what
// the camera's header said about the message (its kind, whether it is a
// keyframe, whether frames were lost before it, how long it waited on the
// camera). A consumer that ignores onmeta gets exactly the socket's stream.
//
// EVERY CAMERA→BROWSER MESSAGE carries a 16-byte big-endian header:
//   0 magic 0xA5 · 1 version 1 · 2 kind (1 init text, 2 init segment,
//   3 frame, 4 control) · 3 flags (0x01 keyframe, 0x02 frames were lost
//   before this one, 0x08 a prft box precedes the moof) · 4 part index ·
//   6 part count · 8 seq (per frame; an init carries the seq of the
//   keyframe it precedes) · 12 queue_ms on the camera · 14 reserved
// A message larger than the peer's limit arrives in parts sharing a seq.
//
// LOSS IS THE CAMERA'S TO SIGNAL. The flag says frames were dropped or
// abandoned before this one, and the camera has already asked its own
// encoder for the keyframe that mends it — so a consumer discards until
// that keyframe and asks for nothing. A hole in `seq` that the camera did
// not flag is the one case this end asks, and no more than once per three
// seconds, which is the camera's own limit for drop-driven requests.
//
// WHAT IS REMEMBERED. A camera without the support answers the data
// section with port 0, and that is read off the answer text before it is
// applied — one round trip, then the WebSocket. That and the other ways of
// never getting a picture (the camera refusing, ICE failing, the channel
// never opening, nothing arriving) are remembered for six hours under their
// own key, so a browser is not made to pay the round trip on every load;
// `busy` is never remembered, and a session that worked and then ended is
// blocked for this page's lifetime only. window.MJ_FEED = 'websocket' or
// 'datachannel' overrides the choice, for a harness.
window.MajesticDataChannel = (function () {
	'use strict';

	const HEADER = 16;
	const MAGIC = 0xA5;
	const VERSION = 1;
	const KIND_INIT_JSON = 1, KIND_INIT_SEG = 2, KIND_FRAME = 3, KIND_CONTROL = 4;
	const FLAG_KEYFRAME = 0x01, FLAG_GAP = 0x02, FLAG_PRFT = 0x08;

	// The feed's own demotion memory, apart from the transport's: a
	// WebSocket that failed says nothing about a channel, and the reverse.
	const FEED_KEY = 'mj-feed-auto';
	const FEED_FOR_MS = 6 * 60 * 60 * 1000;
	// ICE and DTLS, then SCTP: on a LAN the channel opens in half a second,
	// through a relay in two. Six is long enough not to give up on a relay
	// and short enough that a camera that will never answer costs one
	// picture's worth of waiting, not a viewer's patience.
	const OPEN_TIMEOUT_MS = 6000;
	// The camera sends the init the moment the channel opens; three seconds
	// of nothing is a channel that is open and carrying nothing.
	const FIRST_MESSAGE_MS = 3000;
	const IDR_MIN_GAP_MS = 3000;
	// A message in parts is at most a 4K keyframe: a few parts of 256 KiB.
	// A reassembly that has grown past either bound is not a message.
	const MAX_PARTS = 64;
	const MAX_MESSAGE_BYTES = 4 << 20;
	const STATS_MS = 1000;

	// Blocked for this page's lifetime: a channel that failed after it had
	// carried a picture. Not remembered — the next load tries again.
	let sessionBlocked = false;

	function available() {
		return typeof window.RTCPeerConnection === 'function' &&
			typeof window.RTCPeerConnection.prototype.createDataChannel === 'function' &&
			!!window.MajesticSignal;
	}

	// Whether to try the channel before the WebSocket on this attach.
	function eligible() {
		if (window.MJ_FEED === 'datachannel') return available();
		if (window.MJ_FEED === 'websocket') return false;
		if (!available() || sessionBlocked) return false;
		const T = window.MajesticTransport;
		return !(T && T.expiring && T.expiring(FEED_KEY, FEED_FOR_MS));
	}

	// The reasons a feed ends, and which are worth six hours of memory.
	// Only the ways of never getting a picture: a session that carried one
	// and then ended is this page's problem, not the camera's, and `busy`
	// says the camera is full now, which it will not be for long.
	function durable(reason) {
		return reason === 'declined' || reason === 'refused' ||
			reason === 'ice-failed' || reason === 'timeout' ||
			reason === 'no-message';
	}
	function demote(reason) {
		if (reason === 'busy') return;
		sessionBlocked = true;
		if (!durable(reason)) return;
		const T = window.MajesticTransport;
		if (T && T.remember) T.remember(FEED_KEY);
	}

	// One message's header and payload, or null for anything that is not
	// ours: a stray text, a short message, another magic. Kinds 1 and 4 are
	// text, decoded here; 2 and 3 stay bytes.
	function unwrap(buf) {
		if (!(buf instanceof ArrayBuffer) || buf.byteLength < HEADER) return null;
		const u8 = new Uint8Array(buf);
		if (u8[0] !== MAGIC || u8[1] !== VERSION) return null;
		const dv = new DataView(buf);
		return {
			kind: u8[2], flags: u8[3],
			part: dv.getUint16(4), parts: dv.getUint16(6),
			seq: dv.getUint32(8), queueMs: dv.getUint16(12),
			payload: buf.slice(HEADER),
		};
	}

	// Parts of one message, keyed by seq and kind, complete when every part
	// is in. Stale partials are evicted when a later seq completes — the
	// camera abandons parts it never sent, and a message whose parts never
	// all arrive is a hole in the sequence like any other; no timers.
	function reassembler() {
		const pending = {};
		let dropped = 0, joined = 0;
		function key(m) { return m.kind + ':' + m.seq; }
		return {
			push(m) {
				if (m.parts > MAX_PARTS || m.part >= m.parts) { dropped++; return null; }
				let out;
				if (m.parts <= 1) {
					out = m.payload;
				} else {
					const k = key(m);
					let p = pending[k];
					if (!p) p = pending[k] = { seq: m.seq, got: 0, bytes: 0, parts: new Array(m.parts) };
					if (!p.parts[m.part]) { p.parts[m.part] = m.payload; p.got++; p.bytes += m.payload.byteLength; }
					if (p.bytes > MAX_MESSAGE_BYTES) { delete pending[k]; dropped++; return null; }
					if (p.got < m.parts) return null;
					delete pending[k];
					const joinedBytes = new Uint8Array(p.bytes);
					let at = 0;
					for (let i = 0; i < m.parts; i++) { joinedBytes.set(new Uint8Array(p.parts[i]), at); at += p.parts[i].byteLength; }
					joined++;
					out = joinedBytes.buffer;
				}
				// The camera sends in order, so anything older than a message
				// that just completed — split or not — is still waiting for
				// parts that will never come; it goes now, not when the next
				// split message happens to complete.
				Object.keys(pending).forEach(function (o) {
					if (pending[o].seq < m.seq) { delete pending[o]; dropped++; }
				});
				return out;
			},
			stats() { return { partsReassembled: joined, partsDropped: dropped, pending: Object.keys(pending).length }; },
		};
	}

	// The camera answered the data section with port 0: a daemon without
	// the support. Read off the text, before setRemoteDescription: one
	// round trip, and no session to tear down.
	function sdpDeclined(sdp) {
		return window.MajesticSignal.sdpPort(sdp, 'application') <= 0;
	}

	// The `sr=<rtp>:<wallMs>` key of the camera's stats line: the wall clock
	// instant the camera captured at, for a page that wants to say what time
	// it is on the camera without trusting this browser's clock.
	function clockOf(cam, atMs) {
		const sr = cam && cam.sr;
		if (!sr) return null;
		const i = sr.indexOf(':');
		const wall = i > 0 ? parseInt(sr.slice(i + 1), 10) : NaN;
		return isFinite(wall) ? { wallMs: wall, atMs: atMs } : null;
	}

	// Open a feed for `stream` (the exact /ws/video stream number). Resolves
	// through the returned object's handlers, never a promise, so the
	// consumer can treat it as the socket it replaces.
	function open(opts) {
		opts = opts || {};
		const stream = opts.stream | 0;
		const S = window.MajesticSignal;
		const feed = {
			readyState: 0, binaryType: 'arraybuffer',
			onopen: null, onmessage: null, onmeta: null, onclose: null, onerror: null,
			// What the consumer would have written to the socket: the one
			// line /ws/video takes, {"request":"idr"}, goes both ways a
			// camera listens — on the channel and on the signalling socket.
			send: function (text) {
				if (feed.readyState !== 1) return;
				if (/"idr"/.test(String(text))) {
					try { if (dc && dc.readyState === 'open') dc.send(String(text)); } catch (e) {}
					sig.send('idr', '');
					idrRequests++;
				}
			},
			close: function () { finish(null); },
			stats: stats,
		};
		let pc = null, dc = null, sig = null, ended = false;
		let openTimer = null, firstTimer = null, statsTimer = null;
		let rxBytes = 0, msgs = 0, seqGaps = 0, camGaps = 0, late = 0, lastSeq = 0;
		let idrRequests = 0, lastIdrAt = 0, gotMessage = false;
		let rttMs = null, cam = {}, camAt = 0, served = null, lastQueueMs = 0, keyframes = 0;
		const parts = reassembler();

		function stats() {
			const ps = parts.stats();
			return {
				feed: 'datachannel', rxBytes: rxBytes, msgs: msgs, keyframes: keyframes,
				seqGaps: seqGaps, camGaps: camGaps, late: late, idrRequests: idrRequests,
				partsReassembled: ps.partsReassembled, partsDropped: ps.partsDropped,
				rttMs: rttMs, queueMs: lastQueueMs, cam: cam, served: served,
				clock: clockOf(cam, camAt),
			};
		}

		// Ends the feed exactly once. `reason` null is the consumer's own
		// close: nothing to remember, nothing to report.
		function finish(reason) {
			if (ended) return;
			ended = true;
			clearTimeout(openTimer); clearTimeout(firstTimer); clearInterval(statsTimer);
			if (dc) { try { dc.onopen = dc.onmessage = dc.onclose = dc.onerror = null; dc.close(); } catch (e) {} dc = null; }
			if (pc) { try { pc.onicecandidate = pc.oniceconnectionstatechange = null; pc.close(); } catch (e) {} pc = null; }
			if (sig) { sig.close(); sig = null; }
			const was = feed.readyState;
			feed.readyState = 3;
			if (reason === null) return;
			demote(reason);
			if (was !== 1 && feed.onerror) { try { feed.onerror({ reason: reason }); } catch (e) {} }
			if (feed.onclose) { try { feed.onclose({ code: 4000, reason: reason, wasClean: false }); } catch (e) {} }
		}

		function pollRtt() {
			if (!pc || !pc.getStats) return;
			pc.getStats().then(function (report) {
				if (ended) return;
				report.forEach(function (r) {
					if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded' &&
						typeof r.currentRoundTripTime === 'number') {
						rttMs = Math.round(r.currentRoundTripTime * 1000);
					}
				});
			}).catch(function () {});
		}

		function onChannelMessage(ev) {
			if (ended) return;
			if (typeof ev.data === 'string') return; // nothing textual is ours
			const m = unwrap(ev.data);
			if (!m) return;
			rxBytes += ev.data.byteLength;
			if (!gotMessage) { gotMessage = true; clearTimeout(firstTimer); }
			const payload = parts.push(m);
			if (payload === null) return;
			msgs++;
			lastQueueMs = m.queueMs;
			const meta = {
				seq: m.seq, kind: m.kind, flags: m.flags,
				key: !!(m.flags & FLAG_KEYFRAME),
				gap: !!(m.flags & FLAG_GAP),
				prft: !!(m.flags & FLAG_PRFT),
				parts: m.parts, queueMs: m.queueMs,
			};
			if (m.kind === KIND_FRAME) {
				if (meta.key) keyframes++;
				if (meta.gap) camGaps++;
				if (lastSeq && m.seq > lastSeq + 1) {
					// A hole in the sequence: discard until a keyframe. If
					// the camera flagged this very message, it made the hole
					// itself and has already asked for that keyframe — this
					// is that keyframe, as a rule — and asking again costs
					// the link a second one. Only a hole it did not flag is
					// frames it sent and this end never saw, and is asked
					// for — at most every three seconds.
					seqGaps++;
					meta.gap = true;
					const now = Date.now();
					if (!(m.flags & FLAG_GAP) && now - lastIdrAt > IDR_MIN_GAP_MS) { lastIdrAt = now; feed.send('{"request":"idr"}'); }
				}
				if (lastSeq && m.seq <= lastSeq) { late++; return; }
				lastSeq = m.seq;
			}
			if (feed.onmeta) feed.onmeta(meta);
			if (!feed.onmessage) return;
			if (m.kind === KIND_INIT_JSON || m.kind === KIND_CONTROL) {
				let text;
				try { text = new TextDecoder().decode(payload); } catch (e) { return; }
				feed.onmessage({ data: text });
			} else {
				feed.onmessage({ data: payload });
			}
		}

		try {
			pc = new window.RTCPeerConnection({ iceServers: S.iceOf(opts) });
			dc = pc.createDataChannel('video', { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
		} catch (e) {
			setTimeout(function () { finish('refused'); }, 0);
			return feed;
		}
		dc.binaryType = 'arraybuffer';
		dc.onopen = function () {
			if (ended) return;
			clearTimeout(openTimer);
			feed.readyState = 1;
			firstTimer = setTimeout(function () { if (!gotMessage) finish('no-message'); }, FIRST_MESSAGE_MS);
			statsTimer = setInterval(pollRtt, STATS_MS);
			if (feed.onopen) feed.onopen({});
		};
		dc.onmessage = onChannelMessage;
		dc.onclose = function () { finish('closed'); };
		dc.onerror = function () {};
		pc.onicecandidate = function (ev) { if (ev.candidate && sig) sig.send('candidate', ev.candidate.candidate); };
		pc.oniceconnectionstatechange = function () {
			if (!pc) return;
			const s = pc.iceConnectionState;
			if (s === 'failed' || s === 'closed') finish(feed.readyState === 1 ? 'closed' : 'ice-failed');
		};
		openTimer = setTimeout(function () { finish('timeout'); }, OPEN_TIMEOUT_MS);

		sig = S.open(stream, {
			open: function () {
				if (ended) return;
				pc.createOffer().then(function (offer) {
					if (ended) return;
					return pc.setLocalDescription(offer).then(function () {
						if (ended) return;
						sig.send('offer', pc.localDescription.sdp);
					});
				}).catch(function () { finish('refused'); });
			},
			answer: function (sdp) {
				if (ended) return;
				if (sdpDeclined(sdp)) { finish('declined'); return; }
				pc.setRemoteDescription({ type: 'answer', sdp: sdp }).catch(function () { finish('refused'); });
			},
			candidate: function (line, mid) {
				if (ended) return;
				pc.addIceCandidate({ candidate: line, sdpMid: mid }).catch(function () {});
			},
			stats: function (line) { cam = S.parseCam(line); camAt = Date.now(); },
			served: function (m) { served = m; },
			busy: function () { finish('busy'); },
			error: function () { finish('refused'); },
			closed: function () { finish(feed.readyState === 1 ? 'closed' : 'signal-closed'); },
			close: function () { finish(feed.readyState === 1 ? 'closed' : 'signal-closed'); },
		});
		return feed;
	}

	return {
		open: open,
		available: available,
		eligible: eligible,
		durable: durable,
		unwrap: unwrap,
		reassembler: reassembler,
		sdpDeclined: sdpDeclined,
		clockOf: clockOf,
		KIND_INIT_JSON: KIND_INIT_JSON, KIND_INIT_SEG: KIND_INIT_SEG,
		KIND_FRAME: KIND_FRAME, KIND_CONTROL: KIND_CONTROL,
		FLAG_KEYFRAME: FLAG_KEYFRAME, FLAG_GAP: FLAG_GAP, FLAG_PRFT: FLAG_PRFT,
		HEADER: HEADER,
		FEED_KEY: FEED_KEY,
		// For the tests, and for a page that wants a fresh session verdict.
		_reset: function () { sessionBlocked = false; },
	};
})();
