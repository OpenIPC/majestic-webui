#!/usr/bin/haserl
<%in p/common.cgi %>
<%
page_title="Proxy"
config_file=/etc/webui/proxy.conf
params="host port username password"

if [ "$REQUEST_METHOD" = "POST" ]; then
	rm -f "$config_file"
	for p in $params; do
		echo "socks5_${p}=\"$(eval echo \$POST_socks5_${p})\"" >> "$config_file"
	done

	redirect_to "$SCRIPT_NAME"
fi

[ -e "$config_file" ] && include $config_file
%>

<%in p/header.cgi %>

<div class="row g-4">
	<div class="col-12 col-lg-6">
		<div class="card h-100"><div class="card-body">
			<h3>SOCKS5 proxy</h3>
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
