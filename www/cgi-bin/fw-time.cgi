#!/usr/bin/haserl
<%in p/common.cgi %>
<%
page_title="Time Settings"
tz_data=$(cat /etc/TZ)
tz_name=$(cat /etc/timezone)

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

			rm -f /etc/ntp.conf
			for i in $(seq 0 3); do
				eval ntp="\$POST_server_${i}"
				[ -n "$ntp" ] && echo "server $ntp iburst" >> /etc/ntp.conf
			done
			update_caminfo
			redirect_back "success" "Configuration updated."
			;;
	esac
fi

for i in $(seq 0 3); do
	eval server_${i}=$(sed -n $((i + 1))p /etc/ntp.conf | awk '{print $2}')
done
ntp_summary=$(echo $server_0 $server_1 $server_2 $server_3 | sed 's/ /, /g')
%>

<%in p/header.cgi %>

<div class="row g-4">
	<div class="col-12">
		<div class="card h-100"><div class="card-body">
			<h3>Current</h3>
			<dl class="small list mb-0">
				<dt>Device time</dt><dd id="tz-now">—</dd>
				<dt>Zone name</dt><dd><%= $tz_name %></dd>
				<dt>POSIX string</dt><dd class="text-break"><%= $tz_data %></dd>
				<dt>NTP servers</dt><dd><%= "${ntp_summary:-—}" %></dd>
			</dl>
		</div></div>
	</div>
</div>

<form action="<%= $SCRIPT_NAME %>" method="post">
	<% field_hidden "action" "update" %>
	<div class="row g-4 mt-0">
		<div class="col-12 col-lg-6">
			<div class="card h-100"><div class="card-body">
				<h3>Time zone</h3>
				<datalist id="tz_list"></datalist>
				<p class="string" id="tz_name_wrap">
					<label for="tz_name" class="form-label">Zone name</label>
					<input type="text" id="tz_name" name="tz_name" value="<%= $tz_name %>" class="form-control" list="tz_list">
					<span class="hint text-secondary">Type the name of the nearest large city.</span>
				</p>
				<p class="string" id="tz_data_wrap">
					<label for="tz_data" class="form-label">Zone string</label>
					<input type="text" id="tz_data" name="tz_data" value="<%= $tz_data %>" class="form-control" readonly>
					<span class="hint text-secondary">Control string of the timezone selected above.</span>
				</p>
				<button type="button" class="btn btn-sm btn-outline-secondary" id="frombrowser">Use browser timezone</button>
			</div></div>
		</div>

		<div class="col-12 col-lg-6">
			<div class="card h-100"><div class="card-body">
				<h3>Network time (NTP)</h3>
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
<script src="/a/fw-time.js" defer></script>
<%in p/footer.cgi %>
