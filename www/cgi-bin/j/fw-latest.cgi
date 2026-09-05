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
TTL=21600   # six hours: images appear daily at most, and a stale answer only
            # ever delays the notice, never invents one.

json_hdr() { printf 'HTTP/1.1 200 OK\nContent-Type: application/json\nCache-Control: no-store\n\n'; }

installed=$(sed -n 's/^GITHUB_VERSION="\?\([^",]*\).*/\1/p' /etc/os-release 2>/dev/null \
            | sed -n 's/.*+\([0-9a-f]\{7,\}\).*/\1/p' | head -1)

fresh=0
if [ -f "$CACHE" ]; then
    age=$(( $(date +%s) - $(date -r "$CACHE" +%s 2>/dev/null || echo 0) ))
    [ "$age" -ge 0 ] && [ "$age" -lt "$TTL" ] && fresh=1
fi

if [ "$fresh" = "1" ]; then
    json_hdr
    cat "$CACHE"
    exit 0
fi

# Same call, same scrape as the Firmware page: one source of truth for "what
# could this board install". `timeout` bounds it so a dead network cannot hang
# the request.
latest=""
if command -v sysupgrade >/dev/null 2>&1; then
    latest=$(timeout 20 sysupgrade --list-builds 2>/dev/null \
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
# remembered for six hours.
[ "$newer" != "null" ] && printf '%s' "$body" > "$CACHE" 2>/dev/null

json_hdr
printf '%s' "$body"
