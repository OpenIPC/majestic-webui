#!/usr/bin/haserl
<%in p/common.cgi %>
<%
page_title="Tunnel"
conf_file=/tmp/vtund.conf
env_host=$(fw_printenv -n vtun)

if [ -n "$POST_action" ] && [ "$POST_action" = "reset" ]; then
	killall -q tunnel
	killall -q vtund
	rm -f "$conf_file"
	fw_setenv vtun
	redirect_to "$SCRIPT_NAME" "danger" "Tunnel is down"
fi

if [ -n "$POST_vtun_host" ]; then
	fw_setenv vtun "$POST_vtun_host"
	/etc/init.d/S98vtun start
	redirect_to "$SCRIPT_NAME" "success" "Tunnel is up"
fi
%>

<%in p/header.cgi %>

<div class="row row-cols-1 row-cols-md-2 row-cols-lg-3 g-4 mb-4">
	<div class="col">
	<% if [ -e "$conf_file" ]; then %>
		<div class="alert alert-success">
		<h4>Virtual Tunnel is up</h4>
		<p>Use the following credentials to set up remote access via virtual tunnel:</p>
		<dl class="mb-0">
			<dt>Tunnel ID</dt>
			<dd><%= ${network_macaddr//:/} | tr a-z A-Z %></dd>
			<dt>Password</dt>
			<dd><% grep password $conf_file | xargs | cut -d' ' -f2 | sed 's/;$//' %>
		</dl>
		</div>
	<% fi %>

	<h3>Settings</h3>
	<form action="<%= $SCRIPT_NAME %>" method="post">
		<% if [ -n "$env_host" ]; then %>
			<% field_hidden "action" "reset" %>
			<% button_submit "Reset configuration" %>
		<% else %>
			<% field_text "vtun_host" "Virtual Tunnel address" %>
			<% button_submit %>
		<% fi %>
	</form>
	</div>

	<div class="col col-lg-8">
		<h3>Configuration</h3>
		<%
			[ -e "$conf_file" ] && ex "cat $conf_file"
			[ -n "$env_host" ] && ex "fw_printenv | grep vtun"
			ex "pgrep -a vtun"
		%>
	</div>
</div>

<%in p/footer.cgi %>
