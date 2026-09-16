#!/usr/bin/haserl
<%in p/common.cgi %>
<%
config_file=/etc/webui/max.conf
params="enabled token chat_id interval caption crontab clips video video_seconds proxy"

# Webhook for a remote send, answering true or false.
#
# sbin/max reports the send through its exit status, so the answer needs no
# JSON parsed on the camera -- which matters here more than it does next door,
# because MAX answers in JSON at every step of a send.
#
# Two verbs, each asking for exactly what it is named: ?send=image goes on
# meaning a picture on a camera whose schedule has been switched over to video,
# which is what a dashboard fetching a thumbnail every minute wants. The switch
# on this page governs the SCHEDULE, where nobody is present to say; the Try it
# button asks for whichever the page is set to send.
#
# The page's own button POSTs. A GET is what a browser issues on its own -- a
# prefetch, a restored tab, a link from anywhere -- and it carries the session
# with it, so a control this repo draws must not actuate a camera through one;
# the PTZ pad follows the same rule. Both verbs still answer a GET because they
# are published on this page for something outside the camera to call, and
# turning them into POST would break every doorbell wired to them.
send_verb=$GET_send
[ -z "$send_verb" ] && send_verb=$POST_send
if [ "$send_verb" = "image" ] || [ "$send_verb" = "clip" ]; then
	echo "Content-type: text/html; charset=UTF-8"
	echo
	send_what=--image
	[ "$send_verb" = "clip" ] && send_what=--clip
	if max "$send_what" >/dev/null 2>&1; then echo true; else echo false; fi
	exit 0
fi

if [ "$REQUEST_METHOD" = "POST" ]; then
	for p in $params; do
		eval max_${p}=\$POST_max_${p}
	done

	if [ "$max_enabled" = "true" ]; then
		[ -z "$max_token" ] && set_error_flag "Enter the bot token before switching MAX on."
		[ -z "$max_chat_id" ] && set_error_flag "Enter the chat before switching MAX on."
	fi

	if [ -z "$error" ]; then
		rm -f "$config_file"
		for p in $params; do
			echo "max_${p}=\"$(eval echo \$max_${p})\"" >> "$config_file"
		done

		# The interval is a WORD in the cron line, not a number dropped into
		# the minute field: `*/60` matches only minute 0, so writing the
		# figure straight in would make every interval above an hour mean the
		# same thing. Built from the word the page offered instead.
		# Anchored on the program, not on the word: a bare /max/ would also
		# match a line running anything else whose path happens to contain
		# those three letters.
		sed -i '\#/usr/sbin/max$#d' /etc/crontabs/root
		if [ "$max_enabled" = "true" ] && [ "$max_crontab" = "true" ]; then
			case "$max_interval" in
			15 | 30) cron_when="*/${max_interval} * * * *" ;;
			60) cron_when="0 * * * *" ;;
			360) cron_when="0 */6 * * *" ;;
			*) cron_when="*/15 * * * *" ;;
			esac
			echo "${cron_when} /usr/sbin/max" >> /etc/crontabs/root
		fi

		if notify_hooks_sync; then
			redirect_back "success" "MAX settings saved."
		fi

		redirect_back "warning" "MAX settings saved. $notify_hooks_msg"
	fi

	redirect_to "$SCRIPT_NAME"
fi

[ -e "$config_file" ] && include $config_file
[ -z "$max_crontab" ] && max_crontab="true"
[ -z "$max_interval" ] && max_interval="15"

# The sender's own default and the sender's own clamp, both said here too.
# The page reads whatever is in the file, which nothing obliges to be one of
# the lengths offered: a hand-edited 600 would select none of them, so the
# list would show 5, the webhook card would promise 600, and the send would
# ask the camera for the 60 it clamps to -- three numbers for one setting.
# These are the SENDER's bounds rather than the offered list's, because what
# the card promises has to be what the send does; a hand-edited length the
# list does not offer is still honoured, it just cannot be shown as picked.
case "$max_video_seconds" in
"" | *[!0-9]* | ????*) max_video_seconds="10" ;;
esac
[ "$max_video_seconds" -lt 1 ] && max_video_seconds="10"
[ "$max_video_seconds" -gt 60 ] && max_video_seconds="60"

# What the status line says before any script runs. A page that renders its
# verdict only from JS says nothing at all on a camera whose browser refused
# the file, and this is the one line on the page that has to be there.
mx_sender=false
[ -x /usr/sbin/max ] && mx_sender=true
mx_addressed=false
[ -n "$max_token" ] && [ -n "$max_chat_id" ] && mx_addressed=true

