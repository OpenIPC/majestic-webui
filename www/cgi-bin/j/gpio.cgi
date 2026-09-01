#!/bin/sh
# The GPIO pads, and the one dangerous thing you can do to them.
#
# Two jobs the browser cannot do for itself:
#
#   (no query)         enumerate the pads and say what each one already is
#   ?unset=<keys>      remove nightMode pin keys from the config outright
#   ?pair=<a>,<b>      drive a high against b low, then brake both
#   ?park=<a>,<b>      brake both (mode=brake) or release both (mode=float)
#
# Pad COUNT is a property of the SoC and is never assumed: /sys/class/gpio/
# gpiochip* carries base and ngpio for every bank the kernel registered, which
# is 9 banks on most HiSilicon V2/V3, 10 on EV300/DV200 and 17 on a 3516AV100.
# Novatek numbers its pads in the 200s. Anything here that hardcoded 80 would be
# wrong on most cameras in the field.
#
# Pairs, not single pads, because a single pad cannot move an IR-cut filter.
# Measured on a XiongMai 85H50AI, every state that involves only low and float:
#
#   float either pad          -> filter OPEN   (the brake is released)
#   both pads low             -> holds whatever position it is in, no current
#   pad A high, pad B low     -> moves one way
#   pad B high, pad A low     -> moves the other way
#
# So the filter is driven by an H-bridge across TWO pads and only a driven pair
# actuates it. An earlier version of this endpoint pulsed one pad at a time and
# found nothing it could trust: what it saw was the filter springing open
# because the pad had been handed back floating, which is a change the pulse did
# not cause. That is also why `park` exists — a caller that has moved the filter
# has to be able to hold it, and on a brake-held board holding it IS both pads
# low.
#
# This is the only endpoint in j/ that can brick a camera, so every guard below
# is load-bearing rather than tidy.

QS="$QUERY_STRING"
PAIR=""
PARK=""
MODE=""
MS=""
CLEAR=""
UNSET=""
for param in $(echo "$QS" | tr '&' ' '); do
	case "$param" in
		pair=*) PAIR="${param#*=}" ;;
		park=*) PARK="${param#*=}" ;;
		mode=*) MODE="${param#*=}" ;;
		ms=*) MS="${param#*=}" ;;
		clear=*) CLEAR="${param#*=}" ;;
		unset=*) UNSET="${param#*=}" ;;
	esac
done

# "<a>,<b>" -> two small unsigned integers, or nothing at all.
DRIVE=""
LOWPAD=""
case "$PAIR" in
	*,*)
		DRIVE="${PAIR%%,*}"
		LOWPAD="${PAIR#*,}"
		;;
esac
case "$PARK" in
	*,*)
		[ -z "$DRIVE" ] && DRIVE="${PARK%%,*}" && LOWPAD="${PARK#*,}"
		;;
esac
echo "$DRIVE" | grep -qE '^[0-9]{1,4}$' || DRIVE=""
echo "$LOWPAD" | grep -qE '^[0-9]{1,4}$' || LOWPAD=""
[ "$DRIVE" = "$LOWPAD" ] && LOWPAD=""

# Small unsigned integers only — these become a path under /sys and the argument
# of a write that moves hardware.

echo "$MS" | grep -qE '^[0-9]{1,4}$' || MS=120
# A coil wants a pulse, not a hold. An IR-cut winding is sized for a brief
# actuation and BURNS OUT if current is left flowing through it, so the ceiling
# here is a hardware limit, not a tuning knob: no request may ask for longer,
# whatever it sends.
[ "$MS" -lt 40 ] && MS=40
[ "$MS" -gt 400 ] && MS=400

LOCK=/tmp/webui/ircut-pulse.lock
COOLDOWN_US=250000

STATE=/etc/webui/ircut-scan.json

json_head() {
	echo "HTTP/1.1 200 OK
Content-type: application/json; charset=UTF-8
Cache-Control: no-store
Pragma: no-cache
"
}

# ── what the kernel says exists ─────────────────────────────────────────────
# Every bank the kernel registered, as "base ngpio" lines.
banks() {
	for c in /sys/class/gpio/gpiochip*; do
		[ -r "$c/base" ] && [ -r "$c/ngpio" ] || continue
		echo "$(cat "$c/base") $(cat "$c/ngpio")"
	done | sort -n
}

