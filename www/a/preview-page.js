// Camera Preview page glue: night/IRcut/light toggles (via the /night and
// /metrics/night APIs) and the live player attach, with an MJPEG/no-signal
// fallback. `$`, mjConfig and mjGet are globals from main.js; this file loads
// after preview.js and preview-webrtc.js.
//
// TWO TRANSPORTS, ONE FAÇADE. MajesticVideo (MSE) and MajesticWebRTC return
// the same object, so everything below is written once and the choice is made
// in attachPlayer(). WebRTC is the default now: sub-second where MSE is about
// a second behind, audio in both directions, and a receiver whose reports let
// the camera match the encoder to the link. MSE is a tick away for the
// browsers and cameras where negotiation cannot be made to work.
//
// The chain is WebRTC -> MSE -> MJPEG -> note, and the middle step is
// load-bearing rather than tidy. WebRTC negotiates and can therefore fail
// where MSE cannot: Firefox's WebRTC stack offers only H.264 Baseline whatever
// its decoder can do, so a camera on `profile: main` has nothing to give it —
// the same browser plays that stream over MSE without complaint. A player
// reporting 'fallback' is asking for the other transport, not for MJPEG.
//
// Now that the chain runs by default rather than on request, what it remembers
// matters more than it did. A refusal is recorded with a timestamp and expires;
// a camera that is merely full ('busy') is not recorded at all; and an explicit
// choice beats both. Otherwise the first bad afternoon would quietly park a
// browser on the slower transport for good.
(function () {
	// --- Night / IRcut / Light toggles ---
	mjConfig().then(cfg => {
		const active = v => v !== false && v != null;
		const lm = active(mjGet(cfg, 'nightMode.lightMonitor'));
		$('#toggle-night').disabled = lm;
		$('#toggle-ircut').disabled = lm || !active(mjGet(cfg, 'nightMode.irCutPin1'));
		$('#toggle-light').disabled = lm || !active(mjGet(cfg, 'nightMode.backlightPin'));
		if (lm) $('#mj-lightmon').hidden = false;
	});

	['night', 'ircut', 'light'].forEach(n =>
		apiFetch('/metrics/night?value=' + n + '_enabled', { credentials: 'same-origin' })
			.then(r => r.text()).then(v => { $('#toggle-' + n).checked = +v > 0; })
			.catch(() => {}));

	$('#toggle-night').addEventListener('click', () => {
		apiFetch('/night/toggle', { credentials: 'same-origin' }).then(api => api.json()).then(data => {
			$('#toggle-night').checked = data;
			if (!$('#toggle-ircut').disabled) $('#toggle-ircut').checked = data;
			if (!$('#toggle-light').disabled) $('#toggle-light').checked = data;
		});
	});
	$('#toggle-ircut').addEventListener('click', () => {
		apiFetch('/night/ircut', { credentials: 'same-origin' }).then(api => api.json()).then(data => { $('#toggle-ircut').checked = data; });
	});
	$('#toggle-light').addEventListener('click', () => {
		apiFetch('/night/light', { credentials: 'same-origin' }).then(api => api.json()).then(data => { $('#toggle-light').checked = data; });
	});

	// --- Live player (WebRTC or MSE, with MJPEG / no-signal fallback) ---
	const initial = $('#live-video');
	if (!initial || !window.MajesticVideo) return;
	const badge = $('#mj-badge'), img = $('#live-mjpeg'), note = $('#mj-note');
	let jpegOn = false;
	mjConfig().then(cfg => {
		jpegOn = mjGet(cfg, 'jpeg.enabled') === true;
		if (mjGet(cfg, 'video1.enabled') === true) $('#mj-sub').hidden = false;
	});
	const cur = () => $('#live-video');

	const BARS = '#000 url(/a/preview.svg)';
	function showVideo() {
		const v = cur();
		if (v) { v.style.display = ''; v.style.background = '#000'; }
		if (img) { img.style.display = 'none'; img.src = ''; }
		if (note) note.style.display = 'none';
	}
	function showNoSignal() {
		const v = cur();
		if (v) { v.style.display = ''; v.style.background = BARS; }
		if (img) { img.style.display = 'none'; img.src = ''; }
		if (note) note.style.display = 'none';
		if (badge) badge.textContent = 'no signal';
	}
	function showFallback() {
		const v = cur();
		if (v) v.style.display = 'none';
		if (jpegOn && img) { img.src = '/mjpeg'; img.style.display = ''; if (note) note.style.display = 'none'; }
		else if (note) note.style.display = '';
		if (badge) badge.textContent = 'MJPEG';
	}

	const mute = $('#mj-mute'), muteLbl = $('#mj-mute-lbl'), volCtl = $('#mj-vol');
	const audioCtl = $('#mj-audio-ctl');
	const transportCtl = $('#mj-transport'), transportGrp = $('#mj-transport-ctl');
	const s0 = $('#mj-stream-0'), s1 = $('#mj-stream-1');

	// Which transport to try. WebRTC unless something says otherwise: it is
	// sub-second where MSE is about a second behind, it carries audio, and its
	// receiver reports let the camera match the encoder to the link. MSE stays
	// one tick away for the browsers and cameras where negotiation cannot be
	// made to work.
	//
	// Remembered per browser rather than per camera, because what decides it is
	// what this browser can negotiate, and that travels with the browser.
	//
	// Two kinds of "not WebRTC", kept apart on purpose:
	//
	//   mj-transport      — what the person chose. Permanent until they choose
	//                       again, in either direction.
	//   mj-transport-auto — what a failure decided for them, with the time it
	//                       was decided. Expires, because the reasons expire:
	//                       a camera switched to H.265, a stream that stalled,
	//                       a network that was having a bad afternoon. Without
	//                       the expiry, one bad session would demote a browser
	//                       for good and nobody would ever know why their
	//                       preview was a second behind.
	const PREF_KEY = 'mj-transport';
	const AUTO_KEY = 'mj-transport-auto';
	// Long enough not to re-annoy someone whose camera genuinely cannot serve
	// their browser, short enough that fixing the camera shows up the same day.
	const AUTO_FOR_MS = 6 * 60 * 60 * 1000;

	const webrtcAvailable = !!(window.MajesticWebRTC && MajesticWebRTC.available);

	function readPref(k) {
		try { return localStorage.getItem(k); } catch (e) { return null; }
	}
	function writePref(k, v) {
		try {
			if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
		} catch (e) {}
	}

	// A demotion that has not expired. Anything unparseable counts as expired,
	// so a stored value from another version cannot pin the transport for ever.
	function autoDemoted() {
		const at = parseInt(readPref(AUTO_KEY), 10);
		if (!at || Date.now() - at > AUTO_FOR_MS) {
			if (readPref(AUTO_KEY) !== null) writePref(AUTO_KEY, null);
			return false;
		}
		return true;
	}

	function wantWebRTC() {
		if (!webrtcAvailable) return false;
		const chosen = readPref(PREF_KEY);
		if (chosen === 'webrtc') return true;
		if (chosen === 'mse') return false;
		return !autoDemoted();
	}

	// The person picked a transport: that outranks anything a failure decided.
	function rememberTransport(t) {
		writePref(PREF_KEY, t);
		writePref(AUTO_KEY, null);
	}

	// A failure picked one. Recorded separately and with an expiry, and never
	// against an explicit choice to use WebRTC — someone who ticked the box
	// gets it back on the next load rather than being quietly overruled.
	function rememberDemotion() {
		if (readPref(PREF_KEY) === 'webrtc') return;
		writePref(AUTO_KEY, String(Date.now()));
	}

	let player = null, usingWebRTC = false;
	// Carried across a transport switch, because a new player starts from its
	// defaults and the user's choices should outlive the machinery.
	let stream = 0, audioOn = false, vol = 1;
	let audioConfigured = false;

	// Which attachment is the live one. Two things need it, and neither is
	// hypothetical:
	//
	// A player can report 'fallback' from inside attach() — MajesticWebRTC does
	// exactly that when RTCPeerConnection or addTransceiver throws — so the
	// handler runs, attaches MSE, and then the outer `player = impl.attach(…)`
	// assignment completes and overwrites the working MSE player with the dead
	// WebRTC façade nobody can now destroy.
	//
	// And a destroyed player is not a silent one. WebRTC's createOffer and
	// getStats continuations settle after close, so a transport switched away
	// from can still call onState and, seeing a `usingWebRTC` that has since
	// flipped, hide a video that is playing perfectly well.
	//
	// So the generation is stamped at attach and captured by that attachment's
	// handlers: a callback from a superseded player is dropped rather than
	// interpreted as if the current one had sent it.
	let attachSeq = 0;

	// Whether to offer the audio control at all: the camera has to have audio
	// configured and this transport has to be able to carry it. MSE can only
	// when the browser decodes a codec majestic can produce, so the answer
	// changes with the transport and is asked again on every attach.
	function syncAudioCtl() {
		if (!audioCtl) return;
		audioCtl.hidden = !(audioConfigured && player && player.audioSupported());
	}

	// Rebuilt rather than mutated when the transport changes: the two players
	// own different machinery, and the state worth carrying over is three
	// values.
	function attachPlayer(webrtc) {
		const gen = ++attachSeq;
		if (player) { try { player.destroy(); } catch (e) {} player = null; }
		usingWebRTC = !!webrtc;
		// MSE leaves a MediaSource object URL on the element; WebRTC's
		// srcObject would win anyway, but an element carrying both is a
		// confusing thing to debug.
		const v = cur();
		try { v.removeAttribute('src'); v.srcObject = null; } catch (e) {}
		const impl = usingWebRTC ? MajesticWebRTC : MajesticVideo;
		const p = impl.attach(v, Object.assign({ stream: stream }, handlersFor(gen)));
		// attach() reported 'fallback' before returning and something else is
		// now playing. Drop what we just built rather than letting this
		// assignment bury it.
		if (gen !== attachSeq) {
			try { p.destroy(); } catch (e) {}
			return;
		}
		player = p;
		if (audioOn && player.audioSupported()) player.setAudio(true);
		player.setVolume(vol);
		syncAudioCtl();
	}

	function handlersFor(gen) {
		const live = () => gen === attachSeq;
		return {
			onState: (s, d) => {
				if (!live()) return;
				if (s === 'playing') showVideo();
				else if (s === 'nosignal') showNoSignal();
				else if (s === 'mjpeg') showFallback();
				else if (s === 'fallback' || s === 'busy') {
					// WebRTC gave up. Drop to MSE rather than to MJPEG: MSE
					// plays what this browser's decoder takes rather than what
					// its WebRTC stack will negotiate, which is a strictly
					// larger set.
					if (usingWebRTC) {
						const why = d || 'unavailable';
						if (transportCtl) {
							transportCtl.checked = false;
							const lbl = transportCtl.nextElementSibling;
							if (lbl) lbl.title = 'WebRTC: ' + why;
						}
						// 'busy' says the camera is full, which will not be
						// true for long — take MSE now and try WebRTC again on
						// the next load. Only a real refusal is worth
						// remembering, and even that one expires.
						if (s === 'fallback') rememberDemotion();
						attachPlayer(false);
					} else {
						showFallback();
					}
				}
				else if (badge) badge.textContent = (s === 'error') ? 'reconnecting…' : s + '…';
			},
			onCodec: (codec, cs, w, h) => {
				if (!live()) return;
				if (badge) {
					badge.textContent = codec.toUpperCase() + ' ' + w + '×' + h +
						(usingWebRTC ? ' · WebRTC' : '');
				}
			},
			// null means we asked for audio and the camera had none to give (mic
			// off or not producing). Reflect that on the control rather than
			// leaving the user staring at an unmute button that does nothing.
			onAudio: (codec) => {
				if (!live() || !mute) return;
				if (mute.checked && !codec) {
					muteLbl.textContent = '🔇 No audio';
					mute.checked = false;
					audioOn = false;
					if (volCtl) volCtl.disabled = true;
				}
			},
		};
	}

	attachPlayer(wantWebRTC());

	if (transportCtl && transportGrp && webrtcAvailable) {
		transportGrp.hidden = false;
		transportCtl.checked = usingWebRTC;
		transportCtl.addEventListener('change', () => {
			rememberTransport(transportCtl.checked ? 'webrtc' : 'mse');
			attachPlayer(transportCtl.checked);
		});
	}

	if (s0) s0.addEventListener('change', () => { stream = 0; player.setStream(0); });
	if (s1) s1.addEventListener('change', () => { stream = 1; player.setStream(1); });

	// Audio: revealed only when the camera has it configured and the transport
	// in use can carry it — otherwise the button is a dead end.
	if (audioCtl && mute) {
		mjConfig().then(cfg => {
			audioConfigured = mjGet(cfg, 'audio.enabled') === true;
			syncAudioCtl();
		});
		mute.addEventListener('change', () => {
			const on = mute.checked;
			audioOn = on;
			player.setAudio(on);
			muteLbl.textContent = on ? '🔊 Listening' : '🔇 Muted';
			if (volCtl) volCtl.disabled = !on;
		});
		if (volCtl) volCtl.addEventListener('input', () => {
			vol = volCtl.value / 100;
			player.setVolume(vol);
		});
	}
})();
