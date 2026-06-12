#!/usr/bin/haserl
<%in p/common.cgi %>

<%
page_title="Majestic Settings"
label="$GET_tab"
[ -z "$label" ] && label="system"

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

<div class="alert alert-danger">
	<h4>Majestic is not running.</h4>
	<p>Go to https://wiki.openipc.org for more information.</p>
</div>

<% else %>

<div class="row g-4 mb-4">
	<div class="col-12 col-md-3 col-lg-2">
		<ul class="nav nav-pills flex-column small sticky-md-top" id="mj-settings-nav"></ul>
	</div>

	<div class="col-12 col-md-9 col-lg-6" id="mj-settings-form-col">
		<script type="application/json" id="mj-settings-boot">{"tab":"<%= $label %>","labels":{<%= $labels %>},"exclude":[<%= $boot_exclude %>],"sensors":[<%= $boot_sensors %>]}</script>

		<h3 id="mj-settings-title"></h3>
		<form id="mj-settings-form" action="javascript:void(0)" autocomplete="off">
			<p class="text-secondary small mb-0">Loading settings…</p>
		</form>
	</div>
</div>

<script src="/a/mj-settings.js" defer></script>

<% fi %>

<%in p/footer.cgi %>
