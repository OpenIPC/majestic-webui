#!/usr/bin/haserl
<%in p/common.cgi %>
<%
page_title="Telegram"
config_file=/etc/webui/telegram.conf
params="enabled token channel thread_id interval caption crontab document heif proxy"

# webhook for remote send, returns [t|f]
if [ "$GET_send" = "image" ]; then
	echo "Content-type: text/html; charset=UTF-8"
	echo
	telegram | grep -v curl | jsonfilter -e '@.ok'
	exit 0
fi

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

<div class="row g-4">
	<div class="col-12 col-lg-8">
		<div class="card h-100"><div class="card-body">
			<h3>Telegram</h3>
			<p class="small text-secondary">Post snapshots to a Telegram channel, on a schedule or via the webhook.</p>
			<form action="<%= $SCRIPT_NAME %>" method="post">
				<% field_switch "telegram_enabled" "Enable Telegram" "eval" %>
				<div class="text-uppercase x-small text-secondary mt-3 mb-2">Bot</div>
				<% field_text "telegram_token" "Token" "Telegram bot authentication token." %>
				<% field_text "telegram_channel" "Channel" "Channel to post the images to." %>
				<% field_text "telegram_thread_id" "Message thread id" "Topic to post to (forum supergroups only)." %>
				<div class="text-uppercase x-small text-secondary mt-3 mb-2">Submission</div>
				<% field_string "telegram_interval" "Interval" "eval" "15 30 60 120" "Minutes between submissions." %>
				<% field_switch "telegram_crontab" "Add to crontab" "eval" "Send pictures timed by interval." %>
				<% field_text "telegram_caption" "Caption" "Location or short description." %>
				<div class="text-uppercase x-small text-secondary mt-3 mb-2">Options</div>
				<% field_switch "telegram_document" "Send as document" "eval" "Attach picture as general file." %>
				<% field_switch "telegram_heif" "Use HEIF format" "eval" "Requires H265 codec on Video0." %>
				<% field_switch "telegram_proxy" "Use SOCKS5" "eval" "<a href=\"ext-proxy.cgi\">Configure proxy access.</a>" %>
				<% button_submit %>
			</form>
		</div></div>
	</div>

	<div class="col-12 col-lg-4">
		<div class="card h-100"><div class="card-body">
			<h3>Remote send</h3>
			<dl class="small list mb-0">
				<dt>Webhook</dt>
				<dd class="text-break cp2cb">http://root:12345@<%= $network_address %>/cgi-bin/ext-telegram.cgi?send=image</dd>
			</dl>
			<p class="small text-secondary mt-2">Call this URL to trigger an image send. Click to copy.</p>
		</div></div>
	</div>
</div>

<details class="mt-4">
	<summary class="text-secondary small">Advanced — raw configuration</summary>
	<div class="mt-3">
		<% [ -e "$config_file" ] && ex "cat $config_file" %>
		<% ex "grep telegram /etc/crontabs/root" %>
	</div>
</details>

<script>mjHeifGate('#telegram_heif');</script>

<%in p/footer.cgi %>
