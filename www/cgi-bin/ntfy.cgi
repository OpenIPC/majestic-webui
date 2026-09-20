#!/usr/bin/haserl
<%in p/common.cgi %>
<%
config_file=/etc/webui/ntfy.conf
params="enabled server topic user pass caption clips video video_seconds heif priority proxy"

# Three verbs over one path. ?send=test is the button on this page and sends
# whatever the settings say, because that is what a test is for. ?send=image and
# ?send=clip are for something outside the camera -- a doorbell, a home
# automation rule, a motion sensor of its own -- and each asks for exactly what
# it is named, so a dashboard fetching a thumbnail goes on getting one after the
# settings here have been switched over to video.
#
# The page's own button POSTs, and test answers nothing else. A GET is what a
# browser issues on its own -- a prefetch, a restored tab, a link from anywhere
# -- and it carries the session with it, so a control on a page this repo draws
# must not actuate a camera through one. The same rule the PTZ pad follows.
#
# image and clip still answer a GET, and that is deliberate rather than an
# oversight: they are published on this page for something outside the camera
# to call, a curl without -L follows no redirect, and turning them into POST
# would break every doorbell already wired to them. They accept POST too, which
# is what the button uses.
#
# OK/FAIL rather than true/false: that is what a/notify.js reads, and what the
# page said before it.
send_verb=$GET_send
[ -z "$send_verb" ] && send_verb=$POST_send
if [ "$send_verb" = "test" ] && [ "$REQUEST_METHOD" != "POST" ]; then
	# A whole status line rather than a CGI Status: header -- that is what the
	# camera's web server passes through, and what j/ptz.cgi refuses a GET with.
	echo "HTTP/1.1 405 Method Not Allowed
Content-type: text/plain; charset=UTF-8
Allow: POST
Cache-Control: no-store

Use POST to send a test."
	exit 0
fi
if [ "$send_verb" = "test" ] || [ "$send_verb" = "image" ] ||
	[ "$send_verb" = "clip" ]; then
	echo "Content-type: text/html; charset=UTF-8"
	echo
	send_what=""
	[ "$send_verb" = "image" ] && send_what=--image
	[ "$send_verb" = "clip" ] && send_what=--clip
	# Unquoted on purpose: an empty word must disappear rather than arrive as
	# an empty first argument, which the sender would read as a file path.
	if /usr/bin/ntfy.sh $send_what > /dev/null 2>&1; then
		echo "OK"
	else
		echo "FAIL"
	fi
	exit 0
fi

if [ "$REQUEST_METHOD" = "POST" ]; then
	for p in $params; do
		eval ntfy_${p}=\$POST_ntfy_${p}
	done

	if [ "$ntfy_enabled" = "true" ]; then
		[ -z "$ntfy_server" ] && set_error_flag "Enter the server before switching Ntfy on."
		[ -z "$ntfy_topic" ] && set_error_flag "Enter a topic before switching Ntfy on."
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
			eval "_v=\$ntfy_${p}"
			conf_write "ntfy_${p}" "$_v" >> "$config_file"
		done

		if notify_hooks_sync; then
			redirect_back "success" "Ntfy settings saved."
		fi

		redirect_back "warning" "Ntfy settings saved. $notify_hooks_msg"
	fi

	redirect_to "$SCRIPT_NAME"
fi

[ -e "$config_file" ] && include $config_file

[ -z "$ntfy_server" ] && ntfy_server="https://ntfy.sh"
# The sender's default, said here too: the page used to offer 4 while the
# sender fell back to 3, so a camera nobody had touched sent at a loudness the
# page did not show.
[ -z "$ntfy_priority" ] && ntfy_priority="3"

# The sender's own default and the sender's own clamp. A hand-edited length the
# list does not offer is still honoured; it just cannot be shown as picked.
case "$ntfy_video_seconds" in
"" | *[!0-9]* | ????*) ntfy_video_seconds="10" ;;
esac
[ "$ntfy_video_seconds" -lt 1 ] && ntfy_video_seconds="10"
[ "$ntfy_video_seconds" -gt 60 ] && ntfy_video_seconds="60"

# What the status line says before any script runs.
nf_sender=false
[ -x /usr/bin/ntfy.sh ] && nf_sender=true
nf_addressed=false
[ -n "$ntfy_server" ] && [ -n "$ntfy_topic" ] && nf_addressed=true

if [ "$nf_sender" != "true" ]; then
	nf_head="This firmware cannot send to Ntfy"
	nf_level=" mj-status-bad"
	nf_what="&mdash;"
	nf_when="the part that does the sending is not installed"
