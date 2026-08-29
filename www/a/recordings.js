// Recordings browser: a day of footage as one scrubbable timeline.
//
// The page it replaces was "SD Card -> Browse files", which drops you in a
// whole-device file manager holding a folder of 400 MB clips named 12-04.mp4.
// Everything here exists to answer the question people actually arrive with —
// what happened around half past twelve — rather than which file to open.
//
// Three modules, split by what can be silently wrong:
//   timeline.js   places clips on the day and works out coverage and gaps
//   mp4index.js   recovers byte<->time from clips that carry no seek index
//   this file     the DOM, the player and the export
//
// Nothing here streams media through a CGI. Clips are fetched from their own
// filesystem path, where majestic answers with sendfile and honours Range for
// the browser's authenticated session; j/download.cgi would cat a whole
// recording into the connection buffer and take the camera's RAM with it.
(function () {
	'use strict';

	const IDX = window.MajesticMp4Index;
	const TL = window.MajesticTimeline;
	const DAY = TL.DAY;

	// How much of the day the detail band shows, and the steps the zoom takes.
	const ZOOMS = [15 * 60, 30 * 60, 3600, 3 * 3600, 6 * 3600, DAY];
	let zoom = 2;                     // index into ZOOMS -> one hour

	const state = {
		cfg: {}, prefix: '', split: 1200, enabled: false,
		offsetMs: 0, nowSec: null, today: '',
		days: [], dayName: '', day: { clips: [], unplaced: [] },
		view: { from: 0, to: 3600, width: 3600 },
		playhead: 0, sel: null,
		clip: null, mime: null, init: null, hint: null,
	};


	const $id = function (s) { return document.getElementById(s); };
	function esc(s) {
		return String(s).replace(/[&<>"]/g, function (c) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
		});
	}
	// Same reasoning as files.js: majestic serves the absolute path, so the
	// URL is the path with each component encoded.
	function fileUrl(p) { return p.split('/').map(encodeURIComponent).join('/'); }
	function clipPath(name) {
		const d = state.dayName === '.' ? state.prefix : state.prefix + '/' + state.dayName;
		return (d + '/' + name).replace(/\/{2,}/g, '/');
	}

	function note(html, kind) {
		const n = $id('rec-note');
		if (!n) return;
		n.className = html ? 'alert alert-' + (kind || 'secondary') : 'd-none';
		n.innerHTML = html || '';
	}

	// ---- loading ---------------------------------------------------------

	function loadPulse() {
		return apiFetch('/cgi-bin/j/pulse.cgi', { credentials: 'same-origin' })
			.then(function (r) { return r.json(); })
			.then(function (j) {
				const off = parseTzOffsetMs(j.utc_offset);   // main.js; null if unusable
				state.offsetMs = off === null ? 0 : off;
				const nowMs = (+j.time_now || 0) * 1000 + state.offsetMs;
				const d = new Date(nowMs);
				// Read the shifted instant as if it were UTC — the camera's wall
				// clock, which is what records.path %F and %H-%M are stamped in.
				state.today = d.toISOString().slice(0, 10);
				state.nowSec = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
			})
			.catch(function () { /* the page still works without a clock */ });
	}

	function loadConfig() {
		return apiFetch('/api/v1/config.json', { credentials: 'same-origin' })
			.then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; })
			.then(function (c) {
				state.cfg = c;
				state.enabled = mjGet(c, 'records.enabled') === true;
				state.prefix = (mjGet(c, 'records.path') || '').split('%')[0].replace(/\/+$/, '');
				const sp = +mjGet(c, 'records.split');
				state.split = sp > 0 ? sp * 60 : 1200;
			});
	}

	function api(qs) {
		return apiFetch('/cgi-bin/j/recordings.cgi?' + qs, { credentials: 'same-origin' })
			.then(function (r) { return r.json(); });
	}

	function loadDays() {
		if (!state.prefix) return Promise.resolve();
		return api('days=1&prefix=' + encodeURIComponent(state.prefix))
			.then(function (j) { state.days = (j && j.days) || []; })
			.catch(function () { state.days = []; });
	}

	function loadDay(name) {
		state.dayName = name;
		return api('day=' + encodeURIComponent(name) + '&prefix=' + encodeURIComponent(state.prefix))
			.then(function (j) {
				const isToday = (name === state.today) ||
					(name === '.' && state.nowSec !== null);
				state.day = TL.buildDay((j && j.clips) || [], {
					splitSec: state.split,
					nowSec: isToday ? state.nowSec : null,
				});
			})
			.catch(function () { state.day = { clips: [], unplaced: [] }; });
	}

	// ---- the player ------------------------------------------------------
	//
	// A plain <video> element pointed at the clip's own URL, seeking on its own
	// over the Range requests majestic serves.
	//
	// An MSE path aimed by the fragment index would seek by byte offset rather
	// than by asking the browser to find the moment, and it is a reasonable
	// next step — but only reasonable, not necessary. A recording carries a
	// tfdt in every fragment, so the element has the decode times it needs to
	// seek without walking the file, and a plain element is a great deal less
	// machinery to get wrong.
	//
	// What is worth remembering is why this is not MSE already: a SourceBuffer
	// refuses a media segment that has no tfdt, outright and with an empty
	// buffer. Recordings written before that box was added cannot be appended
	// at all, however they are fed in — no mode, timestampOffset or codec
	// string changes it — while the same files play in a plain element.

	// ---- opening a clip --------------------------------------------------

	function openClip(clip, atSec) {
		const video = $id('rec-video');
		if (!video || !clip) return;
		state.clip = clip;
		state.init = null;
		state.hint = null;
		const url = fileUrl(clipPath(clip.name));

		setStatus('Reading clip header…');

		const read = IDX.reader(url);
		// 64 KiB is generous for ftyp + moov, so the codec probe and the init
		// parse share one request.
		read(0, 65535).then(function (head) {
			if (state.clip !== clip) return;          // switched away mid-flight
			const init = IDX.parseInit(head);
			if (!init) throw new Error('not a fragmented MP4');
			state.init = init;

			const codec = codecFromHeader(head);
			const mime = 'video/mp4; codecs="' + (codec || 'avc1.42E01E') + '"';

			// An unplayable codec does not raise `error` on a <video>: H.265
			// parses, reports a duration and then sits at videoWidth 0 forever.
			// So ask before committing anything to the screen.
			if (codec && !video.canPlayType(mime)) {
				const family = /^(hvc1|hev1)/.test(codec) ? 'H.265 (HEVC)' : codec.split('.')[0];
				setStatus('');
				note('<strong>' + family + ' — this browser cannot decode it.</strong> ' +
					'Save the clip and play it in VLC, or record the main stream as H.264. ' +
					'<a href="mj-settings.cgi?tab=video0">Stream settings</a>', 'warning');
				return;
			}
			note('');
			state.mime = mime;
			setStatus('');

			video.src = url;
			positionAt(atSec || 0);
			video.play().catch(function () { /* autoplay policy; controls remain */ });

			// Two reads to turn the clip list's estimate into a real length.
			hintDuration(url, clip, init);
		}).catch(function (e) {
			setStatus('');
			note('Could not open <code>' + esc(clip.name) + '</code> — ' + esc(e.message || 'unreadable') +
				'. <a href="' + esc(url) + '" download>Save the clip</a> and play it locally.', 'danger');
		});
	}

	// Move to a moment inside the clip that is already open. The element does
	// its own seeking over Range; the clips carry no index, so how quickly it
	// gets there is the browser's business and not something the page can aim.
	function positionAt(sec) {
		const video = $id('rec-video');
		if (!video) return;
		try { video.currentTime = Math.max(0, sec); } catch (e) { /* not ready yet */ }
	}

	// ---- storage ---------------------------------------------------------

	// Same numbers and the same bar as the SD card page, because it is the same
	// question asked from the other side: how much footage is there, and how
	// much room is left before the oldest of it is deleted.
	function loadStorage() {
		if (!state.prefix) return;
		apiFetch('/cgi-bin/j/sdcard.cgi?rec=' + encodeURIComponent(state.prefix),
			{ credentials: 'same-origin' })
			.then(function (r) { return r.json(); })
			.then(function (d) {
				if (!d || !d.mounted || !d.totalKb) return;
				const card = $id('rec-storage-card'), el = $id('rec-storage');
				if (!card || !el) return;
				const total = d.totalKb * 1024, used = d.usedKb * 1024;
				const rec = Math.min(d.recBytes || 0, used);
				const other = Math.max(0, used - rec), free = Math.max(0, total - used);
				const seg = function (b, c) {
					return b > 0 ? '<div class="seg" style="width:' + (b / total * 100).toFixed(2) +
						'%;background:' + c + '"></div>' : '';
				};
				const dot = function (c) {
					return '<span class="dot" style="background:' + c + '"></span>';
				};
				// How much longer the card can record, from what this day's
				// footage actually costs per second.
				const day = state.day.clips.reduce(function (a, c) { return a + c.dur; }, 0);
				const bytes = state.day.clips.reduce(function (a, c) { return a + c.size; }, 0);
				const left = (day > 0 && bytes > 0)
					? ' · about ' + TL.duration(free / (bytes / day)) + ' of footage left' : '';

				card.hidden = false;
				el.innerHTML =
					'<div class="d-flex justify-content-between x-small mb-1">' +
					'<span class="fw-semibold">Storage</span>' +
					'<span class="text-secondary">' + TL.bytes(used) + ' of ' + TL.bytes(total) + ' used' +
					esc(left) + '</span></div>' +
					'<div class="storage-bar mb-2">' + seg(rec, '#4c60d8') + seg(other, '#e08a3c') + '</div>' +
					'<div class="storage-legend x-small">' +
					'<span>' + dot('#4c60d8') + 'Recordings <span class="text-secondary">' + TL.bytes(rec) + '</span></span>' +
					'<span>' + dot('#e08a3c') + 'Other <span class="text-secondary">' + TL.bytes(other) + '</span></span>' +
					'<span><span class="dot dot-free"></span>Free <span class="text-secondary">' + TL.bytes(free) + '</span></span>' +
					(mjGet(state.cfg, 'records.maxUsage')
						? '<span class="text-secondary">oldest clips deleted at ' +
						esc(String(mjGet(state.cfg, 'records.maxUsage'))) + ' %</span>' : '') +
					'</div>';
			}).catch(function () { /* the page is useful without it */ });
	}

	// Where a day should open: the freshest footage in it, not the oldest.
	// Landing on 06:00 when the camera has been running all day means watching
	// the wrong end of the archive.
	function freshest() {
		const list = state.day.clips;
		if (!list.length) return 0;
		const last = list[list.length - 1];
		return Math.max(last.start, last.end - 60);
	}

	// Turn the clip list's estimate into a measured length, in two reads.
	function hintDuration(url, clip, init) {
		IDX.durationHint(IDX.reader(url), clip.size, init).then(function (h) {
			if (!h || state.clip !== clip) return;
			state.hint = h;
			if (TL.applyExactDuration(state.day, clip.name, h.seconds)) {
				renderClips();
				renderTimeline();
			}
		});
	}

	function setStatus(t) {
		const s = $id('rec-status');
		if (s) s.textContent = t || '';
	}

	// ---- codec probe (shared shape with files.js) ------------------------

	function fourcc(u8, i) { return String.fromCharCode(u8[i], u8[i + 1], u8[i + 2], u8[i + 3]); }
	function codecFromHeader(u8) {
		const moov = IDX.findBox(u8, 0, u8.length, 'moov');
		if (!moov) return null;
		const hex = function (n) { return n.toString(16).padStart(2, '0'); };
		for (let i = moov[0] + 8; i < moov[1] - 4; i++) {
			const t = fourcc(u8, i);
			if (t === 'hvc1' || t === 'hev1') return t + '.1.6.L93.B0';
			if (t === 'av01') return 'av01.0.05M.08';
			if (t === 'avc1' || t === 'avc3') {
				// the avcC that follows carries profile/compat/level verbatim
				for (let j = i; j < moov[1] - 8; j++) {
					if (fourcc(u8, j) === 'avcC') return t + '.' + hex(u8[j + 5]) + hex(u8[j + 6]) + hex(u8[j + 7]);
				}
				return t + '.42E01E';
			}
		}
		return null;
	}

	// ---- rendering -------------------------------------------------------

	function pct(sec, view) { return ((sec - view.from) / view.width * 100); }

	function renderTimeline() {
		const strip = $id('rec-strip'), band = $id('rec-band');
		if (!strip || !band) return;
		const cov = TL.coverage(state.day);
		const view = state.view;

		// whole day
		let h = '';
		cov.forEach(function (c) {
			h += '<div class="seg" style="left:' + (c.from / DAY * 100).toFixed(3) + '%;width:' +
				((c.to - c.from) / DAY * 100).toFixed(3) + '%"></div>';
		});
		h += '<div class="rec-win" style="left:' + (view.from / DAY * 100).toFixed(3) + '%;width:' +
			(view.width / DAY * 100).toFixed(3) + '%"></div>';
		strip.innerHTML = h;

		// detail band
		let b = '';
		cov.forEach(function (c) {
			if (c.to <= view.from || c.from >= view.to) return;
			const a = Math.max(c.from, view.from), z = Math.min(c.to, view.to);
			b += '<div class="seg" style="left:' + pct(a, view).toFixed(3) + '%;width:' +
				((z - a) / view.width * 100).toFixed(3) + '%"></div>';
		});
		// clip boundaries, so it is clear where one file ends and the next starts
		state.day.clips.forEach(function (c) {
			if (c.start <= view.from || c.start >= view.to) return;
			b += '<div class="rec-edge" style="left:' + pct(c.start, view).toFixed(3) + '%"></div>';
		});
		if (state.sel) {
			const a = Math.max(state.sel.from, view.from), z = Math.min(state.sel.to, view.to);
			if (z > a) {
				b += '<div class="rec-sel" style="left:' + pct(a, view).toFixed(3) + '%;width:' +
					((z - a) / view.width * 100).toFixed(3) + '%"></div>';
			}
		}
		if (state.playhead >= view.from && state.playhead <= view.to) {
			b += '<div class="rec-head" style="left:' + pct(state.playhead, view).toFixed(3) + '%">' +
				'<span class="rec-head-t">' + TL.hhmm(state.playhead) + '</span></div>';
		}
		band.innerHTML = b;

		renderTicks();
		renderSelection();
		const lbl = $id('rec-view-label');
		if (lbl) lbl.textContent = TL.hhmm(view.from) + ' – ' + TL.hhmm(view.to);
	}

	function renderTicks() {
		const el = $id('rec-ticks');
		if (!el) return;
		const view = state.view, out = [];
		for (let i = 0; i <= 4; i++) out.push(TL.hhmm(view.from + view.width * i / 4));
		el.innerHTML = out.map(function (t) { return '<span>' + t + '</span>'; }).join('');
	}

	// The part of a selection that can actually be saved. An export is whole
	// fragments out of ONE clip, so a drag running past the open clip saves
	// less than it covers — report the trimmed range, or the bar promises
	// footage the file does not contain.
	function selectionSpan() {
		if (!state.sel || !state.clip) return null;
		const clip = state.clip;
		const a = Math.max(state.sel.from, clip.start);
		const b = Math.min(state.sel.to, clip.end);
		if (b - a < 0.5) return null;                 // no overlap with this clip
		return {
			from: a, to: b, seconds: b - a,
			// Size is estimated from the clip's own average bitrate. Knowing it
			// exactly would mean indexing the span first, which is the work the
			// Save button is for — a number is more use here than a spinner.
			bytes: clip.dur > 0 ? Math.round(clip.size / clip.dur * (b - a)) : 0,
			clipped: state.sel.from < clip.start - 0.5 || state.sel.to > clip.end + 0.5,
		};
	}

	function renderSelection() {
		const bar = $id('rec-export');
		if (!bar) return;
		if (!state.sel || state.sel.to - state.sel.from < 1) { bar.className = 'd-none'; return; }
		const s = selectionSpan();
		bar.className = 'rec-export';
		if (!s) {
			bar.innerHTML = '<div class="x-small text-secondary">' +
				'Selection is outside the clip being played — pick a moment inside it first.</div>';
			return;
		}
		bar.innerHTML =
			'<div><div class="font-monospace fw-semibold">' + TL.clock(s.from) + ' – ' + TL.clock(s.to) + '</div>' +
			'<div class="x-small text-secondary" id="rec-sel-note">' + TL.duration(s.seconds) +
			' · about ' + TL.bytes(s.bytes) + ' · saved without re-encoding' +
			(s.clipped ? ' · trimmed to this clip' : '') + '</div></div>' +
			'<div class="mj-push-end d-flex gap-2">' +
			'<button class="btn btn-sm btn-outline-secondary" id="rec-sel-clear" type="button">Clear</button>' +
			'<button class="btn btn-sm btn-primary" id="rec-sel-save" type="button">Save clip</button></div>';
		$id('rec-sel-clear').addEventListener('click', function () { state.sel = null; renderTimeline(); });
		$id('rec-sel-save').addEventListener('click', saveSelection);
	}

	function renderClips() {
		const el = $id('rec-clips');
		if (!el) return;
		const list = state.day.clips;
		if (!list.length) {
			el.innerHTML = '<div class="text-secondary small">No clips in this day.</div>';
			return;
		}
		let h = '';
		// newest first: that is the one people want
		list.slice().reverse().forEach(function (c, i, arr) {
			const prev = arr[i + 1];
			if (prev && c.start - prev.end > TL.JOIN_TOLERANCE) {
				h += '<div class="rec-gap"><span>not recording · ' +
					TL.hhmm(prev.end) + ' – ' + TL.hhmm(c.start) + '</span></div>';
			}
			const on = state.clip && state.clip.name === c.name;
			h += '<button type="button" class="rec-clip' + (on ? ' active' : '') + '" data-clip="' + esc(c.name) + '">' +
				'<span class="rec-poster"' + (c.recording ? ' data-live="1"' : '') + '>' +
				'<span class="rec-poster-t">' + TL.hhmm(c.start) + '</span></span>' +
				'<span class="rec-clip-m"><span class="font-monospace fw-semibold">' + TL.hhmm(c.start) + '</span>' +
				'<span class="x-small text-secondary">' +
				(c.recording ? 'recording' : (c.estimated ? '≈ ' : '') + TL.duration(c.dur)) +
				' · ' + TL.bytes(c.size) + '</span></span></button>';
		});
		if (state.day.unplaced.length) {
			h += '<div class="rec-gap"><span>' + state.day.unplaced.length +
				' clip(s) whose name has no time</span></div>';
			state.day.unplaced.forEach(function (c) {
				h += '<button type="button" class="rec-clip" data-clip="' + esc(c.name) + '">' +
					'<span class="rec-poster"><span class="rec-poster-t">?</span></span>' +
					'<span class="rec-clip-m"><span class="font-monospace fw-semibold">' + esc(c.name) + '</span>' +
					'<span class="x-small text-secondary">' + TL.bytes(c.size) + '</span></span></button>';
			});
		}
		el.innerHTML = h;
	}

	function renderDayNav() {
		const el = $id('rec-daynav');
		if (!el) return;
		const i = state.days.map(function (d) { return d.name; }).indexOf(state.dayName);
		const prev = i > 0 ? state.days[i - 1].name : '';
		const next = i >= 0 && i < state.days.length - 1 ? state.days[i + 1].name : '';
		const label = state.dayName === '.' ? 'All recordings' : state.dayName;
		const total = state.day.clips.reduce(function (a, c) { return a + c.dur; }, 0);

		el.innerHTML =
			'<button class="btn btn-sm btn-outline-secondary" id="rec-prev" type="button"' +
			(prev ? '' : ' disabled') + ' aria-label="Previous day">&lsaquo;</button>' +
			'<select class="form-select form-select-sm rec-daypick" id="rec-daysel">' +
			state.days.map(function (d) {
				return '<option value="' + esc(d.name) + '"' + (d.name === state.dayName ? ' selected' : '') + '>' +
					esc(d.name === '.' ? 'All recordings' : d.name) + ' — ' + d.clips + ' clip' + (d.clips === 1 ? '' : 's') +
					'</option>';
			}).join('') + '</select>' +
			'<button class="btn btn-sm btn-outline-secondary" id="rec-next" type="button"' +
			(next ? '' : ' disabled') + ' aria-label="Next day">&rsaquo;</button>' +
			'<span class="small text-secondary">' + state.day.clips.length + ' clips · ' + TL.duration(total) + '</span>' +
			(state.enabled
				? '<span class="mj-push-end badge text-bg-success">Recording</span>'
				: '<span class="mj-push-end badge text-bg-secondary">Recording off</span>') +
			'<span class="small text-secondary">' + esc(label) + '</span>';

		if (prev) $id('rec-prev').addEventListener('click', function () { goDay(prev); });
		if (next) $id('rec-next').addEventListener('click', function () { goDay(next); });
		$id('rec-daysel').addEventListener('change', function (e) { goDay(e.target.value); });
	}

	// ---- export ----------------------------------------------------------

	// A clip is the init segment followed by whole fragments, so an export is a
	// byte concatenation — no transcoding, and the camera only ever sendfiles
	// the ranges it is asked for.
	// Assemble the selection as a real file, without re-encoding it.
	//
	// Fragments are self-contained, so the clip is the init segment followed by
	// whole fragments — a byte concatenation. Only the selected span is indexed
	// (spanFrom), so a one-minute cut costs about sixty small reads instead of
	// the eleven hundred a whole-clip index would.
	function saveSelection() {
		const btn = $id('rec-sel-save'), noteEl = $id('rec-sel-note');
		const clip = state.clip, init = state.init;
		const s = selectionSpan();
		if (!s || !btn || !init) return;

		btn.disabled = true;
		btn.textContent = 'Saving…';
		const read = IDX.reader(fileUrl(clipPath(clip.name)));
		const per = state.hint ? state.hint.perFragment : 1;

		IDX.locate(read, clip.size, init, s.from - clip.start, per).then(function (hit) {
			return IDX.spanFrom(read, clip.size, init, hit.off, s.seconds, function (got, want) {
				if (noteEl) noteEl.textContent = 'Collecting ' + TL.duration(got) + ' of ' + TL.duration(want) + '…';
			});
		}).then(function (span) {
			if (!span.fragments.length) throw new Error('no fragments in range');
			const r = IDX.exportRanges(span, 0, span.duration);
			if (noteEl) noteEl.textContent = 'Fetching ' + TL.bytes(r.bytes) + '…';
			return Promise.all([
				read(r.header.start, r.header.end - 1),
				read(r.body.start, r.body.end - 1),
			]).then(function (parts) { return { parts: parts, span: span, r: r }; });
		}).then(function (o) {
			const blob = new Blob(o.parts, { type: 'video/mp4' });
			const a = document.createElement('a');
			a.href = URL.createObjectURL(blob);
			a.download = (state.dayName === '.' ? '' : state.dayName + '_') +
				TL.hhmm(s.from).replace(':', '-') + '_' +
				TL.hhmm(s.from + o.span.duration).replace(':', '-') + '.mp4';
			document.body.appendChild(a);
			a.click();
			a.remove();
			setTimeout(function () { URL.revokeObjectURL(a.href); }, 30000);
			btn.disabled = false;
			btn.textContent = 'Save clip';
			if (noteEl) {
				noteEl.textContent = 'Saved ' + TL.duration(o.span.duration) + ' · ' +
					TL.bytes(blob.size) + ' · ' + o.span.fragments.length + ' fragments, not re-encoded';
			}
		}).catch(function () {
			btn.disabled = false;
			btn.textContent = 'Save clip';
			note('Could not assemble the clip — the card may be busy. Try a shorter range.', 'danger');
		});
	}

	// ---- interaction -----------------------------------------------------

	function secAtEvent(el, e) {
		const r = el.getBoundingClientRect();
		const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
		return Math.max(0, Math.min(1, x / r.width));
	}

	function goTo(sec) {
		state.playhead = Math.max(0, Math.min(sec, DAY));
		let hit = TL.at(state.day, state.playhead);
		if (!hit) {
			// Scrubbing over a hole: skip to the next footage rather than
			// snapping to a neighbour, which would jump in time without saying
			// so. One hop only — nextCovered lands on a covered instant, so a
			// second miss means there is nothing to play and we just move the
			// playhead.
			const nxt = TL.nextCovered(state.day, state.playhead);
			if (nxt === null) { renderTimeline(); return; }
			state.playhead = nxt;
			hit = TL.at(state.day, nxt);
			if (!hit) { renderTimeline(); return; }
		}
		if (!state.clip || state.clip.name !== hit.clip.name) {
			openClip(hit.clip, hit.offset);
			renderClips();
		} else {
			positionAt(hit.offset);
		}
		renderTimeline();
	}

	function centreView(sec) {
		state.view = TL.window(sec, ZOOMS[zoom]);
		renderTimeline();
	}

	function wire() {
		const strip = $id('rec-strip'), band = $id('rec-band');

		// day strip: click or drag the window
		let stripDrag = false;
		const stripMove = function (e) {
			centreView(secAtEvent(strip, e) * DAY);
			e.preventDefault();
		};
		strip.addEventListener('mousedown', function (e) { stripDrag = true; stripMove(e); });
		strip.addEventListener('touchstart', function (e) { stripDrag = true; stripMove(e); }, { passive: false });
		document.addEventListener('mousemove', function (e) { if (stripDrag) stripMove(e); });
		document.addEventListener('touchmove', function (e) { if (stripDrag) stripMove(e); }, { passive: false });
		document.addEventListener('mouseup', function () { stripDrag = false; });
		document.addEventListener('touchend', function () { stripDrag = false; });

		// detail band: drag scrubs, shift-drag selects a range to export
		let mode = null, anchorSec = 0;
		const bandSec = function (e) { return state.view.from + secAtEvent(band, e) * state.view.width; };
		const bandDown = function (e) {
			const s = bandSec(e);
			if (e.shiftKey || e.altKey) { mode = 'sel'; anchorSec = s; state.sel = { from: s, to: s }; renderTimeline(); }
			else { mode = 'scrub'; goTo(s); }
			e.preventDefault();
		};
		const bandMove = function (e) {
			if (!mode) return;
			const s = bandSec(e);
			if (mode === 'sel') {
				state.sel = { from: Math.min(anchorSec, s), to: Math.max(anchorSec, s) };
				renderTimeline();
			} else { goTo(s); }
			e.preventDefault();
		};
		band.addEventListener('mousedown', bandDown);
		band.addEventListener('touchstart', bandDown, { passive: false });
		document.addEventListener('mousemove', bandMove);
		document.addEventListener('touchmove', bandMove, { passive: false });
		document.addEventListener('mouseup', function () { mode = null; });
		document.addEventListener('touchend', function () { mode = null; });

		// wheel zooms the detail band around the pointer
		band.addEventListener('wheel', function (e) {
			const at = bandSec(e);
			const was = zoom;
			zoom = Math.max(0, Math.min(ZOOMS.length - 1, zoom + (e.deltaY > 0 ? 1 : -1)));
			if (zoom !== was) { centreView(at); e.preventDefault(); }
		}, { passive: false });

		$id('rec-clips').addEventListener('click', function (e) {
			const b = e.target.closest('[data-clip]');
			if (!b) return;
			const name = b.dataset.clip;
			const c = state.day.clips.filter(function (x) { return x.name === name; })[0] ||
				state.day.unplaced.filter(function (x) { return x.name === name; })[0];
			if (!c) return;
			if (c.start !== null && c.start !== undefined) {
				state.playhead = c.start;
				centreView(c.start);
			}
			openClip(c, 0);
			renderClips();
		});

		const v = $id('rec-video');
		v.addEventListener('timeupdate', function () {
			if (!state.clip || state.clip.start === null) return;
			const t = state.clip.start + v.currentTime;
			// Only repaint when the playhead has actually moved a pixel's worth.
			if (Math.abs(t - state.playhead) < state.view.width / 800) return;
			state.playhead = t;
			renderTimeline();
		});
		v.addEventListener('error', function () {
			if (!state.clip) return;
			note('Playback stopped on <code>' + esc(state.clip.name) + '</code>. ' +
				'<a href="' + esc(fileUrl(clipPath(state.clip.name))) + '" download>Save the clip</a> instead.', 'danger');
		});

		const dl = $id('rec-dl');
		if (dl) dl.addEventListener('click', function () {
			if (!state.clip) return;
			const a = document.createElement('a');
			a.href = fileUrl(clipPath(state.clip.name));
			a.download = state.clip.name;
			document.body.appendChild(a); a.click(); a.remove();
		});
	}

	function goDay(name) {
		if (!name || name === state.dayName) return;
		state.clip = null; state.init = null; state.hint = null; state.sel = null;
		const v = $id('rec-video');
		if (v) { try { v.removeAttribute('src'); v.load(); } catch (e) {} }
		history.replaceState(null, '', location.pathname + '?day=' + encodeURIComponent(name));
		loadDay(name).then(function () {
			renderDayNav(); renderClips();
			note('');
			centreView(freshest());
			goTo(freshest());
		});
	}

	// ---- boot ------------------------------------------------------------

	function empty(msg, cta) {
		$id('rec-main').className = 'd-none';
		note(msg + (cta || ''), 'secondary');
	}

	Promise.all([loadConfig(), loadPulse()]).then(function () {
		if (!state.prefix) {
			return empty('<strong>Recording is not configured.</strong> No recording path is set, so there is nothing to browse. ',
				'<a href="tool-sdcard.cgi">Set up the SD card</a>.');
		}
		return loadDays().then(function () {
			if (!state.days.length) {
				return empty(state.enabled
					? '<strong>Nothing recorded yet.</strong> Recording is on, but no clips have been written to <code>' + esc(state.prefix) + '</code> yet. '
					: '<strong>Recording is off.</strong> The camera is not writing to the card, so there is nothing to browse. ',
					'<a href="tool-sdcard.cgi">SD card</a>');
			}
			const want = (/[?&]day=([^&]*)/.exec(location.search) || [])[1];
			const asked = want ? decodeURIComponent(want) : '';
			const names = state.days.map(function (d) { return d.name; });
			const pick = names.indexOf(asked) >= 0 ? asked : names[names.length - 1];

			return loadDay(pick).then(function () {
				wire();
				renderDayNav();
				renderClips();
				loadStorage();
				centreView(freshest());
				goTo(freshest());     // opens the clip, so the page is not a black box
			});
		});
	});
})();
