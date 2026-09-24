#!/usr/bin/haserl
<%in p/common.cgi %>

<%
# Focusing a lens.
#
# A page of its own rather than a corner of Raw, because the person doing this
# is not developing a frame -- they are up a ladder with a screwdriver, and
# "Raw" is not the word they would look under.
#
# The editor draws the grid over the picture when it can be fetched. When it
# cannot, the numbers still come from the camera, so the page falls back to
# reading them out rather than apologising: a rising number is enough to focus
# a lens by, and that is the function this page exists for.
hide_title=1; full_bleed=1
%>
<%in p/header.cgi %>

<!-- The editor mounts here and covers the viewport. -->
<div id="focus-editor-host"></div>

<div id="focus-loading" class="container py-4">
	<p class="text-secondary">
		<span class="spinner-border spinner-border-sm"></span>
		Loading the focus display&hellip;
	</p>
	<span class="hint text-secondary">The display is fetched by this browser the
		first time it is opened, and cached by it afterwards.</span>
</div>

<!-- The camera answers, the editor did not arrive. Degraded, not broken: the
     grid is still measured and still read out, only without the picture under
     it. The numbers are what a lens is focused by. -->
<div id="focus-plain" class="container py-4" hidden>
	<div class="mj-notice mj-notice-warn">
		<div class="mj-notice-txt" id="focus-plain-why"></div>
		<!-- A link, not a click handler: reloading is the retry, and it starts a
		     fresh attempt with no memory of the one that failed. -->
		<span class="mj-notice-acts">
			<a class="btn btn-sm btn-primary" href="focus.cgi">Try again</a>
		</span>
	</div>

	<h2 class="h5 mt-3">Sharpest zone</h2>
	<p class="h1 mb-1" id="focus-plain-peak">&mdash;</p>
	<p class="mb-1" id="focus-plain-where"></p>
	<p class="mb-1 text-secondary" id="focus-plain-counts"></p>
	<span class="hint text-secondary">Turn the focus until this number stops
		rising. It is the camera's own measure of detail, read straight from the
		sharpest cell of its focus grid &mdash; the same number the display would
		draw, without the picture under it.</span>

	<p class="mt-3">
		<a class="btn btn-secondary" href="camera.cgi">Back to Settings</a>
	</p>
</div>

<!-- And this one is the camera having nothing to report. Kept apart from the
     panel above because its advice is the opposite: there is no reading to
     show and, where the cause is permanent, nothing to come back for. -->
<div id="focus-unsupported" class="container py-4" hidden>
	<div class="mj-notice mj-notice-warn">
		<div class="mj-notice-txt" id="focus-unsupported-txt"></div>
		<!-- Shown only where asking again could answer differently. A part with
		     no AF block will not grow one, and offering a retry for that is an
		     invitation to keep pressing. -->
		<span class="mj-notice-acts" id="focus-unsupported-acts" hidden>
			<a class="btn btn-sm btn-primary" href="focus.cgi">Try again</a>
		</span>
	</div>
	<p class="mt-3">
		<a class="btn btn-secondary" href="camera.cgi">Back to Settings</a>
	</p>
</div>

<script src="/a/raw-loader.js"></script>
<script src="/a/focus.js"></script>

<%in p/footer.cgi %>
