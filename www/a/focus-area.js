/* Focus by ear, on part of the picture: the arithmetic.
 *
 * The camera's focus statistic comes in two shapes. /metrics/isp answers one
 * number for the whole frame; /api/v1/isp/af-zones.json answers the grid that
 * number is made of -- rows x cols cells dividing the ISP's frame evenly, each
 * carrying the two horizontal and two vertical filter sums, a luma accumulator
 * and a count of clipped pixels. Drawing a rectangle on the live picture and
 * hearing only what is inside it comes down to two questions: which cells the
 * rectangle covers, and what one number those cells make. Both are answered
 * here, pure and tested; preview-focus.js does the drawing, the fetch and the
 * sound.
 *
 * The frame the grid divides is the ISP's, which majestic reports as `group`
 * in /api/v1/osd. The statistics are taken ahead of the window each channel
 * cuts from it, so a rectangle drawn on a cropped sub stream has to travel
 * through that channel's window into the group before it can be laid over the
 * grid -- mj-region.js's map, built with the group standing in as a stream of
 * its own. On the common camera the group, the main channel and the grid
 * coincide and every map here is a plain ratio; on a cropped one a ratio would
 * listen to the wrong part of the scene and nothing would say so.
 *
 * The per-cell number is the raw editor's blend of the two second-stage sums,
 * (h2 * 54 + v2 * 10) / 64, whole. Averaged over the covered cells it comes
 * out within a percent of the whole-frame metric on the lab camera, so the two
 * sources are on one scale. Cells with a clipped pixel are left out: a lamp or
 * the sun inside the rectangle pins its cell's sums at the top and the lens
 * stops mattering. So are cells darker than 15 % of the grid's median luma,
 * which measure nothing but noise. The median is the whole grid's, not the
 * rectangle's, so the floor does not move with what was drawn. A rectangle
 * with no cell left is NULL, not zero: nothing in it can be measured, and a
 * zero would read as a black scene the lens could still be turned for.
 *
 * Cells are chosen by their centres: a cell whose centre lies inside the
 * rectangle is in, so an edge grazed by the drag does not pull in a cell that
 * is mostly outside it. A rectangle too small to hold any centre takes the one
 * cell under its own middle, so a tap-sized drag still listens to something.
 * Everything is in unit fractions of the grid's frame, which mean the same on
 * every stream and at every zoom.
 */
