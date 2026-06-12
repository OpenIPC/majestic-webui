#!/bin/sh
# File manager backend: JSON directory listing, file read, and file operations.
# GET  ?cd=<dir>        -> {"path":"<canonical>","entries":[{name,type,size,mode,mtime}]}
# GET  ?cat=<file>      -> text/plain file contents (<=1 MiB) for the inline editor
# POST op=<...>         -> {"ok":bool[,"error":...]}  (params via POST_<key>)

json_hdr() { printf 'HTTP/1.1 200 OK\nContent-Type: application/json\nCache-Control: no-store\n\n'; }

# Escape a string for embedding inside JSON quotes (drop control chars).
json_str() { printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

list_dir() {
	d="$1"
	printf '{"path":"%s","entries":[' "$(json_str "$d")"
	first=1
	ls -A1 "$d" 2>/dev/null | while IFS= read -r name; do
		[ -z "$name" ] && continue
		p=$(printf '%s/%s' "$d" "$name" | sed 's#//*#/#g')
		info=$(stat -c '%s|%a|%Y|%F' "$p" 2>/dev/null) || continue
		sz=${info%%|*}; r=${info#*|}; mode=${r%%|*}; r=${r#*|}; mt=${r%%|*}; ft=${r#*|}
		case "$ft" in
			*directory*) t=dir;;
			*"symbolic link"*) t=link;;
			*) t=file;;
		esac
		[ "$first" = 1 ] || printf ','
		first=0
		printf '{"name":"%s","type":"%s","size":%s,"mode":"%s","mtime":%s}' \
			"$(json_str "$name")" "$t" "$sz" "$mode" "$mt"
	done
	printf ']}'
}

extract() { # archive destdir
	case "$1" in
		*.tar.gz|*.tgz) gunzip -c "$1" 2>/dev/null | tar x -C "$2" 2>/dev/null;;
		*.tar) tar x -f "$1" -C "$2" 2>/dev/null;;
		*.gz) gunzip -c "$1" > "$2/$(basename "${1%.gz}")" 2>/dev/null;;
		*.zip) unzip -o "$1" -d "$2" 2>/dev/null;;
		*) return 1;;
	esac
}

if [ "$REQUEST_METHOD" = "POST" ]; then
	json_hdr
	ok=""
	case "$POST_op" in
		delete)   [ -n "$POST_path" ] && rm -rf -- "$POST_path" 2>/dev/null && ok=1;;
		mkdir)    [ -n "$POST_name" ] && mkdir -p -- "$POST_dir/$POST_name" 2>/dev/null && ok=1;;
		newfile)  [ -n "$POST_name" ] && touch -- "$POST_dir/$POST_name" 2>/dev/null && ok=1;;
		rename)   [ -n "$POST_path" ] && [ -n "$POST_newname" ] \
			&& mv -- "$POST_path" "$(dirname "$POST_path")/$POST_newname" 2>/dev/null && ok=1;;
		chmod)    [ -n "$POST_path" ] && [ -n "$POST_mode" ] \
			&& chmod "$POST_mode" -- "$POST_path" 2>/dev/null && ok=1;;
		extract)  [ -n "$POST_path" ] && extract "$POST_path" "${POST_dir:-$(dirname "$POST_path")}" && ok=1;;
		bulkdelete)
			ok=1
			printf '%s' "$POST_paths" | base64 -d 2>/dev/null | while IFS= read -r bp || [ -n "$bp" ]; do
				[ -n "$bp" ] && rm -rf -- "$bp" 2>/dev/null
			done;;
	esac
	[ -n "$ok" ] && printf '{"ok":true}' || printf '{"ok":false,"error":"operation failed"}'
	exit 0
fi

if [ -n "$GET_cat" ]; then
	f="$GET_cat"
	if [ -f "$f" ] && [ "$(stat -c%s "$f" 2>/dev/null || echo 9999999)" -le 1048576 ]; then
		printf 'HTTP/1.1 200 OK\nContent-Type: text/plain; charset=utf-8\nCache-Control: no-store\n\n'
		cat "$f"
	else
		json_hdr
		printf '{"ok":false,"error":"not a text file or too large"}'
	fi
	exit 0
fi

json_hdr
d=$(cd "${GET_cd:-/}" 2>/dev/null && pwd) || d=/
[ -z "$d" ] && d=/
list_dir "$d"
