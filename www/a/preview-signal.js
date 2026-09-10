// The camera's WebRTC signalling socket, on its own.
//
// Two things offer over it now: the WebRTC media player (preview-webrtc.js)
// and the data-channel feed that carries the /ws/video bitstream over an
// RTCDataChannel (preview-datachannel.js). They share nothing else — one
// negotiates a track and the other a byte pipe — but both open the same
// socket, send the same `{req, data}` frames, and read the same replies, and
// two copies of that would drift the way two copies of the transport rules
// did (#402). So the socket lives here, and each caller supplies handlers.
//
// What it is NOT: a policy. Reconnects, attempts, fallback — every decision
// stays with the caller, which is why each handler is a plain function the
// caller binds to its own attempt. A socket only ever speaks to the handlers
// it was opened with; close() detaches them before closing, so a late event
// from a retired socket reaches nobody (the #298 hazard, one layer up).
window.MajesticSignal = (function () {
	'use strict';

	function url(stream) {
		const proto = location.protocol === 'https:' ? 'wss' : 'ws';
		return proto + '://' + location.host + '/ws/webrtc?stream=' + (stream | 0);
	}

	// Open one socket for `stream`. `on` maps what the camera sends to the
	// caller's handlers, each optional:
	//   open()                 the socket is up: offer now
	//   answer(sdp)            the camera's SDP answer
	//   candidate(line, mid)   a trickled ICE candidate and its m-line
	//   stats(line)            the camera's own counters, once a second
	//   served(reply)          which channel is served (#240), the whole reply
	//   busy(text)             every session slot is taken — try again later
	//   error(text)            the camera could not answer this offer
	//   closed(text)           the session ended, with the camera's reason
	//   close()                the socket closed, for any reason
	// Returns a handle: send(req, data), close(), live(), and the socket
	// itself for whoever needs to look at it.
	function open(stream, on) {
		on = on || {};
		const sock = new WebSocket(url(stream));
		sock.onopen = function () { if (on.open) on.open(); };
		sock.onmessage = function (e) {
			let m; try { m = JSON.parse(e.data); } catch (_) { return; }
			if (!m || typeof m.reply !== 'string') return;
			const h = on[m.reply];
			if (typeof h !== 'function') return;
			if (m.reply === 'candidate') h(m.data, m.mid);
			else if (m.reply === 'served') h(m);
			else h(m.data);
		};
		sock.onclose = function () { if (on.close) on.close(); };
		sock.onerror = function () { try { sock.close(); } catch (e) {} };
		return {
			socket: sock,
			send: function (req, data) {
				if (sock.readyState !== 1) return false;
				sock.send(JSON.stringify({ req: req, data: data === undefined ? '' : data }));
				return true;
			},
			live: function () { return sock.readyState === 1; },
			// Detach before closing: a socket closes asynchronously, and until
			// it does its handlers are still live on a connection nobody wants
			// any more — including the close that would start a reconnect on
			// top of the attempt that replaced it.
			close: function () {
				try { sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null; } catch (e) {}
				try { sock.close(); } catch (e) {}
			},
		};
	}

	// The camera's stats line is `key=value` pairs separated by spaces, with
	// a couple of composites (`rtcp=recv/rejected`, `pli=n(+suppressed)`).
	// Split on the first `=` only and hand the values over as text: the page
	// renders them, and inventing a schema here would mean changing two files
	// every time the camera adds a counter.
	function parseCam(line) {
		const out = {};
		(line || '').split(' ').forEach(function (kv) {
			const i = kv.indexOf('=');
			if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
		});
		return out;
	}

	// The port an SDP gives a media section (`m=<media> <port> ...`), or -1
	// when the section is absent. Zero is how a camera declines a section it
	// does not serve — the one fact a caller wants before applying an answer.
	function sdpPort(sdp, media) {
		const m = new RegExp('^m=' + media + '\\s+(\\d+)\\s', 'm').exec(sdp || '');
		return m ? parseInt(m[1], 10) : -1;
	}

	// The ICE servers a caller was given: a list, or a function returning one
	// (the page fetches the camera's list and the first attach can win the
	// race against it, so it is read at every open rather than once).
	function iceOf(opts) {
		try {
			const v = typeof opts.iceServers === 'function' ? opts.iceServers() : opts.iceServers;
			return v || [];
		} catch (e) { return []; }
	}

	return { open: open, url: url, parseCam: parseCam, sdpPort: sdpPort, iceOf: iceOf };
})();
