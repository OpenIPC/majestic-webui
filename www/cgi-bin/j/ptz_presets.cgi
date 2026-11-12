#!/bin/sh
# CGI endpoint for Named PTZ & Focus Presets
# Stores presets in /etc/ptz_presets.tsv:
#   id|name|mag|run_af|zoom_restore|pan_ms|tilt_ms
# Tracks dead-reckoned open-loop pan/tilt position in /etc/ptz_pos.conf
# (stored on persistent /etc flash so it survives reboots).

PRESETS_FILE="/etc/ptz_presets.tsv"
POS_FILE="/tmp/ptz_pos.conf"

if [ ! -f "$PRESETS_FILE" ]; then
	touch "$PRESETS_FILE" 2>/dev/null
fi

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
	printf "PAN_MS=%s\nTILT_MS=%s\nFOCUS_MS=%s\n" "$1" "$2" "${3:-0}" > "${POS_FILE}.tmp" && mv "${POS_FILE}.tmp" "$POS_FILE"
}

urldecode() {
	printf '%b' "$(echo "$1" | sed 's/+/ /g; s/%\([0-9A-Fa-f][0-9A-Fa-f]\)/\\x\1/g')"
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

send_pelco_preset_cmd() {
	# $1 = cmd2 byte decimal (3=Set, 5=Clear, 7=Call), $2 = preset id (1..32)
	c2="$1"
	pid="$2"
	ck=$(( (1 + c2 + pid) % 256 ))
	hex=$(printf "ff0100%02x00%02x%02x" "$c2" "$pid" "$ck")
	/usr/bin/motorsctl --socket /run/motorsd.sock \
		"{\"version\":1,\"id\":\"webui-preset\",\"op\":\"raw\",\"payload\":{\"bytes\":\"$hex\"}}" >/dev/null 2>&1
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
			usleep 100000 2>/dev/null || sleep 1
		fi
	done
	return 0
}

restore_zoom_and_af() {
	target_mag="$1"
	run_af="$2"
	zoom_restore="$3"
	dpan="$4"
	dtilt="$5"
	dfocus="$6"

	/usr/bin/motors-cli --socket /run/motorsd.sock stop >/dev/null 2>&1
	usleep 120000 2>/dev/null || true

	# 1. Drive Pan delta if needed
	if [ -n "$dpan" ] && [ "$dpan" -ne 0 ] 2>/dev/null; then
		if [ "$dpan" -gt 0 ]; then
			pdir="right"
			pabs="$dpan"
		else
			pdir="left"
			pabs=$((0 - dpan))
		fi
		if [ "$pabs" -ge 30 ]; then
			drive_axis_ms "$pdir" "$pabs" || return 1
			usleep 120000 2>/dev/null || true
		fi
	fi

	# 2. Drive Tilt delta if needed
	if [ -n "$dtilt" ] && [ "$dtilt" -ne 0 ] 2>/dev/null; then
		if [ "$dtilt" -gt 0 ]; then
			tdir="up"
			tabs="$dtilt"
		else
			tdir="down"
			tabs=$((0 - dtilt))
		fi
		if [ "$tabs" -ge 30 ]; then
			drive_axis_ms "$tdir" "$tabs" || return 1
			usleep 120000 2>/dev/null || true
		fi
	fi

	# 3. Closed-loop optical zoom restoration
	if [ "$zoom_restore" = "1" ] && [ -n "$target_mag" ] && [ "$target_mag" != "null" ]; then
		step=0
		prev_mag=""
		stall=0
		while [ "$step" -lt 30 ]; do
			cur_mag=$(get_current_mag)
			[ -n "$cur_mag" ] || break
			if [ "$cur_mag" = "$prev_mag" ]; then
				stall=$((stall + 1))
				[ "$stall" -ge 6 ] && break
			else
				stall=0
			fi
			prev_mag="$cur_mag"

			cmd=$(awk -v cur="$cur_mag" -v tgt="$target_mag" -v stall="$stall" 'BEGIN {
				diff = tgt - cur;
				adiff = (diff < 0) ? -diff : diff;
				if (tgt <= 1.15) {
					if (cur <= 1.15) { print "done 0"; exit; }
				} else if (tgt >= 56.5) {
					if (cur >= 56.5) { print "done 0"; exit; }
				} else {
					tol = (tgt > 15.0) ? 0.8 : 0.4;
					if (adiff < tol) { print "done 0"; exit; }
				}
				dir = (diff > 0) ? "tele" : "wide";
				rate = (cur < 6.0 || tgt < 6.0) ? 250 : ((cur < 15.0 || tgt < 15.0) ? 140 : 60);
				ms = int(adiff * rate * (1.0 + stall * 0.5));
				min_ms = (tgt <= 1.15 && cur > 1.5) ? 450 : 200;
				if (ms < min_ms) ms = min_ms;
				if (ms > 2500) ms = 2500;
				print dir " " ms;
			}')
			zdir="${cmd%% *}"
			zms="${cmd#* }"
			if [ "$zdir" = "done" ] || [ -z "$zdir" ]; then
				break
			fi
			/usr/bin/motors-cli --socket /run/motorsd.sock "$zdir" "$zms" >/dev/null 2>&1
			usleep 200000 2>/dev/null || sleep 1
			step=$((step + 1))
		done
	fi

	# 4. Drive Focus delta if saved
	if [ -n "$dfocus" ] && [ "$dfocus" -ne 0 ] 2>/dev/null; then
		if [ "$dfocus" -gt 0 ]; then
			fdir="far"
			fabs="$dfocus"
		else
			fdir="near"
			fabs=$((0 - dfocus))
		fi
		if [ "$fabs" -ge 30 ]; then
			drive_axis_ms "$fdir" "$fabs" || return 1
			usleep 120000 2>/dev/null || true
		fi
	fi

	# 5. Trigger autofocus if configured for this preset
	if [ "$run_af" = "1" ]; then
		usleep 250000 2>/dev/null || sleep 1
		curl -s -m 2 "http://127.0.0.1/autofocus" >/dev/null 2>&1
	fi
}

json_escape() {
	printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/	/ /g' | tr -d '\r\n'
}

emit_list() {
	extra_msg="$1"
	cur_mag=$(get_current_mag)
	read_pos
	printf '{"ok":true,"current_mag":%s,"pan_ms":%s,"tilt_ms":%s,"focus_ms":%s' "${cur_mag:-null}" "$PAN_MS" "$TILT_MS" "$FOCUS_MS"
	if [ -n "$extra_msg" ]; then
		esc_msg=$(json_escape "$extra_msg")
		printf ',"message":"%s"' "$esc_msg"
	fi
	printf ',"presets":['
	first=1
	if [ -f "$PRESETS_FILE" ]; then
		while IFS='|' read -r pid pname pmag paf pzoom ppan ptilt pfocus; do
			[ -z "$pid" ] && continue
			[ -z "$pmag" ] && pmag="null"
			[ -z "$paf" ] && paf="1"
			[ -z "$pzoom" ] && pzoom="1"
			case "$ppan" in ''|*[!0-9-]*) ppan=0 ;; esac
			case "$ptilt" in ''|*[!0-9-]*) ptilt=0 ;; esac
			case "$pfocus" in ''|*[!0-9-]*) pfocus="null" ;; esac
			esc_name=$(json_escape "$pname")
			if [ "$first" -eq 0 ]; then
				printf ','
			fi
			first=0
			printf '{"id":%s,"name":"%s","mag":%s,"run_af":%s,"zoom_restore":%s,"pan_ms":%s,"tilt_ms":%s,"focus_ms":%s}' \
				"$pid" "$esc_name" "$pmag" "$paf" "$pzoom" "$ppan" "$ptilt" "$pfocus"
		done < "$PRESETS_FILE"
	fi
	printf ']}\n'
}

