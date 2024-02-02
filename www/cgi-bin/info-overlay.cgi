#!/usr/bin/haserl
<%in p/common.cgi %>
<%
	s=$(df | grep /overlay | xargs | cut -d' ' -f5)
	page_title="Overlay Partition"
%>
<%in p/header.cgi %>
<div class="alert alert-primary">
	<h5>Overlay partition is <%= $s %> full.</h5>
	<% progressbar "${s/%/}" %>
</div>
<% ex "ls -Rl /overlay" %>
<%in p/footer.cgi %>
