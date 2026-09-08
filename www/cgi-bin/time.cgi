#!/usr/bin/haserl
<%in p/common.cgi %>
<%
tz_data=$(cat /etc/TZ)
tz_name=$(cat /etc/timezone)

# The firmware's own copy of the stock list. The rootfs is a read-only squashfs
# pivoted to /rom with a jffs2 overlay on top, so this is what /etc/ntp.conf
# reads through to until something writes over it -- and what is still sitting
# there, untouched, on a camera where something has deleted it.
ntp_rom=/rom/etc/ntp.conf

# The hostname of every "server" line, in file order. `awk` on the keyword
# rather than `sed -n <N>p` by line number: a comment or a blank line at the top
# shifted every box down one, so the form offered a comment's second word as a
# hostname and saving the form put it back as one.
ntp_read() {
	[ -f "$1" ] || return 0
	awk '$1 == "server" && $2 != "" { print $2 }' "$1"
}

if [ "$REQUEST_METHOD" = "POST" ]; then
	case "$POST_action" in
		update)
			[ -z "$POST_tz_name" ] && redirect_to "$SCRIPT_NAME" "warning" "Empty timezone name. Skipping."
			[ -z "$POST_tz_data" ] && redirect_to "$SCRIPT_NAME" "warning" "Empty timezone value. Skipping."
			if [ "$tz_data" != "$POST_tz_data" ]; then
				echo "${POST_tz_data}" > /etc/TZ
				touch /tmp/system-reboot
			fi
			if [ "$tz_name" != "$POST_tz_name" ]; then
				echo "${POST_tz_name}" > /etc/timezone
				touch /tmp/system-reboot
			fi

			# Build the list first, and only then go near the file. What this
			# replaced removed /etc/ntp.conf up front and appended the boxes to
			# the live file a line at a time, which failed two ways -- and the
			# second is not repairable from this page.
			#
			# A save with the boxes empty left no file at all. On an overlayfs
			# root, deleting a file that lives in the lower layer does not free
			# anything: it writes a WHITEOUT into the overlay, so the firmware's
			# own /rom/etc/ntp.conf is still there, still perfectly good, and
			# masked for good -- through reboots, and through sysupgrade, which
			# does not touch the overlay. busybox ntpd has no built-in peers and
			# takes them from that file alone, so it exits 1 the moment S49ntpd
			# starts it and the clock is never disciplined again. Found on an
			# ssc30kq + imx335 that had drifted 863 minutes with nothing on this
			# page saying why; the boxes then read back from the file the save had
			# just destroyed, came up empty, and armed the same trap for the
			# next save.
			ntp_new=""
			for i in $(seq 0 3); do
				eval ntp="\$POST_server_${i}"
				[ -n "$ntp" ] && ntp_new="${ntp_new}server ${ntp} iburst
"
			done

			saved_class="success"
			saved_text="Configuration updated."
			if [ -n "$ntp_new" ]; then
				# Written beside the target rather than in /tmp, so `mv` is a
				# rename instead of the truncate-and-copy it falls back to
				# across a filesystem: a reader gets the whole old list or the
				# whole new one, and there is never a moment with no file. The
				# mode goes on before the rename for the same reason -- the
				# CGI's umask is 077 and the firmware ships this file 644.
				if printf '%s' "$ntp_new" > /etc/ntp.conf.new && chmod 644 /etc/ntp.conf.new &&
					mv /etc/ntp.conf.new /etc/ntp.conf; then
					# ntpd reads the file once, at start. Without this the page
					# reports servers the running daemon goes on ignoring until
					# the next reboot -- and on a camera being repaired from the
					# whiteout above there is no daemon running to ignore them.
					#
					# Reported rather than assumed: an image can ship without
					# the init script at all (rubyfpv's tweaksys removes it),
					# and "saved" and "in effect" are not the same claim to
					# make. The list is on the camera either way, so this is a
					# warning about when it starts counting, not a failure.
					if ! { [ -x /etc/init.d/S49ntpd ] && /etc/init.d/S49ntpd restart > /dev/null 2>&1; }; then
						saved_class="warning"
						saved_text="Saved. ntpd could not be restarted, so the new servers take effect at the next boot."
					fi
				else
					rm -f /etc/ntp.conf.new
					saved_class="danger"
					saved_text="Time zone saved, but the NTP server list could not be written."
				fi
			else
				saved_class="warning"
				saved_text="Time zone saved. The NTP servers were left as they were: ntpd has no peers of its own, so an empty list is not a setting, it is a clock that never syncs again."
			fi
			update_caminfo
			redirect_back "$saved_class" "$saved_text"
			;;
	esac
fi

# The summary is what is IN EFFECT, so it reads /etc/ntp.conf and nothing else:
# on a camera with the file deleted it says "—", which is the truth.
ntp_summary=$(ntp_read /etc/ntp.conf | awk '{ printf "%s%s", sep, $0; sep = ", " }')

