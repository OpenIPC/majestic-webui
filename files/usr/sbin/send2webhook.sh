#!/bin/sh

plugin="webhook"

. /usr/sbin/common-plugins

show_help() {
	echo "Usage: $0 [-u url] [-v] [-h]
  -u url      Webhook URL.
  -r          Use HEIF image format.
  -v          Verbose output.
  -h          Show this help.
"
	exit 0
}

# override config values with command line arguments
while getopts u:rvh flag; do
	case "$flag" in
		r)
			webhook_use_heif="true"
			;;
		u)
			webhook_url=$OPTARG
			;;
		v)
			verbose="true"
			;;
		h|*)
			show_help
			;;
	esac
done

if [ "false" = "$webhook_enabled" ]; then
	log "Sending to webhook is disabled."
	exit 10
fi

# validate mandatory values
if [ -z "$webhook_url" ]; then
	log "Webhook URL not found"
	exit 11
fi

command="curl --verbose"
command="${command} --connect-timeout ${curl_timeout}"
command="${command} --max-time ${curl_timeout} -X POST"

if [ "true" = "$webhook_attach_snapshot" ]; then
	if [ "true" = "$webhoook_use_heif" ] && [ "h265" = "$(yaml-cli -g .video0.codec)" ]; then
		snapshot=/tmp/snapshot4cron.heif
		snapshot4cron.sh -r
		exitcode=$?
	else
		snapshot=/tmp/snapshot4cron.jpg
		snapshot4cron.sh
		exitcode=$?
	fi

	if [ $exitcode -ne 0 ]; then
		log "Cannot get a snapshot. Exit code: $exitcode"
		exit 2
	fi

	snapshot=/tmp/snapshot4cron.jpg
	if [ ! -f "$snapshot" ]; then
		log "Cannot find a snapshot"
		exit 3
	fi

	command="${command} -F 'image=@$snapshot'"
fi

# SOCK5 proxy, if needed
if [ "true" = "$webhook_socks5_enabled" ]; then
	. /etc/webui/socks5.conf
	command="${command} --socks5-hostname ${socks5_host}:${socks5_port}"
	command="${command} --proxy-user ${socks5_login}:${socks5_password}"
fi

command="${command} --url ${webhook_url}"

log "$command"
eval "$command" >>"$LOG_FILE" 2>&1

[ "true" = "$verbose" ] && cat "$LOG_FILE"

exit 0
