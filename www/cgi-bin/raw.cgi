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

<!-- The editor mounts here and covers the viewport. Empty until then: a
     placeholder would be a page in front of the page. -->
<div id="raw-editor-host"></div>

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

<script src="/a/raw-loader.js"></script>
<script src="/a/raw.js"></script>

<%in p/footer.cgi %>
