#!/bin/sh
# Recordings browser backend: which days hold footage, and what is in one day.
# GET ?days=1        -> {"prefix":"…","days":[{name,clips,mtime}]}
# GET ?day=<name>    -> {"path":"…","clips":[{name,size,mtime}]}
#
# It never serves media, and must never be made to. The browser fetches a clip
# straight off its filesystem path, where majestic answers with sendfile and
# honours Range; routing a 400 MB recording through a CGI would cat it into the
# connection buffer and take the camera's RAM with it. Everything here is
# metadata only — names, sizes, mtimes.
#
# This exists because majestic indexes nothing it records: it writes the clips
# and publishes no listing, no size and no mtime for any of them, so somebody
# has to walk the directory. That is the whole job — everything else it needs,
# it asks the daemon for.

. "$(dirname "$0")/../p/majestic.sh"

json_hdr() { printf 'HTTP/1.1 200 OK\nContent-Type: application/json\nCache-Control: no-store\n\n'; }

# Escape a string for embedding inside JSON quotes (drop control chars).
json_str() { printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

json_hdr

# Where recordings live is majestic's business, not the caller's. This used to
# take the directory from ?prefix=, which made an authenticated request able to
# enumerate MP4 names, sizes and mtimes anywhere the web process can read —
# never mind that the page only ever sent the configured path. A filesystem
# path arriving from a client is not a permission, so derive it here and ignore
# what was sent: records.path up to the first strftime %.
#
# Derived by asking the daemon, which is not the same as reading its file. The
# file holds only what differs from the built-in defaults, so a camera that
# never had its recording path written to disk — the ordinary case, since the
# settings page saves only the keys somebody changed — yielded an empty prefix
# and was told, in a confident sentence, that it had no recordings directory
# at all.
records_path=$(mj_cfg records.path)
case $? in
	0) ;;
	1)
		# Answered, and the key is not set. That is a fact about the camera and
		# is worth saying plainly -- unlike the case below, where nothing has
		# been established at all.
		printf '{"error":"no recording path is configured"}'
		exit 0
		;;
	*)
		# The daemon could not be asked. Reporting this as "no recordings
		# directory" would state as fact something nothing has established, and
		# reporting it as "not configured" would blame the configuration for a
		# request that never got an answer.
		printf '{"error":"could not ask the camera where recordings live"}'
		exit 0
		;;
esac

prefix=$(printf '%s' "$records_path" | sed 's/%.*//; s#/*$##')
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
