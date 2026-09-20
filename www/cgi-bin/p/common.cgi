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
	# while the reason goes to a stderr the service sends nowhere -- on a panel
	# whose whole job is to report. wireguard.cgi's `ip link show wg0` is the
	# case that shows it: on a camera with no tunnel the command fails, and the
	# page had nothing to say about why.
	eval "$1" 2>&1 | sed "s/&/\&amp;/g;s/</\&lt;/g;s/>/\&gt;/g;s/\"/\&quot;/g"
	echo "</pre></div>"
}

# field_hidden "name" "value"
field_hidden() {
	local n="$1"
	local v="$2"
	echo "<input type=\"hidden\" name=\"${n}\" id=\"${n}\" value=\"$(attr_escape "$v")\" class=\"form-hidden\">"
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
		"<input type=\"password\" id=\"${n}\" name=\"${n}\" class=\"form-control\" value=\"$(attr_escape "$v")\">" \
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

# Quote a value so that a shell reading it back gets the value unchanged.
#
# For the two kinds of file this WebUI writes and then SOURCES: the extension
# configs under /etc/webui and the sysinfo cache in /tmp/webui. Both are read
# with `.`, so whatever they contain is shell, and a value that arrives from a
# form goes round the loop a second time on its way back in. Wrapped in double
# quotes -- which is how every one of them used to be written -- a caption
# reading `Motion at the "front door"` truncates at the second quote and hands
# `door` to the shell as a command name, and one containing $(...) or backticks
# runs on every page load, because a sourced file expands those inside double
# quotes (#547).
#
# Single quotes are the only wrapper a shell does not look inside, so the sole
# character needing attention is the single quote itself: close the string,
# emit an escaped one, reopen. The result is what the value was, byte for byte,
# including spaces, globs, backslashes and newlines.
#
# A sed pipeline rather than the substitution esc uses next door, even though
# this costs a fork per key and update_caminfo writes twenty-eight of them.
# ${s//x/y} is not POSIX: busybox ash on the camera takes it, which is why esc
# can, but dash -- /bin/sh on most machines a developer or CI runs this on --
# PARSES it and then fails at run time with "Bad substitution". The lint's
# `sh -n` therefore cannot see the difference, so the one helper whose whole
# job is to get quoting right is the last one that should depend on it.
#
# Streamed, with no $(...) inside it, so that conf_write below can be exact.
# A caller is free to capture it -- `$(shq "$x")` is how the network page
# renders its log line -- but capturing costs every trailing newline the value
# had, so anything writing a file uses conf_write instead.
shq() {
	printf "'"
	printf '%s' "$1" | sed "s/'/'\\\\''/g"
	printf "'"
}

# conf_write "name" "value"
#
# One line of a file that will be sourced: `name='value'`, on stdout, for the
# caller to redirect. This is the only thing that should write into the
# extension configs or the sysinfo cache.
#
# The value never passes through command substitution, and that is the whole
# reason this exists rather than `printf '%s\n' "name=$(shq "$v")"`. POSIX
# command substitution strips EVERY trailing newline from what it captures, so
# the obvious spelling silently rewrites any value that ends in one -- and it
# would do it twice over in the config writers, which used to capture t_value
# on the way in as well. The value is streamed instead: name, equals, opening
# quote, escaped value, closing quote, newline.
#
# printf rather than echo for the same reason throughout. dash's echo acts on
# the backslashes in its argument, so a stored `C:\cams\front` came out as
# `name='C:` -- \c ends echo's output -- leaving a file that will not parse.
# The camera's busybox echo leaves them alone, so this was latent on a camera
# rather than live, but a writer that depends on which echo it got is a writer
# waiting to lose a value.
conf_write() {
	printf '%s=' "$1"
	shq "$2"
	printf '\n'
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
			"<input type=\"text\" id=\"${n}\" name=\"${n}\" class=\"form-control\" value=\"$(attr_escape "$v")\">" \
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
		"<input type=\"text\" id=\"${n}\" name=\"${n}\" class=\"form-control\" value=\"$(attr_escape "$v")\">" \
		"</span></span>"
	[ -n "$h" ] && echo "<span class=\"hint text-secondary\">${h}</span>"
	echo "</p>"
}

# field_textedit "name" "label" "file"
field_textedit() {
	local n="$1"
	local l="$2"
	# The path need not name a readable regular file, and both halves of that
	# matter. editor.cgi passes "$editor_file" straight from GET_f: it is empty
	# until a file is chosen, and it is whatever the query string said
	# otherwise -- a directory included, which editor.cgi logs as not found
	# without stopping the render. `cat` on either writes to a stderr the
	# service sends nowhere, and shows the operator the same empty textarea it
	# shows for a file that is simply absent. So test for a regular file, not
	# merely a readable one: -r alone is true of a directory.
	#
	# And redirect anyway. The test says what this accepts; the redirect covers
	# what it cannot predict -- a regular file that passes -r and still fails to
	# read, /proc/self/mem being the reachable example, since the path is
	# whatever the query string said. Nothing is hidden by it: the operator's
	# answer is the empty textarea either way, and editor.cgi writes the banner
	# that explains why.
	local v=""
	[ -f "$3" ] && [ -r "$3" ] && v=$(cat "$3" 2>/dev/null)
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
# worth asking about; today exactly one destination earns it, restart.cgi.
# Putting it on a link that merely navigates is how the recordings banner came
# within one initAll() timing accident of asking "Are you sure?" before letting
# somebody read a page.
#
# An action that earns it is also written as a form submit rather than an
# anchor, because that confirm() guards one gesture and not a link: a middle
# click delivers `auxclick` and never `click`, and "Open link in new tab"
# delivers nothing, so an acting anchor is followed without the question by two
# things people do to menu items every day (#442). restart.cgi refuses to
# reboot on anything but a POST, which is the half of that pair no markup here
# can get wrong.
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

# The hook messages, in the language of the page that asked.
#
# These sentences reach a person at the one moment something did not work, so
# a page that is Russian throughout must not answer a failed save in English.
# The page sets notify_hooks_lang before calling notify_hooks_sync; anything
# else, or a key with no translation, stays English.
#
# A case rather than one variable per sentence, for the reason pages.cgi gives:
# a table in variables is a table something else can overwrite, and this file
# is sourced into every page's own shell.
hook_say() {
	if [ "$notify_hooks_lang" = ru ]; then
		case "$1" in
		clip_unreadable)
			printf '%s' "Один из файлов настроек уведомлений не читается, поэтому то, что камера запускает по окончании записи, осталось без изменений."
			return ;;
		clip_cannot_ask)
			printf '%s' "Не удалось спросить камеру, что она запускает по окончании записи, поэтому настройка осталась без изменений."
			return ;;
		clip_refused)
			printf '%s' "Камера не приняла настройку отправки записей."
			return ;;
		clip_not_kept)
			printf '%s' "Камера не сохранила настройку отправки записей."
			return ;;
		clip_taken)
			printf '%s' "По окончании записи камера уже запускает свою команду, поэтому её не трогали. Очистите её, чтобы отправлять записи отсюда."
			return ;;
		clip_stop_refused)
			printf '%s' "Камера не смогла прекратить запуск отправки записей."
			return ;;
		motion_unreadable)
			printf '%s' "Один из файлов настроек уведомлений не читается, поэтому то, что камера запускает при начале движения, осталось без изменений."
			return ;;
		motion_no_worker)
			printf '%s' "В этой прошивке нет части, которая отправляет движение с камеры без карты памяти, поэтому отправлять можно только записи."
			return ;;
		motion_taken)
			printf '%s' "При начале движения камера уже запускает свой скрипт, поэтому его не трогали. Удалите ${motion_hook_path}, чтобы отправлять движение отсюда на камере без карты памяти."
			return ;;
		motion_refused)
			printf '%s' "Камера не приняла скрипт, который отправляет движение."
			return ;;
		esac
	fi

	case "$1" in
	clip_unreadable)
		printf '%s' "One of the notification settings files could not be read, so what the camera runs when a recording finishes was left alone." ;;
	clip_cannot_ask)
		printf '%s' "The camera could not be asked what it runs when a recording finishes, so that was left alone." ;;
	clip_refused)
		printf '%s' "The camera would not take the setting that sends recordings." ;;
	clip_not_kept)
		printf '%s' "The camera did not keep the setting that sends recordings." ;;
	clip_taken)
		printf '%s' "The camera already runs a command of its own when a recording finishes, so it was left alone. Clear it to send recordings from here." ;;
	clip_stop_refused)
		printf '%s' "The camera would not stop running the recording sender." ;;
	motion_unreadable)
		printf '%s' "One of the notification settings files could not be read, so what the camera runs when movement starts was left alone." ;;
	motion_no_worker)
		printf '%s' "This firmware does not include the part that sends movement from a camera with no memory card, so only recordings can be sent." ;;
	motion_taken)
		printf '%s' "The camera already runs a script of its own when movement starts, so it was left alone. Remove ${motion_hook_path} to have movement sent from here on a camera with no memory card." ;;
	motion_refused)
		printf '%s' "The camera would not take the script that sends movement." ;;
	esac
}

