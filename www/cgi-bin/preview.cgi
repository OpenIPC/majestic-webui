#!/usr/bin/haserl
<%in p/common.cgi %>
<% page_title="Camera Preview" %>
<%in p/header.cgi %>

<div class="row preview">
	<div class="col-md-8 col-xl-9 col-xxl-9 position-relative mb-3">
		<% preview %>
		<p class="small text-body-secondary"><a href="majestic-endpoints.cgi">Majestic Endpoints</a></p>
	</div>

	<div class="col-md-4 col-xl-3 col-xxl-3">
		<div class="d-grid gap-2 mb-3">
			<div class="btn-group">
				<input type="checkbox" class="btn-check" id="toggle-night">
				<label class="btn btn-primary text-start" for="toggle-night">Day/Night Toggle</label>
				<div class="input-group-text">
					<a href="majestic-settings.cgi?tab=nightMode" title="Night mode settings"><img src="/a/gear.svg" alt="Gear"></a>
				</div>
			</div>

			<div class="btn-group">
				<input type="checkbox" class="btn-check" id="toggle-ircut">
				<label class="btn btn-primary text-start" for="toggle-ircut">IRcut Toggle</label>
				<div class="input-group-text">
					<a href="majestic-settings.cgi?tab=nightMode" title="Night mode settings"><img src="/a/gear.svg" alt="Gear"></a>
				</div>
			</div>

			<div class="btn-group">
				<input type="checkbox" class="btn-check" id="toggle-light">
				<label class="btn btn-primary text-start" for="toggle-light">Light Toggle</label>
				<div class="input-group-text">
					<a href="majestic-settings.cgi?tab=nightMode" title="Night mode settings"><img src="/a/gear.svg" alt="Gear"></a>
				</div>
			</div>

			<% if fw_printenv -n wlandev | grep -q foscam; then %>
				<%in p/motor.cgi %>
			<% fi %>
		</div>
	</div>
</div>

<script>
<% echo "\$('#toggle-night').checked = $(get_metrics night_enabled);" %>
<% echo "\$('#toggle-ircut').checked = $(get_metrics ircut_enabled);" %>
<% echo "\$('#toggle-light').checked = $(get_metrics light_enabled);" %>
<% echo "\$('#toggle-ircut').disabled = !$(get_yaml .nightMode.irCutPin1);" %>
<% echo "\$('#toggle-light').disabled = !$(get_yaml .nightMode.backlightPin);" %>

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

