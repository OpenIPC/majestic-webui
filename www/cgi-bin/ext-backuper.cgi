#!/usr/bin/haserl
<%in p/common.cgi %>
<%
config_file=/etc/webui/backup.conf

backup_create() { # backup_create
	backup_file_name="${network_address}_${fw_version}-${fw_variant}_"`date +%Y-%m-%d_%H-%M-%S`".tgz"
	# http_header_tgz filename
	echo "Content-type: application/tar+gzip"
	echo "Content-Transfer-Encoding: binary"
	echo "Cache-Control: no-store"
	echo "Pragma: no-cache"
	echo "Content-Disposition: attachment; filename=$backup_file_name"
	echo

	files_to_backup=`grep "^#/" $config_file | tr '#' ' ' | tr '\r\n' ' '`
	tar c -f - $files_to_backup | gzip
	exit 0
}

# create backup
if [ "$GET_backup" = "create" ]; then
	backup_create
	exit 0
fi

# This endpoint only serves the backup download; send any other request back to
# the page that owns the backuper configuration.
redirect_to "fw-settings.cgi"
%>
