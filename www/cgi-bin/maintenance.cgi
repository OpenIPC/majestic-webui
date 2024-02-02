#!/usr/bin/haserl
<%in p/common.cgi %>
<% page_title="Maintenance" %>
<%in p/header.cgi %>

<div class="row row-cols-md-3 g-4 mb-4">
	<div class="col">
		<div class="alert alert-danger">
			<h4>Restart camera</h4>
			<p>Reboot camera to apply new settings. That will also delete all data on partitions mounted into system memory, e.g. /tmp.</p>
			<a class="btn btn-danger" href="restart.cgi">Restart camera</a>
		</div>
	</div>
	<div class="col">
		<div class="alert alert-danger">
			<h4>Reset firmware</h4>
			<p>Revert firmware to its original state by wiping out overlay partition. All custom settings and all files stored on overlay partition will be lost!</p>
			<a class="btn btn-danger" href="firmware-reset.cgi">Reset firmware</a>
		</div>
	</div>
</div>

<%in p/footer.cgi %>