RAW_QS="$QUERY_STRING"
if [ "$REQUEST_METHOD" = "POST" ]; then
	BODY=$(cat)
	if [ -n "$BODY" ]; then
		RAW_QS="${RAW_QS}&${BODY}"
	fi
fi

ACT="list"
ID=""
NAME=""
RUN_AF="1"
ZOOM_RESTORE="1"
IN_PAN=""
IN_TILT=""
IN_FOCUS=""

for param in $(echo "$RAW_QS" | tr '&' ' '); do
	case "$param" in
		act=*) ACT="${param#*=}" ;;
		id=*) ID=$(echo "${param#*=}" | tr -cd '0-9') ;;
		name=*) NAME=$(urldecode "${param#*=}") ;;
		run_af=*) RUN_AF=$(echo "${param#*=}" | tr -cd '0-1') ;;
		zoom_restore=*) ZOOM_RESTORE=$(echo "${param#*=}" | tr -cd '0-1') ;;
		pan_ms=*) IN_PAN=$(echo "${param#*=}" | tr -cd '0-9-') ;;
		tilt_ms=*) IN_TILT=$(echo "${param#*=}" | tr -cd '0-9-') ;;
		focus_ms=*) IN_FOCUS=$(echo "${param#*=}" | tr -cd '0-9-') ;;
	esac
