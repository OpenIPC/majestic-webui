#!/usr/bin/haserl
<%in p/common.cgi %>
<%
config_file=/etc/webui/telegram.conf
params="enabled token channel thread_id interval caption crontab clips video video_seconds document heif proxy"

# webhook for remote send, returns [t|f]
#
# sbin/telegram reports the send through its exit status, so the answer does not
# mean picking `ok` out of Telegram's JSON reply. It also means the failure path
# answers at all: the old pipeline emitted an EMPTY body whenever telegram bailed
# out before curl ran (unconfigured, no token, no channel), because there was no
# reply for it to read that field from.
#
# Two verbs, and each asks for exactly what it is named -- ?send=image goes on
# meaning a picture on a camera whose schedule has been switched over to video,
# which is what a dashboard fetching a thumbnail every minute wants. The switch
# on this page governs the SCHEDULE, where nobody is present to say. The Try it
# button asks for whichever the page is set to send.
# The page's own button POSTs. A GET is what a browser issues on its own -- a
# prefetch, a restored tab, a link from anywhere -- and it carries the session
# with it, so a control on a page this repo draws must not actuate a camera
# through one; the PTZ pad follows the same rule. Both verbs still answer a GET
# because they are published on this page for something outside the camera to
# call, and turning them into POST would break every doorbell already wired to
# them.
send_verb=$GET_send
[ -z "$send_verb" ] && send_verb=$POST_send
if [ "$send_verb" = "image" ] || [ "$send_verb" = "clip" ]; then
	echo "Content-type: text/html; charset=UTF-8"
	echo
	send_what=--image
	[ "$send_verb" = "clip" ] && send_what=--clip
	if telegram "$send_what" >/dev/null 2>&1; then echo true; else echo false; fi
	exit 0
fi

if [ "$REQUEST_METHOD" = "POST" ]; then
	for p in $params; do
		eval telegram_${p}=\$POST_telegram_${p}
	done

	if [ "$telegram_enabled" = "true" ]; then
		[ -z "$telegram_token" ] && set_error_flag "Enter the bot token before switching Telegram on."
		[ -z "$telegram_channel" ] && set_error_flag "Enter the chat before switching Telegram on."
	fi

	if [ -z "$error" ]; then
		rm -f "$config_file"
		for p in $params; do
			echo "telegram_${p}=\"$(eval echo \$telegram_${p})\"" >> "$config_file"
		done

		# The interval is a WORD in the cron line, not a number to drop into the
		# minute field. `*/60` and `*/120` both match only minute 0, so the old
		# form made 60 and 120 the same hourly schedule and neither of them the
		# hour or two hours it said on the page.
		sed -i /telegram/d /etc/crontabs/root
		if [ "$telegram_enabled" = "true" ] && [ "$telegram_crontab" = "true" ]; then
			case "$telegram_interval" in
			15 | 30) cron_when="*/${telegram_interval} * * * *" ;;
			60) cron_when="0 * * * *" ;;
			360) cron_when="0 */6 * * *" ;;
			*) cron_when="*/15 * * * *" ;;
			esac
			echo "${cron_when} /usr/sbin/telegram" >> /etc/crontabs/root
		fi

		if notify_hooks_sync; then
			redirect_back "success" "Telegram settings saved."
		fi

		redirect_back "warning" "Telegram settings saved. $notify_hooks_msg"
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

# What the status line says before any script runs. A page that renders its
# verdict only from JS says nothing at all on a camera whose browser refused
# the file, and this is the one line on the page that has to be there.
tg_sender=false
[ -x /usr/sbin/telegram ] && tg_sender=true
tg_addressed=false
[ -n "$telegram_token" ] && [ -n "$telegram_channel" ] && tg_addressed=true

if [ "$tg_sender" != "true" ]; then
	tg_head="This firmware cannot send to Telegram"
	tg_level=" mj-status-bad"
	tg_what="&mdash;"
	tg_when="the part that does the sending is not installed"
elif [ "$telegram_enabled" != "true" ]; then
	tg_head="Switched off"
	tg_level=" mj-status-off"
	tg_what="&mdash;"
	tg_when="nothing will be sent"
elif [ "$tg_addressed" != "true" ]; then
	tg_head="Not set up yet"
	tg_level=" mj-status-off"
	tg_what="&mdash;"
	tg_when="it needs a bot and a chat"
else
	tg_head="Ready"
	tg_level=""
	tg_what="$([ "$telegram_video" = "true" ] && echo "${telegram_video_seconds}-second video" || echo "Picture")"
	tg_when="checking what the camera can do&hellip;"
fi

