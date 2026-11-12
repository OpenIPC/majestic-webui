#!/bin/sh
# Read and update autofocus trigger rules and scheduled refocus settings.
# Persisted in /etc/af_triggers.conf and synced to /etc/crontabs/root.

CONF="/etc/af_triggers.conf"
CRON_FILE="/etc/crontabs/root"
CHECK_BIN="/usr/bin/af-trigger-check"

load_conf() {
	TRIGGER_MODE="ptz"
	ON_IRCUT="1"
	SCHEDULE="off"
	SCHEDULE_HOUR="3"
	SCHEDULE_DAY="0"
	if [ -f "$CONF" ]; then
		while IFS='=' read -r k v; do
			case "$k" in
				trigger_mode) TRIGGER_MODE="$v" ;;
				on_ircut) ON_IRCUT="$v" ;;
				schedule) SCHEDULE="$v" ;;
				schedule_hour) SCHEDULE_HOUR="$v" ;;
				schedule_day) SCHEDULE_DAY="$v" ;;
			esac
		done < "$CONF"
	fi
}

install_watcher() {
	cat << 'EOF' > "${CHECK_BIN}.tmp"
#!/bin/sh
CONF="/etc/af_triggers.conf"
STATE_FILE="/tmp/af_night_state"

ON_IRCUT="1"
if [ -f "$CONF" ]; then
	while IFS='=' read -r k v; do
		case "$k" in
			on_ircut) ON_IRCUT="$v" ;;
		esac
	done < "$CONF"
fi

trigger_af_if_idle() {
	st=$(curl -s -m 2 "http://127.0.0.1/autofocus/status" 2>/dev/null)
	case "$st" in
		running*) return 0 ;;
	esac
	curl -s -m 2 "http://127.0.0.1/autofocus" >/dev/null 2>&1
}

case "$1" in
	--run)
		trigger_af_if_idle
		;;
	--ircut-event)
		[ "$ON_IRCUT" = "1" ] || exit 0
		sleep 3
		trigger_af_if_idle
		;;
	--watch|*)
		[ "$ON_IRCUT" = "1" ] || exit 0
		ircut_pins=$(fw_printenv -n ircut 2>/dev/null)
		[ -n "$ircut_pins" ] || exit 0
		cur=""
		for pin in $ircut_pins; do
			pin_num=${pin#[!0-9]*}
			[ -r "/sys/class/gpio/gpio${pin_num}/value" ] || continue
			v=$(cat "/sys/class/gpio/gpio${pin_num}/value" 2>/dev/null)
			cur="${cur}:${v:-x}"
		done
		[ -n "$cur" ] || exit 0
		if [ ! -f "$STATE_FILE" ]; then
			echo "$cur" > "$STATE_FILE"
			exit 0
		fi
		prev=$(cat "$STATE_FILE" 2>/dev/null)
		if [ "$cur" != "$prev" ]; then
			echo "$cur" > "$STATE_FILE"
			sleep 2
			trigger_af_if_idle
		fi
		;;
esac
EOF
	chmod 755 "${CHECK_BIN}.tmp"
	mv "${CHECK_BIN}.tmp" "$CHECK_BIN"
}

sync_cron() {
	install_watcher
	mkdir -p /etc/crontabs
	touch "$CRON_FILE"
	grep -v '# af-triggers$' "$CRON_FILE" > "${CRON_FILE}.tmp" 2>/dev/null || true

	if [ "$ON_IRCUT" = "1" ]; then
		echo "* * * * * $CHECK_BIN --watch >/dev/null 2>&1 # af-triggers" >> "${CRON_FILE}.tmp"
	fi

	case "$SCHEDULE" in
		hourly)
			echo "0 * * * * $CHECK_BIN --run >/dev/null 2>&1 # af-triggers" >> "${CRON_FILE}.tmp"
			;;
		daily)
			echo "0 $SCHEDULE_HOUR * * * $CHECK_BIN --run >/dev/null 2>&1 # af-triggers" >> "${CRON_FILE}.tmp"
			;;
		weekly)
			echo "0 $SCHEDULE_HOUR * * $SCHEDULE_DAY $CHECK_BIN --run >/dev/null 2>&1 # af-triggers" >> "${CRON_FILE}.tmp"
			;;
	esac

	mv "${CRON_FILE}.tmp" "$CRON_FILE"
}

load_conf

if [ "$REQUEST_METHOD" = "POST" ]; then
	for param in $(echo "$QUERY_STRING" | tr '&' ' '); do
		case "$param" in
			trigger_mode=*)
				v="${param#*=}"
				case "$v" in
					ptz|zoom_only|pan_tilt_only|manual) TRIGGER_MODE="$v" ;;
				esac
				;;
			on_ircut=*)
				v="${param#*=}"
				case "$v" in
					1|true) ON_IRCUT="1" ;;
					0|false) ON_IRCUT="0" ;;
				esac
				;;
			schedule=*)
				v="${param#*=}"
				case "$v" in
					off|hourly|daily|weekly) SCHEDULE="$v" ;;
				esac
				;;
			schedule_hour=*)
				v="${param#*=}"
				if echo "$v" | grep -qE '^[0-9]{1,2}$' && [ "$v" -ge 0 ] && [ "$v" -le 23 ]; then
					SCHEDULE_HOUR="$v"
				fi
				;;
			schedule_day=*)
				v="${param#*=}"
				if echo "$v" | grep -qE '^[0-6]$'; then
					SCHEDULE_DAY="$v"
				fi
				;;
		esac
	done

	cat << EOF > "${CONF}.tmp"
trigger_mode=$TRIGGER_MODE
on_ircut=$ON_IRCUT
schedule=$SCHEDULE
schedule_hour=$SCHEDULE_HOUR
schedule_day=$SCHEDULE_DAY
EOF
	mv "${CONF}.tmp" "$CONF"
	sync_cron
fi

[ "$ON_IRCUT" = "1" ] && ircut_json="true" || ircut_json="false"

echo "HTTP/1.1 200 OK
Content-type: application/json; charset=UTF-8
Cache-Control: no-store

{\"ok\":true,\"trigger_mode\":\"$TRIGGER_MODE\",\"on_ircut\":$ircut_json,\"schedule\":\"$SCHEDULE\",\"schedule_hour\":$SCHEDULE_HOUR,\"schedule_day\":$SCHEDULE_DAY}"
