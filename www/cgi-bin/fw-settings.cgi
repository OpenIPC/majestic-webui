#!/usr/bin/haserl
<%in p/common.cgi %>
<% page_title="Firmware Settings" %>
<%in p/header.cgi %>

<div class="row row-cols-md-3 g-4 mb-4">
	<div class="col">
		<div class="alert alert-danger">
			<h4>Restart Camera</h4>
			<p>Reboot camera to apply new settings and reset temporary files.</p>
			<a class="btn btn-danger" href="fw-restart.cgi">Restart Camera</a>
		</div>
	</div>
	<div class="col">
		<div class="alert alert-danger">
			<h4>Reset Firmware</h4>
			<p>Revert firmware to original state by resetting the overlay partition.</p>
			<a class="btn btn-danger" href="fw-reset.cgi">Reset Firmware</a>
		</div>
	</div>
</div>

<%in p/footer.cgi %>
