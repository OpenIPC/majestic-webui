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

# mj_cfg <dotted.key> — what the camera is RUNNING on, on stdout.
#
# Exit 0 and a value: the key is set. Non-zero: the key is not set, OR the
# camera could not be asked. Callers that would say something different in
# those two cases must not collapse them — an absent reading is not a fact.
#
# This asks the daemon rather than reading /etc/majestic.yaml, and the
# difference is not stylistic. That file holds only what differs from
# majestic's built-in defaults, so a key sitting at its default is absent from
# it altogether: parsing it returns nothing for a setting the camera is plainly
# running on, and nothing distinguishes that from a setting nobody chose. On
# one lab camera with a fully populated file, seven keys already disagreed —
# among them a configured privacy mask and two motion regions the file did not
# mention.
#
# Loopback is exempt from majestic's auth (is_localaddress), so no credentials
# are needed here and none are sent; the same URL from the network is 401.
#
# -f is what makes the exit status mean anything: without it curl exits 0 on a
# 404 and hands back the error body, so "not set" would arrive looking like a
# value. -m 2 because every caller is inside a request the browser is waiting on.
mj_cfg() {
	curl -sf -m 2 "http://127.0.0.1/api/v1/get?key=$1" 2>/dev/null
}
