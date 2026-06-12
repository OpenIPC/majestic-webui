#!/bin/sh
# Stream a file as an attachment, or a folder / selection as a .tar.gz.
# GET ?path=<file>                 -> the file (Content-Disposition: attachment)
# GET ?tgz=1&path=<dir>            -> <dir>.tar.gz
# GET ?tgz=1&path=<dir>&paths=<b64>-> tar.gz of the newline-list (names under <dir>)

# Sanitise a value for use inside a quoted Content-Disposition filename.
dname() { printf '%s' "$1" | tr -d '"\000-\037/'; }

f="$GET_path"

if [ "$GET_tgz" = "1" ]; then
	if [ -n "$GET_paths" ]; then
		base=${f:-/}
		printf 'HTTP/1.1 200 OK\nContent-Type: application/gzip\nContent-Disposition: attachment; filename="%s.tar.gz"\n\n' "$(dname "$(basename "$base")")"
		printf '%s' "$GET_paths" | base64 -d 2>/dev/null | tar c -f - -C "$base" -T - 2>/dev/null | gzip
	else
		[ -d "$f" ] || { printf 'HTTP/1.1 404 Not Found\nContent-Type: text/plain\n\nnot a directory\n'; exit 0; }
		printf 'HTTP/1.1 200 OK\nContent-Type: application/gzip\nContent-Disposition: attachment; filename="%s.tar.gz"\n\n' "$(dname "$(basename "$f")")"
		tar c -f - -C "$(dirname "$f")" "$(basename "$f")" 2>/dev/null | gzip
	fi
	exit 0
fi

if [ ! -f "$f" ]; then
	printf 'HTTP/1.1 404 Not Found\nContent-Type: text/plain\n\nnot a file\n'
	exit 0
fi
printf 'HTTP/1.1 200 OK\nContent-Type: application/octet-stream\nContent-Disposition: attachment; filename="%s"\n\n' "$(dname "$(basename "$f")")"
cat "$f"
