#!/usr/bin/haserl
<%in p/common.cgi %>
<%
	page_title="Firmware Update"

	github_ver() {
		[ -z "$network_gateway" ] && return
		fw_soc=$soc
		[ "$soc_vendor" = "ingenic" ] && fw_soc=$soc_family
		builder=$(fw_printenv -n upgrade)
		fw_url="${builder:-https://github.com/openipc/firmware/releases/download/latest/openipc.${fw_soc}-${flash_type}-${fw_variant}.tgz}"
		curl -m5 -ILs "$fw_url" | grep -i last-modified | cut -d' ' -f2-
	}

	ver=$(github_ver)
	# Issue #44: a fresh flash boots with a stale clock so the HTTPS check
	# fails; sync time once (NTP, else HTTP Date header) and retry.
	if [ -z "$ver" ] && [ -n "$network_gateway" ]; then
		synctime
		ver=$(github_ver)
	fi

	if [ -n "$ver" ]; then
		fw_date=$(date -D "%a, %d %b %Y %T GMT" +"$(date +%y | sed 's/.$/.&/').%m.%d" --date "$ver")
	else
		fw_date="<span class=\"text-danger\">- no access to GitHub -</span>"
	fi
	fw_kernel="true"
	fw_rootfs="true"
%>
<%in p/header.cgi %>

<div id="fw-status" class="alert alert-secondary">
	Installed <b><%= $fw_version %></b> &middot; On GitHub <span id="firmware-master-ver"><%= $fw_date %></span>
</div>

<div id="fw-controls">
	<div class="alert alert-warning">The camera stops video and reboots to upgrade. <b>Do not power off</b> during the process.</div>

	<div class="mb-3" style="max-width:32rem">
		<% field_switch "fw_kernel" "Upgrade kernel" "true" %>
		<% field_switch "fw_rootfs" "Upgrade rootfs" "true" %>
		<% field_switch "fw_reset" "Reset config (wipe overlay)" "false" %>
		<% field_switch "fw_force" "Reflash even if the same version" "false" %>
	</div>

	<div class="row row-cols-1 row-cols-md-2 g-4">
		<div class="col">
			<h5>From GitHub</h5>
			<% if [ -n "$ver" ]; then %>
				<button id="fw-install-github" type="button" class="btn btn-warning">Install update from GitHub</button>
			<% else %>
				<p class="text-danger mb-0">Requires access to GitHub.</p>
			<% fi %>
		</div>
		<div class="col">
			<h5>From file</h5>
			<input id="fw-file" type="file" accept=".tgz,.gz" class="form-control mb-2">
			<button id="fw-install-upload" type="button" class="btn btn-warning">Upload &amp; install</button>
		</div>
	</div>
</div>

<div id="fw-progress" style="display:none">
	<pre id="fw-output" class="border rounded p-2 bg-body-tertiary" style="height:60vh;overflow:auto;white-space:pre-wrap;font-size:12px"></pre>
</div>

<script src="/a/fw-update.js"></script>
<%in p/footer.cgi %>
