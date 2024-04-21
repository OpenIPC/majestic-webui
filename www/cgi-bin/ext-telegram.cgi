#!/usr/bin/haserl
<%in p/common.cgi %>
<%
page_title="Telegram"
config_file=/etc/webui/telegram.conf
params="enabled token channel interval caption crontab document heif proxy"

if [ "$REQUEST_METHOD" = "POST" ]; then
	for p in $params; do
		eval telegram_${p}=\$POST_telegram_${p}
	done

	if [ "$telegram_enabled" = "true" ]; then
		[ -z "$telegram_token" ] && set_error_flag "Telegram token cannot be empty."
		[ -z "$telegram_channel" ] && set_error_flag "Telegram channel cannot be empty."
	fi

	if [ -z "$error" ]; then
		rm -f "$config_file"
		for p in $params; do
			echo "telegram_${p}=\"$(eval echo \$telegram_${p})\"" >> "$config_file"
		done

		sed -i /telegram/d /etc/crontabs/root
		if [ "$telegram_enabled" = "true" ] && [ "$telegram_crontab" = "true" ]; then
			echo "*/${telegram_interval} * * * * /usr/sbin/telegram" >> /etc/crontabs/root
		fi

		redirect_back "success" "Telegram config updated."
	fi

	redirect_to "$SCRIPT_NAME"
fi

[ -e "$config_file" ] && include $config_file
[ -z "$telegram_crontab" ] && telegram_crontab="true"
[ -z "$telegram_interval" ] && telegram_interval="15"
%>

<%in p/header.cgi %>

<form action="<%= $SCRIPT_NAME %>" method="post">
	<% field_switch "telegram_enabled" "Enable Telegram" "eval" %>
	<div class="row row-cols-1 row-cols-md-2 row-cols-lg-3 g-4 mb-4">
		<div class="col">
			<% field_text "telegram_token" "Token" "Telegram bot authentication token." %>
			<% field_text "telegram_channel" "Channel" "Channel to post the images to." %>
			<% field_string "telegram_interval" "Interval" "eval" "15 30 60 120" "Minutes between submissions." %>
			<% field_text "telegram_caption" "Caption" "Location or short description." %>
		</div>

		<div class="col">
			<% field_switch "telegram_crontab" "Add to Crontab" "eval" "Send pictures timed by interval." %>
			<% field_switch "telegram_document" "Send as document" "eval" "Attach picture as general file." %>
			<% field_switch "telegram_heif" "Use HEIF format" "eval" "Requires H265 codec on Video0." %>
			<% field_switch "telegram_proxy" "Use SOCKS5" "eval" "<a href=\"ext-proxy.cgi\">Configure proxy access.</a>" %>
		</div>

		<div class="col">
			<% [ -e "$config_file" ] && ex "cat $config_file" %>
			<% ex "grep telegram /etc/crontabs/root" %>
		</div>
	</div>
	<% button_submit %>
</form>

<script>
<% if [ "$telegram_crontab" = "true" ]; then %>
	$('#telegram_crontab').checked = true;
<% fi %>

<% if [ "$(yaml-cli -g .video0.codec)" != "h265" ]; then %>
	$('#telegram_heif').checked = false;
	$('#telegram_heif').disabled = true;
<% fi %>
</script>

<%in p/footer.cgi %>
