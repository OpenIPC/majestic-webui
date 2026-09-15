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
# and no playlist. What that costs, and it is worth saying plainly: the clip
# starts at the trigger rather than before it, and it is as long as the setting
# says rather than as long as the movement lasts. A camera with a card sends
# the real recording instead, which is better on both counts, and this script
# stands aside for it.
#
# The bounding box majestic passes is deliberately ignored. Its four numbers do
# not mean the same thing on every camera -- on HiSilicon they are the corners
# of the box, on SigmaStar and Ingenic the corner and its size -- so a script
# that reads them is wrong on two vendors out of three. Nothing here needs them.

CONF_DIR=/etc/webui
MJ_SH=/var/www/cgi-bin/p/majestic.sh
LOCK=/tmp/motion-notify.lock

# One capture at a time, camera-wide.
#
# mkdir is the lock because it is atomic and needs no tools. A run killed
# outright cannot clean up after itself, so a lock older than any capture could
# possibly be is taken to be dead and removed -- otherwise one `kill -9` would
# silence the camera until somebody rebooted it.
if ! mkdir "$LOCK" 2>/dev/null; then
	if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +3 2>/dev/null)" ]; then
		rmdir "$LOCK" 2>/dev/null
		mkdir "$LOCK" 2>/dev/null || exit 0
	else
		exit 0
	fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT INT TERM

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

# Stand aside when the recorder is demonstrably doing this already.
#
# A camera recording on motion finishes a clip when the movement stops and
# hands it to the clip hook, which sends it. Both paths firing would mean two
# messages for one event -- and the recorder's is the better one, covering the
# whole event and opening before it.
#
# "Configured to record on motion" is the wrong question, and asking it is what
# would break the very camera this script exists for: a card-less camera whose
# settings still say motion recording is on looks identical to a working one
# until the recorder actually tries. Measured on an hi3516ev300 with no card
# and records.path left at its default, the recorder reported itself ok from
# boot and only went offline on the first event, when it discovered the path
# was on internal flash -- so a script trusting the configuration would have
# stayed silent through exactly the events it was installed to send.
#
# So this asks what the recorder is DOING: the mode it is in, and whether it is
# both healthy and has actually written something. A camera that has recorded
# nothing yet -- freshly restarted, card or no card -- is not taken to be
# covered, which costs one duplicate message on the first event of a camera
# that does have a card, and never costs a missed event on one that does not.
# That is the right way round.
recorder_covers_it() {
	[ -r "$MJ_SH" ] || return 1
	. "$MJ_SH"
	_mode=$(mj_cfg records.mode) || return 1
	[ "$_mode" = "motion" ] || return 1

	# Unauthenticated, no forks, and the same figures the Dashboard reads.
	_m=$(curl -s -m 2 "localhost/metrics/records" 2>/dev/null) || return 1
	[ -n "$_m" ] || return 1

	# 0 is the only state in which a clip can be written; 1, 2 and 3 are
	# degraded, failed and offline.
	_state=$(printf '%s\n' "$_m" | sed -n 's/^records_state \([0-9]*\).*/\1/p')
	[ "$_state" = "0" ] || return 1

	_written=$(printf '%s\n' "$_m" |
		sed -n 's/^records_fragments_written_total \([0-9]*\).*/\1/p')
	case "$_written" in
	'' | 0) return 1 ;;
	esac

	return 0
}

tg=no
nf=no
[ -x /usr/sbin/telegram ] && wants telegram && tg=yes
[ -x /usr/bin/ntfy.sh ] && wants ntfy && nf=yes

if [ "$tg" = "no" ] && [ "$nf" = "no" ]; then
	exit 0
fi

if recorder_covers_it; then
	exit 0
fi

# One capture for both senders: recording it twice would ask the camera for two
# simultaneous streams of the same thing, and the longer of the two requests
# contains the shorter one anyway.
secs=5
[ "$tg" = "yes" ] && secs=$(seconds telegram)
if [ "$nf" = "yes" ]; then
	nsecs=$(seconds ntfy)
	[ "$nsecs" -gt "$secs" ] && secs=$nsecs
fi

workdir=$(mktemp -d /tmp/motion.XXXXXX) || exit 1
trap 'rm -rf "$workdir"; rmdir "$LOCK" 2>/dev/null' EXIT INT TERM

clip=$workdir/"$(hostname -s | tr ' ' '-')"-"$(date +'%Y%m%d-%H%M%S')".mp4

# ?pre= costs nothing and is usually answered with nothing: the camera holds a
# run-up only while another request that asked for one is open. When two events
# overlap, the second one opens before its own trigger.
http=$(curl --silent --show-error \
	--max-time $((secs + 30)) \
	--output "$clip" --write-out '%{http_code}' \
	"localhost/video.mp4?pre=${secs}&duration=${secs}")
rc=$?

# The same three tests the senders make of their own captures: a transfer that
# died after the status line leaves a partial file behind a successful-looking
# code, and half a video is worse than none.
if [ "$rc" -ne 0 ] || [ "$http" != "200" ] || [ ! -s "$clip" ]; then
	exit 1
fi

# A sender that was asked to run and failed makes this fail too. Nothing reads
# the status -- majestic starts this and forgets it -- but a person running it
# by hand is the one who needs the answer.
rc=0
if [ "$tg" = "yes" ]; then
	/usr/sbin/telegram "$clip" >/dev/null 2>&1 || rc=1
fi
if [ "$nf" = "yes" ]; then
	/usr/bin/ntfy.sh "$clip" >/dev/null 2>&1 || rc=1
fi

exit $rc
