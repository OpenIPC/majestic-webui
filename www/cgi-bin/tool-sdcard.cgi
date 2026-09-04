#!/usr/bin/haserl
<%in p/common.cgi %>
<% hide_title=1 %>
<%in p/header.cgi %>

<div id="sd"><div class="text-secondary small">loading…</div></div>

<dialog class="mj-modal" id="sd-format">
	<div class="modal-header"><h5 class="modal-title text-danger">Format SD card</h5><button class="btn-close" data-bs-dismiss="modal"></button></div>
	<div class="modal-body">
		<div class="alert alert-danger mb-3"><strong>This erases everything on the card.</strong> Make a backup first.</div>
		<label class="form-label" for="sd-format-fs">Filesystem</label>
		<select id="sd-format-fs" class="form-select mb-3"></select>
		<pre id="sd-format-log" class="small d-none mb-0" style="max-height:30vh;overflow:auto"></pre>
	</div>
	<div class="modal-footer"><span class="small text-secondary me-auto" id="sd-format-status"></span><button class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button><button class="btn btn-danger" id="sd-format-go" type="button">Format</button></div>
</dialog>

<script src="/a/sdcard.js" defer></script>

<%in p/footer.cgi %>
