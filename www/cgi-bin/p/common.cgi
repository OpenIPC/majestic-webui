#!/usr/bin/haserl
<%
IFS_ORIG=$IFS

# tag "text" "classes" "extras"
div() {
	tag "div" "$1" "$2" "$3"
}

# tag "tag" "text" "css" "extras"
tag() {
	local t="$1"
	local n="$2"
	local c="$3"
	[ -n "$c" ] && c=" class=\"${c}\""
	local x="$4"
	[ -n "$x" ] && x=" ${x}"
	echo "<${t}${c}${x}>${n}</${t}>"
}

# A "tag" "classes" "extras"
A() {
	local c="$2"
	[ -n "$c" ] && c=" class=\"${c}\""
	local x="$3"
	[ -n "$x" ] && x=" ${x}"
	echo "<${1}${c}${x}>"
}

Z() {
	echo "</${1}>"
}

d() {
	echo "$1" >&2
}

e() {
	echo -e -n "$1"
}

h1() {
	tag "h1" "$1" "$2" "$3"
}

h2() {
	tag "h2" "$1" "$2" "$3"
}

h3() {
	tag "h3" "$1" "$2" "$3"
}

h4() {
	tag "h4" "$1" "$2" "$3"
}

h5() {
	tag "h5" "$1" "$2" "$3"
}

h6() {
	tag "h6" "$1" "$2" "$3"
}

label() {
	tag "label" "$1" "$2" "$3"
}

li() {
	tag "li" "$1" "$2" "$3"
}

p() {
	tag "p" "$1" "$2" "$3"
}

span() {
	tag "span" "$1" "$2" "$3"
}

div_() {
	A "div" "$1" "$2"
}

_div() {
	Z "div"
}

row_() {
	echo "<div class\"row ${1}\" ${2}>"
}

_row() {
	echo "</div>"
}

row() {
	row_ "$2"
	echo "$1"
	_row
}

span_() {
	A "span" "$1" "$2"
}

_span() {
	Z "span"
}

# alert "text" "type" "extras"
alert() {
	echo "<div class=\"alert alert-${2}\" ${3}>${1}</div>"
}

# button_submit "text" "type" "extras"
button_submit() {
	local t="$1"
	[ -z "$t" ] && t="Save Changes"
	local c="$2"
	[ -z "$c" ] && c="primary"
	local x="$3"
	[ -z "$x" ] && x=" ${x}"
	echo "<div class=\"mt-2\"><input type=\"submit\" class=\"btn btn-${c}\"${x} value=\"${t}\"></div>"
}

# Is root still on the password the firmware ships with?
#
# The stored hash is salted, so comparing it against a fixed string cannot
# work — two hashes of "12345" differ by their salt. Re-hash the default with
# the salt actually in use and compare that against the live hash.
#
# Stays quiet whenever the answer cannot be established (locked account, a
# crypt scheme mkpasswd cannot reproduce, mkpasswd missing). A false positive
# here redirects every page to the interface settings and locks the operator
# out of their own camera, and this is advice rather than an access control.
uses_default_password() {
	local user hash rest method salt found=

	# Read the entry in the shell rather than through sed and cut. This runs on
	# every page, and dropping those two forks takes the check from 20ms to 5ms
	# on a hi3516av300 — the same cost as the weaker test it replaced. It also
	# separates "no root line, or /etc/shadow unreadable" from "root has an
	# empty password", which one empty string cannot express.
	# stderr is redirected before the input, not after: the shell reports a
	# failed `<` while setting it up, so the order decides whether an
	# unreadable /etc/shadow stays silent.
	while IFS=: read -r user hash rest; do
		[ "$user" = "root" ] && { found=1; break; }
	done 2>/dev/null < /etc/shadow
	[ -n "$found" ] || return 1

	case "$hash" in
		"") return 0;;		# root really has no password: worse than default
		'$1$'*) method=md5;;
		'$5$'*) method=sha256;;
		'$6$'*) method=sha512;;
		*) return 1;;		# locked (! or *), or a scheme we cannot rebuild
	esac

	salt=${hash#\$}; salt=${salt#*\$}; salt=${salt%%\$*}
	case "$salt" in
		""|rounds=*) return 1;;	# mkpasswd has no way to set a round count
	esac

	[ "$(mkpasswd -m "$method" -S "$salt" 12345 2>/dev/null)" = "$hash" ]
}

