#!/usr/bin/haserl
<%in p/common.cgi %>

<%
# The page title is rendered by this page rather than by header.cgi, at the top
# of the rail instead of in a full-width band above both columns. The band cost
# 94px of every window — a 2rem margin, a 32px heading and the row's gutter —
# and it bought a second copy of a name the rail's active item and the browser
# tab already carry. In the rail it costs the picture nothing: the two columns
# start at the same y, and the rail is the taller of them anyway. It is still a
# real <h2>, so the document keeps its heading (#239).
hide_title=1
# ?tab= now names a section, not a category. Left empty the client picks the
# first leaf of the first group; defaulting to "image" would have resolved to
# the section of that name rather than the group, which is a different page.
label="$GET_tab"

mj_json_escape() {
	sed 's/\\/\\\\/g; s/"/\\"/g'
}

labels=$(sed -n 's/^mj_\([A-Za-z0-9]*\)=\(.*\)/"\1":"\2"/p' j/locale.cgi 2>/dev/null | paste -sd,)

boot_exclude=""
if [ -e j/exclude.lst ]; then
	while IFS= read -r line; do
		[ -z "$line" ] && continue
		line="${line#.}"
		e=$(echo -n "$line" | mj_json_escape)
		boot_exclude="${boot_exclude}${boot_exclude:+,}\"${e}\""
	done < j/exclude.lst
fi

boot_sensors=""
if [ -d /etc/sensors ]; then
	for f in $(find /etc/sensors -maxdepth 1 -type f 2>/dev/null); do
		e=$(echo -n "$f" | mj_json_escape)
		boot_sensors="${boot_sensors}${boot_sensors:+,}\"${e}\""
	done
fi
%>

<%in p/header.cgi %>

<% if [ -z "$(pidof majestic majestic.new)" ]; then %>

<%# The wiki's front page used to stand here as "more information", printed as
    plain text rather than a link, about a daemon that has stopped. The log is
    where majestic says why it died -- and it is what an owner can screenshot
    for whoever sold them the camera -- and a restart is the thing to try. %>
<% notice danger '<b>Majestic is not running</b> &mdash; the daemon that streams the video and answers for every setting on this page is stopped, so there is nothing here to configure.' '<a class="btn btn-sm btn-secondary" href="logs.cgi">Open the log</a><a class="btn btn-sm btn-danger" href="restart.cgi" data-confirm="Restart the camera now?&#10;&#10;Settings are kept. The camera is unreachable for about half a minute while it comes back.">Restart camera</a>' %>

<% else %>

<div class="row g-4 mb-4">
	<%
	# The rail carries a two-level tree (category > section) rather than the six
	# category pills it used to, so it keeps col-md-3 all the way up instead of
	# narrowing to col-lg-2. No new Bootstrap class: www/a/bootstrap.min.css is a
	# PurgeCSS subset and col-md-8 is not in it, so widening the other way would
	# have meant regenerating it.
	%>
	<div class="col-12 col-md-3">
		<div class="sticky-md-top">
			<h2 class="mj-rail-title"><%= $page_title %></h2>
			<%
			# Hidden until mj-settings.js unhides it: with no JS the box would be
			# a control that silently does nothing.
			%>
			<p class="d-none mj-search" id="mj-search-wrap">
				<input type="search" class="form-control form-control-sm" id="mj-search"
					placeholder="Search settings…" autocomplete="off" aria-label="Search settings"
					aria-controls="mj-settings-nav">
			</p>
			<ul class="nav nav-pills flex-column small" id="mj-settings-nav"></ul>
		</div>
	</div>

	<div class="col-12 col-md-9" id="mj-settings-form-col">
		<script type="application/json" id="mj-settings-boot">{"tab":"<%= $label %>","labels":{<%= $labels %>},"exclude":[<%= $boot_exclude %>],"sensors":[<%= $boot_sensors %>]}</script>

		<%
		# No page-level heading any more: one section is shown at a time and its
		# card carries its own <h3>, so a second copy of the same words above it
		# was just noise.
		%>
		<form id="mj-settings-form" action="javascript:void(0)" autocomplete="off">
			<p class="text-secondary small mb-0">Loading settings…</p>
		</form>
	</div>
</div>

<script src="/a/preview.js"></script>
<script src="/a/preview-webrtc.js"></script>
<script src="/a/preview-swap.js"></script>
<script src="/a/preview-wasm.js"></script>
<script src="/a/preview-transport.js"></script>
<%
# preview-hero.js publishes window.MajesticHero (fullscreen + snapshot) before
# it looks for the Live page's own stage, so this page can share those two
# behaviours for the stage mj-settings.js builds client-side.
%>
<script src="/a/preview-hero.js"></script>
<%
# The camera picture as an embeddable stage: it builds the video/canvas slots,
# runs the transport ladder over the four scripts above, and hands back a
# handle. Any section that wants to be looked at while it is changed mounts one;
# the Live adjustments leaf is the first, and it is not meant to be the last.
# Not deferred, because mj-settings.js (which is) calls into it at render time.
%>
<script src="/a/mj-preview.js"></script>
<%
# The luma histogram is computed in the browser off the decoded picture, so it
# needs nothing from the camera and no endpoint of its own.
%>
<script src="/a/mj-luma.js"></script>
<script src="/a/ircut-check.js" defer></script>
<script src="/a/ircut-map.js" defer></script>
<script src="/a/ircut-scan.js" defer></script>
<%
# The Day/Night section's light-monitor chart shares the dashboard's chart
# primitives rather than growing its own.
%>
<script src="/a/charts.js" defer></script>
<script src="/a/mj-requires.js" defer></script>
<%
# The settings tree — which leaf every schema key is drawn on. Its own file so
# tests/tree.test.js can ask it; mj-settings.js has no page without it.
%>
<script src="/a/mj-tree.js" defer></script>
<script src="/a/mj-region.js" defer></script>
<script src="/a/mj-settings.js" defer></script>

<% fi %>

<%in p/footer.cgi %>
