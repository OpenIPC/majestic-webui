#!/bin/sh
# Regenerate the shipped (purged) www/a/bootstrap.min.css from upstream Bootstrap.
#
# We ship only the Bootstrap classes the webui actually uses, so the rootfs fits the
# smallest-flash boards. Re-run this whenever you add Bootstrap classes to a page, or
# bump BS_VERSION. Requires node/npx (purgecss is fetched on demand) and curl.
set -e
BS_VERSION=5.3.3
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "fetching Bootstrap ${BS_VERSION} …"
curl -fsSL "https://cdn.jsdelivr.net/npm/bootstrap@${BS_VERSION}/dist/css/bootstrap.min.css" \
	-o "$tmp/bootstrap.min.css"

echo "purging unused classes …"
npx --yes purgecss --config tools/purgecss.config.cjs \
	--css "$tmp/bootstrap.min.css" --output "$tmp/out/"

before=$(wc -c < "$tmp/bootstrap.min.css")
after=$(wc -c < "$tmp/out/bootstrap.min.css")
cp "$tmp/out/bootstrap.min.css" www/a/bootstrap.min.css
echo "www/a/bootstrap.min.css: ${before} -> ${after} bytes"
