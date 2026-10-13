// What the Counting page makes of majestic's counting answers, kept away from
// the DOM so it can be tested.
//
// The one thing this must never do is turn "not counted" into "nobody came".
// The camera's history (GET /api/v1/counting/history) lists only the hours it
// has: an hour the camera was off, had no card and had restarted since, or ran
// under other lines is simply missing from the answer, and an hour that was
// counted for ten minutes says so in `covered`. A chart that filled the gaps
// with zeroes would draw a closed shop on a day the camera was unplugged, and
// nothing on screen could tell the two apart. So every slot of the requested
// range comes back as one of three things -- counted, partly counted, or not
// counted -- and only the first two carry numbers.
(function () {
	'use strict';

	const HOUR = 3600;

	// The local midnight at or before unix second `t`, as the camera's own
	// `step=day` buckets are: the start of the calendar day, which on a
	// daylight-saving change is not 24 hours from the one before.
	function dayStart(t) {
		const d = new Date(t * 1000);
		d.setHours(0, 0, 0, 0);
		return Math.floor(d.getTime() / 1000);
	}

	function nextSlot(t, step) {
		if (step === 'hour') return t + HOUR;
		const d = new Date(t * 1000);
		d.setDate(d.getDate() + 1);
		d.setHours(0, 0, 0, 0);
		return Math.floor(d.getTime() / 1000);
	}

	// Every slot from `from` to `to` (unix seconds), each matched to the bucket
	// the camera returned for it, or marked as not counted.
	//
	//   { t, state: 'none' }                       no data for this slot
	//   { t, state: 'part'|'full', covered, lines, zones }
	//
	// `full` is a slot counted for all of its length, `part` one counted for
	// some of it; the page draws the difference, because 3 people in an hour
	// counted for ten minutes is not 3 people that hour.
	function slots(history, from, to, now) {
		const step = history && history.step === 'day' ? 'day' : 'hour';
		const by = new Map();
		for (const b of (history && history.buckets) || [])
			if (b && typeof b.t === 'number') by.set(b.t, b);
		const out = [];
		let t = step === 'day' ? dayStart(from) : Math.floor(from / HOUR) * HOUR;
		for (let guard = 0; t <= to && guard < 2000; guard++) {
			const end = nextSlot(t, step);
			const b = by.get(t);
			if (!b) {
				out.push({ t: t, state: 'none' });
			} else {
				// The slot still running is only as long as it has been so
				// far; an hour that started twenty minutes ago and was counted
				// for all twenty is a full one.
				const span = Math.max(1, Math.min(end, now || end) - t);
				const covered = Math.max(0, +b.covered || 0);
				out.push({
					t: t,
					state: covered >= span * 0.95 ? 'full' : covered > 0 ? 'part' : 'none',
					covered: covered,
					lines: Array.isArray(b.lines) ? b.lines : [],
					zones: Array.isArray(b.zones) ? b.zones : [],
				});
			}
			t = end;
		}
		return out;
	}

	// Sums over the slots that were counted. `known` is how many of them there
	// were; with none, the totals are not zero, they are unknown, and the
	// caller says so rather than printing a 0.
	function totals(list, nLines, nZones) {
		const r = {
			known: 0,
			lines: Array.from({ length: nLines }, () => ({ in: 0, out: 0 })),
			zones: Array.from({ length: nZones }, () => ({ entered: 0, peak: 0, dwell: [] })),
		};
		for (const s of list) {
			if (s.state === 'none') continue;
			r.known++;
			s.lines.forEach((l, i) => {
				if (!r.lines[i]) return;
				r.lines[i].in += +l.in || 0;
				r.lines[i].out += +l.out || 0;
			});
			s.zones.forEach((z, i) => {
				const o = r.zones[i];
				if (!o) return;
				o.entered += +z.entered || 0;
				o.peak = Math.max(o.peak, +z.peak || 0);
				(z.dwell || []).forEach((n, k) => { o.dwell[k] = (o.dwell[k] || 0) + (+n || 0); });
			});
		}
		return r;
	}

	// How much of the period was counted, in words for a tile: null when all
	// of it was, so a fully counted period says nothing extra. "0 today" over a
	// day the camera counted for ten minutes of is the same wrong answer as a
	// gap drawn as zero, told in a number instead of a bar.
	function coverage(list, step, now) {
		let counted = 0, total = 0;
		for (const s of list) {
			const end = step === 'hour' ? s.t + HOUR : nextSlot(s.t, 'day');
			const span = Math.max(0, Math.min(end, now || end) - s.t);
			total += span;
			if (s.state !== 'none') counted += Math.min(span, s.covered || 0);
		}
		if (!total || counted >= total * 0.95) return null;
		if (!counted) return 'not counted';
		const unit = step === 'hour' ? HOUR : 86400;
		const of = Math.max(1, Math.round(total / unit));
		const n = Math.round(counted / unit);
		const word = step === 'hour' ? 'hour' : 'day';
		if (n < 1) return 'counted for ' + Math.max(1, Math.round(counted / 60)) + ' min of ' + of + ' ' + word + (of === 1 ? '' : 's');
		return 'counted for ' + n + ' of ' + of + ' ' + word + (of === 1 ? '' : 's');
	}

	function fmtSecs(s) {
		if (s < 60) return s + ' s';
		if (s < 3600) return Math.round(s / 60) + ' min';
		return Math.round(s / 360) / 10 + ' h';
	}

	// The dwell histogram's bins, in words: "under 10 s", "10 s – 30 s", …,
	// "over 30 min".
	function dwellBins(edges) {
		const e = Array.isArray(edges) ? edges : [];
		if (!e.length) return [];
		const out = ['under ' + fmtSecs(e[0])];
		for (let i = 1; i < e.length; i++) out.push(fmtSecs(e[i - 1]) + ' – ' + fmtSecs(e[i]));
		out.push('over ' + fmtSecs(e[e.length - 1]));
		return out;
	}

	// The middle stay, from a histogram: the bin that holds the median, as
	// words. Null with no stays at all -- "no one stayed" and "nobody was
	// counted" are both "no median", and the caller knows which.
	function medianBin(dwell, edges) {
		const n = dwell.reduce((a, b) => a + (b || 0), 0);
		if (!n) return null;
		let acc = 0;
		const words = dwellBins(edges);
		for (let i = 0; i < dwell.length; i++) {
			acc += dwell[i] || 0;
			if (acc * 2 >= n) return words[i] || null;
		}
		return null;
	}

	// What GET /api/v1/counting says about whether there is anything to show:
	//   'unknown'   the camera could not be asked (a failed fetch is no answer)
	//   'off'       counting is switched off
	//   'empty'     it is on and has no lines and no zones
	//   'on'
	function state(live) {
		if (!live || typeof live !== 'object') return 'unknown';
		if (!live.enabled) return 'off';
		const n = (live.lines || []).length + (live.zones || []).length;
		return n ? 'on' : 'empty';
	}

	const api = {
		slots: slots,
		totals: totals,
		dwellBins: dwellBins,
		medianBin: medianBin,
		state: state,
		dayStart: dayStart,
		coverage: coverage,
	};
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MjCountingData = api;
})();
