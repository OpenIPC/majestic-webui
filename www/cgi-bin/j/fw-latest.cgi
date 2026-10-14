#!/bin/sh
# Is there a firmware image this board can actually install?
#
# GET -> {"installed":"<sha>","latest":"<build-id>","latestSha":"<sha>",
#         "newer":true|false|null}
#
# `newer` is null for "cannot tell" — no updater, no network, a manifest that
# did not answer, or a build that differs from this camera's without being
# dated after it (p/firmware.sh, fw_newer). Callers must treat null as "say nothing", never as false and
# never as true.
#
# WHY THIS EXISTS. The update notice counts what changed in the camera software,
# but the button under it flashes a whole firmware image, and the two do not
# become available at the same moment: the software publishes on its own
# schedule, and an image carrying it appears later, per board, sometimes not for
# days. A notice driven by the software alone therefore tells an owner they are
# behind while the Firmware page — correctly — offers them nothing to install.
# That contradiction is the whole of majestic-webui#348.
#
# So the notice asks this endpoint as well, and stays silent unless an image
# exists. The comparison is deliberately the same one the Firmware page makes,
# through the same updater, so the two cannot disagree.
#
# CACHED because `sysupgrade --list-builds` fetches a manifest over the network
# and the notice is on every page. The cache is a plain file with an mtime TTL;
# a stale one is refreshed by whichever request notices first.

CACHE=/tmp/fw-latest.json
# Held while a check runs. See the lock below.
BUSY="$CACHE.busy"

# The two answers are not equally safe to remember, so they are not cached for
# the same length of time.
#
# "no image" is cheap to hold: the worst a stale one does is delay the notice,
# and it is the common answer — most days there is nothing new, so this is what
# keeps the query off the page.
#
# "there is an image" is the dangerous one. Held for hours it can outlive the
# thing it describes: connectivity drops, or the build is withdrawn, and the
# notice keeps insisting while the Firmware page — which asks live, every time —
# offers nothing. That is the contradiction this endpoint exists to prevent,
# arriving by a different road. So a yes is re-checked often, and the extra
# queries only happen while an update is genuinely waiting to be installed.
#
# An answer that settled nothing -- the check came back empty, or this camera
# reports no revision to compare against -- is the third. It used not to be
# remembered at all, so that it would be retried; but "retried" meant on every
# page view, and on a camera with a route and no internet each one is a
# sysupgrade that runs for its full 15 seconds. A camera that reports no
# revision paid it with the internet up: three seconds, on every page. So it is
# remembered, briefly: long enough that browsing does not run one check per
# page, short enough that a network coming back is noticed in minutes.
TTL_NO=21600    # six hours
TTL_YES=900     # fifteen minutes
TTL_UNSURE=300  # five minutes

json_hdr() { printf 'HTTP/1.1 200 OK\nContent-Type: application/json\nCache-Control: no-store\n\n'; }

# The question and its answer are p/firmware.sh's, shared with the Update page
# and the scheduled install so the three cannot disagree.
. "$(dirname "$0")/../p/firmware.sh"

inst_ver=$(fw_installed_version)
installed=$(fw_sha_of "$inst_ver")

# A half-written cache is not an answer. The file is replaced by rename below,
# so a reader should never see one — but a crash mid-write, or a cache left by
# an older build that wrote in place, would otherwise sit here being counted as
# fresh for hours while serving JSON the browser cannot parse. Cheap to check,
# and the check is what stops a bad file outliving the request that made it.
cached=""
if [ -f "$CACHE" ]; then
    cached=$(cat "$CACHE" 2>/dev/null)
    case "$cached" in
        '{'*'}') ;;
        *) cached="" ;;
    esac
fi

if [ -n "$cached" ]; then
    age=$(( $(date +%s) - $(date -r "$CACHE" +%s 2>/dev/null || echo 0) ))
    case "$cached" in
        *'"installed":""'* | *'"latestSha":""'*) ttl=$TTL_UNSURE ;;
        *'"newer":true'*) ttl=$TTL_YES ;;
        *) ttl=$TTL_NO ;;
    esac
    if [ "$age" -ge 0 ] && [ "$age" -lt "$ttl" ]; then
        json_hdr
        printf '%s' "$cached"
        exit 0
    fi
fi

# One check at a time. Every page asks, and a camera whose check takes its full
# 15 seconds would otherwise start one more for each page opened while the
# first was still out. A request that finds one running is answered "cannot
# tell" at once, which the notice already treats as silence; it is not cached,
# so the next request reads what the running check writes.
#
# mkdir, because it either creates the directory or fails, in one step. A lock
# left by a check that was killed is recognised by its age -- no check lives
# past its 15 seconds -- and taken over.
if ! mkdir "$BUSY" 2>/dev/null; then
    held=$(( $(date +%s) - $(date -r "$BUSY" +%s 2>/dev/null || echo 0) ))
    if [ "$held" -ge 0 ] && [ "$held" -lt 60 ]; then
        json_hdr
        printf '{"installed":"%s","latest":"","latestSha":"","newer":null}' "$installed"
        exit 0
    fi
    rmdir "$BUSY" 2>/dev/null
    mkdir "$BUSY" 2>/dev/null
fi

latest=$(fw_latest_build)
latest_sha=$(fw_build_sha "$latest")
newer=$(fw_newer "$inst_ver" "$latest")

body=$(printf '{"installed":"%s","latest":"%s","latestSha":"%s","newer":%s}' \
        "$installed" "$latest" "$latest_sha" "$newer")

# Every answer is cached, for the time its kind is trusted (see the TTLs
# above). Which kind it is turns on whether both revisions were read, not on
# whether `newer` came out null: a camera running a build later than the newest
# published gets null on every ask, and that is a settled answer, held as long
# as a no.
#
# Written to a private name and renamed into place, because the notice is on
# every page and these requests overlap: `> "$CACHE"` truncates the file first
# and fills it after, so a reader arriving between the two gets an empty or
# partial body, and the mtime the truncation just set makes it look fresh.
# rename is atomic, so a reader sees either the old answer or the new one.
tmp="$CACHE.$$"
if printf '%s' "$body" > "$tmp" 2>/dev/null; then
    mv -f "$tmp" "$CACHE" 2>/dev/null || rm -f "$tmp" 2>/dev/null
else
    rm -f "$tmp" 2>/dev/null
fi
rmdir "$BUSY" 2>/dev/null

json_hdr
printf '%s' "$body"
