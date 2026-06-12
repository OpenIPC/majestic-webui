#!/usr/bin/haserl
<%in p/common.cgi %>
<% page_title="File Manager" %>
<%in p/header.cgi %>

<div id="fm">
	<div class="d-flex flex-wrap align-items-center gap-2 mb-2">
		<nav id="fm-breadcrumb" aria-label="path" class="me-auto"><ol class="breadcrumb m-0"></ol></nav>
		<div class="btn-group btn-group-sm">
			<button id="fm-newfolder" class="btn btn-outline-primary" type="button">New folder</button>
			<button id="fm-newfile" class="btn btn-outline-primary" type="button">New file</button>
			<button id="fm-upload-btn" class="btn btn-outline-primary" type="button">Upload</button>
		</div>
	</div>

	<div id="fm-bulk" class="align-items-center gap-2 mb-2 d-none">
		<span class="small text-secondary"><span id="fm-selcount">0</span> selected</span>
		<button id="fm-bulk-dl" class="btn btn-sm btn-outline-secondary" type="button">Download .tar.gz</button>
		<button id="fm-bulk-del" class="btn btn-sm btn-outline-danger" type="button">Delete</button>
	</div>

	<div id="fm-progress" class="progress mb-2 d-none" style="height:4px"><div class="progress-bar" style="width:0"></div></div>

	<div id="fm-drop" class="fm-drop">
		<table class="table table-sm table-hover align-middle mb-0">
			<thead><tr>
				<th style="width:1%"><input type="checkbox" id="fm-all" class="form-check-input"></th>
				<th class="fm-sortable" data-sort="name">Name</th>
				<th class="fm-sortable text-end" data-sort="size">Size</th>
				<th class="fm-sortable text-center d-none d-md-table-cell" data-sort="mode">Perms</th>
				<th class="fm-sortable text-end d-none d-md-table-cell" data-sort="mtime">Modified</th>
				<th style="width:1%"></th>
			</tr></thead>
			<tbody id="fm-rows"><tr><td colspan="6" class="text-secondary small">loading…</td></tr></tbody>
		</table>
	</div>
	<input type="file" id="fm-upload" multiple hidden>
</div>

<div class="modal fade" id="fm-prompt" tabindex="-1"><div class="modal-dialog"><div class="modal-content">
	<div class="modal-header"><h5 class="modal-title" id="fm-prompt-title"></h5><button class="btn-close" data-bs-dismiss="modal"></button></div>
	<div class="modal-body">
		<label class="form-label" id="fm-prompt-label"></label>
		<input type="text" class="form-control" id="fm-prompt-input" autocomplete="off">
	</div>
	<div class="modal-footer"><button class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button><button class="btn btn-primary" id="fm-prompt-ok" type="button">OK</button></div>
</div></div></div>

<div class="modal fade" id="fm-editor" tabindex="-1"><div class="modal-dialog modal-lg modal-dialog-scrollable"><div class="modal-content">
	<div class="modal-header"><h5 class="modal-title" id="fm-editor-title"></h5><button class="btn-close" data-bs-dismiss="modal"></button></div>
	<div class="modal-body p-0"><textarea id="fm-editor-text" class="form-control border-0 rounded-0" spellcheck="false" style="height:60vh;font-family:var(--bs-font-monospace);white-space:pre;overflow-wrap:normal"></textarea></div>
	<div class="modal-footer"><span class="small text-secondary me-auto" id="fm-editor-status"></span><button class="btn btn-secondary" data-bs-dismiss="modal">Close</button><button class="btn btn-primary" id="fm-editor-save" type="button">Save</button></div>
</div></div></div>

<script src="/a/files.js" defer></script>

<%in p/footer.cgi %>
