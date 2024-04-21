#!/usr/bin/haserl
<%in p/common.cgi %>
<% page_title="Majestic Endpoints" %>

<%in p/header.cgi %>

<div class="row row-cols-1 row-cols-md-2 row-cols-xl-3 g-4 mb-4">
	<div class="col">
		<h3>Video</h3>
		<dl>
			<dt class="cp2cb">rtsp://root:12345@<%= $network_address %>/stream=0</dt>
			<dd>RTSP main stream.</dd>
			<dt class="cp2cb">rtsp://root:12345@<%= $network_address %>/stream=1</dt>
			<dd>RTSP sub stream.</dd>
			<dt class="cp2cb">http://<%= $network_address %>/mjpeg</dt>
			<dd>MJPEG video stream.</dd>
			<dt class="cp2cb">http://<%= $network_address %>/video.mp4</dt>
			<dd>MP4 video stream.</dd>		
			<dt class="cp2cb">http://<%= $network_address %>/hls</dt>
			<dd>HLS live-streaming in web browser.</dd>
			<dt class="cp2cb">http://<%= $network_address %>/mjpeg.html</dt>
			<dd>MJPEG live-streaming in web browser.</dd>
		</dl>
	</div>

	<div class="col">
		<h3>Audio</h3>
		<dl>
			<dt class="cp2cb">http://<%= $network_address %>/audio.opus</dt>
			<dd>Opus audio stream.</dd>
			<dt class="cp2cb">http://<%= $network_address %>/audio.m4a</dt>
			<dd>AAC audio stream.</dd>
			<dt class="cp2cb">http://<%= $network_address %>/audio.pcm</dt>
			<dd>Raw PCM audio stream.</dd>
			<dt class="cp2cb">http://<%= $network_address %>/audio.alaw</dt>
			<dd>A-law compressed audio stream.</dd>
			<dt class="cp2cb">http://<%= $network_address %>/audio.ulaw</dt>
			<dd>μ-law compressed audio stream.</dd>
			<dt class="cp2cb">http://<%= $network_address %>/audio.g711a</dt>
			<dd>G.711 A-law audio stream.</dd>
			<dt class="cp2cb">http://<%= $network_address %>/play_audio</dt>
			<dd>Play audio file on camera speaker.</dd>
		</dl>
	</div>

	<div class="col">
		<h3>Images</h3>
		<dl>
			<dt class="cp2cb">http://<%= $network_address %>/image.jpg</dt>
			<dd>Snapshot in JPEG format.</dd>
			<dt class="cp2cb">http://<%= $network_address %>/image.heif</dt>
			<dd>Snapshot in HEIF format.</dd>
			<dt class="cp2cb">http://<%= $network_address %>/image.yuv420</dt>
			<dd>Snapshot in YUV420 format.</dd>
		</dl>
	</div>

	<div class="col">
		<h3>Night</h3>
		<dl>
			<dt class="cp2cb">http://<%= $network_address %>/night/on</dt>
			<dd>Turn on night mode.</dd>
			<dt class="cp2cb">http://<%= $network_address %>/night/off</dt>
			<dd>Turn off night mode.</dd>
			<dt class="cp2cb">http://<%= $network_address %>/night/toggle</dt>
			<dd>Toggle night mode.</dd>
			<dt class="cp2cb">http://<%= $network_address %>/night/ircut</dt>
			<dd>Toggle camera ircut.</dd>
			<dt class="cp2cb">http://<%= $network_address %>/night/light</dt>
			<dd>Toggle camera light.</dd>
		</dl>
	</div>

	<div class="col">
		<h3>Monitoring</h3>
		<dl>
			<dt class="cp2cb">http://<%= $network_address %>/api/v1/config.json</dt>
			<dd>Default Majestic config in JSON format.</dd>
			<dt class="cp2cb">http://<%= $network_address %>/api/v1/config.schema.json</dt>
			<dd>Available Majestic settings in JSON format.</dd>
			<dt class="cp2cb">http://<%= $network_address %>/metrics</dt>
			<dd>Node exporter for <a href="https://prometheus.io">Prometheus</a>.</dd>
		</dl>
	</div>
</div>

<script>
	function initializeCopyToClipboard() {
		document.querySelectorAll(".cp2cb").forEach(function (element) {
			element.title = "Click to copy to clipboard";
			element.addEventListener("click", function (event) {
				event.target.preventDefault;
				event.target.animate({ color: 'red' }, 500);
				if (navigator.clipboard && window.isSecureContext) {
					navigator.clipboard.writeText(event.target.textContent).then(r => playChime(r));
				} else {
					let textArea = document.createElement("textarea");
					textArea.value = event.target.textContent;
					textArea.style.position = "fixed";
					textArea.style.left = "-999999px";
					textArea.style.top = "-999999px";
					document.body.appendChild(textArea);
					textArea.focus();
					textArea.select();
					return new Promise((res, rej) => {
						document.execCommand('copy') ? res() : rej();
						textArea.remove();
					});
				}
			})
		})
	}

	window.onload = function () {
		initializeCopyToClipboard();
	}
</script>
<%in p/footer.cgi %>
