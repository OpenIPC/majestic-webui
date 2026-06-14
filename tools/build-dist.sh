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

# minify hand-written JS (skip already-minified vendored libs); fail loudly if a
# minified file is ever not valid JS.
find "$PKG/www" -name '*.js' ! -name '*.min.js' | while IFS= read -r f; do
	# .js suffix on the temp so `node --check` recognises it as a script
	"$BIN/terser" "$f" --compress --mangle -o "$f.tmp.js"
	node --check "$f.tmp.js"
	mv "$f.tmp.js" "$f"
done

# minify hand-written CSS (skip vendored .min.css and the already-purged bootstrap.min.css)
find "$PKG/www" -name '*.css' ! -name '*.min.css' | while IFS= read -r f; do
	"$BIN/cleancss" -O1 -o "$f.tmp" "$f"
	mv "$f.tmp" "$f"
done

tar czf majestic-webui-dist.tar.gz -C "$OUT" majestic-webui
echo "built majestic-webui-dist.tar.gz ($(wc -c < majestic-webui-dist.tar.gz) bytes)"
