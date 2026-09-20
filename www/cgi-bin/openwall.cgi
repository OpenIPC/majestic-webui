#!/usr/bin/haserl
<%in p/common.cgi %>
<%
config_file=/etc/webui/openwall.conf
params="enabled crontab caption interval heif proxy"

if [ "$REQUEST_METHOD" = "POST" ]; then
	for p in $params; do
		eval openwall_${p}=\$POST_openwall_${p}
	done

	if [ "$openwall_enabled" = "true" ]; then
		[ "$openwall_interval" -lt "15" ] && set_error_flag "Keep interval at 15 minutes or longer."
	fi

	if [ -z "$error" ]; then
		rm -f "$config_file"
		for p in $params; do
			# conf_write, so that what a shell reads back out of
			# this file is exactly what was posted. It is sourced by the page, by
			# clip_hook_wanted and by the sender, so a value in it has to survive
			# being read as shell: wrapped in double quotes and never escaped, a
			# caption saying `Motion at the "front door"` truncated at the second
			# quote and left `door` to be run as a command, and the `eval echo`
			# that read it globbed on the way in -- a caption of `snap *` was
			# stored as a directory listing (#547).
			#
			# The value is taken with a plain assignment rather than $(t_value ...):
			# an assignment's right-hand side is not word-split, and it does not
			# strip the trailing newlines a command substitution would.
			eval "_v=\$openwall_${p}"
			conf_write "openwall_${p}" "$_v" >> "$config_file"
		done

		sed -i /openwall/d /etc/crontabs/root
		if [ "$openwall_enabled" = "true" ] && [ "$openwall_crontab" = "true" ]; then
			echo "*/${openwall_interval} * * * * /usr/sbin/openwall" >> /etc/crontabs/root
		fi

		redirect_back "success" "OpenWall config updated."
	fi

	redirect_to "$SCRIPT_NAME"
fi

[ -e "$config_file" ] && include $config_file
[ -z "$openwall_crontab" ] && openwall_crontab="true"
[ -z "$openwall_interval" ] && openwall_interval="15"
%>

<%in p/header.cgi %>

<div class="row g-4">
	<div class="col-12 col-lg-6">
		<div class="card"><div class="card-body">
			<% card_head "OpenWall" %>
			<p class="small text-secondary">Share snapshots on the <a href="https://openipc.org/open-wall">Open Wall</a> to help compare image quality across cameras. Also sends your MAC address, chipset, sensor, flash size, firmware version and uptime.</p>
			<form action="<%= $SCRIPT_NAME %>" method="post">
				<% field_switch "openwall_enabled" "Enable OpenWall" "eval" %>
				<% group_head "Submission" %>
				<% field_string "openwall_interval" "Interval" "eval" "15 30 60 120" "Minutes between submissions." %>
				<% field_switch "openwall_crontab" "Add to crontab" "eval" "Send pictures timed by interval." %>
				<% field_text "openwall_caption" "Caption" "Location or short description." %>
				<% group_head "Options" %>
				<% field_switch "openwall_heif" "Use HEIF format" "eval" "Smaller files (best with H265)." %>
				<% field_switch "openwall_proxy" "Use SOCKS5" "eval" "<a href=\"proxy.cgi\">Configure proxy access.</a>" %>
				<% button_submit %>
			</form>
		</div></div>
	</div>
</div>

<details class="mt-4">
	<summary class="text-secondary small">Advanced — raw configuration</summary>
	<div class="mt-3">
		<% [ -e "$config_file" ] && ex "cat $config_file" %>
		<% ex "grep openwall /etc/crontabs/root" %>
	</div>
</details>

<%in p/footer.cgi %>