check_password() {
	local p="/cgi-bin/fw-interface.cgi"
	[ -z "$SCRIPT_NAME" ] || [ "$SCRIPT_NAME" = "${p}" ] && return
	if uses_default_password; then
		redirect_to "${p}" "danger" "You must set your own secure password!"
	fi
}

ex() {
	echo "<div class=\"${2:-ex}\"><h6># ${1}</h6><pre class=\"small\">"
	eval "$1" | sed "s/&/\&amp;/g;s/</\&lt;/g;s/>/\&gt;/g;s/\"/\&quot;/g"
	echo "</pre></div>"
}

# field_hidden "name" "value"
field_hidden() {
	local n="$1"
	local v="$2"
	echo "<input type=\"hidden\" name=\"${n}\" id=\"${n}\" value=\"${v}\" class=\"form-hidden\">"
}

# field_integer "name" "label" "value" "min" "max" "hint"
field_integer() {
	local n="$1"
	local l="$2"
	local v="$3"
	local x="$4"
	local y="$5"
	local h="$6"
	echo "<p class=\"number\">" \
		"<label class=\"form-label\" for=\"${n}\">${l}</label>" \
		"<span class=\"input-group\">"
	echo "<input type=\"number\" id=\"${n}\" name=\"${n}\" class=\"form-control text-end\" value=\"${v}\" min=\"${x}\" max=\"${y}\" step=\"1\">" \
		"</span>"
	[ -n "$h" ] && echo "<span class=\"hint text-secondary\">${h}</span>"
	echo "</p>"
}

# field_password "name" "label" "hint"
field_password() {
	local n="$1"
	local l="$2"
	local h="$3"
	local v=$(t_value "$n")
	echo "<p class=\"password\" id=\"${n}_wrap\">" \
		"<label for=\"${n}\" class=\"form-label\">${l}</label><span class=\"input-group\">" \
		"<input type=\"password\" id=\"${n}\" name=\"${n}\" class=\"form-control\" value=\"${v}\">" \
		"<label class=\"input-group-text\">" \
		"<input type=\"checkbox\" class=\"form-check-input me-1\" data-for=\"${n}\"> show" \
		"</label></span>"
	[ -n "$h" ] && echo "<span class=\"hint text-secondary\">${h}</span>"
	echo "</p>"
}

# field_range "name" "label" "value" "min" "max" "hint"
field_range() {
	local n="$1"
	local l="$2"
	local v="$3"
	local x="$4"
	local y="$5"
	local h="$6"
	echo "<p class=\"range\" id=\"${n}_wrap\">" \
		"<label for=\"${n}\" class=\"form-label\">${l}</label>" \
		"<span class=\"input-group\">"
	echo "<input type=\"hidden\" id=\"${n}\" name=\"${n}\" value=\"${v}\">"
	echo "<input type=\"range\" class=\"form-control form-range\" id=\"${n}-range\" value=\"${v}\" min=\"${x}\" max=\"${y}\" step=\"1\">"
	echo "<span class=\"input-group-text show-value\" id=\"${n}-show\">${v}</span></span>"
	[ -n "$h" ] && echo "<span class=\"hint text-secondary\">${h}</span>"
	echo "</p>"
}

# Escape a string for use inside a double-quoted HTML attribute.
#
# Numeric character references are restored on the way out, deliberately: the
# confirm prompts use &#10; for their line breaks, and escaping the ampersand
# would put the entity on screen instead of breaking the line. Everything else
# that could close the attribute or open a tag is neutralised, so a prompt is
# free to contain a quote without silently truncating the element it lives in.
attr_escape() {
	printf '%s' "$1" | sed \
		-e 's/&/\&amp;/g' \
		-e 's/</\&lt;/g' \
		-e 's/>/\&gt;/g' \
		-e 's/"/\&quot;/g' \
		-e 's/&amp;#\([0-9][0-9]*\);/\&#\1;/g'
}

