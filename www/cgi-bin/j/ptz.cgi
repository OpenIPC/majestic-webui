#!/bin/sh
# PTZ handler for every backend U-Boot ptz_control can name. Two request
# shapes:
#
#   ?h=<±N>&v=<±N>   step move — GPIO stepper (gpio-motors) or profile motor
#                    (/usr/bin/motor)
#   ?act=<verb>      serial motor — majestic drives it (GET /ptz), because
#                    majestic owns that wire: up down left right stop wide
#                    tele near far
#
# Both shapes answer 200 first, like the rest of j/; the pad never reads the
# body. act= wins when both are present — a caller that sends both knows the
# camera better than this script does.

. "$(dirname "$0")/../p/majestic.sh"

# Moving hardware is not a safe method. A GET is what a browser issues on its
# own -- a prefetch, a restored tab, an <img> or a form on somebody else's page
# -- and it carries the session with it. The camera refuses a GET on its own
# /ptz for exactly that reason, and refusing it here too is what stops this
# endpoint being the deputy that turns an attacker's GET into a legitimate
# POST: everything below either drives a motor or steps a pad.
if [ "$REQUEST_METHOD" != "POST" ]; then
	echo "HTTP/1.1 405 Method Not Allowed
Content-type: text/plain; charset=UTF-8
Allow: POST
Cache-Control: no-store

Use POST to move the camera."
	exit 1
fi

# POST alone was never enough, and the comment above says why in the GET case:
# this must not be the deputy that launders somebody else's request into a
# camera command. A cross-site HTML form POSTs with no preflight and no custom
# header, so `enctype=multipart/form-data` on a page the operator merely visits
# reaches this script. The session cookie is SameSite=Strict and does not ride
# -- but a browser holding cached HTTP Basic credentials attaches those, and
# that is the ordinary state of a WebUI session.
#
# The camera's own /ptz answers this by asking the browser where the request
# came from, and the header it reads is not among the few this script is given.
# So two tests, and the ORDER of trust matters: the second is the one that
# actually holds.
#
# 1. A Referer naming another origin is refused. Cheap, and it catches the
#    ordinary case -- but an attacker sets `Referrer-Policy: no-referrer` and
#    sends none at all, so its absence can prove nothing and must be allowed
#    (that is also every command-line caller).
#
# 2. A form's Content-Type is refused outright. This is the half that cannot be
#    sidestepped: a cross-site POST that carries no preflight is exactly a POST
#    a plain HTML form could have made, and a form can only send these three
#    types. Anything wanting another type needs a preflight, which this endpoint
#    never answers, so the browser stops it before it arrives.
#
# What still gets through is what should: this page's own fetch, which sends its
# arguments in the query string and so carries no body and no Content-Type at
# all, and a command-line POST, which carries none either.
cross_site=""
if [ -n "$HTTP_REFERER" ]; then
	ref_origin="${HTTP_REFERER#*://}"
	ref_origin="${ref_origin%%/*}"
	[ "$ref_origin" = "$HTTP_HOST" ] || cross_site=1
fi
case "$CONTENT_TYPE" in
	application/x-www-form-urlencoded*|multipart/form-data*|text/plain*)
		cross_site=1
		;;
esac
if [ -n "$cross_site" ]; then
	echo "HTTP/1.1 400 Bad Request
Content-type: text/plain; charset=UTF-8
Cache-Control: no-store

Cross-site PTZ refused."
	exit 1
fi

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
pelco_why=""
gpio_ok=0
motor_ok=0
profile=""
case "$ptz_control" in
	# Two Pelco-shaped serial protocols, one verb set, one driver: the camera
	# holds the port and the WebUI asks it for a verb. This used to exec
	# /usr/bin/btzoom or /usr/bin/btzoom-xm, which opened the same tty the
	# camera was already driving for autofocus and raced it for every press.
	pelco-d|pelco-xm)
		mj_ptz > /dev/null 2>&1
		case $? in
			0) pelco_ok=1 ;;
			3) pelco_why="This camera has no PTZ driver installed: add the majestic-af package to its firmware." ;;
			1) pelco_why="This camera reports no motorized lens." ;;
			# Could not ask is not an answer about the hardware: keep the
			# verb reachable and let the attempt report its own failure.
			*) pelco_ok=1 ;;
		esac
		;;
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

