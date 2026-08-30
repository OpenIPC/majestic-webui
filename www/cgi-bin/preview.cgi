#!/usr/bin/haserl
<%in p/common.cgi %>

<% page_title="Live View"; hide_title=1 %>
<%in p/header.cgi %>
<!-- No page heading: the nav underlines "Live", and the row the <h2> occupied
     is exactly the row the player needs to fit a laptop viewport without
     scrolling.

     This page is deliberately settings-free: it is the page every user of a
     future multi-user system gets, read-only, so nothing on it changes the
     camera. Every setting — including the night/IR/light toggles that used
     to sit here — lives in mj-settings.cgi, whose Live section pairs the
     same preview with the real-time adjustments. The one exception is the
     PTZ pad, which steers rather than configures; it stays on the video
     until the multi-user split decides who may steer. -->


<div class="row g-4">
	<div class="col-12">
		<div class="card"><div class="card-body">
			<% preview %>
			<% if [ -n "$ptz_support" ]; then %>
				<%in p/motor.cgi %>
			<% fi %>
			<p class="small mb-0 mt-2"><a href="mj-endpoints.cgi">Stream URLs</a></p>
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
