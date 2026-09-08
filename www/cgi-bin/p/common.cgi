#!/usr/bin/haserl
<%
IFS_ORIG=$IFS

# Reading majestic's configuration.
#
# Sourced through the working directory, not through $0. Under haserl $0 is the
# interpreter -- /bin/sh -- so `dirname $0` is /bin and every page 500s on a
# file that is not there. The CGI's cwd is the directory of the script being
# served, which for every page that includes this one is cgi-bin/ -- the same
# directory haserl resolves this file's own include against. Relative rather
# than /var/www/... because the document root is majestic's system.staticDir
# and a camera is free to move it.
#
# (Nothing in a comment here may contain a haserl close tag: it is inside the
# block, so the parser would end the block on it and the page would fail with
# "Missing" that same tag, several hundred lines later.)
. ./p/majestic.sh

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
	local p="/cgi-bin/access.cgi"
	[ -z "$SCRIPT_NAME" ] || [ "$SCRIPT_NAME" = "${p}" ] && return
	if uses_default_password; then
		redirect_to "${p}" "danger" "You must set your own secure password!"
	fi
}

ex() {
	echo "<div class=\"${2:-ex}\"><h6># ${1}</h6><pre class=\"small\">"
	# 2>&1 because this block exists to SHOW what a command said, and what a
	# failing one says is on stderr. Without it the operator gets an empty box
	# and the reason goes to majestic's stderr, which under the service goes
	# nowhere: `ip link show wg0` on a camera with no tunnel printed "can't find
	# device" there and nothing here, on a panel whose whole job is to report.
	eval "$1" 2>&1 | sed "s/&/\&amp;/g;s/</\&lt;/g;s/>/\&gt;/g;s/\"/\&quot;/g"
	echo "</pre></div>"
}

# field_hidden "name" "value"
field_hidden() {
	local n="$1"
	local v="$2"
	echo "<input type=\"hidden\" name=\"${n}\" id=\"${n}\" value=\"${v}\" class=\"form-hidden\">"
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
# with either would have put a <pre> inside every <dt> on stream-urls.cgi and
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
	# The file need not exist. editor.cgi passes "$editor_file", which is empty
	# until a file is chosen, so opening the editor from the menu ran `cat ""`
	# and put "can't open ''" on majestic's stderr on every visit. An unreadable
	# path is an empty box, which is what the page shows anyway.
	local v=""
	[ -r "$3" ] && v=$(cat "$3")
	echo "<p class=\"textarea\" id=\"${n}_wrap\">" \
		"<label for=\"${n}\" class=\"form-label\">${l}</label>" \
		"<textarea id=\"${n}\" name=\"${n}\" class=\"form-control\">${v}</textarea>"
	echo "</p>"
}

get_config() {
	echo ${1}/etc/majestic.yaml
}

# Make Majestic re-read its configuration file.
#
# Majestic parses the file once and then holds the whole configuration in
# memory, and a save writes that whole tree back. So a file replaced
# underneath it is not merely invisible - the settings page keeps serving the
# values Majestic still holds - it is temporary: the next save from anywhere,
# a field on the settings page or an ONVIF client, puts the old values back on
# disk and the edit is gone with no sign that it ever happened.
#
# SIGHUP is what re-reads it: reload_sdk() parses the file from scratch (built-
# in defaults first, then whatever the file says) and rebuilds the pipeline on
# the result. /api/v1/{config,set,reset} already do this for their own writes;
# anything that writes the file directly has to say so here.
#
# Detached and delayed, because tearing the pipeline down closes every
# connection the web server holds - and that includes the one this CGI's own
# answer is still travelling on. Signalling in line restored the file and then
# left the browser hanging on two of three cameras, which reads exactly like
# the camera having crashed. Two seconds is several times what a page on these
# boards takes to finish, so the redirect and the page it lands on are both
# served before anything is torn down.
#
# The redirections are not tidiness either: the background job inherits the
# pipe the web server reads this CGI's output from, and while it holds that
# pipe open the answer is never finished at all.
majestic_reload() {
	pidof majestic >/dev/null 2>&1 || return 1
	(sleep 2; killall -1 majestic) </dev/null >/dev/null 2>&1 &
	return 0
}