# The boxes are what there is to EDIT, so where the file is gone they offer the
# firmware's own list instead of nothing -- Save is then the way back out of the
# whiteout, and the banner below is what keeps the two apart on screen.
ntp_missing=""
ntp_src=/etc/ntp.conf
if [ ! -f /etc/ntp.conf ]; then
	ntp_missing=1
	[ -f "$ntp_rom" ] && ntp_src="$ntp_rom"
fi

i=0
for host in $(ntp_read "$ntp_src"); do
	[ "$i" -gt 3 ] && break
	# `\$host`, so eval is handed an assignment rather than the contents of the
	# file: the line this replaced was `eval server_$i=$(...)`, which gave
	# whatever was on that line to the shell to parse as a command.
	eval "server_${i}=\$host"
	i=$((i + 1))
done

# Two different situations wear the same missing file, and promising a repair
# that cannot happen is worse than admitting there is none. Keyed on whether a
# box actually got filled rather than on $ntp_rom existing, because that is the
# thing the reader is about to look at: a /rom copy that is present but carries
# no server line leaves the form just as empty, and Save just as refused.
ntp_warn=""
if [ -n "$ntp_missing" ]; then
	ntp_warn='<b>This camera has no NTP configuration.</b> <code>/etc/ntp.conf</code> is missing, so <code>ntpd</code> exits at every boot and nothing ever corrects the clock &mdash; recordings and log rows carry whatever time the camera drifted to. '
	if [ -n "$server_0" ]; then
		ntp_warn="${ntp_warn}The servers below are the firmware defaults, filled in but not in effect; saving the form writes the file back."
	else
		ntp_warn="${ntp_warn}This image has no copy to restore from either, so nothing could be filled in below: type a server &mdash; <code>0.pool.ntp.org</code> will do &mdash; and save."
	fi
fi
%>

<%in p/header.cgi %>

<% [ -n "$ntp_warn" ] && notice warn "$ntp_warn" %>

<div class="row g-4">
	<div class="col-12">
		<div class="card"><div class="card-body">
			<% card_head "Current" %>
			<dl class="small list mb-0">
				<dt>Device time</dt><dd id="tz-now">—</dd>
				<dt>Zone name</dt><dd><% esc "$tz_name" %></dd>
				<dt>POSIX string</dt><dd class="text-break"><% esc "$tz_data" %></dd>
				<dt>NTP servers</dt><dd><% esc "${ntp_summary:-—}" %></dd>
			</dl>
		</div></div>
	</div>
</div>

<form action="<%= $SCRIPT_NAME %>" method="post">
	<% field_hidden "action" "update" %>
	<div class="row g-4 mt-0">
		<div class="col-12 col-lg-6">
			<div class="card"><div class="card-body">
				<% card_head "Time zone" %>
				<datalist id="tz_list"></datalist>
				<%# hand-written rather than field_string because of the datalist
				    and the readonly mirror, so the row shape is spelled out here
				    to match what the helpers emit %>
				<p class="string mj-row" id="tz_name_wrap">
					<label for="tz_name" class="form-label">Zone name</label>
					<span class="mj-ctl"><span class="mj-ctl-in">
						<input type="text" id="tz_name" name="tz_name" value="<% attr_escape "$tz_name" %>" class="form-control" list="tz_list">
					</span></span>
					<span class="hint text-secondary">Type the name of the nearest large city.</span>
				</p>
				<p class="string mj-row" id="tz_data_wrap">
					<label for="tz_data" class="form-label">Zone string</label>
					<span class="mj-ctl"><span class="mj-ctl-in">
						<input type="text" id="tz_data" name="tz_data" value="<% attr_escape "$tz_data" %>" class="form-control" readonly>
					</span></span>
					<span class="hint text-secondary">Control string of the timezone selected above.</span>
				</p>
				<button type="button" class="btn btn-sm btn-outline-secondary" id="frombrowser">Use browser timezone</button>
			</div></div>
		</div>

		<div class="col-12 col-lg-6">
			<div class="card"><div class="card-body">
				<% card_head "Network time (NTP)" %>
				<% for i in $(seq 0 3); do field_text "server_${i}" "Server $((i + 1))"; done %>
				<div class="my-2 d-flex gap-2 flex-wrap">
					<button type="button" class="btn btn-sm btn-outline-secondary" id="sync-time">Sync now</button>
					<button type="button" class="btn btn-sm btn-outline-secondary" id="set-time">Set from browser</button>
				</div>
				<div id="time-status" class="small text-secondary"></div>
			</div></div>
		</div>
	</div>

	<% button_submit %>
</form>

<details class="mt-4">
	<summary class="text-secondary small">Advanced — raw configuration</summary>
	<div class="mt-3">
		<% ex "cat /etc/timezone" %>
		<% ex "cat /etc/TZ" %>
		<% ex "cat /etc/ntp.conf" %>
	</div>
</details>

<script src="/a/timezone.js"></script>
<script src="/a/time.js" defer></script>
<%in p/footer.cgi %>
