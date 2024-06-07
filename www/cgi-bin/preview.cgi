#!/usr/bin/haserl
<%in p/common.cgi %>

<% page_title="Camera Preview" %>
<%in p/header.cgi %>

<div class="row preview">
	<div class="col">
		<% preview %>
		<p class="small"><a href="mj-endpoints.cgi">Majestic Endpoints</a></p>
	</div>

	<div class="col-auto">
		<% if [ "$(get_night lightMonitor)" = "true" ]; then %>
			<p class="small"><a href="mj-settings.cgi?tab=nightMode">Light monitor active</a></p>
		<% fi %>

		<div class="d-grid gap-3">
			<input type="checkbox" class="btn-check" id="toggle-night">
			<label class="btn btn-primary" for="toggle-night">Night</label>

			<input type="checkbox" class="btn-check" id="toggle-ircut">
			<label class="btn btn-primary" for="toggle-ircut">IRcut</label>

			<input type="checkbox" class="btn-check" id="toggle-light">
			<label class="btn btn-primary" for="toggle-light">Light</label>

			<% if [ -n "$ptz_support" ]; then %>
				<%in p/motor.cgi %>
			<% fi %>
		</div>
	</div>
</div>

<script>
<% echo "\$('#toggle-night').checked = $(get_metrics night_enabled);" %>
<% echo "\$('#toggle-ircut').checked = $(get_metrics ircut_enabled);" %>
<% echo "\$('#toggle-light').checked = $(get_metrics light_enabled);" %>

<% echo "\$('#toggle-night').disabled = $(get_night lightMonitor);" %>
<% echo "\$('#toggle-ircut').disabled = $(get_night lightMonitor) || !$(get_night irCutPin1);" %>
<% echo "\$('#toggle-light').disabled = $(get_night lightMonitor) || !$(get_night backlightPin);" %>

$("#toggle-night").addEventListener("click", ev => {
	fetch('/night/toggle').then(api => api.json()).then(data => {
		ev.checked = data;
		if (!$('#toggle-ircut').disabled) {
			$('#toggle-ircut').checked = data;
		}
		if (!$('#toggle-light').disabled) {
			$('#toggle-light').checked = data;
		}
	});
});

$("#toggle-ircut").addEventListener("click", ev => {
	fetch('/night/ircut').then(api => api.json()).then(data => {
		ev.checked = data;
	});
});

$("#toggle-light").addEventListener("click", ev => {
	fetch('/night/light').then(api => api.json()).then(data => {
		ev.checked = data;
	});
});
</script>

<%in p/footer.cgi %>
