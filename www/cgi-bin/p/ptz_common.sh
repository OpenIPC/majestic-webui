#!/bin/sh
# Shared helpers for PTZ and AF JSON CGI endpoints (www/cgi-bin/j/*.cgi).

PTZ_POS_TMP="/tmp/ptz_pos.conf"
PTZ_POS_ETC="/etc/ptz_pos.conf"
AF_PEAKS_JSON="/tmp/af_peaks.json"
AF_PEAKS_TRACK="/tmp/af_peaks_track"

ptz_af_peaks_stamp() {
	[ -f "$AF_PEAKS_JSON" ] || return 1
	set -- $(md5sum "$AF_PEAKS_JSON" 2>/dev/null)
	if [ -n "$1" ]; then
		printf '%s:%s' "$1" "$(stat -c '%i:%Y' "$AF_PEAKS_JSON" 2>/dev/null || echo 0)"
		return 0
	fi
	stat -c '%i:%s:%Y' "$AF_PEAKS_JSON" 2>/dev/null
}

# Track post-scan manual focus nudges relative to /tmp/af_peaks.json.
# Limitation: only sees focus moves made through the WebUI's CGIs
# (ptz_presets.cgi?act=track and ptz_apply_axis_delta); focus moves from ONVIF
# Imaging Move, DVRIP, or direct POST /ptz bypass this tracker because the
# plugin does not yet expose a focus position ABI command.
ptz_af_track_focus() {
	_df="${1:-0}"
	case "$_df" in ''|*[!0-9-]*) return 0 ;; esac
	[ "$_df" -ne 0 ] 2>/dev/null || return 0
	_cur_stamp=$(ptz_af_peaks_stamp) || return 0
	_cur_off=0
	if [ -f "$AF_PEAKS_TRACK" ]; then
		read -r _ts _to < "$AF_PEAKS_TRACK" 2>/dev/null || true
		[ "$_ts" = "$_cur_stamp" ] && case "$_to" in ''|*[!0-9-]*) ;; *) _cur_off="$_to" ;; esac
	fi
	printf '%s %s\n' "$_cur_stamp" "$((_cur_off + _df))" > "${AF_PEAKS_TRACK}.tmp" && \
		mv "${AF_PEAKS_TRACK}.tmp" "$AF_PEAKS_TRACK"
}

ptz_af_reset_track() {
	_cur_stamp=$(ptz_af_peaks_stamp) || { rm -f "$AF_PEAKS_TRACK"; return 0; }
	printf '%s 0\n' "$_cur_stamp" > "${AF_PEAKS_TRACK}.tmp" && \
		mv "${AF_PEAKS_TRACK}.tmp" "$AF_PEAKS_TRACK"
}

ptz_af_manual_delta() {
	_cur_stamp=$(ptz_af_peaks_stamp) || { echo 0; return 0; }
	if [ -f "$AF_PEAKS_TRACK" ]; then
		read -r _ts _to < "$AF_PEAKS_TRACK" 2>/dev/null || true
		if [ "$_ts" = "$_cur_stamp" ]; then
			case "$_to" in ''|*[!0-9-]*) ;; *) echo "$_to"; return 0 ;; esac
		fi
	fi
	echo 0
}

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

# Copy the RAM position to /etc/ptz_pos.conf, which is flash, if it differs.
# It reads the RAM file and never writes it: a `track` landing meanwhile
# must not be overwritten by an older snapshot. Non-zero when the copy could
# not be written, so a caller can say so instead of claiming it saved.
ptz_persist_pos() {
	[ -f "$PTZ_POS_TMP" ] || return 0
	_content=$(cat "$PTZ_POS_TMP" 2>/dev/null)
	_cur=""
	[ -f "$PTZ_POS_ETC" ] && _cur=$(cat "$PTZ_POS_ETC" 2>/dev/null)
	[ "$_cur" = "$_content" ] && return 0
	if printf '%s\n' "$_content" 2>/dev/null > "${PTZ_POS_ETC}.tmp" && mv "${PTZ_POS_ETC}.tmp" "$PTZ_POS_ETC" 2>/dev/null; then
		return 0
	fi
	rm -f "${PTZ_POS_ETC}.tmp" 2>/dev/null
	return 1
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
	[ "$_persist" = "1" ] && { ptz_persist_pos; return $?; }
	return 0
}

# The PTZ job lock, shared by every endpoint that drives a move or rewrites
# the presets: a directory made atomically, with the holder's pid written
# just after. A contender that finds the directory but no pid yet is looking
# at a lock being taken, not a stale one, so it gives the holder a moment
# before deciding -- taking it over then would let two jobs run at once.
ptz_acquire_lock() {
	if mkdir /tmp/ptz_job.lock 2>/dev/null; then
		echo "$$" > /tmp/ptz_job.lock/pid
		return 0
	fi
	_lp=$(cat /tmp/ptz_job.lock/pid 2>/dev/null)
	if [ -z "$_lp" ] && [ -d /tmp/ptz_job.lock ]; then
		usleep 300000 2>/dev/null || sleep 1
		_lp=$(cat /tmp/ptz_job.lock/pid 2>/dev/null)
	fi
	if [ -n "$_lp" ] && kill -0 "$_lp" 2>/dev/null; then
		return 1
	fi
	rm -rf /tmp/ptz_job.lock
	if mkdir /tmp/ptz_job.lock 2>/dev/null; then
		echo "$$" > /tmp/ptz_job.lock/pid
		return 0
	fi
	return 1
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
		far)   FOCUS_MS=$((FOCUS_MS + _ms)); ptz_af_track_focus "$_ms" ;;
		near)  FOCUS_MS=$((FOCUS_MS - _ms)); ptz_af_track_focus "$((-_ms))" ;;
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

