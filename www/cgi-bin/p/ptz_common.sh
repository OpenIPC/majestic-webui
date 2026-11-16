#!/bin/sh
# Shared helpers for PTZ and AF JSON CGI endpoints (www/cgi-bin/j/*.cgi).

PTZ_POS_TMP="/tmp/ptz_pos.conf"
PTZ_POS_ETC="/etc/ptz_pos.conf"

# Refuse cross-site requests: a hostile page can auto-submit an HTML form
# with cached Basic-auth credentials, so reject foreign Referers and form
# Content-Types.
ptz_reject_cross_site() {
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
}

ptz_read_pos() {
	PAN_MS=0
	TILT_MS=0
	FOCUS_MS=0
	if [ -f "$PTZ_POS_TMP" ]; then
		. "$PTZ_POS_TMP" 2>/dev/null
	elif [ -f "$PTZ_POS_ETC" ]; then
		. "$PTZ_POS_ETC" 2>/dev/null
	fi
	case "$PAN_MS" in ''|*[!0-9-]*) PAN_MS=0 ;; esac
	case "$TILT_MS" in ''|*[!0-9-]*) TILT_MS=0 ;; esac
	case "$FOCUS_MS" in ''|*[!0-9-]*) FOCUS_MS=0 ;; esac
}

# Write current position to /tmp/ptz_pos.conf (RAM), and when $4 = 1,
# persist to /etc/ptz_pos.conf only if values changed (spares flash writes).
ptz_write_pos() {
	_p="${1:-0}"
	_t="${2:-0}"
	_f="${3:-$FOCUS_MS}"
	_persist="${4:-0}"
	case "$_f" in ''|*[!0-9-]*) _f=0 ;; esac
	_content=$(printf "PAN_MS=%s\nTILT_MS=%s\nFOCUS_MS=%s\n" "$_p" "$_t" "$_f")
	printf '%s\n' "$_content" > "${PTZ_POS_TMP}.tmp" && mv "${PTZ_POS_TMP}.tmp" "$PTZ_POS_TMP"
	if [ "$_persist" = "1" ]; then
		_cur=""
		[ -f "$PTZ_POS_ETC" ] && _cur=$(cat "$PTZ_POS_ETC" 2>/dev/null)
		if [ "$_cur" != "$_content" ]; then
			printf '%s\n' "$_content" > "${PTZ_POS_ETC}.tmp" 2>/dev/null && mv "${PTZ_POS_ETC}.tmp" "$PTZ_POS_ETC" 2>/dev/null || rm -f "${PTZ_POS_ETC}.tmp"
		fi
	fi
}

ptz_now_ms() {
	_t=$(cut -d' ' -f1 /proc/uptime 2>/dev/null)
	awk -v u="$_t" 'BEGIN { printf "%.0f", u * 1000 }'
}

ptz_apply_axis_delta() {
	_dir="$1"
	_ms="$2"
	_persist="${3:-0}"
	ptz_read_pos
	case "$_dir" in
		right) PAN_MS=$((PAN_MS + _ms)) ;;
		left)  PAN_MS=$((PAN_MS - _ms)) ;;
		up)    TILT_MS=$((TILT_MS + _ms)) ;;
		down)  TILT_MS=$((TILT_MS - _ms)) ;;
		far)   FOCUS_MS=$((FOCUS_MS + _ms)) ;;
		near)  FOCUS_MS=$((FOCUS_MS - _ms)) ;;
	esac
	ptz_write_pos "$PAN_MS" "$TILT_MS" "$FOCUS_MS" "$_persist"
}

# Drive an axis in <=3500 ms chunks, recording completed distance even if a
# chunk fails partway so stored position stays synchronized with the head.
ptz_drive_axis_ms() {
	drv_dir="$1"
	drv_rem="$2"
	drv_role="${3:-}"
	while [ "$drv_rem" -ge 30 ]; do
		[ -f /tmp/ptz_job.cancel ] && return 1
		if [ "$drv_rem" -gt 3500 ]; then
			drv_chunk=3500
		else
			drv_chunk="$drv_rem"
		fi
		t0=$(ptz_now_ms)
		ptz_read_pos
		_ldp=0; _ldt=0; _ldf=0
		case "$drv_dir" in
			right) _ldp=1 ;;
			left)  _ldp=-1 ;;
			up)    _ldt=1 ;;
			down)  _ldt=-1 ;;
			far)   _ldf=1 ;;
			near)  _ldf=-1 ;;
		esac
		if [ "$_ldp" -ne 0 ] || [ "$_ldt" -ne 0 ] || [ "$_ldf" -ne 0 ]; then
			printf "BASE_PAN=%s\nBASE_TILT=%s\nBASE_FOCUS=%s\nDP=%s\nDT=%s\nDF=%s\nSTART_MS=%s\nEND_MS=%s\nMOVING=1\n" \
				"$PAN_MS" "$TILT_MS" "$FOCUS_MS" "$_ldp" "$_ldt" "$_ldf" "$t0" "$((t0 + drv_chunk))" > /tmp/ptz_live.conf.tmp && \
				mv /tmp/ptz_live.conf.tmp /tmp/ptz_live.conf
		fi
		if [ -n "$drv_role" ]; then
			_cli_cmd="/usr/bin/motors-cli --socket /run/motorsd.sock --role $drv_role $drv_dir $drv_chunk"
		else
			_cli_cmd="/usr/bin/motors-cli --socket /run/motorsd.sock $drv_dir $drv_chunk"
		fi
		_rc=0
		$_cli_cmd >/dev/null 2>&1 || _rc=$?
		rm -f /tmp/ptz_live.conf
		t1=$(ptz_now_ms)
		el=$((t1 - t0))
		[ "$el" -lt 0 ] && el=0
		[ "$el" -gt "$drv_chunk" ] && el="$drv_chunk"
		_short=0
		[ "$drv_chunk" -ge 300 ] && [ "$el" -lt $((drv_chunk - 180)) ] && _short=1
		if [ "$_rc" -ne 0 ] || [ -f /tmp/ptz_job.cancel ] || [ "$_short" -eq 1 ]; then
			[ "$el" -ge 20 ] && ptz_apply_axis_delta "$drv_dir" "$el" 1
			return 1
		fi
		ptz_apply_axis_delta "$drv_dir" "$drv_chunk" 0
		drv_rem=$((drv_rem - drv_chunk))
		if [ "$drv_rem" -ge 30 ]; then
			usleep 100000 2>/dev/null || sleep 1
		fi
	done
	return 0
}
