#!/usr/bin/haserl
<%in p/common.cgi %>
<%

	# Latest build available for THIS board, via sysupgrade — the same updater the
	# Install button drives over /ws/upgrade. It reads OpenIPC's manifest.flat
	# (firmware or builder repo, chosen by model), and it answers a fresh flash's
	# stale clock itself — NTP first, then the HTTP Date header — so unlike the
	# old verifying HTTPS HEAD it is not defeated by one (issue #44/#121:
	# BADCERT_FUTURE made curl fail while sysupgrade updated fine). It used to do
	# that by skipping certificate verification; since sysupgrade 1.0.63 the
	# fetch is verified and the clock is what gets fixed.
	# `timeout` bounds it so a dead network cannot hang the page.
	#
	# Asked live on every draw, never from j/fw-latest.cgi's cache. That endpoint
	# exists so the banner on every other page can be cheap; this page is where
	# somebody has come to act, and it must not offer — or withhold — an image on
	# the strength of an answer up to six hours old.
	latest_build() {
		[ -z "$network_gateway" ] && return
		command -v sysupgrade >/dev/null 2>&1 || return
		timeout 15 sysupgrade --list-builds 2>/dev/null \
			| grep -Eo '[A-Za-z0-9._]+-[0-9]{8}-[0-9a-f]+' | head -1
	}

	# A date a sentence can carry. Every other date on this page is ISO because it
	# sits in a dl.list beside a version string, where a column of them lines up;
	# the headline is prose, and "Firmware from 2026-09-08 is ready" reads like a
	# log line rather than like a sentence.
	#
	# A month table rather than `date -d`: busybox's -d parses a much narrower set
	# of inputs than GNU's and differs between builds, and getting it wrong here
	# would print an empty month into the one line everybody reads.
	say_date() {
		local y=${1%%-*} rest=${1#*-} m d
		m=${rest%%-*}; d=${rest#*-}
		d=${d#0}
		case "$m" in
			01) m=January ;;   02) m=February ;; 03) m=March ;;     04) m=April ;;
			05) m=May ;;       06) m=June ;;     07) m=July ;;      08) m=August ;;
			09) m=September ;; 10) m=October ;;  11) m=November ;;  12) m=December ;;
			*) printf '%s' "$1"; return ;;
		esac
		printf '%s %s %s' "$d" "$m" "$y"
	}

	# An upgrade is already running when the camera is holding upgrade mode, which
	# it advertises by keeping the file /tmp/majestic-upgrade-owner present for as
	# long as it lasts and removing it when the upgrade ends. update.js reads the
	# flag below and reattaches to the running /ws/upgrade instead of offering a
	# fresh one, so a page reloaded mid-flash shows the live transcript and the
	# "do not power off" warning again rather than a bare Update card. Without it
	# a reload during a flash lost both: the camera keeps a single upgrade session
	# and answers a second connection with 503, and the user cut power blind.
	fw_active=""
	[ -f /tmp/majestic-upgrade-owner ] && fw_active=1

	# Skip the network-touching build check while a flash is under way: the page
	# goes straight to the progress view, so there is nothing to offer, and
	# `sysupgrade --list-builds` would only add load to a camera mid-upgrade.
	if [ -n "$fw_active" ]; then ver=""; else ver=$(latest_build); fi
	if [ -n "$ver" ]; then
		# nightly-20260717-027aae1 -> 2026-07-17
		fw_date=$(echo "$ver" | grep -Eo '[0-9]{8}' | head -1 | sed -E 's/(....)(..)(..)/\1-\2-\3/')
		[ -z "$fw_date" ] && fw_date="$ver"
	else
		fw_date=""
	fi

	# What state the page is in, decided here so the hero can say one thing
	# plainly instead of printing two versions and leaving the arithmetic to the
	# reader. $fw_build is GITHUB_VERSION out of /etc/os-release, shaped
	# "<branch>+<rev>, <date>", so it carries both the revision this camera was
	# built from and the day it was built.
	#
	# The comparison is j/fw-latest.cgi's, deliberately down to the prefix match
	# in both directions: two surfaces that disagree about whether this camera is
	# current is the fault that endpoint exists to prevent, and it must not arrive
	# by this road instead.
	#
	#   offline   — there is nothing to offer.
	#   current   — both revisions known and the same.
	#   available — there is an image to install.
	#
	# Two of those carry a second variable, because a state is not a reason and
	# this page must not turn one into the other. An absent reading is not a zero
	# and a failed fetch is not a fact:
	#
	#   fw_why  noroute — the camera has no default route. Provable, and the only
	#                     case in which the page may say the internet is the
	#                     problem.
	#           nocheck — it has a route and still came back with nothing: no
	#                     updater, a request that timed out, a manifest that did
	#                     not parse. Says it could not check, and names no cause.
	#
	#   fw_cmp  newer   — both revisions read, and they differ.
	#           unknown — this camera reports no revision to compare against, so
	#                     the image is offered (which is what this page has always
	#                     done) but not called an update. "Firmware X is ready" is
	#                     a claim about two builds; with one of them unreadable
	#                     there is nothing to claim.
	inst_sha=$(echo "$fw_build" | sed -n 's/.*+\([0-9a-f]\{7,\}\).*/\1/p')
	inst_date=$(echo "$fw_build" | grep -Eo '[0-9]{4}-[0-9]{2}-[0-9]{2}' | head -1)
	latest_sha=$(printf '%s' "$ver" | sed -n 's/.*-\([0-9a-f]\{7,\}\)$/\1/p')
	fw_why=""
	fw_cmp=""
	# The rule and the mark, which follow the severity and not the state: an
	# image this camera cannot be compared against is not a warning, and a check
	# that did not happen is not a fault.
	fw_sev=""
	if [ -z "$ver" ]; then
		fw_state="offline"
		fw_sev="info"
		if [ -z "$network_gateway" ]; then fw_why="noroute"; else fw_why="nocheck"; fi
	elif [ -n "$latest_sha" ] && [ -n "$inst_sha" ] && {
		case "$latest_sha" in "$inst_sha"*) true ;; *)
			case "$inst_sha" in "$latest_sha"*) true ;; *) false ;; esac ;;
		esac
	}; then
		fw_state="current"
		fw_sev="ok"
	else
		fw_state="available"
		if [ -n "$latest_sha" ] && [ -n "$inst_sha" ]; then
			fw_cmp="newer"; fw_sev="warn"
		else
			fw_cmp="unknown"; fw_sev="info"
		fi
	fi

	# The page title is rendered by this page rather than by header.cgi, the way
	# camera.cgi does it and for the same arithmetic: the full-width band above
	# the content costs 94px of every window — a 2rem margin, a 32px heading and
	# the gutter under it — and here it bought a copy of a word the nav's active
	# item, the browser tab and the card immediately below it all already carry.
	# Still a real <h2>, so the document keeps its heading (#239).
	hide_title=1

	fw_kernel="true"
	fw_rootfs="true"