# Escape a string for use as HTML text content.
#
# Not `pre` or `ex`: both wrap what they are given in a block element -- a <pre>,
# and a <div> carrying a visible "# command" heading -- which is no use for a
# value sitting inside a <dt> or mid-sentence. Escaping the endpoint addresses
# with either would have put a <pre> inside every <dt> on mj-endpoints.cgi and
# taken the click-to-copy wiring with it.
#
# Not `attr_escape` either. That one deliberately puts numeric character
# references back after escaping, so the confirm prompts can carry a &#10; line
# break; for text read off the device that is exactly backwards, because it hands
# the value a way to emit an entity of its own choosing.
#
# Substitution rather than a sed pipeline, unlike attr_escape and pre next door.
# Those run once or twice per page; this one runs 56 times, and a fork and exec of
# sed per endpoint URL is a poor trade on a camera. Ampersand goes first so the
# entities the later rounds insert are not themselves re-escaped.
#
# printf rather than echo for the result, so nothing re-interprets a backslash and
# no trailing newline lands in the middle of an inline element.
esc() {
	local s="$1"
	s=${s//&/&amp;}
	s=${s//</&lt;}
	s=${s//>/&gt;}
	s=${s//\"/&quot;}
	printf '%s' "$s"
}

# field_switch "name" "label" "value" "hint" "confirm"
#
# A non-empty "confirm" marks the switch destructive: the row is styled in red
# (see .boolean.destructive in bootstrap.override.css) and main.js asks the given
# question as it is switched ON. Use it for anything that throws away data —
# a toggle that wipes the camera must not read like the one above it that
# upgrades the kernel (issue #160). Use &#10; for a line break in the prompt.
#
# Unlike "hint", which is interpolated raw so it can carry a link, this goes
# through attr_escape: it is an attribute value rather than markup, so a stray
# quote would end the tag early rather than merely look wrong.
field_switch() {
	local n="$1"
	local l="$2"
	local v="$3"
	local h="$4"
	local c="$5"
	local extra=""
	[ "$v" = "eval" ] && v=$(t_value "$n")
	# Anything that is not "true" contributes no attribute at all. Testing only
	# for true left the value itself in the tag, so every switch in the off state
	# rendered as <input ... class="form-check-input" false> — a stray boolean
	# attribute literally named "false". Harmless, since nothing reads it, but it
	# is invalid and it is the sort of thing that makes a later selector lie.
	case "$v" in
		true) v="checked" ;;
		*)    v="" ;;
	esac
	[ -n "$c" ] && extra=" data-confirm=\"$(attr_escape "$c")\""
	echo "<p class=\"boolean$([ -n "$c" ] && echo ' destructive')\"><span class=\"form-check form-switch\">" \
		"<input type=\"hidden\" id=\"${n}-false\" name=\"${n}\" value=\"false\">" \
		"<input type=\"checkbox\" id=\"${n}\" name=\"${n}\" value=\"true\" class=\"form-check-input\" ${v}${extra}>" \
		"<label for=\"${n}\" class=\"form-check-label\">${l}</label></span>"
	[ -n "$h" ] && echo "<span class=\"hint text-secondary\">${h}</span>"
	echo "</p>"
}

# field_string "name" "label" "value" "enum" "hint"
field_string() {
	local n="$1"
	local l="$2"
	local v="$3"
	local e="$4"
	local h="$5"
	[ "$v" = "eval" ] && v=$(t_value "$n")
	if [ -n "$e" ]; then
		echo "<p class=\"select\" id=\"${n}_wrap\">" \
			"<label for=\"${n}\" class=\"form-label\">${l}</label>" \
			"<select class=\"form-select\" id=\"${n}\" name=\"${n}\">"
		for e in $e; do
			echo -n "<option value=\"${e}\""
			[ "$v" = "$e" ] && echo -n " selected"
			echo ">${e}</option>"
		done
		echo "</select>"
	else
		echo "<p class=\"string\" id=\"${n}_wrap\">" \
			"<label for=\"${n}\" class=\"form-label\">${l}</label>" \
			"<input type=\"text\" id=\"${n}\" name=\"${n}\" class=\"form-control\" value=\"${v}\">"
	fi
	[ -n "$h" ] && echo "<span class=\"hint text-secondary\">${h}</span>"
	echo "</p>"
}

# field_text "name" "label" "hint"
field_text() {
	local n="$1"
	local l="$2"
	local h="$3"
	local v=$(t_value "$n")
	echo "<p class=\"string\" id=\"${n}_wrap\">" \
		"<label for=\"${n}\" class=\"form-label\">${l}</label>" \
		"<input type=\"text\" id=\"${n}\" name=\"${n}\" class=\"form-control\" value=\"${v}\">"
	[ -n "$h" ] && echo "<span class=\"hint text-secondary\">${h}</span>"
	echo "</p>"
}

# field_textedit "name" "label" "file"
field_textedit() {
	local n="$1"
	local l="$2"
	local v=$(cat "$3")
	echo "<p class=\"textarea\" id=\"${n}_wrap\">" \
		"<label for=\"${n}\" class=\"form-label\">${l}</label>" \
		"<textarea id=\"${n}\" name=\"${n}\" class=\"form-control\">${v}</textarea>"
	echo "</p>"
}

get_config() {
	echo ${1}/etc/majestic.yaml
}

# Best-effort clock fix for HTTPS (issue #44): a fresh flash boots with the
# stale build timestamp until ntpd converges, so HTTPS to GitHub fails
# ("certificate not yet valid"). Try a quick blocking NTP sync; if that is
# unreachable, set the clock from a plain-HTTP Date header (no TLS needed).
synctime() {
	timeout 8 ntpd -n -q -N >/dev/null 2>&1 && return 0
	local h d e
	for h in http://github.com http://deb.debian.org; do
		d=$(curl -m5 -sI "$h" | sed -n 's/^[Dd]ate: //p' | head -1 | tr -d '\r')
		[ -z "$d" ] && continue
		e=$(date -D "%a, %d %b %Y %T GMT" -d "$d" +%s 2>/dev/null)
		[ -n "$e" ] && date -s @"$e" >/dev/null 2>&1 && return 0
	done
	return 1
}

log_create() {
	echo "${1}:${2}" > "$log_file"
}

log_read() {
	[ ! -f "$log_file" ] && return
	[ -z "$(cat $log_file)" ] && return
	local c
	local m
	local l
	OIFS="$IFS"
	IFS=$'\n'
	for l in $(cat "$log_file"); do
		c="$(echo $l | cut -d':' -f1)"
		m="$(echo $l | cut -d':' -f2-)"
		echo "<div class=\"alert alert-${c} alert-dismissible fade show\" role=\"alert\">${m}" \
			"<button type=\"button\" class=\"btn btn-close\" data-bs-dismiss=\"alert\" aria-label=\"Close\"></button>" \
			"</div>"
	done
	IFS=$OIFS
	rm -f "$log_file"
}

set_error_flag() {
	echo "danger:${1}" >> "$log_file"
	error=1
}

html_title() {
	[ -n "$page_title" ] && echo -n "$page_title"
	[ -n "$title" ] && echo -n ": $title"
	echo -n " - OpenIPC"
}

include() {
	[ -f "$1" ] && . "$1"
}

# label "name" "classes" "extras" "units"
label() {
	local c="form-label"
	[ -n "$2" ] && c="${c} ${2}"
	local l="$(t_label "$1")"
	[ -z "$l" ] && l="$1" && c="${c} bg-warning"
	local x="$3"
	[ -n "$x" ] && x=" ${x}"
	local u="$4"
	[ -n "$u" ] && l="${l}, <span class=\"units text-secondary x-small\">$u</span>"
	echo "<label for=\"${1}\" class=\"${c}\"${x}>${l}</label>"
}

# pre "text" "classes" "extras"
pre() {
	# replace <, >, &, ", and ' with HTML entities
	tag "pre" "$(echo -e "$1" | sed "s/&/\&amp;/g;s/</\&lt;/g;s/>/\&gt;/g;s/\"/\&quot;/g")" "$2" "$3"
}

preview() {
	cat <<EOF
<div class="mj-player" id="mj-player">
	<!-- The stage: everything lives ON the video. The wrapper reserves 16:9
	     (preview-page.js corrects it to the stream's real ratio once known),
	     so neither loading nor the stats panel nor the control bar ever moves
	     the picture — the old layout stacked all of those above the video and
	     opening Stats pushed a 4K frame below the fold. tabindex makes the
	     stage itself focusable: that focus is what scopes PTZ arrow keys away
	     from the volume slider and the radio groups in the bar. -->
	<div class="mj-stage" id="mj-stage" tabindex="0" aria-label="Live video">
		<!-- Two, and only ever one of them visible. A transport switch attaches
		     the new player to whichever is idle and leaves the other playing, so
		     the picture only changes once the replacement has one of its own.
		     One element cannot do that: MSE drives it through src and WebRTC
		     through srcObject, so the incoming player would have to evict the
		     outgoing one before anybody knows whether it works. -->
		<video id="live-video" class="mj-stage-media" autoplay muted playsinline></video>
		<video id="live-video-b" class="mj-stage-media" autoplay muted playsinline style="display:none"></video>
		<img id="live-mjpeg" class="mj-stage-media" alt="" style="display:none">
		<p id="mj-note" class="alert alert-warning mj-stage-alert" style="display:none">
			Your browser can't play the live H.264/H.265 stream.
			<a href="mj-settings.cgi?tab=jpeg">Enable JPEG</a> for an MJPEG fallback.
		</p>
		<!-- The status chip. Same id as the badge it replaces, so every state
		     write (connecting… / no signal / MJPEG / reconnecting…) keeps
		     landing; live it reads "H264 3840×2160 · 25 fps". The transport is
		     NOT named here — it is named exactly once, on the picker below. -->
		<span id="mj-badge" class="mj-chip">connecting…</span>
		<!-- Two columns because the two ends disagree in the cases worth
		     looking at: the browser can be losing packets the camera never
		     sees dropped, and REMB is the camera's opinion of the link rather
		     than a measurement of it. An overlay, so looking at the numbers
		     does not displace the picture they describe. -->
		<div id="mj-stats" class="mj-stats-overlay small" hidden>
			<div class="row g-3">
				<div class="col-auto">
					<div class="fw-semibold">Browser</div>
					<table class="table table-sm table-borderless mb-0" style="font-variant-numeric:tabular-nums">
						<tbody>
							<tr><td class="pe-3 mj-stat-key">picture</td><td id="mj-st-pic">-</td></tr>
							<tr><td class="pe-3 mj-stat-key">receiving</td><td id="mj-st-rx">-</td></tr>
							<tr><td class="pe-3 mj-stat-key">lost / jitter</td><td id="mj-st-loss">-</td></tr>
							<tr><td class="pe-3 mj-stat-key">round trip</td><td id="mj-st-rtt">-</td></tr>
							<tr><td class="pe-3 mj-stat-key">recovery</td><td id="mj-st-recov">-</td></tr>
						</tbody>
					</table>
				</div>
				<div class="col-auto">
					<div class="fw-semibold">Camera</div>
					<table class="table table-sm table-borderless mb-0" style="font-variant-numeric:tabular-nums">
						<tbody>
							<tr><td class="pe-3 mj-stat-key">session</td><td id="mj-st-cam">-</td></tr>
							<tr><td class="pe-3 mj-stat-key">estimate</td><td id="mj-st-remb">-</td></tr>
							<tr><td class="pe-3 mj-stat-key">keyframes</td><td id="mj-st-pli">-</td></tr>
							<tr><td class="pe-3 mj-stat-key">audio in</td><td id="mj-st-ain">-</td></tr>
							<tr><td class="pe-3 mj-stat-key">talkback</td><td id="mj-st-talk">-</td></tr>
						</tbody>
					</table>
				</div>
			</div>
		</div>
		<!-- Shown only while WebRTC is the live transport. A sentence rather
		     than a control, and dismissible: the tooltip on the picker cannot
		     be the whole disclosure, because the thing being disclosed reaches
		     past the person reading it. -->
		<p id="mj-transport-note" class="mj-adapt-note small" hidden>
			The camera is adapting this stream's bitrate to your connection.
			Anyone else watching the same stream sees that too.
			<button type="button" class="mj-adapt-close" id="mj-note-close" aria-label="Dismiss">×</button>
		</p>
		<!-- PTZ mount. Empty and hidden on every camera; p/motor.cgi (included
		     by preview.cgi only when the hardware exists) emits the pad after
		     the player and preview-ptz.js relocates it in here. -->
		<div id="mj-ptz" class="mj-ptz" hidden></div>
		<!-- The control bar. Hidden until pointed at, focused into, or tapped
		     (preview-hero.js) — the picture is the page's point, not the
		     chrome. Stats sits by the view controls; snapshot and fullscreen
		     close the bar because they act on the stage itself. -->
		<div class="mj-bar" id="mj-bar">
			<div class="btn-group btn-group-sm" role="group" aria-label="Stream">
				<input type="radio" class="btn-check" name="mj-stream" id="mj-stream-0" autocomplete="off" checked>
				<label class="btn btn-outline-light" for="mj-stream-0">Main</label>
				<!-- Both start disabled, not merely label-hidden: a btn-check is
				     a real radio behind CSS, so an unhidden input is in the tab
				     order and a keyboard could select a stream this camera may
				     not have before the configuration has been read.
				     preview-page.js enables them once it knows there is a
				     substream. -->
				<input type="radio" class="btn-check" name="mj-stream" id="mj-stream-1" autocomplete="off" disabled>
				<label class="btn btn-outline-light" for="mj-stream-1" id="mj-sub" hidden>Sub</label>
				<input type="radio" class="btn-check" name="mj-stream" id="mj-stream-auto" autocomplete="off" disabled>
				<label class="btn btn-outline-light" for="mj-stream-auto" id="mj-auto" hidden
					title="Picks whichever stream is closest to the size this player is being shown at, and follows the window as it changes. The chip names the one in use.">Auto</label>
			</div>
			<div class="btn-group btn-group-sm" role="group" aria-label="Audio" id="mj-audio-ctl" hidden>
				<input type="checkbox" class="btn-check" id="mj-mute" autocomplete="off">
				<label class="btn btn-outline-light" for="mj-mute" id="mj-mute-lbl">🔇 Muted</label>
				<input type="range" id="mj-vol" min="0" max="100" value="100" class="form-range align-self-center ms-2" style="width:6rem" disabled aria-label="Volume">
			</div>
			<!-- Talkback. Revealed only over WebRTC, only where the camera has
			     audio.outputEnabled, and only in a secure context: a browser
			     hands over no microphone on plain HTTP, so the button would be
			     a dead end. -->
			<div class="btn-group btn-group-sm" role="group" aria-label="Talkback" id="mj-talk-ctl" hidden>
				<input type="checkbox" class="btn-check" id="mj-talk" autocomplete="off">
				<label class="btn btn-outline-light" for="mj-talk" id="mj-talk-lbl"
					title="Send this browser's microphone to the camera's speaker. The camera will not take audio in one direction only, so talking also opens its audio to you.">🎤 Talk</label>
			</div>
			<!-- The transport, named exactly once, with the alternative finally
			     visible. Unhidden by preview-page.js only where
			     preview-webrtc.js is loaded and the browser has WebRTC. The
			     failure tooltip still lands on the WebRTC label
			     (#mj-transport-lbl), which is where the question "why am I not
			     on WebRTC?" gets asked. -->
			<div class="btn-group btn-group-sm ms-auto" role="group" aria-label="Transport" id="mj-transport-ctl" hidden>
				<input type="radio" class="btn-check" name="mj-transport" id="mj-transport-w" autocomplete="off">
				<label class="btn btn-outline-light" for="mj-transport-w" id="mj-transport-lbl"
					title="Sub-second video and two-way audio, and the camera fits the stream to your connection — which changes it for everyone else watching that stream too.">WebRTC</label>
				<input type="radio" class="btn-check" name="mj-transport" id="mj-transport-m" autocomplete="off">
				<label class="btn btn-outline-light" for="mj-transport-m"
					title="Plain buffered playback. A couple of seconds behind, but nothing adapts and nothing negotiates.">MSE</label>
			</div>
			<div class="btn-group btn-group-sm" role="group" aria-label="Statistics" id="mj-stats-ctl" hidden>
				<input type="checkbox" class="btn-check" id="mj-stats-btn" autocomplete="off">
				<label class="btn btn-outline-light" for="mj-stats-btn"
					title="Per-second measurements from both ends of the session.">Stats</label>
			</div>
			<button type="button" class="btn btn-sm btn-outline-light" id="mj-snap" hidden
				title="Download a full-resolution snapshot" aria-label="Snapshot">📷</button>
			<!-- Inline SVG rather than U+26F6: that glyph is missing from enough
			     fonts to render as a box on real machines. -->
			<button type="button" class="btn btn-sm btn-outline-light" id="mj-fs" hidden
				title="Fullscreen" aria-label="Fullscreen"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M1.5 5.5v-4h4M14.5 5.5v-4h-4M1.5 10.5v4h4M14.5 10.5v4h-4"/></svg></button>
		</div>
	</div>
</div>
EOF
}

# redirect_back "flash class" "flash text"
redirect_back() {
	redirect_to "${HTTP_REFERER:-/}" "$1" "$2"
}

# redirect_to "url" "flash class" "flash text"
redirect_to() {
	[ -n "$3" ] && log_create "$2" "$3"
	echo "HTTP/1.1 303 See Other"
	echo "Content-type: text/html; charset=UTF-8"
	echo "Cache-Control: no-store"
	echo "Pragma: no-cache"
	echo "Location: $1"
	echo
	exit 0
}

report_command() {
	echo "<h4># ${1}</h4>"
	echo "<pre class=\"small\">${2}</pre>"
}

report_error() {
	echo "<h4 class=\"text-danger\">Oops. Something happened.</h4>"
	alert "$1" "danger"
}

# report_log "text" "extras"
report_log() {
	pre "$1" "small" "$2"
}

generate_signature() {
	echo "${soc} (${soc_family} family), $sensor, ${flash_size} MB ${flash_type} flash, ${fw_version}-${fw_variant}, ${network_hostname}, ${network_macaddr}" > $signature_file
}

signature() {
	[ ! -f "$signature_file" ] && generate_signature
	cat $signature_file
}

t_label() {
	eval "echo \$tL_${1}"
}

t_value() {
	eval "echo \$${1}"
}

update_caminfo() {
	flash_type=$(ipcinfo --flash-type)
	mtd_size=$(grep -E "nor|nand" $(ls /sys/class/mtd/mtd*/type) | sed -E "s|type.+|size|g")
	flash_size=$(awk '{sum+=$1} END{print sum/1024/1024}' $mtd_size)

	sensor=$(fw_printenv -n sensor)
	[ -z "$sensor" ] && sensor="unknown"

	soc_vendor=$(ipcinfo --vendor)
	soc_family=$(ipcinfo --family)

	soc=$(ipcinfo --chip-name)
	if [ -z "$soc" ] || [ "$soc_vendor" = "sigmastar" ]; then
		soc=$(fw_printenv -n soc)
	fi

	soc_temp=$(ipcinfo --temp 2> /dev/null)
	if [ -n "$soc_temp" ]; then
		soc_has_temp="true"
	else
		soc_has_temp="false"
	fi

	# Firmware
	fw_version=$(grep "OPENIPC_VERSION" /etc/os-release | cut -d= -f2 | tr -d '"')
	fw_variant=$(grep "BUILD_OPTION" /etc/os-release | cut -d= -f2 | tr -d '"')
	fw_build=$(grep "GITHUB_VERSION" /etc/os-release | cut -d= -f2 | tr -d '"')
	mj_version=$($mj_bin_file -v)
	uboot_version=$(fw_printenv -n ver)

	# WebUI
	ui_password=$(grep root /etc/shadow | cut -d: -f2)
	# PTZ preview controls. Three backends, each needing both its switch and
	# its binary: GPIO motors (gpio_motors + gpio-motors), a motor profile
	# (ptz + /usr/bin/motor), or Pelco-D over serial (ptz + /usr/bin/btzoom).
	# The backend decides which pad p/motor.cgi draws — the first two are
	# stepped pan/tilt with diagonals, Pelco-D is four directions in timed
	# pulses plus zoom and focus. Order matters only when a camera has
	# several installed; the stepped backends win because their protocol
	# carries magnitudes the Pelco pulses cannot.
	if [ -n "$(fw_printenv -n gpio_motors 2>/dev/null)" ] && command -v gpio-motors >/dev/null 2>&1; then
		ptz_support="1"; ptz_backend="gpio"
	elif [ -x /usr/bin/motor ] && [ -n "$(fw_printenv -n ptz 2>/dev/null)" ]; then
		ptz_support="1"; ptz_backend="motor"
	elif [ -x /usr/bin/btzoom ] && [ -n "$(fw_printenv -n ptz 2>/dev/null)" ]; then
		ptz_support="1"; ptz_backend="pelco"
	else
		ptz_support=""; ptz_backend=""
	fi

	# Network
	network_interface=$(ip route | awk '/default/ {print $5}' | head -n1)
	network_address=$(ip route | grep ${network_interface:-eth0} | awk '/src/ {print $7}')
	network_gateway=$(ip route | awk '/default/ {print $3}')
	network_hostname=$(hostname -s)
	network_macaddr=$(cat /sys/class/net/${network_interface:-eth0}/address)

	# Overlay
	overlay_root="/overlay"

	# Default timezone is GMT
	tz_data=$(cat /etc/TZ)
	tz_name=$(cat /etc/timezone)
	if [ -z "$tz_data" ] || [ -z "$tz_name" ]; then
		tz_data="GMT0"; echo "$tz_data" > /etc/TZ
		tz_name="Etc/GMT"; echo "$tz_name" > /etc/timezone
	fi

	local variables="flash_size flash_type fw_build fw_variant fw_version mj_version network_address
		network_gateway network_hostname network_interface network_macaddr overlay_root ptz_support
		ptz_backend sensor soc soc_family soc_has_temp soc_vendor tz_data tz_name uboot_version ui_password"
	rm -f ${sysinfo_file}

	local v
	for v in $variables; do
		eval "echo ${v}=\'\$${v}\' >> ${sysinfo_file}"
	done

	generate_signature
}

mj_bin_file=/usr/bin/majestic
log_file=/tmp/webui/logfile.txt
signature_file=/tmp/webui/signature.txt
sysinfo_file=/tmp/webui/sysinfo.txt

[ ! -d /etc/webui ] && mkdir -p /etc/webui
[ ! -d /tmp/webui ] && mkdir -p /tmp/webui

[ ! -f $sysinfo_file ] && update_caminfo
include $sysinfo_file

pagename=$(basename "$SCRIPT_NAME")
pagename="${pagename%%.*}"

include /etc/webui/webui.conf

check_password
%>
