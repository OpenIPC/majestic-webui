#!/bin/sh
# Where a network change sbin/netapply is holding open has got to.
# GET ?token=<hex> -> {"state":"applying"|"waiting"|"kept"|"unsaved"|
#                             "rolledback"|"interrupted"|"unknown"|"bad"}
#
# Read-only. network.js asks it over the connection the page is on, and once
# the change is in effect ("waiting") it sends the browser to
# network.cgi?confirm=, which is what keeps it -- an answer here before then
# would prove nothing about the new settings. Every state after that is an
# outcome, and network.cgi?confirm= is also where it is put into words.
# "interrupted" is a worker that is gone without having recorded one.

printf 'HTTP/1.1 200 OK\nContent-Type: application/json\nCache-Control: no-store\n\n'

t=$GET_token
case "$t" in
	'' | *[!0-9a-f]*)
		printf '{"state":"bad"}'
		exit 0
		;;
esac

# The record first: netapply writes its outcome before it removes the record,
# so a run that ends between the two reads is still found by the second.
set -- $(cat /tmp/netapply.pending 2>/dev/null)
read -r done_token done_outcome 2>/dev/null < /tmp/netapply.done
if [ "$2" = "$t" ] && [ -n "$1" ] && kill -0 "$1" 2>/dev/null; then
	if [ "$4" = "applied" ]; then
		printf '{"state":"waiting"}'
	else
		printf '{"state":"applying"}'
	fi
elif [ "$done_token" = "$t" ]; then
	case "$done_outcome" in
		kept | unsaved | rolledback) printf '{"state":"%s"}' "$done_outcome" ;;
		*) printf '{"state":"unknown"}' ;;
	esac
elif [ "$2" = "$t" ]; then
	printf '{"state":"interrupted"}'
else
	printf '{"state":"unknown"}'
fi
