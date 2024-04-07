#!/usr/bin/haserl
<%in p/common.cgi %>
<%
page_title="Console"
%>

<%in p/header.cgi %>
<form>
<div class="row">
	<div class="col-10">
		<% field_text "command" "Enter command:" %>
	</div>
	<div class="col align-self-center">
		<% button_submit "Run" "secondary" %>
	</div>
	<div class="col-10">
		<div id="output-wrapper"></div>
	</div>
</div>
</form>

<script>
$('form').addEventListener('submit', event => {
	event.preventDefault();
	$('form input[type=submit]').disabled = true;
	cmd = $('#command').value;

	el = document.createElement('pre')
	el.id = "output";
	el.dataset['cmd'] = cmd;

	h6 = document.createElement('h6')
	$('#output-wrapper').innerHTML = '';
	$('#output-wrapper').appendChild(h6);
	$('#output-wrapper').appendChild(el);

	runCmd("web")
});
</script>

<%in p/footer.cgi %>
