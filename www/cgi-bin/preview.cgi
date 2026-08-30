#!/usr/bin/haserl
<%in p/common.cgi %>

<% page_title="Live View"; hide_title=1 %>
<%in p/header.cgi %>
<!-- No page heading: the nav underlines "Live", and the row the <h2> occupied
     is exactly the row the player needs to fit a laptop viewport without
     scrolling. -->


<div class="row g-4">
	<div class="col-12">
		<div class="card"><div class="card-body">
			<!-- Stage on the left, device controls in a side rail. The rail is
			     back by popular demand (#184): the stage's viewport clamp
			     leaves horizontal room on most screens, and p/motor.cgi is a
			     de-facto plugin point — people replace it with their own
			     controls built for the old ~300px column, and those must keep
			     a column to land in. Our own pads are hidden markup that
			     preview-ptz.js lifts onto the video, so with stock files the
			     rail holds just the toggles. When the stage needs the full
			     width the rail wraps below it — at its own width, never
			     stretched across the page. -->
			<div class="mj-layout">
				<div class="mj-main">
					<% preview %>
				</div>
				<aside class="mj-side">
					<!-- Device controls, not view controls: what they switch is
					     the camera itself, for every viewer, so they live on
					     the page rather than in the player's bar. Same ids the
					     wiring in preview-page.js has always used. -->
					<div class="d-grid gap-2">
						<input type="checkbox" class="btn-check" id="toggle-night">
						<label class="btn btn-outline-primary" for="toggle-night">🌙 Night mode</label>

						<input type="checkbox" class="btn-check" id="toggle-ircut">
						<label class="btn btn-outline-primary" for="toggle-ircut">👁 IR filter</label>

						<input type="checkbox" class="btn-check" id="toggle-light">
						<label class="btn btn-outline-primary" for="toggle-light">💡 Light</label>
					</div>
					<p class="small mt-2 mb-0" id="mj-lightmon" hidden><a href="mj-settings.cgi?tab=nightMode">Light monitor active</a></p>
					<% if [ -n "$ptz_support" ]; then %>
						<%in p/motor.cgi %>
					<% fi %>
					<p class="small mt-2 mb-0"><a href="mj-endpoints.cgi">Stream URLs</a></p>
				</aside>
			</div>
		</div></div>
	</div>
</div>

<script src="/a/preview.js"></script>
<script src="/a/preview-webrtc.js"></script>
<script src="/a/preview-swap.js"></script>
<script src="/a/preview-transport.js"></script>
<script src="/a/preview-page.js"></script>
<script src="/a/preview-hero.js"></script>

<%in p/footer.cgi %>
