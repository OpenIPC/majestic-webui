#!/usr/bin/haserl
<%in p/common.cgi %>

<%
params="address dhcp gateway hostname nameserver netmask interface wlan_ssid wlan_password"

network_list="$(ls /sys/class/net | grep -e eth0 -e wlan0)"
network_wlan_ssid="$(fw_printenv -n wlanssid)"
network_wlan_password="$(fw_printenv -n wlanpass)"

# The interface the camera is on. The default route names it when there is
# one and it is one of the two edited here; a route through a tunnel or a
# modem must not point the form at a file it cannot show. Without one -- a
# static setup with no gateway, which is what a save on this page can
# produce -- it is the interface the firmware's boot script brought up from
# its file, which is also the only file a restart will read: wlan0 when
# U-Boot names a wireless driver, eth0 when it does not. The form edits this
# one's file and the card reports this one's state. The select can point a
# save at the other interface, and what that does at boot is the boot
# script's decision rather than this page's, so nothing here promises when
# such a save takes effect.
now_iface=""
for i in $network_list; do
	[ "$i" = "$network_interface" ] && now_iface=$i
done
if [ -z "$now_iface" ]; then
	if [ -n "$(fw_printenv -n wlandev 2>/dev/null)" ] && echo "$network_list" | grep -qx wlan0; then
		now_iface=wlan0
	else
		now_iface=eth0
	fi
fi

