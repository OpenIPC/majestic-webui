#!/bin/sh

plugin="mqtt"

. /usr/sbin/common-plugins

show_help() {
	echo "Usage: $0 [-t topic] [-m message] [-s] [-v] [-h]
  -t topic    MQTT topic.
  -m message  Message playload.
  -s          Send a snapshot.
  -r          Use HEIF image format.
  -v          Verbose output.
  -h          Show this help.
"
	exit 0
}

# override config values with command line arguments
while getopts m:rst:vh flag; do
	case "$flag" in
		m)
			mqtt_message=$OPTARG
			;;
		r)
			mqtt_use_heif="true"
			;;
		s)
			mqtt_send_snap="true"
			;;
		t)
			mqtt_topic=$OPTARG
			;;
		v)
			verbose="true"
			;;
		h|*)
			show_help
			;;
	esac
done

if [ "false" = "$mqtt_enabled" ]; then
	log "Sending to MQTT broker is disabled."
	exit 10
fi

# validate mandatory values
if [ -z "$mqtt_host" ]; then
	log "MQTT broker host not found in config"
	exit 11
fi

if [ -z "$mqtt_port" ]; then
	log "MQTT broker port not found in config"
	exit 12
fi

if [ -z "$mqtt_topic" ]; then
	log "MQTT topic not found"
	exit 13
fi

if [ -z "$mqtt_message" ]; then
	log "MQTT message template not found"
	exit 14
fi

if [ "true" = "$mqtt_send_snap" ] && [ -z "$mqtt_snap_topic" ]; then
	log "MQTT topic for sending snapshot not found in config"
	exit 15
fi

# assign default values if not set
[ -z "$mqtt_client_id" ] && mqtt_client_id="${network_hostname}"

# parse strftime templates
mqtt_message=$(date +"$mqtt_message")

command="mosquitto_pub"
command="${command} -h ${mqtt_host}"
command="${command} -p ${mqtt_port}"
command="${command} -i ${mqtt_client_id}"

# MQTT credentials, if given
[ -n "$mqtt_username" ] && command="${command} -u ${mqtt_username}"
[ -n "$mqtt_password" ] && command="${command} -P ${mqtt_password}"

# SOCK5 proxy, if needed
if [ "true" = "$mqtt_socks5_enabled" ]; then
	. /etc/webui/socks5.conf
	socks_opts="--proxy socks5h://${socks5_login}:${socks5_password}@${socks5_host}:${socks5_port}"
fi
command="${command} ${socks_opts}"

# send text message
command1="${command} -t ${mqtt_topic} -m \"${mqtt_message}\""
log "$command1"
eval "$command1" >>"$LOG_FILE" 2>&1

# send file
if [ "true" = "$mqtt_send_snap" ]; then
	if [ "true" = "$mqtt_use_heif" ] && [ "h265" = "$(yaml-cli -g .video0.codec)" ]; then
		snapshot=/tmp/snapshot4cron.heif
		snapshot4cron.sh -r
	else
		snapshot=/tmp/snapshot4cron.jpg
		snapshot4cron.sh
	fi
	exitcode=$?
	if [ $exitcode -ne 0 ]; then
		log "Cannot get a snapshot. Exit code: $exitcode"
		exit 2
	fi
	snapshot=/tmp/snapshot4cron.jpg
	if [ ! -f "$snapshot" ]; then
		log "Cannot find a snapshot"
		exit 3
	fi
	mqtt_file=$snapshot
	command2="${command} -t ${mqtt_snap_topic} -f \"${mqtt_file}\""
	log "$command2"
	eval "$command2" >>"$LOG_FILE" 2>&1
fi

[ "true" = "$verbose" ] && cat "$LOG_FILE"

exit 0
