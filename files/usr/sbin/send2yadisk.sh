#!/bin/sh

plugin="yadisk"

. /usr/sbin/common-plugins

show_help() {
	echo "Usage: $0 [-u username] [-P password] [-v] [-h]
  -d path     Directory on server.
  -f file     File to upload.
  -u username Yandex Disk username.
  -P password Yandex Disk username.
  -r          Use HEIF image format.
  -v          Verbose output.
  -h          Show this help.
"
	exit 0
}

# override config values with command line arguments
while getopts d:f:P:ru:vh flag; do
	case "$flag" in
		d)
			yadisk_path=$OPTARG
			 ;;
		f)
			yadisk_file=$OPTARG
			 ;;
		P)
			yadisk_password=$OPTARG
			;;
		r)
			yadisk_use_heif="true"
			;;
		u)
			yadisk_username=$OPTARG
			;;
		v)
			verbose="true"
			;;
		h|*)
			show_help
			;;
	esac
done

if [ "false" = "$yadisk_enabled" ]; then
	log "Sending to Yandex Disk is disabled."
	exit 10
fi

if [ -z "$yadisk_file" ]; then
	if [ "true" = "$yadisk_use_heif" ] && [ "h265" = "$(yaml-cli -g .video0.codec)" ]; then
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

	yadisk_file=$snapshot
fi

# validate mandatory values
if [ -z "$yadisk_username" ]; then
	log "Yandex Disk username not found"
	exit 11
fi

if [ -z "$yadisk_password" ]; then
	log "Yandex Disk password not found"
	exit 12
fi

command="curl --verbose"
command="${command} --connect-timeout ${curl_timeout}"
command="${command} --max-time ${curl_timeout}"

# Yandex Disk credentials
command="${command} --user '${yadisk_username}:${yadisk_password}'"

# SOCK5 proxy, if needed
if [ "true" = "$yadisk_socks5_enabled" ]; then
	. /etc/webui/socks5.conf
	command="${command} --socks5-hostname ${socks5_host}:${socks5_port}"
	command="${command} --proxy-user ${socks5_login}:${socks5_password}"
fi

# create path to destination directory
url="https://webdav.yandex.ru"
subdirs="${yadisk_path// /_}" # prevent splitting by whitespaces
subdirs="$(echo "$yadisk_path" | sed "s/[^\/]$/\//")" # add final slash if missing
suburl=""
while [ -n "$subdirs" ]; do
	subdir="${subdirs%%/*}"
	subdir="${subdir// /%20}" # convert each space into %20
	if [ -n "$subdir" ]; then
		suburl="${suburl}/${subdir}"
		_command="${command} --request MKCOL ${url}/${_url}/ " # disposable subcommand
		log "$_command"
		eval "$_command" >>"$LOG_FILE" 2>&1
	fi
	subdirs="${subdirs#*/}"
done; unset _command

# upload file
url="${url}${_url}/$(TZ=$(cat /etc/TZ) date +"%G%m%d-%H%M%S").jpg"
command="${command} --url ${url}"
command="${command} --request PUT"
command="${command} --upload-file ${snapshot}"

log "$command"
eval "$command" >>"$LOG_FILE" 2>&1

[ "true" = "$verbose" ] && cat "$LOG_FILE"

exit 0
