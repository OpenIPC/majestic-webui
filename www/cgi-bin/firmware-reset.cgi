#!/usr/bin/haserl
<%in p/common.cgi %>
<%
	page_title="Erasing Overlay"
	c="/usr/sbin/sysupgrade -s -x -n"
	r="true"
%>

<%in p/header.cgi %>
<h3 class="alert alert-warning">DO NOT CLOSE, REFRESH, OR NAVIGATE AWAY FROM THIS PAGE UNTIL THE PROCESS IS FINISHED!</h3>
<pre id="output" data-cmd="<%= $c %>" data-reboot="<%= $r %>"></pre>

<script>
	const el = $('pre#output');
	runCmd("cmd")
</script>
<%in p/footer.cgi %>
