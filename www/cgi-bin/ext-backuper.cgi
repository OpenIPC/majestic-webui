#!/usr/bin/haserl --upload-limit=200 --upload-dir=/tmp
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

if [ "$GET_backup" = "restore" ]; then
	# temporary stub, until file upload is fixed
	redirect_back
	exit 0
fi
%>
