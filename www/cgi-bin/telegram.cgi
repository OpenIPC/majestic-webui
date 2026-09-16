#!/usr/bin/haserl
<%in p/common.cgi %>
<%
config_file=/etc/webui/telegram.conf
params="enabled token channel thread_id interval caption crontab clips video video_seconds document heif proxy"

# webhook for remote send, returns [t|f]
#
# sbin/telegram now reports the send through its exit status, so the answer no
# longer means parsing Telegram's JSON reply with jsonfilter. It also means the
# failure path finally answers: the old pipeline emitted an EMPTY body whenever
# telegram bailed out before curl ran (unconfigured, no token, no channel),
# because there was no JSON for jsonfilter to find an `ok` in.
#
# Two verbs, and each asks for exactly what it is named -- ?send=image goes on
# meaning a picture on a camera whose schedule has been switched over to video,
# which is what a dashboard fetching a thumbnail every minute wants. The switch
# on this page governs the SCHEDULE, where nobody is present to say.
if [ "$GET_send" = "image" ] || [ "$GET_send" = "clip" ]; then
	echo "Content-type: text/html; charset=UTF-8"
	echo
	send_what=--image
	[ "$GET_send" = "clip" ] && send_what=--clip
	if telegram "$send_what" >/dev/null 2>&1; then echo true; else echo false; fi
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

		if notify_hooks_sync; then
			redirect_back "success" "Telegram config updated."
		fi

		redirect_back "warning" "Telegram config updated. $notify_hooks_msg"
	fi

	redirect_to "$SCRIPT_NAME"
fi

[ -e "$config_file" ] && include $config_file
[ -z "$telegram_crontab" ] && telegram_crontab="true"
[ -z "$telegram_interval" ] && telegram_interval="15"
# The sender's own default and the sender's own clamp, both said here too.
# The page reads whatever is in the file, which nothing obliges to be one of
# the lengths offered: a hand-edited 600 would select none of them, so the
# list would show 5, the webhook card would promise 600, and the send would
# ask the camera for the 60 it clamps to -- three numbers for one setting.
# These are the SENDER's bounds rather than the offered list's, because what
# the card promises has to be what the send does; a hand-edited length the
# list does not offer is still honoured, it just cannot be shown as picked.
case "$telegram_video_seconds" in
"" | *[!0-9]* | ????*) telegram_video_seconds="10" ;;
esac
[ "$telegram_video_seconds" -lt 1 ] && telegram_video_seconds="10"
[ "$telegram_video_seconds" -gt 60 ] && telegram_video_seconds="60"
%>

<%in p/header.cgi %>

<div class="row g-4">
	<div class="col-12 col-lg-8">
		<div class="card"><div class="card-body">
			<% card_head "Telegram" "$([ "$telegram_enabled" = "true" ] && echo on || echo off)" %>
			<p class="small text-secondary">Post a picture, or a few seconds of video, to a Telegram channel — on a schedule or via the webhook.</p>
			<form action="<%= $SCRIPT_NAME %>" method="post">
				<% field_switch "telegram_enabled" "Enable Telegram" "eval" %>
				<% group_head "Bot" %>
				<% field_text "telegram_token" "Token" "Telegram bot authentication token." %>
				<% field_text "telegram_channel" "Channel" "Channel to post the images to." %>
				<% field_text "telegram_thread_id" "Message thread id" "Topic to post to (forum supergroups only)." %>
				<% group_head "Submission" %>
				<% field_switch "telegram_clips" "Send motion clips" "eval" "Post something when the camera sees movement. With a memory card it sends the recording once the movement has stopped, as long as the movement lasted and starting a little before it; with no card it records a few seconds as the movement begins." %>
				<% field_switch "telegram_video" "Send video on a schedule" "eval" "Record a few seconds and post that, instead of a single picture. Needs no card and no recording." %>
				<% field_string "telegram_video_seconds" "Video length" "eval" "5 10 15 30 60" "Seconds to record. A send that overlaps another one also gets the seconds before it started; a send on its own begins where it was triggered." %>
				<% field_string "telegram_interval" "Interval" "eval" "15 30 60 120" "Minutes between submissions." %>
				<% field_switch "telegram_crontab" "Add to crontab" "eval" "Send pictures timed by interval." %>
				<% field_text "telegram_caption" "Caption" "Location or short description." %>
				<% group_head "Options" %>
				<% field_switch "telegram_document" "Send as document" "eval" "Attach picture as general file." %>
				<% field_switch "telegram_heif" "Use HEIF format" "eval" "Smaller files (best with H265); sent as a document." %>
				<% field_switch "telegram_proxy" "Use SOCKS5" "eval" "<a href=\"proxy.cgi\">Configure proxy access.</a>" %>
				<% button_submit %>
			</form>
		</div></div>
	</div>

	<div class="col-12 col-lg-4">
		<div class="card"><div class="card-body">
			<% card_head "Remote send" %>
			<dl class="small list mb-0">
				<dt>Picture</dt>
				<dd class="text-break cp2cb"><span class="ep-http">http</span>://root:PASSWORD@<span class="ep-host"><% esc "$network_address" %></span>/cgi-bin/telegram.cgi?send=image</dd>
				<dt>Video</dt>
				<dd class="text-break cp2cb"><span class="ep-http">http</span>://root:PASSWORD@<span class="ep-host"><% esc "$network_address" %></span>/cgi-bin/telegram.cgi?send=clip</dd>
			</dl>
			<p class="small text-secondary mt-2">Call either URL to trigger a send — the second records <% esc "$telegram_video_seconds" %> seconds first. Click to copy, then replace <code>PASSWORD</code> with your WebUI password.</p>
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

<%in p/footer.cgi %>