log_create() {
	echo "${1}:${2}" > "$log_file"
}

# The one banner shape the whole UI uses: .mj-notice in bootstrap.override.css,
# which is the Dashboard's old .st-alert lifted out of the Dashboard. Severity
# is danger | warn | info | ok and drives the rule and the mark together.
#
#   notice <severity> <sentence html> [actions html] [dismiss]
#
# The sentence is HTML because every caller leads with a <b> and most carry a
# link in the tail; run anything device-derived through `ex` before passing it.
# The marks are drawn rather than typed, and are the same five paths main.js
# emits for the pages that build a notice in the browser -- a severity mark
# that differs between two pages is worse than no mark at all.
#
# EVERY action is a button, and the colour says what pressing it costs (#347).
# A notice is read the way a system dialog is -- a sentence, a way out in the
# corner, and the thing to press -- so the thing to press is shaped like one.
# A bare link among banners of buttons is the odd one out, and an arrow after it
# says only what the underline already said (#347).
#
#   btn-primary    go to the page that fixes this
#   btn-secondary  a second, diagnostic destination beside a primary
#   btn-danger     acts on the camera when pressed, not a destination
#
# btn-secondary rather than btn-outline-secondary, which is the more obvious
# reading of "the quieter one", because the outline's label is the SAME grey
# as its border: measured on this card it is 3.51:1 on the dark theme, where
# the filled one puts white on that grey and reaches 4.69:1 in both themes. A
# filled grey is quieter than a filled blue or red anyway -- it is the least
# saturated thing in the row -- so nothing is lost by taking the legible one.
#
# The last one is not decoration. main.js hangs its confirm() off .btn-danger
# and .btn-warning, so that class is a promise that pressing does something
# worth asking about; today exactly one href earns it, restart.cgi, which
# reboots the camera on GET. Putting it on a link that merely navigates is how
# the recordings banner came within one initAll() timing accident of asking
# "Are you sure?" before letting somebody read a page.
#
# The vocabulary drifted once already, because it is written in three languages
# -- this argument, hand-written .mj-notice-acts markup, and an `acts:` literal
# in JS -- and nothing compared them. tests/notice.test.js now does, over every
# action in the tree, by name.
notice_icon() {
	local d
	case "$1" in
		danger) d='<circle cx="12" cy="12" r="8.7"/><path d="M12 7.6v5"/><path d="M12 16.3h.01"/>' ;;
		warn) d='<path d="M12 4.6 21.2 19.4H2.8z"/><path d="M12 10.2v4"/><path d="M12 17.1h.01"/>' ;;
		ok) d='<circle cx="12" cy="12" r="8.7"/><path d="m8.3 12.3 2.6 2.6 4.9-5.3"/>' ;;
		*) d='<circle cx="12" cy="12" r="8.7"/><path d="M12 11.2v5.2"/><path d="M12 7.7h.01"/>' ;;
	esac
	printf '<svg class="mj-notice-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">%s</svg>' "$d"
}

notice() {
	printf '<div class="mj-notice mj-notice-%s" role="alert">' "$1"
	notice_icon "$1"
	printf '<div class="mj-notice-txt">%s</div>' "$2"
	[ -n "$3" ] && printf '<span class="mj-notice-acts">%s</span>' "$3"
	[ -n "$4" ] && printf '<button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>'
	printf '</div>\n'
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
		# The stored word is Bootstrap's severity name, because that is what
		# every caller of log_create / redirect_back / set_error_flag writes and
		# they are spread across two dozen files and both sbin trees. Mapping it
		# here is one `case`; renaming it at the call sites is a flag day.
		case "$(echo $l | cut -d':' -f1)" in
			success) c=ok ;;
			warning) c=warn ;;
			danger) c=danger ;;
			*) c=info ;;
		esac
		m="$(echo $l | cut -d':' -f2-)"
		notice "$c" "$m" "" 1
	done
	IFS=$OIFS
	rm -f "$log_file"
}

