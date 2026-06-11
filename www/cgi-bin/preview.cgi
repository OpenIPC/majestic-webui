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
		<% if [ "$(get_night lightMonitor)" = "true" ]; then %>
			<p class="small"><a href="mj-settings.cgi?tab=nightMode">Light monitor active</a></p>
		<% fi %>

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
<% echo "\$('#toggle-night').checked = $(get_metrics night_enabled);" %>
<% echo "\$('#toggle-ircut').checked = $(get_metrics ircut_enabled);" %>
<% echo "\$('#toggle-light').checked = $(get_metrics light_enabled);" %>

<% echo "\$('#toggle-night').disabled = $(get_night lightMonitor);" %>
<% echo "\$('#toggle-ircut').disabled = $(get_night lightMonitor) || !$(get_night irCutPin1);" %>
<% echo "\$('#toggle-light').disabled = $(get_night lightMonitor) || !$(get_night backlightPin);" %>

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
	const jpegOn = initial.closest('.mj-player').dataset.jpeg === 'true';
	const cur = () => $('#live-video'); // preview.js swaps the element per connection

	const BARS = '#000 url(/a/preview.svg)';
	function showVideo() {
		const v = cur();
		if (v) { v.style.display = ''; v.style.background = '#000'; } // video paints over; no colorbars while live
		if (img) { img.style.display = 'none'; img.src = ''; }
		if (note) note.style.display = 'none';
	}
	function showNoSignal() {
		// genuine lack of signal from the camera: show the colorbars test pattern
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
