#!/bin/sh
# Reading majestic's configuration from a shell.
#
# Sourced, never executed — which is why this is not a .cgi: tools/build-dist.sh
# chmods every *.cgi to 0755 for the httpd to exec, and nothing here should be
# reachable as a URL. The #!/bin/sh is for tools/lint-templates.sh, which picks
# scripts to syntax-check by their shebang.
#
# The j/*.cgi endpoints source nothing and p/common.cgi is a haserl template
# that plain sh cannot source, so the one thing they share has to live in a file
# of its own. Reach it relative to the running script, never through a hardcoded
# document root:
#
#     . "$(dirname "$0")/../p/majestic.sh"

# mj_cfg <dotted.key> -- what the camera is RUNNING on, on stdout.
#
# Three answers, because two is not enough:
#
#   0  the key is set; its value is on stdout
#   1  majestic answered, and the key is not set
#   2  majestic could not be asked
#
# Collapsing 1 and 2 is the mistake this exists to prevent. A caller that
# cannot tell them apart turns a failed request into a fact about the camera --
# "autofocus is not available on this camera" when nothing asked it, or "the
# camera could not be asked where recordings live" when it answered perfectly
# well and the key is simply unset. An absent reading is not a fact and a
# failed fetch is not an absence.
#
# This asks the daemon rather than reading /etc/majestic.yaml, and the
# difference is not stylistic. That file holds only what differs from
# majestic's built-in defaults, so a key sitting at its default is absent from
# it altogether: parsing it returns nothing for a setting the camera is plainly
# running on. Measured on an hi3516ev300 with a fully populated file, seven
# keys already disagreed -- a configured privacy mask and two motion regions
# among them.
#
# No credentials are sent and none are needed: majestic waves through requests
# that originate on the camera itself. The same URL from the network is 401,
# which is what makes this safe to call without one.
#
# -m 2 because every caller is inside a request a browser is waiting on.
mj_cfg() {
	# The body and the status code in one round trip. The code goes last and
	# is split off from the right, so a value containing the separator -- an
	# OSD template can contain anything -- still comes back whole.
	_mj_r=$(curl -s -m 2 -w '|%{http_code}' \
		"http://127.0.0.1/api/v1/get?key=$1" 2>/dev/null) || return 2
	_mj_code=${_mj_r##*|}
	case "$_mj_code" in
		200) ;;
		404) return 1 ;;
		# Anything else is the daemon refusing or failing, not an answer about
		# the key: 401 from a build without the endpoint's auth exemption, 400,
		# 500, or an empty reply from a curl that connected and got nothing.
		*) return 2 ;;
	esac
	printf '%s' "${_mj_r%|*}"
}

# Drive the motor, or ask what this camera's motor can do.
#
# The camera owns the PTZ serial port, so the WebUI asks it for a verb instead
# of opening that port itself. It used to open it: bin/btzoom and bin/btzoom-xm
# wrote Pelco frames to the same tty the camera was already driving for
# autofocus, sharing it through a lock directory. That could never work -- a
# Pelco movement is three steps (drive, wait, stop) and a lock cannot make them
# atomic against another process. What an operator saw, measured on an
# hi3516ev300: button presses that did nothing at all for seconds at a time,
# and focus adjustments that undid themselves about ten seconds after the
# finger came off.
#
#   mj_ptz <verb>   start or continue a move; the camera stops the motor on
#                   its own deadline, so a lost release cannot run a lens into
#                   its end stop. POST, because it changes the world -- a GET
#                   is what a browser issues on its own, and it carries the
#                   session with it.
#   mj_ptz          the capability line (actuator, port, speed, pulse, verbs),
#                   a plain GET: reading what the lens can do is safe.
#
# Return codes, kept apart the way mj_cfg keeps them apart -- "could not ask"
# must never reach the operator as a statement about their hardware:
#   0  answered; the reply is on stdout
#   1  this camera declares no motorized lens (404)
#   3  it does, but the motor driver is not on this build (503)
#   2  could not ask
mj_ptz() {
	if [ -n "$1" ]; then
		_mj_r=$(curl -s -m 3 -X POST -w '|%{http_code}' \
			"http://127.0.0.1/ptz?move=$1" 2>/dev/null) || return 2
	else
		_mj_r=$(curl -s -m 3 -w '|%{http_code}' \
			"http://127.0.0.1/ptz" 2>/dev/null) || return 2
	fi
	_mj_code=${_mj_r##*|}
	case "$_mj_code" in
		200) ;;
		404) return 1 ;;
		503) return 3 ;;
		*) return 2 ;;
	esac
	printf '%s' "${_mj_r%|*}"
}

# mj_set <dotted.key> <value> -- write one key through majestic's own API.
#
# The nested body is built from the dotted path, because that shape is the
# literal input of the config walker: records.onClose goes out as
# {"records":{"onClose":"…"}}. Writing it any other way would mean opening
# /etc/majestic.yaml, which is majestic's file and holds only what differs
# from its defaults.
#
# Same three answers as mj_cfg, and for the same reason -- a write that never
# reached the camera must not be reported as one that did:
#
#   0  the camera took it
#   1  the camera refused it (4xx)
#   2  the camera could not be asked
mj_set() {
	_mj_val=$(printf '%s' "$2" | sed 's/\\/\\\\/g; s/"/\\"/g')
	_mj_body="\"${_mj_val}\""
	_mj_path=$1
	while [ -n "$_mj_path" ]; do
		_mj_body="{\"${_mj_path##*.}\":${_mj_body}}"
		case "$_mj_path" in
		*.*) _mj_path=${_mj_path%.*} ;;
		*) _mj_path= ;;
		esac
	done

	_mj_r=$(curl -s -m 3 -w '|%{http_code}' -X POST \
		-H 'Content-Type: application/json' -d "$_mj_body" \
		"http://127.0.0.1/api/v1/config" 2>/dev/null) || return 2
	case "${_mj_r##*|}" in
	200 | 202) return 0 ;;
	4*) return 1 ;;
	*) return 2 ;;
	esac
}