done

if [ "$ACT" != "list" ] && [ "$REQUEST_METHOD" != "POST" ]; then
	echo "HTTP/1.1 405 Method Not Allowed"
	echo "Allow: POST"
	echo "Content-Type: application/json"
	echo "Cache-Control: no-store"
	echo ""
	echo '{"ok":false,"error":"Use POST for preset actions"}'
	exit 1
fi

echo "Content-Type: application/json"
echo "Cache-Control: no-store, no-cache, must-revalidate"
echo ""

case "$ACT" in
	save)
		if [ -z "$ID" ] || [ "$ID" -lt 1 ] || [ "$ID" -gt 32 ]; then
			echo '{"ok":false,"error":"Preset ID must be between 1 and 32"}'
			exit 0
		fi
		CLEAN_NAME=$(printf '%s' "$NAME" | tr '\t\r\n|' '    ' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | cut -c1-32)
		[ -z "$CLEAN_NAME" ] && CLEAN_NAME="Preset $ID"
		[ -z "$RUN_AF" ] && RUN_AF="1"
		[ -z "$ZOOM_RESTORE" ] && ZOOM_RESTORE="1"

		CUR_MAG=$(get_current_mag)
		read_pos
		SAVE_PAN="$PAN_MS"
		SAVE_TILT="$TILT_MS"
		SAVE_FOCUS="$FOCUS_MS"
		if [ -n "$IN_PAN" ]; then
			case "$IN_PAN" in ''|*[!0-9-]*) ;; *) SAVE_PAN="$IN_PAN" ;; esac
		fi
		if [ -n "$IN_TILT" ]; then
			case "$IN_TILT" in ''|*[!0-9-]*) ;; *) SAVE_TILT="$IN_TILT" ;; esac
		fi
		if [ -n "$IN_FOCUS" ]; then
			case "$IN_FOCUS" in ''|*[!0-9-]*) ;; *) SAVE_FOCUS="$IN_FOCUS" ;; esac
		fi

		if motor_service_ready; then
			send_pelco_preset_cmd 3 "$ID"
		fi

		grep -v "^${ID}|" "$PRESETS_FILE" > "${PRESETS_FILE}.tmp" 2>/dev/null || true
		echo "${ID}|${CLEAN_NAME}|${CUR_MAG}|${RUN_AF}|${ZOOM_RESTORE}|${SAVE_PAN}|${SAVE_TILT}|${SAVE_FOCUS}" >> "${PRESETS_FILE}.tmp"
		sort -t'|' -k1,1n "${PRESETS_FILE}.tmp" > "$PRESETS_FILE"
		rm -f "${PRESETS_FILE}.tmp"

		emit_list "Saved '${CLEAN_NAME}' (Pan ${SAVE_PAN}ms, Tilt ${SAVE_TILT}ms, Focus ${SAVE_FOCUS}ms, Zoom ${CUR_MAG:-unknown}x)"
		;;

	zero)
		write_pos 0 0 0
		emit_list "Current camera direction set as Pan/Tilt/Focus origin (0, 0, 0)"
		;;

	toggle_af)
		if [ -z "$ID" ] || [ "$ID" -lt 1 ] || [ "$ID" -gt 32 ]; then
			echo '{"ok":false,"error":"Invalid preset ID"}'
			exit 0
		fi
		ROW=$(grep "^${ID}|" "$PRESETS_FILE" | head -n 1)
		if [ -z "$ROW" ]; then
			echo '{"ok":false,"error":"Preset not found"}'
			exit 0
		fi
		IFS='|' read -r pid pname pmag paf pzoom ppan ptilt pfocus <<EOF
