// Camera Preview page glue: night/IRcut/light toggles (via the /night and
// /metrics/night APIs) and the low-latency MSE player attach (MajesticVideo
// from preview.js, with an MJPEG/no-signal fallback). `$`, mjConfig and mjGet
// are globals from main.js; this file loads after preview.js.
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
		fetch('/metrics/night?value=' + n + '_enabled', { credentials: 'same-origin' })
			.then(r => r.text()).then(v => { $('#toggle-' + n).checked = +v > 0; })
			.catch(() => {}));

	$('#toggle-night').addEventListener('click', () => {
		fetch('/night/toggle').then(api => api.json()).then(data => {
			$('#toggle-night').checked = data;
			if (!$('#toggle-ircut').disabled) $('#toggle-ircut').checked = data;
			if (!$('#toggle-light').disabled) $('#toggle-light').checked = data;
		});
	});
	$('#toggle-ircut').addEventListener('click', () => {
		fetch('/night/ircut').then(api => api.json()).then(data => { $('#toggle-ircut').checked = data; });
	});
	$('#toggle-light').addEventListener('click', () => {
		fetch('/night/light').then(api => api.json()).then(data => { $('#toggle-light').checked = data; });
	});

	// --- Live MSE player (with MJPEG / no-signal fallback) ---
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

	const mute = $('#mj-mute'), muteLbl = $('#mj-mute-lbl'), vol = $('#mj-vol');

	const player = MajesticVideo.attach(initial, {
		stream: 0,
		onState: (s, d) => {
			if (s === 'playing') showVideo();
			else if (s === 'nosignal') showNoSignal();
			else if (s === 'mjpeg') showFallback();
			else if (badge) badge.textContent = (s === 'error') ? 'reconnecting…' : s + '…';
		},
		onCodec: (codec, cs, w, h) => { if (badge) badge.textContent = codec.toUpperCase() + ' ' + w + '×' + h; },
		// null means we asked for audio and the camera had none to give (mic off
		// or not producing). Reflect that on the control rather than leaving the
		// user staring at an unmute button that does nothing.
		onAudio: (codec) => {
			if (!mute) return;
			if (mute.checked && !codec) {
				muteLbl.textContent = '🔇 No audio';
				mute.checked = false;
				if (vol) vol.disabled = true;
			}
		},
	});

	const s0 = $('#mj-stream-0'), s1 = $('#mj-stream-1');
	if (s0) s0.addEventListener('change', () => player.setStream(0));
	if (s1) s1.addEventListener('change', () => player.setStream(1));

	// Audio: reveal only when the camera has it configured and this browser can
	// play a codec the camera can produce — otherwise the button is a dead end.
	const audioCtl = $('#mj-audio-ctl');
	if (audioCtl && mute && player.audioSupported()) {
		mjConfig().then(cfg => {
			if (mjGet(cfg, 'audio.enabled') === true) audioCtl.hidden = false;
		});
		mute.addEventListener('change', () => {
			const on = mute.checked;
			player.setAudio(on);
			muteLbl.textContent = on ? '🔊 Listening' : '🔇 Muted';
			if (vol) vol.disabled = !on;
		});
		if (vol) vol.addEventListener('input', () => player.setVolume(vol.value / 100));
	}
})();
