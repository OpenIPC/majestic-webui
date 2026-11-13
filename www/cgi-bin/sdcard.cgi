#!/usr/bin/haserl
<%in p/common.cgi %>
<% hide_title=1 %>
<%in p/header.cgi %>

<div id="sd"><div class="text-secondary small">loading…</div></div>

<dialog class="mj-modal" id="sd-format">
	<div class="modal-header"><h5 class="modal-title text-danger">Format SD card</h5><button class="btn-close" data-bs-dismiss="modal"></button></div>
	<div class="modal-body">
		<% notice danger '<b>This erases everything on the card.</b> Make a backup first.' %>
		<label class="form-label mj-cap" for="sd-format-fs">Filesystem</label>
		<select id="sd-format-fs" class="form-select"></select>
		<%# What a format does, in the order it does it. The capacity check runs
		    FIRST and is the step that catches a card which is not the size it
		    claims -- which is why the health panel points at Format for a card
		    it will not offer the standalone check on. %>
		<div class="mj-willdo">
			<span class="mj-cap">What this does, in order</span>
			<ol>
				<li>Writes markers across the card's whole claimed size and reads them back. This is what catches a card that is smaller than it says, or has stopped storing.</li>
				<li>Writes a fresh partition table.</li>
				<li>Makes the filesystem and mounts it.</li>
			</ol>
		</div>
		<%# The acknowledgement that gates the press. It replaced a native
		    confirm(), so it is a real checkbox with a real label: a confirm box
		    was at least reachable from the keyboard, and a div listening for
		    clicks would not be. %>
		<label class="mj-ack" for="sd-format-ack">
			<input class="form-check-input" type="checkbox" id="sd-format-ack">
			<span id="sd-format-ack-txt">I understand this erases everything on the card.</span>
		</label>
		<pre id="sd-format-log" class="small d-none mb-0 mt-3" style="max-height:30vh;overflow:auto"></pre>
	</div>
	<div class="modal-footer"><span class="small text-secondary me-auto" id="sd-format-status"></span><button class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button><button class="btn btn-danger" id="sd-format-go" type="button" disabled>Format</button></div>
</dialog>

<%# Outside #sd on purpose. a/sdcard.js rebuilds that container every five
    seconds, and a wizard inside it would be destroyed mid-swap -- with the
    operator holding a card and the page having forgotten it asked for one.
    The format dialog is out here for the same reason. %>
<dialog class="mj-modal mj-modal-lg" id="sd-swap">
	<div class="modal-header"><h5 class="modal-title">Change the SD card</h5><button class="btn-close" data-bs-dismiss="modal"></button></div>
	<div class="modal-body">
		<div id="sd-swap-head"></div>
		<%# Down the dialog rather than across it. Six steps wrapped to three
		    ragged lines at the modal's width, which read as a list of
		    unrelated phrases rather than as one sequence -- and the step in
		    flight had nowhere to say what it was doing. %>
		<ol class="mj-steps-v" id="sd-swap-steps">
			<li data-step="pausing"><span class="mj-pip">1</span><span><span class="mj-step-name">Pause recording</span><span class="mj-step-sub"></span></span></li>
			<li data-step="releasing"><span class="mj-pip">2</span><span><span class="mj-step-name">Let go of the card</span><span class="mj-step-sub"></span></span></li>
			<li data-step="remove"><span class="mj-pip">3</span><span><span class="mj-step-name">Take the old card out</span><span class="mj-step-sub"></span></span></li>
			<li data-step="waiting"><span class="mj-pip">4</span><span><span class="mj-step-name">Put the new card in</span><span class="mj-step-sub"></span></span></li>
			<li data-step="mounting"><span class="mj-pip">5</span><span><span class="mj-step-name">Make it ready</span><span class="mj-step-sub"></span></span></li>
			<li data-step="resuming"><span class="mj-pip">6</span><span><span class="mj-step-name">Start recording again</span><span class="mj-step-sub"></span></span></li>
		</ol>
	</div>
	<div class="modal-footer"><span class="small text-secondary me-auto" id="sd-swap-status"></span><button class="btn btn-secondary" id="sd-swap-stop" type="button">Stop</button><button class="btn btn-primary" id="sd-swap-go" type="button">Start</button></div>
</dialog>

<%# The Performance panel's two traces share the Dashboard's chart
    primitives rather than growing their own. %>
<script src="/a/charts.js" defer></script>
<script src="/a/sdcard-health.js" defer></script>
<script src="/a/sdcard-swap.js" defer></script>
<script src="/a/sdcard.js" defer></script>

<%in p/footer.cgi %>
