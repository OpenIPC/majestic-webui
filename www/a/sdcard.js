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

	function api(qs) { return apiFetch('/cgi-bin/j/sdcard.cgi' + (qs ? '?' + qs : ''), { credentials: 'same-origin' }).then(r => r.json()); }
	function op(p) {
		return apiFetch('/cgi-bin/j/sdcard.cgi', {
			method: 'POST', credentials: 'same-origin',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(p).toString(),
		}).then(r => r.json());
	}
	function setConfig(obj) {
		return apiFetch('/api/v1/config', {
			method: 'POST', credentials: 'same-origin',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(obj),
		}).then(r => r.ok);
	}

	function load() {
		// fetch config fresh each time (so record-toggle changes show immediately)
		return apiFetch('/api/v1/config.json', { credentials: 'same-origin' })
			.then(r => r.ok ? r.json() : {}).catch(() => ({}))
			.then(c => { cfg = c; const rp = recPrefix(); return api(rp ? 'rec=' + encodeURIComponent(rp) : ''); })
			.then(d => { state = d; render(); })
			.catch(() => { SD.innerHTML = '<div class="alert alert-danger">Failed to read SD-card status.</div>'; });
	}

	// `ok` is spelled out rather than left as the default: render() calls this
	// with {} before the first fetch lands and after a failed one, and an
	// unknown card must not be badged as a healthy one.
	function badge(d) {
		switch (d.health) {
		case 'ok': return '<span class="badge text-bg-success">Mounted</span>';
		case 'readonly': return '<span class="badge text-bg-danger">Read-only</span>';
		case 'unreadable': return '<span class="badge text-bg-danger">No filesystem</span>';
		case 'unformatted': return '<span class="badge text-bg-danger">Unformatted</span>';
		case 'unmounted': return '<span class="badge text-bg-warning">Not mounted</span>';
		default: return '<span class="badge text-bg-secondary">No card</span>';
		}
	}

	// What to do about a card that cannot be recorded to. `fsck` is the right
	// answer where the firmware has the helper for this filesystem, and is not
	// an answer at all where it does not: busybox ships the generic `fsck`
	// wrapper on every build, but it only execs `fsck.<fs>`, and a build
	// without dosfstools has no fsck.vfat for it to find. Saying "run Check"
	// there would send people after a button the page has not drawn.
	function remedy(d) {
		if (d.canFsck) {
			return {
				text: 'Checking the filesystem is the next step: it unmounts the card, repairs what it can and mounts it back.',
				btn: '<button class="btn btn-sm btn-danger" data-act="fsck">Check and repair</button>',
			};
		}
		return {
			text: (d.fs
				? 'This firmware ships no <code>fsck.' + esc(d.fs) + '</code>, so there is no repair to offer: ' +
					'copy off anything you still need, then reformat.'
				: 'With no filesystem to read there is nothing a repair tool could work on — the card has to be reformatted.') +
				' A card that goes bad again soon afterwards is worn out; replace it.',
			btn: '<button class="btn btn-sm btn-danger" data-act="format">Format the card…</button>',
		};
	}

	// Kernel messages, when there are any. Shown as corroboration and never as
	// a verdict: the ring buffer is small and chatty, so the errors that
	// stopped a recording hours ago have usually scrolled out of it. An empty
	// list means nothing was found, not that nothing happened — which is why
	// this renders nothing at all rather than "no errors".
	function kernelLines(d) {
		if (!d.fsErrors || !d.fsErrors.length) return '';
		return '<div class="mt-2"><div class="x-small text-secondary mb-1">Recent kernel messages about this card:</div>' +
			'<pre class="x-small mb-0" style="white-space:pre-wrap">' + esc(d.fsErrors.join('\n')) + '</pre></div>';
	}

	// The one thing the rest of the page cannot tell you. Everything else here
	// — capacity, free space, the storage bar — reads exactly the same on a
	// card that has been read-only since lunchtime as on a healthy one.
	function health(d) {
		let title, body;
		if (d.health === 'readonly') {
			title = 'This card is mounted read-only.';
			body = 'Nothing can be written to it, so recording is not running — whatever the free space below says. ' +
				'The kernel drops a card to read-only the moment its filesystem stops making sense ' +
				'(<code>errors=remount-ro</code>), so treat this as a damaged filesystem. ';
		} else if (d.health === 'unreadable') {
			title = 'No filesystem can be read from this card.';
			body = 'The partition is there, but nothing on the camera recognises what is inside it — ' +
				'it was either never formatted, or the filesystem is damaged past recognition. ';
		} else {
			return '';
		}
		const fix = remedy(d);
		return '<div class="alert alert-danger"><strong>' + title + '</strong> ' + body + fix.text +
			kernelLines(d) + '<div class="mt-2">' + fix.btn + '</div></div>';
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
		// The free figure is what df reports, and df keeps reporting the space
		// that was free at the moment the kernel stopped letting anything use
		// it. Left unqualified it is the single most misleading number on this
		// page — the reason a dead card reads as healthy.
		const cap = d.health === 'readonly'
			? '<span class="text-danger">' + humanBytes(free) + ' free, but nothing can be written</span>'
			: '<span class="text-secondary">' + humanBytes(used) + ' of ' + humanBytes(total) + ' used</span>';
		return '<div class="d-flex justify-content-between x-small mb-1"><span class="fw-semibold">Storage</span>' + cap + '</div>'
			+ '<div class="storage-bar mb-2">' + bar + '</div><div class="storage-legend x-small mb-2">' + leg + '</div>';
	}

	function render() {
		const d = state;
		const head = '<div class="d-flex align-items-center gap-3 mb-4"><h2 class="text-primary m-0">SD Card</h2>' + badge(d || {}) + '</div>';
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

		SD.innerHTML = head + health(d) + '<div class="row g-4">'
			+ '<div class="col-12 col-lg-7"><div class="card h-100"><div class="card-body">'
			+ '<dl class="small list mb-3">'
			+ '<dt>Model</dt><dd>' + esc(d.model || '—') + ' <span class="text-secondary">(' + esc(d.cardtype || 'SD') + ')</span></dd>'
			+ '<dt>Capacity</dt><dd>' + humanBytes(d.sizeBytes) + '</dd>'
			+ '<dt>Filesystem</dt><dd>' + (d.fs ? esc(d.fs)
				: '<span class="text-danger">' + (d.health === 'unreadable' ? 'none readable' : 'unformatted') + '</span>') + '</dd>'
			+ '<dt>Mount</dt><dd>' + (d.mounted
				? esc(d.mountpoint) + (d.health === 'readonly' ? ' <span class="text-danger">— read-only</span>' : '')
				: 'not mounted') + '</dd>'
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
			+ (onThisCard
				// "Recording to this card" is a claim about what is happening,
				// not about what is configured, so it has to know the card is
				// writable before it makes it.
				? (d.health === 'readonly'
					? '<div class="x-small text-danger mb-3">Configured to record here, but the card is read-only — nothing is being written.</div>'
					: '<div class="x-small text-success mb-3">✓ Recording to this card</div>')
				: (d.mounted && d.health !== 'readonly'
					? '<button class="btn btn-sm btn-primary mb-3" id="sd-use">Use this card for recording</button>' : ''))
			+ '<div><a class="small" href="camera.cgi?tab=records">Recording settings →</a></div>'
			+ '</div></div></div></div>';
	}

	function busy(btn) { if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>'; } }
	function after(r) { if (r && r.ok === false) alert('Failed: ' + (r.error || '')); load(); }

	// Bound once, to the container the page never replaces. It used to be bound
	// per render to #sd-actions, which was safe only because that element was
	// thrown away each time; #sd is not, and this page re-renders every five
	// seconds. Delegating from here also lets the health alert offer the same
	// data-act buttons as the actions row.
	function wire() {
		SD.addEventListener('click', e => {
			const b = e.target.closest('[data-act]'); if (!b) return;
			const act = b.dataset.act;
			if (act === 'browse') { location = 'files.cgi?cd=' + encodeURIComponent(state.mountpoint); return; }
			if (act === 'format') { openFormat(); return; }
			if (act === 'fsck' && !confirm('Unmount and check the filesystem?')) return;
			busy(b); op({ op: act }).then(after);
		});
		SD.addEventListener('click', e => {
			const use = e.target.closest('#sd-use'); if (!use) return;
			busy(use); setConfig({ records: { path: state.mountpoint + '/%F', enabled: true } }).then(load);
		});
		SD.addEventListener('change', e => {
			const tog = e.target.closest('#sd-rec-toggle'); if (!tog) return;
			tog.disabled = true; setConfig({ records: { enabled: tog.checked } }).then(load);
		});
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

	wire();
	load().then(() => { clearInterval(timer); timer = setInterval(() => { if (!document.hidden) load(); }, 5000); });
})();
