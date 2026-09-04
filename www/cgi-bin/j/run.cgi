#!/bin/sh
echo "HTTP/1.1 200 OK
Content-type: text/plain; charset=UTF-8
Cache-Control: no-store
Pragma: no-cache
"

[ -n "$QUERY_STRING" ] && eval $(echo "$QUERY_STRING" | sed "s/&/;/g")
[ -n "$cmd" ] && c=$(echo $cmd | base64 -d)
[ -n "$web" ] && c=$(echo $web | base64 -d) && t="timeout 3"
[ -z "$c" ] && echo "No command!" && exit 1

# The prompt is marked with ANSI bold, not with <b></b>, and the stream says
# text/plain.
#
# What this carries is a shell's stdout and stderr, unescaped, and calling that
# text/html was a trap: the first consumer to reach for innerHTML would have
# been rendering command output as markup. The tags did not stay put either —
# a transcript rendered as text prints them, which is what the factory reset
# page did with its own first line (issue #154). SGR is what a terminal already
# speaks: console.cgi reads it, factory-reset.js's terminal writer strips every
# escape it does not act on, and a curl into a real terminal renders it.
#
# printf, not echo: the command is interpolated, and echo would eat a leading
# -n or expand a backslash in it on some shells.
prompt() {
	printf '\033[1m%s@%s:%s# %s\033[0m\n' "$(whoami)" "$(hostname)" "$PWD" "$1"
}

export PATH=/usr/local/bin:/usr/local/sbin:/bin:/sbin:/usr/bin:/usr/sbin
cd /tmp || return

prompt "$c"
eval "$t $c" 2>&1
prompt

exit 0
