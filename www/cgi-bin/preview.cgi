#!/usr/bin/haserl
<%in p/common.cgi %>

<% page_title="Camera Preview" %>
<%in p/header.cgi %>

<div class="row g-4">
	<div class="col-12 col-lg-9">
		<div class="card h-100"><div class="card-body">
			<% preview %>
			<p class="small mb-0"><a href="mj-endpoints.cgi">Majestic endpoints</a></p>
		</div></div>
	</div>

	<div class="col-12 col-lg-3">
		<div class="card h-100"><div class="card-body">
			<h3>Controls</h3>
			<p class="small" id="mj-lightmon" hidden><a href="mj-settings.cgi?tab=nightMode">Light monitor active</a></p>
			<div class="d-grid gap-2">
				<input type="checkbox" class="btn-check" id="toggle-night">
				<label class="btn btn-outline-primary" for="toggle-night">Night</label>

				<input type="checkbox" class="btn-check" id="toggle-ircut">
				<label class="btn btn-outline-primary" for="toggle-ircut">IRcut</label>

				<input type="checkbox" class="btn-check" id="toggle-light">
				<label class="btn btn-outline-primary" for="toggle-light">Light</label>

				<% if [ -n "$ptz_support" ]; then %>
					<%in p/motor.cgi %>
				<% fi %>
			</div>
		</div></div>
	</div>
</div>

<script src="/a/preview.js"></script>
<script src="/a/preview-page.js"></script>

<%in p/footer.cgi %>
