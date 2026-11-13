#!/usr/bin/haserl
<%in p/common.cgi %>
<%
# Put every majestic setting back to its default.
#
# POST only, from the button on config.cgi. A GET is what a browser issues on
# its own -- a prefetch, a restored tab, an old bookmark -- and must not wipe
# every setting, so it is sent to the page holding the button instead.
#
# The path still arrives in f, but it is checked against the one file this
# page offers rather than used as given.
#
# majestic's file holds only what differs from its built-in defaults, and the
# firmware ships no copy of it, so a reset is removing the file. With nothing
# underneath in /rom, removing it through the merged path takes the overlay
# copy away and leaves no whiteout behind.
config=$(get_config)

[ "$REQUEST_METHOD" = "POST" ] || redirect_to "config.cgi"
[ "$POST_f" = "$config" ] || set_error_flag "Nothing to reset."
[ -n "$error" ] && redirect_back
[ -e "$config" ] || redirect_back "info" "No setting is saved, so every one is already at its default."

rm -f "$config"
sync
[ -e "$config" ] && redirect_back "danger" "Cannot remove ${config}!"

# Removing the file is only half of it: see majestic_reload in p/common.cgi
# for what the other half is and why leaving it out loses the reset entirely.
if majestic_reload; then
	redirect_back "success" "Every setting is back to its default. Majestic is picking them up now, so video restarts in a moment."
else
	redirect_back "warning" "Every setting is back to its default, but Majestic is not running to be told. It will start on its defaults."
fi
%>
