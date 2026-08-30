#!/bin/sh
# Slim on purpose: everything the browser can derive from majestic's /metrics —
# memory, SoC temperature, uptimes, CPU, the ISP gain the topbar shows — it
# reads there directly (main.js heartbeat, every 2s). This endpoint carries
# only the facts the daemon cannot report: the overlay's df figure and the
# camera's timezone. It is fetched once on load by fw-time.js, files.js and
# recordings.js (timezone/offset/now) and roughly every 30s by the heartbeat
# (overlay). login.html also probes it for a 200 to detect a live session.

overlay_used=$(df | grep /overlay | xargs | cut -d' ' -f5)

# Epoch and UTC offset in one date(1), split with parameter expansion. The
# offset and the label are for the pages that must speak the camera's wall
# clock because the filesystem does: fw-time.cgi, the File Manager (mtimes)
# and Recordings (clips are named by the camera's strftime). /etc/timezone is
# a display label only — fw-time.js writes it de-underscored, e.g. "America/New
# York", which Intl.DateTimeFormat rejects — so the numeric offset is what
# actually renders a wall clock.
now=$(date '+%s %z')

payload=$(printf '{"time_now":"%s","timezone":"%s","utc_offset":"%s","overlay_used":"%d"}' \
	"${now% *}" "$(cat /etc/timezone)" "${now#* }" "${overlay_used//%/}")

echo "HTTP/1.1 200 OK
Content-type: application/json
Pragma: no-cache

${payload}
"
