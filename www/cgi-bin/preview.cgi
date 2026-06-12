#!/usr/bin/haserl
<%in p/common.cgi %>

<% page_title="Camera Preview" %>
<%in p/header.cgi %>

<div class="row preview">
	<div class="col">
		<% preview %>
		<p class="small"><a href="mj-endpoints.cgi">Majestic Endpoints</a></p>
	</div>

	<div class="col-auto">
		<p class="small" id="mj-lightmon" hidden><a href="mj-settings.cgi?tab=nightMode">Light monitor active</a></p>

		<div class="d-grid gap-3">
			<input type="checkbox" class="btn-check" id="toggle-night">
			<label class="btn btn-outline-success" for="toggle-night">Night</label>

			<input type="checkbox" class="btn-check" id="toggle-ircut">
			<label class="btn btn-outline-success" for="toggle-ircut">IRcut</label>

			<input type="checkbox" class="btn-check" id="toggle-light">
			<label class="btn btn-outline-success" for="toggle-light">Light</label>

			<% if [ -n "$ptz_support" ]; then %>
				<%in p/motor.cgi %>
			<% fi %>
		</div>
	</div>
</div>

<script>
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

$("#toggle-night").addEventListener("click", () => {
	fetch('/night/toggle').then(api => api.json()).then(data => {
		$('#toggle-night').checked = data;
		if (!$('#toggle-ircut').disabled) {
			$('#toggle-ircut').checked = data;
		}
		if (!$('#toggle-light').disabled) {
			$('#toggle-light').checked = data;
		}
	});
});

$("#toggle-ircut").addEventListener("click", () => {
	fetch('/night/ircut').then(api => api.json()).then(data => {
		$('#toggle-ircut').checked = data;
	});
});

$("#toggle-light").addEventListener("click", () => {
	fetch('/night/light').then(api => api.json()).then(data => {
		$('#toggle-light').checked = data;
	});
});
</script>

<script src="/a/preview.js"></script>
<script>
(function () {
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

	const player = MajesticVideo.attach(initial, {
		stream: 0,
		onState: (s, d) => {
			if (s === 'playing') showVideo();
			else if (s === 'nosignal') showNoSignal();
			else if (s === 'mjpeg') showFallback();
			else if (badge) badge.textContent = (s === 'error') ? 'reconnecting…' : s + '…';
		},
		onCodec: (codec, cs, w, h) => { if (badge) badge.textContent = codec.toUpperCase() + ' ' + w + '×' + h; },
	});

	const s0 = $('#mj-stream-0'), s1 = $('#mj-stream-1');
	if (s0) s0.addEventListener('change', () => player.setStream(0));
	if (s1) s1.addEventListener('change', () => player.setStream(1));
})();
</script>

<%in p/footer.cgi %>
