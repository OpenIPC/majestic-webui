#!/bin/sh
# PTZ step handler: GPIO stepper (gpio-motors) or profile motor (/usr/bin/motor + U-Boot ptz=).

echo "HTTP/1.1 200 OK
Content-type: text/plain; charset=UTF-8
Cache-Control: no-store
Pragma: no-cache

"

HORIZONTAL=0
VERTICAL=0
for param in $(echo "$QUERY_STRING" | tr '&' ' '); do
	case "$param" in
		h=*) HORIZONTAL="${param#*=}" ;;
		v=*) VERTICAL="${param#*=}" ;;
	esac
done

# Small signed integers only — these become argv of a binary that drives
# hardware. The pad sends ±5; ±99 leaves room for a coarser caller without
# letting one request command a four-digit sweep. Anything else is a step of
# zero, same as j/time.cgi's pattern.
echo "$HORIZONTAL" | grep -qE '^-?[0-9]{1,2}$' || HORIZONTAL=0
echo "$VERTICAL" | grep -qE '^-?[0-9]{1,2}$' || VERTICAL=0

if command -v gpio-motors >/dev/null 2>&1 && [ -n "$(fw_printenv -n gpio_motors 2>/dev/null)" ]; then
	gpio-motors "$HORIZONTAL" "$VERTICAL" 10
	exit $?
fi

ptz=$(fw_printenv -n ptz 2>/dev/null)
if [ -x /usr/bin/motor ] && [ -n "$ptz" ]; then
	/usr/bin/motor "$ptz" "$HORIZONTAL" "$VERTICAL"
	exit $?
fi

echo "PTZ not available on this device."
exit 1
