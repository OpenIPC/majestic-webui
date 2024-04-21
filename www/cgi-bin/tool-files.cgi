#!/usr/bin/haserl
<%in p/common.cgi %>
<% page_title="Files" %>
<%
	[ -n "$GET_cd" ] && dir=${GET_cd}
	dir=$(cd ${dir:-/}; pwd | sed s#^//#/#)
	back=$(cd ${dir}/..; pwd | sed s#^//#/#)
%>

<%in p/header.cgi %>
<h4><%= $dir %></h4>
<%
	echo "<div class=\"row mb-3\">"
	echo "<a href=\"?cd=${back}\" class=\"fw-bold\">..</a>"
	echo "</div>"

	filename=$(ls --group-directories-first $dir)
	for line in $filename; do
		path=$(echo "${dir}/${line}" | sed s!^//!/!)
		[ "$path" = "/proc" ] || [ "$path" = "/sys" ] && continue

		echo "<div class=\"row mb-3\">"
		echo "<div class=\"col-10 col-lg-4\">"
		if [ -d "${path}" ]; then
			echo "<a href=\"?cd=${path}\" class=\"fw-bold\">${line}</a>"
		else
			echo "<a href=\"${path}\" class=\"fst-italic\">${line}</a>"
		fi

		fileinfo=$(stat -c "%s.%a.%z" $path)
		filesize=$(echo $fileinfo | cut -d. -f1)
		permission=$(echo $fileinfo | cut -d. -f2)
		timestamp=$(echo $fileinfo | cut -d. -f3)

		echo "</div>"
		echo "<div class=\"col-2 col-lg-2 font-monospace text-end\">${filesize}</div>"
		echo "<div class=\"col-6 col-lg-2 font-monospace text-center\">${permission}</div>"
		echo "<div class=\"col-6 col-lg-2 font-monospace text-end\">${timestamp}</div>"
		echo "</div>"
	done
%>

<%in p/footer.cgi %>
