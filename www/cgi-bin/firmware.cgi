#!/usr/bin/haserl
<%in p/common.cgi %>
<%
	page_title="Firmware Update"
	if [ -n "$network_gateway" ]; then
		fw_soc=$soc
		if [ "$soc_vendor" = "ingenic" ]; then
			fw_soc=$soc_family
		fi

		builder=$(fw_printenv -n upgrade)
		url="https://github.com/openipc/firmware/releases/download/latest/openipc.${fw_soc}-${flash_type}-${fw_variant}.tgz"
		ver=$(curl -m 3 -ILs "${builder:-$url}" | grep Last-Modified | cut -d' ' -f2-)
	fi

	if [ -n "$ver" ]; then
		fw_date=$(date -D "%a, %d %b %Y %T GMT" +"2.4.%m.%d" --date "$ver")
	else
		fw_date="<span class=\"text-danger\">- no access to GitHub -</span>"
	fi

	fw_kernel="true"
	fw_rootfs="true"
	fw_reboot="true"
%>
<%in p/header.cgi %>

<div class="row row-cols-1 row-cols-md-2 row-cols-lg-3 g-4 mb-4">
	<div class="col">
		<h3>Version</h3>
			<dl class="list small">
			<dt>Installed</dt>
			<dd><%= $fw_version %></dd>
			<dt>On GitHub</dt>
			<dd id="firmware-master-ver"><%= $fw_date %></dd>
		</dl>
	</div>

	<div class="col">
		<h3>Upgrade</h3>
		<% if [ -n "$network_gateway" ]; then %>
			<form action="firmware-update.cgi" method="post">
				<% field_checkbox "fw_kernel" "Upgrade kernel." %>
				<% field_checkbox "fw_rootfs" "Upgrade rootfs." %>
				<% field_checkbox "fw_reboot" "Restart after upgrade." %>
				<% field_checkbox "fw_reset" "Reset firmware." %>
				<% field_checkbox "fw_force" "Reflash installed version." %>
				<% button_submit "Install update from GitHub" "warning" %>
			</form>
		<% else %>
			<p class="alert alert-danger">Upgrading requires access to GitHub.</p>
		<% fi %>
	</div>
</div>

<%in p/footer.cgi %>
