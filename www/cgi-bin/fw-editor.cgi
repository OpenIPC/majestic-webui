#!/usr/bin/haserl
<%in p/common.cgi %>
<%

if [ "$REQUEST_METHOD" = "POST" ]; then
	editor_file="$POST_editor_file"
	editor_text="$POST_editor_text"

	# strip carriage return (\u000D) characters
	editor_text=$(echo "$editor_text" | sed s/\\r//g)

	case "$POST_action" in
		save)
			if [ -z "$editor_text" ]; then
				log_create "warning" "Empty payload. File not saved!"
			else
				[ -f "${editor_file}.backup" ] && rm "${editor_file}.backup"
				echo "$editor_text" > "$editor_file"
				# Majestic's own file is the one case where writing it is not
				# the whole job - see majestic_reload in p/common.cgi. Without
				# this the edit sat there unread until a reboot, and the next
				# save from the settings page overwrote it first.
				if [ "$editor_file" = "$(get_config)" ] && majestic_reload; then
					redirect_to "${SCRIPT_NAME}?f=${editor_file}" "success" "File saved. Majestic is picking it up now, so video restarts in a moment."
				fi
				redirect_to "${SCRIPT_NAME}?f=${editor_file}" "success" "File saved."
			fi
			;;

		*)
			log_create "danger" "UNKNOWN ACTION: $POST_action"
			;;
	esac
else
	editor_file="$GET_f"
	if [ ! -f "$editor_file" ]; then
		log_create "danger" "File not found!"
	elif [ -n "$editor_file" ]; then
		if [ "b" = "$( (cat -v "$editor_file" | grep -q "\^@") && echo "b" )" ]; then
			log_create "danger" "Not a text file!"
		elif [ "$(stat -c%s $editor_file)" -gt "102400" ]; then
			log_create "danger" "Uploaded file is too large!"
		else
			editor_text="$(cat $editor_file)"
		fi
	fi
fi
%>

<%in p/header.cgi %>
<div class="card"><div class="card-body">
	<%# the file being edited is the card's state, so it goes in the head's note
	    rather than trailing the title and wrapping it %>
	<% card_head "Text editor" "$(attr_escape "$editor_file")" %>
	<form action="<%= $SCRIPT_NAME %>" method="post">
		<% field_hidden "action" "save" %>
		<% field_hidden "editor_file" "$editor_file" %>
		<% field_textedit "editor_text" "File content" "$editor_file" %>
		<% button_submit %>
	</form>
</div></div>

<%in p/footer.cgi %>