# Who holds each line, from debugfs, as "pin owner dir" lines:
#
#   gpio-10  (                    |sysfs               ) out lo
#
# Better than counting /sys/class/gpio exports, and the difference matters. A
# line held by a DRIVER is hardware somebody wired on purpose — a reset, a
# regulator enable — and must never be pulsed. A line held by "sysfs" is only
# somebody's export, which on OpenIPC means majestic, and majestic never
# releases a pad when its nightMode key is deleted; that one is reclaimable.
#
# debugfs is not mounted everywhere and this is best-effort: without it the
# endpoint still enumerates and still refuses configured pads, it just cannot
# name an owner.
held() {
	d=/sys/kernel/debug/gpio
	[ -r "$d" ] || return 0
	sed -n 's/^[[:space:]]*gpio-\([0-9]\+\)[[:space:]]*(\([^)]*\)).*/\1 \2/p' "$d" 2>/dev/null |
		while read -r pin rest; do
			# "   name  |owner   " -> owner, trimmed
			own=$(echo "$rest" | sed 's/.*|//; s/^[[:space:]]*//; s/[[:space:]]*$//')
			[ -n "$own" ] || own=unknown
			echo "$pin $own"
		done
}

in_range() {
	banks | while read -r base n; do
		[ "$1" -ge "$base" ] && [ "$1" -lt $((base + n)) ] && echo yes && break
	done | grep -q yes
}

# Pads already exported are somebody's — majestic's own ircut/lamp/sensor pins
# among them. Driving one behind its owner's back is how you make a filter
# fight itself.
exported() {
	for d in /sys/class/gpio/gpio[0-9]*; do
		[ -d "$d" ] || continue
		echo "${d##*/gpio}"
	done
}

# Pads this camera has already been told about, from majestic's own config and
# from U-Boot. They are not candidates — they are answers.
assigned() {
	for k in irCutPin1 irCutPin2 backlightPin lightSensorPin; do
		v=$(yaml-cli -g ".nightMode.$k" 2>/dev/null)
		echo "$v" | grep -qE '^[0-9]+$' && echo "$v $k"
	done
	for e in ptz_gpio gpio_motors; do
		for v in $(fw_printenv -n "$e" 2>/dev/null | tr ',' ' '); do
			echo "$v" | grep -qE '^[0-9]+$' && echo "$v ptz"
		done
	done
}

# ── the journal ─────────────────────────────────────────────────────────────
# Written BEFORE a pad is driven and synced, because the whole point is to
# survive the pad that stops the camera answering. On the next boot the WebUI
# compares `started` against the kernel's boot time: a journal whose pulse began
# before this boot means that pad took the camera down, and it is excluded
# rather than tried again.
boot_epoch() {
	up=$(cut -d' ' -f1 /proc/uptime 2>/dev/null | cut -d. -f1)
	echo $(( $(date +%s) - ${up:-0} ))
}

read_state() {
	# Anything that is not a plausible object is reported as no journal at all:
	# this value is interpolated straight into the response, so a truncated file
	# would take the whole document's JSON down with it.
	if [ -r "$STATE" ] && [ -s "$STATE" ]; then
		j=$(tr -d '[:cntrl:]' < "$STATE")
		case "$j" in
			'{'*'}') echo "$j"; return ;;
		esac
	fi
	echo '{}'
}

if [ "$CLEAR" = "1" ]; then
	rm -f "$STATE"
	sync
	json_head
	echo '{"cleared":true}'
	exit 0
fi

# ── unset pin keys ──────────────────────────────────────────────────────────
# Majestic's config API can set a key but not remove one. POSTing "" or null to
# an integer writes **0** — and 0 is a real GPIO — so "not connected" saved
# through the ordinary form gives you a camera configured to drive pad 0, with
# no missing-pin warning anywhere because the key is, technically, set.
#
# yaml-cli is the sanctioned way to edit that file, so removal goes through it
# here. The key list is a CLOSED whitelist: these names reach a command line,
# and the four pin keys are the only ones this endpoint has any business
# removing.
if [ -n "$UNSET" ]; then
	json_head
	done_keys=""
	failed_keys=""
	for k in $(echo "$UNSET" | tr ',' ' '); do
		case "$k" in
			irCutPin1|irCutPin2|backlightPin|lightSensorPin)
				yaml-cli -d ".nightMode.$k" >/dev/null 2>&1
				# Judged on the file, not on the exit status. `yaml-cli -d`
				# returns 1 for a key that was already absent as well as for one
				# it could not remove, so the status cannot tell success from
				# failure — but reading the key back can. A delete that did not
				# take must not be reported as one, or the caller carries on
				# believing a coil is disconnected while it is still configured
				# as pad 0.
				if yaml-cli -g ".nightMode.$k" >/dev/null 2>&1; then
					failed_keys="$failed_keys $k"
				else
					done_keys="$done_keys $k"
				fi
				;;
		esac
	done
	# Majestic re-reads the file on SIGHUP; without it the daemon keeps driving
	# the pads the deleted keys named. Backgrounded behind a short sleep,
	# because majestic is the httpd serving THIS request — signalling it inline
	# reloads the process mid-response and the caller gets nothing back.
	[ -n "$done_keys" ] && (sleep 1; killall -1 majestic) >/dev/null 2>&1 &
	u=$(for k in $done_keys; do printf '"%s",' "$k"; done)
	fl=$(for k in $failed_keys; do printf '"%s",' "$k"; done)
	printf '{"unset":[%s],"failed":[%s]}\n' "${u%,}" "${fl%,}"
	exit 0
