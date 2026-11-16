#!/bin/sh

JSON_FILE="/tmp/af_peaks.json"

. "$(dirname "$0")/../p/ptz_common.sh"

# Clear cached candidate peaks: POST ?clear=1
if echo "$QUERY_STRING" | grep -q 'clear=1'; then
    if [ "$REQUEST_METHOD" != "POST" ]; then
        echo "HTTP/1.1 405 Method Not Allowed"
        echo "Content-Type: text/plain"
        echo "Allow: POST"
        echo ""
        echo "Use POST to clear peaks."
        exit 0
    fi
    ptz_reject_cross_site
    rm -f "$JSON_FILE" /tmp/peak_*.jpg
    echo "HTTP/1.1 200 OK"
    echo "Content-Type: application/json"
    echo "Cache-Control: no-store"
    echo ""
    echo '{"ok":true,"cleared":true}'
    exit 0
fi

# Serve candidate JPEG: GET ?img=N
IMG=$(echo "$QUERY_STRING" | sed -n 's/.*img=\([0-9][0-9]*\).*/\1/p')
if [ -n "$IMG" ]; then
    FILE="/tmp/peak_${IMG}.jpg"
    if [ -f "$FILE" ]; then
        echo "HTTP/1.1 200 OK"
        echo "Content-Type: image/jpeg"
        echo "Cache-Control: no-store"
        echo ""
        cat "$FILE"
        exit 0
    fi
    echo "HTTP/1.1 404 Not Found"
    echo "Content-Type: text/plain"
    echo ""
    echo "Image not found"
    exit 0
fi

# Move lens to candidate: POST ?select=N
SELECT_ID=$(echo "$QUERY_STRING" | sed -n 's/.*select=\([0-9][0-9]*\).*/\1/p')
if [ -n "$SELECT_ID" ]; then
    if [ "$REQUEST_METHOD" != "POST" ]; then
        echo "HTTP/1.1 405 Method Not Allowed"
        echo "Content-Type: text/plain"
        echo "Allow: POST"
        echo ""
        echo "Use POST to select a peak."
        exit 0
    fi
    ptz_reject_cross_site
    if [ ! -f "$JSON_FILE" ]; then
        echo "HTTP/1.1 404 Not Found"
        echo "Content-Type: application/json"
        echo ""
        echo '{"ok":false,"error":"no candidates available"}'
        exit 0
    fi

    INFO=$(awk -v id="$SELECT_ID" '{
        s=$0; sub(/.*"current_pos":/, "", s); cur=s+0
        s=$0; sub(/.*"last_dir":/, "", s); ldir=s+0
        s=$0; sub(/.*"recovery_ms":/, "", s); rec=s+0
        pat="\"id\":" id ",\"pos\":"
        idx=index($0, pat)
        if (idx>0) {
            t=substr($0, idx+length(pat))+0
            printf "%d %d %d %d\n", cur, ldir, rec, t
        }
    }' "$JSON_FILE")

    if [ -z "$INFO" ]; then
        echo "HTTP/1.1 400 Bad Request"
        echo "Content-Type: application/json"
        echo ""
        echo '{"ok":false,"error":"candidate id not found"}'
        exit 0
    fi

    set -- $INFO
    CUR=$1
    LDIR=$2
    REC=$3
    TARGET=$4
    DELTA=$((TARGET - CUR))
    NEW_DIR=$LDIR
    DRIVE_MS=0
    CMD=""

    if [ "$DELTA" -ne 0 ]; then
        if [ "$DELTA" -gt 0 ]; then
            NEW_DIR=1
            CMD="far"
            MS=$DELTA
        else
            NEW_DIR=-1
            CMD="near"
            MS=$((-DELTA))
        fi
        BACKLASH=0
        if [ "$LDIR" -ne 0 ] && [ "$NEW_DIR" -ne "$LDIR" ]; then
            BACKLASH=$REC
        fi
        DRIVE_MS=$((MS + BACKLASH))
        if [ "$DRIVE_MS" -gt 0 ]; then
            if ! mkdir /tmp/ptz_job.lock 2>/dev/null; then
                old_pid=$(cat /tmp/ptz_job.lock/pid 2>/dev/null)
                if [ -z "$old_pid" ] || ! kill -0 "$old_pid" 2>/dev/null; then
                    rm -rf /tmp/ptz_job.lock
                    mkdir /tmp/ptz_job.lock 2>/dev/null
                else
                    echo "HTTP/1.1 409 Conflict"
                    echo "Content-Type: application/json"
                    echo ""
                    echo '{"ok":false,"error":"Another PTZ move is in progress"}'
                    exit 0
                fi
            fi
            echo "$$" > /tmp/ptz_job.lock/pid
            trap 'rm -rf /tmp/ptz_job.lock' EXIT
            /usr/bin/motors-cli --socket /run/motorsd.sock "$CMD" "$DRIVE_MS" >/dev/null 2>&1
            RC=$?
            if [ "$RC" -ne 0 ]; then
                echo "HTTP/1.1 500 Internal Server Error"
                echo "Content-Type: application/json"
                echo ""
                echo '{"ok":false,"error":"motors-cli failed"}'
                exit 0
            fi
            ptz_read_pos
            ptz_write_pos "$PAN_MS" "$TILT_MS" "$((FOCUS_MS + DELTA))" 1
        fi
    fi

    awk -v tgt="$TARGET" -v ldir="$NEW_DIR" -v win="$SELECT_ID" '{
        sub(/"current_pos":[-0-9]+/, "\"current_pos\":" tgt)
        sub(/"last_dir":[-0-9]+/, "\"last_dir\":" ldir)
        sub(/"winner":[-0-9]+/, "\"winner\":" win)
        print
    }' "$JSON_FILE" > "${JSON_FILE}.tmp" && mv "${JSON_FILE}.tmp" "$JSON_FILE"

    echo "HTTP/1.1 200 OK"
    echo "Content-Type: application/json"
    echo "Cache-Control: no-store"
    echo ""
    echo "{\"ok\":true,\"selected\":$SELECT_ID,\"target_pos\":$TARGET,\"moved_ms\":$DRIVE_MS,\"dir\":\"${CMD:-none}\"}"
    exit 0
fi

# Default GET: return candidate manifest
echo "HTTP/1.1 200 OK"
echo "Content-Type: application/json"
echo "Cache-Control: no-store"
echo ""
if [ -f "$JSON_FILE" ]; then
    cat "$JSON_FILE"
else
    echo '{"count":0,"candidates":[]}'
fi
