#!/usr/bin/haserl
<%in p/common.cgi %>
<% page_title="Majestic Endpoints"

# Ask the live config rather than majestic.yaml, which omits keys left at their
# default.
mj_config=$(wget -q -T1 -O - localhost/api/v1/config.json 2>/dev/null)

# system.unsafe switches authentication off for every HTTP and RTSP endpoint, so
# the credentials note below would be wrong.
mj_unsafe=$(echo "$mj_config" | jsonfilter -e '@.system.unsafe' 2>/dev/null)

# Hosts below are placeholders: every HTTP and WebSocket endpoint here is served
# on the WebUI's own origin, so main.js overwrites the .ep-* spans with the
# address the browser actually used. RTSP is the exception — its port is its
# own, and only the default 554 may be left out of the URL.
#
# Majestic only range-checks rtsp.port on the write path, so a hand-edited
# majestic.yaml can leave a port no URL can use. Anything outside 1-65535 falls
# back to the default a bare rtsp:// implies. The ?????? arm drops 6-digit and
# longer values before the numeric test, which has no defined behaviour once
# the operand no longer fits a long.
rtsp_port=$(echo "$mj_config" | jsonfilter -e '@.rtsp.port' 2>/dev/null)
case "$rtsp_port" in
	''|*[!0-9]*|??????*) rtsp_port=554 ;;
