#!/bin/sh
# Apply saved Majestic settings that aren't live-tunable (resolution, codec,
# frame rate, ...). majestic IS the HTTP server, so we don't restart the
# process — we send it SIGHUP, which its libevent handler turns into an
# in-process exit_sdk()+reload_sdk() (re-reads the config and rebuilds the
# encoder pipeline) while the web server keeps running. Backgrounded with a
# short delay so this request returns *before* the reload briefly ties up the
# event loop; the client then polls /api/v1/config.json until it answers again.
( sleep 1; killall -HUP majestic ) >/dev/null 2>&1 &

echo "HTTP/1.1 200 OK
Content-type: application/json
Cache-Control: no-store

{\"ok\":true}
"
