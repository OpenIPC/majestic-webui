#!/bin/sh
# CGI endpoint for Named PTZ & Focus Presets
# Stores presets in /etc/ptz_presets.tsv:
#   id|name|mag|run_af|zoom_restore|pan_ms|tilt_ms
# Tracks dead-reckoned open-loop pan/tilt position in /tmp/ptz_pos.conf
# and persists to /etc/ptz_pos.conf on completed moves/releases.

. "$(dirname "$0")/../p/ptz_common.sh"

PRESETS_FILE="/etc/ptz_presets.tsv"
BOOT_HOME_FILE="/etc/ptz_boot_home"
MAP_BG_FILE="/tmp/ptz_map_bg.jpg"
MAP_BG_META="/tmp/ptz_map_bg.meta"

if [ ! -f "$PRESETS_FILE" ]; then
	touch "$PRESETS_FILE" 2>/dev/null
fi

read_boot_home() {
	if [ -f "$BOOT_HOME_FILE" ]; then
		bh=$(tr -cd '0-9' < "$BOOT_HOME_FILE" 2>/dev/null)
		if [ -n "$bh" ] && grep -q "^${bh}|" "$PRESETS_FILE" 2>/dev/null; then
			echo "$bh"
			return
		fi
	fi
	echo "null"
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

restore_zoom_and_af() {
	target_mag="$1"
	run_af="$2"
	zoom_restore="$3"
	dpan="$4"
	dtilt="$5"
	dfocus="$6"

	: > /tmp/majestic-af.cancel 2>/dev/null || true
	/usr/bin/motorsctl --socket /run/motorsd.sock \
		'{"version":1,"id":"preempt-af","op":"acquire","axis":"focus","role":"manual","lease_ms":50}' >/dev/null 2>&1 || true
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
			ptz_drive_axis_ms "$pdir" "$pabs" automation || return 1
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
			ptz_drive_axis_ms "$tdir" "$tabs" automation || return 1
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
			: > /tmp/majestic-af.cancel 2>/dev/null || true
			/usr/bin/motors-cli --socket /run/motorsd.sock --role automation "$zdir" "$zms" >/dev/null 2>&1 || return 1
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
			ptz_drive_axis_ms "$fdir" "$fabs" automation || return 1
			usleep 120000 2>/dev/null || true
		fi
	fi
	rm -f /tmp/majestic-af.cancel 2>/dev/null || true
	return 0
}

json_escape() {
	printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/	/ /g' | tr -d '\r\n'
}

emit_list() {
	extra_msg="$1"
	cur_mag=$(get_current_mag)
	ptz_read_pos
	boot_home=$(read_boot_home)
	has_bg="false"
	BG_PAN="null"
	BG_TILT="null"
	if [ -s "$MAP_BG_FILE" ]; then
		has_bg="true"
		[ -f "$MAP_BG_META" ] && . "$MAP_BG_META" 2>/dev/null
		case "$BG_PAN" in ''|*[!0-9-]*) BG_PAN="null" ;; esac
		case "$BG_TILT" in ''|*[!0-9-]*) BG_TILT="null" ;; esac
	fi
	printf '{"ok":true,"current_mag":%s,"pan_ms":%s,"tilt_ms":%s,"focus_ms":%s,"boot_home":%s,"has_map_bg":%s,"bg_pan":%s,"bg_tilt":%s' "${cur_mag:-null}" "$PAN_MS" "$TILT_MS" "$FOCUS_MS" "$boot_home" "$has_bg" "$BG_PAN" "$BG_TILT"
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
if [ "$REQUEST_METHOD" = "POST" ] && [ "${CONTENT_LENGTH:-0}" -gt 0 ] 2>/dev/null; then
	BODY=$(dd bs=1 count="$CONTENT_LENGTH" 2>/dev/null)
	if [ -n "$BODY" ]; then
		RAW_QS="${RAW_QS}&${BODY}"
	fi
fi

