// File manager: JSON-driven listing, ops, drag-drop upload, inline editor.
(function () {
	const ROWS = $('#fm-rows'), BC = $('#fm-breadcrumb ol'), BULK = $('#fm-bulk');
	let cwd = '/', entries = [], sort = { key: 'name', dir: 1 };
	const sel = new Set();
	const EDIT = /\.(ya?ml|conf|txt|sh|cgi|html?|css|js|json|xml|md|log|ini|cfg)$/i;
	const ARC = /\.(tar\.gz|tgz|tar|zip|gz)$/i;

	function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
	function attr(s) { return String(s).replace(/["&<>]/g, c => ({ '"': '&quot;', '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
	function join(d, n) { return (d.replace(/\/+$/, '') + '/' + n).replace(/\/{2,}/g, '/'); }
	function b64(s) { return btoa(unescape(encodeURIComponent(s))); }
	function humanSize(n) { n = +n || 0; if (n >= 1048576) return (n / 1048576).toFixed(1) + ' M'; if (n >= 1024) return (n / 1024).toFixed(0) + ' K'; return n + ' B'; }
	function fmtTime(s) { try { return new Date(s * 1000).toLocaleString(); } catch (e) { return ''; } }
	function api(qs) { return fetch('/cgi-bin/j/files.cgi?' + qs, { credentials: 'same-origin' }).then(r => r.json()); }
	function op(p) {
		return fetch('/cgi-bin/j/files.cgi', {
			method: 'POST', credentials: 'same-origin',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(p).toString(),
		}).then(r => r.json());
	}
	function reload() { load(cwd, false); }

	function load(path, push) {
		api('cd=' + encodeURIComponent(path)).then(d => {
			cwd = d.path || '/';
			entries = d.entries || [];
			sel.clear();
			render();
			breadcrumb();
			if (push !== false) history.pushState({ path: cwd }, '', '?cd=' + encodeURIComponent(cwd));
		}).catch(() => { ROWS.innerHTML = '<tr><td colspan="6" class="text-danger small">failed to load</td></tr>'; });
	}

	function breadcrumb() {
		const parts = cwd.split('/').filter(Boolean);
		let acc = '', html = '<li class="breadcrumb-item"><a href="#" data-path="/">/</a></li>';
		for (const p of parts) {
			acc += '/' + p;
			html += '<li class="breadcrumb-item"><a href="#" data-path="' + attr(acc) + '">' + esc(p) + '</a></li>';
		}
		BC.innerHTML = html;
	}

	function sorted() {
		const e = entries.slice();
		e.sort((a, b) => {
			if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1;
			let av = a[sort.key], bv = b[sort.key];
			if (sort.key === 'size' || sort.key === 'mtime') { av = +av; bv = +bv; }
			else { av = String(av).toLowerCase(); bv = String(bv).toLowerCase(); }
			return (av < bv ? -1 : av > bv ? 1 : 0) * sort.dir;
		});
		return e;
	}

	function rowHtml(f) {
		const isdir = f.type === 'dir', icon = isdir ? '📁' : f.type === 'link' ? '🔗' : '📄';
		const a = attr(f.name), nm = esc(f.name) + (isdir ? '/' : '');
		const nameCell = isdir
			? '<a href="#" class="fm-nav text-decoration-none" data-name="' + a + '">' + icon + ' ' + nm + '</a>'
			: '<a href="#" class="fm-dl text-decoration-none" data-name="' + a + '">' + icon + ' ' + nm + '</a>';
		let acts = '<li><a class="dropdown-item fm-act" data-act="download" href="#">Download</a></li>';
		if (!isdir && EDIT.test(f.name)) acts += '<li><a class="dropdown-item fm-act" data-act="edit" href="#">Edit</a></li>';
		if (!isdir && ARC.test(f.name)) acts += '<li><a class="dropdown-item fm-act" data-act="extract" href="#">Extract here</a></li>';
		acts += '<li><a class="dropdown-item fm-act" data-act="rename" href="#">Rename</a></li>'
			+ '<li><a class="dropdown-item fm-act" data-act="chmod" href="#">Permissions</a></li>'
			+ '<li><a class="dropdown-item fm-act text-danger" data-act="delete" href="#">Delete</a></li>';
		return '<tr data-name="' + a + '" data-type="' + f.type + '" data-mode="' + attr(f.mode) + '">'
			+ '<td><input type="checkbox" class="form-check-input fm-chk"' + (sel.has(f.name) ? ' checked' : '') + '></td>'
			+ '<td class="fm-name text-break">' + nameCell + '</td>'
			+ '<td class="text-end font-monospace small">' + (isdir ? '' : humanSize(f.size)) + '</td>'
			+ '<td class="text-center font-monospace small d-none d-md-table-cell">' + esc(f.mode) + '</td>'
			+ '<td class="text-end font-monospace small d-none d-md-table-cell">' + fmtTime(f.mtime) + '</td>'
			+ '<td class="text-end"><div class="dropdown"><button class="btn btn-sm btn-link link-secondary p-0 px-2" type="button" data-bs-toggle="dropdown">⋯</button>'
			+ '<ul class="dropdown-menu dropdown-menu-end">' + acts + '</ul></div></td></tr>';
	}

	function render() {
		const e = sorted();
		ROWS.innerHTML = e.length ? e.map(rowHtml).join('') : '<tr><td colspan="6" class="text-secondary small">empty</td></tr>';
		updateBulk();
	}

	function updateBulk() {
		$('#fm-selcount').textContent = sel.size;
		BULK.className = 'align-items-center gap-2 mb-2 ' + (sel.size ? 'd-flex' : 'd-none');
		const all = $('#fm-all');
		all.checked = entries.length > 0 && sel.size === entries.length;
	}

	function entry(name) { return entries.find(f => f.name === name); }

	function promptModal(title, label, def) {
		return new Promise(resolve => {
			$('#fm-prompt-title').textContent = title;
			$('#fm-prompt-label').textContent = label;
			const input = $('#fm-prompt-input'); input.value = def || '';
			const el = $('#fm-prompt'), modal = bootstrap.Modal.getOrCreateInstance(el), ok = $('#fm-prompt-ok');
			let done = false;
			const finish = v => { if (done) return; done = true; clean(); modal.hide(); resolve(v); };
			const onOk = () => finish(input.value);
			const onKey = e => { if (e.key === 'Enter') { e.preventDefault(); onOk(); } };
			const onHide = () => { if (!done) { done = true; clean(); resolve(null); } };
			const clean = () => { ok.removeEventListener('click', onOk); input.removeEventListener('keydown', onKey); el.removeEventListener('hidden.bs.modal', onHide); };
			ok.addEventListener('click', onOk); input.addEventListener('keydown', onKey); el.addEventListener('hidden.bs.modal', onHide);
			modal.show(); setTimeout(() => input.focus(), 250);
		});
	}

	function rowAction(act, name) {
		const f = entry(name), path = join(cwd, name);
		if (act === 'download') {
			location = '/cgi-bin/j/download.cgi?' + (f.type === 'dir' ? 'tgz=1&' : '') + 'path=' + encodeURIComponent(path);
		} else if (act === 'edit') {
			openEditor(path, name);
		} else if (act === 'extract') {
			op({ op: 'extract', path: path, dir: cwd }).then(d => d.ok ? reload() : alert('Extract failed'));
		} else if (act === 'rename') {
			promptModal('Rename', 'New name', name).then(nn => { if (nn && nn !== name) op({ op: 'rename', path: path, newname: nn }).then(d => d.ok ? reload() : alert('Rename failed')); });
		} else if (act === 'chmod') {
			promptModal('Permissions', 'Octal mode (e.g. 644)', f.mode).then(m => { if (m) op({ op: 'chmod', path: path, mode: m }).then(d => d.ok ? reload() : alert('chmod failed')); });
		} else if (act === 'delete') {
			if (confirm('Delete ' + name + '?')) op({ op: 'delete', path: path }).then(d => d.ok ? reload() : alert('Delete failed'));
		}
	}

	// ---- upload (native /upload, raw body, progress) ----
	function uploadFiles(files) {
		const list = Array.from(files); if (!list.length) return;
		const bar = $('#fm-progress'), inner = bar.querySelector('.progress-bar');
		bar.classList.remove('d-none');
		let i = 0;
		(function next() {
			if (i >= list.length) { bar.classList.add('d-none'); inner.style.width = '0'; reload(); return; }
			const file = list[i++];
			const xhr = new XMLHttpRequest();
			xhr.open('POST', '/upload', true);
			try { xhr.setRequestHeader('File-Location', join(cwd, file.name)); }
			catch (e) { next(); return; }
			xhr.upload.onprogress = e => { if (e.lengthComputable) inner.style.width = (e.loaded / e.total * 100).toFixed(0) + '%'; };
			xhr.onload = next; xhr.onerror = next;
			xhr.send(file);
		})();
	}

	// ---- inline editor (CodeMirror from CDN, falls back to textarea) ----
	let cm = null, cmLoad = null;
	function loadCM() {
		if (window.CodeMirror) return Promise.resolve(true);
		if (cmLoad) return cmLoad;
		cmLoad = new Promise(res => {
			const css = document.createElement('link');
			css.rel = 'stylesheet'; css.href = 'https://cdn.jsdelivr.net/npm/codemirror@5.65.16/lib/codemirror.min.css';
			document.head.appendChild(css);
			const js = document.createElement('script');
			js.src = 'https://cdn.jsdelivr.net/npm/codemirror@5.65.16/lib/codemirror.min.js';
			js.onload = () => res(true); js.onerror = () => res(false);
			document.head.appendChild(js);
		});
		return cmLoad;
	}
	function openEditor(path, name) {
		const ta = $('#fm-editor-text'), st = $('#fm-editor-status');
		$('#fm-editor-title').textContent = name;
		st.textContent = 'loading…'; ta.value = '';
		if (cm) { cm.toTextArea(); cm = null; }
		bootstrap.Modal.getOrCreateInstance('#fm-editor').show();
		fetch('/cgi-bin/j/files.cgi?cat=' + encodeURIComponent(path), { credentials: 'same-origin' })
			.then(r => r.ok ? r.text() : Promise.reject()).then(text => {
				ta.value = text; st.textContent = '';
				loadCM().then(ok => {
					if (ok && window.CodeMirror && !cm) {
						cm = window.CodeMirror.fromTextArea(ta, { lineNumbers: true });
						cm.setSize(null, '60vh');
					}
				});
			}).catch(() => { st.textContent = 'failed to load'; });
		$('#fm-editor-save').onclick = () => {
			const content = cm ? cm.getValue() : ta.value;
			st.textContent = 'saving…';
			fetch('/cgi-bin/j/save.cgi?path=' + encodeURIComponent(path), { method: 'POST', credentials: 'same-origin', body: content })
				.then(r => r.json()).then(d => { st.textContent = d.ok ? 'saved' : ('error: ' + (d.error || '')); if (d.ok) reload(); })
				.catch(() => { st.textContent = 'save failed'; });
		};
	}

	function init() {
		// row interactions (delegated)
		ROWS.addEventListener('click', e => {
			const nav = e.target.closest('.fm-nav');
			if (nav) { e.preventDefault(); load(join(cwd, nav.dataset.name)); return; }
			const dl = e.target.closest('.fm-dl');
			if (dl) { e.preventDefault(); location = '/cgi-bin/j/download.cgi?path=' + encodeURIComponent(join(cwd, dl.dataset.name)); return; }
			const act = e.target.closest('.fm-act');
			if (act) { e.preventDefault(); rowAction(act.dataset.act, act.closest('tr').dataset.name); }
		});
		ROWS.addEventListener('change', e => {
			if (!e.target.classList.contains('fm-chk')) return;
			const name = e.target.closest('tr').dataset.name;
			if (e.target.checked) sel.add(name); else sel.delete(name);
			updateBulk();
		});
		$('#fm-all').addEventListener('change', e => {
			sel.clear();
			if (e.target.checked) entries.forEach(f => sel.add(f.name));
			render();
		});
		BC.addEventListener('click', e => { const a = e.target.closest('a[data-path]'); if (a) { e.preventDefault(); load(a.dataset.path); } });
		$$('.fm-sortable').forEach(th => th.addEventListener('click', () => {
			const k = th.dataset.sort;
			sort.dir = sort.key === k ? -sort.dir : 1; sort.key = k; render();
		}));
		$('#fm-newfolder').addEventListener('click', () => promptModal('New folder', 'Folder name', '').then(n => { if (n) op({ op: 'mkdir', dir: cwd, name: n }).then(d => d.ok ? reload() : alert('Failed')); }));
		$('#fm-newfile').addEventListener('click', () => promptModal('New file', 'File name', '').then(n => { if (n) op({ op: 'newfile', dir: cwd, name: n }).then(d => d.ok ? reload() : alert('Failed')); }));
		$('#fm-upload-btn').addEventListener('click', () => $('#fm-upload').click());
		$('#fm-upload').addEventListener('change', e => { uploadFiles(e.target.files); e.target.value = ''; });
		$('#fm-bulk-del').addEventListener('click', () => {
			if (!sel.size || !confirm('Delete ' + sel.size + ' item(s)?')) return;
			const list = Array.from(sel).map(n => join(cwd, n)).join('\n');
			op({ op: 'bulkdelete', paths: b64(list) }).then(reload);
		});
		$('#fm-bulk-dl').addEventListener('click', () => {
			if (!sel.size) return;
			const names = Array.from(sel).join('\n');
			location = '/cgi-bin/j/download.cgi?tgz=1&path=' + encodeURIComponent(cwd) + '&paths=' + encodeURIComponent(b64(names));
		});
		// drag & drop
		const drop = $('#fm-drop');
		['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('fm-dragover'); }));
		['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); if (ev === 'dragleave' && drop.contains(e.relatedTarget)) return; drop.classList.remove('fm-dragover'); }));
		drop.addEventListener('drop', e => { if (e.dataTransfer && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files); });

		window.addEventListener('popstate', e => load((e.state && e.state.path) || '/', false));

		const m = location.search.match(/[?&]cd=([^&]*)/);
		load(m ? decodeURIComponent(m[1]) : '/', false);
	}

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
	else init();
})();
