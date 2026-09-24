#!/usr/bin/haserl
<%in p/common.cgi %>

<%
# Focusing a lens, which is the editor's Focus tab and nothing else.
#
# A page of its own rather than a corner of Raw, because the person doing this
# is not developing a frame -- they are up a ladder with a screwdriver, and
# "Raw" is not the word they would look under. Same mount, same editor, and the
# same reason live.cgi asks for full bleed: no container, no status strip, no
# footer under something that covers the viewport.
hide_title=1; full_bleed=1
%>
<%in p/header.cgi %>

<!-- The editor mounts here and covers the viewport. -->
<div id="focus-editor-host"></div>

<!-- Shown from first paint and covered the moment the editor arrives. It is
     fetched from a CDN, so on a camera with no route out this is what the page
     is for the few seconds before the attempt gives up. -->
<div id="focus-loading" class="container py-4">
	<p class="text-secondary">
		<span class="spinner-border spinner-border-sm"></span>
		Loading the focus display&hellip;
	</p>
	<span class="hint text-secondary">It is fetched from the internet the first time
		it is opened, and cached by your browser afterwards.</span>
</div>

<!-- Two different failures, and they are not interchangeable. This one is the
     editor never arriving, which says nothing about the camera. -->
<div id="focus-fallback" class="container py-4" hidden>
	<div class="mj-notice mj-notice-warn">
		<div class="mj-notice-txt" id="focus-fallback-txt"></div>
		<span class="mj-notice-acts">
			<a class="btn btn-sm btn-primary" href="focus.cgi">Try again</a>
		</span>
	</div>
	<p class="mt-3">
		<a class="btn btn-secondary" href="camera.cgi">Back to Settings</a>
	</p>
</div>

<!-- And this one is the camera having no focus statistics to show. Separate,
     because "try again" is the wrong advice for it: nothing about reloading
     gives a part an AF block it does not have. -->
<div id="focus-unsupported" class="container py-4" hidden>
	<div class="mj-notice mj-notice-warn">
		<div class="mj-notice-txt" id="focus-unsupported-txt"></div>
	</div>
	<p class="mt-3">
		<a class="btn btn-secondary" href="camera.cgi">Back to Settings</a>
	</p>
</div>

<script src="/a/raw-loader.js"></script>
<script src="/a/focus.js"></script>

<%in p/footer.cgi %>