ACT="list"
ID=""
NAME=""
DIR=""
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
		dir=*) DIR=$(echo "${param#*=}" | tr -cd 'a-z') ;;
		run_af=*) RUN_AF=$(echo "${param#*=}" | tr -cd '0-1') ;;
		zoom_restore=*) ZOOM_RESTORE=$(echo "${param#*=}" | tr -cd '0-1') ;;
		pan_ms=*) IN_PAN=$(echo "${param#*=}" | tr -cd '0-9-') ;;
		tilt_ms=*) IN_TILT=$(echo "${param#*=}" | tr -cd '0-9-') ;;
		focus_ms=*) IN_FOCUS=$(echo "${param#*=}" | tr -cd '0-9-') ;;
	esac
done

if [ "$ACT" = "map_bg" ]; then
	if [ -s "$MAP_BG_FILE" ]; then
		echo "HTTP/1.1 200 OK"
		echo "Content-Type: image/jpeg"
		echo "Cache-Control: no-store"
		echo ""
		cat "$MAP_BG_FILE"
	else
		echo "HTTP/1.1 404 Not Found"
		echo "Content-Type: text/plain"
		echo ""
		echo "No map background image"
	fi
	exit 0
fi

if [ "$ACT" != "list" ] && [ "$REQUEST_METHOD" != "POST" ]; then
	echo "HTTP/1.1 405 Method Not Allowed"
	echo "Allow: POST"
	echo "Content-Type: application/json"
	echo "Cache-Control: no-store"
	echo ""
	echo '{"ok":false,"error":"Use POST for preset actions"}'
	exit 1
fi

[ "$REQUEST_METHOD" = "POST" ] && ptz_reject_cross_site

echo "HTTP/1.1 200 OK"
echo "Content-Type: application/json"
echo "Cache-Control: no-store, no-cache, must-revalidate"
echo ""

acquire_ptz_lock() {
	if mkdir /tmp/ptz_job.lock 2>/dev/null; then
		echo "$$" > /tmp/ptz_job.lock/pid
		return 0
	fi
	if [ -f /tmp/ptz_job.lock/pid ]; then
		old_pid=$(cat /tmp/ptz_job.lock/pid 2>/dev/null)
		if [ -z "$old_pid" ] || ! kill -0 "$old_pid" 2>/dev/null; then
			rm -rf /tmp/ptz_job.lock
			if mkdir /tmp/ptz_job.lock 2>/dev/null; then
				echo "$$" > /tmp/ptz_job.lock/pid
				return 0
			fi
		fi
	else
		rm -rf /tmp/ptz_job.lock
		if mkdir /tmp/ptz_job.lock 2>/dev/null; then
			echo "$$" > /tmp/ptz_job.lock/pid
			return 0
		fi
	fi
	return 1
}

upsert_preset_row() {
	target_id="$1"
	new_row="$2"
	awk -v id="$target_id" -v row="$new_row" '
		BEGIN { done = 0 }
		/^[[:space:]]*$/ { next }
		{
			split($0, f, "|")
			if (f[1] == id) {
				if (!done) { print row; done = 1 }
			} else {
				print $0
			}
		}
		END { if (!done) print row }
	' "$PRESETS_FILE" > "${PRESETS_FILE}.tmp" && mv "${PRESETS_FILE}.tmp" "$PRESETS_FILE"
}

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
		ptz_read_pos
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

		upsert_preset_row "$ID" "${ID}|${CLEAN_NAME}|${CUR_MAG}|${RUN_AF}|${ZOOM_RESTORE}|${SAVE_PAN}|${SAVE_TILT}|${SAVE_FOCUS}"

		emit_list "Saved '${CLEAN_NAME}' (Pan ${SAVE_PAN}ms, Tilt ${SAVE_TILT}ms, Focus ${SAVE_FOCUS}ms, Zoom ${CUR_MAG:-unknown}x)"
		;;

	rename)
		if [ -z "$ID" ] || [ "$ID" -lt 1 ] || [ "$ID" -gt 32 ]; then
			echo '{"ok":false,"error":"Invalid preset ID"}'
			exit 0
		fi
		ROW=$(grep "^${ID}|" "$PRESETS_FILE" | head -n 1)
		if [ -z "$ROW" ]; then
			echo '{"ok":false,"error":"Preset not found"}'
			exit 0
		fi
		CLEAN_NAME=$(printf '%s' "$NAME" | tr '\t\r\n|' '    ' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | cut -c1-32)
		if [ -z "$CLEAN_NAME" ]; then
			echo '{"ok":false,"error":"Preset name cannot be empty"}'
			exit 0
		fi
		IFS='|' read -r pid pname pmag paf pzoom ppan ptilt pfocus <<EOF
