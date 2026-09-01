#!/bin/sh
# The GPIO pads, and what each one already is.
#
# One job the browser cannot do for itself: enumerate the pads, and say for each
# whether anything already owns it.
#
# Pad COUNT is a property of the SoC and is never assumed: /sys/class/gpio/
# gpiochip* carries base and ngpio for every bank the kernel registered, which
# is 9 banks on most HiSilicon V2/V3, 10 on EV300/DV200 and 17 on a 3516AV100.
# Novatek numbers its pads in the 200s. Anything here that hardcoded 80 would be
# wrong on most cameras in the field.
#
# Read-only: it reports what the kernel already knows and changes nothing. The
# pin map (a/ircut-map.js) is its only consumer.

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
# regulator enable — and is not a pad to offer. A line held by "sysfs" is only
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

printf '{"banks":[%s],"exported":[%s],"assigned":[%s],"held":[%s]}\n' \
	"${b%,}" "${ex%,}" "${as%,}" "${hd%,}"
