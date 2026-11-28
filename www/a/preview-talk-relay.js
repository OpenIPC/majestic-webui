// Talk on a camera served over plain HTTP (#762).
//
// A browser gives a microphone only to a secure page. Most cameras have no
// certificate, so on their own http:// Live page Talk could never work, on any
// transport. This module hands the microphone to a page that is secure: a
// small window on the OpenIPC share host (TALK_ORIGIN), opened as a popup. A
// popup is a top-level window, so it is a secure context whatever opened it.
// That window asks for the microphone and runs a sound-only WebRTC session
// with the camera. This page carries only that session's signalling, between
// the window (postMessage) and a /ws/webrtc socket of its own. The audio goes
// from the window straight to the camera on the local network.
//
// The window's half lives in the OpenIPC/website repository,
// service/internal/sharerelay/static/talk.js. That file has the message
// table, and the reasons it plays nothing and keeps the session on the local
// network.
//
// What this half refuses:
//
//  * To forward anything but text frames between this one window, at this one
//    origin, and the one socket it opened for it. Every message is checked
//    for its source window and its origin.
//  * To let the window ask the camera for more than Talk needs. The window is
//    a page this WebUI does not ship: a top-level document cannot be pinned
//    by a hash the way a script can. So what this page will forward is fixed
//    here instead: an offer with exactly one media section, audio, and
//    candidates. Anything else -- a video section, a data channel, another
//    request -- never reaches the camera, so even a changed window gets no
//    picture and no other command through this page.
//  * To mix up sockets. Each socket the window asks for carries its session
//    number, and every word about it goes back with that number, so a reply
//    from a socket the window has moved past cannot land in its new session.
//  * To outlive the window. A window the person closes is noticed within
//    POLL_MS, and its socket is closed. Turning Talk off, or leaving the page,
//    tells the window to stop and closes it.
//  * To start without a click. window.open() is called from the Talk
//    button's own change event, because a popup opened any later is blocked.
//  * To claim Listening. This session's sound plays nowhere. Listening stays
//    with the player, so unlike Talk over the player's own session, the
//    window does not tick it.
window.MajesticTalkRelay = (function () {
	'use strict';

	const TALK_ORIGIN = 'https://talk.share.openipc.cloud';
	const NS = 'mj-talk/1';
	const POLL_MS = 500;
	// An offer and its candidates are a few kilobytes. Anything bigger is
	// not signalling.
	const MAX_FRAME = 256 * 1024;

	// What Talk sends the camera, and nothing else: its offer, audio only, and
	// its candidates.
	function talkFrame(data) {
		let m;
		try { m = JSON.parse(data); } catch (e) { return false; }
		if (!m || typeof m.data !== 'string') return false;
		if (m.req === 'candidate') return true;
		if (m.req !== 'offer') return false;
		const media = m.data.split(/\r?\n/).filter(function (l) { return /^m=/.test(l); });
		return media.length === 1 && /^m=audio /.test(media[0]);
	}

	// Only where the page cannot use a microphone itself (an https:// camera
	// has its own), and where the window will have WebRTC.
	function available() {
		return !window.isSecureContext && typeof window.open === 'function' &&
			typeof window.RTCPeerConnection === 'function';
	}

	function socketUrl(stream) {
		const S = window.MajesticSignal;
		if (S && S.url) return S.url(stream);
		return (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host +
			'/ws/webrtc?stream=' + (stream | 0);
	}

	// opts: stream, camera (the name the window shows), onMic(state, why),
	// with state one of
	//   'window'  the talk window is open, waiting on the person there
	//   'live'    the microphone is capturing and the session is connecting
	//   'on'      the camera is taking the audio
	//   'off'     every ending, with the reason, or '' for a plain stop
	// Returns { stop(), active() }.
	function open(opts) {
		opts = opts || {};
		const onMic = opts.onMic || function () {};
		const stream = opts.stream | 0;
		let win = null;
		try { win = window.open(TALK_ORIGIN + '/', 'mj-talk', 'popup,width=400,height=360'); } catch (e) { win = null; }
		if (!win) {
			onMic('off', 'the browser blocked the talk window: allow pop-ups for this camera');
			return { stop: function () {}, active: function () { return false; } };
		}

		let ws = null, done = false, poll = null;

		function post(m) {
			try { win.postMessage(Object.assign({ ns: NS }, m), TALK_ORIGIN); } catch (e) { /* closed */ }
		}

		// Detach first: a socket closes asynchronously, and its close must not
		// reach a window that has already been told about the next one.
		function closeSocket() {
			const s = ws;
			ws = null;
			if (!s) return;
			try { s.onopen = s.onmessage = s.onclose = s.onerror = null; } catch (e) { /* gone */ }
			try { s.close(); } catch (e) { /* closed */ }
		}

		function openSocket(sid) {
			closeSocket();
			let s;
			try { s = ws = new WebSocket(socketUrl(stream)); } catch (e) { post({ t: 'down', sid: sid }); return; }
			s.onopen = function () { if (ws === s) post({ t: 'up', sid: sid }); };
			s.onmessage = function (ev) {
				if (ws === s && typeof ev.data === 'string') post({ t: 'recv', sid: sid, data: ev.data });
			};
			s.onclose = function () { if (ws === s) { ws = null; post({ t: 'down', sid: sid }); } };
			s.onerror = function () { try { s.close(); } catch (e) { /* closed */ } };
		}

		function end(why, tellWindow) {
			if (done) return;
			done = true;
			closeSocket();
			clearInterval(poll);
			window.removeEventListener('message', onMessage);
			window.removeEventListener('pagehide', onHide);
			if (tellWindow) {
				post({ t: 'stop' });
				try { win.close(); } catch (e) { /* not ours to close */ }
			}
			onMic('off', why || '');
		}

		function onMessage(e) {
			if (done || e.source !== win || e.origin !== TALK_ORIGIN) return;
			const m = e.data;
			if (!m || m.ns !== NS || typeof m.t !== 'string') return;
			if (m.t === 'hello') {
				post({ t: 'camera', name: String(opts.camera || '') });
			} else if (m.t === 'open') {
				if (typeof m.sid === 'number') openSocket(m.sid);
			} else if (m.t === 'send') {
				if (typeof m.data === 'string' && m.data.length <= MAX_FRAME && ws && ws.readyState === 1 &&
					talkFrame(m.data)) ws.send(m.data);
			} else if (m.t === 'state') {
				const why = typeof m.why === 'string' ? m.why : '';
				if (m.s === 'off') end(why, false);
				// The window's own prompt is the window's: the button here
				// stays usable, to close it.
				else if (m.s === 'asking') onMic('window', why);
				else if (m.s === 'live' || m.s === 'on') onMic(m.s, why);
			}
		}

		function onHide() { end('', true); }

		window.addEventListener('message', onMessage);
		window.addEventListener('pagehide', onHide);
		poll = setInterval(function () { if (win.closed) end('', false); }, POLL_MS);
		onMic('window', '');

		return {
			stop: function () { end('', true); },
			active: function () { return !done; },
		};
	}

	return { available: available, open: open, origin: TALK_ORIGIN };
})();
