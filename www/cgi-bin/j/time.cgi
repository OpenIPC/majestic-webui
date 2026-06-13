#!/bin/sh
# Time helper. Default: sync via NTP (ntpd -n -q -N).
# With ?set=<epoch>: set the system clock from the caller's Unix time (used by
# the "Set from browser" button for offline cameras; no RTC, so this is volatile
# across reboots). Always returns {"result":"success|danger","message":"..."}.

case "$QUERY_STRING" in
	*set=*)
		set_val=$(printf '%s' "$QUERY_STRING" | sed -n 's/.*\(^\|&\)set=\([^&]*\).*/\2/p')
		if echo "$set_val" | grep -qE '^[0-9]+$' && date -s @"$set_val" >/dev/null 2>&1; then
			payload='{"result":"success","message":"Camera clock set from browser."}'
		elif echo "$set_val" | grep -qE '^[0-9]+$'; then
			payload='{"result":"danger","message":"Failed to set clock."}'
		else
			payload='{"result":"danger","message":"Invalid timestamp."}'
		fi
		;;
	*)
		if ntpd -n -q -N; then
			payload='{"result":"success","message":"Camera time synchronized with NTP server."}'
		else
			payload='{"result":"danger","message":"Synchronization failed!"}'
		fi
		;;
esac

echo "HTTP/1.1 200 OK
Content-type: application/json
Pragma: no-cache

${payload}
"
