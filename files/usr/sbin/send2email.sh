#!/bin/sh

plugin="email"

. /usr/sbin/common-plugins

show_help() {
	echo "Usage: $0 [-f address] [-t address] [-s subject] [-b body] [-v] [-h]
  -f address  Sender's email address
  -t address  Recipient's email address
  -r          Use HEIF image format.
  -s subject  Subject line.
  -b body     Letter body.
  -v          Verbose output.
  -h          Show this help.
"
	exit 0
}

# override config values with command line arguments
while getopts b:f:rs:t:vh flag; do
	case "$flag" in
		b)
			email_body=$OPTARG
			;;
		f)
			email_from_address=$OPTARG
			;;
		r)
			email_use_heif="true"
			;;
		s)
			email_subject=$OPTARG
			;;
		t)
			email_to_address=$OPTARG
			;;
		v)
			verbose="true"
			;;
		h|*)
			show_help
			;;
	esac
done

[ "false" = "$email_enabled" ] && log "Sending to email is disabled." && exit 10

# validate mandatory values
[ -z "$email_smtp_host" ] && log "SMTP host not found in config" && exit 11
[ -z "$email_smtp_port" ] && log "SMTP port not found in config" && exit 12
[ -z "$email_from_address" ] && log "Sender's email address not found" && exit 13
[ -z "$email_to_address" ] && log "Recipient's email address not found" && exit 14

# assign default values if not set
#[ -z "$email_from_name" ] && email_from_name="OpenIPC Camera"
#[ -z "$email_to_name" ] && email_to_name="OpenIPC Camera Admin"
#[ -z "$email_subject" ] && email_subject="Snapshot from OpenIPC Camera"

command="curl --silent --verbose"
command="${command} --connect-timeout ${curl_timeout}"
command="${command} --max-time ${curl_timeout}"

if [ "true" = "$email_smtp_use_ssl" ]; then
	command="${command} --ssl --url smtps://"
else
	command="${command} --url smtp://"
fi
command="${command}${email_smtp_host}:${email_smtp_port}"

command="${command} --mail-from ${email_from_address}"
command="${command} --mail-rcpt ${email_to_address}"
command="${command} --user '${email_smtp_username}:${email_smtp_password}'"

if [ "true" = "$email_attach_snapshot" ]; then
	if [ "true" = "$email_use_heif" ] && [ "h265" = "$(yaml-cli -g .video0.codec)" ]; then
		snapshot=/tmp/snapshot4cron.heif
		snapshot4cron.sh -r
	else
		snapshot=/tmp/snapshot4cron.jpg
		snapshot4cron.sh
	fi
	exitcode=$?
	[ $exitcode -ne 0 ] && log "Cannot get a snapshot. Exit code: $exitcode" && exit 2
	[ ! -f "$snapshot" ] && log "Cannot find a snapshot" && exit 3

	email_body="$(date -R)"
	command="${command} -H 'Subject: ${email_subject}'"
	command="${command} -H 'From: "${email_from_name}" <${email_from_address}>'"
	command="${command} -H 'To: "${email_to_name}" <${email_to_address}>'"
	command="${command} -F '=(;type=multipart/mixed'"
	command="${command} -F '=${email_body};type=text/plain'"
	command="${command} -F 'file=@${snapshot};type=image/jpeg;encoder=base64'"
	command="${command} -F '=)'"
else
	email_file="/tmp/email.$$.txt"
	{
		echo "From: ${email_from_name} <${email_from_address}>"
		echo "To: ${email_to_name} <${email_to_address}>"
		echo "Subject: ${email_subject}"
		echo "Date: $(date -R)"
		echo ""
		echo "${email_body}"
	} >>$email_file
	command="${command} --upload-file ${email_file}"
fi

log "$command"
eval "$command" >>"$LOG_FILE" 2>&1

[ "true" = "$verbose" ] && cat "$LOG_FILE"

[ -f ${email_file} ] && rm -f ${email_file}

exit 0
