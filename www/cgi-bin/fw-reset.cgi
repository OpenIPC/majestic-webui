#!/usr/bin/haserl
<%in p/common.cgi %>
<%
	page_title="Erasing Overlay"
	c="/usr/sbin/sysupgrade -s -n -x"
	r="true"
%>

<%in p/header.cgi %>
<div class="alert alert-warning">Do not close, refresh, or navigate away from this page until the process finishes. The camera will reboot automatically.</div>
<div class="card"><div class="card-body">
	<h3>Progress</h3>
	<pre id="output" class="mb-0" data-cmd="<%= $c %>" data-reboot="<%= $r %>"></pre>
</div></div>

<script>
	const el = $('pre#output');
	runCmd("cmd")
</script>
<%in p/footer.cgi %>
