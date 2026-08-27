// Which transport a preview should use, and the memory behind that choice.
//
// Two pages need this now — the Preview page and the Live adjustments panel in
// settings — and the rules are subtle enough that two copies would drift within
// a release: a legacy key that has to be migrated exactly once, a demotion that
// expires, a bounded window that rejects clocks running backwards, and the
// difference between a camera that cannot serve this browser and one that is
// merely busy. Divergence there would show up as "the preview behaves
// differently on the settings page", which is the kind of bug nobody files.
//
// What is deliberately NOT here is the attach-and-fall-back dance. The two
// pages want different things from it — one has a badge, an MJPEG fallback and
// a transport toggle to keep in step, the other has a bare video element — and
// a shared version would be an abstraction over two callers with one of them
// bent to fit. The dance is a dozen lines; the rules below are not.
window.MajesticTransport = (function () {
	// What the person chose. Permanent until they choose again.
	const PICK_KEY = 'mj-transport-pick';
	// What a failure decided for them, and when. Expires, because the reasons
	// expire: a camera switched to H.265, a stream that stalled, a network
	// having a bad afternoon.
	const AUTO_KEY = 'mj-transport-auto';
	// The single key an earlier release used for both. It cannot tell a choice
	// from a fallback — both wrote 'mse' — so it is read once and thrown away.
	const OLD_KEY = 'mj-transport';

	// Long enough not to re-annoy someone whose camera genuinely cannot serve
	// their browser, short enough that fixing the camera shows up the same day.
	const AUTO_FOR_MS = 6 * 60 * 60 * 1000;

	function read(k) {
		try { return localStorage.getItem(k); } catch (e) { return null; }
	}
	function write(k, v) {
		try {
			if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
		} catch (e) {}
	}

	// 'webrtc' under the old key was unambiguous — only the toggle ever wrote
	// it — so it survives as a choice. 'mse' was not, so it becomes a demotion:
	// nothing changes for that browser today, and in six hours it tries WebRTC
	// again rather than never.
	function migrate() {
		const old = read(OLD_KEY);
		if (old === null) return;
		write(OLD_KEY, null);
		if (read(PICK_KEY) !== null || read(AUTO_KEY) !== null) return;
		if (old === 'webrtc') write(PICK_KEY, 'webrtc');
		else if (old === 'mse') write(AUTO_KEY, String(Date.now()));
	}

	// A demotion that has not expired. The window is bounded at both ends: a
	// timestamp in the future is not a very fresh demotion, it is a clock that
	// moved or a value this code did not write, and honouring it would suppress
	// WebRTC for far longer than the six hours advertised.
	function demoted() {
		const raw = read(AUTO_KEY);
		const at = /^\d+$/.test(raw || '') ? parseInt(raw, 10) : 0;
		const age = Date.now() - at;
		if (!at || age < 0 || age > AUTO_FOR_MS) {
			if (raw !== null) write(AUTO_KEY, null);
			return false;
		}
		return true;
	}

	function available() {
		return !!(window.MajesticWebRTC && window.MajesticWebRTC.available);
	}

	// 'webrtc' unless something says otherwise. WebRTC is sub-second where MSE
	// is about a second behind, carries audio, and lets the camera match the
	// encoder to the link; MSE is what serves the browsers and cameras where
	// negotiation cannot be made to work.
	function preferred() {
		if (!available()) return 'mse';
		migrate();
		const chosen = read(PICK_KEY);
		if (chosen === 'webrtc') return 'webrtc';
		if (chosen === 'mse') return 'mse';
		return demoted() ? 'mse' : 'webrtc';
	}

	// The person picked a transport: that outranks anything a failure decided.
	function choose(kind) {
		write(PICK_KEY, kind === 'webrtc' ? 'webrtc' : 'mse');
		write(AUTO_KEY, null);
		write(OLD_KEY, null);
	}

	// A failure picked one. Recorded apart from a choice and with an expiry, and
	// never against an explicit choice of WebRTC — someone who ticked the box
	// gets it back on the next load rather than being quietly overruled.
	//
	// Not for a camera that is merely full: it will not be full for long, and
	// remembering that would park a browser on the slower transport because
	// somebody else happened to be watching.
	function demote() {
		if (read(PICK_KEY) === 'webrtc') return;
		write(AUTO_KEY, String(Date.now()));
	}

	// The implementation behind a name, for a caller doing its own attaching.
	function impl(kind) {
		return kind === 'webrtc' ? window.MajesticWebRTC : window.MajesticVideo;
	}

	// What the camera falls back to when webrtc.iceServers is unset, and every
	// spelling of "I really do want none". More than one because YAML 1.1
	// decides what these words mean before majestic sees them: `iceServers: off`
	// reaches the config as the string "false", and so do `no` and `false`.
	const STUN_DEFAULT = 'stun:stun.cloudflare.com:3478';
	const OFF_WORDS = ['none', 'off', 'no', 'false', 'disabled'];

	// The camera's webrtc.* settings as an RTCPeerConnection iceServers list.
	//
	// Both pages need it and neither can do without it: with an empty list the
	// browser gathers host candidates only, and Chromium anonymises those to
	// <uuid>.local, which the camera cannot resolve. On a LAN it still works —
	// the browser's own checks teach the camera its address peer-reflexively —
	// but off one, neither end ever learns a routable address for the other and
	// the session dies having negotiated perfectly.
	//
	// This mirrors majestic_stun_ice_js() in include/majestic/stun_default.h,
	// which built the same list for the debug page this replaced. Keep the two
	// in step: same default, same off-words, same rule about relays.
	function iceServers(configured, user, cred) {
		configured = (configured === null || configured === undefined ||
			configured === '') ? STUN_DEFAULT : String(configured);
		if (OFF_WORDS.indexOf(configured.toLowerCase()) >= 0) return [];
		const haveCreds = !!(user && cred);
		const out = [];
		configured.split(/[\s,]+/).forEach(function (url) {
			if (!url) return;
			const isTurn = /^turns?:/i.test(url);
			// A relay entry missing either credential makes RTCPeerConnection
			// throw InvalidAccessError — before the page opens its signalling
			// socket, so the camera sees no attempt at all and the failure
			// reads as "signalling never happened". Drop that entry and keep
			// the rest: it costs the relay and nothing else.
			if (isTurn && !haveCreds) return;
			out.push(isTurn
				? { urls: url, username: String(user), credential: String(cred) }
				: { urls: url });
		});
		return out;
	}

	return {
		available: available,
		preferred: preferred,
		choose: choose,
		demote: demote,
		impl: impl,
		iceServers: iceServers,
	};
})();
