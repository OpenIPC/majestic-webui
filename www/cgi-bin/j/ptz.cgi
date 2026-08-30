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

# The same switch update_caminfo honours (#227): ptz_control names the
# method outright; unset falls back to the pre-#227 detection so nothing in
# the field breaks; "none" (or an unknown method) serves nobody.
ptz_control=$(fw_printenv -n ptz_control 2>/dev/null)
ptz=$(fw_printenv -n ptz 2>/dev/null)

pelco_ok=0
gpio_ok=0
motor_ok=0
profile=""
case "$ptz_control" in
	pelco-d) [ -x /usr/bin/btzoom ] && pelco_ok=1 ;;
	gpio)
		# Binary AND a pin list (either name — the binary itself still reads
		# the legacy one), mirroring update_caminfo.
		if command -v gpio-motors >/dev/null 2>&1 &&
			{ [ -n "$(fw_printenv -n ptz_gpio 2>/dev/null)" ] || [ -n "$(fw_printenv -n gpio_motors 2>/dev/null)" ]; }; then
			gpio_ok=1
		fi
		;;
	motor)
		profile=$(fw_printenv -n ptz_profile 2>/dev/null)
		[ -n "$profile" ] || profile="$ptz"
		[ -x /usr/bin/motor ] && [ -n "$profile" ] && motor_ok=1
		;;
	none) ;;
	"")
		[ -x /usr/bin/btzoom ] && [ -n "$ptz" ] && pelco_ok=1
		command -v gpio-motors >/dev/null 2>&1 && [ -n "$(fw_printenv -n gpio_motors 2>/dev/null)" ] && gpio_ok=1
		profile="$ptz"
		[ -x /usr/bin/motor ] && [ -n "$profile" ] && motor_ok=1
		;;
esac

# The verb is matched against the closed list, never passed through: btzoom
# execs "pelcoD_$1", so an unlisted word would call whatever function the
# query string names. (start/day/night exist in btzoom but are lens
# maintenance, not viewing controls — not reachable from here.)
if [ -n "$ACTION" ]; then
	if [ "$pelco_ok" = 1 ]; then
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

if [ "$gpio_ok" = 1 ]; then
	gpio-motors "$HORIZONTAL" "$VERTICAL" 10
	exit $?
fi

if [ "$motor_ok" = 1 ]; then
	/usr/bin/motor "$profile" "$HORIZONTAL" "$VERTICAL"
	exit $?
fi

echo "PTZ not available on this device."
exit 1
