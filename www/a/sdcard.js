// SD-card page: JSON status + format/mount/fsck ops + recording integration.
(function () {
	const SD = $('#sd');
	let state = null, cfg = {}, timer = null;

	function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
	function humanBytes(n) {
		n = +n || 0;
		if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB';
		if (n >= 1048576) return (n / 1048576).toFixed(0) + ' MB';
		if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
		return n + ' B';
	}
	function recPrefix() { return (mjGet(cfg, 'records.path') || '').split('%')[0].replace(/\/+$/, ''); }

	function api(qs) { return fetch('/cgi-bin/j/sdcard.cgi' + (qs ? '?' + qs : ''), { credentials: 'same-origin' }).then(r => r.json()); }
	function op(p) {
		return fetch('/cgi-bin/j/sdcard.cgi', {
			method: 'POST', credentials: 'same-origin',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(p).toString(),
		}).then(r => r.json());
	}
	function setConfig(obj) {
		return fetch('/api/v1/config', {
			method: 'POST', credentials: 'same-origin',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(obj),
		}).then(r => r.ok);
	}

	function load() {
		// fetch config fresh each time (so record-toggle changes show immediately)
		return fetch('/api/v1/config.json', { credentials: 'same-origin' })
			.then(r => r.ok ? r.json() : {}).catch(() => ({}))
			.then(c => { cfg = c; const rp = recPrefix(); return api(rp ? 'rec=' + encodeURIComponent(rp) : ''); })
			.then(d => { state = d; render(); })
			.catch(() => { SD.innerHTML = '<div class="alert alert-danger">Failed to read SD-card status.</div>'; });
	}

	function badge(d) {
		if (!d.present) return '<span class="badge text-bg-secondary">No card</span>';
		if (d.mounted) return '<span class="badge text-bg-success">Mounted</span>';
		if (d.fs) return '<span class="badge text-bg-warning">Not mounted</span>';
		return '<span class="badge text-bg-danger">Unformatted</span>';
	}

	function storageBar(d) {
		if (!d.mounted || !d.totalKb) return '';
		const total = d.totalKb * 1024, used = d.usedKb * 1024;
		const rec = Math.min(d.recBytes || 0, used), other = Math.max(0, used - rec), free = Math.max(0, total - used);
		const segs = [];
		if (rec > 0) segs.push({ name: 'Recordings', b: rec, c: '#4c60d8' });
		if (other > 0) segs.push({ name: 'Other', b: other, c: '#e08a3c' });
		const bar = segs.map(s => '<div class="seg" style="width:' + (s.b / total * 100).toFixed(2) + '%;background:' + s.c + '" title="' + s.name + ' ' + humanBytes(s.b) + '"></div>').join('');
		const leg = segs.map(s => '<span><i class="dot" style="background:' + s.c + '"></i>' + s.name + ' <span class="text-secondary">' + humanBytes(s.b) + '</span></span>').join('')
			+ '<span><i class="dot dot-free"></i>Free <span class="text-secondary">' + humanBytes(free) + '</span></span>';
		return '<div class="d-flex justify-content-between x-small mb-1"><span class="fw-semibold">Storage</span><span class="text-secondary">' + humanBytes(used) + ' of ' + humanBytes(total) + ' used</span></div>'
			+ '<div class="storage-bar mb-2">' + bar + '</div><div class="storage-legend x-small mb-2">' + leg + '</div>';
	}

	function render() {
		const d = state;
		const head = '<div class="d-flex align-items-center gap-3 mb-4 mt-n3"><h2 class="text-primary m-0">SD Card</h2>' + badge(d || {}) + '</div>';
		if (!d || !d.present) {
			SD.innerHTML = head + '<div class="alert alert-secondary">No SD card detected. Insert a card and reload.</div>';
			return;
		}
		const rp = recPrefix(), recEnabled = mjGet(cfg, 'records.enabled') === true;
		const onThisCard = d.mounted && rp === d.mountpoint;

		let acts = '<button class="btn btn-sm btn-outline-secondary" data-act="browse"' + (d.mounted ? '' : ' disabled') + '>Browse files</button>';
		if (d.mounted) acts += '<button class="btn btn-sm btn-outline-secondary" data-act="unmount">Unmount</button>';
		else if (d.fs) acts += '<button class="btn btn-sm btn-outline-secondary" data-act="mount">Mount</button>';
		if (d.canFsck) acts += '<button class="btn btn-sm btn-outline-secondary" data-act="fsck">Check</button>';
		acts += '<button class="btn btn-sm btn-outline-danger" data-act="format">Format…</button>';

		SD.innerHTML = head + '<div class="row g-4">'
			+ '<div class="col-12 col-lg-7"><div class="card h-100"><div class="card-body">'
			+ '<dl class="small list mb-3">'
			+ '<dt>Model</dt><dd>' + esc(d.model || '—') + ' <span class="text-secondary">(' + esc(d.cardtype || 'SD') + ')</span></dd>'
			+ '<dt>Capacity</dt><dd>' + humanBytes(d.sizeBytes) + '</dd>'
			+ '<dt>Filesystem</dt><dd>' + (d.fs ? esc(d.fs) : '<span class="text-danger">unformatted</span>') + '</dd>'
			+ '<dt>Mount</dt><dd>' + (d.mounted ? esc(d.mountpoint) : 'not mounted') + '</dd>'
			+ '<dt>Manufactured</dt><dd class="text-secondary">' + esc(d.date || '—') + '</dd>'
			+ '</dl>'
			+ storageBar(d)
			+ '<div class="d-flex flex-wrap gap-2 mt-2" id="sd-actions">' + acts + '</div>'
			+ '</div></div></div>'
			+ '<div class="col-12 col-lg-5"><div class="card h-100"><div class="card-body">'
			+ '<div class="d-flex align-items-center mb-3"><h3 class="m-0 me-auto">Recording</h3>'
			+ '<div class="form-check form-switch m-0"><input class="form-check-input" type="checkbox" id="sd-rec-toggle"' + (recEnabled ? ' checked' : '') + '></div></div>'
			+ '<dl class="small list mb-3">'
			+ '<dt>Status</dt><dd>' + (recEnabled ? '<span class="badge text-bg-success">Enabled</span>' : '<span class="badge text-bg-secondary">Disabled</span>') + '</dd>'
			+ '<dt>Path</dt><dd class="text-break">' + esc(mjGet(cfg, 'records.path') || '—') + '</dd>'
			+ '<dt>Split</dt><dd>' + (mjGet(cfg, 'records.split') || '—') + ' min</dd>'
			+ '<dt>Max usage</dt><dd>' + (mjGet(cfg, 'records.maxUsage') || '—') + ' %</dd>'
			+ '</dl>'
			+ (d.mounted && !onThisCard ? '<button class="btn btn-sm btn-primary mb-3" id="sd-use">Use this card for recording</button>'
				: (onThisCard ? '<div class="x-small text-success mb-3">✓ Recording to this card</div>' : ''))
			+ '<div><a class="small" href="mj-settings.cgi?tab=records">Recording settings →</a></div>'
			+ '</div></div></div></div>';

		wire();
	}

	function busy(btn) { if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>'; } }
	function after(r) { if (r && r.ok === false) alert('Failed: ' + (r.error || '')); load(); }

	function wire() {
		const acts = $('#sd-actions');
		if (acts) acts.addEventListener('click', e => {
			const b = e.target.closest('[data-act]'); if (!b) return;
			const act = b.dataset.act;
			if (act === 'browse') { location = 'tool-files.cgi?cd=' + encodeURIComponent(state.mountpoint); return; }
			if (act === 'format') { openFormat(); return; }
			if (act === 'fsck' && !confirm('Unmount and check the filesystem?')) return;
			busy(b); op({ op: act }).then(after);
		});
		const tog = $('#sd-rec-toggle');
		if (tog) tog.addEventListener('change', () => { tog.disabled = true; setConfig({ records: { enabled: tog.checked } }).then(load); });
		const use = $('#sd-use');
		if (use) use.addEventListener('click', () => { busy(use); setConfig({ records: { path: state.mountpoint + '/%F', enabled: true } }).then(load); });
	}

	function openFormat() {
		const sel = $('#sd-format-fs'), log = $('#sd-format-log'), st = $('#sd-format-status'), go = $('#sd-format-go');
		const fss = (state.mkfs && state.mkfs.length) ? state.mkfs : ['vfat'];
		sel.innerHTML = fss.map(f => '<option value="' + f + '">' + f.toUpperCase() + (f === 'vfat' ? ' (FAT32)' : '') + '</option>').join('');
		log.classList.add('d-none'); log.textContent = ''; st.textContent = '';
		go.disabled = false; go.textContent = 'Format';
		const modal = bootstrap.Modal.getOrCreateInstance('#sd-format');
		go.onclick = () => {
			if (!confirm('Erase ALL data and format the card as ' + sel.value + '?')) return;
			go.disabled = true; st.textContent = 'Formatting… do not power off';
			op({ op: 'format', fs: sel.value }).then(r => {
				st.textContent = r.ok ? 'Done' : ('Failed: ' + (r.error || ''));
				if (r.log) { log.classList.remove('d-none'); log.textContent = r.log; }
				if (r.ok) { setTimeout(() => { modal.hide(); load(); }, 800); } else { go.disabled = false; }
			}).catch(() => { st.textContent = 'Request failed'; go.disabled = false; });
		};
		modal.show();
	}

	load().then(() => { clearInterval(timer); timer = setInterval(() => { if (!document.hidden) load(); }, 5000); });
})();
