#!/usr/bin/haserl
<%
IFS_ORIG=$IFS

# tag "tag" "text" "css" "extras"
tag() {
	local t="$1"
	local n="$2"
	local c="$3"
	[ -n "$c" ] && c=" class=\"${c}\""
	local x="$4"
	[ -n "$x" ] && x=" ${x}"
	echo "<${t}${c}${x}>${n}</${t}>"
}

# A "tag" "classes" "extras"
A() {
	local c="$2"
	[ -n "$c" ] && c=" class=\"${c}\""
	local x="$3"
	[ -n "$x" ] && x=" ${x}"
	echo "<${1}${c}${x}>"
}

Z() {
	echo "</${1}>"
}

# tag "text" "classes" "extras"
div() {
	tag "div" "$1" "$2" "$3"
}

h1() {
	tag "h1" "$1" "$2" "$3"
}

h2() {
	tag "h2" "$1" "$2" "$3"
}

h3() {
	tag "h3" "$1" "$2" "$3"
}

h4() {
	tag "h4" "$1" "$2" "$3"
}

h5() {
	tag "h5" "$1" "$2" "$3"
}

h6() {
	tag "h6" "$1" "$2" "$3"
}

label() {
	tag "label" "$1" "$2" "$3"
}

li() {
	tag "li" "$1" "$2" "$3"
}

p() {
	tag "p" "$1" "$2" "$3"
}

span() {
	tag "span" "$1" "$2" "$3"
}

div_() {
	A "div" "$1" "$2"
}

_div() {
	Z "div"
}

span_() {
	A "span" "$1" "$2"
}

_span() {
	Z "span"
}

# alert "text" "type" "extras"
alert() {
	echo "<div class=\"alert alert-${2}\" ${3}>${1}</div>"
}

button_restore_from_rom() {
	local file="$1"
	[ ! -f "/rom/${file}" ] && return
	if [ -z "$(diff "/rom/${file}" "${file}")" ]; then
		echo "<p class=\"small fst-italic\">File matches the version in ROM.</p>"
		return
	fi
	echo "<p><a class=\"btn btn-danger\" href=\"restore.cgi?f=${file}\">Replace ${file} with defaults</a></p>"
}

# button_submit "text" "type" "extras"
button_submit() {
	local t="$1"
	[ -z "$t" ] && t="Save changes"
	local c="$2"
	[ -z "$c" ] && c="primary"
	local x="$3"
	[ -z "$x" ] && x=" ${x}"
	echo "<div class=\"mt-2\"><input type=\"submit\" class=\"btn btn-${c}\"${x} value=\"${t}\"></div>"
}

check_file_exist() {
	[ ! -f "$1" ] && redirect_back "danger" "File ${1} not found"
}

check_password() {
	local p="/cgi-bin/webui-settings.cgi"
	[ "0${debug}" -ge "1" ] && return
	[ -z "$SCRIPT_NAME" ] || [ "$SCRIPT_NAME" = "${p}" ] && return
	if [ ! -f /etc/shadow- ] || [ -z $(grep root /etc/shadow- | cut -d: -f2) ]; then
		redirect_to "${p}" "danger" "You must set your own secure password!"
	fi
}

checked_if() {
	[ "$1" = "$2" ] && echo -n " checked"
}

d() {
	echo "$1" >&2
}

e() {
	echo -e -n "$1"
}

ex() {
	echo "<div class=\"${2:-ex}\"><h6># ${1}</h6><pre class=\"small\">"
	eval "$1" | sed "s/&/\&amp;/g;s/</\&lt;/g;s/>/\&gt;/g;s/\"/\&quot;/g"
	echo "</pre></div>"
}

# field_boolean "label" "name" "value" "hint"
field_boolean() {
	local l="$1"
	local n="$2"
	local v="$3"
	local h="$4"
	echo "<p class=\"boolean\"><span class=\"form-check form-switch\">" \
		"<input type=\"hidden\" id=\"${n}-false\" name=\"${n}\" value="false">" \
		"<input type=\"checkbox\" id=\"${n}\" name=\"${n}\" value="true" class=\"form-check-input\"$(checked_if "true" "$v")>" \
		"<label for=\"${n}\" class=\"form-check-label\">${l}</label></span>"
	[ -n "$h" ] && echo "<span class=\"hint text-secondary\">${h}</span>"
	echo "</p>"
}

