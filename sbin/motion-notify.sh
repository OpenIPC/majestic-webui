#!/bin/sh
#
# What the camera runs when movement STARTS, on a camera with nowhere to record.
#
# majestic calls /usr/sbin/motion.sh on the leading edge of movement, at most
# once every five seconds. That file is a two-line shim the notification pages
# write, and this is what it hands over to. Its whole job is the case the clip
# hook cannot cover: with no memory card there is no recorder, so no clip is
# ever finished, so records.onClose never fires and movement reaches nobody.
#
# Here the camera records the clip as it sends it -- localhost/video.mp4 holds
# the muxer up for the life of one request -- which needs no card, no recorder
# and no playlist. What that costs, and both pages say so: the clip starts at
# the trigger rather than before it, and it is as long as the setting says
# rather than as long as the movement lasts. A camera with a card sends the
# real recording instead, which is better on both counts, and this stands aside
# for it.
#
# The bounding box majestic passes is deliberately ignored. Older cameras put
# the box's far corner in the last two arguments and newer ones put its size,
# and the two cannot be told apart from the numbers, so anything that read them
# would be guessing. Nothing here needs them.
#
# Nothing reads this script's exit status -- majestic starts it and forgets it
# -- so anything worth knowing goes to the camera's log, where the Logs page
# shows it.

CONF_DIR=/etc/webui
MJ_SH=/var/www/cgi-bin/p/majestic.sh
LOCK=/tmp/motion-notify.lock

say() { logger -t motion-notify "$1" 2>/dev/null || true; }

# One capture at a time, camera-wide.
#
# The lock records the pid holding it, because a run can legitimately last
# several minutes -- a capture plus two uploads over a slow link -- and any
# age-based guess short enough to recover from a kill -9 is also short enough
# to expire under an upload that is still going. A pid that is gone is proof;
# the age is only the backstop for a pid the kernel has recycled.
take_lock() {
	if mkdir "$LOCK" 2>/dev/null; then
		echo $$ > "$LOCK/pid"
		return 0
	fi

	_held=$(cat "$LOCK/pid" 2>/dev/null)
	if [ -n "$_held" ] && kill -0 "$_held" 2>/dev/null; then
		return 1
	fi
	if [ -z "$_held" ] &&
		[ -z "$(find "$LOCK" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then
		return 1
	fi

	say "taking over a lock left behind by pid ${_held:-unknown}"
	rm -rf "$LOCK"
	mkdir "$LOCK" 2>/dev/null || return 1
	echo $$ > "$LOCK/pid"
	return 0
}

# Only ever remove our own: a run whose lock was taken from it must not take
# its successor's away on the way out.
drop_lock() {
	[ "$(cat "$LOCK/pid" 2>/dev/null)" = "$$" ] && rm -rf "$LOCK"
}

take_lock || exit 0
trap 'drop_lock' EXIT INT TERM

# Does this sender want to hear about movement? The same two answers record.sh
# asks of the same two files, in a subshell so the first config read cannot
# leak into the second.
wants() {
	[ -e "$CONF_DIR/$1.conf" ] || return 1
	(
		. "$CONF_DIR/$1.conf"
		eval "[ \"\$${1}_enabled\" = true ] && [ \"\$${1}_clips\" = true ]"
	)
}

# How many seconds that sender asks for, clamped exactly as the sender itself
# clamps it -- this figure reaches a URL and an arithmetic expansion, and the
# page that usually writes it is not the only thing that can.
seconds() {
	_s=$(
		. "$CONF_DIR/$1.conf" 2>/dev/null
		eval "printf '%s' \"\$${1}_video_seconds\""
	)
	case "$_s" in
	'' | *[!0-9]* | ????*) _s=10 ;;
	esac
	[ "$_s" -lt 1 ] && _s=10
	[ "$_s" -gt 60 ] && _s=60
	printf '%s' "$_s"
}

