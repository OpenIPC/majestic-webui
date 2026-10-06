#!/bin/sh
# The SMS page's view of the modem: messages, deleting them, sending one, and
# a USSD request. Every request names an act and gets back the transcript of
# what sbin/modem-at sent and what the modem answered, as
#
#   {"rc":0,"error":"","lines":["=> AT+CMGL=4","+CMGL: 0,1,,156","0791…",…]}
#
# and nothing else. Reading PDUs, joining multi-part messages and decoding a
# USSD answer happen in www/a/sms-pdu.js, which a test can feed real
# captures; this script decides only which AT commands an act is, and takes
# nothing from the request that is not checked against a pattern first.
#
#   GET  ?act=list                    every message in every storage
#   POST ?act=delete&del=ME.3,SM.0    those, by storage and index
#   POST ?act=delete-all              everything in every storage
#   POST ?act=send&pdu=LEN:HEX,…      one SMS, as encoded by the page
#   POST ?act=ussd&code=*105%23       one USSD request and its answer
#
# Storages are those the modem lists for reading, less MT (the union of SM
# and ME, so its messages would be listed twice) and anything that is not a
# message store (SR status reports, BM cell broadcast).

# The writes are POST only, and refused when a form on another site could
# have made them -- the reasoning is j/ptz.cgi's, and so is the test.
fail() {
	printf 'HTTP/1.1 %s\nContent-type: text/plain; charset=UTF-8\nCache-Control: no-store\n\n%s\n' "$1" "$2"
	exit 1
}

act="" del="" pdu="" code=""
for param in $(echo "$QUERY_STRING" | tr '&' ' '); do
	case "$param" in
		act=*) act="${param#*=}" ;;
		del=*) del="${param#*=}" ;;
		pdu=*) pdu="${param#*=}" ;;
		code=*) code="${param#*=}" ;;
	esac
done

if [ "$act" != "list" ]; then
	[ "$REQUEST_METHOD" = "POST" ] || fail "405 Method Not Allowed" "Use POST."
	if [ -n "$HTTP_REFERER" ]; then
		ref_origin="${HTTP_REFERER#*://}"
		ref_origin="${ref_origin%%/*}"
		[ "$ref_origin" = "$HTTP_HOST" ] || fail "400 Bad Request" "Cross-site request refused."
	fi
	case "$CONTENT_TYPE" in
		application/x-www-form-urlencoded*|multipart/form-data*|text/plain*)
			fail "400 Bad Request" "Cross-site request refused." ;;
	esac
fi

printf 'HTTP/1.1 200 OK\nContent-Type: application/json\nCache-Control: no-store\n\n'

reply() {
	printf '{"rc":%s,"error":"%s","lines":[' "$1" "$2"
	printf '%s' "$3" | awk '
		{ gsub(/[\001-\037]/, ""); gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); printf "%s\"%s\"", (NR > 1 ? "," : ""), $0 }'
	printf ']}'
	exit 0
}

run() {
	out=$(modem-at "$@" 2>/tmp/webui-sms.$$)
	rc=$?
	err=$(head -n 1 /tmp/webui-sms.$$ | tr -d '"\\')
	rm -f /tmp/webui-sms.$$
	reply "$rc" "$err" "$out"
}

command -v modem-at >/dev/null || reply 1 "modem-at is not installed" ""

mems() {
	modem-at "AT+CPMS=?" 2>/dev/null | sed -n 's/^+CPMS: *(\([^)]*\)).*/\1/p' | tr -d '"' | tr ',' '\n' |
		grep -xE 'SM|ME'
}

case "$act" in
list)
	# Listing marks every message read, and read is how sms-forward knows a
	# message is not new. Collect first, or a message this page showed before
	# cron came round would never reach Telegram; cron does the sending.
	[ -e /etc/webui/sms.conf ] && . /etc/webui/sms.conf
	if [ "$sms_forward" = "telegram" ] && ! sms-forward --collect >/dev/null 2>&1; then
		reply 1 "new messages could not be taken for Telegram yet, so they are not listed; try again in a minute" ""
	fi
	set -- "AT+CMGF=0"
	for m in $(mems); do set -- "$@" "AT+CPMS=\"$m\"" "AT+CMGL=4"; done
	[ $# -gt 1 ] || reply 1 "the modem lists no SMS storage" ""
	run -t 10 "$@"
	;;
delete)
	# ME.3,ME.4,SM.0 -- grouped so each storage is selected once.
	echo "$del" | grep -qE '^(SM|ME)\.[0-9]{1,3}(,(SM|ME)\.[0-9]{1,3}){0,49}$' || reply 1 "bad message list" ""
	set --
	for m in SM ME; do
		idx=$(echo "$del" | tr ',' '\n' | sed -n "s/^$m\.//p")
		[ -n "$idx" ] || continue
		set -- "$@" "AT+CPMS=\"$m\""
		for i in $idx; do set -- "$@" "AT+CMGD=$i"; done
	done
	run "$@"
	;;
delete-all)
	set --
	for m in $(mems); do set -- "$@" "AT+CPMS=\"$m\"" "AT+CMGD=1,4"; done
	[ $# -gt 0 ] || reply 1 "the modem lists no SMS storage" ""
	run -t 20 "$@"
	;;
send)
	# Sized by hand: musl's regex refuses a repeat count over 255, and a PDU
	# runs to 352 hex digits. Ten parts at most, as the page sends.
	echo "$pdu" | grep -qE '^[0-9]{1,3}:[0-9A-F]+(,[0-9]{1,3}:[0-9A-F]+)*$' || reply 1 "bad message" ""
	[ ${#pdu} -le 3600 ] && [ "$(echo "$pdu" | tr -cd ',' | wc -c)" -lt 10 ] || reply 1 "bad message" ""
	set -- "AT+CMGF=0"
	for p in $(echo "$pdu" | tr ',' ' '); do set -- "$@" "PDU:$p"; done
	run "$@"
	;;
ussd)
	code=$(printf '%s' "$code" | sed 's/%23/#/g; s/%2[Aa]/*/g')
	echo "$code" | grep -qE '^[0-9*#]{1,32}$' || reply 1 "bad code" ""
	out=$(modem-at -t 30 -w "+CUSD:" "AT+CSCS=\"GSM\"" "AT+CUSD=1,\"$code\",15" 2>/tmp/webui-sms.$$)
	rc=$?
	err=$(head -n 1 /tmp/webui-sms.$$ | tr -d '"\\')
	rm -f /tmp/webui-sms.$$
	# A menu waits for an answer this page does not give; close it, or the
	# next request meets a session the network still holds open.
	case "$out" in *"+CUSD: 1"*) modem-at "AT+CUSD=2" >/dev/null 2>&1 ;; esac
	reply "$rc" "$err" "$out"
	;;
*)
	reply 1 "unknown act" ""
	;;
esac
