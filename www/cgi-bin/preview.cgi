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
			<% preview %>
			<% if [ -n "$ptz_support" ]; then %>
				<%in p/motor.cgi %>
			<% fi %>
			<!-- Device controls, not view controls: what they switch is the
			     camera itself, for every viewer, so they live on the page
			     rather than in the player's bar. Same ids the wiring in
			     preview-page.js has always used. -->
			<div class="d-flex flex-wrap align-items-center gap-2 mt-2">
				<input type="checkbox" class="btn-check" id="toggle-night">
				<label class="btn btn-sm btn-outline-primary" for="toggle-night">🌙 Night mode</label>

				<input type="checkbox" class="btn-check" id="toggle-ircut">
				<label class="btn btn-sm btn-outline-primary" for="toggle-ircut">👁 IR filter</label>

				<input type="checkbox" class="btn-check" id="toggle-light">
				<label class="btn btn-sm btn-outline-primary" for="toggle-light">💡 Light</label>

				<span class="small" id="mj-lightmon" hidden><a href="mj-settings.cgi?tab=nightMode">Light monitor active</a></span>
				<a class="small ms-auto" href="mj-endpoints.cgi">Stream URLs</a>
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
