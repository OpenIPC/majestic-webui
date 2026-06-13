#!/usr/bin/haserl
<%in p/common.cgi %>
<%
page_title="WireGuard"
env_set=$(fw_printenv | grep -c ^wg_)

if [ "$REQUEST_METHOD" = "POST" ]; then
 if [ "$POST_action" = "reset" ]; then
  ip link del wg0 2>/dev/null
  for var in wg_privkey wg_pubkey wg_sharkey wg_allowed wg_endpoint wg_alive wg_address; do
   fw_setenv "$var"
  done
  rm -f /tmp/wireguard.conf
  sleep 1
  redirect_to "$SCRIPT_NAME" "danger" "WireGuard is down"
 fi

 if [ -n "$POST_wg_privkey" ] && [ -n "$POST_wg_pubkey" ]; then
  for var in wg_privkey wg_pubkey wg_sharkey wg_allowed wg_endpoint wg_alive wg_address; do
   val=$(eval echo "\$POST_${var}")
   fw_setenv "$var" "$val"
  done
 
  /usr/sbin/wireguard

  sleep 1
  redirect_to "$SCRIPT_NAME" "success" "WireGuard is up"
 fi
fi
%>

<%in p/header.cgi %>

<div class="row g-4">
	<div class="col-12 col-lg-7">
		<div class="card h-100"><div class="card-body">
			<h3>WireGuard</h3>
			<p class="small text-secondary">WireGuard VPN tunnel for secure remote access.</p>
			<% if ip link show wg0 >/dev/null 2>&1; then %>
				<dl class="small list">
					<dt>Status</dt><dd><span class="text-success">Up</span></dd>
					<dt>Endpoint</dt><dd class="text-break"><%= $(fw_printenv -n wg_endpoint) %></dd>
					<dt>Address</dt><dd class="text-break"><%= $(fw_printenv -n wg_address) %></dd>
				</dl>
			<% fi %>
			<form action="<%= $SCRIPT_NAME %>" method="post">
				<% if [ "$env_set" -gt 0 ]; then %>
					<% field_hidden "action" "reset" %>
					<% button_submit "Reset configuration" "danger" %>
				<% else %>
					<% field_text "wg_privkey" "Private key" %>
					<% field_text "wg_pubkey" "Public key" %>
					<% field_text "wg_sharkey" "Preshared key" %>
					<% field_text "wg_allowed" "Allowed IPs (e.g. 10.0.0.0/24)" %>
					<% field_text "wg_endpoint" "Peer endpoint (IP:Port)" %>
					<% field_text "wg_alive" "Persistent keepalive (e.g. 25)" %>
					<% field_text "wg_address" "Address (e.g. 10.0.0.2/24)" %>
					<% button_submit "Save Changes" %>
				<% fi %>
			</form>
		</div></div>
	</div>
</div>

<details class="mt-4">
	<summary class="text-secondary small">Advanced — raw configuration</summary>
	<div class="mt-3">
		<%
			[ -e /tmp/wireguard.conf ] && ex "cat /tmp/wireguard.conf"
			ex "fw_printenv | grep ^wg_"
			ex "ip link show wg0"
			ex "ip addr show wg0"
		%>
	</div>
</details>

<%in p/footer.cgi %>