# Whether anything installed on this camera still wants finished recordings.
#
# Each sender answers for itself, in its own config, and is read in a subshell
# so that the second one cannot see what the first one set.
#
# The same list sbin/motion-notify.sh and sbin/record.sh carry;
# tools/lint-templates.sh fails the build when the three disagree. A name
# missing HERE is the expensive one: this predicate gates both hook syncs, and
# answering "nobody wants clips" does not merely skip wiring -- it clears the
# camera's finished-recording hook and removes the movement one. A camera with
# only the missing sender switched on would quietly unwire itself.
#
# Names only, and no executable test: a sender switched on in a build that does
# not ship it still wires the hooks, exactly as before, and record.sh passes
# over it at the moment it would have run.
# Three answers, not two: wanted (0), nobody wants it (1), and a config that
# could not be read (2).
#
# The third exists because of what the callers do with a no. "Nobody wants
# clips" is not a shrug here -- it is authority to clear the camera's
# finished-recording setting and delete the movement hook. A config file that
# will not parse must not buy that authority: it is not a sender declining, it
# is a question that could not be asked, and answering it as a decline would
# unwire a camera on the strength of a typo in an unrelated file. Same rule as
# mj_cfg next door, and the same one sbin/record.sh keeps for the same read.
#
# A sourced file that will not parse leaves 2 behind, which is what makes the
# three cases separable at all; a file that parses and declines leaves 1.
clip_hook_wanted() {
	_ch_unsure=0

	for _ch_name in telegram ntfy max; do
		[ -e "/etc/webui/${_ch_name}.conf" ] || continue
		(
			. "/etc/webui/${_ch_name}.conf"
			eval "[ \"\$${_ch_name}_enabled\" = true ] &&
				[ \"\$${_ch_name}_clips\" = true ]"
		)
		case $? in
		0) return 0 ;;
		1) ;;
		*) _ch_unsure=1 ;;
		esac
	done

	[ "$_ch_unsure" = 1 ] && return 2

	return 1
}

