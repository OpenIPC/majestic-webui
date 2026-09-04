// Shared chart primitives: sparklines and axis charts, extracted from the
// status dashboard so the Live View stats panel draws with the same pencil.
// Colors are per-instance arguments rather than module-init reads of the
// --st-c* theme tokens: the dashboard passes its theme colors, the stats
// panel passes bright-on-glass ones (its black glass is the same in both
// themes, so the page theme must not decide its ink).
window.MjCharts = (function () {
	const SVG_NS = 'http://www.w3.org/2000/svg';
	const charts = [];

	// Lightweight inline-SVG sparkline: a single area+line path stretched to
	// the host width via a fixed viewBox + preserveAspectRatio=none; the
	// 1.5px stroke stays crisp through vector-effect. `cap` is how many
	// samples to keep (default 60 — 2 min at the dashboard's 2s poll).
	//
	// `slot` widens the span without lengthening the path: one point covers
	// `slot` SECONDS, opened when the clock crosses a boundary and overwritten
	// by every push in between, so the trace holds `cap * slot` seconds and
	// points older than that are dropped by age. It is deliberately a
	// duration and not a count of pushes — the caller's pushes are not a
	// clock, since the dashboard's poll arms its next tick 2s after the last
	// one SETTLED and pushes nothing at all for a poll that failed. A count
	// would quietly stretch the window past what it claims, and a sparkline
	// has no axis to admit that with; holding the span is the only way one can
	// be honest about it. Omitted is a point per push, capped by count, which
	// is what every sparkline that does not ask still gets. Overwriting keeps
	// the last value of each slot rather than its peak, which suits a level
	// that moves smoothly (memory) and would hide a spike in one that does not.
	function makeSpark(id, color, lo, hi, cap, slot) {
		const el = typeof id === 'string' ? $(id) : id;
		if (!el) return null;
		const svg = document.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('viewBox', '0 0 100 38');
		svg.setAttribute('preserveAspectRatio', 'none');
		const fill = document.createElementNS(SVG_NS, 'path');
		fill.setAttribute('fill', color + '22');
		const line = document.createElementNS(SVG_NS, 'path');
		line.setAttribute('fill', 'none');
		line.setAttribute('stroke', color);
		line.setAttribute('stroke-width', '1.5');
		line.setAttribute('stroke-linejoin', 'round');
		line.setAttribute('vector-effect', 'non-scaling-stroke');
		svg.appendChild(fill);
		svg.appendChild(line);
		el.textContent = '';
		el.appendChild(svg);
		return { fill: fill, line: line, lo: lo, hi: hi, cap: cap || 60, slot: slot || 0, ks: [], ys: [] };
	}
	function pushSpark(s, y) {
		if (!s) return;
		const ys = s.ys, ks = s.ks;
		if (!s.slot) {
			ys.push(y);
			if (ys.length > s.cap) ys.shift();
		} else {
			// Absolute slot index off the clock, so a boundary is a boundary
			// however the polls happen to land and nothing drifts by a poll
			// interval per point.
			const k = Math.floor(performance.now() / 1000 / s.slot);
			if (ks.length && ks[ks.length - 1] === k) ys[ys.length - 1] = y;
			else { ys.push(y); ks.push(k); }
			// Evicting by AGE rather than by count is the half that survives an
			// outage: points from before a gap in polling are genuinely old,
			// and this trace is drawn by index and cannot show that they are.
			while (ks.length && k - ks[0] >= s.cap) { ks.shift(); ys.shift(); }
		}
		const n = ys.length, W = 100, H = 38;
		let lo = s.lo != null ? s.lo : Math.min.apply(null, ys);
		let hi = s.hi != null ? s.hi : Math.max.apply(null, ys);
		if (hi - lo < 1e-9) hi = lo + 1;
		const dx = n > 1 ? W / (n - 1) : 0;
		let d = '';
		for (let i = 0; i < n; i++) {
			let yy = H - ((ys[i] - lo) / (hi - lo)) * H;
			yy = yy < 0 ? 0 : yy > H ? H : yy;
			d += (i ? 'L' : 'M') + (i * dx).toFixed(2) + ' ' + yy.toFixed(2);
		}
		s.line.setAttribute('d', d);
		s.fill.setAttribute('d', n ? d + 'L' + ((n - 1) * dx).toFixed(2) + ' ' + H + 'L0 ' + H + 'Z' : '');
	}

	// ── axis charts ─────────────────────────────────────────────────────────
	// Real pixel-space rendering (unlike the stretchy sparklines): text must
	// not distort, so each chart re-renders an SVG at the host's current
	// width on every push and on resize.
	function niceCeil(x) {
		if (x <= 0) return 1;
		const p = Math.pow(10, Math.floor(Math.log10(x)));
		const m = x / p;
		return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
	}
	function fmtNum(x) {
		return Math.abs(x) >= 100 || x === (x | 0) ? String(Math.round(x)) : x.toFixed(1);
	}

	// cfg: { h, lo, hi (null = auto), ref {v,label}|null, bands [{from,to,
	// color,label}], colors [..], fmt, grid, refColor, win, gap, hide [..] } —
	// series count = colors.length; `grid` is the hairline color, `refColor`
	// the reference line's (defaults keep the dashboard's look).
	//
	// `hide` withholds a series from the DRAWING without withholding it from
	// the data, which are two different questions and were briefly answered by
	// one: pushing null to hide a line also told everything reading the points
	// back that the value was unknown, and a memory slice that sat at zero and
	// then rose and fell went unreported because the window still opened on one
	// of those nulls. Push the truth; hide it here.
	//
	// Samples are timestamped and x is elapsed time, not sample index: a
	// failed or slow poll leaves a real hole, so the line breaks across an
	// outage instead of bridging it, and nothing older than the labelled
	// window is drawn as if it were recent.
	//
	// `win` and `gap` are per-chart because not every subject is a subject of
	// "right now": bitrate and signal are, memory is a trend over hours. They
	// were module constants, which is why the memory question had no
	// instrument to be asked with (issue #322). What a hole IS depends on how
	// often the caller pushes, so a chart that widens its window widens its
	// gap with it.
	const CHART_WINDOW = 120; // default seconds of history on screen
	const CHART_GAP = 8;      // default: a hole longer than this breaks the line
	// The plot's vertical furniture, hoisted out of renderChart so that the
	// height a chart is GOING to draw at can be known before it has any samples
	// to draw. Everything horizontal stays in there: it depends on the host's
	// measured width, which is not knowable this early.
	const PAD_T = 5;  // headroom above the top gridline
	const X_BAND = 14; // the "-2 min / now" strip below the plot
	function chartHeight(cfg) { return PAD_T + cfg.h + X_BAND; }
	function makeChart(sel, cfg) {
		const host = typeof sel === 'string' ? $(sel) : sel;
		if (!host) return null;
		// Reserve the height now. A chart draws nothing until it has been
		// pushed a sample, which on the dashboard is one heartbeat away, so its
		// box was 0px tall through the first seconds of the page and then
		// sprang to its full height -- taking everything below it down the page
		// and, on the Dashboard's hero row, stretching the camera tile out of
		// the 16:9 it declares (a flex row's default `align-items: stretch`
		// gives an item a definite cross size, which overrides `aspect-ratio`;
		// the tile went 368x207 to 368x224 about four seconds in). The number
		// is not a guess or a duplicate: it is the same arithmetic the render
		// uses, so the reservation cannot drift from what lands in it.
		host.style.minHeight = chartHeight(cfg) + 'px';
		const ch = { host: host, cfg: cfg, pts: [] };
		charts.push(ch);
		return ch;
	}
	function pushChart(ch, vals) {
		if (!ch) return;
		const t = performance.now() / 1000;
		ch.pts.push({ t: t, v: vals });
		const win = ch.cfg.win || CHART_WINDOW;
		while (ch.pts.length && ch.pts[0].t < t - win) ch.pts.shift();
		renderChart(ch);
	}

	// The window's own label. It was the literal string "-2 min" sitting 115
	// lines below the constant that decided the window, so changing one left
	// the other quietly saying something untrue.
	function spanLabel(sec) {
		if (sec % 3600 === 0) return '-' + (sec / 3600) + ' h';
		if (sec % 60 === 0) return '-' + (sec / 60) + ' min';
		return '-' + sec + ' s';
	}
	function renderChart(ch) {
		if (!ch) return;
		const W = ch.host.clientWidth;
		if (!W) return;
		const cfg = ch.cfg;
		const win = cfg.win || CHART_WINDOW, gap = cfg.gap || CHART_GAP;
		const padL = 30, padR = 6, padT = PAD_T, H = cfg.h, XB = X_BAND;
		const plotW = W - padL - padR;
		const lo = cfg.lo;
		let hi = cfg.hi;
		const pts = ch.pts, n = pts.length;
		if (hi == null) {
			let max = 0;
			pts.forEach(p => p.v.forEach(v => { if (v != null && v > max) max = v; }));
			hi = niceCeil(Math.max(max * 1.15, 1));
		}
		const fmt = cfg.fmt || fmtNum;
		const grid = cfg.grid || '#e9ebf2';
		const Y = v => {
			let y = padT + (1 - (v - lo) / (hi - lo)) * H;
			return y < padT ? padT : y > padT + H ? padT + H : y;
		};
		// "now" is the render moment, not the newest sample: during an outage
		// the trace ages leftward instead of sitting pinned at the label.
		const tNow = performance.now() / 1000;
		const X = t => padL + plotW * (1 - (tNow - t) / win);
		let s = '';
		// threshold bands (Wi-Fi grades, luminance floor) sit under everything
		(cfg.bands || []).forEach(b => {
			const y1 = Y(b.to), y2 = Y(b.from);
			s += '<rect x="' + padL + '" y="' + y1.toFixed(1) + '" width="' + plotW +
				'" height="' + (y2 - y1).toFixed(1) + '" fill="' + b.color + '"/>';
			if (b.label) s += '<text x="' + (padL + plotW - 4) + '" y="' + (y1 + 10).toFixed(1) +
				'" text-anchor="end" opacity="0.8">' + b.label + '</text>';
		});
		// hairline grid at lo / mid / hi, labels on the left
		[lo, (lo + hi) / 2, hi].forEach(t => {
			const y = Y(t);
			s += '<line x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (padL + plotW) +
				'" y2="' + y.toFixed(1) + '" stroke="' + grid + '" stroke-width="1"/>';
			s += '<text x="' + (padL - 5) + '" y="' + (y + 3.5).toFixed(1) + '" text-anchor="end">' + fmt(t) + '</text>';
		});
		if (cfg.ref && cfg.ref.v > lo && cfg.ref.v < hi) {
			const y = Y(cfg.ref.v);
			const rc = cfg.refColor || cfg.colors[0];
			s += '<line x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (padL + plotW) +
				'" y2="' + y.toFixed(1) + '" stroke="' + rc + '" stroke-width="1" opacity="0.45"/>';
			s += '<text x="' + (padL + plotW - 4) + '" y="' + (y - 4).toFixed(1) + '" text-anchor="end">' + cfg.ref.label + '</text>';
		}
		const yBase = (padT + H).toFixed(1);
		for (let si = 0; si < cfg.colors.length; si++) {
			if (cfg.hide && cfg.hide[si]) continue;
			// line and area are built per contiguous run: a null value or a
			// gap longer than CHART_GAP closes the run, so neither the stroke
			// nor the fill spans an outage.
			let line = '', area = '', seg = null; // seg = [firstX, lastX]
			const close = () => {
				if (!seg) return;
				area += 'L' + seg[1] + ' ' + yBase + 'L' + seg[0] + ' ' + yBase + 'Z';
				seg = null;
			};
			for (let i = 0; i < n; i++) {
				const v = pts[i].v[si];
				if (i && pts[i].t - pts[i - 1].t > gap) close();
				if (v == null || tNow - pts[i].t > win) { close(); continue; }
				const x = X(pts[i].t).toFixed(1), y = Y(v).toFixed(1);
				if (!seg) {
					line += 'M' + x + ' ' + y;
					area += 'M' + x + ' ' + y;
					seg = [x, x];
				} else {
					line += 'L' + x + ' ' + y;
					area += 'L' + x + ' ' + y;
					seg[1] = x;
				}
			}
			close();
			if (!line) continue;
			if (cfg.colors.length === 1)
				s += '<path d="' + area + '" fill="' + cfg.colors[0] + '1A"/>';
			s += '<path d="' + line + '" fill="none" stroke="' + cfg.colors[si] +
				'" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
		}
		s += '<text x="' + padL + '" y="' + (padT + H + XB - 2) + '">' + spanLabel(win) + '</text>';
		s += '<text x="' + (padL + plotW) + '" y="' + (padT + H + XB - 2) + '" text-anchor="end">now</text>';
		ch.host.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + (padT + H + XB) +
			'" width="' + W + '" height="' + (padT + H + XB) + '">' + s + '</svg>';
	}
	function renderAll() { charts.forEach(renderChart); }

	// Forget a chart that is being replaced. The dashboard's charts live as
	// long as the page and never need this; a settings panel that is unmounted
	// and remade on every visit does, or the registry accumulates detached
	// hosts and their sample history for the life of the tab.
	function dropChart(ch) {
		if (!ch) return;
		const i = charts.indexOf(ch);
		if (i >= 0) charts.splice(i, 1);
	}

	// One debounced resize listener for every chart on the page, whichever
	// script created it.
	let rt = null;
	addEventListener('resize', () => {
		clearTimeout(rt);
		rt = setTimeout(renderAll, 150);
	});

	return {
		makeSpark: makeSpark, pushSpark: pushSpark,
		makeChart: makeChart, pushChart: pushChart, dropChart: dropChart,
		renderChart: renderChart, renderAll: renderAll,
		fmtNum: fmtNum, niceCeil: niceCeil,
	};
})();
