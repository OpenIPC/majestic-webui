#!/usr/bin/haserl
<%in p/common.cgi %>

<%
# The editor IS this page. It mounts fixed over the viewport as soon as it
# arrives, so nothing here is a step on the way to it -- there is no capture
# card, no status list and no frame strip, because those verbs now live in the
# editor's own chrome where the frame they act on is.
#
# full_bleed for the same reason live.cgi asks for it: no container, no status
# strip, no footer. What remains under the editor is the navbar, and the
# editor's own Back button is what leaves.
hide_title=1; full_bleed=1
%>
<%in p/header.cgi %>

<!-- The editor mounts here and covers the viewport. -->
<div id="raw-editor-host"></div>

<!-- Shown from first paint, and covered by the editor the moment it arrives.
     The editor is fetched from a CDN, so on a camera with no route out this is
     what the page is for the few seconds before the attempt gives up; without
     it those seconds are a blank page and no word about why. -->
<div id="raw-loading" class="container py-4">
	<p class="text-secondary">
		<span class="spinner-border spinner-border-sm"></span>
		Loading the editor&hellip;
	</p>
	<span class="hint text-secondary">It is fetched from the internet the first time
		it is opened, and cached by your browser afterwards.</span>
</div>

<!-- The one thing that has to exist before the editor does, because it is what
     gets said when the editor never arrives. Raw frames come from the camera
     either way, so this offers the frame itself rather than an apology. -->
<div id="raw-fallback" class="container py-4" hidden>
	<div class="mj-notice mj-notice-warn">
		<div class="mj-notice-txt" id="raw-fallback-txt"></div>
		<!-- A link, not a click handler: reloading the page is the retry. It
		     starts a fresh loader with no memory of the attempt that failed,
		     which is exactly what someone who has just plugged in a cable is
		     asking for. -->
		<span class="mj-notice-acts">
			<a class="btn btn-sm btn-primary" href="raw.cgi">Try again</a>
		</span>
	</div>
	<p class="mt-3">
		<button type="button" class="btn btn-primary" id="raw-plain">Download a raw frame</button>
		<a class="btn btn-secondary" href="camera.cgi">Back to Camera</a>
	</p>
	<span class="hint text-secondary">A raw frame is several megabytes and is kept in
		this browser tab, never on the camera &mdash; its flash holds the firmware.</span>
</div>

<%
# Plate reading is opt-in, per camera, and off unless somebody turned it on.
#
# The models are fetched from a CDN under CC BY-NC 4.0 -- attribution, and
# non-commercial use only. majestic is a commercial product, so reaching for
# them on every camera would make that choice on behalf of everyone running
# one. The operator makes it instead, once, in the file that already carries
# this camera's own decisions and that survives `updatewebui`:
#
#   echo 'webui_lpr_base="https://cdn.jsdelivr.net/gh/OpenIPC/lpr-wasm@v0.1.0/dist/"' \
#       >> /etc/webui/webui.conf
#
# p/common.cgi sources that file on every request, so the value is simply here.
# Unset, no base reaches the page, lpr-loader.js reports no reader, raw.js
# passes no plate capability and the editor builds no Plates tab.
#
# A <meta>, not an inline script, and that is the whole point of the shape.
# attr_escape is an HTML-ATTRIBUTE escaper: it turns & into &amp; and knows
# nothing about JavaScript string literals. Dropped into `window.X = "..."` it
# would mangle a base carrying a query string and would not stop a newline from
# ending the statement -- so a perfectly reasonable mirror URL could break the
# page or, worse, quietly load from somewhere else. In an attribute it is
# correct by construction, and the DOM parser hands the value back exactly as
# it was written.
if [ -n "$webui_lpr_base" ]; then
%>
<meta name="mj-lpr-base" content="<% attr_escape "$webui_lpr_base" %>">
<% fi %>
<script src="/a/mj-plate-roi.js"></script>
<script src="/a/lpr-loader.js"></script>
<script src="/a/raw-loader.js"></script>
<%
# After the two loaders: it reads both at definition time, because whether a
# plate reader can be had at all is a question raw.js asks before it mounts,
# not one it discovers in a rejected promise.
%>
<script src="/a/raw-plates.js"></script>
<script src="/a/raw.js"></script>

<%in p/footer.cgi %>
