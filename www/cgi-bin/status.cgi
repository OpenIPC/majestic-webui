#!/usr/bin/haserl
<%in p/common.cgi %>
<%# Tombstone for the pre-rename name. REMOVE AFTER 2027-06; see moved_to in
   # p/common.cgi for why these exist at all.
   #
   # This one outlives the others: majestic writes Location: /cgi-bin/status.cgi
   # in three places in src/websrv/httpd.c, so until a build carrying the new
   # name reaches every camera, this is what keeps a sign-in landing somewhere. %>
<% moved_to "dashboard.cgi" %>
