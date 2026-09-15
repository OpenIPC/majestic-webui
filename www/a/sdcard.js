// SD-card page: JSON status + format/mount/fsck ops + recording integration.
(function () {
	const SD = $('#sd');
	let state = null, cfg = {}, timer = null;
	// The recorder half, which the SD endpoint cannot see: a card can be mounted
	// read-write with room on it and still be losing footage, and nothing in the
	// filesystem says so.
	//
	//   { v: … }         a reading
	//   { absent: true } majestic answered and has no such endpoint
	//   null             not asked yet, or the ask failed
	let recorder = null;
	// Achieved write rate, derived from the heartbeat's own snapshot of the
	// previous poll rather than from bookkeeping of our own — that snapshot and
	// its `dt` are there for exactly this, and main.js explains why the window
	// is the browser's monotonic clock and not the camera's.
	let rateBps = null;
	let speed = null, speedBusy = false, speedErr = '';

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
			.catch(() => { SD.innerHTML = mjNotice('danger', 'Failed to read SD-card status.'); });
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
		// The verdict is the sentence; what to do about it, the kernel's
		// corroboration and the button go in the notice's body row. This is the
		// one call site in the tree that needs that row -- everything else the
		// component carries is one line and an action.
		return mjNotice('danger', '<strong>' + title + '</strong> ' + body, {
			body: fix.text + kernelLines(d) + '<div class="mt-2">' + fix.btn + '</div>',
		});
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

	// Video rates are read in Mbit/s from about 1 Mbit/s up, which is where the
	// switch belongs — on the figure being shown, not on the bytes behind it.
	// Deciding at 1e6 BYTES put the changeover at 8 Mbit/s and printed an
	// ordinary stream as "3439 kbit/s".
	function bitrate(bps) {
		const bits = bps * 8;
		if (bits >= 1e6) return (bits / 1e6).toFixed(1) + ' Mbit/s';
		return Math.round(bits / 1e3) + ' kbit/s';
	}
	// A latency, not a length of footage — which is why this is here and not
	// the verdict file's duration(). A pause is worth reading to the
	// millisecond and never rounds up to a friendly word; footage lost is the
	// opposite, and the two must not be formatted by the same function just
	// because both are made of seconds.
	function pause(n) {
		if (n >= 60) return Math.floor(n / 60) + ' min ' + Math.round(n % 60) + ' s';
		if (n >= 10) return n.toFixed(0) + ' s';
		if (n >= 1) return n.toFixed(2) + ' s';
		return Math.round(n * 1000) + ' ms';
	}
	// Footage, in the words every other page uses for it.
	function lostFootage(sec) {
		const V = window.MajesticStorageVerdict;
		return V ? V.duration(sec) : Math.round(sec) + ' s';
	}
	function num(v, k) { return (v && typeof v[k] === 'number') ? v[k] : null; }

	// What is printed on the card, and what it is worth.
	//
	// The C, U and V classes are all measured the same way — one long
	// uninterrupted sequential write — and a camera that only ever streamed to
	// the card would be well served by them. It does not: it deletes old clips
	// to make room while it is still writing new ones, which is small scattered
	// I/O against the same flash. A1/A2 is the only rating that promises
	// anything about that, and a card without one can pass every sequential
	// test on the box and still stall long enough to lose footage.
	//
	// So the absence of an A rating is the line worth spelling out, and it is
	// the one thing an owner can act on before buying the next card
	// (OpenIPC/firmware#1747).
	function ratingRow(d) {
		const r = d.rating;
		if (!r) {
			// WHY there is no rating decides who is at fault, and getting that
			// backwards is the easy mistake here. The sysfs attribute does not
			// exist on every platform — it is absent on the Ingenic 3.10
			// kernels and present on HiSilicon's 4.9 — so the same card reads
			// as unrated on one camera and A2 on another. Saying "this card
			// does not report its ratings" on the first blames the card for
			// something only the camera is short of.
			//
			// An SD structure asked of an eMMC has no answer worth printing at
			// all, so that row is simply not drawn.
			if (d.ratingWhy === 'notsd') return '';
			const why = d.ratingWhy === 'platform'
				? 'this camera cannot read card speed ratings'
				: 'this card’s speed ratings could not be read';
			return '<dt>Rated</dt><dd class="text-secondary">' + why + '</dd>';
		}
		const badges = [];
		if (r.speedClass) badges.push('Class ' + r.speedClass);
		if (r.uhsGrade) badges.push('U' + r.uhsGrade);
		if (r.videoClass) badges.push('V' + r.videoClass);
		badges.push(r.appClass ? 'A' + r.appClass : 'no A1/A2 rating');
		return '<dt>Rated</dt><dd>' + esc(badges.join(' · ')) +
			(r.appClass ? '' : ' <span class="badge text-bg-warning">sequential only</span>') + '</dd>';
	}

	function ratingNote(d) {
		const r = d.rating;
		if (!r || r.appClass) return '';
		return '<div class="x-small text-secondary mb-3">' +
			'The Class, U and V marks on a card are all measured on one long uninterrupted write. ' +
			'<strong>A1 and A2 are the only ones that promise anything about many small reads and writes at once</strong> — ' +
			'which is what this camera does when it deletes old clips to make room while it is still recording. ' +
			'A card without one can meet every number on its label and still pause long enough to lose footage.' +
			'</div>';
	}

	// What the card is actually doing, which is the half no filesystem check
	// can reach. Every figure is gated on having been read: a counter this
	// majestic does not publish is left out, never drawn as a zero, because a
	// zero here reads as "nothing has gone wrong".
	function liveRows() {
		if (!recorder || recorder.absent || !recorder.v) return '';
		const v = recorder.v;
		// A recorder that has written nothing has measured nothing, and its
		// counters all sit at zero. Drawing them would answer "has this card
		// kept up?" with a row of reassuring noughts on a camera that has never
		// asked the card for anything.
		if (num(v, 'records_fragments_written_total') === 0) return '';
		const rows = [];
		if (rateBps !== null) {
			rows.push('<dt>Writing now</dt><dd>' + (rateBps > 1000
				? esc(bitrate(rateBps))
				: '<span class="text-secondary">nothing is being written</span>') + '</dd>');
		}
		const worst = num(v, 'records_fsync_us_max');
		if (worst !== null) {
			rows.push('<dt>Longest pause</dt><dd>' + esc(pause(worst / 1e6)) + '</dd>');
		}
		// Ticks are microseconds of presentation time — the same derivation the
		// Recordings page makes. The fragment count beside it is not seconds:
		// fragment length is configurable, so counting fragments and calling
		// them seconds is right only at the default.
		const frags = num(v, 'records_fragments_dropped_total');
		const ticks = num(v, 'records_dropped_ticks_total');
		if (frags !== null) {
			rows.push('<dt>Footage dropped</dt><dd>' + (frags > 0
				// text-warning, and deliberately not the -emphasis variant of
				// it: that is a real Bootstrap 5.3 class, but it appears
				// nowhere else in this tree, so the purged stylesheet carries
				// no rule for it and the value would have drawn in the body
				// colour. Naming it even in a comment is enough to pull the
				// rule back in and fail the purgecss job — the extractor reads
				// this file as raw text and cannot tell a comment from markup.
				// (Writing the name here to illustrate that is, of course, how
				// this comment first failed the job itself.)
				? '<span class="text-warning">' + frags + (frags === 1 ? ' fragment' : ' fragments') +
					(ticks !== null ? ' (' + esc(lostFootage(ticks / 1e6)) + ' of video)' : '') + '</span>'
				: 'none') + '</dd>');
		}
		// Both error counters in one row: they are the same fault caught at
		// different depths, and listing them apart invites reading two zeroes
		// as twice the reassurance. records_short_writes_total is deliberately
		// not among them — a write that took more than one call succeeded.
		const errs = ['records_write_errors_total', 'records_sync_errors_total']
			.map(k => num(v, k)).filter(n => n !== null);
		if (errs.length) {
			const total = errs.reduce((a, b) => a + b, 0);
			rows.push('<dt>Write errors</dt><dd>' + (total > 0
				? '<span class="text-danger">' + total + '</span>' : 'none') + '</dd>');
		}
		const q = num(v, 'records_queue_fragments');
		if (q !== null) rows.push('<dt>Waiting to be written</dt><dd>' + q + '</dd>');
		return rows.join('');
	}

	// The measured half, for a camera that is not recording yet — which is
	// exactly the camera whose owner has come here to find out whether the card
	// is the problem. The counters above are silent until recording has worked
	// at least once.
	// The sequential floor the card's own marks promise, in MB/s, or 0 when it
	// claims none. Class N and UHS U1/U3 and V-classes are all minimum
	// sustained sequential write rates, so the highest of them is the number
	// the card is holding itself to.
	function ratedFloor(r) {
		if (!r) return 0;
		const uhs = r.uhsGrade === 3 ? 30 : (r.uhsGrade === 1 ? 10 : 0);
		return Math.max(r.speedClass || 0, uhs, r.videoClass || 0);
	}

	// Measured well under what the card promises — and the card is not
	// necessarily the one at fault.
	//
	// Written after measuring a Class 10 card at 4.7 MB/s on a hi3518ev200,
	// where a RAW read straight off the block device managed the same 4.7 MB/s
	// against a CPU that copies 40 MB/s: the host controller was the ceiling,
	// not the card. Printing "claims 10, delivers 4.7" there invites somebody
	// to replace a perfectly good card and measure exactly the same figure
	// again. The rated floors are quoted for a card reader, not for a camera
	// built around a 440 MHz ARM926.
	//
	// So this says the two numbers disagree and declines to say which is
	// wrong, which is all the page actually knows.
	function shortfallNote(d, mbs) {
		const floor = ratedFloor(d.rating);
		if (!floor || mbs >= floor * 0.8) return '';
		return '<div class="x-small text-secondary mb-2">' +
			'That is below the ' + floor + ' MB/s this card’s markings promise — but the rating is quoted for a ' +
			'card reader, and on some cameras the slot itself is the slower half. A figure under the rating ' +
			'does not on its own mean the card is at fault.</div>';
	}

	function speedBlock(d) {
		let out = '';
		if (speed) {
			const mb = speed.bytes / 1048576;
			const w = speed.bytes / (speed.writeMs / 1000);
			out += '<dl class="small list mb-2">'
				+ '<dt>Sequential write</dt><dd>' + esc((w / 1048576).toFixed(1)) + ' MB/s'
				+ ' <span class="text-secondary">(' + esc(mb.toFixed(0)) + ' MB)</span></dd>';
			if (speed.readMs > 0) {
				out += '<dt>Read back</dt><dd>' + esc((speed.bytes / (speed.readMs / 1000) / 1048576).toFixed(1)) + ' MB/s</dd>';
			}
			out += '<dt>Longest pause</dt><dd>' + esc(pause(speed.worstMs / 1000)) + '</dd></dl>';
			out += shortfallNote(d, w / 1048576);
			// Measured against a card that had a second writer on it. Saying so
			// is the difference between a figure and a misleading figure — a
			// test run beside a live recorder reads slower than the card is,
			// and somebody would otherwise replace a card that was fine.
			if (speed.recording === true) {
				out += '<div class="x-small text-secondary mb-2">The camera was recording to this card while it was measured, ' +
					'so both were writing at once — the card on its own is faster than this.</div>';
			}
		}
		if (speedErr) out += mjNotice('warn', esc(speedErr));
		const dis = (!d.mounted || d.health === 'readonly' || speedBusy) ? ' disabled' : '';
		out += '<button class="btn btn-sm btn-outline-secondary" id="sd-speed"' + dis + '>'
			+ (speedBusy ? '<span class="spinner-border spinner-border-sm"></span> Measuring…' : 'Measure this card')
			+ '</button>';
		return out;
	}

	// Why there are no figures, when there are none — and the three reasons are
	// not one sentence.
	//
	//   null            the heartbeat has not landed, or failed. Nothing is
	//                   established, so nothing is said: an unknown may not be
	//                   turned into a fact, here as anywhere else.
	//   { absent }      majestic answered and publishes no recording counters.
	//                   That is a fact about this build, not about this card,
	//                   and the measurement below still works.
	//   nothing written the counters exist and are empty because the camera has
	//                   never asked this card for anything.
	function liveNote() {
		if (recorder === null) return '';
		if (recorder.absent) {
			return '<div class="x-small text-secondary mb-3">' +
				'This camera does not report what its recorder is doing, so the measurement below is the only ' +
				'thing that can speak for the card here.</div>';
		}
		if (num(recorder.v, 'records_fragments_written_total') !== 0) return '';
		return '<div class="x-small text-secondary mb-3">' +
			'Nothing has been recorded to this card since the camera started, so there is nothing measured to ' +
			'show. The test below writes to the card itself and times it.</div>';
	}

	function perfCard(d) {
		const live = liveRows();
		return '<div class="col-12"><div class="card"><div class="card-body">'
			+ '<h3 class="mb-3">Performance</h3>'
			+ '<dl class="small list mb-2">' + ratingRow(d) + live + '</dl>'
			+ (live ? '<div class="x-small text-secondary mb-3">Pauses, dropped footage and errors are '
				+ 'counted since the camera last started.</div>' : '')
			+ ratingNote(d)
			+ liveNote()
			+ speedBlock(d)
			+ '</div></div></div>';
	}

	function render() {
		const d = state;
		const head = '<div class="d-flex align-items-center gap-3 mb-4"><h2 class="text-primary m-0">SD Card</h2>' + badge(d || {}) + '</div>';
		if (!d || !d.present) {
			SD.innerHTML = head + mjNotice('info', 'No SD card detected. Insert a card and reload.');
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
			+ '</div></div></div>'
			+ perfCard(d)
			+ '</div>';
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
		SD.addEventListener('click', e => {
			const b = e.target.closest('#sd-speed'); if (!b || speedBusy) return;
			// Asked only while the recorder is actually writing here, because
			// then it is a real question: the test and the recorder compete for
			// the same card, and on a card with little headroom left the test
			// is enough to make the recorder drop footage. Measured on a lab
			// camera — a 32 MB run beside a live recorder took the worst flush
			// from 2 s to 13 s and lost five fragments doing it.
			if (rateBps !== null && rateBps > 1000 &&
				!confirm('The camera is recording to this card now. Measuring it makes both write at once, ' +
					'which can drop a few seconds of footage. Measure anyway?')) return;
			speedBusy = true; speedErr = ''; speed = null; render();
			op({ op: 'speedtest' }).then(r => {
				speedBusy = false;
				if (r && r.ok && r.speed) speed = r.speed;
				else speedErr = (r && r.error) || 'The measurement did not complete.';
				render();
			}).catch(() => { speedBusy = false; speedErr = 'The measurement did not complete.'; render(); });
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

	// The recorder's half rides the 2 s heartbeat every page already runs, so
	// this page adds no request for it — the same bargain storage-check.js
	// makes, and the reason j/pulse.cgi was cut back to what /metrics cannot
	// answer.
	//
	// Rendering is left to the 5 s cycle below rather than driven from here:
	// render() rebuilds the whole page, and doing that every two seconds
	// restarts transitions and drops anything being selected mid-read. The one
	// exception is the first reading, which is worth showing without waiting
	// for the next poll.
	function onMetrics(s) {
		if (!s || !s.ok || !s.m) { recorder = null; rateBps = null; return; }
		const v = s.m.v;
		const had = recorder !== null;
		recorder = typeof v.records_state === 'number' ? { v: v } : { absent: true };
		// Two readings and the interval between them. A counter that went
		// backwards is majestic having restarted, not a negative rate.
		const pv = s.prev && s.prev.v;
		const b = v.records_bytes_written_total, pb = pv && pv.records_bytes_written_total;
		rateBps = (typeof b === 'number' && typeof pb === 'number' && s.dt > 0 && b >= pb)
			? (b - pb) / s.dt : null;
		if (!had && state) render();
	}

	wire();
	if (window.mjMetricsSubscribe) window.mjMetricsSubscribe(onMetrics);
	load().then(() => { clearInterval(timer); timer = setInterval(() => { if (!document.hidden) load(); }, 5000); });
})();