# Keep the camera's own setting in step with those answers.
#
# The camera runs one command when a recording finishes, and it is not ours to
# take: an operator who has pointed it at a script of their own gets to keep
# it, and is told rather than overruled. So this only ever writes the
# dispatcher over an EMPTY setting, and only ever clears the dispatcher --
# never anything else that happens to be there.
#
# Returns non-zero when the camera was not left in the state the page asked
# for, with the sentence to show in $clip_hook_msg. The caller decides what to
# say, because its own redirect would otherwise overwrite anything written to
# the flash log here.
#
# Called after the config file is written, because the answer is read back out
# of it.
clip_hook_sync() {
	clip_hook_msg=""
	_ch_hook=/usr/sbin/record.sh
	_ch_now=$(mj_cfg records.onClose)

	# Three answers, kept apart. Collapsing "not set" and "could not ask"
	# would let a failed request -- a camera mid-restart, a build without the
	# setting -- read as an empty one, and the empty branch below WRITES.
	case $? in
	0) ;;
	1) _ch_now="" ;;
	*)
		clip_hook_msg=$(hook_say clip_cannot_ask)
		return 1
		;;
	esac

	clip_hook_wanted
	_ch_want=$?

	# A config that could not be read is not a decline, so nothing is torn
	# down on the strength of it. Said out loud rather than passed over: the
	# operator has a file the camera cannot read, and the recording sender is
	# left exactly as it was until they fix it.
	if [ "$_ch_want" = 2 ]; then
		clip_hook_msg=$(hook_say clip_unreadable)
		return 1
	fi

	if [ "$_ch_want" = 0 ]; then
		case "$_ch_now" in
		"$_ch_hook") ;;
		"")
			if ! mj_set records.onClose "$_ch_hook"; then
				clip_hook_msg=$(hook_say clip_refused)
				return 1
			fi
			# Read back rather than trusting the answer: this API can accept
			# a write and keep nothing, and a page that reported success on
			# the strength of the status code would say the opposite of what
			# the camera is doing.
			if [ "$(mj_cfg records.onClose)" != "$_ch_hook" ]; then
				clip_hook_msg=$(hook_say clip_not_kept)
				return 1
			fi
			;;
		*)
			clip_hook_msg=$(hook_say clip_taken)
			return 1
			;;
		esac
	elif [ "$_ch_now" = "$_ch_hook" ]; then
		if ! mj_clear records.onClose; then
			clip_hook_msg=$(hook_say clip_stop_refused)
			return 1
		fi
	fi

	return 0
}

