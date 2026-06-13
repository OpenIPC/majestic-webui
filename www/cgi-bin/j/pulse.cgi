#!/bin/sh
web=$(pidof majestic)
temp=$(ipcinfo -t 2> /dev/null)

if [ -n "$web" ]; then
	daynight_value=$(wget -q -T1 localhost/metrics/isp?value=isp_again -O -)
fi

if [ -n "$temp" ]; then
	soc_temp="${temp%.*}°C"
fi

mem_total=$(awk '/^MemTotal/ {print $2}' /proc/meminfo)
# MemAvailable counts reclaimable cache/buffers as available, so this is real
# usage — not MemFree, which treats the kernel's page cache as "used" and reads
# alarmingly high (~94%). Matches the status dashboard. Fall back to MemFree on
# kernels too old to report MemAvailable.
mem_avail=$(awk '/^MemAvailable/ {print $2}' /proc/meminfo)
[ -z "$mem_avail" ] && mem_avail=$(awk '/^MemFree/ {print $2}' /proc/meminfo)
mem_used=$(( 100 - (mem_avail * 100 / mem_total) ))
overlay_used=$(df | grep /overlay | xargs | cut -d' ' -f5)
uptime=$(awk '{m=$1/60; h=m/60; printf "%sd %sh %sm %ss\n", int(h/24), int(h%24), int(m%60), int($1%60) }' /proc/uptime)

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

payload=$(printf '{"soc_temp":"%s","time_now":"%s","timezone":"%s","mem_used":"%d","overlay_used":"%d","daynight_value":"%d","uptime":"%s","mj_uptime":"%s"}' \
	"${soc_temp}" "$(date +%s)" "$(cat /etc/timezone)" "${mem_used}" "${overlay_used//%/}" "${daynight_value:=-1}" "$uptime" "$mj_uptime")

echo "HTTP/1.1 200 OK
Content-type: application/json
Pragma: no-cache

${payload}
"
