#!/usr/bin/haserl
<%in p/common.cgi %>
<% page_title="Crash report" %>
<%in p/header.cgi %>
<%
# The owner-facing half of the crash report. On the normal boot after a crash
# the firmware leaves state under /etc/crash -- a preserved, gzipped pstore log
# (crash.tar.gz plus a "pending" summary) and/or a "failsafe" breadcrumb when
# the camera fell into failsafe. This page reads that state and hands the log to
# the owner for a bug report. It never uploads anything and does not clear the
# state -- that is Dismiss, which mutates and so lives in crashlog-download.cgi
# where no page body precedes the redirect.
CRASH=/etc/crash
crash_utc=$(sed -n 's/^utc=//p' "$CRASH/pending" 2>/dev/null)
crash_records=$(sed -n 's/^records=//p' "$CRASH/pending" 2>/dev/null)
crash_bytes=$(sed -n 's/^bytes=//p' "$CRASH/pending" 2>/dev/null)
fs_utc=$(sed -n 's/^utc=//p' "$CRASH/failsafe" 2>/dev/null)
%>

<div class="row g-4">
	<div class="col-12 col-lg-8">
		<div class="card mb-4"><div class="card-body">
			<% card_head "Crash report" %>
			<% if [ -f "$CRASH/pending" ] || [ -f "$CRASH/failsafe" ]; then %>
			<p class="small text-secondary">This camera recovered from a crash. The log below is for a
				bug report &mdash; nothing has been sent anywhere.</p>
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
				<% if [ -s "$CRASH/crash.tar.gz" ]; then %>
				<a class="btn btn-primary" href="crashlog-download.cgi?get=log">Download crash log</a>
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
			<% else %>
			<p class="small text-secondary mb-0">No crash on record. If this camera reboots unexpectedly
				or drops into failsafe, the log appears here.</p>
			<% fi %>
		</div></div>
	</div>
</div>

<%in p/footer.cgi %>
