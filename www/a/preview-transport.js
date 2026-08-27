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

	return {
		available: available,
		preferred: preferred,
		choose: choose,
		demote: demote,
		impl: impl,
	};
})();