# The verb is matched against the closed list, never passed through. majestic
# validates it too — the word becomes a frame on a wire, and it refuses
# anything not in its own table — but this endpoint must not be the layer that
# relies on that. (day/night exist on the Pelco-D wire but are lens
# maintenance, not viewing controls: reachable by name through majestic, never
# from here.) Both Pelco variants take the same nine verbs, which is why one
# pad serves them both.
# Is majestic's autofocus engine switched on?
#
# Asked separately from the rest of the gate so that "the camera did not
# answer" cannot arrive at the operator as "Autofocus not available on this
# camera." -- a confident statement about the hardware, drawn from a request
# that failed. A camera that cannot be asked keeps the button and lets the
# attempt report its own failure; only a camera that answered and said no
# withdraws it.
af_configured() {
	_af=$(mj_cfg isp.autofocus.enabled)
	case $? in
		0) [ "$_af" = "true" ] ;;
		1) return 1 ;;
		*) return 0 ;;
	esac
}

af_enabled() {
	# The same three gates the pad's af_support carries: a usable backend
	# (unset/none ptz_control keeps every PTZ procedure inactive, the #227
	# ruling — the engine drives a motor this camera must actually have),
	# the focus axis, and majestic's engine turned on.
	{ [ "$pelco_ok" = 1 ] || [ "$gpio_ok" = 1 ] || [ "$motor_ok" = 1 ]; } &&
		has_cap focus &&
		af_configured
}

if [ -n "$ACTION" ]; then
	# Autofocus is majestic's engine, not a pelco verb: the daemon reads the
	# ISP's focus statistic and drives the same motor it drives for the pad.
	# The request stays open while the pass runs — request lifetime is how the
	# pad paces itself — but the trigger answers immediately, so a poll loop
	# stands in for the pass's duration.
	if [ "$ACTION" = "af" ]; then
		if ! af_enabled; then
			echo "Autofocus not available on this camera."
			exit 1
		fi
		r=$(curl -s -m 2 "http://127.0.0.1/autofocus")
		case "$r" in
			# `restarted` is what the engine answers when this trigger
			# preempted a pass that was already running and re-armed it —
			# a second press, which is a legitimate "the scene changed, go
			# again". It was missing here, so the one case where autofocus
			# had most obviously just started was reported as a camera that
			# never answered.
			started|restarted|busy) ;;
			*)
				# A transport failure is not a pass: say so and fail, or the
				# pad reads a dead engine as instant success.
				echo "Autofocus: engine did not answer."
				exit 1
				;;
		esac
		# Hold the request while the pass runs — request lifetime is how the
		# pad paces itself. An empty poll is a transport blip and is retried
		# inside the same budget, never read as completion: releasing early
		# would let a held button fire again while the engine owns the port.
		i=0
		s="running"
		while [ $i -lt 60 ]; do
			sleep 1
			s=$(curl -s -m 2 "http://127.0.0.1/autofocus/status")
			case "$s" in
				running|"") i=$((i + 1)) ;;
				*) break ;;
			esac
		done
		echo "Autofocus: ${s:-unknown}"
		case "$s" in
			done*) exit 0 ;;
			*) exit 1 ;;
		esac
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
				# One request per press, and one more every quarter second
				# while the button is held: each re-arms the camera's own
				# auto-stop deadline, so the motor runs continuously and
				# stops by itself if the release never arrives. The
				# follow-up focus after a zoom is booked inside majestic
				# now -- it knows when the operator stopped driving, which
				# is what the old ?settle call was trying to guess from a
				# lock file.
				out=$(mj_ptz "$ACTION")
				rc=$?
				[ -n "$out" ] && echo "$out"
				exit $rc
				;;
		esac
		echo "Unknown PTZ action."
		exit 1
	fi
	echo "${pelco_why:-Pelco PTZ not available on this device.}"
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
