#!/usr/bin/haserl
<%in p/common.cgi %>

<%
params="address dhcp gateway hostname nameserver netmask interface wlan_ssid wlan_password"

# -x, so these are the two interfaces and not every name containing them. The
# loose form matched veth0, br-eth0 and eth0.100 as well, and those reach an
# href, a page heading and a setnetwork argument.
network_list="$(ls /sys/class/net | grep -x -e eth0 -e wlan0)"
# Four U-Boot variables, one read of the environment. fw_printenv costs about
# 50 ms on this flash -- it is the single most expensive thing this page does --
# and asking it four separate times was a fifth of a second for nothing. The
# loop forks nothing: `case` on each line.
#
# wlandev is the adapter the firmware loads a driver for and netaddr_fallback
# the address it parks the Ethernet port on while it does. Until this page
# wrote them the only way to set either was a shell (#457).
network_wlan_ssid=""
network_wlan_password=""
network_adapter=""
network_fallback=""
while IFS="=" read -r _k _v; do
	case "$_k" in
		wlanssid) network_wlan_ssid=$_v ;;
		wlanpass) network_wlan_password=$_v ;;
		wlandev) network_adapter=$_v ;;
		netaddr_fallback) network_fallback=$_v ;;
	esac
done <<EOF
$(fw_printenv 2>/dev/null)
EOF

# The adapters THIS firmware can actually bring up.
#
# /etc/wireless/{usb,sdio,modem} name 66 boards between them, and offering all
# 66 asks the owner of a camera to pick their hardware out of a catalogue. It
# is also a catalogue of things that cannot work here: an image ships one or
# two wireless drivers, so nearly every id in those scripts modprobes a module
# that is not on this camera and could only fail.
#
# An entry survives on two conditions. Every module its arm loads has to be
# present under /lib/modules -- exact, not a guess, and what cuts 66 to single
# figures. And where the id names a SoC it has to be this camera's: those
# entries differ only in which pad they raise before the modprobe, and another
# board's pad is another board's wiring. Ids naming no SoC are kept.
#
# NOTHING IS ADDED TO THE IMAGE BY THIS. The scripts are the firmware's own and
# ship on every camera already; this reads them.
#
# Scanned ONCE into a cache, and the scan itself forks nothing per candidate.
# The first cut of this called out to `echo | grep` for every module of every
# id and re-scanned for each caller -- some 800 processes, which took a
# 1 GHz camera 2.9 s to render this page against 0.2 s for its neighbours.
# Everything per-candidate is a `case` on strings now, and the whole page costs
# one find and three awks.
adapter_cache=""
adapter_scan() {
	[ -n "$adapter_cache" ] && return
	local have=" $(find /lib/modules -name '*.ko' 2>/dev/null |
		sed 's|.*/||; s|\.ko$||' | tr '\n' ' ') "
	local bus f id pad tok ms m ok driver
	local TAB=$(printf '\t')
	for bus in usb sdio modem; do
		f="/etc/wireless/$bus"
		[ -r "$f" ] || continue
		# One pass: the id, the pad it raises first, the SoC its name claims,
		# and every module it loads. Doing the name-splitting here keeps the
		# shell loop below free of subshells.
		while IFS="$TAB" read -r id pad tok ms; do
			[ -n "$id" ] || continue
			ok=1
			driver=""
			for m in $ms; do
				case "$have" in *" $m "*) ;; *) ok="" ;; esac
				# mac80211 and cfg80211 are the 802.11 stack, not a device
				# driver: an arm loading only those brings nothing up.
				# /etc/wireless/usb has one -- mt7601u-t31-camhi modprobes
				# mac80211 and stops, on images carrying no mt7601u at all --
				# and offering it is offering a failure.
				case "$m" in mac80211|cfg80211|rfkill) ;; *) driver="$m" ;; esac
			done
			[ -n "$ok" ] && [ -n "$driver" ] || continue
			if [ "$tok" != "-" ]; then
				case "$soc" in
					"$tok"*) ;;
					*) case "$tok" in "$soc"*) ;; *) continue ;; esac ;;
				esac
			fi
			adapter_cache="${adapter_cache}${bus}${TAB}${driver}${TAB}${id}${TAB}${pad}
"
		done <<EOF
$(awk '
	/^if \[ "\$1" = "/ { split($0, a, "\""); id = a[4]; mods = ""; pad = "-"; next }
	id != "" && /set_gpio/ {
		if (pad == "-") { n = split($0, g, /[ \t]+/); for (k = 1; k < n; k++) if (g[k] == "set_gpio") pad = g[k + 1] }
	}
	id != "" && /modprobe/ {
		m = $0; sub(/.*modprobe[ \t]+/, "", m); sub(/[ \t].*/, "", m); mods = mods " " m
	}
	id != "" && /^fi/ {
		tok = "-"
		n = split(id, part, "-")
		for (k = 1; k <= n; k++)
			if (part[k] ~ /^(t[0-9]+|hi[0-9]{4}[a-z0-9]*|gk[0-9]{4}[a-z0-9]*|ssc[0-9]{3}[a-z0-9]*)$/) tok = part[k]
		print id "\t" pad "\t" tok "\t" mods
		id = ""
	}
