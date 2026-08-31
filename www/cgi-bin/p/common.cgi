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

# card_head "title" "note"
#
# The heading of a card, in the vocabulary the settings deck uses: micro-caps
# name, a hairline to the card's edge, and an optional note on the right for
# state the reader would otherwise have to go and find (whether an extension is
# on, which interface is live). Still an <h3> — it is the card's heading and the
# document outline should say so.
card_head() {
	echo "<div class=\"mj-live-head\">" \
		"<h3 class=\"mj-cap\">${1}</h3>" \
		"<span class=\"mj-live-rule\"></span>"
	[ -n "$2" ] && echo "<span class=\"mj-live-note\">${2}</span>"
	echo "</div>"
}

# group_head "title"
#
# A run of related fields inside a card. Four pages had grown their own
# <div class="text-uppercase x-small text-secondary mt-3 mb-2"> for this; they
# all mean the same thing, so it is one helper and one rule now.
group_head() {
	echo "<div class=\"mj-live-grp-head\">" \
		"<span class=\"mj-cap\">${1}</span>" \
		"<span class=\"mj-live-rule\"></span></div>"
}

# button_submit "text" "type" "extras" "note"
#
# The card's foot rather than a button loose on the page: a bar across the
# bottom of the card, its own surface, with the action at the right end and an
# optional note on the left saying what saving does or where it lands.
button_submit() {
	local t="$1"
	[ -z "$t" ] && t="Save Changes"
	local c="$2"
	[ -z "$c" ] && c="primary"
	local x="$3"
	[ -z "$x" ] && x=" ${x}"
	local n="$4"
	echo "<div class=\"mj-foot\">"
	[ -n "$n" ] && echo "<span class=\"mj-foot-note\">${n}</span>"
	echo "<input type=\"submit\" class=\"btn btn-${c}\"${x} value=\"${t}\"></div>"
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
	echo "<p class=\"number mj-row\">" \
		"<label class=\"form-label\" for=\"${n}\">${l}</label>" \
		"<span class=\"mj-ctl\"><span class=\"mj-ctl-in\">"
	echo "<input type=\"number\" id=\"${n}\" name=\"${n}\" class=\"form-control text-end\" value=\"${v}\" min=\"${x}\" max=\"${y}\" step=\"1\">" \
		"</span></span>"
	[ -n "$h" ] && echo "<span class=\"hint text-secondary\">${h}</span>"
	echo "</p>"
}

