#!/bin/sh
# PTZ handler for every backend U-Boot ptz_control can name. Two request
# shapes:
#
#   ?h=<±N>&v=<±N>   step move — GPIO stepper (gpio-motors) or profile motor
#                    (/usr/bin/motor)
#   ?act=<verb>      timed pulse — Pelco-D (/usr/bin/btzoom) or the XiongMai
#                    variant (/usr/bin/btzoom-xm) over serial:
#                    up down left right stop wide tele near far
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
# method outright. Unset means no PTZ, same as "none" or an unknown method —
# the reporter ruled that a camera without ptz_control serves nobody, so the
# old auto-detection from gpio_motors/ptz alone is gone.
ptz_control=$(fw_printenv -n ptz_control 2>/dev/null)

pelco_ok=0
pelco_bin=""
gpio_ok=0
motor_ok=0
profile=""
case "$ptz_control" in
	# Two Pelco-shaped serial protocols, one verb set: btzoom is classic
	# Pelco-D, btzoom-xm the XiongMai near-Pelco wire (sandbox#31).
	pelco-d) pelco_bin=/usr/bin/btzoom; [ -x "$pelco_bin" ] && pelco_ok=1 ;;
	pelco-xm) pelco_bin=/usr/bin/btzoom-xm; [ -x "$pelco_bin" ] && pelco_ok=1 ;;
	gpio)
		# Binary AND a pin list (either name — the binary reads ptz_gpio
		# first, legacy gpio_motors second), mirroring update_caminfo.
		if command -v gpio-motors >/dev/null 2>&1 &&
			{ [ -n "$(fw_printenv -n ptz_gpio 2>/dev/null)" ] || [ -n "$(fw_printenv -n gpio_motors 2>/dev/null)" ]; }; then
			gpio_ok=1
		fi
		;;
	motor)
		profile=$(fw_printenv -n ptz_profile 2>/dev/null)
		[ -n "$profile" ] || profile=$(fw_printenv -n ptz 2>/dev/null)
		[ -x /usr/bin/motor ] && [ -n "$profile" ] && motor_ok=1
		;;
esac

# ptz_caps mirrors update_caminfo's sanitising: it declares which axes the
# hardware actually has (an XM zoom block accepts pan frames and ignores
# them), and the endpoint must refuse what the pad no longer draws — the
# pad is a convenience, this is the contract. Empty means every axis.
ptz_caps=""
for cap in $(fw_printenv -n ptz_caps 2>/dev/null); do
	case "$cap" in
		pan|tilt|zoom|focus) ptz_caps="$ptz_caps $cap" ;;
	esac
done

has_cap() {
	[ -z "$ptz_caps" ] && return 0
	case " $ptz_caps " in *" $1 "*) return 0 ;; esac
	return 1
}

# The verb is matched against the closed list, never passed through: the
# scripts dispatch on the verb ("pelcoD_$1"), so an unlisted word must never
# reach them raw. (start/day/night exist in btzoom but are lens maintenance,
# not viewing controls — not reachable from here.) Both Pelco variants take
# the same nine verbs, which is why one pad serves them both.
af_enabled() {
	has_cap focus &&
		[ "$(yaml-cli -g .isp.autofocus.enabled 2>/dev/null)" = "true" ]
}

if [ -n "$ACTION" ]; then
	# Autofocus is majestic's engine, not a pelco verb: the daemon reads the
	# ISP's focus statistic and drives the same motor, holding btzoom's port
	# lock. The request stays open while the pass runs — request lifetime is
	# how the pad paces itself — but the trigger answers immediately, so a
	# poll loop stands in for the pass's duration.
	if [ "$ACTION" = "af" ]; then
		if af_enabled; then
			curl -s -m 2 "http://127.0.0.1/autofocus" > /dev/null
		else
			echo "Autofocus not available on this camera."
			exit 1
		fi
		i=0
		s="running"
		while [ $i -lt 45 ] && [ "$s" = "running" ]; do
			sleep 1
			s=$(curl -s -m 2 "http://127.0.0.1/autofocus/status")
			i=$((i + 1))
		done
		echo "Autofocus: ${s:-unknown}"
		exit 0
	fi
	if [ "$pelco_ok" = 1 ]; then
		case "$ACTION" in
			up|down|left|right|stop|wide|tele|near|far)
				# stop is always allowed — a caps change must never take
				# away the one verb that halts a motor already moving.
				case "$ACTION" in
					wide|tele) has_cap zoom || ACTION="" ;;
					near|far) has_cap focus || ACTION="" ;;
					up|down) has_cap tilt || ACTION="" ;;
					left|right) has_cap pan || ACTION="" ;;
				esac
				if [ -z "$ACTION" ]; then
					echo "Not supported by this camera's PTZ."
					exit 1
				fi
				"$pelco_bin" "$ACTION"
				rc=$?
				# A zoom step on a motorized lens leaves focus behind, so it
				# books a one-shot pass. ?settle makes the engine wait for
				# the port to go quiet first: a held button's pulse train
				# never yields the quiet window, so the pass runs exactly
				# once, after the zooming is over. Repeat triggers answer
				# "busy" and collapse into that one pass.
				if [ "$rc" = 0 ]; then
					case "$ACTION" in
						wide|tele)
							af_enabled &&
								curl -s -m 2 \
									"http://127.0.0.1/autofocus?settle" \
									> /dev/null
							;;
					esac
				fi
				exit $rc
				;;
		esac
		echo "Unknown PTZ action."
		exit 1
	fi
	echo "Pelco PTZ not available on this device."
	exit 1
fi

# The stepped backends take magnitudes, so a missing axis zeroes its
# component rather than refusing the request whole.
has_cap pan || HORIZONTAL=0
has_cap tilt || VERTICAL=0

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
