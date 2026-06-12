#!/bin/sh
# Write the request body to a file, reading it from stdin (needs majestic's
# CGI-body-to-stdin support). In-place write preserves the existing mode.
# POST/PUT ?path=<file>  body=<content>  -> {"ok":bool}

printf 'HTTP/1.1 200 OK\nContent-Type: application/json\nCache-Control: no-store\n\n'

f="$GET_path"
if [ -z "$f" ]; then
	printf '{"ok":false,"error":"no path"}'
elif cat > "$f"; then
	printf '{"ok":true}'
else
	printf '{"ok":false,"error":"write failed"}'
fi
