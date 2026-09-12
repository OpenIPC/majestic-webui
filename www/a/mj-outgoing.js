// What a publishing destination is doing, and what to say about it.
//
// The camera answers for every destination it was configured with. This turns
// one of those answers into words: a badge, a line for the row, and — when
// somebody opens the row — the paragraphs that say what is actually wrong and
// whose problem it is.
//
// Kept away from the DOM so the wording can be tested, which is the part worth
// testing. A sentence about a camera the reader cannot see is a confident
// claim, and every branch of it is silent when it is wrong: a destination
// losing half its packets draws exactly like one that is fine.
//
// THE ONE RULE. An absent reading is not zero. The camera omits a key it
// cannot answer — a destination with nothing talking back genuinely does not
// know its loss — so a missing figure means "nobody said", and painting that
// as a measurement invents a green light nobody earned. Everything below
// gates on presence, never on truthiness.
(function () {
	'use strict';

	const STATES = ['off', 'connecting', 'live', 'retrying', 'failed'];
	const PROTOCOLS = ['rtmp', 'rtmps', 'rtp', 'unix', 'whip'];

	// Must stay in step with the scheme table in mj-servers.js: the page
	// corroborates a row's address against the protocol the camera reports,
	// and a disagreement means the two are describing different destinations.
	const PROTO_NAME = {
		rtmp: 'RTMP', rtmps: 'RTMPS', rtp: 'RTP',
		unix: 'UNIX', whip: 'WHIP',
	};

	// Long enough to say what went wrong, short enough not to become the page.
	const ERR_MAX = 200;

	// Loss worth mentioning. Below this a link is doing what links do.
	const LOSS_NOTICEABLE = 20;   // 2%
	// A destination that has come back this many times is flapping, not
	// recovering.
	const FLAPPING = 3;
	// How long to wait before "connecting" reads as "not connecting".
	const SLOW_CONNECT_MS = 30000;

	function isNum(v) {
		return typeof v === 'number' && isFinite(v) && v >= 0;
	}

	// One destination, sanitised. Anything the camera did not say, or said in
	// a shape this does not recognise, is dropped rather than coerced — a
	// string "918273645" is not a byte count, and Number() on it would invent
	// one.
	function readOne(raw) {
		if (!raw || typeof raw !== 'object') return null;
		if (!Number.isInteger(raw.index) || raw.index < 0) return null;

		const st = { index: raw.index };
		if (STATES.indexOf(raw.state) >= 0) st.state = raw.state;
		if (PROTOCOLS.indexOf(raw.protocol) >= 0) st.protocol = raw.protocol;
		if (Number.isInteger(raw.channel)) st.channel = raw.channel;

		['sinceMs', 'txBytes', 'attempts', 'reconnects', 'retryInMs',
			'lastErrorAgoMs', 'packetsSent', 'keyframeRequests', 'lossPermille',
			'lastReportAgoMs', 'peerEstimateKbps', 'sendKbps', 'encoderKbps',
		].forEach(function (k) {
			if (isNum(raw[k])) st[k] = raw[k];
		});

		if (typeof raw.bandwidthLimited === 'boolean') {
			st.bandwidthLimited = raw.bandwidthLimited;
		}
		if (typeof raw.lastError === 'string' && raw.lastError.trim() !== '') {
			const t = raw.lastError.trim();
			// Stays text forever. It is the camera's own words and, for one
			// protocol, partly a remote server's — never markup, never parsed.
			st.lastError = t.length > ERR_MAX ? t.slice(0, ERR_MAX) + '…' : t;
		}
		return st;
	}

	// The whole reply. null means nobody answered anything usable — never an
	// empty object, because "the camera did not say" and "the camera said
	// nothing is configured" are different facts and the second one is real.
	function read(json) {
		if (!json || typeof json !== 'object') return null;
		if (!Array.isArray(json.destinations)) return null;

		const byIndex = Object.create(null);
		let count = 0;
		json.destinations.forEach(function (raw) {
			const st = readOne(raw);
			if (!st) return;
			// First wins, the way the metrics parser resolves a duplicate.
			if (st.index in byIndex) return;
			byIndex[st.index] = st;
			count++;
		});
		return {
			known: true,
			byIndex: byIndex,
			count: count,
			truncated: json.truncated === true,
		};
	}

	// Whether a row's own address and the camera's answer describe the same
	// destination. False only when both are known and differ — a disagreement
	// means the join is wrong, and one destination's numbers under another's
	// address is worse than no numbers at all.
	function agrees(st, protoName) {
		if (!st || !st.protocol || !protoName) return true;
		return PROTO_NAME[st.protocol] === protoName;
	}

	function plural(n, one, many) { return n === 1 ? one : many; }

	// "12 s", "4 min", "2 h 11 min", "3 days". Empty for an absent reading.
	function since(ms) {
		if (!isNum(ms)) return '';
		const s = Math.floor(ms / 1000);
		if (s < 60) return s + ' s';
		const m = Math.floor(s / 60);
		if (m < 60) return m + ' min';
		const h = Math.floor(m / 60);
		if (h < 24) return h + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
		const d = Math.floor(h / 24);
		return d + ' ' + plural(d, 'day', 'days');
	}

	// A decimal below ten per cent, because that is the band where the
	// difference is worth acting on: 2.5% and 3% are not the same report to
	// somebody tuning a link, and rounding hid it. Above ten the decimal is
	// noise on a number that is already bad news.
	function pct(permille) {
		if (!isNum(permille)) return '';
		const v = permille / 10;
		return (v < 10 ? String(Math.round(v * 10) / 10) : String(Math.round(v))) + '%';
	}

	function bytes(n) {
		if (!isNum(n)) return '';
		const u = ['B', 'kB', 'MB', 'GB', 'TB'];
		let i = 0, v = n;
		while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
		return (i === 0 ? v : v.toFixed(1)) + ' ' + u[i];
	}

	function bps(n) {
		if (!isNum(n)) return '';
		const u = ['bit/s', 'kbit/s', 'Mbit/s', 'Gbit/s'];
		let i = 0, v = n;
		while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
		return (i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + u[i];
	}

	// A rate across two samples, or null. Never zero for an unknown: a
	// counter that went backwards is a destination that reconnected, and a
	// missing count is a destination that does not report one.
	function rate(prevBytes, curBytes, dtMs) {
		if (!isNum(prevBytes) || !isNum(curBytes)) return null;
		if (!isNum(dtMs) || dtMs <= 0) return null;
		if (curBytes < prevBytes) return null;
		return ((curBytes - prevBytes) * 8) / (dtMs / 1000);
	}

	function limited(st) { return st.bandwidthLimited === true; }
	function lossy(st) {
		return isNum(st.lossPermille) && st.lossPermille >= LOSS_NOTICEABLE;
	}
	function flapping(st) {
		return isNum(st.reconnects) && st.reconnects >= FLAPPING;
	}

	// What this destination cannot tell you, said once and never as a
	// warning. Silence about a measurement is not the same as a good reading,
	// and a page that never distinguishes them teaches people to trust a
	// blank.
	function limitsOf(st) {
		const out = [];
		// Only for a destination that is actually carrying something. These
		// answer "why is there no figure for that here?", which is a question
		// somebody asks while reading a running destination's numbers — on a
		// row that is switched off or has never connected, "nothing has
		// reported back yet" says the obvious about the wrong thing.
		if (st.state !== 'live') return out;
		if (st.protocol === 'unix') {
			out.push('This destination is a socket on the camera itself, so ' +
				'there is no network in between and nothing to lose on the way.');
			return out;
		}
		const noLoss = !isNum(st.lossPermille);
		const noRate = !isNum(st.peerEstimateKbps);
		// A destination with no back channel at all answers both questions
		// the same way, and two paragraphs of it in a row read as a stutter.
		if (noLoss && noRate && st.protocol !== 'rtp' && st.protocol !== 'whip') {
			out.push('This kind of destination does not tell the camera what ' +
				'reaches the far end, so nothing here can say how much of the ' +
				'stream is arriving or whether the connection is keeping up.');
			return out;
		}
		if (noLoss) {
			// "Yet" is a promise, and only one of these can keep it: a plain
			// stream to an address can start being reported on at any moment,
			// where the others have no channel for it at all and never will.
			if (st.protocol === 'rtp') {
				out.push('Nothing has reported back from this destination ' +
					'yet, so there is no way to tell how much of the stream ' +
					'is arriving.');
			} else if (st.protocol === 'whip') {
				// The receiver does report it; this camera does not read it
				// back out. Whose shortcoming it is decides who can fix it.
				out.push('This camera does not report how much of the stream ' +
					'is arriving at this destination.');
			} else {
				out.push('This kind of destination does not tell the camera ' +
					'how much of the stream is arriving at the far end.');
			}
		}
		if (noRate) {
			// A destination that could say has not said yet, against one that
			// has no way of saying at all.
			out.push(st.protocol === 'whip'
				? 'The receiver has not yet said how much this connection ' +
					'can carry.'
				: 'This kind of destination does not tell the camera how much ' +
					'the connection can carry, so nothing here can say whether ' +
					'it is keeping up.');
		}
		return out;
	}

	// The verdict. `ctx` carries what the page knows and the camera does not:
	// whether the row is switched on here, and how long ago the sample
	// arrived, so a countdown ticks between polls.
	function verdict(st, ctx) {
		const c = ctx || {};
		const age = isNum(c.ageMs) ? c.ageMs : 0;
		const v = {
			known: false, sev: 'unknown', badge: '', short: '',
			detail: [], reasonLead: '', reason: '', limits: [],
		};
		if (!st) return v;

		v.known = true;
		v.limits = limitsOf(st);
		if (st.lastError) v.reason = st.lastError;

		const held = isNum(st.sinceMs) ? st.sinceMs + age : null;
		const forStr = since(held);

		switch (st.state) {
		case 'live': {
			const bad = [];
			if (limited(st)) bad.push('limited');
			if (lossy(st)) bad.push('loss');

			if (bad.length === 2) {
				v.sev = 'warn';
				v.badge = 'Limited';
				v.short = 'The connection cannot carry the whole stream — the ' +
					'camera is sending less, and about ' + pct(st.lossPermille) +
					' of that is still not arriving.';
			} else if (limited(st)) {
				v.sev = 'warn';
				v.badge = 'Limited';
				v.short = 'The connection cannot carry the whole stream, so the ' +
					'camera is sending less to this destination.';
			} else if (lossy(st)) {
				v.sev = 'warn';
				v.badge = 'Packet loss';
				v.short = 'About ' + pct(st.lossPermille) + ' of what the camera ' +
					'sends to this destination is not arriving.';
			} else if (flapping(st)) {
				v.sev = 'warn';
				v.badge = 'Live';
				v.short = (forStr ? 'Publishing for ' + forStr + ', but the ' : 'The ') +
					'camera has counted ' + st.reconnects + ' reconnections to ' +
					'this destination.';
			} else {
				v.sev = 'ok';
				v.badge = 'Live';
				v.short = forStr ? 'Publishing for ' + forStr + '.' : 'Publishing.';
			}

			if (limited(st)) {
				v.detail.push('The receiver reports it can take about ' +
					bps(st.peerEstimateKbps * 1000) + ', and the camera is holding ' +
					'what it sends down to match. The picture arriving there is ' +
					'coarser or jerkier than the camera is set to produce.');
				v.detail.push('This is the network between the camera and the ' +
					'receiver, not the camera itself. A stronger signal, a wired ' +
					'link, a lower bitrate, or sending the sub stream to this ' +
					'destination instead of the main one are what change it.');
			}
			if (lossy(st)) {
				v.detail.push('About ' + pct(st.lossPermille) + ' of the packets ' +
					'sent to this destination are not arriving. Whatever the ' +
					'receiver shows or records will break up in bursts. Loss ' +
					'happens on the network in between; the camera is sending them.');
			}
			if (flapping(st)) {
				v.detail.push('Every reconnection is a gap in what the receiver ' +
					'got. A destination that keeps dropping is usually the network ' +
					'in between, or a receiver that closes the connection when it ' +
					'falls behind.');
			}
			if (isNum(st.keyframeRequests) && st.keyframeRequests > 0) {
				v.detail.push('A receiver asks for a fresh keyframe when it has ' +
					'lost the picture, so a rising count is another sign of a ' +
					'lossy link.');
			}
			if (v.reason) {
				v.reasonLead = 'An earlier attempt to reach this destination ' +
					'failed. The camera reported:';
			}
			break;
		}
		case 'connecting': {
			const slow = isNum(held) && held >= SLOW_CONNECT_MS;
			v.sev = slow ? 'warn' : 'info';
			v.badge = 'Connecting';
			v.short = slow
				? 'Still trying to connect after ' + forStr + '.'
				: 'Connecting…';
			if (slow) {
				v.detail.push('Nothing has answered yet. Check that the address ' +
					'is right and that whatever should receive it is running.');
			}
			if (v.reason) {
				v.reasonLead = 'The last attempt failed' +
					(isNum(st.lastErrorAgoMs)
						? ' ' + since(st.lastErrorAgoMs + age) + ' ago'
						: '') + '. The camera reported:';
			}
			break;
		}
		case 'retrying': {
			v.sev = 'warn';
			v.badge = 'Reconnecting';
			// The countdown is what the sample said, less how long ago it
			// said it — and never a negative, which would read as overdue.
			const left = isNum(st.retryInMs) ? st.retryInMs - age : null;
			const when = isNum(left) && left > 0 ? ' in ' + since(left) : '';
			const tries = isNum(st.attempts) && st.attempts > 1
				? ' after ' + st.attempts + ' attempts'
				: '';
			v.short = 'Disconnected' + tries + ' — trying again' + when + '.';
			if (v.reason) {
				v.reasonLead = 'The last attempt failed' +
					(isNum(st.lastErrorAgoMs)
						? ' ' + since(st.lastErrorAgoMs + age) + ' ago'
						: '') + '. The camera reported:';
			}
			break;
		}
		case 'failed': {
			v.sev = 'danger';
			v.badge = 'Not connected';
			v.short = 'The camera is not publishing to this destination.';
			if (v.reason) v.reasonLead = 'The camera reported:';
			break;
		}
		case 'off': {
			if (c.rowEnabled) {
				v.sev = 'warn';
				v.badge = 'Not running';
				v.short = 'Switched on, but the camera is not publishing to it.';
			} else {
				v.sev = 'unknown';
				v.badge = 'Off';
				v.short = '';
			}
			break;
		}
		default:
			// A state this build does not know. Saying nothing is the honest
			// answer; guessing would be a claim about a camera that has told
			// us something we cannot read.
			v.badge = 'Unknown';
			v.short = '';
			break;
		}
		return v;
	}

	// The numbers, for the panel. Only what was actually measured, in the
	// order somebody reads them.
	function facts(st, bitsPerSecond) {
		const out = [];
		if (!st) return out;
		if (isNum(bitsPerSecond)) out.push(['Sending', bps(bitsPerSecond)]);
		if (isNum(st.txBytes)) out.push(['Sent in total', bytes(st.txBytes)]);
		if (isNum(st.packetsSent)) {
			out.push(['Packets', String(st.packetsSent)]);
		}
		if (isNum(st.lossPermille)) out.push(['Not arriving', pct(st.lossPermille)]);
		if (isNum(st.lastReportAgoMs)) {
			out.push(['Receiver last reported', since(st.lastReportAgoMs) + ' ago']);
		}
		if (isNum(st.peerEstimateKbps)) {
			out.push(['Receiver can take', bps(st.peerEstimateKbps * 1000)]);
		}
		if (isNum(st.encoderKbps) && st.encoderKbps > 0) {
			out.push(['Encoder held at', bps(st.encoderKbps * 1000)]);
		}
		if (isNum(st.keyframeRequests)) {
			out.push(['Keyframes asked for', String(st.keyframeRequests)]);
		}
		if (isNum(st.reconnects)) out.push(['Reconnections', String(st.reconnects)]);
		return out;
	}

	const api = {
		STATES: STATES, PROTOCOLS: PROTOCOLS, PROTO_NAME: PROTO_NAME,
		ERR_MAX: ERR_MAX,
		read: read, verdict: verdict, agrees: agrees, facts: facts,
		rate: rate, since: since, pct: pct, bytes: bytes, bps: bps,
	};
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticOutgoing = api;
})();
