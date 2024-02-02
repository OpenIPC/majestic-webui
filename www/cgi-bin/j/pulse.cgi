#!/bin/sh
web=$(pidof majestic)
temp=$(ipcinfo --temp 2> /dev/null)

if [ -n "$web" ]; then
	daynight_value=$(wget -q -T1 localhost/metrics/isp?value=isp_again -O -)
fi

if [ -n "$temp" ]; then
	soc_temp="${temp}°C"
fi

mem_total=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
mem_free=$(awk '/MemFree/ {print $2}' /proc/meminfo)
mem_used=$(( 100 - (mem_free / (mem_total / 100)) ))
overlay_used=$(df | grep /overlay | xargs | cut -d' ' -f5)
uptime=$(awk '{m=$1/60; h=m/60; printf "%sd %sh %sm %ss\n", int(h/24), int(h%24), int(m%60), int($1%60) }' /proc/uptime)
payload=$(printf '{"soc_temp":"%s","time_now":"%s","timezone":"%s","mem_used":"%d","overlay_used":"%d","daynight_value":"%d","uptime":"%s"}' \
	"${soc_temp}" "$(date +%s)" "$(cat /etc/timezone)" "${mem_used}" "${overlay_used//%/}" "${daynight_value:=-1}" "$uptime")

echo "HTTP/1.1 200 OK
Content-type: application/json
Pragma: no-cache

${payload}
"
