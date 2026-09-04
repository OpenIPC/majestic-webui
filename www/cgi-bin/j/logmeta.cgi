#!/bin/sh
# The UTC offset syslogd is *actually* running under, so logs.js can turn the
# "Mmm dd hh:mm:ss" stamps coming out of /ws/logs into real instants.
#
# busybox syslogd formats every line with ctime() and stores only the string
# (sysklogd/syslogd.c), discarding the time_t -- so the wall clock in a log line
# is device-local with no year and no zone, and this offset is the missing half.
#
# Deliberately not `date +%z` and not /etc/TZ: /etc/init.d/rcS exports TZ once at
# boot, so syslogd keeps whatever zone was current then, and logs.cgi
# restarts it with the CGI's inherited environment rather than the file. Only the
# daemon's own /proc entry is right in every state, including after a timezone
# change but before the reboot that makes it stick.
spid=$(pidof syslogd | cut -d' ' -f1)
stz=$(tr '\0' '\n' < "/proc/$spid/environ" 2>/dev/null | sed -n 's/^TZ=//p')

# time_now rides along so logs.js can infer the year the wire format omits
# without a second request; the epoch is the same under any TZ, so this is still
# one date(1).
if [ -n "$stz" ]; then
	now=$(TZ="$stz" date '+%z %s')
else
	# syslogd has no TZ in its environment -- which happens when it is restarted
	# from a non-login shell, since only /etc/profile and rcS export one. libc
	# then falls back to /etc/localtime, or UTC if that is missing. Reproduce
	# that by unsetting TZ; inheriting httpd's would report the zone /etc/TZ held
	# at boot and shift every line on any camera that is not on UTC.
	now=$(unset TZ; date '+%z %s')
fi

echo "HTTP/1.1 200 OK
Content-type: application/json
Pragma: no-cache

$(printf '{"tz_offset":"%s","time_now":"%s"}' "${now% *}" "${now#* }")
"
