#!/usr/bin/haserl
<%in p/common.cgi %>

<% page_title="Device Status" %>
<%in p/header.cgi %>

<div class="row row-cols-1 row-cols-md-2 row-cols-lg-3 g-4 mb-4">
	<div class="col">
		<h3>Hardware</h3>
		<dl class="small list">
			<dt>Processor</dt>
			<dd><%= $soc %></dd>
			<dt>Family</dt>
			<dd><%= $soc_family %></dd>
			<dt>Sensor</dt>
			<dd><%= $sensor_ini %></dd>
			<dt>Flash</dt>
			<dd><%= $flash_size %> MB</dd>
		</dl>
	</div>

	<div class="col">
		<h3>Firmware</h3>
		<dl class="small list">
			<dt>Version</dt>
			<dd><%= "${fw_version}-${fw_variant}" %></dd>
			<dt>Build</dt>
			<dd><%= $fw_build %></dd>
			<dt>Majestic</dt>
			<dd><%= $mj_version %></dd>
			<% if [ -n "$uboot_version" ]; then %>
				<dt>U-Boot</dt>
				<dd><%= $uboot_version %></dd>
			<% fi %>
		</dl>
	</div>
</div>

<div class="row g-4 mb-4">
	<div class="col ">
		<h3>Resources</h3>
		<% ex "uptime" %>
		<% ex "df -hT" %>
		<% ex "free -h" %>
	</div>
</div>

<%in p/footer.cgi %>
