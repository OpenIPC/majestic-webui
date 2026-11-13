#!/usr/bin/haserl
<%in p/common.cgi %>
<%
	# --web is not optional here, despite there being no WebSocket in sight.
	#
	# free_resources() opens with `killall -q -3 majestic` unless web_update is
	# set — and majestic is the server running this very CGI, whose stdout is the
	# stream feeding the box below. Without the flag the reset kills its own
	# progress log: the transcript stops dead on "Stop services, sync files, free
	# up memory", the line printed immediately before the signal, and the page
	# then sits there while the camera wipes and reboots underneath it (#154).
	#
	# The flag reads as upgrade-specific because /ws/upgrade needed it first, but
	# what it means to sysupgrade is "majestic is streaming this, leave it
	# alone", which is just as true of this one. Besides skipping the
	# sysupgrade self-update it gates nothing else, and nothing later in the run
	# touches majestic: that killall is the only one in the script, and -n
	# rewrites rootfs_data, not the rootfs majestic runs from. So the log now
	# survives all the way to the reboot.
	#
	# What is NOT passed any more, and why:
	#
	#   -x (--no_reboot) — asked sysupgrade to leave the reboot to us, back when
	#   this page hopped to restart.cgi at the end to take it. sysupgrade
	#   cannot honour that here: rootfs_data is the upper layer of the overlay
	#   the running root is assembled from, so erasing it takes the live
	#   filesystem with it and only a reboot puts one back. It says as much —
	#   four lines of NOTICE and a five-second wait for a Ctrl-C nobody watching
	#   a web page can send — and then reboots anyway. So the flag bought a
	#   warning about itself and a stall, and asked for a reboot that had already
	#   been decided (#154). factory-reset.js waits that reboot out rather than
	#   ordering one.
	#
	#   -s — sysupgrade's silent mode, which pipes every progress meter through
	#   `awk '{print NR, $1}'`. flash_eraseall redraws one line with a bare \r
	#   and never emits a newline until it is done, so awk saw the whole erase as
	#   a single record and printed the whole of it as "1 Erasing" — after the
	#   fact. Dropping it puts the real meter back: one redraw per erase block,
	#   about five a second, which on a camera whose overlay takes half a minute
	#   to erase is the difference between progress and a frozen page (#154).
	#
	# The reset is the POST to this page, and nothing else runs it. The GET draws
	# the page; factory-reset.js then POSTs here and reads the response as the
	# transcript. A fixed command behind a POST, never a command named by the
	# page: the reset is a mutation, and a GET is what a browser issues on its
	# own.
	if [ "$REQUEST_METHOD" = "POST" ]; then
		printf 'HTTP/1.1 200 OK\nContent-Type: text/plain; charset=UTF-8\nCache-Control: no-store\n\n'
		cd /tmp || exit 1
		# stdin from /dev/null: haserl feeds the script to the shell on it.
		/usr/sbin/sysupgrade -n --web </dev/null 2>&1
		exit 0
	fi
%>

<%in p/header.cgi %>
<div id="fw-reset-status" class="mj-notice mj-notice-warn" role="alert">
	<% notice_icon warn %>
	<div class="mj-notice-txt">Do not close, refresh, or navigate away from this page until the process finishes. The camera will reboot automatically.</div>
</div>
<div class="card"><div class="card-body">
	<% card_head "Progress" %>
	<pre id="output" class="mb-0"></pre>
</div></div>

<script src="/a/factory-reset.js" defer></script>
<%in p/footer.cgi %>
