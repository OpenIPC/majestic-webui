#!/bin/sh
# Write the request body to a file, reading it from stdin (needs majestic's
# CGI-body-to-stdin support). The existing file's mode is kept.
# POST/PUT ?path=<file>  body=<content>  -> {"ok":bool}
#
# POST or PUT only. `cat > "$f"` truncates before it reads a byte, so a GET --
# which is what a cross-site <img> sends -- used to empty any file it named.
# And the body goes to a file beside the target first, replacing it only once
# fully written: a full overlay used to leave the file cut short, which for an
# init script or /etc/passwd is a camera that does not come back.

printf 'HTTP/1.1 200 OK\nContent-Type: application/json\nCache-Control: no-store\n\n'

case "$REQUEST_METHOD" in
POST | PUT) ;;
*)
	printf '{"ok":false,"error":"POST or PUT only"}'
	exit 0
	;;
esac

f="$GET_path"
if [ -z "$f" ]; then
	printf '{"ok":false,"error":"no path"}'
	exit 0
fi

# A symlink is written through, as the in-place write did, not replaced.
t=$(readlink -f "$f" 2>/dev/null)
[ -n "$t" ] && f=$t
tmp="$f.save.$$"
mode=$(stat -c %a "$f" 2>/dev/null)
if cat > "$tmp" && { [ -z "$mode" ] || chmod "$mode" "$tmp"; } && mv -f "$tmp" "$f"; then
	printf '{"ok":true}'
else
	rm -f "$tmp"
	printf '{"ok":false,"error":"write failed"}'
fi
