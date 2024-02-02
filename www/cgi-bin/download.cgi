#!/usr/bin/haserl
<%in p/common.cgi %>
<%
file=$GET_file
fname=$(basename $file)
mime="application/octet-stream"
check_file_exist $file

echo "HTTP/1.0 200 OK
Date: $(TZ=GMT0 date +'%a, %d %b %Y %T %Z')
Server: $SERVER_SOFTWARE
Content-type: ${mime}
Content-Disposition: attachment; filename=${fname}
Content-Length: $(stat -c%s $file)
Cache-Control: no-store
Pragma: no-cache
"
cat $file
%>
