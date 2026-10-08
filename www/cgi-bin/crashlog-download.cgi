#!/usr/bin/haserl
<%in p/common.cgi %>
<%
# The mutating side of the crash report: streams the preserved log for download,
# sends it to openipc.org, keeps the owner's choice about sending on its own,
# or clears it on Dismiss. All of it must run before any page body so
# redirect_to and the download headers are the first output -- the same reason
# backup-create.cgi is separate from backup.cgi. Auth is common.cgi's; the log
# is root-only.
CRASH=/etc/crash
config_file=/etc/webui/crashlog.conf

# Send -- the owner pressing the button, for this crash. sbin/crashlog-send
# says what it did in one sentence, which is what the page shows -- escaped,
# because the sentence carries what openipc.org answered and a notice is
# rendered as markup.
if [ "$REQUEST_METHOD" = "POST" ] && [ "$POST_action" = "send" ]; then
	if said=$(/usr/sbin/crashlog-send 2>&1); then
		redirect_to "crashlog.cgi" "success" "$(esc "$said")"
	fi
	redirect_to "crashlog.cgi" "danger" "$(esc "${said:-The crash could not be sent.}")"
fi

# Sending on its own -- the owner's standing yes, kept until they take it back.
# On, cron offers each crash the camera recovers from to the sender every ten
# minutes; the sender sends only one it has not sent already.
if [ "$REQUEST_METHOD" = "POST" ] && [ "$POST_action" = "auto" ]; then
	[ "$POST_crashlog_auto" = "true" ] || POST_crashlog_auto=false
	[ "$POST_crashlog_proxy" = "true" ] || POST_crashlog_proxy=false
	{
		conf_write crashlog_auto "$POST_crashlog_auto"
		conf_write crashlog_proxy "$POST_crashlog_proxy"
	} > "$config_file"
	sed -i '\#/usr/sbin/crashlog-send#d' /etc/crontabs/root
	if [ "$POST_crashlog_auto" = "true" ]; then
		echo "*/10 * * * * /usr/sbin/crashlog-send --auto" >> /etc/crontabs/root
		redirect_to "crashlog.cgi" "success" "Crashes will be sent to openipc.org on their own."
	fi
	redirect_to "crashlog.cgi" "success" "Crashes will be sent only when you press Send."
fi

# Dismiss -- drop the notice and free the space, on the camera's next glance and
# for good. Clears the overlay bundle and the live pstore ring together.
if [ "$REQUEST_METHOD" = "POST" ] && [ "$POST_action" = "dismiss" ]; then
	rm -f "$CRASH/pending" "$CRASH/failsafe" "$CRASH/crash.tar.gz" "$CRASH/sent" 2>/dev/null
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
