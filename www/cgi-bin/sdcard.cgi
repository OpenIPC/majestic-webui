#!/usr/bin/haserl
<%in p/common.cgi %>
<% hide_title=1 %>
<%in p/header.cgi %>

<div id="sd"><div class="text-secondary small">loading…</div></div>

<dialog class="mj-modal" id="sd-format">
	<div class="modal-header"><h5 class="modal-title text-danger">Format SD card</h5><button class="btn-close" data-bs-dismiss="modal"></button></div>
	<div class="modal-body">
		<% notice danger '<b>This erases everything on the card.</b> Make a backup first.' %>
		<label class="form-label" for="sd-format-fs">Filesystem</label>
		<select id="sd-format-fs" class="form-select mb-3"></select>
		<pre id="sd-format-log" class="small d-none mb-0" style="max-height:30vh;overflow:auto"></pre>
	</div>
	<div class="modal-footer"><span class="small text-secondary me-auto" id="sd-format-status"></span><button class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button><button class="btn btn-danger" id="sd-format-go" type="button">Format</button></div>
</dialog>

<%# Outside #sd on purpose. a/sdcard.js rebuilds that container every five
    seconds, and a wizard inside it would be destroyed mid-swap -- with the
    operator holding a card and the page having forgotten it asked for one.
    The format dialog is out here for the same reason. %>
<dialog class="mj-modal" id="sd-swap">
	<div class="modal-header"><h5 class="modal-title">Change the SD card</h5><button class="btn-close" data-bs-dismiss="modal"></button></div>
	<div class="modal-body">
		<div id="sd-swap-head"></div>
		<ol class="mj-steps" id="sd-swap-steps">
			<li data-step="pausing">Pause recording</li>
			<li data-step="releasing">Let go of the card</li>
			<li data-step="remove">Take the old card out</li>
			<li data-step="waiting">Put the new card in</li>
			<li data-step="mounting">Make it ready</li>
			<li data-step="resuming">Start recording again</li>
		</ol>
	</div>
	<div class="modal-footer"><span class="small text-secondary me-auto" id="sd-swap-status"></span><button class="btn btn-secondary" id="sd-swap-stop" type="button">Stop</button><button class="btn btn-primary" id="sd-swap-go" type="button">Start</button></div>
</dialog>

<script src="/a/sdcard-swap.js" defer></script>
<script src="/a/sdcard.js" defer></script>

<%in p/footer.cgi %>