# The other half of the answer above: what the camera runs when movement
# STARTS, rather than when a recording finishes.
#
# It exists because the clip hook cannot cover a camera with no memory card.
# With nowhere to record there is no recorder, so no clip is ever finished and
# records.onClose never fires -- and "send me something when it moves" is
# exactly what such a camera's owner asked for. /usr/sbin/motion-notify.sh
# records a few seconds as it sends them, which needs no card at all, and
# stands aside on its own whenever the recorder is set to record on movement.
#
# There is NO configuration key for this one. majestic runs /usr/sbin/motion.sh
# if that file is there and executable, so wiring it means writing the file --
# and the same rule holds as for the clip hook: an operator who has put a
# script of their own there keeps it and is told, rather than being overruled.
# This only ever writes a file that is absent, and only ever removes one it
# wrote itself, which is what the marker line is for.
#
# It is wired whenever either page wants movement sent, including on a camera
# that has a card today: the script decides at the moment of the event, so
# pulling the card later leaves the setting working instead of silently
# stopping.
motion_hook_path=/usr/sbin/motion.sh
motion_hook_worker=/usr/sbin/motion-notify.sh
motion_hook_mark="# written by the OpenIPC WebUI notification pages"

motion_hook_sync() {
	motion_hook_msg=""

	clip_hook_wanted
	_mh_want=$?

	# As above: a config that could not be read is not permission to remove
	# somebody's movement hook.
	if [ "$_mh_want" = 2 ]; then
		motion_hook_msg=$(hook_say motion_unreadable)
		return 1
	fi

	if [ "$_mh_want" = 0 ]; then
		# Saying nothing here would be the page confirming a setting whose
		# other half cannot run: on a build that ships no sender the whole
		# card-less path is missing, and the operator would be told their
		# settings were saved with movement quietly going nowhere.
		if [ ! -x "$motion_hook_worker" ]; then
			motion_hook_msg=$(hook_say motion_no_worker)
			return 1
		fi

		if [ -e "$motion_hook_path" ]; then
			if grep -qF "$motion_hook_mark" "$motion_hook_path" 2>/dev/null; then
				return 0
			fi
			motion_hook_msg=$(hook_say motion_taken)
			return 1
		fi

		cat > "$motion_hook_path" <<-HOOK
			#!/bin/sh
			${motion_hook_mark}
			#
			# Delete this file to stop movement being sent, or replace it with
			# a script of your own -- nothing here will overwrite one.
			exec ${motion_hook_worker} "\$@"
		HOOK
		# Written, then checked: a full flash writes a truncated file without
		# saying so, and a hook the camera cannot execute is one it silently
		# never runs. Both leave the operator told it worked.
		if [ ! -s "$motion_hook_path" ] || ! chmod 0755 "$motion_hook_path" ||
			[ ! -x "$motion_hook_path" ]; then
			rm -f "$motion_hook_path"
			motion_hook_msg=$(hook_say motion_refused)
			return 1
		fi
		return 0
	fi

	if [ -e "$motion_hook_path" ] &&
		grep -qF "$motion_hook_mark" "$motion_hook_path" 2>/dev/null; then
		rm -f "$motion_hook_path"
	fi

	return 0
}

