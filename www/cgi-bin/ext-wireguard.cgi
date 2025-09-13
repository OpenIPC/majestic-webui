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
 
  /usr/sbin/wg-start

  sleep 1
  redirect_to "$SCRIPT_NAME" "success" "WireGuard is up"
 fi
fi
%>

<%in p/header.cgi %>

<div class="row row-cols-1 row-cols-md-2 row-cols-lg-3 g-4 mb-4">
 <div class="col">
 <% if ip link show wg0 >/dev/null 2>&1; then %>
  <div class="alert alert-success">
  <h4>WireGuard is up</h4>
  <p>Tunnel is active and running.</p>
  <dl class="mb-0">
   <dt>Endpoint</dt>
   <dd><%= fw_printenv -n wg_endpoint %></dd>
   <dt>Interface Address</dt>
   <dd><%= fw_printenv -n wg_address %></dd>
  </dl>
  </div>
 <% fi %>

 <h3>Settings</h3>
 <form action="<%= $SCRIPT_NAME %>" method="post">
  <% if [ "$env_set" -gt 0 ]; then %>
   <% field_hidden "action" "reset" %>
   <% button_submit "Reset configuration" %>
  <% else %>
   <% field_text "wg_privkey" "Private Key" %>
   <% field_text "wg_pubkey" "Public Key" %>
   <% field_text "wg_sharkey" "Preshared Key" %>
   <% field_text "wg_allowed" "Allowed IPs (e.g. 10.0.0.0/24)" %>
   <% field_text "wg_endpoint" "Peer Endpoint (IP:Port)" %>
   <% field_text "wg_alive" "Persistent Keepalive (e.g. 25)" %>
   <% field_text "wg_address" "Address (e.g. 10.0.0.2/24)" %>
   <% button_submit "Save Changes" %>
  <% fi %>
 </form>
 </div>

 <div class="col col-lg-8">
  <h3>Configuration</h3>
  <%
   [ -e /tmp/wireguard.conf ] && ex "cat /tmp/wireguard.conf"
   ex "fw_printenv | grep ^wg_"
   ex "ip link show wg0"
   ex "ip addr show wg0"
  %>
 </div>
</div>

<%in p/footer.cgi %>
