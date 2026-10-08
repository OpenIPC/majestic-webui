#!/usr/bin/haserl
<%in p/common.cgi %>
<% page_title="Crash report" %>
<%in p/header.cgi %>
<%
# The owner-facing half of the crash report. On the normal boot after a crash
# the firmware leaves state under /etc/crash -- a preserved, gzipped pstore log
# (crash.tar.gz plus a "pending" summary) and/or a "failsafe" breadcrumb when
# the camera fell into failsafe. This page reads that state, hands the log to
# the owner, and offers to send it to openipc.org, where crashes from every
# camera are filed by bug (sbin/crashlog-send). Nothing goes unless the owner
# presses Send or has said crashes may go on their own. Sending, that choice
# and Dismiss all mutate, so they live in crashlog-download.cgi, where no page
# body precedes the redirect.
CRASH=/etc/crash
crash_utc=$(sed -n 's/^utc=//p' "$CRASH/pending" 2>/dev/null)
crash_records=$(sed -n 's/^records=//p' "$CRASH/pending" 2>/dev/null)
crash_bytes=$(sed -n 's/^bytes=//p' "$CRASH/pending" 2>/dev/null)
fs_utc=$(sed -n 's/^utc=//p' "$CRASH/failsafe" 2>/dev/null)
# What openipc.org said about this crash, if it was sent -- this one: the note
# names the crash it was for, and the firmware keeps only the latest.
crash_sum=$(cat "$CRASH/crash.tar.gz" "$CRASH/failsafe" 2>/dev/null | md5sum | cut -d' ' -f1)
sent_url= sent_title= sent_utc=
if [ "$(sed -n 's/^bundle=//p' "$CRASH/sent" 2>/dev/null)" = "$crash_sum" ]; then
	sent_url=$(sed -n 's/^url=//p' "$CRASH/sent")
	sent_title=$(sed -n 's/^title=//p' "$CRASH/sent")
	sent_utc=$(sed -n 's/^utc=//p' "$CRASH/sent")
fi
case "$sent_url" in https://*) ;; *) sent_url= ;; esac
[ -e /etc/webui/crashlog.conf ] && include /etc/webui/crashlog.conf
%>

<div class="row g-4">
	<div class="col-12 col-lg-8">
		<div class="card mb-4"><div class="card-body">
			<% card_head "Crash report" %>
			<% if [ -f "$CRASH/pending" ] || [ -f "$CRASH/failsafe" ]; then %>
			<% if [ -n "$sent_utc" ]; then %>
			<p class="small text-secondary">This camera recovered from a crash, and it was sent to
				openipc.org on <% esc "$sent_utc" %> UTC.</p>
			<% else %>
			<p class="small text-secondary">This camera recovered from a crash. Nothing has been sent
				anywhere: send it to OpenIPC and it is filed with the same crash from other cameras, so the bug
				can be found and fixed.</p>
			<% fi %>
			<dl class="row small mb-3">
				<% if [ -n "$crash_utc" ]; then %>
				<dt class="col-sm-3 text-secondary">Captured</dt>
				<dd class="col-sm-9"><% esc "$crash_utc" %> UTC</dd>
				<% fi %>
				<% if [ -n "$fs_utc" ]; then %>
				<dt class="col-sm-3 text-secondary">Failsafe</dt>
				<dd class="col-sm-9">entered <% esc "$fs_utc" %> UTC after repeated boot failure</dd>
				<% fi %>
				<% if [ -n "$crash_records" ]; then %>
				<dt class="col-sm-3 text-secondary">Kernel log</dt>
				<dd class="col-sm-9"><% esc "$crash_records" %> pstore record(s), <% esc "$crash_bytes" %> bytes compressed</dd>
				<% fi %>
			</dl>
			<div class="d-flex gap-2 flex-wrap align-items-center">
				<% if [ -z "$sent_utc" ] && { [ -s "$CRASH/crash.tar.gz" ] || [ -f "$CRASH/failsafe" ]; }; then %>
				<form method="post" action="crashlog-download.cgi" class="d-inline m-0">
					<input type="hidden" name="action" value="send">
					<button type="submit" class="btn btn-primary">Send to OpenIPC</button>
				</form>
				<% fi %>
				<% if [ -s "$CRASH/crash.tar.gz" ]; then %>
				<a class="btn btn-outline-primary" href="crashlog-download.cgi?get=log">Download crash log</a>
				<% elif [ -n "$fs_utc" ]; then %>
				<span class="small text-secondary">No kernel panic was captured &mdash; the failsafe event above is on record.</span>
				<% else %>
				<span class="small text-secondary">The crash log is no longer available.</span>
				<% fi %>
				<form method="post" action="crashlog-download.cgi" class="d-inline m-0">
					<input type="hidden" name="action" value="dismiss">
					<button type="submit" class="btn btn-outline-secondary">Dismiss</button>
				</form>
			</div>
			<% if [ -n "$sent_utc" ]; then %>
			<p class="small mt-3 mb-0">Filed under
				<% if [ -n "$sent_url" ]; then %><a href="<% attr_escape "$sent_url" %>"><% esc "$sent_title" %></a><% else %><% esc "$sent_title" %><% fi %>.</p>
			<% fi %>
			<% else %>
			<p class="small text-secondary mb-0">No crash on record. If this camera reboots unexpectedly
				or drops into failsafe, the log appears here.</p>
			<% fi %>
		</div></div>
		<div class="card mb-4"><div class="card-body">
			<% card_head "Sending crashes" %>
			<%# ?ref carries the same word the footer's link to the same site
			    carries; p/footer.cgi says what it is. %>
			<p class="small text-secondary">What is sent: the kernel's log of the crash, as Download gives it,
				and the camera's MAC address, chip, sensor, firmware and Majestic version. openipc.org replaces
				the MAC and every IP address in the log with hashes, and only OpenIPC's maintainers read the log;
				<a href="https://openipc.org/crashes?ref=webui">the list of crashes</a> shows only which code
				crashed and on which chips. No picture, settings or password is sent. A camera linked to your
				<a href="https://openipc.org/club?ref=webui">OpenIPC Club</a> account on the OpenWall page
				earns you stars for the crashes it sends.</p>
			<form action="crashlog-download.cgi" method="post">
				<input type="hidden" name="action" value="auto">
				<% field_switch "crashlog_auto" "Send crashes on their own" "eval" "Each crash this camera recovers from goes to openipc.org within ten minutes of the camera coming back, without waiting for you to open this page." %>
				<% field_switch "crashlog_proxy" "Use SOCKS5" "eval" "<a href=\"proxy.cgi\">Configure proxy access.</a>" %>
				<% button_submit %>
			</form>
		</div></div>
	</div>
</div>

<%in p/footer.cgi %>
