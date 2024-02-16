#!/bin/sh

plugin="openwall"

. /usr/sbin/common-plugins

show_help() {
	echo "Usage: $0 [-v] [-h] [-f]
  -f   Force send.
  -r   Use HEIF image format.
  -v   Verbose output.
  -h   Show this help.
"
	exit 0
}

# default values
flash_size=$(awk '{sum+=sprintf("0x%s", $2);} END{print sum/1048576;}' /proc/mtd)
fw_variant=$(grep "BUILD_OPTION" /etc/os-release | cut -d= -f2 | tr -d /\"/); [ -z "$fw_variant" ] && fw_variant="lite"
fw_version=$(grep "OPENIPC_VERSION" /etc/os-release | cut -d= -f2 | tr -d /\"/)

network_hostname=$(hostname -s)
network_default_interface=$(ip r | sed -nE '/default/s/.+dev (\w+).+?/\1/p' | head -n 1)
[ -z "$network_default_interface" ] && network_default_interface=$(ip r | sed -nE 's/.+dev (\w+).+?/\1/p' | head -n 1)
network_macaddr=$(cat "/sys/class/net/${network_default_interface}/address")

sensor=$(ipcinfo --short-sensor)
[ -z "$sensor" ] && sensor=$(fw_printenv -n sensor | cut -d_ -f1)

#sensor_config=$(yaml-cli -g .isp.sensorConfig)
soc=$(ipcinfo --chip-name)
[ "sigmastar" = "$(ipcinfo -v)" ] && soc=$(fw_printenv -n soc)

soc_temperature=$(ipcinfo --temp)
streamer=$(basename "$(ipcinfo --streamer)")
uptime=$(uptime | sed -r 's/^.+ up ([^,]+), .+$/\1/')

# override config values with command line arguments
while getopts frvh flag; do
	case "$flag" in
		f)
			force="true"
			;;
		r)
			use_heif="true"
			;;
		v)
			verbose="true"
			;;
		h|*)
			show_help
			;;
	esac
done

if [ "false" = "$openwall_enabled" ] && [ "true" != "$force" ]; then
	log "Sending to OpenIPC Wall is disabled."
	exit 10
fi

if [ "true" = "$openwall_use_heif" ] && [ "h265" = "$(yaml-cli -g .video0.codec)" ]; then
	snapshot=/tmp/snapshot4cron.heif
	snapshot4cron.sh -r
else
	snapshot=/tmp/snapshot4cron.jpg
	snapshot4cron.sh
	# [ $? -ne 0 ] && echo "Cannot get a snapshot" && exit 2
fi
[ ! -f "$snapshot" ] && log "Cannot find a snapshot" && exit 3

# validate mandatory values
[ ! -f "$snapshot" ] && log "Snapshot file not found" && exit 11
[ -z "$network_macaddr" ] && log "MAC address not found" && exit 12

command="curl --verbose"
command="${command} --connect-timeout ${curl_timeout}"
command="${command} --max-time ${curl_timeout}"

# SOCK5 proxy, if needed
if [ "true" = "$openwall_socks5_enabled" ]; then
	. /etc/webui/socks5.conf
	command="${command} --socks5-hostname ${socks5_host}:${socks5_port}"
	command="${command} --proxy-user ${socks5_login}:${socks5_password}"
fi

command="${command} --url https://openipc.org/snapshots"
command="${command} -F 'mac_address=${network_macaddr}'"
command="${command} -F 'firmware=${fw_version}-${fw_variant}'"
command="${command} -F 'flash_size=${flash_size}'"
command="${command} -F 'hostname=${network_hostname}'"
command="${command} -F 'caption=${openwall_caption}'"
command="${command} -F 'sensor=${sensor}'"
# command="${command} -F 'sensor_config=${sensor_config}'"
command="${command} -F 'soc=${soc}'"
command="${command} -F 'soc_temperature=${soc_temperature}'"
command="${command} -F 'streamer=${streamer}'"
command="${command} -F 'uptime=${uptime}'"
command="${command} -F 'file=@${snapshot}'"

log "$command"
eval "$command" >>"$LOG_FILE" 2>&1

[ "true" = "$verbose" ] && cat "$LOG_FILE"

exit 0
