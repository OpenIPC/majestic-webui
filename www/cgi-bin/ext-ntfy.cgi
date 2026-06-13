#!/usr/bin/haserl
<%in p/common.cgi %>
<%
page_title="Ntfy Notifications"
config_file=/etc/webui/ntfy.conf
# The list of parameters that we will save
params="enabled server topic user pass caption heif priority"

# === TEST DISPATCH LOGIC ===
if [ "$GET_send" = "test" ]; then
    echo "Content-type: text/html; charset=UTF-8"
    echo
    # Run the sending script.
    # Redirect the output to /dev/null so as not to clog up the response.
    # Check the return code (exit code). 0 = success.
    if /usr/bin/ntfy.sh > /dev/null 2>&1; then
        echo "OK"
    else
        echo "FAIL"
    fi
    exit 0
fi

# === LOGIC OF SAVING SETTINGS ===
if [ "$REQUEST_METHOD" = "POST" ]; then
    for p in $params; do
        eval ntfy_${p}=\$POST_ntfy_${p}
    done

    # Validation
    if [ "$ntfy_enabled" = "true" ]; then
        [ -z "$ntfy_server" ] && set_error_flag "Server URL cannot be empty."
        [ -z "$ntfy_topic" ] && set_error_flag "Topic cannot be empty."
    fi

    # Writing to a file
    if [ -z "$error" ]; then
        rm -f "$config_file"
        for p in $params; do
            echo "ntfy_${p}=\"$(eval echo \$ntfy_${p})\"" >> "$config_file"
        done
        redirect_back "success" "Ntfy config updated."
    fi

    redirect_to "$SCRIPT_NAME"
fi

# === LOADING CURRENT SETTINGS ===
[ -e "$config_file" ] && include $config_file

# Default values
[ -z "$ntfy_server" ] && ntfy_server="https://ntfy.sh"
[ -z "$ntfy_priority" ] && ntfy_priority="4"
%>

<%in p/header.cgi %>

<div class="row g-4">
	<div class="col-12 col-lg-8">
		<div class="card h-100"><div class="card-body">
			<h3>Ntfy notifications</h3>
			<p class="small text-secondary">Push a snapshot notification to an <a href="https://ntfy.sh">ntfy</a> topic.</p>
			<form action="<%= $SCRIPT_NAME %>" method="post">
				<% field_switch "ntfy_enabled" "Enable Ntfy" "eval" %>
				<div class="text-uppercase x-small text-secondary mt-3 mb-2">Connection</div>
				<% field_text "ntfy_server" "Server URL" "e.g. https://ntfy.sh" %>
				<% field_text "ntfy_topic" "Topic" "Unique topic name for notifications." %>
				<% field_text "ntfy_user" "Username" "Leave empty if no auth." %>
				<% field_text "ntfy_pass" "Password" "Leave empty if no auth." %>
				<div class="text-uppercase x-small text-secondary mt-3 mb-2">Message</div>
				<% field_text "ntfy_caption" "Caption" "Supports %hostname, %datetime, %soctemp." %>
				<% field_string "ntfy_priority" "Priority" "eval" "1 2 3 4 5" "1 = min, 5 = max (urgent)." %>
				<% field_switch "ntfy_heif" "Use HEIF format" "eval" "Smaller files than JPEG." %>
				<% button_submit %>
			</form>
		</div></div>
	</div>

	<div class="col-12 col-lg-4">
		<div class="card h-100"><div class="card-body">
			<h3>Test</h3>
			<p class="small text-secondary">Send a test notification using the saved settings.</p>
			<button type="button" id="ntfy-test" class="btn btn-sm btn-outline-secondary">Send test notification</button>
			<span id="ntfy-status" class="small ms-2"></span>
		</div></div>
	</div>
</div>

<details class="mt-4">
	<summary class="text-secondary small">Advanced — raw configuration</summary>
	<div class="mt-3">
		<% [ -e "$config_file" ] && ex "cat $config_file" %>
	</div>
</details>

<script src="/a/ext-ntfy.js"></script>

<%in p/footer.cgi %>
