// File manager: JSON-driven listing, ops, drag-drop upload, inline editor.
(function () {
	const ROWS = $('#fm-rows'), BC = $('#fm-breadcrumb ol'), BULK = $('#fm-bulk');
	let cwd = '/', entries = [], sort = { key: 'name', dir: 1 };
	const sel = new Set();
	const EDIT = /\.(ya?ml|conf|txt|sh|cgi|html?|css|js|json|xml|md|log|ini|cfg)$/i;
	const ARC = /\.(tar\.gz|tgz|tar|zip|gz)$/i;
	const VID = /\.(mp4|m4v|mov|mkv|webm|ts|avi)$/i;
	const IMG = /\.(jpe?g|png|gif|webp|bmp|svg|heic|heif)$/i;
	const AUD = /\.(mp3|m4a|aac|wav|opus|ogg)$/i;

	function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
	function attr(s) { return String(s).replace(/["&<>]/g, c => ({ '"': '&quot;', '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
	function join(d, n) { return (d.replace(/\/+$/, '') + '/' + n).replace(/\/{2,}/g, '/'); }
	// Serve files straight off the filesystem instead of through download.cgi:
	// majestic's static handler falls back to the absolute path and streams it
	// with sendfile, where the CGI would cat a whole recording into the
	// connection buffer and take the camera's RAM with it.
	function fileUrl(p) { return p.split('/').map(encodeURIComponent).join('/'); }
	function isMedia(n) { return VID.test(n) || IMG.test(n) || AUD.test(n); }
	// Types the browser would execute in the camera's own origin if it ever
	// rendered them inline instead of saving them.
	const ACTIVE = /\.(x?html?|xht|svg|xml)$/i;
	// Above this, an active file goes direct like everything else. Firmware
	// carrying the CGI flow-control fix caps the buffer at 1 MiB, but this UI
	// still has to be safe on the builds that predate it — which is the whole
	// reason downloads went direct in the first place — and there the CGI
	// holds the entire file in RAM.
	const CGI_ATTACH_MAX = 1048576;
	function download(path, name) {
		const f = entry(name);
		if (ACTIVE.test(name) && f && f.size <= CGI_ATTACH_MAX) {
			// download.cgi pins Content-Disposition: attachment, which the
			// static handler cannot.
			location = '/cgi-bin/j/download.cgi?path=' + encodeURIComponent(path);
			return;
		}
		const a = document.createElement('a');
		a.href = fileUrl(path);
		a.download = name; // same-origin, so this wins over an inline media type
		document.body.appendChild(a);
		a.click();
		a.remove();
	}
	function b64(s) { return btoa(unescape(encodeURIComponent(s))); }
	function humanSize(n) { n = +n || 0; if (n >= 1048576) return (n / 1048576).toFixed(1) + ' M'; if (n >= 1024) return (n / 1024).toFixed(0) + ' K'; return n + ' B'; }
	// Modified times render in the *camera's* zone, unlike the log viewer, because
	// everything else on this screen is already stamped in it: majestic writes
	// recordings to records.path "/mnt/mmcblk0p1/%F" with records.filename
	// "%H-%M", so the directory and the file name are both strftime in device
	// local time. Showing the browser's clock next to a folder called 2026-08-12
	// holding 20-00.mp4 can disagree on the hour and, far enough east or west, on
	// the date. The viewer's own equivalent stays one hover away.
	//
	// Conversion prefers Intl with the camera's real IANA zone over the flat
	// offset the header bar uses, because these timestamps are historical. A flat
	// offset is the *current* one, so on a DST zone every file written the other
	// side of a transition renders an hour off the %H-%M in its own name — and an
	// SD card holds months where the log ring holds minutes. /etc/timezone is
	// stored de-underscored (fw-time.js:13 writes "America/New York"), so putting
	// the underscores back recovers the name Intl wants; the flat offset stays as
	// the fallback for a label it will not accept.
	let devOffsetMs = null, devZone = '', devIana = null;
	function ianaOrNull(label) {
		try {
			const z = String(label).replace(/ /g, '_');
			new Intl.DateTimeFormat('en', { timeZone: z }).format(0);
			return z;
		} catch (e) { return null; }
	}
	function fmtTime(s) {
		const ms = s * 1000;
		if (!ms) return '';
		if (devIana) return new Date(ms).toLocaleString(undefined, { timeZone: devIana });
		if (devOffsetMs !== null) return fmtDeviceTime(ms, devOffsetMs); // main.js
		return new Date(ms).toLocaleString(); // pre-pulse
	}
	function titleTime(s) {
		const ms = s * 1000;
		if (!ms || (devIana === null && devOffsetMs === null)) return '';
		return attr(devZone + ' — ' + new Date(ms).toLocaleString() + ' your time');
	}

	fetch('/cgi-bin/j/pulse.cgi', { credentials: 'same-origin' }).then(r => r.json()).then(j => {
		devZone = j.timezone || '';
		devIana = ianaOrNull(devZone);
		devOffsetMs = parseTzOffsetMs(j.utc_offset); // main.js; null if unusable
		// Neither usable: keep the browser rendering rather than a wrong one.
		if (devIana === null && devOffsetMs === null) return;
		// Only restamp an existing listing; rendering an empty one would replace
		// the "loading…" placeholder with "empty" before the first load lands.
		if (entries.length) render();
	}).catch(() => {});
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
		const isdir = f.type === 'dir', media = !isdir && isMedia(f.name);
		const icon = isdir ? '📁' : media ? (VID.test(f.name) ? '🎬' : IMG.test(f.name) ? '🖼️' : '🎵') : f.type === 'link' ? '🔗' : '📄';
		const a = attr(f.name), nm = esc(f.name) + (isdir ? '/' : '');
		const cls = isdir ? 'fm-nav' : media ? 'fm-view' : 'fm-dl';
		const nameCell = '<a href="#" class="' + cls + ' text-decoration-none" data-name="' + a + '">' + icon + ' ' + nm + '</a>';
		let acts = '';
		if (media) acts += '<li><a class="dropdown-item fm-act" data-act="view" href="#">Play / view</a></li>';
		acts += '<li><a class="dropdown-item fm-act" data-act="download" href="#">Download</a></li>';
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
			+ '<td class="text-end font-monospace small d-none d-md-table-cell" title="' + titleTime(f.mtime) + '">' + esc(fmtTime(f.mtime)) + '</td>'
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
			// a folder still has to be packed server-side; a plain file does not
			if (f.type === 'dir') location = '/cgi-bin/j/download.cgi?tgz=1&path=' + encodeURIComponent(path);
			else download(path, name);
		} else if (act === 'view') {
			openPreview(path, name);
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

	// ---- codec probe ----
	// A recording is .mp4 whether it holds H.264 or H.265, and canPlayType()
	// on the container alone always answers "maybe", so the extension tells us
	// nothing. Read the codec out of the file: 16 KiB covers ftyp + moov on
	// everything majestic writes.
	function fourcc(u8, i) {
		return String.fromCharCode(u8[i], u8[i + 1], u8[i + 2], u8[i + 3]);
	}
	function be32(u8, i) { return (u8[i] << 24 | u8[i + 1] << 16 | u8[i + 2] << 8 | u8[i + 3]) >>> 0; }

	// Search only inside moov: mdat payload can spell 'hvc1' by chance.
	function codecFromHeader(u8) {
		let off = 0, moov = null;
		while (off + 8 <= u8.length) {
			const size = be32(u8, off), type = fourcc(u8, off + 4);
			if (size < 8) break;
			if (type === 'moov') { moov = [off + 8, Math.min(off + size, u8.length)]; break; }
			off += size;
		}
		if (!moov) return null;

		const hex = n => n.toString(16).padStart(2, '0');
		for (let i = moov[0]; i < moov[1] - 4; i++) {
			const t = fourcc(u8, i);
			if (t === 'hvc1' || t === 'hev1') return t + '.1.6.L93.B0';
			if (t === 'av01') return 'av01.0.05M.08';
			if (t === 'avc1' || t === 'avc3') {
				// the avcC that follows carries profile/compat/level verbatim
				for (let j = i; j < moov[1] - 8; j++) {
					if (fourcc(u8, j) === 'avcC') {
						return t + '.' + hex(u8[j + 5]) + hex(u8[j + 6]) + hex(u8[j + 7]);
					}
				}
				return t + '.42E01E';
			}
		}
		return null;
	}

	function probeCodec(path, signal) {
		// no-store: this 16 KiB slice is not a copy of the file worth keeping
		// around under the URL the <video> is about to request.
		return fetch(fileUrl(path), {
			credentials: 'same-origin', cache: 'no-store', signal,
			headers: { Range: 'bytes=0-16383' },
		}).then(res => {
			if (!res.ok || !res.body) return null;
			// Firmware without Range support answers 200 with the whole file,
			// so read a header's worth and drop the rest on the floor.
			const reader = res.body.getReader();
			const chunks = [];
			let total = 0;
			const pump = () => reader.read().then(({ done, value }) => {
				if (done) return;
				chunks.push(value); total += value.length;
				if (total < 16384) return pump();
				reader.cancel().catch(() => {});
			});
			return pump().then(() => {
				const u8 = new Uint8Array(total);
				let at = 0;
				for (const c of chunks) { u8.set(c, at); at += c.length; }
				return codecFromHeader(u8);
			});
		}).catch(() => null);
	}

	// ---- media preview (plays straight off the card, nothing downloaded) ----
	function openPreview(path, name) {
		const body = $('#fm-preview-body'), st = $('#fm-preview-status');
		const url = fileUrl(path);
		$('#fm-preview-title').textContent = name;
		$('#fm-preview-dl').href = url;
		$('#fm-preview-dl').download = name;
		st.textContent = '';

		let el;
		if (VID.test(name)) {
			el = document.createElement('video');
			el.controls = true;
			el.playsInline = true; // keeps iOS from hijacking it fullscreen
			el.preload = 'metadata';
			el.className = 'w-100';
			el.style.maxHeight = '70vh';
		} else if (AUD.test(name)) {
			el = document.createElement('audio');
			el.controls = true;
			el.className = 'w-100 my-3';
		} else {
			el = document.createElement('img');
			el.className = 'mw-100';
			el.style.maxHeight = '70vh';
		}
		el.addEventListener('error', () => {
			st.textContent = 'Cannot play this file in the browser — download it instead.';
		});

		body.innerHTML = ""; body.appendChild(el);
		const modal = bootstrap.Modal.getOrCreateInstance('#fm-preview');
		let stall = null, closed = false;
		const abort = new AbortController();
		$('#fm-preview').addEventListener('hidden.bs.modal', () => {
			// drop the source, or the browser keeps pulling from the card
			closed = true;
			abort.abort();
			clearTimeout(stall);
			if (el.pause) el.pause();
			el.removeAttribute('src');
			if (el.load) el.load();
			body.innerHTML = "";
		}, { once: true });
		modal.show();

		if (!VID.test(name)) { el.src = url; return; }

		// An unplayable codec does NOT raise `error` on a <video>: H.265 parses
		// fine, reports a duration, then sits at videoWidth 0 fetching ranges
		// forever. So ask first, and keep a stall timer for the cases a codec
		// string can't settle (HEVC Main10 on a Main-only decoder, say).
		st.textContent = 'Checking codec…';
		probeCodec(path, abort.signal).then(codec => {
			// The probe outlives a quick close. Assigning src to a detached
			// element still loads it, so a closed preview would go on pulling
			// the clip off the card with nothing on screen.
			if (closed) return;
			if (codec && !el.canPlayType('video/mp4; codecs="' + codec + '"')) {
				const family = /^(hvc1|hev1)/.test(codec) ? 'H.265 (HEVC)' : codec.split('.')[0];
				st.textContent = family + ' — this browser cannot decode it. Download the clip and play it in VLC, or open this page on a device with ' + family + ' support.';
				body.innerHTML = '';
				return;
			}
			st.textContent = '';
			el.src = url;
			// Deliberately tentative: over a slow link a perfectly good clip can
			// still be loading here, and the codec check above already caught
			// the cases we can name.
			stall = setTimeout(() => {
				if (!el.videoWidth) {
					st.textContent = 'Still loading… if no picture appears, download the clip and play it in VLC.';
				}
			}, 30000);
			// clear the timer *and* the notice: a 4K clip over a slow link can
			// trip the warning and then load perfectly well a moment later
			el.addEventListener('loadedmetadata', () => {
				clearTimeout(stall);
				st.textContent = '';
			}, { once: true });
		});
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
			const view = e.target.closest('.fm-view');
			if (view) { e.preventDefault(); openPreview(join(cwd, view.dataset.name), view.dataset.name); return; }
			const dl = e.target.closest('.fm-dl');
			if (dl) { e.preventDefault(); download(join(cwd, dl.dataset.name), dl.dataset.name); return; }
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