# Is the recorder demonstrably doing this already?
#
#   0  yes -- it is recording on movement and writing
#   1  no  -- it is not, and this script is the only thing that will send
#   2  cannot tell -- the camera did not answer
#
# Three answers rather than two, for the reason the config helper next door
# keeps three: a question that could not be asked is not an answer about the
# camera, and collapsing it into "no" would hide the one case where this script
# and the recorder can both fire for the same movement. The caller still sends
# on a 2 -- a missed event is worse than a duplicate, and a camera that will
# not answer is usually one that is restarting -- but it says so where somebody
# chasing duplicate messages can find it.
#
# A camera recording on motion finishes a clip when the movement stops and
# hands it to the clip hook, which sends it. That clip is the better one,
# covering the whole event and opening before it, which is why this stands
# aside for it.
#
# Four things have to be true, and the fourth is the one that is easy to
# forget: recording switched ON. records.mode keeps saying `motion` after
# recording is turned off, the health gauge stays at 0 because nothing has
# tried, and the write counter keeps whatever it reached before -- so the other
# three can all look like a working recorder on a camera that will never finish
# another clip.
#
# "Configured to record on motion" is not enough on its own either, and asking
# only that is what would break the camera this exists for: measured on an
# hi3516ev300 with no card and records.path left at its default, the recorder
# reported itself ok from boot and only went offline on the first event, when
# it discovered the path was on internal flash.
recorder_covers_it() {
	[ -r "$MJ_SH" ] || return 2
	. "$MJ_SH"

	_en=$(mj_cfg records.enabled)
	case $? in
	0) ;;
	1) return 1 ;;   # not set, so not on
	*) return 2 ;;
	esac
	[ "$_en" = "true" ] || return 1

	_mode=$(mj_cfg records.mode)
	case $? in
	0) ;;
	1) return 1 ;;
	*) return 2 ;;
	esac
	[ "$_mode" = "motion" ] || return 1

	# Unauthenticated, no forks, and the same figures the Dashboard reads.
	_m=$(curl -s -m 2 "localhost/metrics/records" 2>/dev/null) || return 2
	[ -n "$_m" ] || return 2

	# 0 is the only state in which a clip can be written; 1, 2 and 3 are
	# degraded, failed and offline. A build that does not publish the gauge at
	# all has told us nothing.
	_state=$(printf '%s\n' "$_m" | sed -n 's/^records_state \([0-9]*\).*/\1/p')
	[ -n "$_state" ] || return 2
	[ "$_state" = "0" ] || return 1

	_written=$(printf '%s\n' "$_m" |
		sed -n 's/^records_fragments_written_total \([0-9]*\).*/\1/p')
	[ -n "$_written" ] || return 2
	[ "$_written" = "0" ] && return 1

	return 0
}

# Record one clip and hand it to the senders named. The file belongs to this
# function: the senders send what they are given and delete nothing.
capture_to() {
	_secs=$1
	shift

	_work=$(mktemp -d /tmp/motion.XXXXXX) || return 1
	_clip=$_work/"$(hostname -s | tr ' ' '-')"-"$(date +'%Y%m%d-%H%M%S')".mp4

	# ?pre= costs nothing and is usually answered with nothing: the camera
	# holds a run-up only while another request that asked for one is open.
	# When two events overlap, the second opens before its own trigger.
	_http=$(curl --silent --show-error \
		--max-time $((_secs + 30)) \
		--output "$_clip" --write-out '%{http_code}' \
		"localhost/video.mp4?pre=${_secs}&duration=${_secs}")
	_rc=$?

	# The same three tests the senders make of their own captures: a transfer
	# that died after the status line leaves a partial file behind a
	# successful-looking code, and half a video is worse than none.
	if [ "$_rc" -ne 0 ]; then
		say "the clip did not arrive whole (curl exit ${_rc})"
		rm -rf "$_work"
		return 1
	fi
	if [ "$_http" != "200" ] || [ ! -s "$_clip" ]; then
		say "the camera would not record a clip (HTTP ${_http:-none})"
		rm -rf "$_work"
		return 1
	fi

	_bad=0
	for _who in "$@"; do
		case "$_who" in
		telegram) _out=$(/usr/sbin/telegram "$_clip" 2>&1) || _bad=1 ;;
		ntfy) _out=$(/usr/bin/ntfy.sh "$_clip" 2>&1) || _bad=1 ;;
		esac
		[ "$_bad" = 1 ] && say "${_who}: ${_out}"
	done

	rm -rf "$_work"
	return "$_bad"
}

tg=no
nf=no
[ -x /usr/sbin/telegram ] && wants telegram && tg=yes
[ -x /usr/bin/ntfy.sh ] && wants ntfy && nf=yes

if [ "$tg" = "no" ] && [ "$nf" = "no" ]; then
	exit 0
fi

recorder_covers_it
case $? in
0)
	exit 0
	;;
2)
	say "could not tell whether the recorder is covering this; sending anyway, which may duplicate a recording that also gets sent"
	;;
esac

# One capture serves both senders where they ask for the same length, which is
# the ordinary case. Where they differ, each gets what its own page promised:
# handing both the longer clip would silently lengthen one service's video
# because the other was switched on, while its page went on showing the shorter
# figure.
rc=0
if [ "$tg" = "yes" ] && [ "$nf" = "yes" ]; then
	tgs=$(seconds telegram)
	nfs=$(seconds ntfy)
	if [ "$tgs" = "$nfs" ]; then
		capture_to "$tgs" telegram ntfy || rc=1
	else
		capture_to "$tgs" telegram || rc=1
		capture_to "$nfs" ntfy || rc=1
	fi
elif [ "$tg" = "yes" ]; then
	capture_to "$(seconds telegram)" telegram || rc=1
else
	capture_to "$(seconds ntfy)" ntfy || rc=1
fi

exit $rc