set_error_flag() {
	echo "danger:${1}" >> "$log_file"
	error=1
}

# The browser tab. It carries the bar menu the page sits under, so a window
# of camera tabs reads "System - Network - OpenIPC" rather than four tabs all
# called Network; a top-level page has no menu and gets no prefix. The `title`
# secondary that used to sit here is gone -- nothing in the tree ever set it.
html_title() {
	local m=$(page_menu "$pagename")
	[ -n "$m" ] && printf '%s - ' "$m"
	printf '%s - OpenIPC' "$page_title"
}

include() {
	[ -f "$1" ] && . "$1"
}

# pre "text" "classes" "extras"
#
# The <pre> twin of ex, for a text blob the camera produced rather than a
# command to run. It has no caller today, but it is half of the escaping API
# tools/lint-templates.sh names when it catches request data rendered raw
# through an echoing template tag, so removing it would leave that message
# pointing at nothing. (Spelling that tag out here would open a second
# template block inside this one -- haserl scans the raw file for it.)
pre() {
	local c="$2"
	[ -n "$c" ] && c=" class=\"${c}\""
	local x="$3"
	[ -n "$x" ] && x=" ${x}"
	echo "<pre${c}${x}>$(esc "$(echo -e "$1")")</pre>"
}

# redirect_back "flash class" "flash text"
redirect_back() {
	redirect_to "${HTTP_REFERER:-/}" "$1" "$2"
}

# redirect_to "url" "flash class" "flash text"
# moved_to <the page it moved to>
#
# The whole body of a compatibility alias -- one of the tombstone .cgi files
# still carrying a pre-rename name, each of which is four lines and a call to
# this. They all say REMOVE AFTER 2027-06 and can go together.
#
# They are not merely politeness to old bookmarks. sbin/updatewebui prunes the
# overlay copy of a name this release no longer ships, and pruning UNCOVERS the
# firmware's own older copy underneath -- so on a camera whose image predates
# the rename, /cgi-bin/fw-settings.cgi would answer 200 with the page exactly
# as it was, its links and its behaviour and its old bugs included. A file here
# shadows that; deleting these files does not restore a 404, it restores the
# stale page.
#
# 307 rather than 301, and rather than 302. Not 301 because a 301 a browser has
# cached outlives the file that sent it, and these are meant to be deleted. Not
# 302 because 302 does not carry the method: a POST to an old page URL becomes
# a bodyless GET at the new one, and every page here mutates only on POST -- so
# the form would appear to submit and do nothing. 307 is 302's method-preserving
# twin, equally uncached, and it re-issues the POST with its body at the new
# address, which also leaves the right URL in the bar and the right id on
# <body>. (The two machine endpoints cannot use any redirect: a curl without -L
# follows none of them. They exec instead.)
#
# The query string rides along either way: a stale link is usually a deep one,
# and camera.cgi?tab=nightMode is the shape of every settings bookmark there is.
moved_to() {
	local q=
	[ -n "$QUERY_STRING" ] && q="?$QUERY_STRING"
	echo "HTTP/1.1 307 Temporary Redirect"
	echo "Content-type: text/html; charset=UTF-8"
	echo "Cache-Control: no-store"
	echo "Location: /cgi-bin/${1}${q}"
	echo
	exit 0
}

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

# The bar answers three questions -- which camera am I on, what hardware is
# it, what firmware does it run -- and nothing more; MAC, flash and SoC family
# live on the Dashboard. The stock hostname is <soc>-<sensor>, so each
# hardware word appears only when the hostname does not already say it: a
# renamed camera reads "front-door, hi3516av300, imx415, 2.6.08.29-lite",
# a stock one collapses to "hi3516av300-imx415, 2.6.08.29-lite".
generate_signature() {
	local sig="$network_hostname"
	# Compare lowered copies on both sides -- soc and sensor come from
	# fw_setenv-able variables, so their case is the user's, not ours.
	local lower=$(echo "$network_hostname" | tr 'A-Z' 'a-z')
	local soc_l=$(echo "$soc" | tr 'A-Z' 'a-z')
	local sensor_l=$(echo "$sensor" | tr 'A-Z' 'a-z')
	case "$lower" in *"$soc_l"*) ;; *) sig="$sig, $soc" ;; esac
	[ "$sensor_l" != "unknown" ] && case "$lower" in *"$sensor_l"*) ;; *) sig="$sig, $sensor" ;; esac
	sig="$sig, ${fw_version}-${fw_variant}"
	sig="${sig#, }"
	esc "$sig" > $signature_file
}

