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

# What to send, in the order the answers are allowed to win: the caller's file,
# the caller's word, then the configuration.
#
# --clip and --image are for a webhook that knows what it wants -- a doorbell
# button asking for video, a dashboard asking for a thumbnail -- and are read
# before the path, because a path is the one argument that means "send this, I
# have already made it". sbin/telegram takes the same two.
mode=config
case "$1" in
--clip)
    mode=clip
    shift
    ;;
--image)
    mode=image
    shift
    ;;
esac

# A clip of one's own: how many seconds of it, clamped. A configured value is
# an operator's, so it is checked rather than trusted -- it reaches a URL and
# an arithmetic expansion, and the page that usually writes it is not the only
# thing that can.
clip_seconds=$ntfy_video_seconds
case "$clip_seconds" in
'' | *[!0-9]* | ????*) clip_seconds=10 ;;
esac
[ "$clip_seconds" -lt 1 ] && clip_seconds=10
[ "$clip_seconds" -gt 60 ] && clip_seconds=60

filename="$(hostname -s | tr ' ' '-')"-"$(date +'%Y%m%d-%H%M%S')"

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
elif [ "$mode" = "clip" ] ||
    { [ "$mode" = "config" ] && [ "$ntfy_video" = "true" ]; }; then
    # The camera records this one itself. It needs no card and no recorder --
    # /video.mp4 holds the muxer up for as long as this request is open and
    # gives it back afterwards -- so it is the one way a camera with no
    # storage can push what it saw rather than what it can see now.
    #
    # ?pre= asks for the seconds BEFORE the request as well, and is usually
    # answered with none. The camera holds a run-up only while another
    # request that asked for one is open -- in practice another send still
    # running -- so a lone one starts at the trigger. Watching the Live page
    # does not make one: that is WebRTC or MSE, and neither asks this
    # endpoint for anything. Measured on an hi3516ev300, a second send six
    # seconds into a ten-second capture opened four seconds earlier than it
    # was started; the first got nothing. The response says which, and so
    # does the line printed below.
    #
    # The deadline is the clip plus half a minute: ?duration= counts media
    # rather than wall clock, the first fragment can be a GOP away, and the
    # cut lands on a whole fragment after that.
    snapshot=$workdir/${filename}.mp4
    content_type="video/mp4"
    http=$(curl --silent --show-error \
        --max-time $((clip_seconds + 30)) \
        --dump-header "$workdir/clip.head" \
        --output "$snapshot" --write-out '%{http_code}' \
        "localhost/video.mp4?pre=${clip_seconds}&duration=${clip_seconds}")
    rc=$?

    # Three ways this is not a clip, and the first is the one a status line
    # cannot show. curl writes the code it was given the moment the headers
    # arrive, so a transfer that stalls, resets or runs into the deadline
    # after a 200 leaves a partial file behind a successful-looking status.
    # Its own exit status is what says the body arrived whole, and a
    # half-written video is worse than no video: it plays, up to the point
    # where it stops, and nothing about it says it was cut.
    #
    # An empty 200 is a refusal too -- a reply that ends before it carries a
    # fragment is the shape a torn-down pipeline leaves behind.
    if [ "$rc" -ne 0 ]; then
        echo "The clip did not arrive whole (curl exit ${rc})"
        exit 1
    fi
    if [ "$http" != "200" ] || [ ! -s "$snapshot" ]; then
        echo "The camera would not record a clip (HTTP ${http:-none})"
        exit 1
    fi

    # The camera says how much of the clip came from before the request. An
    # ABSENT header is not a run-up of zero -- it is a camera that did not
    # say -- so the sentence loses the clause rather than inventing a figure.
    run_up=$(sed -n 's/^[Xx]-[Pp]re[Rr]oll-[Ss]econds:[[:space:]]*\([0-9][0-9]*\).*/\1/p' \
        "$workdir/clip.head")
    if [ -n "$run_up" ]; then
        echo "Recorded ${clip_seconds}s, run-up ${run_up}s"
    else
        echo "Recorded ${clip_seconds}s"
    fi
else
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

# === SENDING TO NTFY ===
#
# An argument list, not a command line handed to eval.
#
# Every value below crosses into curl from somewhere a person can type: the
# server, topic, priority and credentials come off the ntfy page, the message
# is free prose, and the path is a recording name built from an operator's
# strftime pattern. The version this replaced pasted them all into one string
# and eval'd it, so a single quote anywhere ended the quoting and handed the
# rest of the upload to sh. Three of the values were escaped by hand against
# exactly that; the password, which is the likeliest of the lot to hold a
# space or a dollar sign, was pasted in bare (#547).
#
# Passing "$@" retires the question. Nothing here is re-parsed by a shell, so
# no value needs escaping and none can be split, globbed or truncated -- and
# the hand-rolled escaping those three carried is gone with the eval that
# required it.
set -- curl -s --connect-timeout 100 --max-time 100

# Add a proxy, if available
if [ "$ntfy_proxy" = "true" ] && [ -e "/etc/webui/proxy.conf" ]; then
    . /etc/webui/proxy.conf
    set -- "$@" --socks5-hostname "${socks5_host}:${socks5_port}"
    if [ -n "$socks5_username" ] && [ -n "$socks5_password" ]; then
        set -- "$@" --proxy-user "${socks5_username}:${socks5_password}"
    fi
fi

# Headlines
set -- "$@" -H "Title: Motion Detected"
set -- "$@" -H "Priority: ${ntfy_priority}"
set -- "$@" -H "Tags: warning,rotating_light"
set -- "$@" -H "Message: ${ntfy_message}"
set -- "$@" -H "Filename: $(basename "$snapshot")"
set -- "$@" -H "Content-Type: ${content_type}"

# Sending a file
set -- "$@" -T "$snapshot"
set -- "$@" "${ntfy_server}/${ntfy_topic}"

# Login and password
if [ -n "$ntfy_user" ]; then
    set -- "$@" -u "${ntfy_user}:${ntfy_pass}"
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
set -- "$@" --output "$body" --write-out '%{http_code}'

http=$("$@")
[ -s "$body" ] && cat "$body"

case "$http" in
2*) exit 0 ;;
*)
    echo "ntfy refused the upload (HTTP ${http:-none})"
    exit 1
    ;;
esac