$ROW
EOF
		[ "$paf" = "1" ] && new_af="0" || new_af="1"
		grep -v "^${ID}|" "$PRESETS_FILE" > "${PRESETS_FILE}.tmp" 2>/dev/null || true
		echo "${pid}|${pname}|${pmag}|${new_af}|${pzoom:-1}|${ppan}|${ptilt}|${pfocus}" >> "${PRESETS_FILE}.tmp"
		sort -t'|' -k1,1n "${PRESETS_FILE}.tmp" > "$PRESETS_FILE"
		rm -f "${PRESETS_FILE}.tmp"
		emit_list ""
		;;

	goto)
		if [ -z "$ID" ] || [ "$ID" -lt 1 ] || [ "$ID" -gt 32 ]; then
			echo '{"ok":false,"error":"Invalid preset ID"}'
			exit 0
		fi
		if ! motor_service_ready; then
			echo '{"ok":false,"error":"Motor service is unavailable"}'
			exit 0
		fi
		if ! mkdir /tmp/ptz_job.lock 2>/dev/null; then
			echo '{"ok":false,"error":"Another PTZ move is in progress"}'
			exit 0
		fi
		trap 'rmdir /tmp/ptz_job.lock 2>/dev/null || true' EXIT
		ROW=$(grep "^${ID}|" "$PRESETS_FILE" | head -n 1)
		if [ -n "$ROW" ]; then
			IFS='|' read -r pid pname pmag paf pzoom ppan ptilt pfocus <<EOF
$ROW
EOF
			case "$ppan" in ''|*[!0-9-]*) ppan=0 ;; esac
			case "$ptilt" in ''|*[!0-9-]*) ptilt=0 ;; esac
			case "$pfocus" in ''|*[!0-9-]*) pfocus="" ;; esac
			read_pos
			DPAN=$((ppan - PAN_MS))
			DTILT=$((ptilt - TILT_MS))
			DFOCUS=""
			NEW_FOCUS="$FOCUS_MS"
			if [ -n "$pfocus" ]; then
				DFOCUS=$((pfocus - FOCUS_MS))
				NEW_FOCUS="$pfocus"
			fi
			if restore_zoom_and_af "$pmag" "$paf" "$pzoom" "$DPAN" "$DTILT" "$DFOCUS"; then
				write_pos "$ppan" "$ptilt" "$NEW_FOCUS"
				emit_list "Moved to '${pname}' (dPan=${DPAN}ms, dTilt=${DTILT}ms)"
			else
				echo '{"ok":false,"error":"Motor move failed"}'
			fi
		else
			echo '{"ok":false,"error":"Preset not found"}'
		fi
		;;

	delete)
		if [ -n "$ID" ] && [ -f "$PRESETS_FILE" ]; then
			if motor_service_ready; then
				send_pelco_preset_cmd 5 "$ID"
			fi
			grep -v "^${ID}|" "$PRESETS_FILE" > "${PRESETS_FILE}.tmp" 2>/dev/null || true
			mv "${PRESETS_FILE}.tmp" "$PRESETS_FILE"
		fi
		emit_list "Preset deleted"
		;;

	*)
		emit_list ""
		;;
esac
