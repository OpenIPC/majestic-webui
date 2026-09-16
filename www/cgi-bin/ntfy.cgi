#!/usr/bin/haserl
<%in p/common.cgi %>
<%
config_file=/etc/webui/ntfy.conf
# The list of parameters that we will save
params="enabled server topic user pass caption clips video video_seconds heif priority"

# === TEST AND WEBHOOK DISPATCH ===
#
# Three verbs over one path. ?send=test is the button on this page and sends
# whatever the settings say, because that is what a test is for. ?send=image
# and ?send=clip are for something outside the camera -- a doorbell, a home
# automation rule, a motion sensor of its own -- and each asks for exactly
# what it is named, so a dashboard fetching a thumbnail goes on getting one
# after the settings here have been switched over to video.
#
# OK/FAIL rather than true/false: that is what a/ntfy.js already reads.
if [ "$GET_send" = "test" ] || [ "$GET_send" = "image" ] ||
    [ "$GET_send" = "clip" ]; then
    echo "Content-type: text/html; charset=UTF-8"
    echo
    send_what=""
    [ "$GET_send" = "image" ] && send_what=--image
    [ "$GET_send" = "clip" ] && send_what=--clip
    # Unquoted on purpose: an empty word must disappear rather than arrive as
    # an empty first argument, which the sender would read as a file path.
    if /usr/bin/ntfy.sh $send_what > /dev/null 2>&1; then
        echo "OK"
    else
        echo "FAIL"
    fi
    exit 0
fi

# === LOGIC OF SAVING SETTINGS ===
if [ "$REQUEST_METHOD" = "POST" ]; then
    for p in $params; do
        eval ntfy_${p}=\$POST_ntfy_${p}
    done

    # Validation
    if [ "$ntfy_enabled" = "true" ]; then
        [ -z "$ntfy_server" ] && set_error_flag "Server URL cannot be empty."
        [ -z "$ntfy_topic" ] && set_error_flag "Topic cannot be empty."
    fi

    # Writing to a file
    if [ -z "$error" ]; then
        rm -f "$config_file"
        for p in $params; do
            echo "ntfy_${p}=\"$(eval echo \$ntfy_${p})\"" >> "$config_file"
        done
        if notify_hooks_sync; then
            redirect_back "success" "Ntfy config updated."
        fi

        redirect_back "warning" "Ntfy config updated. $notify_hooks_msg"
    fi

    redirect_to "$SCRIPT_NAME"
fi

# === LOADING CURRENT SETTINGS ===
[ -e "$config_file" ] && include $config_file

# Default values
[ -z "$ntfy_server" ] && ntfy_server="https://ntfy.sh"
[ -z "$ntfy_priority" ] && ntfy_priority="4"
# The sender's own default and the sender's own clamp, both said here too.
# The page reads whatever is in the file, which nothing obliges to be one of
# the lengths offered: a hand-edited 600 would select none of them, so the
# list would show 5, the webhook card would promise 600, and the send would
# ask the camera for the 60 it clamps to -- three numbers for one setting.
# These are the SENDER's bounds rather than the offered list's, because what
# the card promises has to be what the send does; a hand-edited length the
# list does not offer is still honoured, it just cannot be shown as picked.
case "$ntfy_video_seconds" in
"" | *[!0-9]* | ????*) ntfy_video_seconds="10" ;;
esac
[ "$ntfy_video_seconds" -lt 1 ] && ntfy_video_seconds="10"
[ "$ntfy_video_seconds" -gt 60 ] && ntfy_video_seconds="60"
%>

<%in p/header.cgi %>

<div class="row g-4">
	<div class="col-12 col-lg-8">
		<div class="card"><div class="card-body">
			<% card_head "Ntfy notifications" %>
			<p class="small text-secondary">Push a picture, or a few seconds of video, to an <a href="https://ntfy.sh">ntfy</a> topic.</p>
			<form action="<%= $SCRIPT_NAME %>" method="post">
				<% field_switch "ntfy_enabled" "Enable Ntfy" "eval" %>
				<% group_head "Connection" %>
				<% field_text "ntfy_server" "Server URL" "e.g. https://ntfy.sh" %>
				<% field_text "ntfy_topic" "Topic" "Unique topic name for notifications." %>
				<% field_text "ntfy_user" "Username" "Leave empty if no auth." %>
				<% field_text "ntfy_pass" "Password" "Leave empty if no auth." %>
				<% group_head "Message" %>
				<% field_text "ntfy_caption" "Caption" "Supports %hostname, %datetime, %soctemp." %>
				<% field_string "ntfy_priority" "Priority" "eval" "1 2 3 4 5" "1 = min, 5 = max (urgent)." %>
				<% field_switch "ntfy_heif" "Use HEIF format" "eval" "Smaller files (best with H265)." %>
				<% group_head "Submission" %>
				<% field_switch "ntfy_clips" "Send motion clips" "eval" "Push something when the camera sees movement. With a memory card it sends the recording once the movement has stopped, as long as the movement lasted and starting a little before it; with no card it records a few seconds as the movement begins." %>
				<% field_switch "ntfy_video" "Send video" "eval" "Record a few seconds and push that, instead of a single picture. Needs no card and no recording." %>
				<% field_string "ntfy_video_seconds" "Video length" "eval" "5 10 15 30 60" "Seconds to record. A push that overlaps another one also gets the seconds before it started; a push on its own begins where it was triggered." %>
				<% button_submit %>
			</form>
		</div></div>
	</div>

	<div class="col-12 col-lg-4">
		<div class="card"><div class="card-body">
			<% card_head "Test" %>
			<p class="small text-secondary">Send a test notification using the saved settings.</p>
			<button type="button" id="ntfy-test" class="btn btn-sm btn-outline-secondary">Send test notification</button>
			<span id="ntfy-status" class="small ms-2"></span>
		</div></div>

		<div class="card mt-4"><div class="card-body">
			<% card_head "Remote send" %>
			<dl class="small list mb-0">
				<dt>Picture</dt>
				<dd class="text-break cp2cb"><span class="ep-http">http</span>://root:PASSWORD@<span class="ep-host"><% esc "$network_address" %></span>/cgi-bin/ntfy.cgi?send=image</dd>
				<dt>Video</dt>
				<dd class="text-break cp2cb"><span class="ep-http">http</span>://root:PASSWORD@<span class="ep-host"><% esc "$network_address" %></span>/cgi-bin/ntfy.cgi?send=clip</dd>
			</dl>
			<p class="small text-secondary mt-2">Call either URL to push a notification — the second records <% esc "$ntfy_video_seconds" %> seconds first. Click to copy, then replace <code>PASSWORD</code> with your WebUI password.</p>
		</div></div>
	</div>
</div>

<details class="mt-4">
	<summary class="text-secondary small">Advanced — raw configuration</summary>
	<div class="mt-3">
		<% [ -e "$config_file" ] && ex "cat $config_file" %>
	</div>
</details>

<script src="/a/ntfy.js"></script>

<%in p/footer.cgi %>