%>
<%in p/header.cgi %>

<h2 class="mj-rail-title mj-page-title"><%= $page_title %></h2>

<%# Where update.js reports what a flash is doing. Above everything and outside
    #fw-controls, because it also carries the two refusals that happen BEFORE a
    flash starts — nothing selected to write, no file chosen — and those must not
    land in a block that is still hidden. %>
<div id="fw-status" role="status" aria-live="polite"></div>

<%# Set when the camera is holding upgrade mode (the marker file checked above).
    update.js reads data-active and reattaches to /ws/upgrade instead of offering
    a fresh upgrade, so a page reloaded mid-flash shows the live transcript and
    the "do not power off" warning again rather than a bare Update card. Always
    present so the reader is `$('#fw-inflight')`, never a missing node. %>
<div id="fw-inflight" hidden data-active="<% attr_escape "$fw_active" %>"></div>

<div id="fw-controls">

	<%# The page's one decision, first on the page: what is on offer, what it is
	    worth, and the button. Everything below it is detail for somebody who has
	    already decided or wants to know more.

	    A card rather than a banner, though it borrows .mj-notice's severity rule
	    and 28px mark: a banner is a thing you close, and this is the page. The
	    data attributes are what the header's notice slot carries elsewhere —
	    update.js needs them here because this page renders no slot. %>
	<div id="fw-head" class="card mj-hero-card mj-sev-<% esc "$fw_sev" %>"
	     data-mj-version="<% attr_escape "$mj_version" %>"
	     data-soc-vendor="<% attr_escape "$soc_vendor" %>"
	     data-fw-state="<% attr_escape "$fw_state" %>"
	     data-fw-latest="<% attr_escape "$ver" %>">
		<div class="card-body">
			<div class="mj-hero">
				<% if [ "$fw_state" = "available" ]; then %>
					<svg class="mj-hero-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>
				<% elif [ "$fw_state" = "current" ]; then %>
					<svg class="mj-hero-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z"/><path d="m8 12 2.6 2.6L16 9.5"/></svg>
				<% else %>
					<svg class="mj-hero-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.3 8.1A5 5 0 0 1 16.6 8.9a4 4 0 0 1 2.6 6.8"/><path d="M15 18H6.5a4.5 4.5 0 0 1-1.6-8.7"/><path d="M3 3l18 18"/></svg>
				<% fi %>

				<div class="mj-hero-txt">
					<% if [ "$fw_state" = "available" ] && [ "$fw_cmp" = "newer" ]; then %>
						<p class="mj-hero-kick">Update available</p>
						<h3 class="mj-hero-hl">Firmware from <% esc "$(say_date "$fw_date")" %> is ready</h3>
						<p class="mj-hero-sub">
							<span class="mj-mono"><% esc "$ver" %></span> &middot; built for
							<% esc "$soc" %> on <% esc "$(echo "$flash_type" | tr 'a-z' 'A-Z')" %> flash. This camera has been
							running <span class="mj-mono"><% esc "${fw_version}-${fw_variant}" %></span><% if [ -n "$inst_date" ]; then %> since <% esc "$inst_date" %><% fi %>.
						</p>
					<% elif [ "$fw_state" = "available" ]; then %>
						<%# The image is offered, but nothing here calls it an update: with no
						    readable revision on one side there are not two builds to compare. %>
						<p class="mj-hero-kick">Build available</p>
						<h3 class="mj-hero-hl">Firmware from <% esc "$(say_date "$fw_date")" %> is available</h3>
						<p class="mj-hero-sub">
							<span class="mj-mono"><% esc "$ver" %></span> &middot; built for
							<% esc "$soc" %> on <% esc "$(echo "$flash_type" | tr 'a-z' 'A-Z')" %> flash. This camera
							reports no revision of its own, so whether that is newer than what it is
							running cannot be established here.
						</p>
					<% elif [ "$fw_state" = "current" ]; then %>
						<p class="mj-hero-kick">Up to date</p>
						<h3 class="mj-hero-hl">This camera runs the newest firmware</h3>
						<p class="mj-hero-sub">
							<span class="mj-mono"><% esc "$ver" %></span> &middot; the latest build
							published for <% esc "$soc" %> on <% esc "$(echo "$flash_type" | tr 'a-z' 'A-Z')" %> flash.
						</p>
					<% elif [ "$fw_why" = "noroute" ]; then %>
						<p class="mj-hero-kick">No connection</p>
						<h3 class="mj-hero-hl">Can&rsquo;t reach the update server</h3>
						<p class="mj-hero-sub">
							This camera has no route to the internet, so it cannot check for new
							firmware or download any. Everything else on the camera keeps working.
						</p>
					<% else %>
						<%# It has a route and still came back with nothing. That is not evidence
						    of a network fault, so this names none. %>
						<p class="mj-hero-kick">Not checked</p>
						<h3 class="mj-hero-hl">Couldn&rsquo;t check for new firmware</h3>
						<p class="mj-hero-sub">
							The camera has a network route, but nothing came back from OpenIPC&rsquo;s
							build list &mdash; it may be temporarily unreachable, or this build may have
							no updater. Nothing here says which, and nothing on the camera has changed.
						</p>
					<% fi %>

					<%# Filled by update.js from the public feed, and staying empty is the
					    correct result on a browser that cannot reach it. %>
					<div id="fw-counts" class="mj-pills" hidden></div>
				</div>

				<% if [ "$fw_state" = "available" ]; then %>
					<div class="mj-hero-act">
						<button id="fw-install-github" type="button" class="btn btn-primary btn-lg">Install</button>
					</div>
				<% elif [ "$fw_state" = "current" ]; then %>
					<%# The write-options card offers "Reflash even if the same version", and
					    on a camera that IS current this was the only page with no button to
					    act on it — a switch you can set and cannot use. Reinstalling the
					    build you are on is a real thing to want (a flash you suspect), so
					    the state that makes it meaningful is the state that offers it.
					    data-force because that is what the word means here: without it
					    sysupgrade answers "same version, nothing to update" and writes
					    nothing, which is a button that does nothing by another road. %>
					<div class="mj-hero-act">
						<button id="fw-install-github" type="button" class="btn btn-outline-secondary"
						        data-force="1"
						        data-confirm="Reinstall the build this camera is already running?&#10;&#10;It writes the same firmware over itself. Video stops and the camera reboots.">Reinstall</button>
					</div>
				<% elif [ "$fw_state" = "offline" ] && [ "$fw_why" = "noroute" ]; then %>
					<div class="mj-hero-act">
						<a href="network.cgi" class="btn btn-outline-secondary">Check network settings</a>
					</div>
				<% fi %>
			</div>
		</div>

		<div class="mj-foot">
			<% if [ "$fw_state" = "available" ]; then %>
				<span class="mj-foot-note">Writes the kernel and the rootfs. Video stops and the camera reboots &mdash; do not power it off.</span>
				<span class="mj-foot-note ms-auto">about 2 minutes</span>
			<% elif [ "$fw_state" = "current" ]; then %>
				<span class="mj-foot-note">Checked against OpenIPC&rsquo;s build list just now. Nothing to install &mdash; Reinstall writes this same build again.</span>
			<% else %>
				<span class="mj-foot-note">Nothing has been downloaded, and nothing on this camera has changed.</span>
			<% fi %>
		</div>
	</div>

	<div class="row g-4 mt-0 mj-fw-cols">

		<%# The wide column. With an image on offer it is the changelog, which the
		    browser fetches; with none it is the file route, which is then the only
		    way to update at all. Either way it is the thing a reader came to read,
		    and the rail beside it is reference.

		    #fw-news carries `hidden` until the feed answers, and the stylesheet
		    widens the rail when it stays that way — an empty two-thirds beside a
		    narrow rail is the dead margin this layout exists to remove. %>
		<% if [ "$fw_state" = "offline" ]; then %>
			<div class="col-12 col-lg-7 mj-fw-wide">
				<div class="card h-100"><div class="card-body d-flex flex-column">
					<% card_head "Install from a file" "the only route from here" %>
					<p class="hint text-secondary">On a machine that does have internet, download the image for
						<code><% esc "$soc" %></code> on <% esc "$(echo "$flash_type" | tr 'a-z' 'A-Z')" %> flash, then upload it here.
						The camera checks the image before it writes anything.</p>
					<p class="string mj-row mt-3">
						<label for="fw-file" class="form-label">Image</label>
						<span class="mj-ctl"><span class="mj-ctl-in">
							<input id="fw-file" type="file" accept=".tgz,.gz" class="form-control">
						</span></span>
					</p>
					<div class="mj-foot mt-auto">
						<span class="mj-foot-note">Writes the kernel and the rootfs. Video stops and the camera reboots &mdash; do not power it off.</span>
						<button id="fw-install-upload" type="button" class="btn btn-primary">Upload &amp; install</button>
					</div>
				</div></div>
			</div>
		<% else %>
			<div id="fw-news" class="col-12 col-lg-7 mj-fw-wide" hidden>
				<div class="card"><div class="card-body">
					<% card_head "What&rsquo;s new" "since your build" %>
					<div id="fw-news-body"></div>
				</div></div>
			</div>
		<% fi %>

		<div class="col-12 col-lg-5 mj-fw-rail">
			<div class="row g-4">

				<div class="col-12">
					<div class="card h-100"><div class="card-body">
						<% card_head "This camera" %>
						<dl class="small list mb-0">
							<%# id is a contract with fw-update.js: after the camera reboots it
							    re-fetches this page and compares the value to decide whether the
							    upgrade actually applied (issue #120). %>
							<dt>Installed</dt><dd id="fw-installed"><% esc "${fw_version}-${fw_variant}" %></dd>
							<% if [ -n "$inst_date" ]; then %>
								<dt>Built</dt><dd><% esc "$inst_date" %></dd>
							<% fi %>
							<dt>SoC</dt><dd><% esc "$soc" %> <span class="text-secondary">(<% esc "$soc_family" %>)</span></dd>
							<dt>Sensor</dt><dd><% esc "$sensor" %></dd>
							<dt>Flash</dt><dd><% esc "$flash_type" %></dd>
						</dl>
					</div></div>
				</div>

				<%# Kept visible rather than folded behind a disclosure: they govern
				    both routes, and a switch nobody can see is a switch nobody
				    knows they have. Subordinate to the hero by position and size,
				    which is what the complaint about this page was about. %>
				<div class="col-12">
					<div class="card h-100"><div class="card-body">
						<% card_head "What gets written" %>
						<p class="hint text-secondary mb-3">Both are written unless you turn one off.</p>
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
				</div>

				<% if [ "$fw_state" = "available" ]; then %>
					<%# The question somebody asks with a finger over Install. It is
					    answered here rather than after the fact, because after the
					    fact this page is not reachable. %>
					<div class="col-12">
						<div class="card h-100"><div class="card-body">
							<% card_head "If it does not come back" %>
							<p class="hint text-secondary">The camera stops answering while it writes and returns in about
								two minutes. If it has not returned after five, power it off and on
								once, then reload this page.</p>
						</div></div>
					</div>
				<% fi %>

				<% if [ "$fw_state" != "offline" ]; then %>
					<%# From a file, at the weight it is actually used at: last in the
					    rail, one line and a way in. It is not a second half of a pair
					    of equal choices — almost nobody arrives here with a .tgz —
					    and presenting it as one is what made the download route hard
					    to find. The button stays btn-sm even once a file is chosen:
					    size carries the hierarchy, so it can be the real action
					    without competing with Install. %>
					<div class="col-12">
						<div class="card h-100"><div class="card-body">
							<% card_head "Install from a file" %>
							<p class="hint text-secondary mb-3">Have a <code>.tgz</code> image on your computer? Use it instead of downloading.</p>
							<p class="string mj-row mb-0">
								<label for="fw-file" class="form-label">Image</label>
								<span class="mj-ctl"><span class="mj-ctl-in">
									<input id="fw-file" type="file" accept=".tgz,.gz" class="form-control form-control-sm">
								</span></span>
							</p>
							<div class="mj-foot mt-3">
								<span class="mj-foot-note">Same reboot, same caution.</span>
								<button id="fw-install-upload" type="button" class="btn btn-sm btn-primary">Install this file</button>
							</div>
						</div></div>
					</div>
				<% fi %>

			</div>
		</div>
	</div>
</div>

<div id="fw-progress" class="mt-4" style="display:none">
	<%# While it writes there is nothing else to do on this page, so there is
	    nothing else on it: #fw-controls goes and this takes its place. The log
	    used to open BELOW two install cards that stayed live under a flash
	    already under way. %>
	<div class="card mj-hero-card mj-sev-progress">
		<div class="card-body">
			<div class="mj-hero">
				<svg class="mj-hero-ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/></svg>
				<div class="mj-hero-txt">
					<p class="mj-hero-kick">Installing</p>
					<h3 class="mj-hero-hl" id="fw-progress-hl">Writing firmware</h3>
					<%# Only ever a percentage sysupgrade itself printed. A bar that
					    invents its own progress is worse than none: this one is
					    hidden until the download meter says a number, and hidden
					    again once it stops. %>
					<div id="fw-bar" class="progress mt-3" role="progressbar" hidden><div class="progress-bar"></div></div>
					<ol id="fw-steps" class="mj-steps">
						<li data-step="download">Downloading</li>
						<li data-step="verify">Verifying</li>
						<li data-step="kernel">Writing kernel</li>
						<li data-step="rootfs">Writing rootfs</li>
						<li data-step="reboot">Rebooting</li>
					</ol>
				</div>
			</div>
		</div>
		<div class="mj-foot mj-foot-loud">
			<svg class="mj-foot-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 9v5m0 3.5h.01M10.3 3.9 1.9 18.3A2 2 0 0 0 3.6 21.3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>
			<span class="mj-foot-note">Do not power the camera off, and do not close this page.</span>
		</div>
	</div>

	<div class="card mt-4"><div class="card-body">
		<% card_head "Progress" "sysupgrade" %>
		<pre id="fw-output" class="border rounded p-2 bg-body-tertiary mb-0" style="height:50vh;overflow:auto;white-space:pre-wrap;font-size:12px"></pre>
	</div></div>
</div>

<script src="/a/update.js"></script>
<%in p/footer.cgi %>