# Drive Pan and Tilt simultaneously via motors-cli diagonal action when both axes
# need >=30 ms, then finish any remaining single-axis delta; falls back to
# sequential ptz_drive_axis_ms if diagonal move is unsupported.
ptz_drive_pan_tilt_ms() {
	_dp_in="${1:-0}"
	_dt_in="${2:-0}"
	_role="${3:-}"
	_dp=0; _dt=0; _rem_p=0; _rem_t=0
	if [ "$_dp_in" -gt 0 ] 2>/dev/null; then _dp=1; _rem_p="$_dp_in"; _pdir="right"
	elif [ "$_dp_in" -lt 0 ] 2>/dev/null; then _dp=-1; _rem_p=$((0 - _dp_in)); _pdir="left"; fi
	if [ "$_dt_in" -gt 0 ] 2>/dev/null; then _dt=1; _rem_t="$_dt_in"; _tdir="up"
	elif [ "$_dt_in" -lt 0 ] 2>/dev/null; then _dt=-1; _rem_t=$((0 - _dt_in)); _tdir="down"; fi

	_diag_ok=1
	while [ "$_rem_p" -ge 30 ] && [ "$_rem_t" -ge 30 ] && [ "$_diag_ok" -eq 1 ]; do
		[ -f /tmp/ptz_job.cancel ] && return 1
		_chunk="$_rem_p"
		[ "$_rem_t" -lt "$_chunk" ] && _chunk="$_rem_t"
		[ "$_chunk" -gt 3500 ] && _chunk=3500

		_diag_dir="${_tdir}${_pdir}"
		ptz_read_pos
		_t0=$(ptz_now_ms)
		printf "BASE_PAN=%s\nBASE_TILT=%s\nBASE_FOCUS=%s\nDP=%s\nDT=%s\nDF=0\nSTART_MS=%s\nEND_MS=%s\nMOVING=1\n" \
			"$PAN_MS" "$TILT_MS" "$FOCUS_MS" "$_dp" "$_dt" "$_t0" "$((_t0 + _chunk))" > /tmp/ptz_live.conf.tmp && \
			mv /tmp/ptz_live.conf.tmp /tmp/ptz_live.conf

		if [ -n "$_role" ]; then
			_cli_cmd="/usr/bin/motors-cli --socket /run/motorsd.sock --role $_role $_diag_dir $_chunk"
		else
			_cli_cmd="/usr/bin/motors-cli --socket /run/motorsd.sock $_diag_dir $_chunk"
		fi
		_rc=0
		$_cli_cmd >/dev/null 2>&1 || _rc=$?
		rm -f /tmp/ptz_live.conf

		_t1=$(ptz_now_ms)
		_el=$((_t1 - _t0))
		[ "$_el" -lt 0 ] && _el=0
		[ "$_el" -gt "$_chunk" ] && _el="$_chunk"
		# A fast (<30 ms) non-zero exit without cancel can be either an older
		# motors-cli/driver without diagonal support or a `busy` lease rejection;
		# falling through to ptz_drive_axis_ms handles older drivers cleanly and
		# fails identically on `busy`.
		if [ "$_rc" -ne 0 ] && [ "$_el" -lt 30 ] && [ ! -f /tmp/ptz_job.cancel ]; then
			_diag_ok=0
			break
		fi
		_short=0
		[ "$_chunk" -ge 300 ] && [ "$_el" -lt $((_chunk - 180)) ] && _short=1
		if [ "$_rc" -ne 0 ] || [ -f /tmp/ptz_job.cancel ] || [ "$_short" -eq 1 ]; then
			if [ "$_el" -ge 20 ]; then
				ptz_read_pos
				ptz_write_pos $((PAN_MS + _dp * _el)) $((TILT_MS + _dt * _el)) "$FOCUS_MS" 1
			fi
			return 1
		fi
		ptz_read_pos
		ptz_write_pos $((PAN_MS + _dp * _chunk)) $((TILT_MS + _dt * _chunk)) "$FOCUS_MS" 0
		_rem_p=$((_rem_p - _chunk))
		_rem_t=$((_rem_t - _chunk))
		if [ "$_rem_p" -ge 30 ] || [ "$_rem_t" -ge 30 ]; then
			usleep 40000 2>/dev/null || true
		fi
	done

	if [ "$_rem_p" -ge 30 ]; then
		ptz_drive_axis_ms "$_pdir" "$_rem_p" "$_role" || return 1
		usleep 80000 2>/dev/null || true
	fi
	if [ "$_rem_t" -ge 30 ]; then
		ptz_drive_axis_ms "$_tdir" "$_rem_t" "$_role" || return 1
		usleep 80000 2>/dev/null || true
	fi
	return 0
}
