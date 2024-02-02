#!/usr/bin/haserl --upload-limit=100 --upload-dir=/tmp
<%in p/common.cgi %>
<%
page_title="WebUI Settings"
config_file="/etc/webui/webui.conf"

if [ "POST" = "$REQUEST_METHOD" ]; then
	case "$POST_action" in
		access)
			new_password="$POST_ui_password_new"
			[ -z "$new_password" ] && redirect_to $SCRIPT_NAME "danger" "Password cannot be empty!"
			echo "root:${new_password}" | chpasswd
			update_caminfo
			redirect_to "/" "success" "Password updated."
			;;

		theme)
			eval webui_theme=\$POST_webui_theme
			echo webui_theme=\"$webui_theme\" >  $config_file
			update_caminfo
			redirect_back "success" "WebUI settings updated."
			;;

		*)
			redirect_to $SCRIPT_NAME "danger" "UNKNOWN ACTION: $POST_action"
			;;
	esac
fi

ui_username="$USER"
%>

<%in p/header.cgi %>

<div class="row row-cols-1 row-cols-md-2 row-cols-lg-3 g-4 mb-4">
	<div class="col">
		<h3>Access</h3>
		<form action="<%= $SCRIPT_NAME %>" method="post">
			<% field_hidden "action" "access" %>
			<p class="string">
				<label for="ui_username" class="form-label">Username</label>
				<input type="text" id="ui_username" name="ui_username" value="<%= $ui_username %>" class="form-control" autocomplete="username" disabled>
			</p>
			<% field_password "ui_password_new" "Password" %>
			<% button_submit %>
		</form>
	</div>

	<div class="col">
		<h3>Interface</h3>
		<form action="<%= $SCRIPT_NAME %>" method="post">
			<% field_hidden "action" "theme" %>
			<% field_select "webui_theme" "Theme" "light,dark" %>
			<% button_submit %>
		</form>
	</div>
</div>

<%in p/footer.cgi %>
