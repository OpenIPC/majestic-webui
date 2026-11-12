#!/bin/sh
# Manage and apply ISP Scene & Night Shutter Presets (/etc/scene_presets.tsv).
# Applies exposure, brightness (luminance), contrast, and optional IR-Cut + AF.

SCENE_FILE="/etc/scene_presets.tsv"
ACTIVE_FILE="/etc/scene_active"

urldecode() {
	printf '%b' "$(echo "$1" | sed 's/+/ /g; s/%\([0-9A-Fa-f][0-9A-Fa-f]\)/\\x\1/g')"
}

json_escape() {
	printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/	/ /g' | tr -d '\r\n'
}

seed_defaults() {
	if [ ! -f "$SCENE_FILE" ] || [ ! -s "$SCENE_FILE" ]; then
		cat << 'EOF' > "$SCENE_FILE"
day_auto|Day (Auto Shutter)|0|50|50|day|0|Auto exposure & day filter for bright daylight
night_glare|Night Anti-Glare / Fast Shutter|35|45|56|keep|0|Fast shutter (35) to cut streetlamp halos & motion blur
night_bal|Night Balanced (100)|100|50|52|keep|0|Balanced night shutter (100) for mixed street lighting
night_max|Night Max Light (200)|200|50|50|keep|0|High sensitivity night exposure (200, camera default)
EOF
	fi
}

apply_scene_values() {
	irc="$4"

	# Optional IR-Cut switch via motorsd
	if [ "$irc" = "day" ] || [ "$irc" = "night" ]; then
		/usr/bin/motorsctl --socket /run/motorsd.sock \
			"{\"version\":1,\"id\":\"scene-ircut\",\"op\":\"command\",\"name\":\"ircut\",\"value\":\"$irc\"}" >/dev/null 2>&1
	fi
}

seed_defaults

ACT=""
ID=""
NAME=""
EXPOSURE="200"
LUMINANCE="50"
CONTRAST="50"
IRCUT="keep"
RUN_AF="0"
DESC=""

for param in $(echo "$QUERY_STRING" | tr '&' ' '); do
	case "$param" in
		act=*) ACT="${param#*=}" ;;
		id=*) ID=$(urldecode "${param#*=}") ;;
		name=*) NAME=$(urldecode "${param#*=}") ;;
		exposure=*) EXPOSURE="${param#*=}" ;;
		luminance=*) LUMINANCE="${param#*=}" ;;
		contrast=*) CONTRAST="${param#*=}" ;;
		ircut=*) IRCUT="${param#*=}" ;;
		run_af=*) RUN_AF="${param#*=}" ;;
		desc=*) DESC=$(urldecode "${param#*=}") ;;
	esac
done

echo "$EXPOSURE" | grep -qE '^[0-9]{1,4}$' || EXPOSURE=200
[ "$EXPOSURE" -le 1000 ] || EXPOSURE=1000
echo "$LUMINANCE" | grep -qE '^[0-9]{1,3}$' || LUMINANCE=50
[ "$LUMINANCE" -le 100 ] || LUMINANCE=50
echo "$CONTRAST" | grep -qE '^[0-9]{1,3}$' || CONTRAST=50
[ "$CONTRAST" -le 100 ] || CONTRAST=50
case "$IRCUT" in day|night|keep) ;; *) IRCUT="keep" ;; esac
[ "$RUN_AF" = "1" ] || RUN_AF="0"

if [ "$REQUEST_METHOD" = "POST" ]; then
	clean_id=$(printf '%s' "$ID" | tr -cd 'A-Za-z0-9_-' | cut -c1-24)
	case "$ACT" in
		apply)
			if [ -n "$clean_id" ]; then
				row=$(awk -F'|' -v id="$clean_id" '$1 == id { print $0; exit }' "$SCENE_FILE")
				if [ -n "$row" ]; then
					r_exp=$(echo "$row" | cut -d'|' -f3)
					r_lum=$(echo "$row" | cut -d'|' -f4)
					r_con=$(echo "$row" | cut -d'|' -f5)
					r_irc=$(echo "$row" | cut -d'|' -f6)
					r_af=$(echo "$row" | cut -d'|' -f7)
					apply_scene_values "${r_exp:-200}" "${r_lum:-50}" "${r_con:-50}" "${r_irc:-keep}" "${r_af:-0}"
					echo "$clean_id" > "$ACTIVE_FILE"
				fi
			else
				apply_scene_values "$EXPOSURE" "$LUMINANCE" "$CONTRAST" "$IRCUT" "$RUN_AF"
				echo "custom" > "$ACTIVE_FILE"
			fi
			;;
		save)
			[ -n "$clean_id" ] || clean_id="custom_$(date +%s)"
			clean_name=$(printf '%s' "$NAME" | tr '\t\r\n|' '    ' | sed 's/^ *//; s/ *$//' | cut -c1-32)
			[ -n "$clean_name" ] || clean_name="Custom Scene"
			clean_desc=$(printf '%s' "$DESC" | tr '\t\r\n|' '    ' | sed 's/^ *//; s/ *$//' | cut -c1-80)
			[ -n "$clean_desc" ] || clean_desc="Custom shutter (${EXPOSURE}) · Bri ${LUMINANCE} · Con ${CONTRAST}"
			awk -F'|' -v id="$clean_id" '$1 != id && NF >= 2 { print $0 }' "$SCENE_FILE" > "${SCENE_FILE}.tmp"
			echo "${clean_id}|${clean_name}|${EXPOSURE}|${LUMINANCE}|${CONTRAST}|${IRCUT}|${RUN_AF}|${clean_desc}" >> "${SCENE_FILE}.tmp"
			mv "${SCENE_FILE}.tmp" "$SCENE_FILE"
			apply_scene_values "$EXPOSURE" "$LUMINANCE" "$CONTRAST" "$IRCUT" "$RUN_AF"
			echo "$clean_id" > "$ACTIVE_FILE"
			;;
		delete)
			if [ -n "$clean_id" ]; then
				awk -F'|' -v id="$clean_id" '$1 != id && NF >= 2 { print $0 }' "$SCENE_FILE" > "${SCENE_FILE}.tmp"
				mv "${SCENE_FILE}.tmp" "$SCENE_FILE"
				seed_defaults
			fi
			;;
	esac
fi

active_id=$(cat "$ACTIVE_FILE" 2>/dev/null | tr -d '\r\n ')

echo "HTTP/1.1 200 OK
Content-type: application/json; charset=UTF-8
Cache-Control: no-store

{\"ok\":true,\"active\":\"${active_id}\",\"scenes\":["

first=1
while IFS='|' read -r sid sname sexp slum scon sirc saf sdesc; do
	[ -n "$sid" ] || continue
	[ "$first" = 1 ] && first=0 || printf ','
	e_id=$(json_escape "$sid")
	e_name=$(json_escape "$sname")
	e_desc=$(json_escape "$sdesc")
	[ "$saf" = "1" ] && af_b="true" || af_b="false"
	printf '{"id":"%s","name":"%s","exposure":%s,"luminance":%s,"contrast":%s,"ircut":"%s","run_af":%s,"desc":"%s"}' \
		"$e_id" "$e_name" "${sexp:-200}" "${slum:-50}" "${scon:-50}" "${sirc:-keep}" "$af_b" "$e_desc"
done < "$SCENE_FILE"

echo "]}"
