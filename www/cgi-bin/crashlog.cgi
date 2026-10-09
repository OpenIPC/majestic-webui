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
# The earlier crashes the firmware kept because nobody had dismissed them, and
# how many of those are still to go.
older_kept=0 older_unsent=0
for f in "$CRASH/older"/*.tar.gz; do
	[ -s "$f" ] || continue
	older_kept=$((older_kept + 1))
	[ -s "$f.sent" ] || older_unsent=$((older_unsent + 1))
done
[ -e /etc/webui/crashlog.conf ] && include /etc/webui/crashlog.conf

# majestic's own crashes: the dump it leaves when it dies of a signal, the one
# before it as .1, and the firmware's note when it stopped restarting it. The
# dump's header is text (key=value lines) at its start; the rest is memory,
# which is never shown here.
# busybox's tr has no [:print:]: the printable range, by octal.
mj_field() {
	head -c 1024 "$1" 2>/dev/null | tr -c '\040-\176\n' '\n' | sed -n "s/^$2=//p" | head -n 1
}
mj_signal() {
	case "$1" in
	11) echo SIGSEGV ;; 6) echo SIGABRT ;; 4) echo SIGILL ;; 8) echo SIGFPE ;; 7 | 10) echo SIGBUS ;;
	*) echo "signal $1" ;;
	esac
}
mj_when() {
	date -u -d "@$1" '+%Y-%m-%d %H:%M' 2>/dev/null || echo "$1"
}
mj_dumps=0 mj_unsent=0
for f in "$CRASH/majestic.dump" "$CRASH/majestic.dump.1"; do
	[ -s "$f" ] || continue
	mj_dumps=$((mj_dumps + 1))
	grep -q "^$(md5sum < "$f" | cut -d' ' -f1) " "$CRASH/majestic.sent" 2>/dev/null || mj_unsent=$((mj_unsent + 1))
done
mj_loop_utc=$(sed -n 's/^utc=//p' "$CRASH/majestic.loop" 2>/dev/null)
# The note says the firmware stopped restarting it; it is true only while
# majestic is not running again.
mj_stopped=
[ -f "$CRASH/majestic.loop" ] && ! pidof majestic >/dev/null 2>&1 && mj_stopped=1
%>

<div class="row g-4">
	<div class="col-12 col-lg-8">
		<div class="card mb-4"><div class="card-body">
			<% card_head "Crash report" %>
			<% if [ -f "$CRASH/pending" ] || [ -f "$CRASH/failsafe" ] || [ "$older_kept" -gt 0 ] || [ "$mj_dumps" -gt 0 ] || [ -f "$CRASH/majestic.loop" ]; then %>
			<% if [ "$mj_unsent" -gt 0 ]; then %>
			<p class="small text-secondary">majestic, the streamer, crashed<% if [ -n "$mj_stopped" ]; then %> again and again,
				and was stopped<% fi %>. Its crash has not been sent: send it to OpenIPC and it is filed with the same
				crash from other cameras, so the bug can be found and fixed.</p>
			<% elif [ -n "$sent_utc" ]; then %>
			<p class="small text-secondary">This camera recovered from a crash, and the latest one was
				sent to openipc.org on <% esc "$sent_utc" %> UTC.</p>
			<% elif [ -f "$CRASH/pending" ] || [ -f "$CRASH/failsafe" ]; then %>
			<p class="small text-secondary">This camera recovered from a crash. The latest one has not
				been sent: send it to OpenIPC and it is filed with the same crash from other cameras, so the bug
				can be found and fixed.</p>
			<% elif [ -n "$mj_stopped" ]; then %>
			<p class="small text-secondary">majestic, the streamer, kept crashing and was stopped.</p>
			<% elif [ "$mj_dumps" -gt 0 ] || [ -f "$CRASH/majestic.loop" ]; then %>
			<p class="small text-secondary">majestic, the streamer, crashed, and its crashes were sent.</p>
			<% else %>
			<p class="small text-secondary">This camera recovered from crashes earlier, kept until you
				dismiss them.</p>
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
				<% for f in "$CRASH/majestic.dump" "$CRASH/majestic.dump.1"; do
					[ -s "$f" ] || continue
					mj_sig=$(mj_signal "$(mj_field "$f" signal)")
					mj_wall=$(mj_field "$f" wall)
					mj_ver=$(mj_field "$f" version) %>
				<dt class="col-sm-3 text-secondary">majestic crashed</dt>
				<dd class="col-sm-9"><% esc "$mj_sig" %><% if [ -n "$mj_wall" ]; then %>, <% esc "$(mj_when "$mj_wall")" %> UTC<% fi %><% if [ -n "$mj_ver" ]; then %>, version <% esc "$mj_ver" %><% fi %>
					&middot; <a href="crashlog-download.cgi?get=majestic<% [ "$f" = "$CRASH/majestic.dump.1" ] && echo -n '&amp;which=1' %>">download</a></dd>
				<% done %>
				<% if [ -n "$mj_stopped" ]; then %>
				<dt class="col-sm-3 text-secondary">Stopped</dt>
				<dd class="col-sm-9">majestic kept crashing<% if [ -n "$mj_loop_utc" ]; then %> until <% esc "$mj_loop_utc" %> UTC<% fi %>
					and is no longer restarted: there is no video until it is started again, or the camera rebooted.</dd>
				<% elif [ "$mj_dumps" -gt 0 ]; then %>
				<dt class="col-sm-3 text-secondary">majestic</dt>
				<dd class="col-sm-9"><% if [ "$mj_unsent" -gt 0 ]; then %><% esc "$mj_unsent" %> of its crashes not sent yet<% else %>its crashes were sent<% fi %></dd>
				<% fi %>
				<% if [ "$older_kept" -gt 0 ]; then %>
				<dt class="col-sm-3 text-secondary">Earlier crashes</dt>
				<dd class="col-sm-9"><% esc "$older_kept" %> kept since the last Dismiss<% if [ "$older_unsent" -gt 0 ]; then %>, <% esc "$older_unsent" %> not sent yet<% else %>, all sent<% fi %></dd>
				<% fi %>
			</dl>
			<div class="d-flex gap-2 flex-wrap align-items-center">
				<% if { [ -z "$sent_utc" ] && { [ -s "$CRASH/crash.tar.gz" ] || [ -f "$CRASH/failsafe" ]; }; } || [ "$older_unsent" -gt 0 ] || [ "$mj_unsent" -gt 0 ]; then %>
				<form method="post" action="crashlog-download.cgi" class="d-inline m-0">
					<input type="hidden" name="action" value="send">
					<button type="submit" class="btn btn-primary">Send to OpenIPC</button>
				</form>
				<% fi %>
				<% if [ -s "$CRASH/crash.tar.gz" ]; then %>
				<a class="btn btn-outline-primary" href="crashlog-download.cgi?get=log">Download crash log</a>
				<% elif [ -n "$fs_utc" ]; then %>
				<span class="small text-secondary">No kernel panic was captured &mdash; the failsafe event above is on record.</span>
				<% elif [ "$mj_dumps" -gt 0 ] || [ -f "$CRASH/majestic.loop" ]; then
					: # majestic's crash has its own Download below
				else %>
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
				a crash of majestic's own also carries a slice of majestic's memory at the moment it crashed, which
				can hold what it was handling: only OpenIPC's maintainers can read it, and openipc.org deletes it
				once it has made the backtrace from it;
				<a href="https://openipc.org/crashes?ref=webui">the list of crashes</a> shows only which code
				crashed and on which chips. No picture, no settings file and no password file is sent; what
				majestic held in memory when it crashed is the one thing that can carry anything, which is why only
				the maintainers read it and it is deleted once used. A camera linked to your
				<a href="https://openipc.org/club?ref=webui">OpenIPC Club</a> account on the OpenWall page
				earns you stars for the crashes it sends.</p>
			<form action="crashlog-download.cgi" method="post">
				<input type="hidden" name="action" value="auto">
				<% field_switch "crashlog_auto" "Send crashes on their own" "eval" "Each crash this camera recovers from goes to openipc.org within ten minutes of the camera coming back, without waiting for you to open this page." %>
				<% field_switch "crashlog_majestic" "Send majestic's crashes on their own too" "eval" "Each crash of majestic's goes as well, with the slice of its memory said above. Off, they go only when you press Send." %>
				<% field_switch "crashlog_proxy" "Use SOCKS5" "eval" "<a href=\"proxy.cgi\">Configure proxy access.</a>" %>
				<% button_submit %>
			</form>
		</div></div>
	</div>
</div>

<%in p/footer.cgi %>