# Both hooks, and one sentence for whatever did not happen. The pages call this
# rather than the two separately, so that a page can never report one of them
# as the whole answer.
notify_hooks_sync() {
	notify_hooks_msg=""

	clip_hook_sync || notify_hooks_msg="$clip_hook_msg"
	motion_hook_sync ||
		notify_hooks_msg="${notify_hooks_msg}${notify_hooks_msg:+ }${motion_hook_msg}"

	[ -z "$notify_hooks_msg" ]
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

# The value of the variable named by $1 -- how the field_* helpers read the
# value they are about to render out of the environment.
#
# printf into an escaped pair of double quotes, not `echo $var`. Unquoted, the
# expansion is word-split and globbed before echo ever sees it, so a stored
# password of `p@ss  word` came back with one space and one of `*` came back as
# a listing of the current directory. And echo would eat a leading -n or act on
# a backslash. Neither can happen to a quoted printf '%s' (#547).
t_value() {
	eval "printf '%s' \"\$${1}\""
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
	# Which majestic answered the questions below, and which RUN of it. Neither
	# is shown anywhere — together they are what lets the next page load tell a
	# cached answer from a stale one; see caminfo_stale. Both empty when the
	# daemon is not running, which is its own fact and is read as one.
	mj_pid=$(pidof majestic 2>/dev/null)
	mj_pid=${mj_pid%% *}
	mj_started=""
	[ -n "$mj_pid" ] && read_starttime "$mj_pid" && mj_started=$mj_started_now

	# WebUI
	ui_password=$(grep root /etc/shadow | cut -d: -f2)
	# The deployed WebUI's own version, shown on the Dashboard the way majestic's
	# is. What updatewebui recorded wins over the image's own stamp: an install
	# hides the image's www/.version without replacing it, so that file still
	# reads as the firmware's version after a newer WebUI was laid over it. Empty
	# on an image too old to carry either, which the Dashboard renders "unknown".
	if [ -s /etc/webui/webui.version ]; then
		webui_version=$(cat /etc/webui/webui.version)
	elif [ -s /var/www/.version ]; then
		webui_version=$(cat /var/www/.version)
	else
		webui_version=""
	fi
	# This value is cached into the shell-sourced sysinfo file and shown on the
	# Dashboard; keep it to characters that cannot break out of either. It is a
	# version string, so a printable subset loses nothing real. Testing -s above
	# (not -f) means a truncated or empty stamp falls through rather than winning.
	webui_version=$(printf '%s' "$webui_version" | tr -cd 'A-Za-z0-9 .,:+/@()_-')
	# PTZ preview controls. The switch is the U-Boot ptz_control variable
	# (#227): it names the method — "gpio" (gpio-motors, pins in ptz_gpio,
	# with the legacy gpio_motors as an alias on both sides), "pelco-d"
	# (Pelco-D over serial, port/rate in ptz_port and ptz_speed), "pelco-xm"
	# (the XiongMai UART protocol — same verbs, same pad, different wire),
	# or "motor" (a motor profile in ptz_profile or the legacy ptz value).
	# An explicit method is trusted but still needs something that can
	# actually drive it — a pad whose every press fails is worse than no
	# pad. For the two Pelco wires that something is majestic, which owns
	# the port; the WebUI shipped its own btzoom/btzoom-xm scripts for it
	# until they were removed for racing the daemon on the same tty. Unset
	# means no PTZ, exactly like "none" (#227): a camera without ptz_control
	# shows no pad, so the old auto-detection from gpio_motors/ptz alone is
	# gone and a field camera configured that way must set ptz_control once.
	# The backend decides which pad p/motor.cgi draws — gpio and motor are
	# stepped eight-way pan/tilt, the Pelco variants are four directions in
	# timed pulses plus zoom and focus.
	ptz_support=""; ptz_backend=""; ptz_reason=""
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
		pelco-d|pelco-xm)
			# Ask the daemon whether it can drive this wire. Its answers are
			# kept apart the way af_support keeps them apart: a camera that
			# could not be asked keeps its pad and lets a press report its
			# own failure, and only a camera that answered "no motorized
			# lens" has the pad withdrawn.
			#
			# A missing driver (3) is NOT that answer. The lens is declared
			# and the operator has one thing to do about it, so the pad
			# renders and carries the reason: withdrawing it here would say
			# "this camera has no PTZ", which is the confusion this endpoint
			# exists to end, and would put the explanation j/ptz.cgi
			# prepares somewhere nothing can reach.
			mj_ptz > /dev/null 2>&1
			case $? in
				0|2) ptz_support="1"; ptz_backend="pelco" ;;
				3)
					ptz_support="1"; ptz_backend="pelco"
					ptz_reason="This camera has no PTZ driver installed: add the majestic-af package to its firmware."
					;;
			esac
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

	# Autofocus has NO cached flag here, deliberately, and this comment is the
	# tombstone of the one that used to be.
	#
	# `af_support` combined two facts with very different lifetimes: whether
	# this board has a motor and a focus axis (U-Boot, effectively permanent)
	# and whether majestic's engine is switched on (isp.autofocus.enabled,
	# changed from the settings page whenever anybody likes). The whole file is
	# invalidated by caminfo_stale(), which compares majestic's pid and start
	# time -- and saving a config key is a SIGHUP reload, not a restart, so the
	# pid never moves. Turning "Motorized lens" on therefore did nothing
	# visible until majestic was restarted for some unrelated reason, and there
	# is no server-side hook that could fix it: Save goes from the browser
	# straight to /api/v1/config with no CGI anywhere in the path.
	#
	# So the slow half stays cached ($ptz_support, $ptz_caps, both derived from
	# U-Boot above) and p/motor.cgi draws the control on those. The fast half is
	# majestic's own configuration, and the browser asks majestic for it --
	# preview-ptz.js probes GET /autofocus/status at mount, which 404s when the
	# engine is off. That is the standing rule stated as a fix: config comes
	# from the daemon, and a second copy needs an invalidation rule that has a
	# witness at the event. This one never had one.

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

	local variables="flash_size flash_type fw_build fw_variant fw_version mj_pid mj_started mj_version network_address
		network_gateway network_hostname network_interface network_macaddr overlay_root ptz_support
		ptz_backend ptz_caps ptz_reason sensor soc soc_family soc_has_temp soc_vendor tz_data tz_name uboot_version ui_password webui_version"
	rm -f ${sysinfo_file}

	# Through shq, because this file is SOURCED on every request and several of
	# these values come off the device or out of a form. The line this replaced
	# wrapped each one in single quotes and escaped nothing in it, so a camera
	# named with an apostrophe wrote
	#
	#     network_hostname='cam'apos'
	#
	# and every page in the WebUI answered 500 from then on -- the file no longer
	# parsed, and common.cgi sources it before it can render anything, so there
	# was no page left to say so and no way back but SSH. The network form used
	# to refuse such a name by accident, its own quoting being broken in a way
	# that rejected the apostrophe before it reached /etc/hostname; fixing that
	# is what made this reachable (#547).
	#
	# The assignment is the escaped `\$${v}` form on purpose: an assignment's
	# right-hand side is not word-split or globbed, so the value arrives whole.
	local v val
	for v in $variables; do
		eval "val=\$${v}"
		conf_write "$v" "$val" >> ${sysinfo_file}
	done

	generate_signature
}

