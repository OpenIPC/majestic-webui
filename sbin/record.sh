#!/bin/sh
#
# What the camera runs when a recording is finished.
#
# majestic calls this with the clip it has just written, committed and closed:
#
#     record.sh <path> <motion|split|stop|error> <seconds>
#
# It is a dispatcher and nothing else. Each extension decides for itself
# whether it wants clips, in its own config, so that turning one off does not
# mean editing this file — and an extension that is not installed at all is
# simply not there to call, which is the ordinary case on an FPV image where
# the Telegram sender is deliberately left out of the build.
#
# Only motion clips are forwarded. A camera recording without stopping closes
# a clip every records.split minutes whatever is happening in front of it, and
# a chat that receives one every twenty minutes around the clock is a chat
# nobody reads. The other reasons are left for a hand-written hook, which is
# what the setting is for.

clip=$1
reason=$2
# $3 is the clip's length in seconds. Nothing here uses it yet; it is passed
# on so a hand-written hook that replaces this one has it.

[ -n "$clip" ] && [ -s "$clip" ] || exit 1
[ "$reason" = "motion" ] || exit 0

# A subshell per extension: both configs are read into this shell, and the
# second one must not see what the first one set.
#
# A sender that was asked to run and failed makes this fail too. The camera
# does not read the status, but a person running it by hand does, and "the
# clip went nowhere" must not look like "nothing to do".
rc=0

if [ -x /usr/sbin/telegram ] && [ -e /etc/webui/telegram.conf ]; then
	(
		. /etc/webui/telegram.conf
		[ "$telegram_enabled" = "true" ] && [ "$telegram_clips" = "true" ] ||
			exit 0
		/usr/sbin/telegram "$clip"
	) || rc=1
fi

if [ -x /usr/bin/ntfy.sh ] && [ -e /etc/webui/ntfy.conf ]; then
	(
		. /etc/webui/ntfy.conf
		[ "$ntfy_enabled" = "true" ] && [ "$ntfy_clips" = "true" ] || exit 0
		/usr/bin/ntfy.sh "$clip"
	) || rc=1
fi

exit $rc
