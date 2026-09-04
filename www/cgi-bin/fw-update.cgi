#!/usr/bin/haserl
<%in p/common.cgi %>
<%

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
		<div class="card"><div class="card-body">
			<% card_head "Firmware" %>
			<dl class="small list mb-0">
				<%# id is a contract with fw-update.js: after the camera reboots it
				    re-fetches this page and compares the value to decide whether the
				    upgrade actually applied (issue #120). %>
				<dt>Installed</dt><dd id="fw-installed"><% esc "${fw_version}-${fw_variant}" %></dd>
				<dt>Latest on GitHub</dt>
				<dd><span><% if [ -n "$fw_date" ]; then %><% esc "$fw_date" %><% else %><span class="text-secondary">— no access to GitHub —</span><% fi %></span></dd>
				<dt>SoC</dt><dd><% esc "$soc" %> <span class="text-secondary">(<% esc "$soc_family" %>)</span></dd>
				<dt>Flash</dt><dd><% esc "$flash_type" %></dd>
			</dl>
			<div id="fw-status" class="small text-secondary mt-2"></div>
		</div></div>
	</div>
</div>

<div id="fw-controls" class="mt-4">
	<%# The switches used to float on the page background between an alert and
	    two cards, which made the one thing you choose before flashing the only
	    thing on the page not in a card. The warning went with them: it is about
	    the act, so it sits on the buttons that start it rather than standing at
	    the top whether or not you are about to press anything. %>
	<div class="card mb-4" style="max-width:32rem"><div class="card-body">
		<% card_head "What gets written" %>
		<% field_switch "fw_kernel" "Upgrade kernel" "true" %>
		<% field_switch "fw_rootfs" "Upgrade rootfs" "true" %>
		<details class="mt-2">
			<summary class="text-secondary small">Advanced options</summary>
			<div class="mt-2">
				<% field_switch "fw_reset" "Reset config (wipe overlay)" "false" "Erases every setting on this camera; it comes back as a fresh flash. <span class='text-danger'>Destroys all changes, and cannot be undone.</span>" "Wipe ALL settings during this upgrade?&#10;&#10;Every configuration change on this camera is erased: network and Wi-Fi, video and image settings, timezone, passwords, and every extension you have configured.&#10;&#10;It comes back as if freshly flashed. This cannot be undone.&#10;&#10;Leave this off unless you specifically want a factory reset." %>
				<% field_switch "fw_force" "Reflash even if the same version" "false" "Re-writes flash even when installed and target versions match." %>
			</div>
		</details>
	</div></div>

	<div class="row g-4">
		<div class="col-12 col-md-6">
			<div class="card h-100"><div class="card-body d-flex flex-column">
				<% card_head "From GitHub" %>
				<p class="small text-secondary">Download and flash the latest release for this board.</p>
				<% if [ -z "$ver" ]; then %>
					<p class="small text-danger">No access to GitHub. <a href="fw-network.cgi">Check your network</a>.</p>
				<% fi %>
				<div class="mj-foot mt-auto">
					<span class="mj-foot-note">Stops video and reboots. Do not power off.</span>
					<button id="fw-install-github" type="button" class="btn btn-primary"<% [ -z "$ver" ] && echo " disabled" %>>Install</button>
				</div>
			</div></div>
		</div>
		<div class="col-12 col-md-6">
			<div class="card h-100"><div class="card-body d-flex flex-column">
				<% card_head "From file" %>
				<p class="small text-secondary">Upload a <code>.tgz</code> firmware image from your computer.</p>
				<p class="string mj-row">
					<label for="fw-file" class="form-label">Image</label>
					<span class="mj-ctl"><span class="mj-ctl-in">
						<input id="fw-file" type="file" accept=".tgz,.gz" class="form-control">
					</span></span>
				</p>
				<div class="mj-foot mt-auto">
					<span class="mj-foot-note">Stops video and reboots. Do not power off.</span>
					<button id="fw-install-upload" type="button" class="btn btn-primary">Upload &amp; install</button>
				</div>
			</div></div>
		</div>
	</div>
</div>

<div id="fw-progress" class="mt-4" style="display:none">
	<div class="card"><div class="card-body">
		<% card_head "Progress" %>
		<pre id="fw-output" class="border rounded p-2 bg-body-tertiary mb-0" style="height:60vh;overflow:auto;white-space:pre-wrap;font-size:12px"></pre>
	</div></div>
</div>

<script src="/a/fw-update.js"></script>
<%in p/footer.cgi %>
