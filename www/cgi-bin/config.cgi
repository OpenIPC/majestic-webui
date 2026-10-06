#!/usr/bin/haserl
<%in p/common.cgi %>
<%
# majestic's file is the list of changes, not the configuration: majestic
# declares a default for every setting and writes back only what differs, and
# the firmware ships no copy of the file at all. So there is no /rom file to
# diff against -- what is on the camera is already the diff -- and an absent
# file, or one holding nothing but majestic's own comment header, is a camera
# running on its defaults rather than one missing its configuration.
config=$(get_config)
changed=
[ -f "$config" ] && grep -q -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "$config" && changed=1
%>
<%in p/header.cgi %>

<div class="card"><div class="card-body">
	<% card_head "Changes from defaults" %>
	<%# What the page knows is the file, so that is what it speaks about: a
	    reset or an edit reaches the daemon on a reload a moment later, and a
	    sentence about what majestic is running would be ahead of it. %>
	<% if [ -n "$changed" ]; then %>
		<% ex "cat $config" %>
	<% else %>
		<p class="mb-0">No setting is saved, so every one is at its default.</p>
	<% fi %>
	<div class="d-flex gap-2 mt-3">
		<a class="btn btn-outline-secondary" href="editor.cgi?f=<%= $config %>">Edit</a>
		<% if [ -n "$changed" ]; then %>
		<form action="config-reset.cgi" method="post" class="m-0">
			<input type="hidden" name="f" value="<%= $config %>">
			<button type="submit" class="btn btn-danger"
				data-confirm="Put every camera setting back to its default?&#10;&#10;This takes effect at once: video restarts on the default settings and everything configured since is gone.">Reset to defaults</button>
		</form>
		<% fi %>
	</div>
</div></div>

<%in p/footer.cgi %>
