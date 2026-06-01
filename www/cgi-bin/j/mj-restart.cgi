#!/usr/bin/haserl
<%
if [ "$REQUEST_METHOD" = "POST" ]; then
	killall -1 majestic 2>/dev/null
	killall -1 majestic.new 2>/dev/null
	[ -d /tmp/webui ] && echo "success:Majestic restart signal sent." > /tmp/webui/logfile.txt
fi

location="${HTTP_REFERER:-/cgi-bin/mj-settings.cgi}"

echo "HTTP/1.1 303 See Other"
echo "Content-type: text/html; charset=UTF-8"
echo "Cache-Control: no-store"
echo "Pragma: no-cache"
echo "Location: $location"
echo
exit 0
%>
