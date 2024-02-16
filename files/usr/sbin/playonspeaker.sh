#!/bin/sh

plugin="speaker"

. /usr/sbin/common-plugins

SUPPORTED="goke hisilicon ingenic sigmastar"
if [ -z "$(echo $SUPPORTED | sed -n "/\b$(ipcinfo --vendor)\b/p")" ]; then
	log "Playing on speaker is not supported on your camera!"
	exit 1
fi

show_help() {
	echo "Usage: $0 [-u url] [-f file] [-v] [-h]
  -u url      Audio URL.
  -f file     Audio file.
  -v          Verbose output.
  -h          Show this help.
"
	exit 0
}

# override config values with command line arguments
while getopts f:u:vh flag; do
	case "$flag" in
		f)
			speaker_file=$OPTARG
			;;
		u)
			speaker_url=$OPTARG
			;;
		v)
			verbose="true"
			;;
		h|*)
			show_help
			;;
	esac
done

if [ "false" = "$speaker_enabled" ]; then
	log "Playing on speaker is disabled in config ${config_file}."
	exit 10
fi

if [ "false" = "$(yaml-cli -g .audio.enabled)" ]; then
	log "Playing on speaker is disabled in Majestic."
	exit 11
fi

# validate mandatory values
if [ -z "$speaker_url" ]; then
	log "Speaker URL is not set"
	exit 12
fi

if [ -z "$speaker_file" ]; then
	log "Audio file is not set"
	exit 13
fi

if [ ! -f "$speaker_file" ]; then
	log "Audio file ${speaker_file} not found"
	exit 14
fi

command="curl --verbose"
command="${command} --connect-timeout ${curl_timeout}"
command="${command} --max-time ${curl_timeout} -X POST"
command="${command} -T ${speaker_file}"
command="${command} --url ${speaker_url}"

log "$command"
eval "$command" >>"$LOG_FILE" 2>&1

[ "true" = "$verbose" ] && cat "$LOG_FILE"

exit 0