# Two readings, kept apart, because they are only the same thing between a
# restart and the next save. sbin/setnetwork writes
# /etc/network/interfaces.d/<iface> and applies nothing but the hostname; the
# boot script's ifup is what reads the file, so a saved address exists nowhere
# but in that file until the camera restarts. The FORM shows the file, since
# that is what it edits. The CARD shows the kernel, since that is what
# "current connection" means. The form used to be drawn from the kernel too,
# so a static address that had just been saved came back as the DHCP lease
# still in use, and the only place the save was visible was the file dumped
# under Diagnostics (OpenIPC/majestic#311).
net_read() {
	local f="/etc/network/interfaces.d/$1"
	cfg_mode=$(awk '$1 == "iface" { print $4; exit }' "$f" 2>/dev/null)
	cfg_address=$(awk '$1 == "address" { print $2; exit }' "$f" 2>/dev/null)
	cfg_netmask=$(awk '$1 == "netmask" { print $2; exit }' "$f" 2>/dev/null)
	cfg_gateway=$(awk '$1 == "gateway" { print $2; exit }' "$f" 2>/dev/null)
	# The resolver is a pre-up line that writes /tmp/resolv.conf. That
	# spelling is setnetwork's, and this is its only reader.
	cfg_nameserver=$(awk '$1 == "pre-up" && $2 == "echo" && $3 == "nameserver" { print $4; exit }' "$f" 2>/dev/null)

	# Empty here is an absence, not a failed reading: the tools are busybox's
	# own, and an interface with no address, no route or no resolver is a
	# fact about it that the file may well disagree with.
	local inet=$(ifconfig "$1" 2>/dev/null | sed -n 's/.*inet addr:\([^ ]*\).*Mask:\([^ ]*\).*/\1 \2/p')
	now_address=${inet% *}
	now_netmask=${inet#* }
	now_gateway=$(ip -4 route 2>/dev/null | awk -v i="$1" '
		$1 == "default" {
			gw = ""; dev = ""
			for (n = 2; n <= NF; n++) {
				if ($n == "via") gw = $(n + 1)
				if ($n == "dev") dev = $(n + 1)
			}
			if (dev == i && gw != "") { print gw; exit }
		}')
	now_nameserver=$(awk '$1 == "nameserver" { print $2; exit }' /etc/resolv.conf 2>/dev/null)
	# A live udhcpc for the interface is what being on DHCP means; ifup
	# leaves its pid where ifdown will look for it. An address with no
	# udhcpc behind it is static. No address at all is neither, and the card
	# says so rather than picking one.
	local pid=$(cat "/var/run/udhcpc.$1.pid" 2>/dev/null)
	if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
		now_mode=dhcp
	elif [ -n "$now_address" ]; then
		now_mode=static
	else
		now_mode=""
	fi
	# The wireless network in use is the one wpa_supplicant was started
	# with: the pre-up wrote it from the U-Boot variables of that moment,
	# and a later save changes the variables and nothing else.
	now_ssid=$(sed -n 's/^[[:space:]]*ssid="\(.*\)"$/\1/p' /tmp/wpa_supplicant.conf 2>/dev/null | head -n1)
	now_psk=$(sed -n 's/^[[:space:]]*psk=\([0-9a-f]*\)$/\1/p' /tmp/wpa_supplicant.conf 2>/dev/null | head -n1)
}

# True while the file says something the kernel is not doing. Judged from the
# two readings every time rather than flagged at save time, so it clears
# itself on a restart, on a save that puts things back, and for a file edited
# by hand -- a flag left in /tmp would say "waiting for a restart" about a
# change that had since been undone.
net_pending() {
	[ -n "$cfg_mode" ] || return 1
	[ "$cfg_mode" = "$now_mode" ] || return 0
	if [ "$cfg_mode" = "static" ]; then
		[ "$cfg_address" = "$now_address" ] || return 0
		[ "$cfg_netmask" = "$now_netmask" ] || return 0
		[ "$cfg_gateway" = "$now_gateway" ] || return 0
		[ "$cfg_nameserver" = "$now_nameserver" ] || return 0
	fi
	if [ "$now_iface" = "wlan0" ] && [ -n "$now_ssid" ] && command -v wpa_passphrase >/dev/null; then
		[ "$network_wlan_ssid" = "$now_ssid" ] || return 0
		local psk=$(wpa_passphrase "$network_wlan_ssid" "$network_wlan_password" 2>/dev/null | sed -n 's/^[[:space:]]*psk=//p')
		[ "$psk" = "$now_psk" ] || return 0
	fi
	return 1
}

net_read "$now_iface"

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
			# The firmware's set is staged beside the directory and swapped in
			# only once every copy succeeded, so a copy that fails -- the
			# overlay full, say -- leaves what was there rather than a camera
			# with no interface file to boot from. Staged rather than copied
			# onto the merged path, because a file the overlay has never
			# copied up is the firmware's own inode showing through, and cp
			# refuses to copy a file onto itself.
			d=/etc/network/interfaces.d
			rm -rf "$d.new"
			if ! out=$({ mkdir "$d.new" && cp -f "/rom$d"/* "$d.new/"; } 2>&1); then
				rm -rf "$d.new"
				redirect_back "danger" "Network configuration was not reset: $(esc "$out")"
			fi
			rm -f "$d"/*
			mv "$d.new"/* "$d/" && rmdir "$d.new"
			net_read "$now_iface"
			msg="Network configuration reset to the firmware's."
			net_pending && msg="$msg It takes effect when the camera restarts."
			redirect_back "success" "$msg"
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
				# setnetwork refuses on its own checks and says why on stdout;
				# its status used to be dropped, so a refused save was
				# reported as a save.
				if ! out=$(eval "$command" 2>&1); then
					redirect_back "danger" "Network settings were not saved: $(esc "$out")"
				fi

				update_caminfo
				msg="Network settings saved."
				if [ "$network_interface" = "$now_iface" ]; then
					net_read "$now_iface"
					net_pending && msg="$msg They take effect when the camera restarts."
				fi
				redirect_back "success" "$msg"
			fi
			;;
	esac
fi

# The header reads network_gateway for its no-default-route banner, and that
# is a statement about the kernel; so the banner it does draw for the pending
# save is asked for by name, and the form's variables are filled in below it.
net_pending && restart_pending=1
%>
<%in p/header.cgi %>

<%
# The fields carry the file. On DHCP the static fields are hidden, and what
# they hold is the starting point for turning the switch off: the lease in
# use, which is what most people mean to pin. A save the checks above
# refused falls through to here with the posted values still in the
# variables, and they stay: the page is showing the person their own
# attempt beside what was wrong with it.
if [ -z "$error" ]; then
	network_interface=$now_iface
	network_dhcp=$([ "$cfg_mode" = "dhcp" ] && echo true)
	if [ "$cfg_mode" = "static" ]; then
		network_address=$cfg_address
		network_netmask=$cfg_netmask
		network_gateway=$cfg_gateway
		network_nameserver=$cfg_nameserver
	else
		network_address=$now_address
		network_netmask=$now_netmask
		network_gateway=$now_gateway
		network_nameserver=$now_nameserver
	fi
fi
%>

<div class="row g-4">
	<div class="col-12 col-lg-7">
		<div class="card"><div class="card-body">
			<% card_head "Network settings" "$([ "$network_dhcp" = "true" ] && echo DHCP || echo static) · $(attr_escape "$network_interface")" %>
			<form action="<%= $SCRIPT_NAME %>" method="post">
				<% field_hidden "action" "update" %>

				<% group_head "General" %>
				<% field_text "network_hostname" "Hostname" %>
				<% field_string "network_interface" "Network interface" "eval" "$network_list" %>

				<div id="wifi-section">
					<% group_head "Wi-Fi" %>
					<% field_text "network_wlan_ssid" "WLAN SSID" %>
					<div class="mb-3">
						<button type="button" class="btn btn-sm btn-outline-secondary" id="wifi-scan">Scan for networks</button>
						<span id="wifi-scan-status" class="small text-secondary ms-2"></span>
						<select id="wifi-results" class="form-select form-select-sm mt-2 d-none"></select>
					</div>
					<% field_password "network_wlan_password" "WLAN Password" %>
				</div>

				<% group_head "IP" %>
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
		<div class="card"><div class="card-body">
			<% card_head "Current connection" %>
			<% if net_pending; then %>
			<p class="small text-secondary">What the camera is on now. The saved settings take effect when it restarts.</p>
			<% fi %>
			<dl class="small list mb-0">
				<dt>Hostname</dt><dd><% esc "$network_hostname" %></dd>
				<dt>Interface</dt><dd><% esc "$now_iface" %></dd>
				<dt>Mode</dt><dd><%= $(case "$now_mode" in dhcp) echo DHCP ;; static) echo Static ;; *) echo "—" ;; esac) %></dd>
				<% if [ "$now_iface" = "wlan0" ] && [ -n "$now_ssid" ]; then %>
				<dt>Wi-Fi</dt><dd><% esc "$now_ssid" %></dd>
				<% fi %>
				<dt>IP</dt><dd><% esc "${now_address:-—}" %></dd>
				<dt>Netmask</dt><dd><% esc "${now_netmask:-—}" %></dd>
				<dt>Gateway</dt><dd><% esc "${now_gateway:-—}" %></dd>
				<dt>DNS</dt><dd><% esc "${now_nameserver:-—}" %></dd>
				<dt>MAC</dt><dd class="text-break"><% esc "$network_macaddr" %></dd>
			</dl>
		</div></div>
	</div>
</div>

<details class="mt-4">
	<summary>Advanced</summary>
	<div class="row g-4 mt-1">
		<div class="col-12 col-lg-6">
			<%# id="mac": the placeholder-MAC banner in p/header.cgi links here, so
			    this is the anchor it lands on. It also carries the generator the
			    banner used to hold -- that helper was only ever reachable from a
			    banner most cameras never raise, on the page nobody looking for
			    the MAC address would find it on. %>
			<div class="card" id="mac"><div class="card-body">
				<% card_head "Change MAC address" %>
				<p class="small text-secondary">Override the Ethernet MAC address. <span class="text-danger">Requires a reboot.</span> The camera will most likely come back on a different IP address, because the DHCP server hands out leases by MAC.</p>
				<form action="<%= $SCRIPT_NAME %>" method="post">
					<% field_hidden "action" "changemac" %>
					<% field_string "mac_address" "MAC address" "$network_macaddr" %>
					<p class="small mb-3"><a href="#" id="generate-mac-address">Generate a valid random one</a></p>
					<% button_submit "Update MAC" "danger" %>
				</form>

				<hr class="my-3">
				<% group_head "Reset network configuration" %>
				<p class="small text-secondary">Restore the config bundled with the firmware. All changes are lost.</p>
				<form action="<%= $SCRIPT_NAME %>" method="post">
					<% field_hidden "action" "reset" %>
					<% button_submit "Reset config" "outline-danger confirm" %>
				</form>
			</div></div>
		</div>

		<div class="col-12 col-lg-6">
			<div class="card"><div class="card-body">
				<% card_head "Diagnostics" %>
				<% for dev in $network_list; do %>
					<% ex "cat /etc/network/interfaces.d/$dev" %>
				<% done %>
				<% [ -n "$(fw_printenv -n wlandev)" ] && ex "fw_printenv | grep wlan" %>
				<% ex "ifconfig" %>
			</div></div>
		</div>
	</div>
</details>

<script src="/a/network.js" defer></script>

<%in p/footer.cgi %>