' "$f")
EOF
	done
	# A scan that finds nothing must not re-run on every later call.
	[ -n "$adapter_cache" ] || adapter_cache="$TAB$TAB$TAB"
}

# bus, driver, id, pad -- for one bus.
adapter_list() {
	adapter_scan
	printf '%s' "$adapter_cache" | awk -F'\t' -v b="$1" '$1 == b { print $2 "\t" $3 "\t" $4 }'
}

# Just the ids, for the places that only need to know what is legal.
adapter_ids() {
	adapter_list "$1" | cut -f2
}

# The word a person uses for the interface, with the kernel's name kept beside
# it rather than instead of it. Someone setting up a camera thinks "Wi-Fi";
# someone reading a support thread thinks "wlan0", and the two have to be the
# same row on the screen or the page is teaching a private vocabulary.
iface_word() {
	case "$1" in
		eth0) printf 'Ethernet' ;;
		wlan0) printf 'Wi-Fi' ;;
		# Escaped: the two words above are literals, but anything else is a
		# device name on its way into page text, and a kernel interface name
		# may hold characters that are markup here.
		*) esc "$1" ;;
	esac
}

# Will the firmware actually apply this interface's file at boot?
#
# /etc/init.d/S40network branches on one variable and nothing else. With an
# adapter set it loads that driver, `ifup wlan0`, and then puts eth0 on
# `ifconfig eth0 ${netaddr_fallback:-192.168.2.10}` -- a static address with no
# gateway, and NOT `ifup eth0`, so /etc/network/interfaces.d/eth0 is never
# read. With no adapter set it is the other way round: `ifup eth0`, and no
# wireless driver is ever loaded so wlan0 does not exist at all.
#
# The page has to know this or it lies twice: it offers a form whose file
# nothing will open, and it raises a restart banner for a difference no
# restart can resolve.
# Is the configured adapter a cellular modem rather than Wi-Fi? Asked of the
# script itself rather than of the filtered list, so the answer holds for an id
# this image has no driver for -- which is exactly the camera whose owner needs
# to be told the truth about it.
adapter_is_modem() {
	[ -n "$network_adapter" ] || return 1
	grep -qF "\"$network_adapter\"" /etc/wireless/modem 2>/dev/null
}

iface_is_booted() {
	if [ -z "$network_adapter" ]; then
		[ "$1" = "eth0" ]
		return
	fi
	# set_wireless tries usb, then sdio, then modem. A modem takes the third
	# arm, which runs `ifup usb0` and `ifup eth1` -- wlan0 is never brought up
	# at all, and eth0 still gets the fixed address. So on a modem camera
	# NEITHER of the two interfaces this page edits comes up from its file, and
	# saying wlan0 does would promise a restart that changes nothing.
	adapter_is_modem && return 1
	[ "$1" = "wlan0" ]
}

# The interface the camera is on. The default route names it when there is
# one and it is one of the two edited here; a route through a tunnel or a
# modem must not point the form at a file it cannot show. Without one -- a
# static setup with no gateway, which is what a save on this page can
# produce -- it is the interface the firmware's boot script brought up from
# its file, which is also the only file a restart will read.
now_iface=""
for i in $network_list; do
	[ "$i" = "$network_interface" ] && now_iface=$i
done
if [ -z "$now_iface" ]; then
	if [ -n "$network_adapter" ] && echo "$network_list" | grep -qx wlan0; then
		now_iface=wlan0
	else
		now_iface=eth0
	fi
fi

# The interface the page is ABOUT -- which is a different question, and
# conflating the two is the fault this page was reported for. The select used
# to name only the file a save would land in, while every field on the form
# went on showing the interface the camera happened to be using: picking
# wlan0 on a camera plugged into Ethernet and pressing Save wrote eth0's
# address into wlan0's file, said nothing about when it would take effect,
# and had reverted to eth0 by the next page load (#458).
#
# Now it is a tab strip, the whole page follows it, and the only thing the
# form carries is which interface it is editing. `?iface=` is honoured only
# for an interface this camera actually has: it reaches awk and setnetwork
# arguments below, and it comes from the query string.
edit_iface=""
for i in $network_list; do
	[ "$i" = "${POST_network_interface:-$GET_iface}" ] && edit_iface=$i
