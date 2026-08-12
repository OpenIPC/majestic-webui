#!/bin/sh
# Validate the haserl CGI templates under www/cgi-bin, plus the ordinary shell
# scripts under www/ and sbin/.
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
# The cd and the mktemp below are checked rather than assumed: this is a gate,
# and a gate that cannot run has to say so instead of reaching the success
# line. An unguarded cd would silently lint the wrong tree, or none at all,
# and an unguarded mktemp would drop every finding on the floor.
ROOT=$(CDPATH= cd "$(dirname "$0")/.." && pwd) || exit 1
cd "$ROOT" || exit 1

# POSIX `read` rather than `head -1 | grep`: head's -1 form is obsolescent (POSIX
# spells it -n 1) and the pipeline forked twice per file across the whole tree.
# Returning non-zero for an unreadable file matters — the old `|| continue` let
# one drop silently out of the run, which is the same class of hole as the
# guards above.
first_line() {
	[ -r "$1" ] || return 1
	IFS= read -r first_line < "$1" || first_line=''
	return 0
}

FAILS=$(mktemp) || exit 1
# What actually got inspected, so the summary can report real counts. A gate
# that checked nothing should not be indistinguishable from a gate that passed.
SEEN=$(mktemp) || exit 1
trap 'rm -f "$FAILS" "$SEEN"' EXIT

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
#
# The subshell is because <%in %> resolves relative to the CURRENT WORKING
# DIRECTORY rather than to the including file — undocumented in the manpage, and
# the reason every page fails to find its include if haserl is invoked from the
# repo root. majestic execs the CGIs with this same cwd, so it matches
# production.
#
# The subshell's status is checked for the same reason as the cd above: `cd ...
# || exit 1` inside it only leaves the subshell, so on its own it would skip
# every template while the script carried on to report success.
if ! (
	cd www/cgi-bin || exit 1
	find . -name '*.cgi' | sed 's|^\./||' | sort | while IFS= read -r f; do
		if ! first_line "$f"; then
			printf 'www/cgi-bin/%s: cannot read\n' "$f" >> "$FAILS"
			continue
		fi
		case $first_line in *haserl*) ;; *) continue ;; esac
		echo "t" >> "$SEEN"
		if ! out=$(haserl -d "$f" < /dev/null 2>&1); then
			printf 'www/cgi-bin/%s: haserl: %s\n' "$f" "$(printf '%s' "$out" | tail -1)" >> "$FAILS"
			continue
		fi
		if ! err=$(printf '%s\n' "$out" | sh -n 2>&1); then
			printf 'www/cgi-bin/%s: %s\n' "$f" "$err" >> "$FAILS"
		fi
	done
	exit 0
); then
	echo "lint: could not enter www/cgi-bin, templates unchecked" >> "$FAILS"
fi

# --- 2. escaping ------------------------------------------------------------
# CLAUDE.md: "Never <%= $userInput %> for anything that came from POST_/GET_."
# <%= %> is sugar for echo, so request data goes to the page verbatim — an
# unescaped one is stored XSS, not a style nit. p/common.cgi provides ex and pre
# for this; they belong in a plain <% %> block, as in <% ex "$POST_x" %>.
#
# grep exits 0 for a match, 1 for a clean run and 2+ for an error. `if
# hits=$(grep ...)` conflates 1 and 2, so a grep that failed outright would look
# exactly like "no violations" and the script would still report success —
# the guard silently disabling itself is the one outcome worse than not having
# it. -r and --include are GNU extensions (CLAUDE.md rules them out), so the
# file list comes from find; globbing is off because it is expanded unquoted.
set -f
set -- $(find www/cgi-bin -name '*.cgi' | sort)
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

# --- 3. plain shell ---------------------------------------------------------
# Everything that is not a template: the j/*.cgi JSON endpoints and the sbin
# helpers. Worth checking because nothing else does — sbin/setnetwork writes
# /etc/network/interfaces.d and sbin/updatewebui is the deploy path, so a syntax
# error in either misconfigures or bricks the camera it runs on.
#
# Selection is by shebang. That is why j/locale.cgi does not carry one: it is a
# data file parsed with sed (mj-settings.cgi), never sourced or executed, and
# `mj_cloud=Cloud (WebRTC)` is not valid shell. Quoting that value would not
# help — the sed captures \(.*\) straight into JSON, so the quotes would end up
# inside the label.
find www sbin -type f 2>/dev/null | sort | while IFS= read -r s; do
	if ! first_line "$s"; then
		printf '%s: cannot read\n' "$s" >> "$FAILS"
		continue
	fi
	case $first_line in
	'#!'*/sh|'#!'*/ash|'#!'*/dash) ;;
	*) continue ;;
	esac
	echo "s" >> "$SEEN"
	if ! err=$(sh -n "$s" 2>&1); then
		printf '%s: %s\n' "$s" "$err" >> "$FAILS"
	fi
done

ntpl=$(grep -c '^t$' "$SEEN")
nsh=$(grep -c '^s$' "$SEEN")

# Nothing to check is a broken selector, not a clean tree — the repo always has
# both kinds of file. Without this, a find or shebang test that stopped matching
# would report a confident pass over zero files.
[ "$ntpl" -gt 0 ] || echo "lint: no haserl templates matched, selection is broken" >> "$FAILS"
[ "$nsh" -gt 0 ] || echo "lint: no shell scripts matched, selection is broken" >> "$FAILS"

if [ -s "$FAILS" ]; then
	cat "$FAILS"
	exit 1
fi
echo "ok: $ntpl haserl templates, $nsh shell scripts"
