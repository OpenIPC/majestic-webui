#!/usr/bin/haserl
<%in p/common.cgi %>
<%
config_file=/etc/webui/proxy.conf
params="host port username password"

if [ "$REQUEST_METHOD" = "POST" ]; then
	rm -f "$config_file"
	for p in $params; do
		# conf_write, so that what a shell reads back out of this file is
		# exactly what was posted. It is sourced by this page and by all three
		# senders, so a value in it has to survive being read as shell: wrapped
		# in double quotes and never escaped, a proxy password containing a
		# quote broke every reader of the file and one containing $(...) ran on
		# each of those reads, while the `eval echo` that read it collapsed the
		# spaces out of the rest (#547).
		#
		# Plain assignment rather than $(t_value ...): an assignment's
		# right-hand side is not word-split, and it does not strip the trailing
		# newlines a command substitution would.
		eval "_v=\$POST_socks5_${p}"
		conf_write "socks5_${p}" "$_v" >> "$config_file"
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
