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

# Everything this escapes lands inside <script type="application/json">, which
# is a RAW TEXT element: the HTML parser looks for `</script` in it and stops
# there, without caring that it is inside a JSON string. So escaping quotes and
# backslashes is not enough — a value containing `</script>` closes the block
# early and whatever follows is parsed as markup in an administrator's page.
#
# `<` becomes its \u escape, which JSON.parse reads straight back as `<` and
# the HTML parser can no longer see. Done in the one helper every field goes
# through rather than at the four call sites: the font paths come from
# filenames on a writable filesystem and `soc` from the boot loader's
# environment, and the next field added here will have the same problem.
#
# Order matters and is the order below: backslashes double FIRST, so the ones
# this rule introduces are not doubled again.
mj_json_escape() {
	sed 's/\\/\\\\/g; s/"/\\"/g; s/</\\u003c/g'
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

# The part this camera is, as sysinfo spells it. The Day/Night pin map has
# always had a caption for it and mj-settings.js has always passed
# `window.mjSoc` — which nothing in this tree ever assigned, so the caption
# rendered as a bare " · 10 banks" on every camera. It is also what lets the pin
# sweep read the wiki's per-part pad table (a/ircut-pads.js) instead of driving
# the same pads in the same order everywhere.
boot_soc=$(printf '%s' "$soc" | mj_json_escape)

boot_sensors=""
if [ -d /etc/sensors ]; then
	for f in $(find /etc/sensors -maxdepth 1 -type f 2>/dev/null); do
		e=$(echo -n "$f" | mj_json_escape)
		boot_sensors="${boot_sensors}${boot_sensors:+,}\"${e}\""
	done
fi

# The fonts the camera can draw the overlay with. One face ships with the
# firmware; the point of listing rather than hardcoding is the ones an owner
# adds to their own image, which is the only way there are ever two.
#
# By extension and recursively, because freetype takes a path and not a name:
# nothing requires an added face to sit beside the shipped one, or in a flat
# directory. Full paths, since that is what the setting stores; the picker
# shows the face name.
boot_fonts=""
if [ -d /usr/share/fonts ]; then
	# Split on newlines only, and do not glob what comes back. The plain
	# `for f in $(find ...)` splits on every space and tab and then expands
	# what it split as a pattern, so a font in a directory with a space in its
	# name arrived as two fragments and one with a bracket in it arrived as
	# whatever happened to match — and the picker then stored a path the
	# camera cannot open. Not a pipe into `while read`: that is a subshell in
	# POSIX sh and boot_fonts would not survive it.
	_ifs=$IFS
	IFS='
'
	set -f
	for f in $(find /usr/share/fonts -type f \
		\( -name '*.ttf' -o -name '*.otf' -o -name '*.ttc' \) 2>/dev/null); do
		e=$(printf '%s' "$f" | mj_json_escape)
		boot_fonts="${boot_fonts}${boot_fonts:+,}\"${e}\""
	done
	set +f
	IFS=$_ifs
fi
%>

<%in p/header.cgi %>

<% if [ -z "$(pidof majestic majestic.new)" ]; then %>

<%# The wiki's front page used to stand here as "more information", printed as
    plain text rather than a link, about a daemon that has stopped. The log is
    where majestic says why it died -- and it is what an owner can screenshot
    for whoever sold them the camera -- and a restart is the thing to try. %>
<% notice danger '<b>Majestic is not running</b> &mdash; the daemon that streams the video and answers for every setting on this page is stopped, so there is nothing here to configure.' '<a class="btn btn-sm btn-secondary" href="logs.cgi">Open the log</a><form method="post" action="restart.cgi" class="d-inline"><button type="submit" class="btn btn-sm btn-danger confirm" data-confirm="Restart the camera now?&#10;&#10;Settings are kept. The camera is unreachable for about half a minute while it comes back.">Restart camera</button></form>' %>

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
		<div class="sticky-md-top" id="mj-rail">
			<h2 class="mj-rail-title"><%= $page_title %></h2>
			<%
			# Below md the tree folds behind this, so a phone opens on the section
			# rather than on a screen of menu (#587). Hidden until mj-settings.js
			# names the section in it: with no JS the tree simply stays open.
			%>
			<button type="button" class="mj-rail-toggle" id="mj-rail-toggle" hidden
				aria-expanded="false" aria-controls="mj-settings-nav">
				<span class="mj-rail-where"></span><span class="mj-tree-caret"></span>
			</button>
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
		<script type="application/json" id="mj-settings-boot">{"tab":"<%= $label %>","soc":"<%= $boot_soc %>","labels":{<%= $labels %>},"exclude":[<%= $boot_exclude %>],"sensors":[<%= $boot_sensors %>],"fonts":[<%= $boot_fonts %>]}</script>

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
<script src="/a/preview-signal.js"></script>
<script src="/a/preview-datachannel.js"></script>
<script src="/a/preview-webrtc.js"></script>
<script src="/a/preview-swap.js"></script>
<script src="/a/preview-wasm.js"></script>
<script src="/a/mj-sources.js"></script>
<script src="/a/preview-multipart.js"></script>
<script src="/a/preview-transport.js"></script>
<script src="/a/preview-chain.js"></script>
<script src="/a/preview-served.js"></script>
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
# the Picture leaf is the first, and it is not meant to be the last.
# Not deferred, because mj-settings.js (which is) calls into it at render time.
%>
<script src="/a/mj-preview.js"></script>
<%
# The luma histogram is computed in the browser off the decoded picture, so it
# needs nothing from the camera and no endpoint of its own.
%>
<script src="/a/mj-luma.js"></script>
<%
# What automatic tone tuning is doing, said in a sentence, and which knobs the
# camera is holding away from the operator's own values. Its own file for the
# reason ircut-check.js is: it renders a confident sentence whichever branch it
# takes, and reaching most of those branches on a real camera needs fog or
# darkness. tests/tone-check.test.js drives every one of them.
%>
<script src="/a/tone-check.js" defer></script>
<%
# The Audio section's soundcheck: the measurement, the verdict table and the
# loop that chooses a level. Its own file because every tier of it fails
# silently, and tests/audio-check.test.js drives all of them without a camera.
# Deferred like the rest — the panel is built by mj-settings.js, which is
# deferred too and runs after it.
%>
<script src="/a/audio-check.js" defer></script>
<script src="/a/ircut-check.js" defer></script>
<script src="/a/rc-check.js" defer></script>
<script src="/a/ircut-map.js" defer></script>
<script src="/a/ircut-pads.js" defer></script>
<script src="/a/ircut-scan.js" defer></script>
<script src="/a/pin-sweep.js" defer></script>
<script src="/a/pin-hunt.js" defer></script>
<%
# The pins page: the chip on the board, drawn from the pad table the camera
# reports at /api/v1/pinmux. Its own file, and pure where it can be, so
# tests/pins.test.js can ask it how a pad count is dealt round the four sides.
%>
<script src="/a/mj-pins.js" defer></script>
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
<%
# Which of a field's three texts goes where, and whether the row needs the "?"
# that opens the rest. Its own file for the reason mj-tree.js is: every answer
# it gives produces a page that looks entirely ordinary when it is wrong -- a
# mark that opens nothing, a hint cut where nothing was hidden, a search that
# quietly stops covering the words it used to -- and only a module can be asked
# by a test. Without it the page keeps the two-tier hints it always drew.
%>
<script src="/a/mj-help.js" defer></script>
<%
# Where the rail's list has to sit and whether a pick has to move the page. Its
# own file for the reason mj-fps.js is: rectangle arithmetic that fails silently
# — a list scrolled to the wrong offset is still a list — and tests/rail.test.js
# is what can ask it without a camera carrying enough sections to overflow a
# window.
%>
<script src="/a/mj-rail.js" defer></script>
<%
# What frame rate the camera reaches at each resolution. Its own file, and pure,
# so tests/fps-caps.test.js can ask it: a control bounded wrongly is still a
# control, and reproducing one needs a camera with more than one sensor mode.
%>
<script src="/a/mj-fps.js"></script>
<%
# What a number field the camera runs by itself says while it is empty, and its
# name in the mode the camera is in (#582). Its own file, and pure, so
# tests/exposure.test.js can ask it: a placeholder quoting the wrong multiplier
# is still a placeholder.
%>
<script src="/a/mj-exposure.js" defer></script>
<script src="/a/mj-region.js" defer></script>
<script src="/a/analytics-overlay.js" defer></script>
<script src="/a/mj-servers.js" defer></script>
<script src="/a/mj-outgoing.js" defer></script>
<%
# Where the overlay sits. Its own file for the same reason the tree is: the
# arithmetic is the subject of issue #340, it fails silently — an overlay placed
# wrongly still renders and still looks like an overlay — and tests/place.test.js
# can only ask it if it is reachable without a picture.
%>
<script src="/a/mj-place.js" defer></script>
<script src="/a/mj-queue.js" defer></script>
<script src="/a/mj-settings.js" defer></script>

<% fi %>

<%in p/footer.cgi %>
