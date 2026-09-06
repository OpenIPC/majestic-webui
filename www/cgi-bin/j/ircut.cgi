#!/bin/sh
# "This camera has no IR-cut filter" — one fact, kept on the camera.
#
#   (no query)   report it
#   ?dismiss=1   record it
#   ?clear=1     forget it
#
# The dashboard raises a banner when no pin is wired to the filter, because
# that fault is invisible until nightfall and silence would read as a clean
# bill of health. But a camera that has no filter at all is not faulty, and
# nothing the camera can measure tells the two apart: an unwired filter and an
# absent one look identical from here. So the owner says which, once.
#
# It lives on the camera rather than in localStorage because the answer is a
# property of the hardware, not of the browser looking at it — every phone and
# desktop that opens the page is asking the same question about the same
# camera, and they should not each have to be told.
#
# Its own file, not a key in webui.conf: access.cgi writes the theme
# there with `>`, so anything else in it is destroyed the next time somebody
# picks a colour scheme.
#
# `clear=1` is how the claim is taken back by hand — nothing in the UI calls
# it, because the only owner who needs it is one who pressed Dismiss on a
# camera that does have a filter, and the answer to that is to wire it.
CONF="/etc/webui/ircut.conf"

printf 'HTTP/1.1 200 OK\nContent-Type: application/json\nCache-Control: no-store\n\n'

# Is anything wired to the filter? Asked here rather than by the page, because
# a pad contradicts the claim and the claim must not outlive its premise —
# whoever supplied the pad, from wherever. It used to be dropped by
# dashboard.js on the first load that saw one, which made the dashboard the
# only witness to a wiring change and it is the one page that cannot make one:
# wire the filter on Day / Night, take it away again, and no dashboard was ever
# open while a pad existed. The claim survived, and the banner it exists to
# silence stayed silenced on the page that had just stopped being able to move
# the filter (#367).
#
# This answers about the pad that is there when the question is put, so it also
# covers a yaml-cli edit over SSH, or another browser, or a phone opening the
# page a week later. What it cannot see on its own is a pad that came and went
# between two questions — so the Day / Night page asks once after every save
# (recheckNoFilterClaim in a/mj-settings.js), which is the only place in the UI
# where a pad appears at all. The rule stays here; that is only a caller.
wired() {
	# The question the banner itself asks, and it has to be the same one, or
	# this drops a claim the page will not stop making or keeps one the page
	# has stopped honouring. In ircut-check.js's diagnose() it is `driveable`:
	# the OPENING coil alone, the pad majestic raises for night and returns
	# early without, whatever else is set. A camera holding only the closing
	# coil still moves nothing, so it is still the camera the banner is raised
	# on, and someone pressing Dismiss under that banner is answering about the
	# state they are looking at (#273). tests/ircut-claim.test.js holds the two
	# to the same table.
	p=$(yaml-cli -g .nightMode.irCutPin1 2>/dev/null) || return 1
	# GPIO 0 is a real pad — the wiki lists RESET=0 on several XM boards — so
	# nothing here may test a pin for truthiness. A hand-edited `true` is not a
	# pad however true it is, and neither is an empty value.
	case "$p" in
		'' | *[!0-9]*) return 1 ;;
	esac
	return 0
}

case "$QUERY_STRING" in
	*dismiss=1*)
		mkdir -p /etc/webui 2>/dev/null
		echo 'ircut_no_filter="1"' > "$CONF" 2>/dev/null
		sync
		;;
	*clear=1*)
		rm -f "$CONF" 2>/dev/null
		sync
		;;
esac

# Read the file back rather than reporting what was just asked for: a flash
# that refused the write must not answer "dismissed" and leave the banner
# coming back on the next camera the same person opens.
no_filter=false
if [ -f "$CONF" ]; then
	. "$CONF" 2>/dev/null
	[ "$ircut_no_filter" = "1" ] && no_filter=true
fi

# The contradiction is reported whether or not the file could be deleted, which
# is the one place this does not read back what it wrote. A pad is wired: that
# is true of the camera regardless of what /etc will accept, and answering
# "dismissed" because a read-only filesystem refused the removal would silence
# a banner on exactly the reasoning this endpoint exists to prevent. The next
# read tries the removal again.
if [ "$no_filter" = true ] && wired; then
	rm -f "$CONF" 2>/dev/null
	sync
	no_filter=false
fi

printf '{"noFilter":%s}\n' "$no_filter"
