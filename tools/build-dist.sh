#!/bin/sh
# Build the minified distribution tarball that the firmware buildroot package fetches.
#
# The source in git stays pristine and readable; this produces
# majestic-webui-dist.tar.gz with the hand-written JS/CSS minified (the already-minified
# vendored libs and the purged bootstrap.min.css pass through untouched). Run from CI
# (.github/workflows/dist.yml) after `npm ci`, which provides terser + clean-css.
#
# The tarball has a single top-level majestic-webui/ directory holding exactly what the
# buildroot package installs (sbin, bin, www, LICENSE), so buildroot's default
# --strip-components=1 lands the payload where the package's INSTALL expects it.
set -e
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

BIN="$PWD/node_modules/.bin"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
PKG="$OUT/majestic-webui"
mkdir -p "$PKG"

# payload the buildroot package installs
cp -r www LICENSE "$PKG"/
[ -d sbin ] && cp -r sbin "$PKG"/ || true
[ -d bin ]  && cp -r bin  "$PKG"/ || true

# Stamp the tree with its own version, so the Dashboard can show which WebUI is
# deployed the way it shows majestic's -- there is otherwise nothing on the
# camera that records it, and a reporter running an install cannot say which
# build they are on. Best-effort: a build with no git checkout (buildroot
# unpacking a release tarball) ships no stamp, and the Dashboard says "unknown"
# rather than a wrong answer. Format mirrors majestic's -v: `<ref>+<sha>, <date>`.
if git -C "$PWD" rev-parse --git-dir >/dev/null 2>&1; then
	sha=$(git -C "$PWD" rev-parse --short HEAD 2>/dev/null)
	when=$(git -C "$PWD" show -s --format=%cd --date=format:'%Y-%m-%d %H:%M' HEAD 2>/dev/null)
	ref=${GITHUB_REF_NAME:-$(git -C "$PWD" rev-parse --abbrev-ref HEAD 2>/dev/null)}
	# The payload above is copied from the working tree, not from HEAD, so a
	# tree with uncommitted or untracked changes to what ships must not
	# advertise a clean commit. Judge only the paths that go into the package.
	[ -n "$(git -C "$PWD" status --porcelain -- www sbin bin LICENSE 2>/dev/null)" ] && dirty="-dirty" || dirty=""
	case $ref in '' | HEAD) stamp="$sha$dirty" ;; *) stamp="$ref+$sha$dirty" ;; esac
	[ -n "$when" ] && stamp="$stamp, $when"
	[ -n "$stamp" ] && printf '%s\n' "$stamp" >"$PKG/www/.version"
fi

# CGIs are exec'd directly by majestic, so a non-executable one 500s the page.
# Guarantee the exec bit here even if a file was committed without it (a recurring
# slip) — defence in depth on top of the repo's own modes. Same for sbin helpers.
find "$PKG/www" -name '*.cgi' -exec chmod 0755 {} +
[ -d "$PKG/sbin" ] && chmod 0755 "$PKG"/sbin/* 2>/dev/null || true

# minify hand-written JS (skip already-minified vendored libs); fail loudly if a
# minified file is ever not valid JS.
find "$PKG/www" -name '*.js' ! -name '*.min.js' | while IFS= read -r f; do
	# .js suffix on the temp so `node --check` recognises it as a script
	# comments=false, not the CLI default: terser's default is "some", which
	# keeps /*! and @license banners. No hand-written .js here carries one and
	# no vendored .min.js exists to need one, so the default only leaves a way
	# for a comment to reach a camera unnoticed.
	"$BIN/terser" "$f" --compress --mangle --format comments=false -o "$f.tmp.js"
	node --check "$f.tmp.js"
	mv "$f.tmp.js" "$f"
done

# minify hand-written CSS (skip vendored .min.css and the already-purged bootstrap.min.css)
find "$PKG/www" -name '*.css' ! -name '*.min.css' | while IFS= read -r f; do
	"$BIN/cleancss" -O1 -o "$f.tmp" "$f"
	mv "$f.tmp" "$f"
done

# minify the static HTML pages — the four self-contained ones majestic serves
# before there is a session, and nothing else.
#
# Their stylesheets and scripts are INLINE, so the two loops above never reached
# them: everything the browser gets from setup.html, login.html, cameras.html and
# index.html shipped exactly as written, comments and all. On setup.html that was
# 22 KB of a 59 KB page, on the one page an unclaimed camera serves. Across the
# four it is 43 KB of rootfs, which on a 5120 KB partition is the same kind of
# saving the purged bootstrap subset exists for.
#
# Comments plus the inline JS and CSS, and deliberately NOT collapseWhitespace:
# measured, the whitespace is another 578 bytes out of 55 KB — 0.6% — for a
# transform that can take a meaningful space out from between two inline
# elements. That is not a trade worth making on the pages with no fallback.

find "$PKG/www" -name '*.html' | while IFS= read -r f; do
	"$BIN/html-minifier-terser" --remove-comments --minify-js --minify-css \
		-o "$f.tmp" "$f"
	# A <!--! comment is one addressed to whoever FETCHES the page rather than
	# to whoever edits the file — setup.html's note to AI agents about who may
	# accept the EULA is the only one so far, and the served copy is the only
	# copy its reader will ever see. Losing it would be silent: the page still
	# works, still looks right, and no longer says the thing it exists to say.
	#
	# The ! prefix is html-minifier-terser's own convention for a comment
	# --remove-comments keeps, and the check below is what makes relying on a
	# default safe: spelling it out as --ignore-custom-comments '[/^!/]' looked
	# safer and is worse — the CLI mis-parses the value and keeps comments it
	# was not asked to (two of setup.html's, measured). So depend on the
	# default and fail the build if it ever changes.
	kept=$(grep -c '<!--!' "$f" || true)
	got=$(grep -c '<!--!' "$f.tmp" || true)
	if [ "$kept" != "$got" ]; then
		echo "build-dist: $f lost a kept comment ($kept -> $got)" >&2
		exit 1
	fi
	# Empty output from a minifier that still exits 0 is the other silent
	# failure; the pages are self-contained, so every one of them is large.
	[ -s "$f.tmp" ] || { echo "build-dist: $f minified to nothing" >&2; exit 1; }
	mv "$f.tmp" "$f"
done

# strip the comments out of the haserl templates.
#
# This is the step an HTML minifier could not do -- it does not know what <% %>
# is, and two thirds of the comment bytes in a .cgi are not HTML comments at
# all but shell and haserl ones. tools/strip-cgi-comments.js knows all three.
#
# It is worth more than the .html pages above: measured over this tree, 83 KB
# of 297 KB, and on the Live page 17 KB of the 32 KB a browser is sent EVERY
# time somebody opens it -- uncompressed, because a CGI reply comes back
# chunked with no Content-Encoding however the request asks for one.
node tools/strip-cgi-comments.js "$PKG/www"

# ...and refuse to build a payload that still carries any.
#
# Last step before the tar on purpose: it checks what is about to ship rather
# than what the sources say, so it also catches a minifier that stopped
# removing comments, a step accidentally reordered, and a new asset type nobody
# ran through either loop. check.yml runs this same script on a pull request,
# so the gate fires there too.
node tools/check-no-comments.js "$PKG"

tar czf majestic-webui-dist.tar.gz -C "$OUT" majestic-webui
echo "built majestic-webui-dist.tar.gz ($(wc -c < majestic-webui-dist.tar.gz) bytes)"
