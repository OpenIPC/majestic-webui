#!/bin/sh

plugin="telegram"

. /usr/sbin/common-plugins

show_help() {
	echo "Usage: $0 [-t token] [-c channel] [-m message] [-p photo] [-s] [-b] [-v] [-h]
  -t token    Telegram bot token. See https://t.me/botfather if you need one.
  -c channel  Telegram channel ID. See https://gist.github.com/mraaroncruz/e76d19f7d61d59419002db54030ebe35
  -m message  Message text.
  -p photo    Path to photo file.
    -i          Send inline.
    -a          Send as attachment.
    -r          Use HEIF image format.
  -s          Disable notification.
  -v          Verbose output.
  -h          Show this help.
"
	exit 0
}

# default values
telegram_disable_notification=false

# override config values with command line arguments
while getopts ac:im:p:rst:vh flag; do
	case "$flag" in
		a)
			telegram_as_attachment="true"
			;;
		c)
			telegram_channel=$OPTARG
			;;
		i)
			telegram_as_photo="true"
			;;
		m)
			telegram_message=$OPTARG
			;;
		p)
			telegram_photo=$OPTARG
			;;
		r)
			teleram_use_heif="true"
			;;
		s)
			telegram_disable_notification=true
			;;
		t)
			telegram_token=$OPTARG
			;;
		v)
			verbose="true"
			;;
		h|*)
			show_help
			;;
	esac
done

if [ "false" = "$telegram_enabled" ]; then
	log "Sending to Telegram is disabled."
	exit 10
fi

# validate mandatory values
if [ -z "$telegram_token" ]; then
	log "Telegram token not found"
	exit 11
fi

if [ -z "$telegram_channel" ]; then
	log "Telegram channel not found"
	exit 12
fi

if [ -z "$telegram_message" ]; then
	telegram_message="$(echo "$telegram_caption" | sed "s/%hostname/$(hostname -s)/;s/%datetime/$(date +"%F %T")/;s/%soctemp/$(ipcinfo --temp)/")"

	if [ -z "$telegram_photo" ]; then
		if [ "true" = "$telegram_use_heif" ] && [ "h265" = "$(yaml-cli -g .video0.codec)" ]; then
			snapshot=/tmp/snapshot4cron.heif
			snapshot4cron.sh -r
		else
			snapshot=/tmp/snapshot4cron.jpg
			snapshot4cron.sh
		fi

		if [ ! -f "$snapshot" ]; then
			log "Cannot find a snapshot"
			exit 3
		fi

		telegram_photo=$snapshot
	fi
fi

command="curl --verbose"
command="${command} --connect-timeout ${curl_timeout}"
command="${command} --max-time ${curl_timeout}"

# SOCK5 proxy, if needed
if [ "true" = "$telegram_socks5_enabled" ]; then
	. /etc/webui/socks5.conf
	command="${command} --socks5-hostname ${socks5_host}:${socks5_port}"
	command="${command} --proxy-user ${socks5_login}:${socks5_password}"
fi

command="${command} -H 'Content-Type: multipart/form-data'"
command="${command} -F 'chat_id=${telegram_channel}'"
command="${command} -F 'disable_notification=${telegram_disable_notification}'"
command="${command} --url https://api.telegram.org/bot${telegram_token}/"

if [ -n "$telegram_photo" ]; then
	if [ "true" = "$telegram_as_attachment" ]; then
		command1="$command"
		command1="${command1}sendDocument"
		command1="${command1} -F 'document=@${telegram_photo}'"
		command1="${command1} -F 'caption=${telegram_message}'"
		log "$command1"
		eval "$command1" >>"$LOG_FILE" 2>&1
	elif [ "true" = "$telegram_as_photo" ]; then
		command2="$command"
		command2="${command2}sendPhoto"
		command2="${command2} -F 'photo=@${telegram_photo}'"
		command2="${command2} -F 'caption=${telegram_message}'"
		log "$command2"
		eval "$command2" >>"$LOG_FILE" 2>&1
	else
		command3="$command"
		command3="${command3}sendMessage"
		command3="${command3} -F 'text=Please select a method of sending (inline photo or file attachmnet).'"
		log "$command3"
		eval "$command3" >>"$LOG_FILE" 2>&1
	fi
else
	command4="$command"
	command4="${command4}sendMessage"
	command4="${command4} -F 'text=${telegram_message}'"
	log "$command4"
	eval "$command4" >>"$LOG_FILE" 2>&1
fi

[ "true" = "$verbose" ] && cat "$LOG_FILE"

exit 0
