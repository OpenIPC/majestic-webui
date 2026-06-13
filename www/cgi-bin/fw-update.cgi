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
		fw_date=""
	fi
	fw_kernel="true"
	fw_rootfs="true"
%>
<%in p/header.cgi %>

<div class="row g-4">
	<div class="col-12">
		<div class="card h-100"><div class="card-body">
			<h3>Firmware</h3>
			<dl class="small list mb-0">
				<dt>Installed</dt><dd><%= "${fw_version}-${fw_variant}" %></dd>
				<dt>Latest on GitHub</dt>
				<dd><span id="firmware-master-ver"><% if [ -n "$fw_date" ]; then %><%= $fw_date %><% else %><span class="text-secondary">— no access to GitHub —</span><% fi %></span></dd>
				<dt>SoC</dt><dd><%= $soc %> <span class="text-secondary">(<%= $soc_family %>)</span></dd>
				<dt>Flash</dt><dd><%= $flash_type %></dd>
			</dl>
			<div id="fw-status" class="small text-secondary mt-2"></div>
		</div></div>
	</div>
</div>

<div id="fw-controls" class="mt-4">
	<div class="alert alert-warning py-2 small">The camera stops video and reboots to upgrade. <strong>Do not power off</strong> during the process.</div>

	<div class="mb-4" style="max-width:32rem">
		<% field_switch "fw_kernel" "Upgrade kernel" "true" %>
		<% field_switch "fw_rootfs" "Upgrade rootfs" "true" %>
		<details class="mt-2">
			<summary class="text-secondary small">Advanced options</summary>
			<div class="mt-2">
				<% field_switch "fw_reset" "Reset config (wipe overlay)" "false" "Erases all your settings — equivalent to a fresh flash." %>
				<% field_switch "fw_force" "Reflash even if the same version" "false" "Re-writes flash even when installed and target versions match." %>
			</div>
		</details>
	</div>

	<div class="row g-4">
		<div class="col-12 col-md-6">
			<div class="card h-100"><div class="card-body">
				<h3>From GitHub</h3>
				<p class="small text-secondary">Download and flash the latest release for this board.</p>
				<% if [ -n "$ver" ]; then %>
					<button id="fw-install-github" type="button" class="btn btn-primary">Install update from GitHub</button>
				<% else %>
					<button id="fw-install-github" type="button" class="btn btn-primary" disabled>Install update from GitHub</button>
					<p class="small text-danger mb-0 mt-2">No access to GitHub. <a href="fw-network.cgi">Check your network</a>.</p>
				<% fi %>
			</div></div>
		</div>
		<div class="col-12 col-md-6">
			<div class="card h-100"><div class="card-body">
				<h3>From file</h3>
				<p class="small text-secondary">Upload a <code>.tgz</code> firmware image from your computer.</p>
				<input id="fw-file" type="file" accept=".tgz,.gz" class="form-control mb-2">
				<button id="fw-install-upload" type="button" class="btn btn-primary">Upload &amp; install</button>
			</div></div>
		</div>
	</div>
</div>

<div id="fw-progress" class="mt-4" style="display:none">
	<div class="card"><div class="card-body">
		<h3>Progress</h3>
		<pre id="fw-output" class="border rounded p-2 bg-body-tertiary mb-0" style="height:60vh;overflow:auto;white-space:pre-wrap;font-size:12px"></pre>
	</div></div>
</div>

<script src="/a/fw-update.js"></script>
<%in p/footer.cgi %>
