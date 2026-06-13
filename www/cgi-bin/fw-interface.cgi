#!/usr/bin/haserl --upload-limit=100 --upload-dir=/tmp
<%in p/common.cgi %>
<%
page_title="Interface Settings"
config_file="/etc/webui/webui.conf"

if [ "$REQUEST_METHOD" = "POST" ]; then
	case "$POST_action" in
		access)
			password_default="$POST_password_default"
			if [ -z "$password_default" ]; then
				redirect_to "$SCRIPT_NAME" "danger" "Password cannot be empty!"
			fi

			password_confirm="$POST_password_confirm"
			if [ "$password_default" != "$password_confirm" ]; then
				redirect_to "$SCRIPT_NAME" "danger" "Password does not match!"
			fi

			echo "root:${password_default}" | chpasswd
			update_caminfo
			redirect_to "/" "success" "Password updated."
			;;

		theme)
			case "$POST_webui_theme" in
				light|dark|auto) webui_theme="$POST_webui_theme";;
				*) webui_theme="dark";;
			esac
			echo "webui_theme=\"$webui_theme\"" > "$config_file"
			update_caminfo
			redirect_back "success" "Settings updated."
			;;

		*)
			redirect_to "$SCRIPT_NAME" "danger" "UNKNOWN ACTION: $POST_action"
			;;
	esac
fi

ui_username="$USER"
tcur=${webui_theme:-dark}
%>

<%in p/header.cgi %>

<div class="row g-4">
	<div class="col-12 col-md-6">
		<div class="card h-100"><div class="card-body">
			<h3>Admin password</h3>
			<form action="<%= $SCRIPT_NAME %>" method="post">
				<% field_hidden "action" "access" %>
				<p class="string">
					<label for="ui_username" class="form-label">Username</label>
					<input type="text" id="ui_username" name="ui_username" value="<%= $ui_username %>" class="form-control" autocomplete="username" disabled>
				</p>
				<% field_password "password_default" "Password" %>
				<% field_password "password_confirm" "Confirm password" %>
				<p class="hint text-secondary">This is the camera's <strong>root</strong> password — it secures the web UI and SSH.</p>
				<% button_submit %>
			</form>
		</div></div>
	</div>

	<div class="col-12 col-md-6">
		<div class="card h-100"><div class="card-body">
			<h3>Appearance</h3>
			<form action="<%= $SCRIPT_NAME %>" method="post">
				<% field_hidden "action" "theme" %>
				<label class="form-label d-block">Theme</label>
				<div class="btn-group" role="group" aria-label="Theme" id="theme-choice">
					<input type="radio" class="btn-check" name="webui_theme" id="theme-light" value="light" autocomplete="off" <% [ "$tcur" = "light" ] && echo checked %>>
					<label class="btn btn-outline-primary" for="theme-light">☀ Light</label>
					<input type="radio" class="btn-check" name="webui_theme" id="theme-dark" value="dark" autocomplete="off" <% [ "$tcur" = "dark" ] && echo checked %>>
					<label class="btn btn-outline-primary" for="theme-dark">🌙 Dark</label>
					<input type="radio" class="btn-check" name="webui_theme" id="theme-auto" value="auto" autocomplete="off" <% [ "$tcur" = "auto" ] && echo checked %>>
					<label class="btn btn-outline-primary" for="theme-auto">Auto</label>
				</div>
				<p class="hint text-secondary mt-2">Auto follows your device's light/dark setting. Changes preview instantly.</p>
				<% button_submit "Save" %>
			</form>
		</div></div>
	</div>
</div>

<script src="/a/fw-interface.js" defer></script>

<%in p/footer.cgi %>
