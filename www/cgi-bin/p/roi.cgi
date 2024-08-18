<div class="col-10" id="_row">
	<h3>Visual editor</h3>
	<div class="col">
		<iframe id="_iframe" src="/m/img.html" frameborder="0" style="padding: 0px; margin: 0px; border: 1px solid rgb(76, 96, 216);"></iframe>
	</div>
	<div class="row mb-3 align-items-center">
		<div class="col">
			<input type="button" class="btn btn-primary" onclick="_clear();" value="Clear all regions">
		</div>
	</div>
</div>

<script>
function _clear() {
	document.getElementById('_iframe').contentWindow.location.reload();
	document.getElementById('_motionDetect_roi').value = '';
}
</script>
