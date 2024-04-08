#!/usr/bin/haserl
<%in p/common.cgi %>
<%
page_title="OpenWall"
config_file=/etc/webui/openwall.conf
params="enabled crontab caption interval heif proxy"

if [ "POST" = "$REQUEST_METHOD" ]; then
	for p in $params; do
		eval openwall_${p}=\$POST_openwall_${p}
	done

	if [ "$openwall_enabled" = "true" ]; then
		[ "$openwall_interval" -lt "15" ] && set_error_flag "Keep interval at 15 minutes or longer."
	fi

	if [ -z "$error" ]; then
		rm -f "$config_file"
		for p in $params; do
			echo "openwall_${p}=\"$(eval echo \$openwall_${p})\"" >> "$config_file"
		done

		sed -i /openwall/d /etc/crontabs/root
		if [ "$openwall_enabled" = "true" ] && [ "$openwall_crontab" = "true" ]; then
			echo "*/${openwall_interval} * * * * /usr/sbin/openwall" >> /etc/crontabs/root
		fi

		redirect_back "success" "OpenWall config updated."
	fi

	redirect_to $SCRIPT_NAME
fi

[ -e "$config_file" ] && include $config_file
[ -z "$openwall_crontab" ] && openwall_crontab="true"
[ -z "$openwall_interval" ] && openwall_interval="15"
%>

<%in p/header.cgi %>

<div class="alert alert-info">
<p>This extension allows you to share images from your OpenIPC camera on the <a href="https://openipc.org/open-wall">Open Wall</a>
	page of our website. The images you share will allow us to determine the quality of images from different cameras.
	We also collect your MAC address, chipset, sensor, flashsize, firmware version, and uptime.</p>
</div>

<form action="<%= $SCRIPT_NAME %>" method="post">
	<% field_switch "openwall_enabled" "Enable OpenWall" %>
	<div class="row row-cols-1 row-cols-md-2 row-cols-lg-3 g-4 mb-4">
		<div class="col">
			<% field_select "openwall_interval" "Interval" "15,30,60,120" "Minutes between submissions." %>
			<% field_text "openwall_caption" "Caption" "Location or short description." %>
		</div>

		<div class="col">
			<% field_switch "openwall_crontab" "Add to Crontab" "Send pictures timed by interval." %>
			<% field_switch "openwall_heif" "Use HEIF format" "Requires H265 codec on Video0." %>
			<% field_switch "openwall_proxy" "Use SOCKS5" "<a href=\"ext-proxy.cgi\">Configure proxy access.</a>" %>
		</div>

		<div class="col">
			<% [ -e "$config_file" ] && ex "cat $config_file" %>
			<% ex "grep openwall /etc/crontabs/root" %>
		</div>
	</div>
	<% button_submit %>
</form>

<script>
<% if [ "$openwall_crontab" = "true" ]; then %>
	$('#openwall_crontab').checked = true;
<% fi %>

<% if [ "$(yaml-cli -g .video0.codec)" != "h265" ]; then %>
	$('#openwall_heif').checked = false;
	$('#openwall_heif').disabled = true;
<% fi %>
</script>

<%in p/footer.cgi %>
