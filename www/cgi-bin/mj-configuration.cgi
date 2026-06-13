#!/usr/bin/haserl
<%in p/common.cgi %>
<% page_title="Majestic Configuration" %>
<%in p/header.cgi %>

<div class="row g-4">
	<div class="col-12 col-lg-7">
		<div class="card h-100"><div class="card-body">
			<h3>Running configuration</h3>
			<% ex "cat $(get_config)" %>
		</div></div>
	</div>
	<div class="col-12 col-lg-5">
		<div class="card h-100"><div class="card-body">
			<h3>Changes from defaults</h3>
			<%
				diff $(get_config /rom) $(get_config) > /tmp/majestic.patch
				ex "cat /tmp/majestic.patch"
			%>
			<div class="d-flex gap-2 mt-3">
				<a class="btn btn-outline-secondary" href="fw-editor.cgi?f=<%= $(get_config) %>">Edit</a>
				<a class="btn btn-danger" href="fw-restore.cgi?f=<%= $(get_config) %>">Reset to defaults</a>
			</div>
		</div></div>
	</div>
</div>

<%in p/footer.cgi %>
