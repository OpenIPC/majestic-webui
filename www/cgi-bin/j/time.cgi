#!/bin/sh
# Time helper. Default: sync via NTP (ntpd -n -q -N).
# With ?set=<epoch>: set the system clock from the caller's Unix time (used by
# the "Set from browser" button for offline cameras; no RTC, so this is volatile
# across reboots). Always returns {"result":"success|danger","message":"..."}.
#
# POST only. Both arms change the clock, and a GET is what a cross-site <img>
# sends: with Basic credentials cached in the browser, any page could set the
# camera's time -- and a share's expiry with it.

if [ "$REQUEST_METHOD" != "POST" ]; then
	printf 'HTTP/1.1 405 Method Not Allowed\nAllow: POST\nContent-type: application/json\n\n{"result":"danger","message":"POST only."}\n'
	exit 0
fi

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
		if [ ! -f /etc/ntp.conf ]; then
			# busybox ntpd has no built-in peers -- with the file gone it prints
			# its usage and exits, and "Synchronization failed!" was all the page
			# ever said about a camera that could not sync and never would.
			payload='{"result":"danger","message":"No NTP servers are configured: /etc/ntp.conf is missing. Fill the servers in above and save."}'
		elif ntpd -n -q -N; then
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
