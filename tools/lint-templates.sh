#!/bin/sh
# Validate the haserl CGI templates under www/cgi-bin.
#
# Run from CI (.github/workflows/check.yml); also fine by hand. Needs haserl on
# PATH — Ubuntu ships it in universe, so `apt-get install haserl` is enough.
#
# Do NOT try to run this on a camera. OpenIPC's musl/mips haserl build throws a
# bare "Exception." on every command-line invocation — even a one-line template
# with no tags — while working perfectly when majestic execs it as a CGI. An
# upstream 0.9.36 built on x86 has no such problem, so it is a buildroot
# artifact rather than a haserl bug, but it does mean on-device linting is out.
#
# Runs from www/cgi-bin because <%in %> resolves relative to the CURRENT
# WORKING DIRECTORY, not to the including file — undocumented in the manpage,
# and the reason every page 404s its include if you invoke haserl from the repo
# root. majestic execs the CGIs with that same cwd, so this matches production.
#
# Both of these are checked rather than assumed: this is a gate, and a gate that
# cannot run has to say so instead of reaching the "templates ok" line. An
# unguarded cd would silently lint the wrong directory (or none), and an
# unguarded mktemp would drop every finding on the floor.
DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../www/cgi-bin" && pwd) || exit 1
cd "$DIR" || exit 1

FAILS=$(mktemp) || exit 1
trap 'rm -f "$FAILS"' EXIT

# --- 1. syntax --------------------------------------------------------------
# Shell constructs legally span <% %> blocks here: status.cgi opens `if ...;
# then` in one block and closes it with `<% fi %>` after several lines of HTML.
# So the blocks cannot be checked in isolation — anything that lints them
# independently sees an unterminated `if` in every one. Let haserl do the
# codegen instead (it also resolves the <%in p/common.cgi %> includes) and
# syntax check what it actually produces.
#
# haserl and the shell fail INDEPENDENTLY and both have to be tested. A bad tag
# makes haserl exit non-zero while printing "Missing %> near line N" on stdout,
# so the obvious `haserl -d "$f" | sh -n` discards that status and then hands
# the message to the shell, which finds it a perfectly valid command — leaving a
# broken template reported as clean. Hence capturing the codegen first.
find . -name '*.cgi' | sed 's|^\./||' | sort | while IFS= read -r f; do
	head -1 "$f" | grep -q haserl || continue
	if ! out=$(haserl -d "$f" < /dev/null 2>&1); then
		printf '%s: haserl: %s\n' "$f" "$(printf '%s' "$out" | tail -1)" >> "$FAILS"
		continue
	fi
	if ! err=$(printf '%s\n' "$out" | sh -n 2>&1); then
		printf '%s: %s\n' "$f" "$err" >> "$FAILS"
	fi
done

# --- 2. escaping ------------------------------------------------------------
# CLAUDE.md: "Never <%= $userInput %> for anything that came from POST_/GET_."
# <%= %> is sugar for echo, so request data goes to the page verbatim — an
# unescaped one is stored XSS, not a style nit. p/common.cgi provides ex and pre
# for this; they belong in a plain <% %> block, as in <% ex "$POST_x" %>.
#
# grep exits 0 for a match, 1 for a clean run and 2+ for an error. `if
# hits=$(grep ...)` conflates 1 and 2, so a grep that failed outright would look
# exactly like "no violations" and the script would still print templates ok —
# the guard silently disabling itself is the one outcome worse than not having
# it. -r and --include are GNU extensions (CLAUDE.md rules them out), so the
# file list comes from find; globbing is off because it is expanded unquoted.
set -f
set -- $(find . -name '*.cgi' | sort)
set +f
hits=$(grep -nE '<%=[^%]*\$\{?(POST|GET)_' /dev/null "$@")
case $? in
0)
	printf '%s\n' "$hits" >> "$FAILS"
	echo "^ request data rendered unescaped via <%= — use ex or pre (p/common.cgi)" >> "$FAILS"
	;;
1) ;;
*) echo "lint: grep failed, escaping guard did not run" >> "$FAILS" ;;
esac

if [ -s "$FAILS" ]; then
	cat "$FAILS"
	exit 1
fi
echo "templates ok"
