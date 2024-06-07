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
				[ -z "$network_wlan_ssid" ] && set_error_flag"WLAN SSID cannot be empty."
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
	<div class="col col-md-6 col-lg-4 mb-4">
		<form action="<%= $SCRIPT_NAME %>" method="post">
			<% field_hidden "action" "update" %>
			<% field_text "network_hostname" "Hostname" %>
			<% field_string "network_interface" "Network interface" "eval" "$network_list" %>
			<% field_text "network_wlan_ssid" "WLAN SSID" %>
			<% field_text "network_wlan_password" "WLAN Password" %>

			<% field_switch "network_dhcp" "Use DHCP" "eval" %>
			<% field_text "network_address" "IP Address" %>
			<% field_text "network_netmask" "IP Netmask" %>
			<% field_text "network_gateway" "Gateway" %>
			<% field_text "network_nameserver" "DNS" %>
			<% button_submit %>
		</form>

		<div class="alert alert-danger mt-4">
			<h5>Reset network configuration</h5>
			<p>Restore the config file bundled with firmware. All changes to the default configuration will be lost!</p>
			<form action="<%= $SCRIPT_NAME %>" method="post">
				<% field_hidden "action" "reset" %>
				<% button_submit "Reset config" "danger" %>
			</form>
		</div>
	</div>

	<div class="col col-md-6 col-lg-8">
		<% for dev in $network_list; do %>
			<% ex "cat /etc/network/interfaces.d/$dev" %>
		<% done %>
		<% if [ -n "$(fw_printenv -n wlandev)" ]; then %>
			<% ex "fw_printenv | grep wlan" %>
		<% fi %>
		<% ex "ifconfig" %>
	</div>
</div>

<script>
	function toggleStatic() {
		const c = $('#network_dhcp').checked;
		const ids = ['network_address','network_netmask','network_gateway','network_nameserver'];
		ids.forEach(id => {
			$('#' + id).disabled = c;
			let el = $('#' + id + '_wrap');
			c ? el.classList.add('d-none') : el.classList.remove('d-none');
		});
	}

	function toggleInterface() {
		const ids = ['network_wlan_ssid','network_wlan_password'];
		if ($('#network_interface').value == 'wlan0') {
			ids.forEach(id => $('#' + id + '_wrap').classList.remove('d-none'));
		} else {
			ids.forEach(id => $('#' + id + '_wrap').classList.add('d-none'));
		}
	}

	$('#network_interface').addEventListener('change', toggleInterface);
	$('#network_dhcp').addEventListener('change', toggleStatic);

	toggleInterface();
	toggleStatic();
</script>

<%in p/footer.cgi %>