if [ "$mx_sender" != "true" ]; then
	mx_head="This firmware cannot send to MAX"
	mx_level=" mj-status-bad"
	mx_what="&mdash;"
	mx_when="the part that does the sending is not installed"
elif [ "$max_enabled" != "true" ]; then
	mx_head="Switched off"
	mx_level=" mj-status-off"
	mx_what="&mdash;"
	mx_when="nothing will be sent"
elif [ "$mx_addressed" != "true" ]; then
	mx_head="Not set up yet"
	mx_level=" mj-status-off"
	mx_what="&mdash;"
	mx_when="it needs a bot and a chat"
else
	mx_head="Ready"
	mx_level=""
	mx_what="$([ "$max_video" = "true" ] && echo "${max_video_seconds}-second video" || echo "Picture")"
	mx_when="checking what the camera can do&hellip;"
fi

# What the form holds as saved, as JSON literals, so the page can tell a
# preview of unsaved edits from what the camera is actually set to do.
mx_on=false;    [ "$max_enabled" = "true" ] && mx_on=true
mx_vid=false;   [ "$max_video" = "true" ] && mx_vid=true
mx_clips=false; [ "$max_clips" = "true" ] && mx_clips=true
mx_cron=false;  [ "$max_crontab" = "true" ] && mx_cron=true

mx_who="not addressed yet"
[ "$mx_addressed" = "true" ] && mx_who="to chat $(esc "$max_chat_id")"
%>

<%in p/header.cgi %>

<script type="application/json" id="mj-notify-boot">{"key":"max","label":"MAX","sender":<%= $mx_sender %>,"addressed":<%= $mx_addressed %>,"missing":"it needs a bot and a chat","schedulable":true,"saved":{"enabled":<%= $mx_on %>,"video":<%= $mx_vid %>,"seconds":<%= $max_video_seconds %>,"clips":<%= $mx_clips %>,"crontab":<%= $mx_cron %>,"interval":<%= $max_interval %>}}</script>

<div class="mj-status<%= $mx_level %>" id="mj-notify-status">
	<span class="mj-status-ico">
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.7"/><path d="M12 11.2v5.2"/><path d="M12 7.7h.01"/></svg>
	</span>
	<span class="mj-status-txt">
		<b class="mj-notify-head"><%= $mx_head %></b>
		<span class="mj-notify-who"><%= $mx_who %></span>
	</span>
	<span class="mj-status-val">
		<b class="mj-notify-what"><%= $mx_what %></b>
		<span class="mj-notify-when"><%= $mx_when %></span>
	</span>
</div>

<span class="mj-say text-secondary" id="mj-notify-unsaved" hidden></span>