done
[ -z "$edit_iface" ] && edit_iface=$now_iface

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
	# This interface's own hardware address. sysinfo's network_macaddr is the
	# DEFAULT ROUTE's, which is a different interface as soon as there are two
	# -- the eth0 tab was printing wlan0's address under eth0's name.
	now_macaddr=$(cat "/sys/class/net/$1/address" 2>/dev/null)
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
	# /etc/resolv.conf is the camera's, not this interface's. Reported beside
	# three empty boxes on an interface that is not up, it read as a resolver
	# eth0 had been given -- so it is shown only where there is a connection
	# for it to belong to.
	now_nameserver=""
	[ -n "$now_address" ] && now_nameserver=$(awk '$1 == "nameserver" { print $2; exit }' /etc/resolv.conf 2>/dev/null)
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
#
# An interface the boot script will not read is never pending, however far its
# file has drifted: on a camera with an adapter set, eth0's file says DHCP for
# ever while the kernel holds the static fallback, and judging that difference
# raised a restart banner that no restart could clear.
net_pending() {
	iface_is_booted "$1" || return 1
	[ -n "$cfg_mode" ] || return 1
	[ "$cfg_mode" = "$now_mode" ] || return 0
	if [ "$cfg_mode" = "static" ]; then
		[ "$cfg_address" = "$now_address" ] || return 0
		[ "$cfg_netmask" = "$now_netmask" ] || return 0
		[ "$cfg_gateway" = "$now_gateway" ] || return 0
		[ "$cfg_nameserver" = "$now_nameserver" ] || return 0
	fi
	if [ "$1" = "wlan0" ] && [ -n "$now_ssid" ] && command -v wpa_passphrase >/dev/null; then
		[ "$network_wlan_ssid" = "$now_ssid" ] || return 0
		local psk=$(wpa_passphrase "$network_wlan_ssid" "$network_wlan_password" 2>/dev/null | sed -n 's/^[[:space:]]*psk=//p')
		[ "$psk" = "$now_psk" ] || return 0
	fi
	return 1
}

# The banner is a statement about the CAMERA, so it asks every interface and
# not just the one on screen -- otherwise a save made on one tab stopped
# announcing itself the moment you looked at the other. The loop leaves the
# readings on the edited interface, which is what the rest of the page draws.
any_pending=""
for i in $network_list; do
	net_read "$i"
	net_pending "$i" && any_pending=1
done
net_read "$edit_iface"

