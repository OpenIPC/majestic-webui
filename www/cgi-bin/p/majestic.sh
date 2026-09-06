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
