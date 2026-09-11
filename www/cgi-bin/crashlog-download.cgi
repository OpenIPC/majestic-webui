#!/usr/bin/haserl
<%in p/common.cgi %>
<%
# The mutating side of the crash report: streams the preserved log for download,
# or clears it on Dismiss. Both must run before any page body so redirect_to and
# the download headers are the first output -- the same reason backup-create.cgi
# is separate from backup.cgi. Auth is common.cgi's; the log is root-only.
CRASH=/etc/crash

# Dismiss -- drop the notice and free the space, on the camera's next glance and
# for good. Clears the overlay bundle and the live pstore ring together.
if [ "$REQUEST_METHOD" = "POST" ] && [ "$POST_action" = "dismiss" ]; then
	rm -f "$CRASH/pending" "$CRASH/failsafe" "$CRASH/crash.tar.gz" 2>/dev/null
	rm -f /sys/fs/pstore/dmesg-* 2>/dev/null
	redirect_to "dashboard.cgi"
	exit 0
fi

# Download the preserved bundle (gzipped tar of the pstore records).
if [ "$GET_get" = "log" ] && [ -s "$CRASH/crash.tar.gz" ]; then
	fn="crashlog_${network_address}_"`date +%Y-%m-%d_%H-%M-%S`".tar.gz"
	echo "Content-type: application/tar+gzip"
	echo "Content-Transfer-Encoding: binary"
	echo "Cache-Control: no-store"
	echo "Pragma: no-cache"
	echo "Content-Disposition: attachment; filename=$fn"
	echo
	cat "$CRASH/crash.tar.gz"
	exit 0
fi

# Nothing to serve -> back to the report page.
redirect_to "crashlog.cgi"
%>
