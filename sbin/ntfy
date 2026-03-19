#!/bin/sh

# === LOADING CONFIGURATION ===
CONFIG_FILE="/etc/webui/ntfy.conf"
if [ -e "$CONFIG_FILE" ]; then
    source "$CONFIG_FILE"
else
    echo "Config file $CONFIG_FILE not found"
    exit 1
fi

# === CHECKS ===
if [ "$ntfy_enabled" != "true" ]; then
    echo "Sending to Ntfy is not enabled"
    exit 0
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

# === SNAPSHOT CREATION ===
filename="$(hostname -s | tr ' ' '-')"-"$(date +'%Y%m%d-%H%M%S')"

# Format verification (HEIF or JPG)
if [ "$ntfy_heif" = "true" ] && [ "$(yaml-cli -g .video0.codec)" = "h265" ]; then
    snapshot=/tmp/${filename}.heif
    wget -q -T1 localhost/image.heif -O "$snapshot"
else
    snapshot=/tmp/${filename}.jpg
    wget -q -T1 localhost/image.jpg -O "$snapshot"
fi

if [ ! -e "$snapshot" ]; then
    echo "Snapshot file not found"
    exit 1
fi

# === PROXY CONFIGURATION (Takes from the standard OpenIPC config) ===
PROXY_OPTS=""
if [ -e "/etc/webui/proxy.conf" ]; then
    source /etc/webui/proxy.conf
    if [ "$openwall_proxy_enabled" = "true" ]; then
        PROXY_OPTS="--socks5-hostname ${socks5_host}:${socks5_port}"
        if [ -n "$socks5_login" ] && [ -n "$socks5_password" ]; then
            PROXY_OPTS="${PROXY_OPTS} --proxy-user ${socks5_login}:${socks5_password}"
        fi
    fi
fi

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
command="${command} -H 'Message: ${ntfy_message}'"
command="${command} -H 'Filename: $(basename $snapshot)'"

# Sending a file
command="${command} -T '${snapshot}'"
command="${command} '${ntfy_server}/${ntfy_topic}'"

# Login and password
if [ -n "$ntfy_user" ]; then
    command="${command} -u ${ntfy_user}:${ntfy_pass}"
fi


# Execution
echo "$command"
eval "$command"

# Delete the temporary file
rm -f "$snapshot"

exit 0