# What the form holds as saved, as JSON literals, so the page can tell a
# preview of unsaved edits from what the camera is actually set to do.
tg_on=false;    [ "$telegram_enabled" = "true" ] && tg_on=true
tg_vid=false;   [ "$telegram_video" = "true" ] && tg_vid=true
tg_clips=false; [ "$telegram_clips" = "true" ] && tg_clips=true
tg_cron=false;  [ "$telegram_crontab" = "true" ] && tg_cron=true

tg_who="not addressed yet"
[ "$tg_addressed" = "true" ] && tg_who="to chat $(esc "$telegram_channel")"
%>

<%in p/header.cgi %>

<script type="application/json" id="mj-notify-boot">{"key":"telegram","label":"Telegram","sender":<%= $tg_sender %>,"addressed":<%= $tg_addressed %>,"missing":"it needs a bot and a chat","schedulable":true,"saved":{"enabled":<%= $tg_on %>,"video":<%= $tg_vid %>,"seconds":<%= $telegram_video_seconds %>,"clips":<%= $tg_clips %>,"crontab":<%= $tg_cron %>,"interval":<%= $telegram_interval %>}}</script>

<div class="mj-status<%= $tg_level %>" id="mj-notify-status">
	<span class="mj-status-ico">
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.7"/><path d="M12 11.2v5.2"/><path d="M12 7.7h.01"/></svg>
	</span>
	<span class="mj-status-txt">
		<b class="mj-notify-head"><%= $tg_head %></b>
		<span class="mj-notify-who"><%= $tg_who %></span>
	</span>
	<span class="mj-status-val">
		<b class="mj-notify-what"><%= $tg_what %></b>
		<span class="mj-notify-when"><%= $tg_when %></span>
	</span>
</div>

<span class="mj-say text-secondary" id="mj-notify-unsaved" hidden></span>

