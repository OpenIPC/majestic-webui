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
CONF="/etc/webui/ircut.conf"

printf 'HTTP/1.1 200 OK\nContent-Type: application/json\nCache-Control: no-store\n\n'

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

printf '{"noFilter":%s}\n' "$no_filter"
