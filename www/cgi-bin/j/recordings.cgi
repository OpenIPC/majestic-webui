#!/bin/sh
# Recordings browser backend: which days hold footage, and what is in one day.
# GET ?days=1&prefix=<dir>      -> {"prefix":"…","days":[{name,clips,mtime}]}
# GET ?day=<name>&prefix=<dir>  -> {"path":"…","clips":[{name,size,mtime}]}
#
# It never serves media, and must never be made to. The browser fetches a clip
# straight off its filesystem path, where majestic answers with sendfile and
# honours Range; routing a 400 MB recording through a CGI would cat it into the
# connection buffer and take the camera's RAM with it. Everything here is
# metadata only — names, sizes, mtimes.
#
# <prefix> comes from the client, which reads records.path out of
# /api/v1/config.json and splits it at the first strftime %. Same arrangement as
# j/sdcard.cgi's ?rec=, and for the same reason: no shell here has to parse YAML
# or JSON to find out where recordings live.

json_hdr() { printf 'HTTP/1.1 200 OK\nContent-Type: application/json\nCache-Control: no-store\n\n'; }

# Escape a string for embedding inside JSON quotes (drop control chars).
json_str() { printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

json_hdr

prefix=$(printf '%s' "${GET_prefix:-}" | sed 's#/*$##')
if [ -z "$prefix" ] || [ ! -d "$prefix" ]; then
	printf '{"error":"no recordings directory"}'
	exit 0
fi

# Count the clips in a directory without stat-ing each one, and without a
# subprocess: the day list is drawn for a whole card at once, and a month of
# footage is a lot of files. `set --` does the glob, so $# is already the count.
# An unmatched glob stays literal, which is what -e rules out.
count_clips() {
	set -- "$1"/*.mp4
	[ -e "$1" ] || { echo 0; return; }
	echo $#
}

if [ -n "$GET_days" ]; then
	printf '{"prefix":"%s","days":[' "$(json_str "$prefix")"
	first=1
	# Day folders are records.path's %F, so their names sort chronologically.
	# A prefix with no % in it records straight into the prefix instead; that
	# shows up as the "." day so the page has something to select.
	n=$(count_clips "$prefix")
	if [ -n "$n" ] && [ "$n" -gt 0 ] 2>/dev/null; then
		mt=$(stat -c '%Y' "$prefix" 2>/dev/null || echo 0)
		printf '{"name":".","clips":%s,"mtime":%s}' "$n" "$mt"
		first=0
	fi
	for d in "$prefix"/*/; do
		[ -d "$d" ] || continue
		name=$(basename "$d")
		n=$(count_clips "$prefix/$name")
		[ -n "$n" ] || continue
		[ "$n" -gt 0 ] 2>/dev/null || continue
		mt=$(stat -c '%Y' "$prefix/$name" 2>/dev/null || echo 0)
		[ "$first" = 1 ] || printf ','
		first=0
		printf '{"name":"%s","clips":%s,"mtime":%s}' "$(json_str "$name")" "$n" "$mt"
	done
	printf ']}'
	exit 0
fi

# One day. The name is a single path component under the prefix — never a path,
# so a caller cannot walk out of the recordings directory with it.
day="$GET_day"
case "$day" in
	.)         dir="$prefix" ;;
	''|*/*|.*) printf '{"error":"bad day"}'; exit 0 ;;
	*)         dir="$prefix/$day" ;;
esac

if [ ! -d "$dir" ]; then
	printf '{"error":"no such day"}'
	exit 0
fi

printf '{"path":"%s","clips":[' "$(json_str "$dir")"
first=1
for f in "$dir"/*.mp4; do
	[ -f "$f" ] || continue
	info=$(stat -c '%s|%Y' "$f" 2>/dev/null) || continue
	sz=${info%%|*}; mt=${info#*|}
	[ "$first" = 1 ] || printf ','
	first=0
	printf '{"name":"%s","size":%s,"mtime":%s}' "$(json_str "$(basename "$f")")" "$sz" "$mt"
done
printf ']}'
