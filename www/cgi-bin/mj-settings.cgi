#!/usr/bin/haserl
<%in p/common.cgi %>

<%
page_title="Majestic Settings"
label="$GET_tab"
[ -z "$label" ] && label="system"

json_conf=$(wget -q -T1 localhost/api/v1/config.json -O -)
json_schema=$(cat $(get_schema) | jsonfilter -e "@.properties.$label")
json_load "$json_schema"

if [ "$REQUEST_METHOD" = "POST" ]; then
	case "$POST_action" in
		restart)
			killall -1 majestic
			;;

		update)
			OIFS=$IFS
			IFS=$'\n'
			for yaml_param in $(printenv | grep POST__ | sort); do
				param=$(echo ${yaml_param#POST_} | cut -d= -f1)
				newval=$(echo ${yaml_param#POST_} | cut -d= -f2)
				setting=${param//_/.}
				oldval=$(yaml-cli -g "$setting")

				if [ -z "$newval" ] && [ -n "$oldval" ]; then
					yaml-cli -d "$setting"
				elif [ "$newval" != "$oldval" ]; then
					yaml-cli -s "$setting" "$newval"
				fi
			done
			IFS=$OIFS
			;;
	esac

	redirect_to "$HTTP_REFERER"
fi
%>

<%in p/header.cgi %>

<% if [ -z "$(pidof majestic)" ]; then %>

<div class="alert alert-danger">
	<h4>Majestic is not running.</h4>
	<p>Go to https://wiki.openipc.org for more information.</p>
</div>

<% else %>

<ul class="nav nav-underline small mb-4 d-lg-flex">
	<%
	include j/locale.cgi
	eval $(cat $(get_schema) | jsonfilter -e "section=@.properties")
	for key in $section; do
		locale=$(eval echo \$mj_${key})
		c="class=\"nav-link\""
		[ "$label" = "$key" ] && title="$locale" && c="class=\"nav-link active\" aria-current=\"true\""
		echo "<li class=\"nav-item\"><a ${c} href=\"mj-settings.cgi?tab=${key}\">${locale}</a></li>"
	done
	%>
</ul>

<% if json_is_a "properties" "object"; then %>

<div class="row row-cols-1 row-cols-md-2 row-cols-lg-3 g-4 mb-4">
	<div class="col">
		<h3><%= $title %></h3>
		<div class="d-grid gap-2">
			<form action="<%= $SCRIPT_NAME %>" method="post">
				<%
				json_select "properties"
				json_get_keys "keys"
				for key in $keys; do
					json_select "$key"
					json_get_var "desc" "description"
					json_get_var "type" "type"
					json_get_values "enum" "enum"
					json_get_var "min" "minimum"
					json_get_var "max" "maximum"
					json_select ..

					param="_${label}_${key}"
					setting=${param//_/.}
					value=$(yaml-cli -g "$setting")
					default=${value:-$(echo "$json_conf" | jsonfilter -e "@$setting")}
					config="${config}\n$(echo $setting: $value)"

					case "$type" in
						boolean)
							field_switch "$param" "$desc" "$default"
							;;

						integer)
							if [ -n "$max" ] && [ "$max" -le "100" ]; then
								field_range "$param" "$desc" "$default" "$min" "$max"
							else
								field_integer "$param" "$desc" "$default" "$min" "$max"
							fi
							;;

						string)
							field_string "$param" "$desc" "$default" "$enum"
							;;
					esac
				done
				%>
				<input type="hidden" name="action" value="update">
				<% button_submit %>
			</form>

			<form action="<%= $SCRIPT_NAME %>" method="post">
				<input type="hidden" name="action" value="restart">
				<% button_submit "Restart Majestic" "secondary" %>
			</form>
		</div>
	</div>

	<div class="col">
		<h3>Related Settings</h3>
		<pre><% echo -e "$config" %></pre>
	</div>

	<div class="col">
		<h3>Quick Links</h3>
		<p><a href="mj-configuration.cgi">Majestic Configuration</a></p>
		<p><a href="mj-endpoints.cgi">Majestic Endpoints</a></p>
	</div>
</div>

<% else %>

<div class="alert alert-danger">
	<h4>Setting is not available.</h4>
	<p><a href="mj-settings.cgi">Majestic Settings</a></p>
</div>

<% fi %>
<% fi %>

<script>
	<% if [ -e /etc/sensors ]; then %>
		if ($("#_isp_sensorConfig")) {
			const inp = $("#_isp_sensorConfig");
			const sel = document.createElement("select");
			sel.classList.add("form-select");
			sel.name=inp.name;
			sel.id=inp.id;
			sel.options.add(new Option());
			let opt;
			<% for i in $(find /etc/sensors -type f); do %>
				opt = new Option("<%= $i %>");
				opt.selected = ("<%= $i %>" == inp.value);
				sel.options.add(opt);
			<% done %>
			inp.replaceWith(sel);
		}
	<% fi %>
</script>

<%in p/footer.cgi %>