$ROW
EOF
		upsert_preset_row "$ID" "${pid}|${CLEAN_NAME}|${pmag}|${paf}|${pzoom:-1}|${ppan}|${ptilt}|${pfocus}"
		emit_list "Renamed preset #${ID} to '${CLEAN_NAME}'"
		;;

	move)
		if [ -z "$ID" ] || [ "$ID" -lt 1 ] || [ "$ID" -gt 32 ]; then
			echo '{"ok":false,"error":"Invalid preset ID"}'
			exit 0
		fi
		if [ "$DIR" != "up" ] && [ "$DIR" != "down" ]; then
			echo '{"ok":false,"error":"Invalid move direction"}'
			exit 0
		fi
		awk -v id="$ID" -v dir="$DIR" '
			/^[[:space:]]*$/ { next }
			{ lines[++n] = $0; split($0, f, "|"); ids[n] = f[1] }
			END {
				for (i = 1; i <= n; i++) {
					if (ids[i] == id) {
						j = (dir == "up") ? i - 1 : i + 1
						if (j >= 1 && j <= n) {
							tmp = lines[i]; lines[i] = lines[j]; lines[j] = tmp
						}
						break
					}
				}
				for (i = 1; i <= n; i++) print lines[i]
			}
		' "$PRESETS_FILE" > "${PRESETS_FILE}.tmp" && mv "${PRESETS_FILE}.tmp" "$PRESETS_FILE"
		emit_list ""
		;;

	zero)
		ptz_read_pos
		if [ -f "$PRESETS_FILE" ] && { [ "$PAN_MS" -ne 0 ] || [ "$TILT_MS" -ne 0 ] || [ "$FOCUS_MS" -ne 0 ]; }; then
			awk -F'|' -v OFS='|' -v dp="$PAN_MS" -v dt="$TILT_MS" -v df="$FOCUS_MS" '
				/^[[:space:]]*$/ { next }
				{
					$6 = ($6 + 0) - dp
					$7 = ($7 + 0) - dt
					if ($8 != "" && $8 != "null") $8 = ($8 + 0) - df
					print $0
				}
			' "$PRESETS_FILE" > "${PRESETS_FILE}.tmp" && mv "${PRESETS_FILE}.tmp" "$PRESETS_FILE"
		fi
		if [ -f "$MAP_BG_META" ] && { [ "$PAN_MS" -ne 0 ] || [ "$TILT_MS" -ne 0 ]; }; then
			BG_PAN=""
			BG_TILT=""
			. "$MAP_BG_META" 2>/dev/null || true
			case "$BG_PAN" in ''|*[!0-9-]*) ;; *) BG_PAN=$((BG_PAN - PAN_MS)) ;; esac
			case "$BG_TILT" in ''|*[!0-9-]*) ;; *) BG_TILT=$((BG_TILT - TILT_MS)) ;; esac
			printf "BG_PAN=%s\nBG_TILT=%s\n" "${BG_PAN:-0}" "${BG_TILT:-0}" > "$MAP_BG_META"
		fi
		ptz_write_pos 0 0 0 1
		emit_list "Current camera direction set as new Origin (0, 0, 0); saved presets shifted to match"
		;;

	shift_all)
		case "$IN_PAN" in ''|*[!0-9-]*) IN_PAN=0 ;; esac
		case "$IN_TILT" in ''|*[!0-9-]*) IN_TILT=0 ;; esac
		if [ -f "$PRESETS_FILE" ] && { [ "$IN_PAN" -ne 0 ] || [ "$IN_TILT" -ne 0 ]; }; then
			awk -F'|' -v OFS='|' -v dp="$IN_PAN" -v dt="$IN_TILT" '
				/^[[:space:]]*$/ { next }
				{
					$6 = ($6 + 0) + dp
					$7 = ($7 + 0) + dt
					print $0
				}
			' "$PRESETS_FILE" > "${PRESETS_FILE}.tmp" && mv "${PRESETS_FILE}.tmp" "$PRESETS_FILE"
		fi
		emit_list "Shifted all presets by Pan ${IN_PAN}ms, Tilt ${IN_TILT}ms"
		;;

	sync_pos)
		if [ -z "$ID" ] || [ "$ID" -lt 1 ] || [ "$ID" -gt 32 ]; then
			echo '{"ok":false,"error":"Invalid preset ID"}'
			exit 0
		fi
		ROW=$(grep "^${ID}|" "$PRESETS_FILE" 2>/dev/null | head -n 1)
		if [ -z "$ROW" ]; then
			echo '{"ok":false,"error":"Preset not found"}'
			exit 0
		fi
		ptz_read_pos
		IFS='|' read -r pid pname pmag paf pzoom ppan ptilt pfocus <<EOF
