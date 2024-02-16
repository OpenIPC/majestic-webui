#!/usr/bin/haserl
<%in p/common.cgi %>
<%
plugin="yadisk"
plugin_name="Send to Yandex Disk"
page_title="Send to Yandex Disk"
params="enabled username password path use_heif socks5_enabled"

tmp_file=/tmp/${plugin}.conf

config_file="${ui_config_dir}/${plugin}.conf"
[ ! -f "$config_file" ] && touch $config_file

if [ "POST" = "$REQUEST_METHOD" ]; then
	# parse values from parameters
	for p in $params; do
		eval ${plugin}_${p}=\$POST_${plugin}_${p}
		sanitize "${plugin}_${p}"
	done; unset p

	### Validation
	if [ "true" = "$email_enabled" ]; then
		[ -z "$yadisk_username" ] && set_error_flag "Yandex Disk username cannot be empty."
		[ -z "$yadisk_password" ] && set_error_flag "Yandex Disk password cannot be empty."
	fi

	if [ -z "$error" ]; then
		# create temp config file
		:>$tmp_file
		for p in $params; do
			echo "${plugin}_${p}=\"$(eval echo \$${plugin}_${p})\"" >>$tmp_file
		done; unset p
		mv $tmp_file $config_file

		update_caminfo
		redirect_back "success" "${plugin_name} config updated."
	fi

	redirect_to $SCRIPT_NAME
else
	include $config_file

	# Default values
	[ -z "$yadisk_use_heif" ] && yadisk_use_heif="false"
fi
%>
<%in p/header.cgi %>

<form action="<%= $SCRIPT_NAME %>" method="post">
  <div class="row row-cols-1 row-cols-md-2 row-cols-lg-3 g-4 mb-4">
    <div class="col">
      <% field_switch "yadisk_enabled" "Enable Yandex Disk bot" %>
      <% field_text "yadisk_username" "Yandex Disk username" %>
      <% field_password "yadisk_password" "Yandex Disk password" "A dedicated password for application. <a href=\"https://yandex.com/support/id/authorization/app-passwords.html\">Create it here</a>." %>
    </div>
    <div class="col">
      <% field_text "yadisk_path" "Yandex Disk path" %>
      <% field_switch "yandex_use_heif" "Use HEIF format." "Requires H.265 codec on Video0." %>
      <% field_switch "yadisk_socks5_enabled" "Use SOCKS5" "<a href=\"network-socks5.cgi\">Configure</a> SOCKS5 access" %>
    </div>
    <div class="col">
      <% ex "cat $config_file" %>
      <% button_webui_log %>
    </div>
  </div>
  <% button_submit %>
</form>

<%in p/footer.cgi %>
