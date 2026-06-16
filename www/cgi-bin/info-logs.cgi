#!/usr/bin/haserl
<%in p/common.cgi %>
<%
page_title="Logs"
syslog_defaults=/etc/default/syslogd

if [ "$REQUEST_METHOD" = "POST" ]; then
	size=$POST_syslog_size
	if echo "$size" | grep -qE '^[0-9]+$' && [ "$size" -ge 16 ] && [ "$size" -le 4096 ]; then
		mkdir -p /etc/default
		echo "SYSLOG_SIZE=$size" > "$syslog_defaults"
		/etc/init.d/S01syslogd restart >/dev/null 2>&1
		redirect_to "$SCRIPT_NAME" "success" "Log buffer set to ${size} KiB (existing buffer cleared)."
	else
		redirect_to "$SCRIPT_NAME" "danger" "Invalid buffer size."
	fi
fi

SYSLOG_SIZE=64
[ -r "$syslog_defaults" ] && . "$syslog_defaults"
%>
<%in p/header.cgi %>
<div class="card"><div class="card-body">
	<div class="row g-2 align-items-center mb-3">
		<div class="col-auto">
			<select id="log-source" class="form-select form-select-sm">
				<option value="all">Everything</option>
				<option value="majestic">Majestic</option>
				<option value="kernel">Kernel</option>
			</select>
		</div>
		<div class="col">
			<input id="log-filter" type="text" class="form-control form-control-sm" placeholder="filter…" autocomplete="off">
		</div>
		<div class="col-auto">
			<button id="log-pause" type="button" class="btn btn-sm btn-outline-secondary">⏸ Pause</button>
			<button id="log-clear" type="button" class="btn btn-sm btn-outline-secondary">Clear</button>
			<button id="log-download" type="button" class="btn btn-sm btn-outline-secondary">⬇ Download</button>
			<a href="/cgi-bin/j/dmesg.cgi" target="_blank" class="btn btn-sm btn-outline-secondary" title="Full kernel ring buffer (dmesg)">dmesg</a>
		</div>
	</div>
	<div id="log" class="border rounded bg-body-tertiary"></div>
	<details class="mt-3">
		<summary class="text-secondary small">Log buffer size — currently <%= $SYSLOG_SIZE %> KiB</summary>
		<form action="<%= $SCRIPT_NAME %>" method="post" class="row g-2 align-items-end mt-1" style="max-width:30rem">
			<div class="col">
				<% field_string "syslog_size" "In-RAM syslog buffer (KiB)" "$SYSLOG_SIZE" "64 128 256 512 1024" "More backlog but more RAM. Default 64. Applies immediately and clears the current buffer." %>
			</div>
			<div class="col-auto">
				<% button_submit "Apply" %>
			</div>
		</form>
	</details>
</div></div>
<script src="/a/logs.js"></script>
<%in p/footer.cgi %>