# field_password "name" "label" "hint"
field_password() {
	local n="$1"
	local l="$2"
	local h="$3"
	local v=$(t_value "$n")
	echo "<p class=\"password mj-row\" id=\"${n}_wrap\">" \
		"<label for=\"${n}\" class=\"form-label\">${l}</label>" \
		"<span class=\"mj-ctl\"><span class=\"mj-ctl-in\"><span class=\"input-group\">" \
		"<input type=\"password\" id=\"${n}\" name=\"${n}\" class=\"form-control\" value=\"${v}\">" \
		"<label class=\"input-group-text\">" \
		"<input type=\"checkbox\" class=\"form-check-input me-1\" data-for=\"${n}\"> show" \
		"</label></span></span></span>"
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
	echo "<p class=\"range mj-row\" id=\"${n}_wrap\">" \
		"<label for=\"${n}\" class=\"form-label\">${l}</label>" \
		"<span class=\"mj-ctl\"><span class=\"mj-ctl-in\"><span class=\"input-group\">"
	echo "<input type=\"hidden\" id=\"${n}\" name=\"${n}\" value=\"${v}\">"
	echo "<input type=\"range\" class=\"form-control form-range\" id=\"${n}-range\" value=\"${v}\" min=\"${x}\" max=\"${y}\" step=\"1\">"
	echo "<span class=\"input-group-text show-value\" id=\"${n}-show\">${v}</span></span></span></span>"
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
	# The label goes above the switch, like every other row's, instead of beside
	# it: a switch row was 24px where a text row is 64, so a card mixing the two
	# had no rhythm. The word beside the switch says what the position means and
	# is filled by CSS from the checkbox's own state — these pages are rendered
	# by the server and have no JS to write it.
	echo "<p class=\"boolean mj-row$([ -n "$c" ] && echo ' destructive')\">" \
		"<label for=\"${n}\" class=\"form-label\">${l}</label>" \
		"<span class=\"mj-ctl\"><span class=\"mj-ctl-in\">" \
		"<span class=\"form-check form-switch\">" \
		"<input type=\"hidden\" id=\"${n}-false\" name=\"${n}\" value=\"false\">" \
		"<input type=\"checkbox\" id=\"${n}\" name=\"${n}\" value=\"true\" class=\"form-check-input\" ${v}${extra}>" \
		"</span><span class=\"mj-state\" aria-hidden=\"true\"></span></span></span>"
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
		echo "<p class=\"select mj-row\" id=\"${n}_wrap\">" \
			"<label for=\"${n}\" class=\"form-label\">${l}</label>" \
			"<span class=\"mj-ctl\"><span class=\"mj-ctl-in\">" \
			"<select class=\"form-select\" id=\"${n}\" name=\"${n}\">"
		for e in $e; do
			echo -n "<option value=\"${e}\""
			[ "$v" = "$e" ] && echo -n " selected"
			echo ">${e}</option>"
		done
		echo "</select></span></span>"
	else
		echo "<p class=\"string mj-row\" id=\"${n}_wrap\">" \
			"<label for=\"${n}\" class=\"form-label\">${l}</label>" \
			"<span class=\"mj-ctl\"><span class=\"mj-ctl-in\">" \
			"<input type=\"text\" id=\"${n}\" name=\"${n}\" class=\"form-control\" value=\"${v}\">" \
			"</span></span>"
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
	echo "<p class=\"string mj-row\" id=\"${n}_wrap\">" \
		"<label for=\"${n}\" class=\"form-label\">${l}</label>" \
		"<span class=\"mj-ctl\"><span class=\"mj-ctl-in\">" \
		"<input type=\"text\" id=\"${n}\" name=\"${n}\" class=\"form-control\" value=\"${v}\">" \
		"</span></span>"
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
						<tr><td class="pe-3 mj-stat-key">encoder</td><td id="mj-st-enc">-</td></tr>
							<tr><td class="pe-3 mj-stat-key">keyframes</td><td id="mj-st-pli">-</td></tr>
							<tr><td class="pe-3 mj-stat-key">audio in</td><td id="mj-st-ain">-</td></tr>
							<tr><td class="pe-3 mj-stat-key">talkback</td><td id="mj-st-talk">-</td></tr>
						</tbody>
					</table>
				</div>
			</div>
		</div>
		<!-- The adaptation toast (preview-adapt.js): the whole disclosure of
		     WebRTC's shared-encoder bitrate adaptation, made at the moment it
		     acts rather than as a standing sentence (the always-on note this
		     replaces taught people to ignore it, and could not tell whose
		     connection was responsible). Names the direction and says whose
		     link moved the encoder — a change caused by another viewer is the
		     case nothing else on the page would explain. Below the chip so
		     the two can show together. -->
		<!-- role=status so the announcement reaches a screen reader when the
		     text lands; the × is the keyboard's dismissal (click-anywhere
		     only serves a pointer) and focusing it pins the toast the same
		     way hovering does. -->
		<p id="mj-adapt" class="mj-adapt-toast small" role="status" hidden>
			<span id="mj-adapt-rates" class="mj-adapt-rates"></span>
			<span id="mj-adapt-why" class="mj-adapt-why"></span>
			<button type="button" class="mj-adapt-close" aria-label="Dismiss">×</button>
		</p>
		<!-- The served-channel message (preview-page.js): why the channel the
		     viewer picked is not the one playing, from the camera's own
		     `served` signalling reply on a new enough majestic. Unlike the
		     adaptation toast it does not time out — the mismatch stands for
		     the whole session — so it stays until dismissed or stale. Slotted
		     below the adaptation toast so all three overlays can show. -->
		<p id="mj-served" class="mj-adapt-toast mj-served-toast small" role="status" hidden>
			<span id="mj-served-why"></span>
			<button type="button" class="mj-adapt-close" aria-label="Dismiss">×</button>
		</p>
		<!-- PTZ mount. Empty and hidden on every camera; p/motor.cgi (included
		     by preview.cgi only when the hardware exists) emits the pad after
		     the player and preview-ptz.js relocates it in here. -->
		<div id="mj-ptz" class="mj-ptz" hidden></div>
		<!-- The control bar. Hidden until pointed at, focused into, or tapped
		     (preview-hero.js) — the picture is the page's point, not the
		     chrome. It stays overlaid at every width, because it lives inside
		     the stage and that is what carries it into fullscreen; below md it
		     scrolls sideways rather than wrapping into rows over a 186px-tall
		     picture. The PTZ pad is the one that moves off the video there:
		     it is always visible, so overlaid it never gives the picture back.

		     Every group is black glass with a micro-caps label and, where it
		     has a state, a lit indicator — the same vocabulary the Live
		     adjustments deck uses, so the two pages read as one product. The
		     radio/checkbox-behind-a-label pattern is kept exactly as it was:
		     preview-page.js drives .checked and .disabled on those inputs, and
		     they are what keeps the groups reachable from a keyboard.

		     Icons are inline SVG on a 20px grid. The emoji that were here
		     (U+1F507 speaker, U+1F3A4 microphone, U+1F4F7 camera) rendered as
		     a different picture on every machine — the same argument the
		     fullscreen button in this very bar already won, when U+26F6 came
		     out as a box on real hardware. -->
	<div class="mj-bar" id="mj-bar">
			<span class="mj-hud mj-seg" role="group" aria-label="Stream">
				<input type="radio" class="mj-seg-in" name="mj-stream" id="mj-stream-0" autocomplete="off" checked>
				<label class="mj-seg-lbl" for="mj-stream-0">Main</label>
				<!-- Both start disabled, not merely label-hidden: the input is a
				     real radio behind CSS, so an unhidden one is in the tab
				     order and a keyboard could select a stream this camera may
				     not have before the configuration has been read.
				     preview-page.js enables them once it knows there is a
				     substream. -->
				<input type="radio" class="mj-seg-in" name="mj-stream" id="mj-stream-1" autocomplete="off" disabled>
				<label class="mj-seg-lbl" for="mj-stream-1" id="mj-sub" hidden>Sub</label>
				<input type="radio" class="mj-seg-in" name="mj-stream" id="mj-stream-auto" autocomplete="off" disabled>
				<label class="mj-seg-lbl" for="mj-stream-auto" id="mj-auto" hidden
					title="Picks whichever stream is closest to the size this player is being shown at, and follows the window as it changes. The chip names the one in use.">Auto</label>
			</span>

			<!-- Muting and level are one control, so the slider rides inside
			     the same glass rather than beside it. The speaker icon carries
			     both states in one element: CSS shows the crossed-out ending
			     while the input is unchecked and the waves while it is, so the
			     word alone is what preview-page.js has to rewrite. -->
			<span class="mj-hud mj-tog-wrap" id="mj-audio-ctl" hidden>
				<input type="checkbox" class="mj-tog-in" id="mj-mute" autocomplete="off">
				<label class="mj-tog" for="mj-mute" id="mj-mute-lbl">
					<span class="mj-led"></span>
					<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<path d="M4 7.6h2.8L10.6 4.4v11.2L6.8 12.4H4z"></path>
						<path class="mj-ic-off" d="M13.6 7.8l3.8 4.4M17.4 7.8l-3.8 4.4"></path>
						<path class="mj-ic-on" d="M13.4 7.6a3.4 3.4 0 0 1 0 4.8M15.8 5.6a6.6 6.6 0 0 1 0 8.8"></path>
					</svg>
					<span class="mj-tog-t" id="mj-mute-t">Muted</span>
				</label>
				<input type="range" id="mj-vol" min="0" max="100" value="100" class="mj-vol" disabled aria-label="Volume">
			</span>

			<!-- Talkback. Revealed only over WebRTC, only where the camera has
			     audio.outputEnabled, and only in a secure context: a browser
			     hands over no microphone on plain HTTP, so the button would be
			     a dead end. -->
			<span class="mj-hud mj-tog-wrap" id="mj-talk-ctl" hidden>
				<input type="checkbox" class="mj-tog-in" id="mj-talk" autocomplete="off">
				<label class="mj-tog mj-tog-amber" for="mj-talk" id="mj-talk-lbl"
					title="Send this browser's microphone to the camera's speaker. The camera will not take audio in one direction only, so talking also opens its audio to you.">
					<span class="mj-led"></span>
					<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<rect x="7.4" y="2.6" width="5.2" height="9" rx="2.6"></rect>
						<path d="M4.6 9.4a5.4 5.4 0 0 0 10.8 0M10 14.8v2.6"></path>
					</svg>
					<span class="mj-tog-t" id="mj-talk-t">Talk</span>
				</label>
			</span>

			<!-- The transport, named exactly once, with the alternative finally
			     visible. Unhidden by preview-page.js only where
			     preview-webrtc.js is loaded and the browser has WebRTC. The
			     failure tooltip still lands on the WebRTC label
			     (#mj-transport-lbl), which is where the question "why am I not
			     on WebRTC?" gets asked. -->
			<span class="mj-hud mj-seg mj-bar-end" role="group" aria-label="Transport" id="mj-transport-ctl" hidden>
				<input type="radio" class="mj-seg-in" name="mj-transport" id="mj-transport-w" autocomplete="off">
				<label class="mj-seg-lbl" for="mj-transport-w" id="mj-transport-lbl"
					title="Sub-second video and two-way audio, and the camera fits the stream to your connection — which changes it for everyone else watching that stream too.">WebRTC</label>
				<input type="radio" class="mj-seg-in" name="mj-transport" id="mj-transport-m" autocomplete="off">
				<label class="mj-seg-lbl" for="mj-transport-m"
					title="Plain buffered playback. A couple of seconds behind, but nothing adapts and nothing negotiates.">MSE</label>
			</span>

			<span class="mj-hud mj-tog-wrap" id="mj-stats-ctl" hidden>
				<input type="checkbox" class="mj-tog-in" id="mj-stats-btn" autocomplete="off">
				<label class="mj-tog" for="mj-stats-btn"
					title="Per-second measurements from both ends of the session.">
					<span class="mj-led"></span>
					<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
						<path d="M3.4 16.6V11M8.4 16.6V4.6M13.4 16.6V8.2M17.2 16.6v-3.4"></path>
					</svg>
					<span class="mj-tog-t">Stats</span>
				</label>
			</span>

			<span class="mj-hud mj-ico-wrap">
				<button type="button" class="mj-hud-ico" id="mj-snap" hidden
					title="Download a full-resolution snapshot" aria-label="Snapshot">
					<svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
						<path d="M2.6 6.6h3.2l1.5-2.1h5.4l1.5 2.1h3.2v9H2.6z" stroke-linejoin="round"></path>
						<circle cx="10" cy="10.6" r="3.1"></circle>
					</svg>
				</button>
				<button type="button" class="mj-hud-ico" id="mj-fs" hidden
					title="Fullscreen" aria-label="Fullscreen">
					<svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
						<path d="M3 7.4V3h4.4M16.9 7.4V3h-4.4M3 12.6V17h4.4M16.9 12.6V17h-4.4"></path>
					</svg>
				</button>
			</span>
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

# The bar answers three questions -- which camera am I on, what hardware is
# it, what firmware does it run -- and nothing more; MAC, flash and SoC family
# live on the Dashboard. The stock hostname is <soc>-<sensor>, so each
# hardware word appears only when the hostname does not already say it: a
# renamed camera reads "front-door, hi3516av300, imx415, 2.6.08.29-lite",
# a stock one collapses to "hi3516av300-imx415, 2.6.08.29-lite".
generate_signature() {
	local sig="$network_hostname"
	local lower=$(echo "$network_hostname" | tr 'A-Z' 'a-z')
	case "$lower" in *"$soc"*) ;; *) sig="$sig, $soc" ;; esac
	[ "$sensor" != "unknown" ] && case "$lower" in *"$sensor"*) ;; *) sig="$sig, $sensor" ;; esac
	sig="$sig, ${fw_version}-${fw_variant}"
	sig="${sig#, }"
	esc "$sig" > $signature_file
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
	# PTZ preview controls. The switch is the U-Boot ptz_control variable
	# (#227): it names the method — "gpio" (gpio-motors, pins in ptz_gpio or
	# the legacy gpio_motors, which the gpio-motors binary itself still
	# reads), "pelco-d" (btzoom over serial, port/rate in ptz_port and
	# ptz_speed), "motor" (a motor profile in ptz_profile or the legacy ptz
	# value), or "none". An explicit method is trusted but still needs its
	# binary — a pad whose every press fails is worse than no pad. With
	# ptz_control unset, the pre-#227 detection stands so no camera in the
	# field loses its pad: gpio wins over a profile wins over Pelco, because
	# the stepped protocols carry magnitudes the Pelco pulses cannot.
	# The backend decides which pad p/motor.cgi draws — gpio and motor are
	# stepped eight-way pan/tilt, Pelco-D is four directions in timed pulses
	# plus zoom and focus.
	ptz_support=""; ptz_backend=""
	ptz_control=$(fw_printenv -n ptz_control 2>/dev/null)
	case "$ptz_control" in
		gpio)
			# The binary AND a pin list: gpio-motors without pins errors on
			# every press, and the pad must not render what cannot work. The
			# binary itself still reads the legacy name, so either satisfies.
			if command -v gpio-motors >/dev/null 2>&1 &&
				{ [ -n "$(fw_printenv -n ptz_gpio 2>/dev/null)" ] || [ -n "$(fw_printenv -n gpio_motors 2>/dev/null)" ]; }; then
				ptz_support="1"; ptz_backend="gpio"
			fi
			;;
		pelco-d)
			if [ -x /usr/bin/btzoom ]; then
				ptz_support="1"; ptz_backend="pelco"
			fi
			;;
		motor)
			# Same rule: the profile is what the binary is called with, so a
			# pad without one would render presses the endpoint refuses.
			if [ -x /usr/bin/motor ] &&
				{ [ -n "$(fw_printenv -n ptz_profile 2>/dev/null)" ] || [ -n "$(fw_printenv -n ptz 2>/dev/null)" ]; }; then
				ptz_support="1"; ptz_backend="motor"
			fi
			;;
		none) ;;
		"")
			if [ -n "$(fw_printenv -n gpio_motors 2>/dev/null)" ] && command -v gpio-motors >/dev/null 2>&1; then
				ptz_support="1"; ptz_backend="gpio"
			elif [ -x /usr/bin/motor ] && [ -n "$(fw_printenv -n ptz 2>/dev/null)" ]; then
				ptz_support="1"; ptz_backend="motor"
			elif [ -x /usr/bin/btzoom ] && [ -n "$(fw_printenv -n ptz 2>/dev/null)" ]; then
				ptz_support="1"; ptz_backend="pelco"
			fi
			;;
	esac

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