# field_integer "label" "name" "value" "min" "max" "hint"
field_integer() {
	local l="$1"
	local n="$2"
	local v="$3"
	local x="$4"
	local y="$5"
	local h="$6"
	echo "<p class=\"number\">" \
		"<label class=\"form-label\" for=\"${n}\">${l}</label>" \
		"<span class=\"input-group\">"
	echo "<input type=\"number\" id=\"${n}\" name=\"${n}\" class=\"form-control text-end\" value=\"${v}\" min=\"${x}\" max=\"${y}\" step="1">" \
		"</span>"
	[ -n "$h" ] && echo "<span class=\"hint text-secondary\">${h}</span>"
	echo "</p>"
}

# field_range "label" "name" "value" "min" "max" "hint"
field_range() {
	local l="$1"
	local n="$2"
	local v="$3"
	local x="$4"
	local y="$5"
	local h="$6"
	echo "<p class=\"range\" id=\"${n}_wrap\">" \
		"<label for=\"${n}\" class=\"form-label\">${l}</label>" \
		"<span class=\"input-group\">"
	echo "<input type=\"hidden\" id=\"${n}\" name=\"${n}\" value=\"${v}\">"
	echo "<input type=\"range\" class=\"form-control form-range\" id=\"${n}-range\" value=\"${v}\" min=\"${x}\" max=\"${y}\" step="1">"
	echo "<span class=\"input-group-text show-value\" id=\"${n}-show\">${v}</span></span>"
	[ -n "$h" ] && echo "<span class=\"hint text-secondary\">${h}</span>"
	echo "</p>"
}

# field_string "label" "name" "value" "enum" "hint"
field_string() {
	local l="$1"
	local n="$2"
	local v="$3"
	local e="$4"
	local h="$5"
	if [ -n "$e" ]; then
		echo "<p class=\"select\" id=\"${n}_wrap\">" \
			"<label for=\"${n}\" class=\"form-label\">${l}</label>" \
			"<select class=\"form-select\" id=\"${n}\" name=\"${n}\">"
		[ -z "$v" ] && echo "<option value=\"\">Select from options</option>"
		for e in $e; do
			echo -n "<option value=\"${e}\""
			[ "$v" = "$e" ] && echo -n " selected"
			echo ">${e}</option>"
		done
		echo "</select>"
	else
		echo "<p class=\"string\" id=\"${n}_wrap\">" \
			"<label for=\"${n}\" class=\"form-label\">${l}</label>" \
			"<input type=\"text\" id=\"${n}\" name=\"${n}\" class=\"form-control\" value=\"${v}\">"
	fi
	[ -n "$h" ] && echo "<span class=\"hint text-secondary\">${h}</span>"
	echo "</p>"
}

# field_checkbox "name" "label" "hint"
field_checkbox() {
	local l=$2
	[ -z "$l" ] && l="$(t_label "$1")"
	[ -z "$l" ] && l="<span class=\"bg-warning\">${1}</span>"
	local h=$3
	local v=$(t_value "$1")
	[ -z "$v" ] && v="false"
	echo "<p class=\"boolean form-check\">" \
		"<input type=\"hidden\" id=\"${1}-false\" name=\"${1}\" value=\"false\">" \
		"<input type=\"checkbox\" name=\"${1}\" id=\"${1}\" value=\"true\" class=\"form-check-input\"$(checked_if "true" "$v")>" \
		"<label for=\"${1}\" class=\"form-label\">${l}</label>"
	[ -n "$h" ] && echo "<span class=\"hint text-secondary d-block mb-2\">${h}</span>"
	echo "</p>"
}

# field_hidden "name" "value"
field_hidden() {
	echo "<input type=\"hidden\" name=\"${1}\" id=\"${1}\" value=\"${2}\" class=\"form-hidden\">"
}

# field_password "name" "label" "hint"
field_password() {
	local l=$2
	[ -z "$l" ] && l="$(t_label "$1")"
	[ -z "$l" ] && l="<span class=\"bg-warning\">${1}</span>"
	local h=$3
	local v=$(t_value "$1")
	echo "<p class=\"password\" id=\"${1}_wrap\">" \
		"<label for=\"${1}\" class=\"form-label\">${l}</label><span class=\"input-group\">" \
		"<input type=\"password\" id=\"${1}\" name=\"${1}\" class=\"form-control\" value=\"${v}\" placeholder=\"K3wLHaZk3R!\">" \
		"<label class=\"input-group-text\">" \
		"<input type=\"checkbox\" class=\"form-check-input me-1\" data-for=\"${1}\"> show" \
		"</label></span>"
	[ -n "$h" ] && echo "<span class=\"hint text-secondary\">${h}</span>"
	echo "</p>"
}

