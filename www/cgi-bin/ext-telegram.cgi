#!/usr/bin/haserl
<%in p/common.cgi %>
<%
page_title="Telegram"
config_file=/etc/webui/telegram.conf
params="enabled token channel interval caption document heif proxy"

if [ "POST" = "$REQUEST_METHOD" ]; then
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
		if [ "$telegram_enabled" = "true" ]; then
			echo "*/${telegram_interval} * * * * /usr/sbin/telegram" >> /etc/crontabs/root
		fi

		redirect_back "success" "Telegram config updated."
	fi

	redirect_to $SCRIPT_NAME
fi

[ -e "$config_file" ] && include $config_file
[ -z "$telegram_interval" ] && telegram_interval="15"
%>

<%in p/header.cgi %>

<form action="<%= $SCRIPT_NAME %>" method="post">
	<% field_switch "telegram_enabled" "Enable sending to Telegram" %>
	<div class="row row-cols-1 row-cols-md-2 row-cols-lg-3 g-4 mb-4">
		<div class="col">
			<% field_text "telegram_token" "Token" "Telegram bot authentication token." %>
			<% field_text "telegram_channel" "Channel" "Channel to post the images to." %>
			<% field_select "telegram_interval" "Interval" "15,30,60" "Minutes between submissions." %>
			<% field_text "telegram_caption" "Caption" "Location or short description." %>
		</div>

		<div class="col">
			<% field_switch "telegram_document" "Send as document." %>
			<% field_switch "telegram_heif" "Use HEIF format" "Requires H265 codec on Video0." %>
			<% field_switch "telegram_proxy" "Use SOCKS5" "<a href=\"ext-proxy.cgi\">Configure proxy access.</a>" %>
		</div>

		<div class="col">
			<% [ -e "$config_file" ] && ex "cat $config_file" %>
			<% ex "grep telegram /etc/crontabs/root" %>
		</div>
	</div>
	<% button_submit %>
</form>

<script>
<% if [ "$(yaml-cli -g .video0.codec)" != "h265" ]; then %>
	$('#telegram_heif').checked = false;
	$('#telegram_heif').disabled = true;
<% fi %>
</script>

<%in p/footer.cgi %>
