#!/bin/sh
# Is there a firmware image for this board newer than the one it runs?
#
# Sourced, never executed, for the reason p/majestic.sh gives. Three callers ask
# this question and they must not be able to answer it differently:
#
#   update.cgi          the Update page, asked live on every draw
#   j/fw-latest.cgi     the notice on every other page, cached
#   /usr/sbin/fw-autoupdate
#                       the scheduled install, which reboots the camera on a yes
#
# Two of them used to carry a copy each, kept in step by comments saying so
# (#348 is what a disagreement between them looks like). The third is the one
# that acts unattended, so it is the one that most needs the same answer.

# fw_sha_of <GITHUB_VERSION>   the revision a build string names, or nothing
#
# GITHUB_VERSION in /etc/os-release is shaped "<branch>+<rev>, <date>".
fw_sha_of() {
	printf '%s\n' "$1" | sed -n 's/.*+\([0-9a-f]\{7,\}\).*/\1/p' | head -1
}

# fw_installed_version [os-release]   GITHUB_VERSION, the string fw_newer reads
fw_installed_version() {
	sed -n 's/^GITHUB_VERSION="\?\([^"]*\)"\?$/\1/p' "${1:-/etc/os-release}" 2>/dev/null | head -1
}

# fw_installed_sha [os-release]   the revision this camera was built from, or nothing
fw_installed_sha() {
	fw_sha_of "$(fw_installed_version "$1")"
}

# fw_latest_build   the newest build OpenIPC publishes for this board, or nothing
#
# Through sysupgrade, the same updater the Install button drives over
# /ws/upgrade. It reads OpenIPC's manifest.flat (firmware or builder repo,
# chosen by model), and answers a fresh flash's stale clock itself -- NTP
# first, then the HTTP Date header -- so unlike a verifying HTTPS HEAD it is
# not defeated by one (#44, #121).
#
# A default route must exist, and `timeout` bounds the ask, so a dead network
# cannot hang a page. `ip route`, not /proc/net/route: a hand-rolled parse of
# that file is how this check was wrong the first time -- `grep -E` does not
# read \t as a tab, so it saw no default route on a camera that plainly had
# one.
fw_latest_build() {
	[ -n "$(ip route 2>/dev/null | awk '/default/ {print $3}')" ] || return 0
	command -v sysupgrade >/dev/null 2>&1 || return 0
	timeout 15 sysupgrade --list-builds 2>/dev/null |
		grep -Eo '[A-Za-z0-9._]+-[0-9]{8}-[0-9a-f]+' | head -1
}

# fw_build_sha <build-id>   nightly-20260717-027aae1 -> 027aae1
fw_build_sha() {
	printf '%s' "$1" | sed -n 's/.*-\([0-9a-f]\{7,\}\)$/\1/p'
}

# fw_newer <installed GITHUB_VERSION> <latest build id>   prints true, false or null
#
#   false  the two name the same revision: this camera runs the latest build.
#          A prefix match in both directions, because the two revisions are
#          abbreviated independently and need not be the same length.
#   true   different revisions, and the build is dated after the one
#          installed. Only this may be called an update, and only this lets
#          the scheduled install flash.
#   null   anything else -- a side unread, a date missing, or a build that is
#          different but not later. A camera running something newer than
#          the newest published (a local or a branch build) lands here, and
#          so does a second build published the same day; "different" alone
#          is not "newer", and treating it as newer would have the scheduled
#          install flash an OLDER image over it. Callers treat null as neither
#          yes nor no.
fw_newer() {
	local isha lsha idate ldate
	isha=$(fw_sha_of "$1")
	lsha=$(fw_build_sha "$2")
	if [ -z "$isha" ] || [ -z "$lsha" ]; then
		echo null
		return
	fi
	case "$lsha" in "$isha"*) echo false; return ;; esac
	case "$isha" in "$lsha"*) echo false; return ;; esac
	# "<branch>+<rev>, 2026-10-01" and "nightly-20261002-<rev>"
	idate=$(printf '%s' "$1" | grep -Eo '[0-9]{4}-[0-9]{2}-[0-9]{2}' | head -1 | tr -d -)
	ldate=$(printf '%s' "$2" | grep -Eo -- '-[0-9]{8}-' | head -1 | tr -d -)
	if [ -n "$idate" ] && [ -n "$ldate" ] && [ "$ldate" -gt "$idate" ]; then
		echo true
	else
		echo null
	fi
}
