#!/usr/bin/haserl --upload-limit=100 --upload-dir=/tmp
<%in p/common.cgi %>
<%
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
		<div class="card"><div class="card-body">
			<% card_head "Admin password" %>
			<form action="<%= $SCRIPT_NAME %>" method="post">
				<% field_hidden "action" "access" %>
				<%# hand-written because the field is disabled — root is the only
				    account — so the row shape is spelled out to match the helpers %>
				<p class="string mj-row">
					<label for="ui_username" class="form-label">Username</label>
					<span class="mj-ctl"><span class="mj-ctl-in">
						<input type="text" id="ui_username" name="ui_username" value="<% attr_escape "$ui_username" %>" class="form-control" autocomplete="username" disabled>
					</span></span>
				</p>
				<% field_password "password_default" "Password" %>
				<% field_password "password_confirm" "Confirm password" %>
				<p class="hint text-secondary">This is the camera's <strong>root</strong> password — it secures the web UI and SSH.</p>
				<% button_submit %>
			</form>
		</div></div>
	</div>

	<div class="col-12 col-md-6">
		<div class="card"><div class="card-body">
			<% card_head "Appearance" %>
			<form action="<%= $SCRIPT_NAME %>" method="post">
				<% field_hidden "action" "theme" %>
				<%# The segmented control the stream picker and the player bar use,
				    not a btn-group of outline buttons — and inline SVG rather than
				    U+2600 and U+1F319, which render as a different picture in every
				    font stack. Radios either way: they are the right semantics and
				    fw-interface.js drives .checked to preview a theme. %>
				<p class="mj-row">
					<label class="form-label">Theme</label>
					<span class="mj-ctl"><span class="mj-ctl-in">
						<span class="mj-seg" role="group" aria-label="Theme" id="theme-choice">
							<input type="radio" class="mj-seg-in" name="webui_theme" id="theme-light" value="light" autocomplete="off" <% [ "$tcur" = "light" ] && echo checked %>>
							<label class="mj-seg-lbl" for="theme-light">
								<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="10" cy="10" r="3.6"></circle><path d="M10 2.4v1.8M10 15.8v1.8M2.4 10h1.8M15.8 10h1.8M4.6 4.6l1.3 1.3M14.1 14.1l1.3 1.3M15.4 4.6l-1.3 1.3M5.9 14.1l-1.3 1.3"></path></svg>
								Light
							</label>
							<input type="radio" class="mj-seg-in" name="webui_theme" id="theme-dark" value="dark" autocomplete="off" <% [ "$tcur" = "dark" ] && echo checked %>>
							<label class="mj-seg-lbl" for="theme-dark">
								<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M16.4 12.3A7 7 0 0 1 7.7 3.6a7 7 0 1 0 8.7 8.7z"></path></svg>
								Dark
							</label>
							<input type="radio" class="mj-seg-in" name="webui_theme" id="theme-auto" value="auto" autocomplete="off" <% [ "$tcur" = "auto" ] && echo checked %>>
							<label class="mj-seg-lbl" for="theme-auto">
								<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="10" cy="10" r="6.6"></circle><path d="M10 3.4v13.2a6.6 6.6 0 0 0 0-13.2z" fill="currentColor" stroke="none"></path></svg>
								Auto
							</label>
						</span>
					</span></span>
					<span class="hint text-secondary">Auto follows your device's light/dark setting. Changes preview instantly.</span>
				</p>
				<% button_submit "Save" %>
			</form>
		</div></div>
	</div>
</div>

<script src="/a/fw-interface.js" defer></script>

<%in p/footer.cgi %>