$ROW
EOF
		case "$ppan" in ''|*[!0-9-]*) ppan=0 ;; esac
		case "$ptilt" in ''|*[!0-9-]*) ptilt=0 ;; esac
		case "$pfocus" in ''|*[!0-9-]*) pfocus="$FOCUS_MS" ;; esac
		ptz_write_pos "$ppan" "$ptilt" "$pfocus" 1
		emit_list "Re-homed camera coordinates to '${pname}' (#${ID}: Pan ${ppan}ms, Tilt ${ptilt}ms)"
		;;

	set_home_here)
		ptz_read_pos
		CUR_MAG=$(get_current_mag)
		bh=$(read_boot_home)
		if [ "$bh" = "null" ] || [ -z "$bh" ]; then
			bh=$(awk -F'|' 'tolower($2) ~ /^home/ { print $1; exit }' "$PRESETS_FILE" 2>/dev/null)
		fi
		if [ -z "$bh" ]; then
			bh=1
			while [ "$bh" -le 32 ]; do
				grep -q "^${bh}|" "$PRESETS_FILE" 2>/dev/null || break
				bh=$((bh + 1))
			done
			[ "$bh" -gt 32 ] && bh=1
		fi
		EXISTING_NAME=""
		EXISTING_AF="0"
		EXISTING_ZOOM="1"
		ROW=$(grep "^${bh}|" "$PRESETS_FILE" 2>/dev/null | head -n 1)
		if [ -n "$ROW" ]; then
			IFS='|' read -r pid pname pmag paf pzoom ppan ptilt pfocus <<EOF
$ROW
EOF
			EXISTING_NAME="$pname"
			[ -n "$paf" ] && EXISTING_AF="$paf"
			[ -n "$pzoom" ] && EXISTING_ZOOM="$pzoom"
		fi
		CLEAN_NAME=$(printf '%s' "$NAME" | tr '\t\r\n|' '    ' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | cut -c1-32)
		[ -z "$CLEAN_NAME" ] && CLEAN_NAME="${EXISTING_NAME:-Home}"
		upsert_preset_row "$bh" "${bh}|${CLEAN_NAME}|${CUR_MAG}|${EXISTING_AF}|${EXISTING_ZOOM}|${PAN_MS}|${TILT_MS}|${FOCUS_MS}"
		printf '%s\n' "$bh" > "$BOOT_HOME_FILE"
		emit_list "Home set to '${CLEAN_NAME}' (#${bh} at Pan ${PAN_MS}ms, Tilt ${TILT_MS}ms, Zoom ${CUR_MAG:-unknown}x)"
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
		upsert_preset_row "$ID" "${pid}|${pname}|${pmag}|${new_af}|${pzoom:-1}|${ppan}|${ptilt}|${pfocus}"
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
		if ! acquire_ptz_lock; then
			echo '{"ok":false,"error":"Another PTZ move is in progress"}'
			exit 0
		fi
		trap 'rm -rf /tmp/ptz_job.lock /tmp/majestic-af.cancel 2>/dev/null || true' EXIT
		ROW=$(grep "^${ID}|" "$PRESETS_FILE" | head -n 1)
		if [ -n "$ROW" ]; then
			IFS='|' read -r pid pname pmag paf pzoom ppan ptilt pfocus <<EOF
