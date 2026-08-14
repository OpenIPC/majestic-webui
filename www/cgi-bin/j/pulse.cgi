#!/bin/sh
web=$(pidof majestic)
temp=$(ipcinfo -t 2> /dev/null)

if [ -n "$web" ]; then
	daynight_value=$(wget -q -T1 localhost/metrics/isp?value=isp_again -O -)
fi

if [ -n "$temp" ]; then
	soc_temp="${temp%.*}°C"
fi

# MemAvailable counts reclaimable cache/buffers as available, so this is real
# usage — not MemFree, which treats the kernel's page cache as "used" and reads
# alarmingly high. Matches the status dashboard.
#
# Kernels older than 3.14 have no MemAvailable line at all (the T31 runs 3.10),
# so rebuild the kernel's own si_mem_available() estimate from the parts that
# are there. Bare MemFree is not a usable substitute: on a T31 it reads ~90%
# used at idle, which trips the amber branch of setProgressBar (issue #116).
# wmark_low lives in /proc/zoneinfo, not here, so this runs ~2% optimistic.
# Keep this formula in sync with parseMetrics() in www/a/status.js.
mem_used=$(awk '
	/^MemTotal:/         { t = $2 }
	/^MemAvailable:/     { a = $2 }
	/^MemFree:/          { f = $2 }
	/^Active\(file\):/   { af = $2 }
	/^Inactive\(file\):/ { inf = $2 }
	/^SReclaimable:/     { sr = $2 }
	END {
		if (t <= 0) { printf "0"; exit }
		if (a == "") a = f + af + inf + sr
		pct = 100 - (a * 100 / t)
		if (pct < 0) pct = 0
		if (pct > 100) pct = 100
		printf "%d", pct
	}' /proc/meminfo)
overlay_used=$(df | grep /overlay | xargs | cut -d' ' -f5)
uptime=$(awk '{m=$1/60; h=m/60; printf "%sd %sh %sm %ss\n", int(h/24), int(h%24), int(m%60), int($1%60) }' /proc/uptime)

# The same value in raw seconds. fw-update.js compares it against how long the
# upgrade has been running to establish that the camera really did reboot;
# recovering that from the "0d 0h 1m 2s" label above would mean parsing a string
# written for humans. `read` is a builtin, so this costs the 2s heartbeat no
# extra fork.
read -r uptime_s _ </proc/uptime
uptime_s=${uptime_s%.*}

# Majestic's own uptime: system uptime minus the process start time (field 22 of
# /proc/<pid>/stat is starttime in clock ticks since boot). Computed live each
# poll, so it stays correct even if majestic restarts on its own. Formatted
# without seconds to match the status card's system-uptime line.
mj_uptime=""
mjpid=$(echo "$web" | awk '{print $1}')
if [ -n "$mjpid" ] && [ -r "/proc/$mjpid/stat" ]; then
	mj_uptime=$(awk -v hz="$(getconf CLK_TCK 2>/dev/null || echo 100)" \
		-v up="$(awk '{print $1}' /proc/uptime)" \
		'{ s = up - $22/hz; if (s<0) s=0;
		   d=int(s/86400); h=int((s%86400)/3600); m=int((s%3600)/60);
		   printf "%s%s%sm", (d? d"d ":""), (h||d? h"h ":""), m }' "/proc/$mjpid/stat")
fi

# Epoch and UTC offset in one date(1), split with parameter expansion, so the
# 2s heartbeat gains no extra fork. The header needs both: /etc/timezone is only
# a display label (fw-time.js writes it de-underscored, e.g. "America/New York",
# which Intl.DateTimeFormat rejects), so the numeric offset is what actually
# renders the camera's wall clock.
now=$(date '+%s %z')

payload=$(printf '{"soc_temp":"%s","time_now":"%s","timezone":"%s","utc_offset":"%s","mem_used":"%d","overlay_used":"%d","daynight_value":"%d","uptime":"%s","uptime_s":%d,"mj_uptime":"%s"}' \
	"${soc_temp}" "${now% *}" "$(cat /etc/timezone)" "${now#* }" "${mem_used}" "${overlay_used//%/}" "${daynight_value:=-1}" "$uptime" "${uptime_s:-0}" "$mj_uptime")

echo "HTTP/1.1 200 OK
Content-type: application/json
Pragma: no-cache

${payload}
"
