// The Counting page: how many people crossed each line, how many are in each
// zone and for how long, today and over the last week or month.
//
// Everything comes from majestic -- GET /api/v1/counting for what is
// happening now and GET /api/v1/counting/history for the hours and days
// before -- and nothing is kept here. What the numbers mean, and the rule that
// an hour the camera did not count is drawn as "not counted" rather than as
// zero, is in counting-data.js.
(function () {
	'use strict';

	const D = window.MjCountingData;
	const SVG_NS = 'http://www.w3.org/2000/svg';
	const POLL_MS = 5000;
	const css = getComputedStyle(document.documentElement);
	const ink = (name, dflt) => (css.getPropertyValue(name) || dflt).trim();

	let range = 'today';
	let live = null; // the last answer from /api/v1/counting, or null
	// Whether the camera follows people: true, false, or null for not known.
	// Following keeps a person still in the picture, and lines and zones are
	// places in it, so the counts stay at zero with nothing else to say why.
	let follows = null;
	let hist = null;
	let timer = null;

	function el(tag, cls, text) {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text != null) e.textContent = text;
		return e;
	}

	// Through the tree's apiFetch: it says who is asking, so an expired
	// session is a trip to the login page rather than Safari's credentials
	// dialog, or a 401 read here as a camera that stopped answering.
	async function getJSON(url) {
		try {
			const r = await apiFetch(url, { cache: 'no-store' });
			if (!r.ok) return null;
			return await r.json();
		} catch (e) {
			return null;
		}
	}

	async function getText(url) {
		try {
			const r = await apiFetch(url, { cache: 'no-store' });
			return r.ok ? await r.text() : null;
		} catch (e) {
			return null;
		}
	}

	// What the camera says, as words, or a dash where it said nothing:
	// "undefined people" is not a reading.
	const word = (v, fallback) => (typeof v === 'string' && v ? v : fallback);
	const num = (v) => (typeof v === 'number' && isFinite(v) ? String(v) : '–');

	function period(now) {
		const today = D.dayStart(now);
		if (range === 'today') return { from: today, to: now, step: 'hour' };
		const days = range === 'week' ? 7 : 30;
		return { from: D.daysBack(now, days - 1), to: now, step: 'day' };
	}

	// ── what there is to show ────────────────────────────────────────────

	function note(kind, html) {
		const box = $('#ct-note');
		box.innerHTML = html
			? '<div class="mj-notice mj-notice-' + kind + '" role="status"><div class="mj-notice-txt">' +
			  html + '</div></div>'
			: '';
	}

	function paintState() {
		const s = D.state(live);
		$('#ct-main').hidden = s !== 'on';
		if (s === 'unknown')
			note('warn', 'The camera is not answering — retrying…');
		else if (s === 'off')
			note('info', 'Counting is off. <a href="camera.cgi?tab=counting">Turn it on and draw a line or a zone</a> to start counting.');
		else if (s === 'empty')
			note('info', 'Counting is on, but there is nothing to count yet. <a href="camera.cgi?tab=counting">Draw a line or a zone</a>.');
		else if (follows === true)
			note('warn', 'The camera follows people, so it keeps them in the same place in the picture and they never cross a line. <a href="camera.cgi?tab=ptz">Turn Follow off</a> to count.');
		else note('', '');
		return s;
	}

	// ── tiles ────────────────────────────────────────────────────────────

	function tile(cap, val, unit, sub) {
		const t = el('div', 'st-panel st-tile');
		t.appendChild(el('div', 'mj-cap', cap));
		const v = el('div', 'st-val', val);
		if (unit) v.appendChild(el('span', 'st-unit', ' ' + unit));
		t.appendChild(v);
		if (sub) t.appendChild(el('div', 'x-small text-secondary', sub));
		return t;
	}

	function paintTiles(list) {
		const box = $('#ct-kpis');
		box.textContent = '';
		const lines = live.lines || [], zones = live.zones || [];
		const tot = D.totals(list, lines.length, zones.length);
		const step = hist && hist.step === 'day' ? 'day' : 'hour';
		const when = range === 'today' ? 'today' : range === 'week' ? 'last 7 days' : 'last 30 days';
		// A partly counted period says how much of it was, once, beside the
		// period it is about: "0 today" for a day counted for ten minutes is a
		// wrong answer told as a number.
		const cover = D.coverage(list, step, Math.floor(Date.now() / 1000));
		const cv = $('#ct-cover');
		cv.textContent = cover ? (when.charAt(0).toUpperCase() + when.slice(1)) + ': ' + cover + '.' : '';
		cv.hidden = !cover;
		// Nothing counted in the period is "no data", never 0.
		const n = (v) => (tot.known ? String(v) : '–');
		lines.forEach((l, i) => {
			const name = word(l && l.name, 'line ' + (i + 1));
			box.appendChild(tile(name + ' · in', n(tot.lines[i].in), '', when));
			box.appendChild(tile(name + ' · out', n(tot.lines[i].out), '', when));
		});
		zones.forEach((z, i) => {
			const name = word(z && z.name, 'zone ' + (i + 1));
			const occ = z && z.occupancy;
			box.appendChild(tile(name + ' · now', num(occ), occ === 1 ? 'person' : 'people',
				'at most ' + n(tot.zones[i].peak) + ' at once ' + when));
			const med = tot.known ? D.medianBin(tot.zones[i].dwell, hist && hist.dwellEdges) : null;
			box.appendChild(tile(name + ' · typical stay', med || '–', '',
				tot.known ? tot.zones[i].entered + ' visits ' + when : 'not counted ' + when));
		});
	}

	// ── charts ───────────────────────────────────────────────────────────

	function label(t, step) {
		const d = new Date(t * 1000);
		return step === 'hour'
			? String(d.getHours()).padStart(2, '0')
			: d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
	}

	function slotTitle(s, step) {
		const d = new Date(s.t * 1000);
		const when = step === 'hour'
			? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
			: d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
		if (s.state === 'none') return when + ' — not counted';
		if (s.state === 'part') return when + ' — counted for ' + Math.round(s.covered / 60) + ' min of it';
		return when;
	}

	// Grouped bars, one group per slot: `values(slot)` gives each series' value
	// for a counted slot. A slot not counted is a hatched band with no bars; a
	// slot counted for part of its length draws its bars faint.
	function bars(host, list, step, series, values, fmt) {
		host.textContent = '';
		const W = Math.max(280, host.clientWidth || 600), H = 150, PAD_L = 30, PAD_B = 18, PAD_T = 8;
		const plotW = W - PAD_L - 4, plotH = H - PAD_B - PAD_T;
		let hi = 0;
		for (const s of list) if (s.state !== 'none') for (const v of values(s)) hi = Math.max(hi, v);
		const top = hi <= 4 ? 4 : Math.ceil(hi * 1.1);
		const svg = document.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('width', W);
		svg.setAttribute('height', H);
		svg.setAttribute('role', 'img');
		const grid = ink('--st-grid', '#e9ebf2');
		// Diagonal hatching for a slot not counted: a flat tint the colour of
		// the card is invisible on the dark theme, and an invisible gap is a
		// slot of zero people.
		const hatch = 'ct-hatch-' + Math.random().toString(36).slice(2, 8);
		const defs = document.createElementNS(SVG_NS, 'defs');
		const pat = document.createElementNS(SVG_NS, 'pattern');
		pat.setAttribute('id', hatch);
		pat.setAttribute('width', '6');
		pat.setAttribute('height', '6');
		pat.setAttribute('patternUnits', 'userSpaceOnUse');
		pat.setAttribute('patternTransform', 'rotate(45)');
		const stripe = document.createElementNS(SVG_NS, 'rect');
		stripe.setAttribute('width', '2');
		stripe.setAttribute('height', '6');
		stripe.setAttribute('class', 'ct-hatch');
		pat.appendChild(stripe);
		defs.appendChild(pat);
		svg.appendChild(defs);
		const mk = (tag, a) => {
			const e = document.createElementNS(SVG_NS, tag);
			for (const k in a) e.setAttribute(k, a[k]);
			svg.appendChild(e);
			return e;
		};
		for (const f of [0, 0.5, 1]) {
			const y = PAD_T + plotH * (1 - f);
			mk('line', { x1: PAD_L, x2: W - 4, y1: y, y2: y, stroke: grid });
			const t = mk('text', { x: PAD_L - 4, y: y + 3, 'text-anchor': 'end', class: 'ct-axis' });
			t.textContent = fmt(top * f);
		}
		const slotW = plotW / Math.max(1, list.length);
		const every = Math.ceil(list.length / Math.max(1, Math.floor(plotW / 34)));
		list.forEach((s, i) => {
			const x0 = PAD_L + i * slotW;
			const g = document.createElementNS(SVG_NS, 'g');
			const title = document.createElementNS(SVG_NS, 'title');
			let words = slotTitle(s, step);
			if (s.state === 'none') {
				const r = document.createElementNS(SVG_NS, 'rect');
				r.setAttribute('x', x0 + 1);
				r.setAttribute('y', PAD_T);
				r.setAttribute('width', Math.max(1, slotW - 2));
				r.setAttribute('height', plotH);
				r.setAttribute('class', 'ct-none');
				r.setAttribute('fill', 'url(#' + hatch + ')');
				g.appendChild(r);
			} else {
				const v = values(s);
				const bw = Math.max(1, (slotW - 4) / series.length);
				v.forEach((val, k) => {
					const h = top ? (plotH * val) / top : 0;
					const r = document.createElementNS(SVG_NS, 'rect');
					r.setAttribute('x', x0 + 2 + k * bw);
					r.setAttribute('y', PAD_T + plotH - h);
					r.setAttribute('width', Math.max(1, bw - 1));
					r.setAttribute('height', Math.max(0, h));
					r.setAttribute('fill', series[k].color);
					if (s.state === 'part') r.setAttribute('fill-opacity', '0.45');
					g.appendChild(r);
					words += '\n' + series[k].name + ': ' + fmt(val);
				});
			}
			title.textContent = words;
			g.appendChild(title);
			svg.appendChild(g);
			if (i % every === 0) {
				const t = mk('text', { x: x0 + slotW / 2, y: H - 4, 'text-anchor': 'middle', class: 'ct-axis' });
				t.textContent = label(s.t, step);
			}
		});
		host.appendChild(svg);
		const key = el('div', 'ct-key x-small text-secondary');
		for (const s of series) {
			const k = el('span', 'ct-key-item');
			const sw = el('span', 'ct-swatch');
			sw.style.background = s.color;
			k.appendChild(sw);
			k.appendChild(document.createTextNode(s.name));
			key.appendChild(k);
		}
		const none = el('span', 'ct-key-item');
		none.appendChild(el('span', 'ct-swatch ct-swatch-none'));
		none.appendChild(document.createTextNode('not counted'));
		key.appendChild(none);
		host.appendChild(key);
	}

	function paintCharts(list) {
		const step = hist && hist.step === 'day' ? 'day' : 'hour';
		const lines = live.lines || [], zones = live.zones || [];
		const C1 = ink('--st-c1', '#4c60d8'), C2 = ink('--st-c2', '#0d9488');
		const C3 = ink('--st-c3', '#c96a2e'), C4 = ink('--st-c4', '#8a5cd8');
		const whole = (v) => String(Math.round(v));

		$('#ct-lines-box').hidden = !lines.length;
		const lbox = $('#ct-lines');
		lbox.textContent = '';
		lines.forEach((l, i) => {
			if (lines.length > 1) lbox.appendChild(el('div', 'small fw-semibold mt-2', word(l && l.name, 'line ' + (i + 1))));
			const h = el('div');
			lbox.appendChild(h);
			bars(h, list, step, [{ name: 'in', color: C1 }, { name: 'out', color: C2 }],
				(s) => [+(s.lines[i] || {}).in || 0, +(s.lines[i] || {}).out || 0], whole);
		});

		$('#ct-zones-box').hidden = !zones.length;
		const zbox = $('#ct-zones');
		zbox.textContent = '';
		zones.forEach((z, i) => {
			if (zones.length > 1) zbox.appendChild(el('div', 'small fw-semibold mt-2', word(z && z.name, 'zone ' + (i + 1))));
			const h = el('div');
			zbox.appendChild(h);
			bars(h, list, step, [{ name: 'on average', color: C3 }, { name: 'most at once', color: C4 }],
				(s) => [+(s.zones[i] || {}).mean || 0, +(s.zones[i] || {}).peak || 0],
				(v) => (v < 10 && v % 1 ? v.toFixed(1) : String(Math.round(v))));
		});
	}

	function paintDwell(list) {
		const zones = live.zones || [];
		const box = $('#ct-dwell');
		$('#ct-dwell-box').hidden = !zones.length;
		box.textContent = '';
		const tot = D.totals(list, 0, zones.length);
		const words = D.dwellBins(hist && hist.dwellEdges);
		zones.forEach((z, i) => {
			const d = tot.zones[i].dwell;
			const n = d.reduce((a, b) => a + (b || 0), 0);
			if (zones.length > 1) box.appendChild(el('div', 'small fw-semibold mt-2', word(z && z.name, 'zone ' + (i + 1))));
			if (!tot.known) {
				box.appendChild(el('div', 'small text-secondary', 'Not counted in this period.'));
				return;
			}
			if (!n) {
				box.appendChild(el('div', 'small text-secondary', 'Nobody left this zone in this period.'));
				return;
			}
			const tbl = el('div', 'ct-dwell');
			words.forEach((w, k) => {
				const row = el('div', 'ct-dwell-row');
				row.appendChild(el('span', 'ct-dwell-lab small', w));
				const bar = el('span', 'ct-dwell-bar');
				const fill = el('span', 'ct-dwell-fill');
				fill.style.width = ((100 * (d[k] || 0)) / n).toFixed(1) + '%';
				bar.appendChild(fill);
				row.appendChild(bar);
				row.appendChild(el('span', 'ct-dwell-n small text-secondary', String(d[k] || 0)));
				tbl.appendChild(row);
			});
			box.appendChild(tbl);
		});
	}

	// ── the latest events ────────────────────────────────────────────────

	function fmtStay(ms) {
		const s = Math.round(ms / 1000);
		return s < 60 ? s + ' s' : s < 3600 ? Math.round(s / 60) + ' min' : (s / 3600).toFixed(1) + ' h';
	}

	function eventWords(e) {
		if (!e || typeof e !== 'object') return null;
		const who = e.cls === 'vehicle' ? 'A vehicle' : 'Someone';
		const line = word(e.line, 'a line'), zone = word(e.zone, 'a zone');
		const stay = typeof e.dwellMs === 'number' ? fmtStay(e.dwellMs) : null;
		switch (e.kind) {
		case 'in': return who + ' went in at ' + line;
		case 'out': return who + ' went out at ' + line;
		case 'enter': return who + ' entered ' + zone;
		case 'exit': return who + ' left ' + zone + (stay ? ' after ' + stay : '');
		case 'dwell': return who + ' has been in ' + zone + (stay ? ' for ' + stay : ' too long');
		default: return null;
		}
	}

	function paintEvents() {
		const box = $('#ct-events');
		box.textContent = '';
		if (!Array.isArray(live.events)) {
			box.appendChild(el('li', 'small text-secondary', 'The camera did not say what happened lately.'));
			return;
		}
		const evs = live.events.slice(-12).reverse();
		if (!evs.length) {
			box.appendChild(el('li', 'small text-secondary', 'Nothing yet since the camera started counting.'));
			return;
		}
		for (const e of evs) {
			const w = eventWords(e);
			if (!w) continue;
			const li = el('li', 'ct-event small');
			li.appendChild(el('span', 'ct-event-t text-secondary',
				new Date(e.t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })));
			li.appendChild(el('span', e.kind === 'dwell' ? 'ct-event-w text-warning-emphasis' : 'ct-event-w', w));
			box.appendChild(li);
		}
	}

	// ── the loop ─────────────────────────────────────────────────────────

	// One load at a time in effect: a range click or a resize starts a new
	// one while the last is still waiting on the camera, and only the newest
	// may paint or arm the next poll. Without the generation, a slow answer
	// for Today could land after the one for 7 days and draw under the wrong
	// button, and every overlap left a second 5-second loop running.
	let gen = 0;
	async function load() {
		const mine = ++gen;
		clearTimeout(timer);
		timer = null;
		const now = Math.floor(Date.now() / 1000);
		const p = period(now);
		const [l, h, track, caps] = await Promise.all([
			getJSON('/api/v1/counting'),
			getJSON('/api/v1/counting/history?from=' + p.from + '&to=' + p.to + '&step=' + p.step),
			getJSON('/api/v1/get?key=ptz.track'),
			getText('/ptz'),
		]);
		if (mine !== gen) return;
		live = l;
		// Following counts only where the head can follow -- the same test
		// the PTZ pad makes before it offers the switch.
		follows = D.canFollow(track, caps);
		// A history that failed to load keeps the last one on screen rather
		// than replacing it with an empty period -- which would read as a
		// day with nobody in it -- but only while the lines and zones are
		// still the ones it was counted under.
		if (h) hist = h;
		const fresh = !!h;
		// The next poll is armed whatever painting does: one answer the page
		// cannot draw must not be the last one it asks for.
		try {
			if (paintState() === 'on') {
				if (!hist) {
					clearPeriod('history not available — retrying');
				} else if (!D.sameLayout(hist, live)) {
					// Old counts under new lines would be the wrong numbers
					// stated as right ones; better none until the camera answers.
					clearPeriod('the lines or zones changed — waiting for their history');
				} else {
					const list = D.slots(hist, p.from, p.to, now);
					paintTiles(list);
					paintCharts(list);
					paintDwell(list);
					$('#ct-stamp').textContent = fresh ? 'updated ' + new Date().toLocaleTimeString() : 'history not updated — retrying';
				}
				paintEvents();
			}
		} finally {
			if (mine === gen) timer = setTimeout(load, POLL_MS);
		}
	}

	// Nothing of a period on screen but what is said about it: the figures,
	// charts and coverage of another period, or of other lines, are not this
	// one's.
	function clearPeriod(msg) {
		for (const id of ['#ct-kpis', '#ct-lines', '#ct-zones', '#ct-dwell']) $(id).textContent = '';
		$('#ct-cover').hidden = true;
		$('#ct-stamp').textContent = msg;
	}

	$$('[data-range]').forEach((b) => {
		b.addEventListener('click', () => {
			range = b.dataset.range;
			$$('[data-range]').forEach((o) => {
				o.classList.toggle('active', o === b);
				o.setAttribute('aria-pressed', o === b ? 'true' : 'false');
			});
			hist = null;
			clearPeriod('loading…');
			load();
		});
	});
	let resized = null;
	window.addEventListener('resize', () => {
		clearTimeout(resized);
		resized = setTimeout(load, 250);
	});
	load();
})();
