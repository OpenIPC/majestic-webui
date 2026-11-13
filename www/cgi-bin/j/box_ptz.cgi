#!/bin/sh
# 3D Positioning / Box PTZ handler:
# Centers the physical Pan/Tilt head on a dragged rectangle (dx, dy)
# scaled by the current Field of View (1.0x wide .. 57.0x tele),
# and drives closed-loop optical zoom to target_mag (or mag * zoom_factor),
# followed by an automatic focus pass.
# Also updates /etc/ptz_pos.conf so Presets stay synchronized.

POS_FILE="/tmp/ptz_pos.conf"

read_pos() {
	PAN_MS=0
	TILT_MS=0
	FOCUS_MS=0
	if [ -f "$POS_FILE" ]; then
		. "$POS_FILE" 2>/dev/null
	elif [ -f /etc/ptz_pos.conf ]; then
		. /etc/ptz_pos.conf 2>/dev/null
	fi
	case "$PAN_MS" in ''|*[!0-9-]*) PAN_MS=0 ;; esac
	case "$TILT_MS" in ''|*[!0-9-]*) TILT_MS=0 ;; esac
	case "$FOCUS_MS" in ''|*[!0-9-]*) FOCUS_MS=0 ;; esac
}

write_pos() {
	printf "PAN_MS=%s\nTILT_MS=%s\nFOCUS_MS=%s\n" "$1" "$2" "${3:-$FOCUS_MS}" > "${POS_FILE}.tmp" && mv "${POS_FILE}.tmp" "$POS_FILE"
}

get_current_mag() {
	z=""
	if [ -x /usr/bin/motorsctl ] && [ -S /run/motorsd.sock ]; then
		z=$(/usr/bin/motorsctl --socket /run/motorsd.sock '{"version":1,"id":"mag","op":"status"}' 2>/dev/null | sed -n 's/.*"zoom_magnification":[[:space:]]*\([0-9.]*\).*/\1/p')
	fi
	if [ -z "$z" ] && [ -f /etc/majestic-af.zoom ]; then
		z=$(head -n 1 /etc/majestic-af.zoom 2>/dev/null | tr -d '\r\n ')
	fi
	case "$z" in
		''|*[!0-9.]*) echo "" ;;
		*) echo "$z" ;;
	esac
}

motor_service_ready() {
	[ -x /usr/bin/motors-cli ] && [ -x /usr/bin/motorsctl ] && [ -S /run/motorsd.sock ]
}

drive_axis_ms() {
	drv_dir="$1"
	drv_rem="$2"
	while [ "$drv_rem" -ge 30 ]; do
		if [ "$drv_rem" -gt 3500 ]; then
			drv_chunk=3500
		else
			drv_chunk="$drv_rem"
		fi
		/usr/bin/motors-cli --socket /run/motorsd.sock "$drv_dir" "$drv_chunk" >/dev/null 2>&1 || return 1
		drv_rem=$((drv_rem - drv_chunk))
		if [ "$drv_rem" -ge 30 ]; then
			usleep 80000 2>/dev/null || sleep 1
		fi
	done
	return 0
}

if [ "$REQUEST_METHOD" != "POST" ]; then
	cur_mag=$(get_current_mag)
	read_pos
	echo "HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store

{\"ok\":true,\"current_mag\":${cur_mag:-null},\"pos_pan_ms\":$PAN_MS,\"pos_tilt_ms\":$TILT_MS}"
	exit 0
fi

if ! motor_service_ready; then
	echo "HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store

{\"ok\":false,\"error\":\"Motor service is unavailable\"}"
	exit 0
fi

if ! mkdir /tmp/ptz_job.lock 2>/dev/null; then
	echo "HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store

{\"ok\":false,\"error\":\"Another PTZ move is in progress\"}"
	exit 0
fi
trap 'rmdir /tmp/ptz_job.lock 2>/dev/null || true' EXIT

DX="0"
DY="0"
ZOOM_FACTOR="1.0"
TARGET_MAG=""
PAN_SCALE="10600"
TILT_SCALE="6400"
INV_PAN="0"
INV_TILT="0"

for param in $(echo "$QUERY_STRING" | tr '&' ' '); do
	case "$param" in
		dx=*) DX="${param#*=}" ;;
		dy=*) DY="${param#*=}" ;;
		zoom_factor=*) ZOOM_FACTOR="${param#*=}" ;;
		target_mag=*) TARGET_MAG="${param#*=}" ;;
		pan_scale=*) PAN_SCALE="${param#*=}" ;;
		tilt_scale=*) TILT_SCALE="${param#*=}" ;;
		inv_pan=*) INV_PAN="${param#*=}" ;;
		inv_tilt=*) INV_TILT="${param#*=}" ;;
	esac
done

echo "$DX" | grep -qE '^-?[0-9]+(\.[0-9]+)?$' || DX="0"
echo "$DY" | grep -qE '^-?[0-9]+(\.[0-9]+)?$' || DY="0"
echo "$ZOOM_FACTOR" | grep -qE '^[0-9]+(\.[0-9]+)?$' || ZOOM_FACTOR="1.0"
echo "$TARGET_MAG" | grep -qE '^[0-9]+(\.[0-9]+)?$' || TARGET_MAG=""
echo "$PAN_SCALE" | grep -qE '^[0-9]{2,5}$' || PAN_SCALE="10600"
echo "$TILT_SCALE" | grep -qE '^[0-9]{2,5}$' || TILT_SCALE="6400"

cur_mag=$(get_current_mag)
if [ -z "$cur_mag" ]; then
	echo "HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store