esac
[ "$rtsp_port" -ge 1 ] && [ "$rtsp_port" -le 65535 ] || rtsp_port=554
[ "$rtsp_port" = "554" ] && rtsp_suffix= || rtsp_suffix=":$rtsp_port"
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
			<dt class="cp2cb">rtsp://<span class="ep-addr"><%= $network_address %></span><%= $rtsp_suffix %>/stream=0</dt>
			<dd>RTSP main stream.</dd>
			<dt class="cp2cb">rtsp://<span class="ep-addr"><%= $network_address %></span><%= $rtsp_suffix %>/stream=1</dt>
			<dd>RTSP sub stream.</dd>
			<dt class="cp2cb">rtsp://<span class="ep-addr"><%= $network_address %></span><%= $rtsp_suffix %>/stream=2</dt>
			<dd>RTSP JPEG stream.</dd>
			<dt class="cp2cb"><span class="ep-ws">ws</span>://<span class="ep-host"><%= $network_address %></span>/ws/video?stream=0</dt>
			<dd>Low-latency H.264/H.265 main stream (fMP4/MSE, used by Preview). Append <code>&amp;audio=opus,mp4a.40.2</code> to mux in an audio track for the codecs your player accepts.</dd>
			<dt class="cp2cb"><span class="ep-ws">ws</span>://<span class="ep-host"><%= $network_address %></span>/ws/video?stream=1</dt>
			<dd>Low-latency H.264/H.265 sub stream (fMP4/MSE).</dd>
			<dt class="cp2cb"><span class="ep-http">http</span>://<span class="ep-host"><%= $network_address %></span>/mjpeg</dt>
			<dd>MJPEG video stream.</dd>
			<dt class="cp2cb"><span class="ep-http">http</span>://<span class="ep-host"><%= $network_address %></span>/video.mp4</dt>
			<dd>MP4 video stream.</dd>
			<dt class="cp2cb"><span class="ep-http">http</span>://<span class="ep-host"><%= $network_address %></span>/hls</dt>
			<dd>HLS live-streaming in web browser.</dd>
			<dt class="cp2cb"><span class="ep-http">http</span>://<span class="ep-host"><%= $network_address %></span>/mjpeg.html</dt>
			<dd>MJPEG live-streaming in web browser.</dd>
		</dl>
	</div>

	<div class="col">
		<h3>Audio</h3>
		<dl>
			<dt class="cp2cb"><span class="ep-http">http</span>://<span class="ep-host"><%= $network_address %></span>/audio.opus</dt>
			<dd>Opus audio stream.</dd>
			<dt class="cp2cb"><span class="ep-http">http</span>://<span class="ep-host"><%= $network_address %></span>/audio.m4a</dt>
			<dd>AAC audio stream.</dd>
			<dt class="cp2cb"><span class="ep-http">http</span>://<span class="ep-host"><%= $network_address %></span>/audio.pcm</dt>
			<dd>Raw PCM audio stream.</dd>
			<dt class="cp2cb"><span class="ep-http">http</span>://<span class="ep-host"><%= $network_address %></span>/audio.alaw</dt>
			<dd>A-law compressed audio stream.</dd>
			<dt class="cp2cb"><span class="ep-http">http</span>://<span class="ep-host"><%= $network_address %></span>/audio.ulaw</dt>
			<dd>μ-law compressed audio stream.</dd>
			<dt class="cp2cb"><span class="ep-http">http</span>://<span class="ep-host"><%= $network_address %></span>/audio.g711a</dt>
			<dd>G.711 A-law audio stream.</dd>
			<dt class="cp2cb"><span class="ep-http">http</span>://<span class="ep-host"><%= $network_address %></span>/play_audio</dt>
			<dd>Play audio file on camera speaker.</dd>
		</dl>
	</div>

	<div class="col">
		<h3>Images</h3>
		<dl>
			<dt class="cp2cb"><span class="ep-http">http</span>://<span class="ep-host"><%= $network_address %></span>/image.jpg</dt>
			<dd>Snapshot in JPEG format.</dd>
			<dt class="cp2cb"><span class="ep-http">http</span>://<span class="ep-host"><%= $network_address %></span>/image.heif</dt>
			<dd>Snapshot in HEIF format.</dd>
			<dt class="cp2cb"><span class="ep-http">http</span>://<span class="ep-host"><%= $network_address %></span>/image.yuv420</dt>
			<dd>Snapshot in YUV420 format.</dd>
		</dl>
	</div>

	<div class="col">
		<h3>Night</h3>
		<dl>
			<dt class="cp2cb"><span class="ep-http">http</span>://<span class="ep-host"><%= $network_address %></span>/night/on</dt>
			<dd>Turn on night mode.</dd>
			<dt class="cp2cb"><span class="ep-http">http</span>://<span class="ep-host"><%= $network_address %></span>/night/off</dt>
			<dd>Turn off night mode.</dd>
			<dt class="cp2cb"><span class="ep-http">http</span>://<span class="ep-host"><%= $network_address %></span>/night/toggle</dt>
			<dd>Toggle night mode.</dd>
			<dt class="cp2cb"><span class="ep-http">http</span>://<span class="ep-host"><%= $network_address %></span>/night/ircut</dt>
			<dd>Toggle camera ircut.</dd>
			<dt class="cp2cb"><span class="ep-http">http</span>://<span class="ep-host"><%= $network_address %></span>/night/light</dt>
			<dd>Toggle camera light.</dd>
		</dl>
	</div>

	<div class="col">
		<h3>Monitoring</h3>
		<dl>
			<dt class="cp2cb"><span class="ep-http">http</span>://<span class="ep-host"><%= $network_address %></span>/api/v1/config.json</dt>
			<dd>Default Majestic config in JSON format.</dd>
			<dt class="cp2cb"><span class="ep-http">http</span>://<span class="ep-host"><%= $network_address %></span>/api/v1/config.schema.json</dt>
			<dd>Available Majestic settings in JSON format.</dd>
			<dt><a href="https://github.com/openipc/wiki/blob/master/en/majestic-config.md">https://github.com/openipc/wiki</a></dt>
			<dd>Available Majestic settings in YAML format.</dd>
			<dt class="cp2cb"><span class="ep-http">http</span>://<span class="ep-host"><%= $network_address %></span>/metrics</dt>
			<dd>Node exporter for <a href="https://prometheus.io">Prometheus</a>.</dd>
		</dl>
	</div>
</div>

<%in p/footer.cgi %>
