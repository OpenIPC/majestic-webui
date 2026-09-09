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
// What is deliberately NOT here is what a page DOES about an outcome: what to
// put on the badge, what a failure means for its controls, what to show when
// the chain runs out. The two pages want different things there — one has a
// badge, an MJPEG fallback and a transport toggle to keep in step, the other
// an alert sentence — and those stay per page.
//
// The line between the three shared modules is worth stating: preview-swap.js
// is a state machine with invariants that are not obvious, preview-chain.js is
// the walk down the chain (what to try next, and the software rung's retry
// ladder), and this is the set of rules the walk asks — which transport to
// prefer, what to remember, whether a failure is worth the next rung.
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
		if (read(PICK_KEY) !== null || read(AUTO_KEY) !== null) {
			write(OLD_KEY, null);
			return;
		}
		// Same order as migrateStream(), for the same reason: the replacement
		// has to be readable before the original is thrown away.
		let carried = true;
		if (old === 'webrtc') {
			write(PICK_KEY, 'webrtc');
			carried = read(PICK_KEY) === 'webrtc';
		} else if (old === 'mse') {
			const at = String(Date.now());
			write(AUTO_KEY, at);
			carried = read(AUTO_KEY) === at;
		}
		if (carried) write(OLD_KEY, null);
	}

	// A timestamp under `key` that is younger than `forMs`. The window is
	// bounded at both ends: a timestamp in the future is not a very fresh
	// one, it is a clock that moved or a value this code did not write, and
	// honouring it would suppress whatever it guards for far longer than
	// advertised. Anything outside the window is cleared on the way out.
	// The transport's own demotion is one such key; the data-channel feed
	// keeps another (preview-datachannel.js), with the same rule.
	function expiring(key, forMs) {
		const raw = read(key);
		const at = /^\d+$/.test(raw || '') ? parseInt(raw, 10) : 0;
		const age = Date.now() - at;
		if (!at || age < 0 || age > forMs) {
			if (raw !== null) write(key, null);
			return false;
		}
		return true;
	}
	// Stamp `key` now, for expiring() to find.
	function remember(key) {
		write(key, String(Date.now()));
	}

	// A demotion that has not expired.
	function demoted() {
		return expiring(AUTO_KEY, AUTO_FOR_MS);
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
	// MSE stays the else-branch, because it is the floor: `preferred()` and
	// `choose()` only ever name a transport, and the software rung is not one —
	// it is reached by the chain, never remembered, never picked. So a caller
	// asking for 'wasm' has decided already, and an unknown string still lands
	// on the player that plays anything the browser can decode.
	// Whether a WebRTC session's ENDING is worth remembering as a demotion.
	// 'fallback' is the camera or this browser saying it cannot serve WebRTC at
	// all — a durable fact that still expires, since demote() timestamps it —
	// while 'busy' says only that the camera is full right now, which it will
	// not be for long and so is never remembered. One rule, asked wherever a
	// WebRTC session ends: a dropped trial (a page's onFailed) and a live player
	// giving up mid-session (its onLive), on both the Live page and the settings
	// preview, so the two cannot drift (#402). It takes the machine STATE, not
	// the reason detail — the detail is a human string ('RTCPeerConnection
	// failed', 'the camera refused the offer'), the state is 'fallback'/'busy'.
	function durable(state) {
		return state === 'fallback';
	}

	// Whether the software-decode rung is worth trying for a given failure.
	// Here rather than in the walk (preview-chain.js) because it is a RULE,
	// which is what this module is for: the walk asks whether the attempt is
	// worth a network round trip, and this is the answer.
	//
	// `detail` is the player's reason code. Only a codec the browser refused,
	// and only one this decoder speaks: an unreachable camera is not a decoding
	// problem, and an H.264 High 10 refusal reports the same code, where
	// launching an H.265 decoder would be a slower way to fail.
	function softwareRungFor(detail) {
		const bits = String(detail || '').split(' ');
		const w = window.MajesticWasm;
		return bits[0] === 'undecodable' &&
			!!(w && w.available && w.handles && w.handles(bits[1]));
	}

	// A softer test than the one above, for when MSE never got far enough to
	// return a codec verdict. `undecodable` carries the codec the browser
	// refused; `unreachable` and `mse-error` do not — the socket could not be
	// held open to read the init (six reconnects, a flaky or high-latency link)
	// or the MediaSource refused a mime it had claimed. Neither means "this
	// browser cannot decode"; both would otherwise fall straight to MJPEG. So
	// fall back to what the CONFIG says the channel is encoded as: if the
	// software decoder handles that codec, its worker holds its own /ws/video
	// socket with its own reconnect and is worth a try — it may survive where
	// the MSE player's ladder gave up (measured: a Raspberry Pi over a remote
	// link, majestic #288). It cannot loop, because the software rung's own
	// failure reports kind `wasm`, which the walk does not route here.
	function softwareRungForCodec(detail, codec) {
		const bits = String(detail || '').split(' ');
		const w = window.MajesticWasm;
		return (bits[0] === 'unreachable' || bits[0] === 'mse-error') &&
			!!(w && w.available && w.handles && w.handles(codec));
	}

	// Whether the MJPEG rung is worth trying for what is on screen.
	//
	// Two quite different reasons to reach it, and the gate is the same one:
	// the camera has an MJPEG stream for this source. Either the ladder above
	// gave up — nothing here can decode what this source encodes — or the
	// source has never had anything else, which is the usual state of a USB
	// webcam. `stream` is the entry from /api/v1/sources; a caller with no
	// answer yet passes nothing and gets false, because offering a picture the
	// camera may not serve is worse than offering none.
	//
	// It lives beside softwareRungFor() for the reason that one does: it is a
	// rule, and the Live page's floor (its fallThrough) is what asks it — the
	// settings preview has no MJPEG rung, which is why the shared walk in
	// preview-chain.js stops above this and leaves the floor to each page.
	function multipartRungFor(stream) {
		const s = window.MajesticSources;
		return !!(stream && s && s.family(stream) === 'multipart' &&
			window.MajesticMultipart && window.MajesticMultipart.available);
	}

	function impl(kind) {
		return kind === 'webrtc' ? window.MajesticWebRTC
			: kind === 'wasm' ? window.MajesticWasm
			: kind === 'multipart' ? window.MajesticMultipart
			: window.MajesticVideo;
	}

	// Which encoder channel the person last picked, or null if they never have.
	//
	// The default is the substream, which is right for the common case — the
	// main channel carries the recording, the substream exists to be watched
	// over whatever link is available. It is wrong for at least two:
	//
	//   - videoN.crop is per channel, so someone who has cropped video0 and
	//     wants to see the result of that cropping needs the main stream
	//     specifically. A substream preview shows a different picture, not a
	//     smaller one.
	//   - a substream sized well away from what the preview box wants, when
	//     the main stream happens to be closer.
	//
	// Neither is a reason to change the default, and both are a reason to
	// remember the answer: without this, anyone those cases apply to re-picks
	// Main on every page load, for ever. Remembered per browser rather than on
	// the camera because it is a viewing preference, like the transport beside
	// it — the same camera watched from a phone and a desk may want different
	// answers, and neither should overwrite the other.
	// Per page, not one answer for both. The two are looked at for different
	// reasons — Preview to watch, Live adjustments to judge an ISP knob while
	// dragging it — and someone can reasonably want Main on one and Sub on the
	// other. `where` is the page asking: 'preview' or 'live'.
	const STREAM_KEY = 'mj-preview-stream';

	function streamKey(where) {
		return STREAM_KEY + ':' + (where || 'preview');
	}

	// The unsuffixed key a previous release wrote, when one answer served both
	// pages. Both inherit it, because that is what the person was actually
	// looking at; from then on they diverge as each is chosen. Read once and
	// thrown away, like the transport migration above.
	//
	// Dropping it instead would silently return anyone who had chosen Main to
	// the substream default — and the reason to choose Main is that the
	// substream shows the wrong picture, so the setting would be lost by
	// exactly the people who needed it.
	// New keys first, old key last, and only once the new ones read back.
	// write() swallows storage failures by design — a private window must not
	// break the page — so "it did not throw" is no evidence the value landed.
	// Deleting first and then failing to write would lose the choice for good.
	function migrateStream() {
		const old = read(STREAM_KEY);
		if (old === null) return;
		if (old !== '0' && old !== '1') {
			write(STREAM_KEY, null);
			return;
		}
		let carried = true;
		['preview', 'live'].forEach(function (w) {
			if (read(streamKey(w)) !== null) return;
			write(streamKey(w), old);
			if (read(streamKey(w)) !== old) carried = false;
		});
		if (carried) write(STREAM_KEY, null);
	}

	// 0, 1, 'auto', or null for "never chosen". 'auto' is a choice like the
	// other two rather than a mode on top of them: it says which stream to
	// watch, it is just answered per resize instead of once.
	function chosenStream(where) {
		migrateStream();
		const v = read(streamKey(where));
		return v === '0' ? 0 : v === '1' ? 1 : v === 'auto' ? 'auto' : null;
	}

	function chooseStream(where, n) {
		write(streamKey(where),
			n === 'auto' ? 'auto' : (n | 0) === 1 ? '1' : '0');
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
	// The camera applies the same rules to the same setting on its own side,
	// and used to build this very list for the debug page this replaced. Keep
	// the two in step: same default, same off-words, same rule about relays.
	function iceServers(configured, user, cred) {
		// A harness's override, the way MJ_FEED pins the feed: a list to use
		// instead of the camera's, for measuring a path the camera's own
		// configuration would not choose (a relay on the tester's side).
		if (Array.isArray(window.MJ_ICE)) return window.MJ_ICE;
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
		expiring: expiring,
		remember: remember,
		impl: impl,
		durable: durable,
		softwareRungFor: softwareRungFor,
		softwareRungForCodec: softwareRungForCodec,
		multipartRungFor: multipartRungFor,
		iceServers: iceServers,
		chosenStream: chosenStream,
		chooseStream: chooseStream,
	};
})();
