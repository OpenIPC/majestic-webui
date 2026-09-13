#!/bin/sh

# === LOADING CONFIGURATION ===
# `.` rather than `source`: busybox ash takes either, but /bin/sh on a
# developer machine is often dash, which has only the POSIX spelling.
CONFIG_FILE="/etc/webui/ntfy.conf"
if [ -e "$CONFIG_FILE" ]; then
    . "$CONFIG_FILE"
else
    echo "Config file $CONFIG_FILE not found"
    exit 1
fi

# === CHECKS ===
# Non-zero, like every other refusal here. It used to exit 0, which told
# ntfy.cgi's test button that a switched-off integration had sent something.
if [ "$ntfy_enabled" != "true" ]; then
    echo "Sending to Ntfy is not enabled"
    exit 1
fi

if [ -z "$ntfy_topic" ]; then
    echo "Ntfy topic not found in config"
    exit 1
fi

# Default values
[ -z "$ntfy_server" ] && ntfy_server="https://ntfy.sh"
[ -z "$ntfy_priority" ] && ntfy_priority="3"

# Formation of the message text
if [ -z "$ntfy_caption" ]; then
    ntfy_message="$(hostname -s), $(date +'%F %T')"
else
    ntfy_message="$(echo "$ntfy_caption" | sed "s/%hostname/$(hostname -s)/;s/%datetime/$(date +"%F %T")/;s/%soctemp/$(ipcinfo --temp)/")"
fi

# === WHAT TO SEND ===
# A private directory rather than a predictable /tmp path: this runs as root,
# from a webhook anyone who can reach the camera can fire, and the old
# hostname-and-timestamp name was guessable enough for a symlink planted there
# to be followed and clobbered. sbin/telegram carries the same note.
workdir=$(mktemp -d /tmp/ntfy.XXXXXX) || exit 1
trap 'rm -rf "$workdir"' EXIT INT TERM

# Called with a path, send that file instead of taking a picture -- that is how
# majestic hands over a finished recording. The file belongs to the caller, so
# it is never put in the workdir and never removed.
if [ -n "$1" ]; then
    snapshot=$1
    if [ ! -s "$snapshot" ]; then
        echo "Nothing to send: $snapshot"
        exit 1
    fi
    case "$snapshot" in
    *.mp4) content_type="video/mp4" ;;
    *.heif) content_type="image/heif" ;;
    *) content_type="image/jpeg" ;;
    esac
else
    filename="$(hostname -s | tr ' ' '-')"-"$(date +'%Y%m%d-%H%M%S')"

    # Format verification (HEIF or JPG)
    if [ "$ntfy_heif" = "true" ]; then
        snapshot=$workdir/${filename}.heif
        content_type="image/heif"
        wget -q -T1 localhost/image.heif -O "$snapshot"
    else
        snapshot=$workdir/${filename}.jpg
        content_type="image/jpeg"
        wget -q -T1 localhost/image.jpg -O "$snapshot"
    fi

    if [ ! -e "$snapshot" ]; then
        echo "Snapshot file not found"
        exit 1
    fi
fi

# === PROXY CONFIGURATION (Takes from the standard OpenIPC config) ===
PROXY_OPTS=""
if [ "$ntfy_proxy" = "true" ] && [ -e "/etc/webui/proxy.conf" ]; then
    . /etc/webui/proxy.conf
    PROXY_OPTS="--socks5-hostname ${socks5_host}:${socks5_port}"
    if [ -n "$socks5_username" ] && [ -n "$socks5_password" ]; then
        PROXY_OPTS="${PROXY_OPTS} --proxy-user ${socks5_username}:${socks5_password}"
    fi
fi


# The path reaches a shell twice: once written into the command string and once
# when that string is eval'd. It used to be ours -- mktemp plus a hostname and
# a timestamp -- and is now whatever the caller hands over, which is a
# recording path built from an operator's strftime pattern. A single quote in
# it would close the quoting and hand the rest of the name to sh, so it is
# escaped rather than trusted: close the quote, escape one, reopen.
esc_path=$(printf '%s' "$snapshot" | sed "s/'/'\\\\''/g")
esc_name=$(basename "$snapshot" | sed "s/'/'\\\\''/g")
esc_message=$(printf '%s' "$ntfy_message" | sed "s/'/'\\\\''/g")

# === SENDING TO NTFY ===
command="curl -s"
command="${command} --connect-timeout 100"
command="${command} --max-time 100"

# Add a proxy, if available
if [ -n "$PROXY_OPTS" ]; then
    command="${command} ${PROXY_OPTS}"
fi

# Headlines
command="${command} -H 'Title: Motion Detected'"
command="${command} -H 'Priority: ${ntfy_priority}'"
command="${command} -H 'Tags: warning,rotating_light'"
command="${command} -H 'Message: ${esc_message}'"
command="${command} -H 'Filename: ${esc_name}'"
command="${command} -H 'Content-Type: ${content_type}'"

# Sending a file
command="${command} -T '${esc_path}'"
command="${command} '${ntfy_server}/${ntfy_topic}'"

# Login and password
if [ -n "$ntfy_user" ]; then
    command="${command} -u ${ntfy_user}:${ntfy_pass}"
fi

# Execution
#
# The command line is not echoed: it carries -u user:pass. And the send is
# judged on the HTTP code rather than assumed -- this used to end in a bare
# `exit 0`, so a rejected topic, a wrong password and a delivered notification
# were one answer, and ntfy.cgi's test button printed OK for all three.
#
# --write-out rather than --fail-with-body: curl is pinned at 7.76.0 in the
# firmware, the very release that added --fail-with-body, so going through the
# status code leaves no version floor to trip over later.
body=$workdir/response.txt
command="${command} --output '${body}' --write-out '%{http_code}'"

http=$(eval "$command")
[ -s "$body" ] && cat "$body"

case "$http" in
2*) exit 0 ;;
*)
    echo "ntfy refused the upload (HTTP ${http:-none})"
    exit 1
    ;;
esac
