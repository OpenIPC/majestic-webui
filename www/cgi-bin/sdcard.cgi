#!/usr/bin/haserl
<%in p/common.cgi %>
<% page_title="SDcard" %>
<%in p/header.cgi %>

<% if [ ! -e /dev/mmcblk0 ]; then %>

<div class="alert alert-danger">
	<h4>SDcard is not available.</h4>
	<p>Make sure the card is correctly inserted.</p>
</div>

<% else %>

<%
	card_device="/dev/mmcblk0"
	card_partition="${card_device}p1"
	mount_point="${card_partition//dev/mnt}"
	error=""
	_o=""
%>

<% if [ -n "$POST_doFormatCard" ]; then %>

<div class="alert alert-danger">
	<h4>SDcard formatting takes time.</h4>
	<p>Please do not refresh this page. Wait until partition formatting is finished!</p>
</div>

<%
	if [ "$(grep $card_partition /etc/mtab)" ]; then
		_c="umount $card_partition"
		_o="${_o}\n${_c}\n$($_c 2>&1)"
		[ $? -ne 0 ] && error="Cannot unmount SDcard partition."
	fi

	if [ -z "$error" ]; then
		_c="mkfs.exfat $card_partition"
		_o="${_o}\n${_c}\n$($_c 2>&1)"
		[ $? -ne 0 ] && error="Cannot format SDcard partition."
	fi

	if [ -z "$error" ] && [ ! -d "$mount_point" ]; then
		_c="mkdir -p $mount_point"
		_o="${_o}\n${_c}\n$($_c 2>&1)"
		[ $? -ne 0 ] && error="Cannot create SDcard mount point."
	fi

	if [ -z "$error" ]; then
		_c="mount -t exfat $card_partition $mount_point"
		_o="${_o}\n${_c}\n$($_c 2>&1)"
		[ $? -ne 0 ] && error="Cannot remount SDcard partition."
	fi

	if [ -n "$error" ]; then
		report_error "$error"
		[ -n "$_c" ] && report_command "$_c" "$_o"
	else
		report_log "$_o"
	fi
%>

<a class="btn btn-primary" href="/">Return</a>

<% else %>

<h4>SDcard partitions</h4>
<%
	partitions=$(df -h | grep 'dev/mmc')
	echo "<pre class=\"small\">${partitions}</pre>"
%>

<% if [ -n "$partitions" ]; then %>

<h4>Browse files on these partitions</h4>
<div class="mb-4">
<%
	IFS=$'\n'
	for i in $partitions; do
		_mount=$(echo $i | awk '{print $6}')
		echo "<a href=\"files.cgi?cd=${_mount}\" class=\"btn btn-primary\">${_mount}</a>"
		unset _mount
	done
	IFS=$IFS_ORIG
	unset _partitions
%>
</div>

<% fi %>

<h4>Format SDcard</h4>
<div class="alert alert-danger">
	<h4>ATTENTION! Formatting will destroy all data on the SDcard.</h4>
	<p>Make sure you have a backup copy if you are going to use the data in the future.</p>
	<form action="<%= $SCRIPT_NAME %>" method="post">
	<% field_hidden "doFormatCard" "true" %>
	<% button_submit "Format SDcard" "danger" %>
	</form>
</div>

<% fi %>
<% fi %>

<%in p/footer.cgi %>