<form action="<%= $SCRIPT_NAME %>" method="post">
<div class="row g-4">
	<div class="col-12 col-lg-8">
		<div class="card"><div class="card-body">
			<% card_head "What it sends" %>

			<% field_switch "telegram_enabled" "Send to Telegram" "eval" %>

			<% group_head "The message" %>
			<p class="boolean mj-row">
				<label for="telegram_video" class="form-label">Picture or video</label>
				<span class="mj-ctl"><span class="mj-ctl-in">
					<span class="mj-seg" role="group" aria-label="Picture or video">
						<input type="radio" class="mj-seg-in" name="telegram_video" id="telegram_video_off" value="false" <% [ "$telegram_video" != "true" ] && echo checked %>>
						<label class="mj-seg-lbl" for="telegram_video_off">Picture</label>
						<input type="radio" class="mj-seg-in" name="telegram_video" id="telegram_video" value="true" <% [ "$telegram_video" = "true" ] && echo checked %>>
						<label class="mj-seg-lbl" for="telegram_video">Video</label>
					</span>
				</span></span>
				<span class="hint text-secondary">The camera records the video as it sends it, so this works with no memory card in the camera.</span>
			</p>

			<p class="select mj-row" id="telegram_video_seconds_wrap">
				<label for="telegram_video_seconds" class="form-label">How long</label>
				<span class="mj-ctl"><span class="mj-ctl-in">
					<select class="form-select" id="telegram_video_seconds" name="telegram_video_seconds">
						<option value="5" <% [ "$telegram_video_seconds" = "5" ] && echo selected %>>5 seconds</option>
						<option value="10" <% [ "$telegram_video_seconds" = "10" ] && echo selected %>>10 seconds</option>
						<option value="15" <% [ "$telegram_video_seconds" = "15" ] && echo selected %>>15 seconds</option>
						<option value="30" <% [ "$telegram_video_seconds" = "30" ] && echo selected %>>30 seconds</option>
						<option value="60" <% [ "$telegram_video_seconds" = "60" ] && echo selected %>>A minute</option>
					</select>
				</span></span>
				<span class="hint text-secondary">Movement is the exception: with a memory card the camera sends the whole recording, which lasts as long as the movement did.</span>
			</p>

			<% field_text "telegram_caption" "What it says" "Your own wording. <code>%hostname</code> becomes the camera's name, <code>%datetime</code> the time and <code>%soctemp</code> how warm it is." %>
		</div></div>

		<div class="card mt-4"><div class="card-body">
			<% card_head "When it sends" %>

			<div class="mj-trig" id="mj-trig-motion">
				<span class="mj-trig-t">
					<b>When something moves</b>
					<span>With a memory card the camera sends the recording once the movement has stopped, starting a little before it began. With no card it records a few seconds as the movement begins.</span>
					<span class="mj-trig-why" id="mj-trig-motion-why" hidden></span>
				</span>
				<span class="form-check form-switch">
					<input type="hidden" name="telegram_clips" value="false">
					<input type="checkbox" class="form-check-input" id="telegram_clips" name="telegram_clips" value="true" <% [ "$telegram_clips" = "true" ] && echo checked %> aria-label="When something moves">
				</span>
			</div>

			<div class="mj-trig" id="mj-trig-schedule">
				<span class="mj-trig-t">
					<b>Every so often</b>
					<span>On a timer, whatever is happening in front of the camera.</span>
					<span style="display:flex; align-items:center; gap:.6rem; margin-top:.6rem">
						<select class="form-select form-select-sm" id="telegram_interval" name="telegram_interval" style="max-width:11rem" aria-label="How often">
							<option value="15" <% [ "$telegram_interval" = "15" ] && echo selected %>>Every 15 minutes</option>
							<option value="30" <% [ "$telegram_interval" = "30" ] && echo selected %>>Every 30 minutes</option>
							<option value="60" <% [ "$telegram_interval" = "60" ] && echo selected %>>Every hour</option>
							<option value="360" <% [ "$telegram_interval" = "360" ] && echo selected %>>Every six hours</option>
						</select>
					</span>
				</span>
				<span class="form-check form-switch">
					<input type="hidden" name="telegram_crontab" value="false">
					<input type="checkbox" class="form-check-input" id="telegram_crontab" name="telegram_crontab" value="true" <% [ "$telegram_crontab" = "true" ] && echo checked %> aria-label="Every so often">
				</span>
			</div>

			<div class="mj-trig">
				<span class="mj-trig-t">
					<b>When something asks for it</b>
					<span>Always available. The two links on the right are for a doorbell, a motion sensor or a home-automation rule to call.</span>
				</span>
			</div>
		</div></div>

		<details class="mj-advanced">
			<summary>Settings you will probably never need</summary>
			<div class="card mt-3"><div class="card-body">
				<% card_head "The bot" %>
				<% field_password "telegram_token" "Token" "From @BotFather in Telegram, after <code>/newbot</code>." %>
				<% field_text "telegram_channel" "Chat" "The chat, channel or group to post in." %>
				<% field_text "telegram_thread_id" "Topic in a forum group" "Leave empty unless the group has topics." %>

				<% group_head "How a picture is attached" %>
				<% field_switch "telegram_document" "Send as a file" "eval" "It arrives exactly as the camera wrote it, rather than as a picture in the chat." %>
				<% field_switch "telegram_heif" "Use the smaller format" "eval" "About half the size, best with H265, and always arrives as a file. Some phones need an app to open it." %>

				<% group_head "Connection" %>
				<% field_switch "telegram_proxy" "Send through a proxy" "eval" "Uses the <a href=\"proxy.cgi\">proxy settings</a>. Cameras are built without proxy support unless you ask for it." %>
			</div></div>
		</details>
	</div>

	<div class="col-12 col-lg-4">
		<div class="card"><div class="card-body">
			<% card_head "Try it" %>
			<p class="small text-secondary">Sends one now, with these settings as they were last saved.</p>
			<button type="button" id="mj-notify-test" class="btn btn-sm btn-primary" data-send="<% [ "$telegram_video" = "true" ] && echo clip || echo image %>">Send me a test</button>
			<span class="mj-say text-secondary" id="mj-notify-test-say"></span>
		</div></div>

		<div class="card mt-4"><div class="card-body">
			<% card_head "Ask for one" %>
			<dl class="small list mb-0">
				<dt>Picture</dt>
				<dd class="text-break cp2cb"><span class="ep-http">http</span>://root:PASSWORD@<span class="ep-host"><% esc "$network_address" %></span>/cgi-bin/telegram.cgi?send=image</dd>
				<dt>Video</dt>
				<dd class="text-break cp2cb"><span class="ep-http">http</span>://root:PASSWORD@<span class="ep-host"><% esc "$network_address" %></span>/cgi-bin/telegram.cgi?send=clip</dd>
			</dl>
			<p class="small text-secondary mt-2">Call either link to send one — the second records <% esc "$telegram_video_seconds" %> seconds first. Click to copy, then replace <code>PASSWORD</code> with your WebUI password.</p>
		</div></div>
	</div>

	<div class="col-12 mj-save"><% button_submit "Save" %></div>
</div>
</form>

<details class="mj-advanced">
	<summary>Raw configuration</summary>
	<div class="mt-3">
		<% [ -e "$config_file" ] && ex "sed -e 's/^telegram_token=.*/telegram_token=\"(hidden)\"/' $config_file" %>
		<% ex "grep telegram /etc/crontabs/root" %>
	</div>
</details>

<script src="/a/notify.js" defer></script>

<%in p/footer.cgi %>