(function () {
	'use strict';

	/* Of the grid's median luma: the raw editor's rule, so the cells this
	 * leaves out are the cells its Focus tab paints as unlit. */
	const DARK_BELOW = 0.15;
	const W_H2 = 54, W_V2 = 10, W_DIV = 64;
	const FIELDS = ['h1', 'h2', 'v1', 'v2', 'y', 'hlcnt'];

	function num(v) { return typeof v === 'number' && isFinite(v); }
	function whole(v) { return num(v) && Math.floor(v) === v && v > 0; }
	function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
	function size(s) { return !!s && num(s.w) && num(s.h) && s.w > 0 && s.h > 0; }

	/* The shape has to hold before anything is read from it, and on every
	 * answer rather than the first: a grid that advertised 15 x 17 and then
	 * sends 200 cells is a grid to refuse, not to index. The `fields` line, when
	 * the camera sends one, has to name every field this reads. */
	function usable(g) {
		if (!g || !whole(g.rows) || !whole(g.cols)) return false;
		if (!Array.isArray(g.zones) || g.zones.length !== g.rows * g.cols) return false;
		if (g.fields !== undefined) {
			if (!Array.isArray(g.fields)) return false;
			for (let i = 0; i < FIELDS.length; i++)
				if (g.fields.indexOf(FIELDS[i]) < 0) return false;
		}
		const n = Array.isArray(g.fields) ? g.fields.length : FIELDS.length;
		for (let i = 0; i < g.zones.length; i++) {
			const z = g.zones[i];
			if (!Array.isArray(z) || z.length < n) return false;
			for (let k = 0; k < n; k++)
				if (!num(z[k]) || z[k] < 0) return false;
		}
		return true;
	}

	/* Where each field sits in a cell: by the grid's own `fields` line when it
	 * carries one, else in the order the camera has always used. */
	function slots(g) {
		const f = g && Array.isArray(g.fields) ? g.fields : FIELDS;
		return { h2: f.indexOf('h2'), v2: f.indexOf('v2'), y: f.indexOf('y'), hl: f.indexOf('hlcnt') };
	}

	function blend(z, s) {
		const at = s || slots(null);
		return Math.trunc((z[at.h2] * W_H2 + z[at.v2] * W_V2) / W_DIV);
	}

	/* What preview-focus.js learns about the picture on screen: `map` is
	 * mj-region.js's, with the group as the reference stream, so k and o take
	 * group pixels to the shown stream's DECLARED pixels; `group` is the grid's
	 * frame; `declared` the size the camera says the shown stream is; `decoded`
	 * what the player actually received, which WebRTC may have scaled down. */
	function geomOk(g) {
		return !!g && !!g.map && !!g.map.k && !!g.map.o &&
			num(g.map.k.x) && num(g.map.k.y) && g.map.k.x > 0 && g.map.k.y > 0 &&
			num(g.map.o.x) && num(g.map.o.y) &&
			size(g.group) && size(g.declared) && size(g.decoded);
	}
	function unitOk(u) {
		return !!u && num(u.x0) && num(u.y0) && num(u.x1) && num(u.y1) &&
			u.x1 > u.x0 && u.y1 > u.y0;
	}

	/* A rectangle on the decoded picture, {x, y, w, h}, to unit fractions of the
	 * grid's frame, {x0, y0, x1, y1}. Null when a number is missing, or when
	 * nothing of the rectangle lies on the frame -- a drag that stayed on the
	 * part of a cropped stream that shows nothing the grid covers. */
	function fromShown(rect, geom) {
		if (!rect || !geomOk(geom)) return null;
		if (!num(rect.x) || !num(rect.y) || !num(rect.w) || !num(rect.h)) return null;
		if (rect.w <= 0 || rect.h <= 0) return null;
		const ax = geom.decoded.w / geom.declared.w, ay = geom.decoded.h / geom.declared.h;
		const m = geom.map;
		const gx0 = (rect.x / ax - m.o.x) / m.k.x, gy0 = (rect.y / ay - m.o.y) / m.k.y;
		const gx1 = gx0 + rect.w / ax / m.k.x, gy1 = gy0 + rect.h / ay / m.k.y;
		const u = {
			x0: clamp01(gx0 / geom.group.w), y0: clamp01(gy0 / geom.group.h),
			x1: clamp01(gx1 / geom.group.w), y1: clamp01(gy1 / geom.group.h),
		};
		return u.x1 > u.x0 && u.y1 > u.y0 ? u : null;
	}

	/* The way back, for drawing the cells on the picture: unit fractions to a
	 * rectangle in decoded pixels of the shown stream. Not clamped -- on a
	 * cropped stream part of the grid is off the picture, and the outline
	 * should say so by running off the edge rather than by shrinking. */
	function toShown(u, geom) {
		if (!unitOk(u) || !geomOk(geom)) return null;
		const ax = geom.decoded.w / geom.declared.w, ay = geom.decoded.h / geom.declared.h;
		const m = geom.map;
		return {
			x: (m.k.x * u.x0 * geom.group.w + m.o.x) * ax,
			y: (m.k.y * u.y0 * geom.group.h + m.o.y) * ay,
			w: (u.x1 - u.x0) * geom.group.w * m.k.x * ax,
			h: (u.y1 - u.y0) * geom.group.h * m.k.y * ay,
		};
	}

	/* The run of cells along one axis whose centres fall inside [lo, hi] of n
	 * cells; the one cell under the middle when none does. */
	function span(lo, hi, n) {
		let a = Math.ceil(lo * n - 0.5), b = Math.floor(hi * n - 0.5);
		if (b < a) a = b = Math.floor((lo + hi) / 2 * n);
		a = Math.min(n - 1, Math.max(0, a));
		b = Math.min(n - 1, Math.max(0, b));
		return [a, b];
	}

	/* Which cells a unit rectangle covers, as an inclusive range of rows and
	 * columns. The whole frame, {0, 0, 1, 1}, is every cell. */
	function cells(u, rows, cols) {
		if (!unitOk(u) || !whole(rows) || !whole(cols)) return null;
		const c = span(u.x0, u.x1, cols), r = span(u.y0, u.y1, rows);
		return { r0: r[0], r1: r[1], c0: c[0], c1: c[1] };
	}

	function cellsOk(c, rows, cols) {
		return !!c && whole(rows) && whole(cols) &&
			Number.isInteger(c.r0) && Number.isInteger(c.r1) &&
			Number.isInteger(c.c0) && Number.isInteger(c.c1) &&
			c.r0 >= 0 && c.r0 <= c.r1 && c.r1 < rows &&
			c.c0 >= 0 && c.c0 <= c.c1 && c.c1 < cols;
	}

	/* The rectangle those cells make, in unit fractions: what is drawn, so the
	 * outline shows the cells being listened to rather than the drag that chose
	 * them. */
	function bounds(c, rows, cols) {
		if (!cellsOk(c, rows, cols)) return null;
		return { x0: c.c0 / cols, y0: c.r0 / rows, x1: (c.c1 + 1) / cols, y1: (c.r1 + 1) / rows };
	}

	/* One number for the cells, or null when nothing in them can be measured.
	 * The counts ride along so a caller can say WHY there is nothing. */
	function measure(g, c) {
		if (!usable(g) || !cellsOk(c, g.rows, g.cols)) return null;
		const s = slots(g);
		const ys = g.zones.map((z) => z[s.y]).sort((a, b) => a - b);
		const floor = ys[ys.length >> 1] * DARK_BELOW;
		let sum = 0, measured = 0, clipped = 0, dark = 0, total = 0;
		for (let r = c.r0; r <= c.r1; r++) {
			for (let k = c.c0; k <= c.c1; k++) {
				const z = g.zones[r * g.cols + k];
				total++;
				if (z[s.hl] > 0) { clipped++; continue; }
				if (z[s.y] < floor) { dark++; continue; }
				sum += blend(z, s);
				measured++;
			}
		}
		return {
			value: measured ? sum / measured : null,
			measured: measured, clipped: clipped, dark: dark, total: total,
		};
	}

	const api = { usable: usable, blend: blend, fromShown: fromShown, toShown: toShown,
		cells: cells, bounds: bounds, measure: measure, DARK_BELOW: DARK_BELOW };
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticFocusArea = api;
})();