<form action="<%= $SCRIPT_NAME %>" method="post">
<div class="row g-4">
	<div class="col-12 col-lg-8">
		<div class="card"><div class="card-body">
			<% card_head "What it sends" %>

			<% field_switch "max_enabled" "Send to MAX" "eval" %>

			<% group_head "The message" %>
			<p class="boolean mj-row">
				<label for="max_video" class="form-label">Picture or video</label>
				<span class="mj-ctl"><span class="mj-ctl-in">
					<span class="mj-seg" role="group" aria-label="Picture or video">
						<input type="radio" class="mj-seg-in" name="max_video" id="max_video_off" value="false" <% [ "$max_video" != "true" ] && echo checked %>>
						<label class="mj-seg-lbl" for="max_video_off">Picture</label>
						<input type="radio" class="mj-seg-in" name="max_video" id="max_video" value="true" <% [ "$max_video" = "true" ] && echo checked %>>
						<label class="mj-seg-lbl" for="max_video">Video</label>
					</span>
				</span></span>
				<span class="hint text-secondary">The camera records the video as it sends it, so this works with no memory card in the camera.</span>
			</p>

			<p class="select mj-row" id="max_video_seconds_wrap">
				<label for="max_video_seconds" class="form-label">How long</label>
				<span class="mj-ctl"><span class="mj-ctl-in">
					<select class="form-select" id="max_video_seconds" name="max_video_seconds">
						<option value="5" <% [ "$max_video_seconds" = "5" ] && echo selected %>>5 seconds</option>
						<option value="10" <% [ "$max_video_seconds" = "10" ] && echo selected %>>10 seconds</option>
						<option value="15" <% [ "$max_video_seconds" = "15" ] && echo selected %>>15 seconds</option>
						<option value="30" <% [ "$max_video_seconds" = "30" ] && echo selected %>>30 seconds</option>
						<option value="60" <% [ "$max_video_seconds" = "60" ] && echo selected %>>A minute</option>
					</select>
				</span></span>
				<span class="hint text-secondary">Movement is the exception: with a memory card the camera sends the whole recording, which lasts as long as the movement did.</span>
			</p>

			<% field_text "max_caption" "What it says" "Your own wording. <code>%hostname</code> becomes the camera's name, <code>%datetime</code> the time and <code>%soctemp</code> how warm it is." %>
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
					<input type="hidden" name="max_clips" value="false">
					<input type="checkbox" class="form-check-input" id="max_clips" name="max_clips" value="true" <% [ "$max_clips" = "true" ] && echo checked %> aria-label="When something moves">
				</span>
			</div>

			<div class="mj-trig" id="mj-trig-schedule">
				<span class="mj-trig-t">
					<b>Every so often</b>
					<span>On a timer, whatever is happening in front of the camera.</span>
					<span style="display:flex; align-items:center; gap:.6rem; margin-top:.6rem">
						<select class="form-select form-select-sm" id="max_interval" name="max_interval" style="max-width:11rem" aria-label="How often">
							<option value="15" <% [ "$max_interval" = "15" ] && echo selected %>>Every 15 minutes</option>
							<option value="30" <% [ "$max_interval" = "30" ] && echo selected %>>Every 30 minutes</option>
							<option value="60" <% [ "$max_interval" = "60" ] && echo selected %>>Every hour</option>
							<option value="360" <% [ "$max_interval" = "360" ] && echo selected %>>Every six hours</option>
						</select>
					</span>
				</span>
				<span class="form-check form-switch">
					<input type="hidden" name="max_crontab" value="false">
					<input type="checkbox" class="form-check-input" id="max_crontab" name="max_crontab" value="true" <% [ "$max_crontab" = "true" ] && echo checked %> aria-label="Every so often">
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
				<% field_password "max_token" "Token" "From MAX's own bot-making bot. It is a long string; paste it whole." %>
				<% field_text "max_chat_id" "Chat" "The number of the chat to post in, which is negative for a group. Add the bot to the chat first &mdash; until you do, it can see no chats at all." %>

				<% group_head "Connection" %>
				<% field_switch "max_proxy" "Send through a proxy" "eval" "Uses the <a href=\"proxy.cgi\">proxy settings</a>. Cameras are built without proxy support unless you ask for it." %>
			</div></div>
		</details>
	</div>

	<div class="col-12 col-lg-4">
		<div class="card"><div class="card-body">
			<% card_head "Try it" %>
			<p class="small text-secondary">Sends one now, with these settings as they were last saved.</p>
			<button type="button" id="mj-notify-test" class="btn btn-sm btn-primary" data-send="<% [ "$max_video" = "true" ] && echo clip || echo image %>">Send me a test</button>
			<span class="mj-say text-secondary" id="mj-notify-test-say"></span>
		</div></div>

		<div class="card mt-4"><div class="card-body">
			<% card_head "Ask for one" %>
			<dl class="small list mb-0">
				<dt>Picture</dt>
				<dd class="text-break cp2cb"><span class="ep-http">http</span>://root:PASSWORD@<span class="ep-host"><% esc "$network_address" %></span>/cgi-bin/max.cgi?send=image</dd>
				<dt>Video</dt>
				<dd class="text-break cp2cb"><span class="ep-http">http</span>://root:PASSWORD@<span class="ep-host"><% esc "$network_address" %></span>/cgi-bin/max.cgi?send=clip</dd>
			</dl>
			<p class="small text-secondary mt-2">Call either link to send one — the second records <% esc "$max_video_seconds" %> seconds first. Click to copy, then replace <code>PASSWORD</code> with your WebUI password.</p>
		</div></div>
	</div>

	<div class="col-12 mj-save"><% button_submit "Save" %></div>
</div>
</form>

<details class="mj-advanced">
	<summary>Raw configuration</summary>
	<div class="mt-3">
		<% [ -e "$config_file" ] && ex "sed -e 's/^max_token=.*/max_token=\"(hidden)\"/' $config_file" %>
		<% ex "grep /usr/sbin/max /etc/crontabs/root" %>
	</div>
</details>

<script src="/a/notify.js" defer></script>

<%in p/footer.cgi %>