$ROW
EOF
			case "$ppan" in ''|*[!0-9-]*) ppan=0 ;; esac
			case "$ptilt" in ''|*[!0-9-]*) ptilt=0 ;; esac
			case "$pfocus" in ''|*[!0-9-]*) pfocus="" ;; esac
			ptz_read_pos
			DPAN=$((ppan - PAN_MS))
			DTILT=$((ptilt - TILT_MS))
			DFOCUS=""
			NEW_FOCUS="$FOCUS_MS"
			if [ -n "$pfocus" ]; then
				DFOCUS=$((pfocus - FOCUS_MS))
				NEW_FOCUS="$pfocus"
			fi
			if restore_zoom_and_af "$pmag" "$paf" "$pzoom" "$DPAN" "$DTILT" "$DFOCUS"; then
				ptz_write_pos "$ppan" "$ptilt" "$NEW_FOCUS" 1
				emit_list "Moved to '${pname}' (dPan=${DPAN}ms, dTilt=${DTILT}ms)"
			else
				emit_list "Preset move interrupted by manual control (position tracked)"
			fi
		else
			echo '{"ok":false,"error":"Preset not found"}'
		fi
		;;

	capture_map_bg)
		ptz_read_pos
		CUR_MAG=$(get_current_mag)
		if wget -qO "${MAP_BG_FILE}.tmp" "http://127.0.0.1/image.jpg" 2>/dev/null && [ -s "${MAP_BG_FILE}.tmp" ]; then
			mv "${MAP_BG_FILE}.tmp" "$MAP_BG_FILE"
			printf "BG_PAN=%s\nBG_TILT=%s\n" "$PAN_MS" "$TILT_MS" > "$MAP_BG_META"
			emit_list "Captured map background at current view (Pan ${PAN_MS}ms, Tilt ${TILT_MS}ms, Zoom ${CUR_MAG:-1.0}x)"
		else
			rm -f "${MAP_BG_FILE}.tmp"
			echo '{"ok":false,"error":"Snapshot capture failed"}'
		fi
		;;

	delete)
		if [ -n "$ID" ] && [ -f "$PRESETS_FILE" ]; then
			grep -v "^${ID}|" "$PRESETS_FILE" > "${PRESETS_FILE}.tmp" 2>/dev/null || true
			mv "${PRESETS_FILE}.tmp" "$PRESETS_FILE"
			if [ "$(read_boot_home)" = "$ID" ] || { [ -f "$BOOT_HOME_FILE" ] && [ "$(tr -cd '0-9' < "$BOOT_HOME_FILE" 2>/dev/null)" = "$ID" ]; }; then
				rm -f "$BOOT_HOME_FILE"
			fi
		fi
		emit_list "Preset deleted"
		;;

	set_boot_home)
		cur_bh=$(read_boot_home)
		if [ -z "$ID" ] || [ "$ID" = "$cur_bh" ]; then
			rm -f "$BOOT_HOME_FILE"
			emit_list "Boot home preset cleared"
		elif grep -q "^${ID}|" "$PRESETS_FILE" 2>/dev/null; then
			printf '%s\n' "$ID" > "$BOOT_HOME_FILE"
			emit_list "Preset #${ID} set as Boot Home"
		else
			emit_list "Preset #${ID} not found"
		fi
		;;

	track)
		ptz_read_pos
		case "$IN_PAN" in ''|*[!0-9-]*) IN_PAN=0 ;; esac
		case "$IN_TILT" in ''|*[!0-9-]*) IN_TILT=0 ;; esac
		case "$IN_FOCUS" in ''|*[!0-9-]*) IN_FOCUS=0 ;; esac
		PAN_MS=$((PAN_MS + IN_PAN))
		TILT_MS=$((TILT_MS + IN_TILT))
		FOCUS_MS=$((FOCUS_MS + IN_FOCUS))
		ptz_write_pos "$PAN_MS" "$TILT_MS" "$FOCUS_MS" 1
		emit_list ""
		;;

	*)
		emit_list ""
		;;
esac
