#!/bin/sh
# PTZ handler for all three backends. Two request shapes:
#
#   ?h=<±N>&v=<±N>   step move — GPIO stepper (gpio-motors) or profile motor
#                    (/usr/bin/motor + U-Boot ptz=)
#   ?act=<verb>      timed pulse — Pelco-D over serial (/usr/bin/btzoom +
#                    U-Boot ptz=): up down left right stop wide tele near far
#
# Both shapes answer 200 first, like the rest of j/; the pad never reads the
# body. act= wins when both are present — a caller that sends both knows the
# camera better than this script does.

echo "HTTP/1.1 200 OK
Content-type: text/plain; charset=UTF-8
Cache-Control: no-store
Pragma: no-cache

"

HORIZONTAL=0
VERTICAL=0
ACTION=""
for param in $(echo "$QUERY_STRING" | tr '&' ' '); do
	case "$param" in
		h=*) HORIZONTAL="${param#*=}" ;;
		v=*) VERTICAL="${param#*=}" ;;
		act=*) ACTION="${param#*=}" ;;
	esac
done

# Small signed integers only — these become argv of a binary that drives
# hardware. The pad sends ±5; ±99 leaves room for a coarser caller without
# letting one request command a four-digit sweep. Anything else is a step of
# zero, same as j/time.cgi's pattern.
echo "$HORIZONTAL" | grep -qE '^-?[0-9]{1,2}$' || HORIZONTAL=0
echo "$VERTICAL" | grep -qE '^-?[0-9]{1,2}$' || VERTICAL=0

ptz=$(fw_printenv -n ptz 2>/dev/null)

# The verb is matched against the closed list, never passed through: btzoom
# execs "pelcoD_$1", so an unlisted word would call whatever function the
# query string names. (start/day/night exist in btzoom but are lens
# maintenance, not viewing controls — not reachable from here.)
if [ -n "$ACTION" ]; then
	if [ -x /usr/bin/btzoom ] && [ -n "$ptz" ]; then
		case "$ACTION" in
			up|down|left|right|stop|wide|tele|near|far)
				/usr/bin/btzoom "$ACTION"
				exit $?
				;;
		esac
		echo "Unknown PTZ action."
		exit 1
	fi
	echo "Pelco-D PTZ not available on this device."
	exit 1
fi

if command -v gpio-motors >/dev/null 2>&1 && [ -n "$(fw_printenv -n gpio_motors 2>/dev/null)" ]; then
	gpio-motors "$HORIZONTAL" "$VERTICAL" 10
	exit $?
fi

if [ -x /usr/bin/motor ] && [ -n "$ptz" ]; then
	/usr/bin/motor "$ptz" "$HORIZONTAL" "$VERTICAL"
	exit $?
fi

echo "PTZ not available on this device."
exit 1