mj_bin_file=/usr/bin/majestic
log_file=/tmp/webui/logfile.txt
signature_file=/tmp/webui/signature.txt
sysinfo_file=/tmp/webui/sysinfo.txt

[ ! -d /etc/webui ] && mkdir -p /etc/webui
[ ! -d /tmp/webui ] && mkdir -p /tmp/webui

# Some of what update_caminfo caches is not a fact about the camera but an
# answer the daemon gave -- mj_version, and the whole PTZ/autofocus verdict,
# which asks majestic whether it can drive the motor wire. Those are good for
# exactly as long as the majestic instance that gave them, and nothing said so.
#
# The cache lives in /tmp, so a reboot cleared it, and that covered the only
# case anyone hit -- until it didn't: install the motor driver package on a
# running camera, restart majestic, and the Live page went on telling the
# operator to install the package they had just installed. The answer was
# minutes old and from a process that no longer existed. There is no hook to
# invalidate it from either, the way a save on this page has one: what changed
# is outside the WebUI entirely, so the cache has to notice by itself.
#
# It has to notice for free. Measured on an hi3516ev300, a page load reusing
# the cache is ~100ms and one that rebuilds it is ~500ms, which is the whole
# reason the cache exists -- so a check that forks `pidof` (10ms) would spend a
# tenth of the saving on every page of the UI. The recorded identity turns it
# into builtins, and the loop below runs in the noise of an empty one.

