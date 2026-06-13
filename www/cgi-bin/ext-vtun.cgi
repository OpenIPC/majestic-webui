#!/usr/bin/haserl
<%in p/common.cgi %>
<%
page_title="VTun"
conf_file=/tmp/vtund.conf
env_host=$(fw_printenv -n vtun)

if [ "$REQUEST_METHOD" = "POST" ]; then
	if [ "$POST_action" = "reset" ]; then
		killall -q tunnel
		killall -q vtund
		rm -f "$conf_file"
		fw_setenv vtun
		sleep 1
		redirect_to "$SCRIPT_NAME" "danger" "VTun is down"
	fi

	if [ -n "$POST_vtun_host" ]; then
		fw_setenv vtun "$POST_vtun_host"
		/etc/init.d/S98vtun start
		sleep 1
		redirect_to "$SCRIPT_NAME" "success" "VTun is up"
	fi
fi
%>

<%in p/header.cgi %>

<div class="row g-4">
	<div class="col-12 col-lg-6">
		<div class="card h-100"><div class="card-body">
			<h3>VTun</h3>
			<p class="small text-secondary">Virtual tunnel for remote access to the camera.</p>
			<% if [ -e "$conf_file" ]; then %>
				<dl class="small list">
					<dt>Status</dt><dd><span class="text-success">Up</span></dd>
					<dt>VTun ID</dt><dd class="text-break"><%= ${network_macaddr//:/} | tr a-z A-Z %></dd>
					<dt>Password</dt><dd class="text-break"><% grep password $conf_file | xargs | cut -d' ' -f2 | sed 's/;$//' %></dd>
				</dl>
				<p class="small text-secondary">Use these credentials to set up remote access.</p>
			<% fi %>
			<form action="<%= $SCRIPT_NAME %>" method="post">
				<% if [ -n "$env_host" ]; then %>
					<% field_hidden "action" "reset" %>
					<% button_submit "Reset configuration" "danger" %>
				<% else %>
					<% field_text "vtun_host" "VTun address" %>
					<% button_submit %>
				<% fi %>
			</form>
		</div></div>
	</div>
</div>

<details class="mt-4">
	<summary class="text-secondary small">Advanced — raw configuration</summary>
	<div class="mt-3">
		<%
			[ -e "$conf_file" ] && ex "cat $conf_file"
			[ -n "$env_host" ] && ex "fw_printenv | grep vtun"
			ex "pgrep -a vtund"
		%>
	</div>
</details>

<%in p/footer.cgi %>
