#!/usr/bin/haserl
<%in p/common.cgi %>
<% page_title="Majestic Configuration" %>
<%in p/header.cgi %>

<div class="row row-cols-md-2">
	<% ex "cat $(get_config)" %>
	<div class="col">
		<%
			diff $(get_config /rom) $(get_config) > /tmp/majestic.patch
			ex "cat /tmp/majestic.patch"
		%>
		<div class="row">
			<p><a class="btn btn-secondary" href="fw-editor.cgi?f=<%= $(get_config) %>">Edit Configuration</a></p>
			<p><a class="btn btn-danger" href="fw-restore.cgi?f=<%= $(get_config) %>">Reset Configuration</a></p>
		</div>
	</div>
</div>

<%in p/footer.cgi %>
