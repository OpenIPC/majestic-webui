#!/usr/bin/haserl
<%in p/common.cgi %>
<%
	page_title="Erasing Overlay"
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
	# alone", which is just as true of the run.cgi flow. Besides skipping the
	# sysupgrade self-update it gates nothing else, and nothing later in the run
	# touches majestic: that killall is the only one in the script, and -n
	# rewrites rootfs_data, not the rootfs majestic runs from. So the log now
	# survives all the way to the reboot.
	c="/usr/sbin/sysupgrade -s -n -x --web"
	r="true"
%>

<%in p/header.cgi %>
<div class="alert alert-warning">Do not close, refresh, or navigate away from this page until the process finishes. The camera will reboot automatically.</div>
<div class="card"><div class="card-body">
	<h3>Progress</h3>
	<pre id="output" class="mb-0" data-cmd="<%= $c %>" data-reboot="<%= $r %>"></pre>
</div></div>

<script>
	const el = $('pre#output');
	// Stop the header heartbeat for the same reason fw-update.js does: every tick
	// forks a dozen processes and makes a loopback request into the majestic that
	// is streaming this log. Fine on an idle camera, ruinous on one erasing its
	// own flash — and only now worth saying, because until --web above kept
	// majestic alive these ticks died against a stopped server anyway. Keeping it
	// running would trade one bug for a quieter one.
	if (typeof stopHeartbeat === 'function') stopHeartbeat();
	runCmd("cmd")
</script>
<%in p/footer.cgi %>