if [ "$REQUEST_METHOD" = "POST" ]; then
	case "$POST_action" in
		changemac)
			# Which addresses are usable is the firmware's call, not this
			# page's. Shape is all a regex can check, and the camera refuses
			# more than that -- the bootloader placeholders it repairs at boot,
			# a multicast address, the all-zero one. Accepting any of those
			# here reported success, asked for a reboot, and brought the camera
			# back on a different address than the one that was typed, because
			# the boot-time repair had replaced it.
			#
			# So it asks the applet that owns the rule and reports what it
			# says. Empty is answered first: called with no address, set_mac
			# mints a fresh random one, which is not what an empty field means.
			#
			# The reflected value is escaped. The flash message is rendered as
			# HTML by notice(), and this is the one handler that echoes a POST
			# field back into it.
			mac_shown=$(esc "$POST_mac_address" | tr -d '\r\n')

			if [ -z "$POST_mac_address" ]; then
				redirect_back "warning" "Empty MAC address."
			elif command -v set_mac >/dev/null 2>&1; then
				# stderr only -- the applet prints the address it stored on stdout.
				if mac_err=$(set_mac "$POST_mac_address" 2>&1 >/dev/null); then
					update_caminfo
					touch /tmp/system-reboot
					redirect_back "success" "MAC address updated."
				else
					# The applet's own sentence already names the address,
					# so it is shown as-is rather than with it appended twice.
					mac_err=$(printf '%s' "${mac_err#set_mac: }" | tr -d '\r\n')
					redirect_back "warning" "$(esc "${mac_err:-Invalid MAC address: $POST_mac_address}" | tr -d '\r\n')"
				fi
			elif echo "$POST_mac_address" | grep -Eiq '^([0-9a-f]{2}[:-]){5}([0-9a-f]{2})$'; then
				# Firmware without the applet: shape is all there is to go on.
				fw_setenv ethaddr "$POST_mac_address"
				update_caminfo
				touch /tmp/system-reboot
				redirect_back "success" "MAC address updated."
			else
				redirect_back "warning" "Invalid MAC address: ${mac_shown}"
			fi
			;;

		adapter)
			# The id becomes the argument of a shell script the boot runs as
			# root, so it is accepted only by being one of the ids that script
			# already answers to. Empty is the other legal value and means no
			# wireless adapter at all.
			adapter_ok=""
			[ -z "$POST_network_adapter" ] && adapter_ok=1
			# The value already set counts as legal whatever the filter thinks
			# of it. adapter_ids only offers what this image can load, and a
			# camera configured before that filter existed -- or by hand, or by
			# a firmware that shipped another driver -- must be able to save the
			# rest of this card without its adapter being refused or wiped.
			[ -n "$network_adapter" ] && [ "$POST_network_adapter" = "$network_adapter" ] && adapter_ok=1
			for i in $(adapter_ids usb; adapter_ids sdio; adapter_ids modem); do
				[ "$i" = "$POST_network_adapter" ] && adapter_ok=1
			done
			[ -z "$adapter_ok" ] && set_error_flag "Unknown wireless adapter: $(esc "$POST_network_adapter")"

			# Every octet 0-255. Four groups of up to three digits also
			# describes 999.999.999.999, which would reach fw_setenv and leave
			# the Ethernet port with no usable address after a restart -- on a
			# camera whose Wi-Fi is the only other way in.
			if [ -n "$POST_network_fallback" ] &&
				! echo "$POST_network_fallback" | grep -Eq '^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$'; then
				set_error_flag "Ethernet fallback address is not an IPv4 address: $(esc "$POST_network_fallback")"
			fi

			if [ -z "$error" ]; then
				# fw_setenv with no value deletes the variable, which is what
				# an empty choice has to mean: the boot script tests
				# `[ -n "$dev" ]`, so a variable set to the empty string and
				# one that is absent behave alike there, but only the absent
				# one leaves the environment as a camera without an adapter
				# has it.
				# fw_setenv writes flash and can fail -- a full or bad-block
				# environment sector, a read-only mount. Reporting a save that
				# did not happen is bad here in a particular way: the answer it
				# gives is "restart the camera", and a camera restarted onto an
				# adapter that was never stored comes back somewhere its owner
				# may not be able to reach.
				#
				# The second write is guarded by the first: wlandev alone
				# decides whether there is Wi-Fi at all, so if the fallback
				# address cannot be stored the adapter is put back rather than
				# left set with an unknown Ethernet address beside it.
				if [ -n "$POST_network_adapter" ]; then
					out=$(fw_setenv wlandev "$POST_network_adapter" 2>&1)
				else
					out=$(fw_setenv wlandev 2>&1)
				fi
				if [ $? -ne 0 ]; then
					redirect_back "danger" "The wireless adapter was not saved: $(esc "$out")"
				fi

				if [ -n "$POST_network_fallback" ]; then
					out=$(fw_setenv netaddr_fallback "$POST_network_fallback" 2>&1)
				else
					out=$(fw_setenv netaddr_fallback 2>&1)
				fi
				if [ $? -ne 0 ]; then
					if [ -n "$network_adapter" ]; then
						fw_setenv wlandev "$network_adapter" 2>/dev/null
					else
						fw_setenv wlandev 2>/dev/null
					fi
					redirect_back "danger" "The Ethernet fallback address was not saved, so the adapter was left as it was: $(esc "$out")"
				fi

				update_caminfo
				touch /tmp/system-reboot
				redirect_to "network.cgi" "success" \
					"Wireless adapter saved. It takes effect when the camera restarts."
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
			#
			# Every path below is written out in full rather than built from a
			# variable. This runs as root on a camera, and `rm -f "$d"/*` is
			# one edit that empties $d away from `rm -f /*` -- a saving of
			# nothing against a blast radius of everything.
			rm -rf /etc/network/interfaces.d.new
			if ! out=$({ mkdir /etc/network/interfaces.d.new &&
				cp -f /rom/etc/network/interfaces.d/* /etc/network/interfaces.d.new/; } 2>&1); then
				rm -rf /etc/network/interfaces.d.new
				redirect_back "danger" "Network configuration was not reset: $(esc "$out")"
			fi
			rm -f /etc/network/interfaces.d/*
			mv /etc/network/interfaces.d.new/* /etc/network/interfaces.d/ &&
				rmdir /etc/network/interfaces.d.new
			net_read "$edit_iface"
			msg="Network configuration reset to the firmware's."
			net_pending "$edit_iface" && msg="$msg It takes effect when the camera restarts."
			redirect_back "success" "$msg"
			;;

		update)
			for p in $params; do
				eval network_${p}=\$POST_network_${p}
			done

			# Not the select's value any more but the tab that was open, and
			# it has already been held to the interfaces this camera has.
			network_interface=$edit_iface

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
				# An argument list, not a command line handed to eval.
				#
				# These are the values an operator typed, and a passphrase is
				# entitled to contain a space, a quote or a dollar sign. The
				# lines this replaced pasted each one into a string that was
				# then eval'd, so the shell parsed the operator's input as
				# shell: `my camera` reached setnetwork as -h my with a stray
				# word after it and the page still reported the save as done,
				# a quote or an apostrophe anywhere ended the save with a raw
				# "unterminated quoted string" on screen, and a semicolon ran
				# what followed it (#547).
				#
				# setnetwork was never the problem -- it reads getopts, so it
				# has always taken its values as separate arguments. It just
				# had no way to receive them as separate arguments while the
				# caller was building one string. Nothing here needs quoting
				# rules now: "$@" carries each value whole, whatever is in it.
				set -- -i "$network_interface" -m "$network_mode" -h "$network_hostname"

				if [ "$network_interface" = "wlan0" ]; then
					set -- "$@" -s "$network_wlan_ssid" -p "$network_wlan_password"
				fi

				if [ "$network_mode" != "dhcp" ]; then
					set -- "$@" -a "$network_address" -n "$network_netmask"
					[ -n "$network_gateway" ] && set -- "$@" -g "$network_gateway"
					[ -n "$network_nameserver" ] && set -- "$@" -d "$network_nameserver"
				fi

				# What was asked for, for the Diagnostics dump -- rendered
				# separately from the arguments actually passed, and with the
				# wireless passphrase held back. The line this replaced echoed
				# the command it was about to eval, so /tmp/webui.log kept the
				# WiFi password of every camera it had ever been set on, in
				# clear, for anyone who could read a log. Both notification
				# senders stopped echoing their curl line for that same reason.
				log_line="setnetwork"
				log_hide=
				for log_arg in "$@"; do
					if [ -n "$log_hide" ]; then
						log_line="$log_line ********"
						log_hide=
						continue
					fi
					[ "$log_arg" = "-p" ] && log_hide=1
					log_line="$log_line $(shq "$log_arg")"
				done
				printf '%s\n' "$log_line" >> /tmp/webui.log

				# setnetwork refuses on its own checks and says why on stdout;
				# its status used to be dropped, so a refused save was
				# reported as a save.
				if ! out=$(setnetwork "$@" 2>&1); then
					redirect_back "danger" "Network settings were not saved: $(esc "$out")"
				fi

				update_caminfo

				# $edit_iface, not $network_interface. update_caminfo above
				# RE-ASSIGNS network_interface to whichever interface carries
				# the default route -- so on a camera saving the other one,
				# everything below here was judging and naming the wrong
				# interface, and the redirect landed on the wrong tab. It
				# reported a wlan0 verdict for an eth0 save and called it
				# eth0's. edit_iface is the interface this POST was for and
				# nothing touches it.
				#
				# What the save is worth, judged for the interface that was
				# SAVED -- which the page can now always do, because it reads
				# that interface. It used to be asked only when the save
				# happened to target the interface the camera was using, so
				# saving the other one reported a bare "Network settings
				# saved." that reads as applied.
				net_read "$edit_iface"
				msg="Network settings saved."
				if ! iface_is_booted "$edit_iface"; then
					msg="$msg They are stored, but the camera does not bring $(iface_word "$edit_iface") up from this file."
				elif net_pending "$edit_iface"; then
					msg="$msg They take effect when the camera restarts."
				fi
				redirect_to "network.cgi?iface=${edit_iface}" "success" "$msg"
			fi
			;;
	esac
fi

# The header reads network_gateway for its no-default-route banner, and that
# is a statement about the kernel; so the banner it does draw for the pending
# save is asked for by name, and the form's variables are filled in below it.
[ -n "$any_pending" ] && restart_pending=1

# This page draws its own title, because the interface switcher sits on the
# same line as it. Without this the header prints one too and the page opens
# with the word Network twice -- the same opt-out camera.cgi, dashboard.cgi
# and recordings.cgi take for the same reason.
hide_title=1
%>
<%in p/header.cgi %>

<%
# The fields carry the file. Under Automatic the address fields show the lease
# in use rather than nothing: it is the answer to "what did the router give
# me", and it is the starting point for switching to Manual, which is what
# most people mean to do when they pin an address. A save the checks above
# refused falls through to here with the posted values still in the
# variables, and they stay: the page is showing the person their own attempt
# beside what was wrong with it.
if [ -z "$error" ]; then
	network_interface=$edit_iface
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

<div class="mj-net-head">
	<h2 class="mj-page-title">Network</h2>
	<%# One interface is not a choice, so the switcher only appears where there
	    is something to switch between. Links rather than a select: switching
	    redraws the whole page for that interface, and a control that navigates
	    is reachable without script. %>
	<% if [ "$(echo "$network_list" | wc -w)" -gt 1 ]; then %>
	<div class="mj-seg" role="group" aria-label="Interface">
		<% for i in $network_list; do %>
		<a class="mj-seg-lbl<% [ "$i" = "$edit_iface" ] && printf ' active' %>" href="?iface=<% attr_escape "$i" %>"><% iface_word "$i" %></a>
		<% done %>
	</div>
	<% fi %>
</div>

<% if ! iface_is_booted "$edit_iface"; then %>
	<% if adapter_is_modem; then %>
	<% notice warn "<b>The camera does not bring $(iface_word "$edit_iface") up from this file.</b> A cellular modem is the configured adapter, so the firmware brings up <code>usb0</code>/<code>eth1</code> instead &mdash; which this page does not edit &mdash; and puts the Ethernet port on a fixed address (<code>$(esc "${network_fallback:-192.168.2.10}")</code>). What you save here applies if the adapter is cleared." %>
	<% elif [ -n "$network_adapter" ]; then %>
	<% notice warn "<b>The camera does not bring $(iface_word "$edit_iface") up from this file.</b> While a wireless adapter is set, the firmware puts the Ethernet port on a fixed address (<code>$(esc "${network_fallback:-192.168.2.10}")</code>) and never reads this interface's file. What you save here applies if the adapter is cleared." %>
	<% else %>
	<% notice warn "<b>The camera does not bring $(iface_word "$edit_iface") up from this file.</b> No wireless adapter is set, so no driver is loaded for it. What you save here applies once one is chosen under <b>Wireless adapter</b>." %>
	<% fi %>
<% fi %>

<%# The nine-row table this replaces answered one question -- what is this
    camera on -- and made you read all nine to find it. One line, the values
    that identify the camera on the right in the face addresses are legible
    in, and the rest is below in the controls that set it. %>
<div class="mj-status<% [ -z "$now_address" ] && printf ' mj-status-off' %>">
	<span class="mj-status-ico">
		<% if [ "$edit_iface" = "wlan0" ]; then %>
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1"/></svg>
		<% else %>
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="14" width="20" height="7" rx="1.5"/><path d="M6.5 17.5h.01"/><path d="M10 17.5h.01"/><path d="M12 14V9"/><path d="M7 9h10"/><path d="M7 9V6.5"/><path d="M17 9V6.5"/></svg>
		<% fi %>
	</span>
	<span class="mj-status-txt">
		<%# The headline is what IDENTIFIES this connection, and on a wired
		    interface that is not its name -- the switcher printed that word one
		    line above, and printing it again gave the eth0 tab "Ethernet" twice
		    in three lines. A network name where there is one, the state where
		    there is not; the interface word then appears once, in the line
		    underneath, where it is describing rather than repeating. %>
		<b><% if [ -n "$now_ssid" ] && [ "$edit_iface" = "wlan0" ]; then
				esc "$now_ssid"
			elif [ -n "$now_address" ]; then
				printf 'Connected'
			else
				printf 'Not connected'
			fi %></b>
		<span><%
			printf '%s' "$(iface_word "$edit_iface")"
			if [ -z "$now_address" ]; then
				[ "$edit_iface" != "$now_iface" ] && printf ' &middot; the camera is on %s' "$(iface_word "$now_iface")"
			elif [ "$now_mode" = "dhcp" ]; then
				printf ' &middot; address from DHCP'
			else
				printf ' &middot; fixed address'
			fi
		%></span>
	</span>
	<span class="mj-status-val">
		<b><% esc "${now_address:-—}" %></b>
		<%# Nothing rather than sysinfo's, which is the DEFAULT ROUTE's address:
		    falling back to it would put the other interface's MAC under this
		    one's name, which is the error this reading exists to avoid. %>
		<span><% esc "${now_macaddr:-—}" %></span>
	</span>
</div>

<%# The form's cards are dealt into equal columns sized to how many there are
    -- three on a wireless interface, two on a wired one -- so the row fills
    rather than leaving one card alone on a second line with a hole beside it.
    h-100 makes them equal height, which is what stops a short card and a tall
    one reading as a mistake. %>
<% if [ "$edit_iface" = "wlan0" ]; then card_col="col-12 col-lg-4"; else card_col="col-12 col-lg-6"; fi %>
<form action="<%= $SCRIPT_NAME %>" method="post">
	<% field_hidden "action" "update" %>
	<% field_hidden "network_interface" "$edit_iface" %>
	<div class="row g-4">

	<% if [ "$edit_iface" = "wlan0" ]; then %>
	<div class="<%= $card_col %>">
	<div class="card h-100"><div class="card-body">
		<% card_head "Wi-Fi network" "wlan0" %>
		<div id="wifi-section">
			<% field_text "network_wlan_ssid" "Network name" %>
			<div class="mj-inline-act">
				<button type="button" class="btn btn-sm btn-outline-secondary" id="wifi-scan">Scan</button>
				<span id="wifi-scan-status" class="small text-secondary"></span>
			</div>
			<select id="wifi-results" class="form-select form-select-sm d-none"></select>
			<% field_password "network_wlan_password" "Password" %>
		</div>
	</div></div>
	</div>
	<% fi %>

	<div class="<%= $card_col %>">
	<div class="card h-100"><div class="card-body">
		<% card_head "IP address" "$([ "$(echo "$network_list" | wc -w)" -gt 1 ] && attr_escape "$edit_iface")" %>
		<%# A segmented pair of radios rather than a switch labelled "Use DHCP":
		    the two states have names, and naming them is what stops the reader
		    working out what the off position of a switch means. Radios so the
		    control still posts, and still works, with no script. %>
		<div class="mj-seg" role="group" aria-label="How the address is set">
			<input type="radio" class="mj-seg-in" name="network_dhcp" id="network_dhcp_auto" value="true"<% [ "$network_dhcp" = "true" ] && printf ' checked' %>>
			<label class="mj-seg-lbl" for="network_dhcp_auto">Automatic</label>
			<input type="radio" class="mj-seg-in" name="network_dhcp" id="network_dhcp_manual" value="false"<% [ "$network_dhcp" != "true" ] && printf ' checked' %>>
			<label class="mj-seg-lbl" for="network_dhcp_manual">Manual</label>
		</div>
		<div class="mj-ip-grid">
			<% field_text "network_address" "Address" %>
			<% field_text "network_netmask" "Subnet mask" %>
			<% field_text "network_gateway" "Router" %>
			<% field_text "network_nameserver" "DNS" %>
		</div>
		<%# Emitted only in Automatic. It used to render always and be hidden by
		    toggleStatic(), so a statically configured camera whose script did
		    not load told its owner that the address they had typed was set by
		    the router. network.js still toggles it; this decides the state the
		    page ARRIVES in. %>
		<% if [ "$network_dhcp" = "true" ]; then %>
		<p class="mj-card-note" id="ip-auto-note">Set by the router. Choose Manual to enter them yourself.</p>
		<% fi %>
	</div></div>
	</div>

	<div class="<%= $card_col %>">
	<div class="card h-100"><div class="card-body">
		<% card_head "Camera" %>
		<% field_text "network_hostname" "Name" "What this camera calls itself on the network." %>
	</div></div>
	</div>

	<div class="col-12 mj-save"><% button_submit %></div>
	</div>
</form>

<div class="row g-4 mt-0">
<div class="col-12 col-lg-6">
<div class="card h-100" id="adapter"><div class="card-body">
	<% card_head "Wireless adapter" "$([ -n "$network_adapter" ] && echo on || echo off)" %>
	<p class="mj-card-note">Whether this camera has Wi-Fi at all. The firmware loads the driver named here at boot and brings <code>wlan0</code> up. Only adapters this firmware carries a driver for are listed &mdash; an image ships one or two. <span class="text-danger">Requires a reboot.</span></p>
	<form action="<%= $SCRIPT_NAME %>" method="post">
		<% field_hidden "action" "adapter" %>
		<%# mj-wide because .select .mj-ctl-in caps at 16rem and these ids do not
			    fit in it: "rtl8188fu-generic &mdash; no power-up pad" came out as
			    "rtl8188fu-generic - no po". A <select> does not wrap, it clips. %>
			<p class="select mj-wide mj-row" id="network_adapter_wrap">
			<label for="network_adapter" class="form-label">Adapter</label>
			<span class="mj-ctl"><span class="mj-ctl-in">
			<select class="form-select" id="network_adapter" name="network_adapter">
				<%# The whole list is emitted by ONE awk, escaping included.
				    Built a row at a time it cost about forty processes -- an
				    attr_escape sed per option, and the candidate list re-run
				    per group -- which on a 1 GHz camera is most of a second on
				    a page that is already the slowest in the UI. Nothing here
				    is data this repo ships: it is /etc/wireless/{usb,sdio,
				    modem}, the firmware's own scripts, read at render time.

				    Grouped by DRIVER rather than by bus, because that is the
				    honest shape of the choice. An image carries one or two
				    wireless drivers; the entries under each are that same
				    driver with a different board's power-up pad raised first,
				    and listing them flat read as seven drivers on a camera
				    that has one. The pad is printed because it is the entire
				    difference between the rows, and a dongle that never powers
				    up is the symptom that sends somebody here. %>
				<% adapter_scan %>
				<% printf '%s' "$adapter_cache" | awk -F'\t' -v cur="$network_adapter" '
					function e(x) {
						gsub(/&/, "\\&amp;", x); gsub(/</, "\\&lt;", x)
						gsub(/>/, "\\&gt;", x); gsub(/"/, "\\&quot;", x)
						return x
					}
					function opt(id, pad, quiet,   sel, tail) {
						sel = (id == cur) ? " selected" : ""
						# Short because the row has to fit the control: on a
						# 390px phone the longest option missed by seven pixels,
						# and a <select> does not wrap, it clips. The group
						# heading above already says these rows are the board
						# variants of one driver, so the pad number alone is the
						# whole of what separates them.
						#
						# No apostrophes in here. This is an awk program inside
						# a shell single-quoted string, so one closes the string
						# and hands the rest of the program to the shell.
						tail = quiet ? "" \
							: (pad == "-" || pad == "") ? " &mdash; no pad" \
							: " &mdash; pad " e(pad)
						printf "<option value=\"%s\"%s>%s%s</option>\n", e(id), sel, e(id), tail
					}
					$3 == "" { next }
					{
						if ($3 == cur) seen = 1
						if ($1 == "modem") { mo[++mn] = $3 "\t" $4; next }
						if (!(($2) in first)) { first[$2] = ++dn; drv[dn] = $2 }
						k = first[$2]
						rows[k] = rows[k] $3 "\t" $4 "\n"
					}
					END {
						printf "<option value=\"\"%s>None &mdash; wired Ethernet only</option>\n", \
							(cur == "" ? " selected" : "")
						if (cur != "" && !seen)
							printf "<option value=\"%s\" selected>%s &mdash; set on this camera, no driver for it in this firmware</option>\n", e(cur), e(cur)
						for (i = 1; i <= dn; i++) {
							printf "<optgroup label=\"Wi-Fi &mdash; driver %s\">\n", e(drv[i])
							n = split(rows[i], line, "\n")
							for (j = 1; j <= n; j++) {
								if (line[j] == "") continue
								split(line[j], f, "\t"); opt(f[1], f[2])
							}
							print "</optgroup>"
						}
						if (mn) {
							print "<optgroup label=\"Cellular modem &mdash; brings up usb0/eth1, not wlan0\">"
							for (i = 1; i <= mn; i++) { split(mo[i], f, "\t"); opt(f[1], "-", 1) }
							print "</optgroup>"
						}
					}
				' %>
			</select>
			</span></span>
			<span class="hint text-secondary">Within a Wi-Fi driver, start with the entry that needs no pad. The others are that same driver for boards which hold the dongle powered off until a GPIO pad is raised, and each names the pad &mdash; pick the one named after your board, or try them if your adapter never appears.</span>
		</p>
		<%# Not field_string: the effective address belongs in the box as a
		    placeholder, so an empty field shows what the camera will actually
		    do instead of looking unset. %>
		<p class="string mj-row" id="network_fallback_wrap">
			<label for="network_fallback" class="form-label">Ethernet fallback address</label>
			<span class="mj-ctl"><span class="mj-ctl-in">
			<input type="text" id="network_fallback" name="network_fallback" class="form-control" placeholder="192.168.2.10" value="<% attr_escape "$network_fallback" %>">
			</span></span>
			<span class="hint text-secondary">Used only while a Wi-Fi adapter is set: the Ethernet port is not brought up from its own file then, so it keeps this address and you can always plug in.</span>
		</p>
		<% button_submit "Save radio" "warning" %>
	</form>
</div></div>
</div>

<div class="col-12 col-lg-6">
<details class="mj-advanced">
	<summary>Advanced</summary>
	<div class="row g-4 mt-1">
		<div class="col-12">
			<%# id="mac": the placeholder-MAC banner in p/header.cgi links here, so
			    this is the anchor it lands on. It also carries the generator the
			    banner used to hold -- that helper was only ever reachable from a
			    banner most cameras never raise, on the page nobody looking for
			    the MAC address would find it on. %>
			<div class="card" id="mac"><div class="card-body">
				<% card_head "Change MAC address" %>
				<%# The self-assignment sentence is true only where the firmware can
				    actually do it, so it is gated on that being so rather than
				    asserted for every camera this WebUI runs on. %>
				<% if command -v get_mac >/dev/null 2>&1; then %>
				<p class="small text-secondary">The camera gives itself a stable unique address on first boot and keeps it, so you do not need to set one. This is for overriding that &mdash; to put back the address on the camera's own label, or to separate two cameras that ended up sharing one. <span class="text-danger">Requires a reboot.</span> The camera will most likely come back on a different IP address, because the DHCP server hands out leases by MAC.</p>
				<% else %>
				<p class="small text-secondary">Override the Ethernet MAC address &mdash; to put back the address on the camera's own label, or to separate two cameras that ended up sharing one. <span class="text-danger">Requires a reboot.</span> The camera will most likely come back on a different IP address, because the DHCP server hands out leases by MAC.</p>
				<% fi %>
				<form action="<%= $SCRIPT_NAME %>" method="post">
					<% field_hidden "action" "changemac" %>
					<% field_string "mac_address" "MAC address" "$network_macaddr" %>
					<p class="small mb-3"><a href="#" id="generate-mac-address">Or generate a random one</a></p>
					<% button_submit "Update MAC" "danger" %>
				</form>
				<hr class="my-3">
				<% group_head "Reset network configuration" %>
				<p class="mj-card-note">Restore the config bundled with the firmware. All changes are lost.</p>
				<form action="<%= $SCRIPT_NAME %>" method="post">
					<% field_hidden "action" "reset" %>
					<% button_submit "Reset config" "outline-danger confirm" %>
				</form>
			</div></div>
		</div>

		<div class="col-12">
			<div class="card"><div class="card-body">
				<% card_head "Diagnostics" %>
				<% for dev in $network_list; do %>
					<% ex "cat /etc/network/interfaces.d/$dev" %>
				<% done %>
				<%# The passphrase is masked. This block exists to be copied into a
		    support thread, and wlanpass in clear is the one line in it that
		    must not travel. %>
		<% [ -n "$network_adapter" ] && ex "fw_printenv | grep -e wlan -e netaddr | sed 's/^wlanpass=.*/wlanpass=<hidden>/'" %>
				<% ex "ifconfig" %>
			</div></div>
		</div>
	</div>
</details>
</div>
</div>

<script src="/a/network.js" defer></script>

<%in p/footer.cgi %>