# The task's start time, in jiffies since boot: field 22 of /proc/<pid>/stat.
# This is what makes a pid an identity rather than a number -- pids are unique
# only while their process lives, so a name alone would accept a later majestic
# that happened to land on the same one. Monotonic, so unlike a file mtime it
# is also indifferent to the clock being stepped.
#
# Sets a variable rather than echoing one: a command substitution would fork,
# and not forking is the entire point of this path.
read_starttime() {
	mj_started_now=""
	local line=""
	# Read before the set -- below, which takes $1 away.
	# Grouped, because ash reports an unopenable redirection itself and does it
	# before the command's own 2> can catch it: a pid that has since exited
	# would otherwise write "can't open" to the httpd's log on every page.
	{ read line < "/proc/$1/stat"; } 2>/dev/null
	[ -n "$line" ] || return 1
	# -f for just this expansion, and restored right after: field 2 is the
	# command name in parentheses, and a glob character in it would otherwise
	# be matched against the working directory. Callers check the name first,
	# so it cannot happen from here -- but the guard is one word and the next
	# caller may not.
	set -f
	set -- $line
	set +f
	mj_started_now=${22}
	[ -n "$mj_started_now" ]
}

caminfo_stale() {
	# The path every page takes.
	if [ -n "$mj_pid" ] && [ -n "$mj_started" ]; then
		local comm=""
		# Same grouping, same reason as above. An unreadable comm leaves it
		# empty, which is the same answer as a wrong one. Checked before the
		# start time because it is what makes the field split below safe.
		{ read comm < "/proc/$mj_pid/comm"; } 2>/dev/null
		[ "$comm" = "majestic" ] || return 0
		read_starttime "$mj_pid" || return 0
		[ "$mj_started_now" = "$mj_started" ] && return 1
		return 0
	fi
	# Nothing recorded: a cache written before this existed, or written while
	# majestic was down. Worth one fork to find out -- and only one, because
	# a daemon that is still down leaves the record alone rather than paying
	# 400ms on every page of the UI somebody is using to go and fix it.
	pidof majestic >/dev/null 2>&1
}

include $sysinfo_file
if [ ! -f $sysinfo_file ] || caminfo_stale; then
	update_caminfo
fi
include $sysinfo_file

pagename=$(basename "$SCRIPT_NAME")
pagename="${pagename%%.*}"

include /etc/webui/webui.conf

check_password
%>
