#!/usr/bin/haserl
<%in p/common.cgi %>
<% page_title="Majestic Messages" %>
<%in p/header.cgi %>
<% ex "logread | grep -o majestic.*" %>
<%in p/footer.cgi %>
