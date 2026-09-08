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

# One stat and one awk for the whole day, not five processes per clip.
#
# The obvious loop -- stat the file, basename it, json_str the name -- forks
# `stat`, `basename`, and json_str's own printf|tr|sed, for every clip.
# records.split is counted in minutes, so a full day is 1440 clips, and that
# loop is some seven thousand busybox forks to answer one request. Measured on
# an armv7 camera: 11.8 s for 680 clips, all of it process startup -- the glob
# and the tests together cost 0.04 s. The page cannot draw its timeline until
# this request finishes, so that number is the page load. The pipeline below
# emits the same bytes in 0.07 s.
#
# xargs does the batching, so the argument list stays inside ARG_MAX no matter
# how many clips a day holds, and it hands them on in the order it got them --
# the glob's, which is already chronological because these names are the clock.
# awk sees one uninterrupted stream, so the commas never have to work out where
# one batch ended and the next began.
#
# -L asks about what a symlink points at, which is what the `-f` test this
# replaces asked: a link to a clip is a clip, and a dangling one fails stat and
# drops out, as it did before. Size and mtime now describe the clip rather than
# the link, which is the answer the caller was always after.
set -- "$dir"/*.mp4
if [ -e "$1" ]; then
	printf '%s\0' "$@" |
	xargs -0 -r stat -L -c '%s|%Y|%F|%n' 2>/dev/null |
	awk -F'|' '
		# json_str, moved in here: escape backslash and quote, drop control
		# characters. Done a character at a time on purpose -- a backslash in
		# a gsub *replacement* is reinterpreted by gsub, and getting that
		# wrong is silent, so this never puts one there.
		function esc(s,   out, i, c) {
			out = ""
			for (i = 1; i <= length(s); i++) {
				c = substr(s, i, 1)
				if (c == "\\" || c == "\"") out = out "\\" c
				else if (c !~ /[\001-\037]/) out = out c
			}
			return out
		}
		# The name is field 4 onwards, rejoined: a filename may contain the
		# separator itself. Size, mtime and type go first, where they cannot
		# be mistaken for part of it.
		#
		# ^regular, not "regular file": busybox calls a zero-byte file a
		# "regular empty file", and the clip being recorded right now is
		# zero bytes until the muxer first flushes. Matching the exact string
		# drops the newest clip from the day you are most likely looking at.
		$3 ~ /^regular/ {
			name = $4
			for (i = 5; i <= NF; i++) name = name "|" $i
			sub(/.*\//, "", name)
			printf "%s{\"name\":\"%s\",\"size\":%s,\"mtime\":%s}", \
				(seen++ ? "," : ""), esc(name), $1, $2
		}
	'
fi
printf ']}'
