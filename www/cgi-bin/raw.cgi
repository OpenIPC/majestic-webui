#!/usr/bin/haserl
<%in p/common.cgi %>

<%in p/header.cgi %>

<!-- Ships hidden. raw.js unhides it with whatever the camera turns out to say:
     a build with no raw support, a camera with it switched off, a capture that
     failed, or an editor that could not be fetched. Claiming any of those
     before the camera has answered would be a banner at every visitor whose
     camera is fine. -->
<div id="raw-note" class="mj-notice" role="alert" hidden></div>

<div class="row g-4 mb-4">
	<div class="col-12 col-lg-8">
		<div class="card">
			<div class="card-body">
				<% card_head "Capture" "the sensor's own data, before the image pipeline" %>
				<p>
					<button type="button" class="btn btn-primary" id="raw-capture" disabled>Capture a frame</button>
					<button type="button" class="btn btn-secondary" id="raw-download" disabled>Download</button>
					<button type="button" class="btn btn-secondary" id="raw-open" disabled>Open editor</button>
				</p>
				<span class="hint text-secondary">A raw frame is several megabytes and is kept in
					this browser tab, never on the camera — its flash holds the firmware.</span>
				<div class="mj-live-grp-head"><h3 class="mj-cap">This session</h3><span class="mj-live-rule"></span></div>
				<div id="raw-strip"></div>
			</div>
		</div>
	</div>

	<div class="col-12 col-lg-4">
		<div class="card">
			<div class="card-body">
				<% card_head "Status" %>
				<dl class="list">
					<dt>Raw mode</dt><dd id="raw-mode">&mdash;</dd>
					<dt>Last capture</dt><dd id="raw-took">&mdash;</dd>
				</dl>
				<span class="hint text-secondary">The editor is fetched the first time you open
					it and then cached by your browser. Nothing is downloaded until then, and
					nothing is stored on the camera.</span>
			</div>
		</div>
	</div>
</div>

<!-- The editor mounts here and covers the viewport. Empty and hidden until
     someone asks for it, so a camera with no route out never notices. -->
<div id="raw-editor-host" hidden></div>

<script src="/a/raw-loader.js"></script>
<script src="/a/raw.js"></script>

<%in p/footer.cgi %>
