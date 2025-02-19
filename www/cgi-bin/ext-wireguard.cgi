#!/usr/bin/haserl
<%in p/common.cgi %>
<% page_title="WireGuard Configuration" %>
<%
if [ "$REQUEST_METHOD" = "POST" ]; then
	case "$POST_action" in
		reload)
			output=$(wg setconf wg0 /etc/wireguard.conf 2>&1)
			if [ $? -eq 0 ]; then
				redirect_back "success" "WireGuard configuration has been reloaded."
			else
				redirect_back "danger" "Failed to reload WireGuard configuration: $output"
			fi
			;;
	esac

	redirect_to "$HTTP_REFERER"
fi
%>
<%in p/header.cgi %>

<div class="row row-cols-2">
	<div class="col">
		<%
			ex "cat /etc/network/interfaces.d/wg0"
		%>
		<div class="row">
			<p><a class="btn btn-secondary" href="fw-editor.cgi?f=<%= /etc/network/interfaces.d/wg0 %>">Edit Interface</a></p>
		</div>
		<%
			ex "cat /etc/rc.local"
		%>
		<div class="row">
			<p><a class="btn btn-secondary" href="fw-editor.cgi?f=<%= /etc/rc.local %>">Edit Boot script</a></p>
		</div>
	</div>
	<div class="col">
		<%
			ex "cat /etc/wireguard.conf"
		%>
		<div class="row">
			<p><a class="btn btn-secondary" href="fw-editor.cgi?f=<%= /etc/wireguard.conf %>">Edit WireGuard configuration</a></p>
			<form action="<%= $SCRIPT_NAME %>" method="post">
				<input type="hidden" name="action" value="reload">
				<% button_submit "Reload WireGuard configuration" "success" %>
			</form>
		</div>
	</div>
</div>

<%in p/footer.cgi %>
