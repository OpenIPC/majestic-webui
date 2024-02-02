#!/usr/bin/haserl
<%in p/common.cgi %>
<%
page_title="Text Editor"

if [ "POST" = "$REQUEST_METHOD" ]; then
	editor_file="$POST_editor_file"
	editor_text="$POST_editor_text"

	# strip carriage return (\u000D) characters
	editor_text=$(echo "$editor_text" | sed s/\\r//g)

	case "$POST_action" in
		save)
			if [ -z "$editor_text" ]; then
				flash_save "warning" "Empty payload. File not saved!"
			else
				[ -f "${editor_file}.backup" ] && rm "${editor_file}.backup"
				echo "$editor_text" > "$editor_file"
				redirect_to "${SCRIPT_NAME}?f=${editor_file}" "success" "File saved."
			fi
			;;

		*)
			flash_save "danger" "UNKNOWN ACTION: $POST_action"
			;;
	esac
else
	editor_file="$GET_f"
	if [ ! -f "$editor_file" ]; then
		flash_save "danger" "File not found!"
	elif [ -n "$editor_file" ]; then
		if [ "b" = "$( (cat -v "$editor_file" | grep -q "\^@") && echo "b" )" ]; then
			flash_save "danger" "Not a text file!"
		elif [ "$(stat -c%s $editor_file)" -gt "102400" ]; then
			flash_save "danger" "Uploded file is too large!"
		else
			editor_text="$(cat $editor_file | sed "s/&/\&amp;/g;s/</\&lt;/g;s/>/\&gt;/g;s/\"/\&quot;/g")"
		fi
	fi
fi
%>

<%in p/header.cgi %>
<form action="<%= $SCRIPT_NAME %>" method="post">
	<% field_hidden "action" "save" %>
	<% field_hidden "editor_file" "$editor_file" %>
	<% field_textedit "editor_text" "$editor_file" "File content" %>
	<% button_submit %>
</form>

<%in p/footer.cgi %>