# field_select "name" "label" "options" "hint" "units"
field_select() {
	local l=$2
	[ -z "$l" ] && l="$(t_label "$1")"
	[ -z "$l" ] && l="<span class=\"bg-warning\">${1}</span>"
	local o=$3
	o=${o//,/ }
	local h=$4
	local u=$5
	echo "<p class=\"select\" id=\"${1}_wrap\">" \
		"<label for=\"${1}\" class=\"form-label\">${l}</label>" \
		"<select class=\"form-select\" id=\"${1}\" name=\"${1}\">"
	[ -z "$(t_value "$1")" ] && echo "<option value=\"\">Select from available options</option>"
	for o in $o; do
		v="${o%:*}"
		n="${o#*:}"
		echo -n "<option value=\"${v}\""
		[ "$(t_value "$1")" = "$v" ] && echo -n " selected"
		echo ">${n}</option>"
		unset v; unset n
	done
	echo "</select>"
	[ -n "$u" ] && echo "<span class=\"input-group-text\">${u}</span>"
	[ -n "$h" ] && echo "<span class=\"hint text-secondary\">${h}</span>"
	echo "</p>"
}

# field_swith "name" "label" "hint" "options"
field_switch() {
	local l=$2
	[ -z "$l" ] && l="$(t_label "$1")"
	[ -z "$l" ] && l="<span class=\"bg-warning\">$1</span>"
	local v=$(t_value "$1")
	[ -z "$v" ] && v="false"
	local h="$3"
	local o=$4
	[ -z "$o" ] && o="true,false"
	local o1=$(echo "$o" | cut -d, -f1)
	local o2=$(echo "$o" | cut -d, -f2)
	echo "<p class=\"boolean\">" \
		"<span class=\"form-check form-switch\">" \
		"<input type=\"hidden\" id=\"${1}-false\" name=\"${1}\" value=\"${o2}\">" \
		"<input type=\"checkbox\" id=\"${1}\" name=\"${1}\" value=\"${o1}\" role=\"switch\" class=\"form-check-input\"$(checked_if "$o1" "$v")>" \
		"<label for=\"$1\" class=\"form-check-label\">${l}</label>" \
		"</span>"
	[ -n "$h" ] && echo "<span class=\"hint text-secondary\">${h}</span>"
	echo "</p>"
}

# field_text "name" "label" "hint" "placeholder"
field_text() {
	local l=$2
	[ -z "$l" ] && l="$(t_label "$1")"
	[ -z "$l" ] && l="<span class=\"bg-warning\">$1</span>"
	local v="$(t_value "$1")"
	local h="$3"
	local p="$4"
	echo "<p class=\"string\" id=\"${1}_wrap\">" \
		"<label for=\"${1}\" class=\"form-label\">${l}</label>" \
		"<input type=\"text\" id=\"${1}\" name=\"${1}\" class=\"form-control\" value=\"${v}\" placeholder=\"${p}\">"
	[ -n "$h" ] && echo "<span class=\"hint text-secondary\">${h}</span>"
	echo "</p>"
}

# field_textedit "name" "file" "label"
field_textedit() {
	local l=$3
	[ -z "$l" ] && l="$(t_label "$1")"
	[ -z "$l" ] && l="<span class=\"bg-warning\">$1</span>"
	local v=$(cat "$2")
	echo "<p class=\"textarea\" id=\"${1}_wrap\">" \
		"<label for=\"${1}\" class=\"form-label\">${l}</label>" \
		"<textarea id=\"${1}\" name=\"${1}\" class=\"form-control\">${v}</textarea>"
	echo "</p>"
}

flash_append() {
	echo "$1:$2" >> "$flash_file"
}

flash_delete() {
	:>"$flash_file"
}

flash_read() {
	[ ! -f "$flash_file" ] && return
	[ -z "$(cat $flash_file)" ] && return
	local c
	local m
	local l
	OIFS="$IFS"
	IFS=$'\n'
	for l in $(cat "$flash_file"); do
		c="$(echo $l | cut -d':' -f1)"
		m="$(echo $l | cut -d':' -f2-)"
		echo "<div class=\"alert alert-${c} alert-dismissible fade show\" role=\"alert\">${m}" \
			"<button type=\"button\" class=\"btn btn-close\" data-bs-dismiss=\"alert\" aria-label=\"Close\"></button>" \
			"</div>"
	done
	IFS=$OIFS
	flash_delete
}

flash_save() {
	echo "${1}:${2}" > $flash_file
}

get_config() {
	echo ${1}/etc/majestic.yaml
}

get_json() {
	local m=/tmp/webui/config.json
	if [ ! -e "$m" ]; then
		wget -T1 -q localhost/api/v1/config.json -O "$m"
	fi
	echo "$m"
}

get_metrics() {
	local m=$(pidof majestic)
	if [ -z "$m" ]; then
		echo 0
	else
		wget -T1 -q -O - localhost/metrics/night?value=${1}
	fi
}

get_schema() {
	local m=/tmp/webui/schema.json
	if [ ! -e "$m" ]; then
		wget -T1 -q localhost/api/v1/config.schema.json -O "$m"
	fi
	echo "$m"
}

get_yaml() {
	local m=$(pidof majestic)
	local v=$(yaml-cli -g $1)
	if [ -n "$m" ] && [ -n "$v" ]; then
		echo 1
	else
		echo 0
	fi
}

html_title() {
	[ -n "$page_title" ] && echo -n "$page_title"
	[ -n "$title" ] && echo -n ": $title"
	echo -n " - OpenIPC"
}

include() {
	[ -f "$1" ] && . "$1"
}

# label "name" "classes" "extras" "units"
label() {
	local c="form-label"
	[ -n "$2" ] && c="${c} ${2}"
	local l="$(t_label "$1")"
	[ -z "$l" ] && l="$1" && c="${c} bg-warning"
	local x="$3"
	[ -n "$x" ] && x=" ${x}"
	local u="$4"
	[ -n "$u" ] && l="${l}, <span class=\"units text-secondary x-small\">$u</span>"
	echo "<label for=\"${1}\" class=\"${c}\"${x}>${l}</label>"
}

link_to() {
	echo "<a href=\"${2}\">${1}</a>"
}

# pre "text" "classes" "extras"
pre() {
	# replace <, >, &, ", and ' with HTML entities
	tag "pre" "$(echo -e "$1" | sed "s/&/\&amp;/g;s/</\&lt;/g;s/>/\&gt;/g;s/\"/\&quot;/g")" "$2" "$3"
}

