#!/usr/bin/haserl
<%in p/common.cgi %>
<% page_title="Majestic Endpoints"

# system.unsafe switches authentication off for every HTTP and RTSP endpoint, so
# the credentials note below would be wrong. Ask the live config rather than
# majestic.yaml, which omits keys left at their default.
mj_unsafe=$(wget -q -T1 -O - localhost/api/v1/config.json 2>/dev/null | jsonfilter -e '@.system.unsafe' 2>/dev/null)
%>

<%in p/header.cgi %>

<% if [ "$mj_unsafe" = "true" ]; then %>
<p class="small text-danger">Authentication is switched off for every endpoint (<code>system.unsafe</code>) — anyone who can reach the camera can open these URLs.</p>
<% else %>
<p class="small text-secondary">These endpoints authenticate as user <code>root</code> with the same password you use for this WebUI. Players such as VLC ask for it when you open a bare URL.</p>
<% fi %>

<div class="row row-cols-1 row-cols-md-2 row-cols-xl-3 g-4 mb-4">
	<div class="col">
		<h3>Video</h3>
		<dl>
			<dt class="cp2cb">rtsp://<%= $network_address %>/stream=0</dt>
			<dd>RTSP main stream.</dd>
			<dt class="cp2cb">rtsp://<%= $network_address %>/stream=1</dt>
			<dd>RTSP sub stream.</dd>
			<dt class="cp2cb">rtsp://<%= $network_address %>/stream=2</dt>
			<dd>RTSP JPEG stream.</dd>
			<dt class="cp2cb">ws://<%= $network_address %>/ws/video?stream=0</dt>
			<dd>Low-latency H.264/H.265 main stream (fMP4/MSE, used by Preview). Append <code>&amp;audio=opus,mp4a.40.2</code> to mux in an audio track for the codecs your player accepts.</dd>
			<dt class="cp2cb">ws://<%= $network_address %>/ws/video?stream=1</dt>
			<dd>Low-latency H.264/H.265 sub stream (fMP4/MSE).</dd>
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
			<dt><a href="https://github.com/openipc/wiki/blob/master/en/majestic-config.md">https://github.com/openipc/wiki</a></dt>
			<dd>Available Majestic settings in YAML format.</dd>
			<dt class="cp2cb">http://<%= $network_address %>/metrics</dt>
			<dd>Node exporter for <a href="https://prometheus.io">Prometheus</a>.</dd>
		</dl>
	</div>
</div>

<%in p/footer.cgi %>
