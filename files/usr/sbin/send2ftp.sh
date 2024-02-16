#!/bin/sh

plugin="ftp"

. /usr/sbin/common-plugins

show_help() {
	echo "Usage: $0 [-h host] [-p port] [-u username] [-P password] [-d path] [-f file] [-v] [-h]
  -s host     FTP server FQDN or IP address.
  -p port     FTP server port.
  -d path     Directory on server, relative to FTP root.
  -f file     File to upload.
  -u username FTP username.
  -P password FTP password.
  -r          Use HEIF image format.
  -v          Verbose output.
  -h          Show this help.
"
	exit 0
}

# override config values with command line arguments
while getopts d:f:p:P:rs:u:vh flag; do
	case "$flag" in
		d)
			ftp_path=$OPTARG
			;;
		f)
			ftp_file=$OPTARG
			;;
		p)
			ftp_port=$OPTARG
			;;
		P)
			ftp_password=$OPTARG
			;;
		r)
			ftp_use_heif="true"
			;;
		s)
			ftp_host=$OPTARG
			;;
		u)
			ftp_username=$OPTARG
			;;
		v)
			verbose="true"
			;;
		h|*)
			show_help
			;;
	esac
done

if [ "false" = "$ftp_enabled" ]; then
	log "Sending to FTP is disabled."
	exit 10
fi

# validate mandatory values
if [ -z "$ftp_host" ]; then
	log "FTP host not found"
	exit 11
fi

if [ -z "$ftp_port" ]; then
	log "FTP port not found"
	exit 12
fi

if [ -z "$ftp_file" ]; then
	if [ "true" = "$ftp_use_heif" ] && [ "h265" = "$(yaml-cli -g .video0.codec)" ]; then
		snapshot=/tmp/snapshot4cron.heif
		snapshot4cron.sh -r
	else
		snapshot=/tmp/snapshot4cron.jpg
		snapshot4cron.sh
	fi
	# [ $? -ne 0 ] && echo "Cannot get a snapshot" && exit 2
	[ ! -f "$snapshot" ] && log "Cannot find a snapshot" && exit 3

	ftp_file=$snapshot
fi

command="curl --verbose"
command="${command} --connect-timeout ${curl_timeout}"
command="${command} --max-time ${curl_timeout}"

# SOCK5 proxy, if needed
if [ "true" = "$ftp_socks5_enabled" ]; then
	. /etc/webui/socks5.conf
	command="${command} --socks5-hostname ${socks5_host}:${socks5_port}"
	command="${command} --proxy-user ${socks5_login}:${socks5_password}"
fi

command="${command} --url ftp://"
[ -n "$ftp_username" ] && [ -n "$ftp_password" ] && command="${command}${ftp_username}:${ftp_password}"
command="${command}@${ftp_host}:${ftp_port}"
[ -n "$ftp_path" ] && command="${command}/${ftp_path// /%20}"
command="${command}/$(date +"$ftp_template")"
command="${command} --upload-file ${ftp_file}"
command="${command} --ftp-create-dirs"

log "$command"
eval "$command" >>"$LOG_FILE" 2>&1

[ "true" = "$verbose" ] && cat "$LOG_FILE"

exit 0
