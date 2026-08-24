#!/usr/bin/haserl
<%in p/common.cgi %>
<%
	page_title="Firmware Update"

	# Latest build available for THIS board, via sysupgrade — the same updater the
	# Install button drives over /ws/upgrade. It reads OpenIPC's manifest.flat
	# (firmware or builder repo, chosen by model) with `curl -k`, so unlike the old
	# verifying HTTPS HEAD it is not defeated by a fresh flash's stale clock
	# (issue #44/#121: BADCERT_FUTURE made curl fail while sysupgrade updated fine).
	# `timeout` bounds it so a dead network cannot hang the page.
	latest_build() {
		[ -z "$network_gateway" ] && return
		command -v sysupgrade >/dev/null 2>&1 || return
		timeout 15 sysupgrade --list-builds 2>/dev/null \
			| grep -Eo '[A-Za-z0-9._]+-[0-9]{8}-[0-9a-f]+' | head -1
	}

	ver=$(latest_build)
	if [ -n "$ver" ]; then
		# nightly-20260717-027aae1 -> 2026-07-17
		fw_date=$(echo "$ver" | grep -Eo '[0-9]{8}' | head -1 | sed -E 's/(....)(..)(..)/\1-\2-\3/')
		[ -z "$fw_date" ] && fw_date="$ver"
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
				<%# id is a contract with fw-update.js: after the camera reboots it
				    re-fetches this page and compares the value to decide whether the
				    upgrade actually applied (issue #120). %>
				<dt>Installed</dt><dd id="fw-installed"><% esc "${fw_version}-${fw_variant}" %></dd>
				<dt>Latest on GitHub</dt>
				<dd><span id="firmware-master-ver"><% if [ -n "$fw_date" ]; then %><% esc "$fw_date" %><% else %><span class="text-secondary">— no access to GitHub —</span><% fi %></span></dd>
				<dt>SoC</dt><dd><% esc "$soc" %> <span class="text-secondary">(<% esc "$soc_family" %>)</span></dd>
				<dt>Flash</dt><dd><% esc "$flash_type" %></dd>
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
				<% field_switch "fw_reset" "Reset config (wipe overlay)" "false" "Erases every setting on this camera; it comes back as a fresh flash. <span class='text-danger'>Destroys all changes, and cannot be undone.</span>" "Wipe ALL settings during this upgrade?&#10;&#10;Every configuration change on this camera is erased: network and Wi-Fi, video and image settings, timezone, passwords, and every extension you have configured.&#10;&#10;It comes back as if freshly flashed. This cannot be undone.&#10;&#10;Leave this off unless you specifically want a factory reset." %>
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