preview() {
	if [ "true" = "$(yaml-cli -g .jpeg.enabled)" ]; then
		echo "<video poster=\"/mjpeg\" style=\"background:url(/a/preview.svg); background-size:cover; width:100%\"></video>"
	else
		echo "<p class=\"alert alert-warning\"><a href=\"majestic-settings.cgi?tab=jpeg\">Enable JPEG support</a> to see the preview.</p>"
	fi
}

progressbar() {
	local c="primary"
	[ "$1" -ge "75" ] && c="danger"
	echo "<div class=\"progress\" role=\"progressbar\" aria-valuenow=\"${1}\" aria-valuemin=\"0\" aria-valuemax=\"100\">" \
		"<div class=\"progress-bar progress-bar-striped progress-bar-animated bg-${c}\" style=\"width:${1}%\"></div>" \
		"</div>"
}

# redirect_back "flash class" "flash text"
redirect_back() {
	redirect_to "${HTTP_REFERER:-/}" "$1" "$2"
}

# redirect_to "url" "flash class" "flash text"
redirect_to() {
	[ -n "$3" ] && flash_save "$2" "$3"
	echo "HTTP/1.1 303 See Other"
	echo "Content-type: text/html; charset=UTF-8"
	echo "Cache-Control: no-store"
	echo "Pragma: no-cache"
	echo "Date: $(TZ=GMT0 date +'%a, %d %b %Y %T %Z')"
	echo "Server: $SERVER_SOFTWARE"
	echo "Location: $1"
	echo
	exit 0
}

# row_ "class"
row_() {
	echo "<div class\"row ${1}\" ${2}>"
}

_row() {
	echo "</div>"
}

row() {
	row_ "$2"
	echo "$1"
	_row
}

report_command() {
	echo "<h4># ${1}</h4>"
	echo "<pre class=\"small\">${2}</pre>"
}

