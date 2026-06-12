#!/usr/bin/haserl
<%in p/common.cgi %>

<%
page_title="Network Settings"
params="address dhcp gateway hostname nameserver netmask interface wlan_ssid wlan_password"

network_list="$(ls /sys/class/net | grep -e eth0 -e wlan0)"
network_nameserver="$(cat /etc/resolv.conf | grep nameserver | cut -d' ' -f2)"
network_netmask="$(ifconfig ${network_interface} | grep Mask | cut -d: -f4)"
network_dhcp="$(cat /etc/network/interfaces.d/${network_interface} | grep -q dhcp && echo true)"

network_wlan_ssid="$(fw_printenv -n wlanssid)"
network_wlan_password="$(fw_printenv -n wlanpass)"

if [ "$REQUEST_METHOD" = "POST" ]; then
	case "$POST_action" in
		changemac)
			if echo "$POST_mac_address" | grep -Eiq '^([0-9a-f]{2}[:-]){5}([0-9a-f]{2})$'; then
				fw_setenv ethaddr "$POST_mac_address"
				update_caminfo
				touch /tmp/system-reboot
				redirect_back "success" "MAC address updated."
			else
				if [ -z "$POST_mac_address" ]; then
					redirect_back "warning" "Empty MAC address."
				else
					redirect_back "warning" "Invalid MAC address: ${POST_mac_address}"
				fi
			fi
			;;

		reset)
			rm -f /etc/network/interfaces.d/*
			cp -f /rom/etc/network/interfaces.d/* /etc/network/interfaces.d
			redirect_back
			;;

		update)
			for p in $params; do
				eval network_${p}=\$POST_network_${p}
			done

			[ -z "$network_interface" ] && set_error_flag "Default network interface cannot be empty."
			if [ "$network_interface" = "wlan0" ]; then
				[ -z "$network_wlan_ssid" ] && set_error_flag "WLAN SSID cannot be empty."
				[ -z "$network_wlan_password" ] && set_error_flag "WLAN Password cannot be empty."
			fi

			if [ "$network_dhcp" = "false" ]; then
				network_mode="static"
				[ -z "$network_address" ] && set_error_flag "IP address cannot be empty."
				[ -z "$network_netmask" ] && set_error_flag "Networking mask cannot be empty."
			else
				network_mode="dhcp"
			fi

			if [ -z "$error" ]; then
				command="setnetwork"
				command="${command} -i $network_interface"
				command="${command} -m $network_mode"
				command="${command} -h $network_hostname"

				if [ "$network_interface" = "wlan0" ]; then
					command="${command} -s $network_wlan_ssid"
					command="${command} -p $network_wlan_password"
				fi

				if [ "$network_mode" != "dhcp" ]; then
					command="${command} -a $network_address"
					command="${command} -n $network_netmask"
					[ -n "$network_gateway" ] && command="${command} -g $network_gateway"
					[ -n "$network_nameserver" ] && command="${command} -d $network_nameserver"
				fi

				echo "$command" >> /tmp/webui.log
				eval "$command" > /dev/null 2>&1

				update_caminfo
				redirect_back "success" "Network settings updated."
			fi
			;;
	esac
fi
%>
<%in p/header.cgi %>

<div class="row g-4">
	<div class="col-12 col-lg-7">
		<div class="card h-100"><div class="card-body">
			<h3>Network settings</h3>
			<form action="<%= $SCRIPT_NAME %>" method="post">
				<% field_hidden "action" "update" %>

				<div class="text-uppercase x-small text-secondary mb-2">General</div>
				<% field_text "network_hostname" "Hostname" %>
				<% field_string "network_interface" "Network interface" "eval" "$network_list" %>

				<div id="wifi-section">
					<div class="text-uppercase x-small text-secondary mt-3 mb-2">Wi-Fi</div>
					<% field_text "network_wlan_ssid" "WLAN SSID" %>
					<div class="mb-3">
						<button type="button" class="btn btn-sm btn-outline-secondary" id="wifi-scan">Scan for networks</button>
						<span id="wifi-scan-status" class="small text-secondary ms-2"></span>
						<select id="wifi-results" class="form-select form-select-sm mt-2 d-none"></select>
					</div>
					<% field_password "network_wlan_password" "WLAN Password" %>
				</div>

				<div class="text-uppercase x-small text-secondary mt-3 mb-2">IP</div>
				<% field_switch "network_dhcp" "Use DHCP" "eval" %>
				<% field_text "network_address" "IP Address" %>
				<% field_text "network_netmask" "IP Netmask" %>
				<% field_text "network_gateway" "Gateway" %>
				<% field_text "network_nameserver" "DNS" %>
				<% button_submit %>
			</form>
		</div></div>
	</div>

	<div class="col-12 col-lg-5">
		<div class="card h-100"><div class="card-body">
			<h3>Current connection</h3>
			<dl class="small list mb-0">
				<dt>Hostname</dt><dd><%= $network_hostname %></dd>
				<dt>Interface</dt><dd><%= $network_interface %></dd>
				<dt>Mode</dt><dd><%= $([ "$network_dhcp" = "true" ] && echo DHCP || echo Static) %></dd>
				<dt>IP</dt><dd><%= $network_address %></dd>
				<dt>Netmask</dt><dd><%= ${network_netmask:-—} %></dd>
				<dt>Gateway</dt><dd><%= ${network_gateway:-—} %></dd>
				<dt>DNS</dt><dd><%= ${network_nameserver:-—} %></dd>
				<dt>MAC</dt><dd class="text-break"><%= $network_macaddr %></dd>
			</dl>
		</div></div>
	</div>
</div>

<details class="mt-4">
	<summary>Advanced</summary>
	<div class="row g-4 mt-1">
		<div class="col-12 col-lg-6">
			<div class="card"><div class="card-body">
				<h3>Change MAC address</h3>
				<p class="small text-secondary">Override the Ethernet MAC address. <span class="text-danger">Requires a reboot.</span></p>
				<form action="<%= $SCRIPT_NAME %>" method="post">
					<% field_hidden "action" "changemac" %>
					<% field_string "mac_address" "MAC address" "$network_macaddr" %>
					<% button_submit "Update MAC" "danger" %>
				</form>

				<hr class="my-3">
				<h3 class="fs-6">Reset network configuration</h3>
				<p class="small text-secondary">Restore the config bundled with the firmware. All changes are lost.</p>
				<form action="<%= $SCRIPT_NAME %>" method="post">
					<% field_hidden "action" "reset" %>
					<% button_submit "Reset config" "outline-danger confirm" %>
				</form>
			</div></div>
		</div>

		<div class="col-12 col-lg-6">
			<div class="card"><div class="card-body">
				<h3>Diagnostics</h3>
				<% for dev in $network_list; do %>
					<% ex "cat /etc/network/interfaces.d/$dev" %>
				<% done %>
				<% [ -n "$(fw_printenv -n wlandev)" ] && ex "fw_printenv | grep wlan" %>
				<% ex "ifconfig" %>
			</div></div>
		</div>
	</div>
</details>

<script src="/a/fw-network.js" defer></script>

<%in p/footer.cgi %>
