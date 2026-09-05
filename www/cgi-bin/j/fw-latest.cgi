#!/bin/sh
# Is there a firmware image this board can actually install?
#
# GET -> {"installed":"<sha>","latest":"<build-id>","latestSha":"<sha>",
#         "newer":true|false|null}
#
# `newer` is null for "cannot tell" — no updater, no network, a manifest that
# did not answer. Callers must treat null as "say nothing", never as false and
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
TTL_NO=21600    # six hours
TTL_YES=900     # fifteen minutes

json_hdr() { printf 'HTTP/1.1 200 OK\nContent-Type: application/json\nCache-Control: no-store\n\n'; }

installed=$(sed -n 's/^GITHUB_VERSION="\?\([^",]*\).*/\1/p' /etc/os-release 2>/dev/null \
            | sed -n 's/.*+\([0-9a-f]\{7,\}\).*/\1/p' | head -1)

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
        *'"newer":true'*) ttl=$TTL_YES ;;
        *) ttl=$TTL_NO ;;
    esac
    if [ "$age" -ge 0 ] && [ "$age" -lt "$ttl" ]; then
        json_hdr
        printf '%s' "$cached"
        exit 0
    fi
fi

# Same predicate as the Firmware page, deliberately down to the numbers: a
# default route must exist, and `sysupgrade` gets the same fifteen seconds. A
# longer timeout here, or asking without a route, would let this endpoint answer
# where the page gives up — and two surfaces that disagree is the whole fault
# this is fixing.
#
# The page reads $network_gateway from the shared shell prelude, which is a
# haserl template this cannot include, so the one line that computes it is
# repeated here verbatim rather than reimplemented — `ip route`, not
# /proc/net/route, because a hand-rolled parse of that file is how this check
# was wrong the first time: `grep -E` does not read \t as a tab, so it saw no
# default route on a camera that plainly had one and switched the notice off
# everywhere.
latest=""
if [ -n "$(ip route 2>/dev/null | awk '/default/ {print $3}')" ] &&
   command -v sysupgrade >/dev/null 2>&1; then
    latest=$(timeout 15 sysupgrade --list-builds 2>/dev/null \
             | grep -Eo '[A-Za-z0-9._]+-[0-9]{8}-[0-9a-f]+' | head -1)
fi

latest_sha=$(printf '%s' "$latest" | sed -n 's/.*-\([0-9a-f]\{7,\}\)$/\1/p')

if [ -z "$latest" ] || [ -z "$latest_sha" ] || [ -z "$installed" ]; then
    newer=null
else
    case "$latest_sha" in
        "$installed"*) newer=false ;;
        *) case "$installed" in "$latest_sha"*) newer=false ;; *) newer=true ;; esac ;;
    esac
fi

body=$(printf '{"installed":"%s","latest":"%s","latestSha":"%s","newer":%s}' \
        "$installed" "$latest" "$latest_sha" "$newer")

# Only a real answer is worth caching; an unknown should be retried, not
# remembered.
#
# Written to a private name and renamed into place, because the notice is on
# every page and these requests overlap: `> "$CACHE"` truncates the file first
# and fills it after, so a reader arriving between the two gets an empty or
# partial body, and the mtime the truncation just set makes it look fresh.
# rename is atomic, so a reader sees either the old answer or the new one.
if [ "$newer" != "null" ]; then
    tmp="$CACHE.$$"
    if printf '%s' "$body" > "$tmp" 2>/dev/null; then
        mv -f "$tmp" "$CACHE" 2>/dev/null || rm -f "$tmp" 2>/dev/null
    else
        rm -f "$tmp" 2>/dev/null
    fi
fi

json_hdr
printf '%s' "$body"
