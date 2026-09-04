#!/usr/bin/haserl
<%in p/common.cgi %>
<%in p/header.cgi %>

<div class="row g-4">
	<div class="col-12 col-lg-7">
		<div class="card h-100"><div class="card-body">
			<% card_head "Running configuration" %>
			<% ex "cat $(get_config)" %>
		</div></div>
	</div>
	<div class="col-12 col-lg-5">
		<div class="card h-100"><div class="card-body">
			<% card_head "Changes from defaults" %>
			<%
				diff $(get_config /rom) $(get_config) > /tmp/majestic.patch
				ex "cat /tmp/majestic.patch"
			%>
			<div class="d-flex gap-2 mt-3">
				<a class="btn btn-outline-secondary" href="editor.cgi?f=<%= $(get_config) %>">Edit</a>
				<a class="btn btn-danger" href="config-reset.cgi?f=<%= $(get_config) %>"
					data-confirm="Put every camera setting back to what the firmware shipped?&#10;&#10;This takes effect at once: video restarts on the default settings and everything configured since is gone.">Reset to defaults</a>
			</div>
		</div></div>
	</div>
</div>

<%in p/footer.cgi %>