fi

# ── drive a pair ────────────────────────────────────────────────────────────
if [ -n "$DRIVE" ] && [ -n "$LOWPAD" ]; then
	json_head
	deny() { printf '{"drive":%s,"low":%s,"done":false,"error":"%s"}\n' \
		"${DRIVE:-0}" "${LOWPAD:-0}" "$1"; exit 0; }

	for pad in "$DRIVE" "$LOWPAD"; do
		in_range "$pad" || deny "no such pad on this SoC"
		# A line a DRIVER claimed is wired to something on purpose and is the
		# class of pad that resets a PHY or drops a rail. "sysfs" is only an
		# export — majestic's, and it keeps IR-cut pads driven because on a
		# brake-held board that is what holds the filter — so those stay usable.
		for line in $(held | sed 's/ /:/'); do
			pp="${line%%:*}"; own="${line#*:}"
			if [ "$pp" = "$pad" ] && [ "$own" != "sysfs" ]; then
				deny "pad $pad is held by the kernel driver \\\"$own\\\""
			fi
		done
		for v in $(assigned | cut -d' ' -f1); do
			[ "$v" = "$pad" ] && deny "pad $pad is already assigned"
		done
	done

	# One actuation at a time, camera-wide. Two overlapping requests could
	# energise two windings at once, or the same one twice with no gap — and a
	# coil fails by burning, quietly and permanently.
	mkdir -p /tmp/webui 2>/dev/null
	exec 9>"$LOCK"
	flock -n 9 2>/dev/null || deny "another actuation is already running"

	# Journal both pads before either is touched, and get it onto flash. The
	# journal that matters describes a camera that has stopped answering, so
	# this is the one write whose failure must stop the actuation: with a full
	# or read-only overlay there would be no record, and the pair that took the
	# camera down would be offered again on the next scan.
	#
	# Written to a temporary file and renamed, never truncated in place. The
	# enumeration path reads this file, and a reader that arrives between the
	# truncate and the write gets an empty one — which lands in its response as
	# a bare `"scan":` and makes the whole JSON unparseable.
	journal() {
		printf '{"pins":[%s,%s],"started":%s,"boot":%s%s}\n' \
			"$DRIVE" "$LOWPAD" "$(date +%s)" "$(boot_epoch)" "$1" > "$STATE.tmp" 2>/dev/null ||
			return 1
		[ -s "$STATE.tmp" ] || return 1
		sync
		mv "$STATE.tmp" "$STATE" 2>/dev/null || return 1
		sync
		return 0
	}
	journal "" || deny "could not record which pads are about to be driven"

	# How each pad was being held, so it can be handed back the same way. On a
	# brake-held board the difference between "driven low" and "floating" IS the
	# difference between closed and open, so restoring it wrongly moves the
	# filter as surely as driving it would.
	remember() {
		if [ -d "/sys/class/gpio/gpio$1" ]; then
			echo "$(cat "/sys/class/gpio/gpio$1/direction" 2>/dev/null) $(cat "/sys/class/gpio/gpio$1/value" 2>/dev/null)"
		else
			echo "absent 0"
		fi
	}
	dstate=$(remember "$DRIVE")
	lstate=$(remember "$LOWPAD")
	dheld=1; lheld=1
	[ "${dstate% *}" = "absent" ] && dheld=0
	[ "${lstate% *}" = "absent" ] && lheld=0

	# De-energise on EVERY exit. A client that hangs up mid-actuation kills this
	# script between the write that raises a pad and the write that would lower
	# it, and a pad left high is current left in a winding that cannot take it.
	# Braking (both low) is the safe resting state on either kind of filter: it
	# holds a brake-held one where it is and does nothing to a latching one.
	brake() {
		for pad in "$DRIVE" "$LOWPAD"; do
			[ -d "/sys/class/gpio/gpio$pad" ] || continue
			echo out > "/sys/class/gpio/gpio$pad/direction" 2>/dev/null
			echo 0 > "/sys/class/gpio/gpio$pad/value" 2>/dev/null
		done
	}
	trap 'brake' EXIT INT TERM HUP PIPE

	[ "$dheld" = 0 ] && echo "$DRIVE" > /sys/class/gpio/export 2>/dev/null
	[ "$lheld" = 0 ] && echo "$LOWPAD" > /sys/class/gpio/export 2>/dev/null

	ok=1
	if [ -d "/sys/class/gpio/gpio$DRIVE" ] && [ -d "/sys/class/gpio/gpio$LOWPAD" ]; then
		# Both low first: a defined starting point, and the brake state.
		echo out > "/sys/class/gpio/gpio$LOWPAD/direction" 2>/dev/null || ok=0
		echo 0 > "/sys/class/gpio/gpio$LOWPAD/value" 2>/dev/null || ok=0
		echo out > "/sys/class/gpio/gpio$DRIVE/direction" 2>/dev/null || ok=0
		echo 0 > "/sys/class/gpio/gpio$DRIVE/value" 2>/dev/null || ok=0
		usleep 50000 2>/dev/null || sleep 0.1

		if [ "$MODE" != "float" ] && [ -z "$PARK" ]; then
			# The actuation: one side high across the bridge, briefly.
			echo 1 > "/sys/class/gpio/gpio$DRIVE/value" 2>/dev/null || ok=0
			usleep $((MS * 1000)) 2>/dev/null || sleep 0.2
			echo 0 > "/sys/class/gpio/gpio$DRIVE/value" 2>/dev/null
		fi
	else
		ok=0
	fi

	trap - EXIT INT TERM HUP PIPE

	if [ "$MODE" = "float" ]; then
		# Releasing the brake is how a brake-held filter is allowed to spring
		# open, and it is the classification test as well: float after a
		# successful close, and a filter that opens is brake-held while one that
		# stays is latching. It also returns a ruled-out pad to the state the
		# scan found it in.
		for pad in "$DRIVE" "$LOWPAD"; do
			[ -d "/sys/class/gpio/gpio$pad" ] || continue
			echo in > "/sys/class/gpio/gpio$pad/direction" 2>/dev/null
		done
		# Unexport unconditionally, not just what this request exported. float
		# is a caller SAYING "give these back", and by the time it arrives the
		# pads are exported from the actuation that preceded it — a separate
		# request, so they look like somebody else's. Judging by who exported
		# them leaves a sysfs entry behind for every pair a scan rules out.
		# Nothing assigned can reach here; the guard above refused it.
		echo "$DRIVE" > /sys/class/gpio/unexport 2>/dev/null
		echo "$LOWPAD" > /sys/class/gpio/unexport 2>/dev/null
	else
		# Everything else leaves the pair BRAKED, and that is not tidiness — on
		# a brake-held filter the brake is what holds the position the actuation
		# just reached. Handing the pads back as the call found them would
		# discard the very thing the caller asked for, which is exactly what an
		# earlier version of this did: it actuated, restored the pads to
		# floating, and the filter sprang open before anything could look at it.
		# Braking is zero current, so holding it costs nothing and is safe to
		# leave indefinitely; the caller releases explicitly with mode=float.
		brake
	fi

	journal ',"survived":true'

	# A winding needs time to shed the heat of the last actuation before the
	# next, and a scan works through pairs without pausing to think.
	usleep "$COOLDOWN_US" 2>/dev/null || sleep 1

	printf '{"drive":%s,"low":%s,"done":%s,"ms":%s,"mode":"%s"}\n' \
		"$DRIVE" "$LOWPAD" "$([ "$ok" = 1 ] && echo true || echo false)" "$MS" \
		"${MODE:-pulse}"
	exit 0
fi

# ── enumerate ───────────────────────────────────────────────────────────────
json_head

b=$(banks | while read -r base n; do printf '{"base":%s,"n":%s},' "$base" "$n"; done)
ex=$(exported | while read -r p; do printf '%s,' "$p"; done)
as=$(assigned | while read -r v k; do printf '{"pin":%s,"role":"%s"},' "$v" "$k"; done)
# Owner names come from debugfs and are kernel-supplied, but they land inside a
# JSON string, so they get the same two escapes every other device-written value
# in this tree gets.
hd=$(held | while read -r p own; do
	own=$(echo "$own" | tr -d '[:cntrl:]' | sed 's/\\/\\\\/g; s/"/\\"/g')
	printf '{"pin":%s,"owner":"%s"},' "$p" "$own"
done)

printf '{"banks":[%s],"exported":[%s],"assigned":[%s],"held":[%s],"boot":%s,"now":%s,"scan":%s}\n' \
	"${b%,}" "${ex%,}" "${as%,}" "${hd%,}" "$(boot_epoch)" "$(date +%s)" "$(read_state)"
