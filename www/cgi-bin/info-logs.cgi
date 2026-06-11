#!/usr/bin/haserl
<%in p/common.cgi %>
<% page_title="Logs" %>
<%in p/header.cgi %>
<style>
#log { height: 70vh; overflow-y: auto; font-family: monospace; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
.log-line { padding: 0 .25rem; }
.log-err { color: #dc3545; }
.log-warn { color: #fd7e14; }
.log-debug { opacity: .6; }
</style>
<div class="row g-2 align-items-center mb-2">
	<div class="col-auto">
		<select id="log-source" class="form-select form-select-sm">
			<option value="all">Everything</option>
			<option value="majestic">Majestic</option>
			<option value="kernel">Kernel</option>
		</select>
	</div>
	<div class="col">
		<input id="log-filter" type="text" class="form-control form-control-sm" placeholder="filter…" autocomplete="off">
	</div>
	<div class="col-auto">
		<button id="log-pause" type="button" class="btn btn-sm btn-secondary">⏸ Pause</button>
		<button id="log-clear" type="button" class="btn btn-sm btn-outline-secondary">Clear</button>
		<button id="log-download" type="button" class="btn btn-sm btn-outline-secondary">⬇ Download</button>
	</div>
</div>
<div id="log" class="border rounded bg-body-tertiary"></div>
<script src="/a/logs.js"></script>
<%in p/footer.cgi %>
