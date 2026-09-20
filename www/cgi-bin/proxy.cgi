#!/usr/bin/haserl
<%in p/common.cgi %>
<%
config_file=/etc/webui/proxy.conf
params="host port username password"

if [ "$REQUEST_METHOD" = "POST" ]; then
	rm -f "$config_file"
	for p in $params; do
		# shq, and t_value rather than `eval echo`: this file is sourced
		# back by this page and by all three senders, so a value in it has
		# to survive being read as shell. Wrapped in double quotes and
		# never escaped, a proxy password containing a quote broke every
		# reader of the file, one containing $(...) ran on each of those
		# reads, and `eval echo` collapsed the spaces out of the rest
		# (#547).
		echo "socks5_${p}=$(shq "$(t_value "POST_socks5_${p}")")" >> "$config_file"
	done

	redirect_to "$SCRIPT_NAME"
fi

[ -e "$config_file" ] && include $config_file
%>

<%in p/header.cgi %>

<div class="row g-4">
	<div class="col-12 col-lg-6">
		<div class="card"><div class="card-body">
			<% card_head "SOCKS5 proxy" %>
			<p class="small text-secondary">Route extension traffic (OpenWall, Telegram) through a SOCKS5 proxy.</p>
			<form action="<%= $SCRIPT_NAME %>" method="post">
				<% field_hidden "action" "update" %>
				<% field_text "socks5_host" "SOCKS5 host" %>
				<% field_text "socks5_port" "SOCKS5 port" "1080" %>
				<% field_text "socks5_username" "SOCKS5 username" %>
				<% field_password "socks5_password" "SOCKS5 password" %>
				<% button_submit %>
			</form>
		</div></div>
	</div>
</div>

<details class="mt-4">
	<summary class="text-secondary small">Advanced — raw configuration</summary>
	<div class="mt-3">
		<% [ -e "$config_file" ] && ex "cat $config_file" %>
	</div>
</details>

<%in p/footer.cgi %>