signature() {
	[ ! -f "$signature_file" ] && generate_signature
	cat $signature_file
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
	# (#227): it names the method — "gpio" (gpio-motors, pins in ptz_gpio,
	# with the legacy gpio_motors as an alias on both sides), "pelco-d"
	# (btzoom over serial, port/rate in ptz_port and ptz_speed), "pelco-xm"
	# (btzoom-xm, the XiongMai UART protocol — same verbs, same pad,
	# different wire), or "motor" (a motor profile in ptz_profile or the
	# legacy ptz value). An explicit method is trusted but still needs its
	# binary — a pad whose every press fails is worse than no pad. Unset
	# means no PTZ, exactly like "none" (#227): a camera without ptz_control
	# shows no pad, so the old auto-detection from gpio_motors/ptz alone is
	# gone and a field camera configured that way must set ptz_control once.
	# The backend decides which pad p/motor.cgi draws — gpio and motor are
	# stepped eight-way pan/tilt, the Pelco variants are four directions in
	# timed pulses plus zoom and focus.
	ptz_support=""; ptz_backend=""
	ptz_control=$(fw_printenv -n ptz_control 2>/dev/null)
	case "$ptz_control" in
		gpio)
			# The binary AND a pin list: gpio-motors without pins errors on
			# every press, and the pad must not render what cannot work. The
			# binary reads ptz_gpio first and falls back to the legacy name,
			# so either satisfies.
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
		pelco-xm)
			if [ -x /usr/bin/btzoom-xm ]; then
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
		# "none", unset and anything unrecognised all land here: no pad.
	esac

	# ptz_caps declares which axes the hardware actually has, in the same
	# declarative U-Boot family as the rest (#227): fw_setenv ptz_caps
	# 'zoom focus', tokens from pan/tilt/zoom/focus. The 85H50AI-style XM
	# zoom blocks accept pan frames and silently ignore them, and a pad
	# must not render what cannot work. Unknown words are dropped; unset —
	# or nothing recognisable — means full capability for the backend, so
	# no camera configured before this variable changes behaviour.
	ptz_caps=""
	local cap
	for cap in $(fw_printenv -n ptz_caps 2>/dev/null); do
		case "$cap" in
			pan|tilt|zoom|focus) ptz_caps="$ptz_caps $cap" ;;
		esac
	done
	ptz_caps="${ptz_caps# }"

	# Autofocus: the engine lives in majestic (GET /autofocus, #227's board
	# being the first) and exists only when its config enables it; the pad's
	# AF button additionally needs a focus axis to make sense. Cached like
	# the rest so pages don't shell out per request.
	af_support=""
	# A camera that could not be asked keeps the button rather than losing it:
	# withdrawing the control would state, from a failed request, that this
	# hardware does not have the feature. Only an answer saying it is off
	# withdraws it.
	_af=$(mj_cfg isp.autofocus.enabled); _afrc=$?
	_af_on=""
	[ "$_afrc" = 0 ] && [ "$_af" = "true" ] && _af_on=1
	[ "$_afrc" -gt 1 ] && _af_on=1
	if [ -n "$ptz_support" ] && [ -n "$_af_on" ]; then
		case " ${ptz_caps:-focus} " in
			*" focus "*) af_support="1" ;;
		esac
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
		af_support ptz_backend ptz_caps sensor soc soc_family soc_has_temp soc_vendor tz_data tz_name uboot_version ui_password"
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