report_error() {
	echo "<h4 class=\"text-danger\">Oops. Something happened.</h4>"
	alert "$1" "danger"
}

# report_log "text" "extras"
report_log() {
	pre "$1" "small" "$2"
}

set_error_flag() {
	flash_append "danger" "$1"
	error=1
}

generate_signature() {
	echo "${soc} (${soc_family} family), $sensor, ${flash_size} MB ${flash_type} flash, ${fw_version}-${fw_variant}, ${network_hostname}, ${network_macaddr}" > $signature_file
}

signature() {
	[ ! -f "$signature_file" ] && generate_signature
	cat $signature_file
}

t_label() {
	eval "echo \$tL_${1}"
}

t_value() {
	# eval "echo \"\$${1}\""
	eval echo '$'${1}
}

update_caminfo() {
	flash_type=$(ipcinfo --flash-type)
	mtd_size=$(grep -E "nor|nand" $(ls /sys/class/mtd/mtd*/type) | sed -E "s|type.+|size|g")
	flash_size=$(awk '{sum+=$1} END{print sum/1024/1024}' $mtd_size)

	sensor_ini=$(ipcinfo --long-sensor)
	[ -z "$sensor_ini" ] && sensor_ini=$(fw_printenv -n sensor)

	sensor=$(ipcinfo --short-sensor)
	[ -z "$sensor" ] && sensor=$(echo $sensor_ini | cut -d_ -f1)

	soc_vendor=$(ipcinfo --vendor)
	soc_family=$(ipcinfo --family)

	soc=$(ipcinfo --chip-name)
	if [ -z "$soc" ] || [ "$soc_vendor" = "sigmastar" ]; then
		soc=$(fw_printenv -n soc)
	fi

	soc_temp=$(ipcinfo --temp 2> /dev/null)
	if [ -n "$soc_temp" ]; then
		soc_has_temp="true"
	else
		soc_has_temp="false"
	fi

	# Firmware
	fw_version=$(grep "OPENIPC_VERSION" /etc/os-release | cut -d= -f2 | tr -d '"')
	fw_variant=$(grep "BUILD_OPTION" /etc/os-release | cut -d= -f2 | tr -d '"')
	fw_build=$(grep "GITHUB_VERSION" /etc/os-release | cut -d= -f2 | tr -d '"')
	mj_version=$($mj_bin_file -v)
	uboot_version=$(fw_printenv -n ver)

	# WebUI
	ui_password=$(grep root /etc/shadow|cut -d: -f2)

	# Network
	network_interface=$(ip route | awk '/default/ {print $5}')
	network_address=$(ip route | grep ${network_interface} | awk '/src/ {print $7}')
	network_gateway=$(ip route | awk '/default/ {print $3}')
	network_hostname=$(hostname -s)
	network_macaddr=$(cat /sys/class/net/${network_interface}/address)

	# Overlay
	overlay_root="/overlay"

	# Default timezone is GMT
	tz_data=$(cat /etc/TZ)
	tz_name=$(cat /etc/timezone)
	if [ -z "$tz_data" ] || [ -z "$tz_name" ]; then
		tz_data="GMT0"; echo "$tz_data" > /etc/TZ
		tz_name="Etc/GMT"; echo "$tz_name" > /etc/timezone
	fi

	local variables="flash_size flash_type fw_build fw_variant fw_version mj_version network_address
		network_gateway network_hostname network_interface network_macaddr overlay_root sensor
		sensor_ini soc soc_family soc_has_temp soc_vendor tz_data tz_name uboot_version ui_password"
	rm -f ${sysinfo_file}

	local v
	for v in $variables; do
		eval "echo ${v}=\'\$${v}\' >> ${sysinfo_file}"
	done

	generate_signature
}

mj_bin_file=/usr/bin/majestic
flash_file=/tmp/webui-flash.txt
signature_file=/tmp/webui/signature.txt
sysinfo_file=/tmp/sysinfo.txt

[ ! -d /etc/webui ] && mkdir -p /etc/webui
[ ! -d /tmp/webui ] && mkdir -p /tmp/webui

[ ! -f $sysinfo_file ] && update_caminfo
include $sysinfo_file

pagename=$(basename "$SCRIPT_NAME")
pagename="${pagename%%.*}"

include /etc/webui/webui.conf
include /usr/share/libubox/jshn.sh

check_password
%>
