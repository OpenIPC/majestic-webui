#!/usr/bin/haserl
<%in p/common.cgi %>
<%
	page_title="Upgrading Firmware"
	c="/usr/sbin/sysupgrade -s -x"
	[ "$POST_fw_kernel" = "true" ] && c="${c} -k"
	[ "$POST_fw_rootfs" = "true" ] && c="${c} -r"
	[ "$POST_fw_reboot" = "true" ] && r="true"
	[ "$POST_fw_reset" = "true" ] && c="${c} -n"
	[ "$POST_fw_force" = "true" ] && c="${c} --force_ver"
%>

<%in p/header.cgi %>
<h3 class="alert alert-warning">DO NOT CLOSE, REFRESH, OR NAVIGATE AWAY FROM THIS PAGE UNTIL THE PROCESS IS FINISHED!</h3>
<pre id="output" data-cmd="<%= $c %>" data-reboot="<%= $r %>"></pre>

<script>
	const el = $('pre#output');
	runCmd("cmd")
</script>
<%in p/footer.cgi %>
