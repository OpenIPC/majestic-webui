#!/bin/sh
# Wi-Fi scan: GET ?scan=1 -> {"networks":[{ssid,signal,security}],"error":""}
# (signal is dBm; security is open/WEP/WPA/WPA2). Always returns valid JSON.
DEV=wlan0

printf 'HTTP/1.1 200 OK\nContent-Type: application/json\nCache-Control: no-store\n\n'

json_str() { printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
num() { printf '%s' "$1" | grep -oE '^-?[0-9]+' || printf '0'; }

if [ ! -e "/sys/class/net/$DEV" ]; then
	printf '{"networks":[],"error":"no Wi-Fi interface"}'
	exit 0
fi

ip link set "$DEV" up 2>/dev/null

# intermediate lines: "signal|security|ssid"
raw=""

# 1) wpa_cli (when wpa_supplicant runs with a control socket): scan + scan_results
if command -v wpa_cli >/dev/null 2>&1; then
	wpa_cli -i "$DEV" scan >/dev/null 2>&1
	sleep 2
	sr=$(wpa_cli -i "$DEV" scan_results 2>/dev/null)
	raw=$(printf '%s\n' "$sr" | awk -F'\t' '
		NR>1 && NF>=5 && $5!="" {
			sec="open";
			if ($4 ~ /WPA2/) sec="WPA2"; else if ($4 ~ /WPA/) sec="WPA"; else if ($4 ~ /WEP/) sec="WEP";
			print $3"|"sec"|"$5
		}')
fi

# 2) fallback to iwlist
if [ -z "$raw" ] && command -v iwlist >/dev/null 2>&1; then
	raw=$(iwlist "$DEV" scan 2>/dev/null | awk '
		/Signal level/      { s=$0; sub(/.*Signal level[=:]/,"",s); sub(/[ ].*/,"",s); sig=s }
		/Encryption key:on/  { enc=1 }
		/Encryption key:off/ { enc=0 }
		/IEEE 802.11i\/WPA2/ { sec="WPA2" }
		/WPA Version 1/      { if (sec=="") sec="WPA" }
		/ESSID:/ {
			e=$0; sub(/.*ESSID:"/,"",e); sub(/"[ ]*$/,"",e);
			if (e!="" && e!="<hidden>")
				printf "%s|%s|%s\n", sig, (enc ? (sec ? sec : "WEP") : "open"), e;
			sig=""; enc=0; sec=""
		}')
fi

# dedup by ssid keeping the strongest signal (largest dBm)
dedup=$(printf '%s\n' "$raw" | awk -F'|' '
	$3!="" { if (!($3 in seen) || $1+0 > sig[$3]+0) { sig[$3]=$1; sec[$3]=$2; seen[$3]=1 } }
	END { for (s in seen) print sig[s]"|"sec[s]"|"s }')

networks=""
OLDIFS=$IFS
IFS='
'
for line in $dedup; do
	[ -z "$line" ] && continue
	sig=${line%%|*}; rest=${line#*|}; sec=${rest%%|*}; ssid=${rest#*|}
	[ -z "$ssid" ] && continue
	networks="$networks${networks:+,}{\"ssid\":\"$(json_str "$ssid")\",\"signal\":$(num "$sig"),\"security\":\"$(json_str "$sec")\"}"
done
IFS=$OLDIFS

printf '{"networks":[%s],"error":""}' "$networks"