{\"ok\":false,\"error\":\"Current zoom magnification is unavailable\"}"
	exit 0
fi

plan=$(awk -v dx="$DX" -v dy="$DY" -v zf="$ZOOM_FACTOR" -v req_tmag="$TARGET_MAG" \
	-v mag="$cur_mag" -v pscale="$PAN_SCALE" -v tscale="$TILT_SCALE" \
	-v ip="$INV_PAN" -v it="$INV_TILT" 'BEGIN {
	if (mag < 1.0) mag = 1.0;
	if (ip == "1") dx = -dx;
	if (it == "1") dy = -dy;

	# FOV narrows as magnification increases (~10x narrower at 57x than 1x)
	fov_scale = 0.05 + (0.95 / (1.0 + 0.35 * (mag - 1.0)));

	pdir = (dx < 0) ? "left" : "right";
	adx = (dx < 0) ? -dx : dx;
	if (adx < 0.02) {
		pdir = "none";
		pms = 0;
	} else {
		pms = int(100 + (adx * pscale * fov_scale));
		if (pms < 140) pms = 140;
		if (pms > 12000) pms = 12000;
	}

	tdir = (dy < 0) ? "up" : "down";
	ady = (dy < 0) ? -dy : dy;
	if (ady < 0.02) {
		tdir = "none";
		tms = 0;
	} else {
		tms = int(100 + (ady * tscale * fov_scale));
		if (tms < 140) tms = 140;
		if (tms > 8000) tms = 8000;
	}

	if (req_tmag != "") {
		tmag = req_tmag + 0.0;
	} else {
		if (zf < 1.0) zf = 1.0;
		if (zf > 57.0) zf = 57.0;
		tmag = mag * zf;
	}
	if (tmag < 1.0) tmag = 1.0;
	if (tmag > 57.0) tmag = 57.0;
	printf "%s|%d|%s|%d|%.1f", pdir, pms, tdir, tms, tmag;
}')

pdir=$(echo "$plan" | cut -d'|' -f1)
pms=$(echo "$plan" | cut -d'|' -f2)
tdir=$(echo "$plan" | cut -d'|' -f3)
tms=$(echo "$plan" | cut -d'|' -f4)
tmag=$(echo "$plan" | cut -d'|' -f5)

read_pos
if [ "$pdir" = "right" ] && [ "$pms" -gt 0 ]; then
	PAN_MS=$((PAN_MS + pms))
elif [ "$pdir" = "left" ] && [ "$pms" -gt 0 ]; then
	PAN_MS=$((PAN_MS - pms))
fi
if [ "$tdir" = "up" ] && [ "$tms" -gt 0 ]; then
	TILT_MS=$((TILT_MS + tms))
elif [ "$tdir" = "down" ] && [ "$tms" -gt 0 ]; then
	TILT_MS=$((TILT_MS - tms))
fi

run_box_ptz() {
	/usr/bin/motors-cli --socket /run/motorsd.sock stop >/dev/null 2>&1
	usleep 100000 2>/dev/null || true

	if [ "$pms" -gt 0 ] && [ "$pdir" != "none" ]; then
		drive_axis_ms "$pdir" "$pms" || return 1
		usleep 120000 2>/dev/null || sleep 1
	fi
	if [ "$tms" -gt 0 ] && [ "$tdir" != "none" ]; then
		drive_axis_ms "$tdir" "$tms" || return 1
		usleep 120000 2>/dev/null || sleep 1
	fi

	# Closed-loop optical zoom toward target_mag (supports both tele & wide)
	step=0
	prev_mag=""
	stall=0
	while [ "$step" -lt 30 ]; do
		now_mag=$(get_current_mag)
		[ -n "$now_mag" ] || break
		if [ "$now_mag" = "$prev_mag" ]; then
			stall=$((stall + 1))
			[ "$stall" -ge 6 ] && break
		else
			stall=0
		fi
		prev_mag="$now_mag"

		zcmd=$(awk -v cur="$now_mag" -v tgt="$tmag" -v stall="$stall" 'BEGIN {
			d = tgt - cur;
			ad = (d < 0) ? -d : d;
			if (tgt <= 1.15) {
				if (cur <= 1.15) { print "done 0"; exit; }
			} else if (tgt >= 56.5) {
				if (cur >= 56.5) { print "done 0"; exit; }
			} else {
				tol = (tgt > 15.0) ? 0.8 : 0.4;
				if (ad <= tol) { print "done 0"; exit; }
			}
			dir = (d > 0) ? "tele" : "wide";
			rate = (cur < 6.0 || tgt < 6.0) ? 250 : ((cur < 15.0 || tgt < 15.0) ? 140 : 60);
			ms = int(ad * rate * (1.0 + stall * 0.5));
			min_ms = (tgt <= 1.15 && cur > 1.5) ? 450 : 200;
			if (ms < min_ms) ms = min_ms;
			if (ms > 2500) ms = 2500;
			print dir " " ms;
		}')
		zdir="${zcmd%% *}"
		zpulse="${zcmd#* }"
		[ "$zdir" = "done" ] && break
		[ "$zpulse" -gt 0 ] 2>/dev/null || break
		/usr/bin/motors-cli --socket /run/motorsd.sock "$zdir" "$zpulse" >/dev/null 2>&1
		usleep 200000 2>/dev/null || sleep 1
		step=$((step + 1))
	done
}

run_box_ptz >/dev/null 2>&1 || {
	echo "HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store

{\"ok\":false,\"error\":\"Motor move failed\"}"
	exit 0
}
write_pos "$PAN_MS" "$TILT_MS"

echo "HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store

{\"ok\":true,\"pan_dir\":\"$pdir\",\"pan_ms\":$pms,\"tilt_dir\":\"$tdir\",\"tilt_ms\":$tms,\"start_mag\":$cur_mag,\"target_mag\":$tmag,\"pos_pan_ms\":$PAN_MS,\"pos_tilt_ms\":$TILT_MS}"
