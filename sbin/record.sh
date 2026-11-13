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

# A sender that was asked to run and failed makes this fail too. The camera
# does not read the status, but a person running it by hand does, and "the clip
# went nowhere" must not look like "nothing to do".
#
# The same list sbin/motion-notify.sh fans a capture out to and p/common.cgi's
# clip_hook_wanted decides the hooks from; tools/lint-templates.sh fails the
# build when the three disagree. See the comment on SENDERS in motion-notify.sh
# for why it is repeated rather than sourced from one place.
rc=0

for name in telegram ntfy max; do
	case $name in
	telegram) bin='/usr/sbin/telegram' ;;
	ntfy) bin='/usr/bin/ntfy.sh' ;;
	max) bin='/usr/sbin/max' ;;
	esac

	[ -x "$bin" ] && [ -e "/etc/webui/$name.conf" ] || continue

	# A subshell for the QUESTION only: every config is read into one shell and
	# the next must not see what the last one set. The sender itself runs out
	# here, because a config that happened to set `clip` -- or now `bin` --
	# would otherwise change which file was sent, or which program sent it.
	# The settings are named after the sender, so the test is built as a string
	# and eval'd; $name comes from the list above and from nowhere else.
	(
		. "/etc/webui/$name.conf"
		eval "[ \"\$${name}_enabled\" = true ] && [ \"\$${name}_clips\" = true ]"
	)
	# Three answers, not two: a config that will not even parse leaves a
	# non-zero status that is not this sender declining, and collapsing it into
	# "does not want clips" would turn a broken file into a silent success.
	case $? in
	0) "$bin" "$clip" || rc=1 ;;
	1) ;;
	*) rc=1 ;;
	esac
done

exit $rc
