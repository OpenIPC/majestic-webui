#!/usr/bin/haserl
<%in p/common.cgi %>
<% hide_title=1 %>
<%in p/header.cgi %>

<h2 class="mj-sr"><%= $page_title %></h2>

<noscript>
	<% notice warn 'This page reads the counts from the camera in the browser, so it needs JavaScript.' %>
</noscript>

<%# What there is to show, decided by a/counting.js from the camera's own
    answer: counting off, on with nothing drawn, or the camera not answering.
    Each needs its own sentence, and none of them may look like a quiet day. %>
<div id="ct-note" class="mt-3" aria-live="polite"></div>

<div id="ct-main" hidden>
	<div class="d-flex flex-wrap align-items-center gap-2 mt-3 mb-3">
		<div class="btn-group" role="group" aria-label="Period">
			<button type="button" class="btn btn-sm btn-outline-primary active" data-range="today" aria-pressed="true">Today</button>
			<button type="button" class="btn btn-sm btn-outline-primary" data-range="week" aria-pressed="false">7 days</button>
			<button type="button" class="btn btn-sm btn-outline-primary" data-range="month" aria-pressed="false">30 days</button>
		</div>
		<span class="small text-secondary" id="ct-stamp"></span>
		<span class="small text-warning-emphasis" id="ct-cover" hidden></span>
		<a class="btn btn-sm btn-outline-secondary ms-auto" href="camera.cgi?tab=counting">Lines and zones</a>
	</div>

	<div class="st-kpis" id="ct-kpis" aria-live="polite"></div>

	<div class="st-panel mt-3" id="ct-lines-box">
		<div class="mj-cap">Crossings</div>
		<div id="ct-lines"></div>
	</div>
	<div class="st-panel mt-3" id="ct-zones-box">
		<div class="mj-cap">People in each zone</div>
		<div id="ct-zones"></div>
	</div>
	<div class="st-panel mt-3" id="ct-dwell-box">
		<div class="mj-cap">How long people stay</div>
		<div id="ct-dwell"></div>
	</div>
	<div class="st-panel mt-3 mb-3">
		<div class="mj-cap">Latest</div>
		<ol class="ct-events list-unstyled mb-0" id="ct-events"></ol>
	</div>
</div>

<script src="/a/counting-data.js" defer></script>
<script src="/a/counting.js" defer></script>

<%in p/footer.cgi %>