elif [ "$ntfy_enabled" != "true" ]; then
	nf_head="Switched off"
	nf_level=" mj-status-off"
	nf_what="&mdash;"
	nf_when="nothing will be sent"
elif [ "$nf_addressed" != "true" ]; then
	nf_head="Not set up yet"
	nf_level=" mj-status-off"
	nf_what="&mdash;"
	nf_when="it needs a topic"
else
	nf_head="Ready"
	nf_level=""
	nf_what="$([ "$ntfy_video" = "true" ] && echo "${ntfy_video_seconds}-second video" || echo "Picture")"
	nf_when="checking what the camera can do&hellip;"
fi

# What the form holds as saved, as JSON literals. Ntfy has no schedule, so the
# two schedule fields are constants the page will always find equal.
nf_on=false;    [ "$ntfy_enabled" = "true" ] && nf_on=true
nf_vid=false;   [ "$ntfy_video" = "true" ] && nf_vid=true
nf_clips=false; [ "$ntfy_clips" = "true" ] && nf_clips=true

nf_who="not addressed yet"
[ "$nf_addressed" = "true" ] && nf_who="to a private topic on $(esc "${ntfy_server#*://}")"
%>

<%in p/header.cgi %>

<script type="application/json" id="mj-notify-boot">{"key":"ntfy","label":"Ntfy","sender":<%= $nf_sender %>,"addressed":<%= $nf_addressed %>,"missing":"it needs a topic","schedulable":false,"saved":{"enabled":<%= $nf_on %>,"video":<%= $nf_vid %>,"seconds":<%= $ntfy_video_seconds %>,"clips":<%= $nf_clips %>,"crontab":false,"interval":0}}</script>

<div class="mj-status<%= $nf_level %>" id="mj-notify-status">
	<span class="mj-status-ico">
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.7"/><path d="M12 11.2v5.2"/><path d="M12 7.7h.01"/></svg>
	</span>
	<span class="mj-status-txt">
		<b class="mj-notify-head"><%= $nf_head %></b>
		<span class="mj-notify-who"><%= $nf_who %></span>
	</span>
	<span class="mj-status-val">
		<b class="mj-notify-what"><%= $nf_what %></b>
		<span class="mj-notify-when"><%= $nf_when %></span>
	</span>
</div>

<span class="mj-say text-secondary" id="mj-notify-unsaved" hidden></span>

<form action="<%= $SCRIPT_NAME %>" method="post">
<div class="row g-4">
	<div class="col-12 col-lg-8">
		<div class="card"><div class="card-body">
			<% card_head "Where it goes" %>
			<p class="small text-secondary">Without these two there is nowhere to send.</p>
			<% field_text "ntfy_server" "Server" "The public one is <code>https://ntfy.sh</code>, or the address of one you run yourself." %>
			<% field_text "ntfy_topic" "Topic" "Make one up that nobody would guess &mdash; the name is the only thing keeping your notifications yours." %>
		</div></div>

		<div class="card mt-4"><div class="card-body">
			<% card_head "What it sends" %>

			<% field_switch "ntfy_enabled" "Send to Ntfy" "eval" %>

			<% group_head "The message" %>
			<p class="boolean mj-row">
				<label for="ntfy_video" class="form-label">Picture or video</label>
				<span class="mj-ctl"><span class="mj-ctl-in">
					<span class="mj-seg" role="group" aria-label="Picture or video">
						<input type="radio" class="mj-seg-in" name="ntfy_video" id="ntfy_video_off" value="false" <% [ "$ntfy_video" != "true" ] && echo checked %>>
						<label class="mj-seg-lbl" for="ntfy_video_off">Picture</label>
						<input type="radio" class="mj-seg-in" name="ntfy_video" id="ntfy_video" value="true" <% [ "$ntfy_video" = "true" ] && echo checked %>>
						<label class="mj-seg-lbl" for="ntfy_video">Video</label>
					</span>
				</span></span>
				<span class="hint text-secondary">The camera records the video as it sends it, so this works with no memory card in the camera.</span>
			</p>

			<p class="select mj-row" id="ntfy_video_seconds_wrap">
				<label for="ntfy_video_seconds" class="form-label">How long</label>
				<span class="mj-ctl"><span class="mj-ctl-in">
					<select class="form-select" id="ntfy_video_seconds" name="ntfy_video_seconds">
						<option value="5" <% [ "$ntfy_video_seconds" = "5" ] && echo selected %>>5 seconds</option>
						<option value="10" <% [ "$ntfy_video_seconds" = "10" ] && echo selected %>>10 seconds</option>
						<option value="15" <% [ "$ntfy_video_seconds" = "15" ] && echo selected %>>15 seconds</option>
						<option value="30" <% [ "$ntfy_video_seconds" = "30" ] && echo selected %>>30 seconds</option>
						<option value="60" <% [ "$ntfy_video_seconds" = "60" ] && echo selected %>>A minute</option>
					</select>
				</span></span>
				<span class="hint text-secondary">Movement is the exception: with a memory card the camera sends the whole recording, which lasts as long as the movement did.</span>
			</p>

			<% field_text "ntfy_caption" "What it says" "Your own wording. <code>%hostname</code> becomes the camera's name, <code>%datetime</code> the time and <code>%soctemp</code> how warm it is." %>

			<p class="select mj-row" id="ntfy_priority_wrap">
				<label for="ntfy_priority" class="form-label">How loudly</label>
				<span class="mj-ctl"><span class="mj-ctl-in">
					<select class="form-select" id="ntfy_priority" name="ntfy_priority">
						<option value="1" <% [ "$ntfy_priority" = "1" ] && echo selected %>>Silent</option>
						<option value="2" <% [ "$ntfy_priority" = "2" ] && echo selected %>>Quiet</option>
						<option value="3" <% [ "$ntfy_priority" = "3" ] && echo selected %>>Normal</option>
						<option value="4" <% [ "$ntfy_priority" = "4" ] && echo selected %>>Loud</option>
						<option value="5" <% [ "$ntfy_priority" = "5" ] && echo selected %>>Urgent</option>
					</select>
				</span></span>
				<span class="hint text-secondary">Urgent breaks through Do Not Disturb. Keep it for things that matter at 3am.</span>
			</p>
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
					<input type="hidden" name="ntfy_clips" value="false">
					<input type="checkbox" class="form-check-input" id="ntfy_clips" name="ntfy_clips" value="true" <% [ "$ntfy_clips" = "true" ] && echo checked %> aria-label="When something moves">
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
				<% card_head "If your server asks who you are" %>
				<% field_text "ntfy_user" "Username" "Only if your server asks for one." %>
				<% field_password "ntfy_pass" "Password" "Only if your server asks for one." %>

				<% group_head "How a picture is attached" %>
				<% field_switch "ntfy_heif" "Use the smaller format" "eval" "About half the size, best with H265. Some phones need an app to open it." %>

				<% group_head "Connection" %>
				<% field_switch "ntfy_proxy" "Send through a proxy" "eval" "Uses the <a href=\"proxy.cgi\">proxy settings</a>. Cameras are built without proxy support unless you ask for it." %>
			</div></div>
		</details>
	</div>

	<div class="col-12 col-lg-4">
		<div class="card"><div class="card-body">
			<% card_head "Try it" %>
			<p class="small text-secondary">Sends one now, with these settings as they were last saved.</p>
			<button type="button" id="mj-notify-test" class="btn btn-sm btn-primary" data-send="test">Send me a test</button>
			<span class="mj-say text-secondary" id="mj-notify-test-say"></span>
		</div></div>

		<div class="card mt-4"><div class="card-body">
			<% card_head "Ask for one" %>
			<dl class="small list mb-0">
				<dt>Picture</dt>
				<dd class="text-break cp2cb"><span class="ep-http">http</span>://root:PASSWORD@<span class="ep-host"><% esc "$network_address" %></span>/cgi-bin/ntfy.cgi?send=image</dd>
				<dt>Video</dt>
				<dd class="text-break cp2cb"><span class="ep-http">http</span>://root:PASSWORD@<span class="ep-host"><% esc "$network_address" %></span>/cgi-bin/ntfy.cgi?send=clip</dd>
			</dl>
			<p class="small text-secondary mt-2">Call either link to send one — the second records <% esc "$ntfy_video_seconds" %> seconds first. Click to copy, then replace <code>PASSWORD</code> with your WebUI password.</p>
		</div></div>

		<div class="card mt-4"><div class="card-body">
			<% card_head "On your phone" %>
			<p class="small text-secondary mb-0">Install <b>ntfy</b> from your app store, add the topic from <b>Where it goes</b>, and every message lands on your phone. There is no account to make.</p>
		</div></div>
	</div>

	<div class="col-12 mj-save"><% button_submit "Save" %></div>
</div>
</form>

<details class="mj-advanced">
	<summary>Raw configuration</summary>
	<div class="mt-3">
		<% [ -e "$config_file" ] && ex "sed -e 's/^ntfy_pass=.*/ntfy_pass=\"(hidden)\"/' $config_file" %>
	</div>
</details>

<script src="/a/notify.js" defer></script>

<%in p/footer.cgi %>
