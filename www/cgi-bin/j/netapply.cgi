#!/bin/sh
# Where a network change sbin/netapply is holding open has got to.
# GET ?token=<hex> -> {"state":"applying"|"waiting"|"rolledback"|"done"|"bad"}
#
# Read-only. network.js asks it over the connection the page is on, and once
# the change is in effect ("waiting") it sends the browser to
# network.cgi?confirm=, which is what keeps it -- an answer here before then
# would prove nothing about the new settings. "done" is a change already kept,
# or one this camera never held.

printf 'HTTP/1.1 200 OK\nContent-Type: application/json\nCache-Control: no-store\n\n'

t=$GET_token
case "$t" in
	'' | *[!0-9a-f]*)
		printf '{"state":"bad"}'
		exit 0
		;;
esac

set -- $(cat /tmp/netapply.pending 2>/dev/null)
if [ "$2" = "$t" ] && [ -n "$1" ] && kill -0 "$1" 2>/dev/null; then
	if [ "$4" = "applied" ]; then
		printf '{"state":"waiting"}'
	else
		printf '{"state":"applying"}'
	fi
elif grep -qxF "$t" /tmp/netapply.rolledback 2>/dev/null; then
	printf '{"state":"rolledback"}'
else
	printf '{"state":"done"}'
fi
