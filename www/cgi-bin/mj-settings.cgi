#!/usr/bin/haserl
<%in p/common.cgi %>

<%
page_title="Majestic Settings"
label="$GET_tab"
[ -z "$label" ] && label="system"

include j/locale.cgi

section=""
if [ -f "$(get_schema)" ]; then
	eval $(jsonfilter -e "section=@.properties" < $(get_schema) 2>/dev/null)
fi

title=""
for key in $section; do
	loc=$(eval echo \$mj_${key})
	if [ -n "$loc" ] && [ "$label" = "$key" ]; then
		title="$loc"
		break
	fi
done

mj_json_escape() {
	sed 's/\\/\\\\/g; s/"/\\"/g'
}

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

<div class="alert alert-danger">
	<h4>Majestic is not running.</h4>
	<p>Go to https://wiki.openipc.org for more information.</p>
</div>

<% else %>

<ul class="nav nav-underline small mb-4 d-lg-flex">
	<%
	for key in $section; do
		loc=$(eval echo \$mj_${key})
		[ -z "$loc" ] && continue
		c="class=\"nav-link\""
		[ "$label" = "$key" ] && c="class=\"nav-link active\" aria-current=\"true\""
		echo "<li class=\"nav-item\"><a ${c} href=\"mj-settings.cgi?tab=${key}\">${loc}</a></li>"
	done
	%>
</ul>

<% if [ -n "$title" ]; then %>

<script type="application/json" id="mj-settings-boot">{"tab":"<%= $label %>","exclude":[<%= $boot_exclude %>],"sensors":[<%= $boot_sensors %>]}</script>

<div class="row row-cols-1 row-cols-md-2 row-cols-lg-3 g-4 mb-4">
	<div class="col" id="mj-settings-form-col">
		<h3><%= $title %></h3>
		<div class="d-grid gap-2">
			<form id="mj-settings-form" action="javascript:void(0)" autocomplete="off">
				<p class="text-secondary small mb-0">Loading settings…</p>
			</form>

			<form action="/cgi-bin/j/mj-restart.cgi" method="post">
				<div class="mt-2"><input type="submit" class="btn btn-secondary" value="Restart Majestic"></div>
			</form>
		</div>
	</div>

	<div class="col" id="mj-settings-related-col">
		<h3>Related Settings</h3>
		<pre class="small mb-0">—</pre>
	</div>

	<div class="col">
		<h3>Quick Links</h3>
		<p><a href="mj-configuration.cgi">Majestic Configuration</a></p>
		<p><a href="mj-endpoints.cgi">Majestic Endpoints</a></p>
	</div>
</div>

<% if [ "$label" = "motionDetect" ]; then %>
	<%in p/roi.cgi %>
<% fi %>

<script src="/a/mj-settings.js" defer></script>

<% else %>

<div class="alert alert-danger">
	<h4>Setting is not available.</h4>
	<p><a href="mj-settings.cgi">Majestic Settings</a></p>
</div>

<% fi %>
<% fi %>

<%in p/footer.cgi %>
