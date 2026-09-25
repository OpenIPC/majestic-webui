// Focus by ear, on part of the picture: which cells a rectangle covers and
// what one number they make (www/a/focus-area.js).
//
// Both halves of the admission rule. It fails SILENTLY: a rectangle mapped to
// the wrong cells still yields a plausible number that still makes plausible
// beeps, and an off-by-one row listens to the sky above the subject with the
// same confidence. And it cannot be reproduced on demand: it needs a camera
// with a cropped sub stream, a lamp inside the rectangle, and a lens turned by
// hand while someone checks which cells moved. A fixture holds all that still.
'use strict';

const path = require('path');
const { check, group, done } = require('./assert');

const A = require(path.join(__dirname, '..', 'www', 'a', 'focus-area.js'));
const R = require(path.join(__dirname, '..', 'www', 'a', 'mj-region.js'));

const near = (a, b, eps) => Math.abs(a - b) <= (eps || 1e-6);
const eq = (name, got, want) =>
	check(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got));
const unitNear = (name, got, want) =>
	check(name, !!got && near(got.x0, want.x0) && near(got.y0, want.y0) &&
		near(got.x1, want.x1) && near(got.y1, want.y1), 'got ' + JSON.stringify(got));

// A cell: [h1, h2, v1, v2, y, hlcnt].
const cell = (h2, v2, y, hl) => [1, h2, 2, v2, y, hl || 0];
// Two rows of three, lit evenly, with a different focus value in every cell.
const GRID = {
	rows: 2, cols: 3, fields: ['h1', 'h2', 'v1', 'v2', 'y', 'hlcnt'],
	zones: [
		cell(1000, 100, 10000), cell(2000, 200, 10000), cell(3000, 300, 10000),
		cell(4000, 400, 10000), cell(5000, 500, 10000), cell(6000, 600, 10000),
	],
};
const blendOf = (h2, v2) => Math.trunc((h2 * 54 + v2 * 10) / 64);

group('the grid has to hold its shape');
{
	check('the fixture is usable', A.usable(GRID));
	check('so is one without a fields line', A.usable({ rows: 2, cols: 3, zones: GRID.zones }));
	check('a count that disagrees with rows x cols is not',
		!A.usable({ rows: 2, cols: 3, zones: GRID.zones.slice(0, 5) }));
	check('fractional rows are not', !A.usable({ rows: 1.5, cols: 4, zones: GRID.zones }));
	check('zero cols are not', !A.usable({ rows: 6, cols: 0, zones: [] }));
	check('a negative count is not',
		!A.usable({ rows: 2, cols: 3, zones: GRID.zones.map((z, i) => (i ? z : [1, -2, 2, 3, 4, 0])) }));
	check('a short cell is not',
		!A.usable({ rows: 2, cols: 3, zones: GRID.zones.map((z, i) => (i ? z : [1, 2, 3])) }));
	check('a fields line missing a field this reads is not',
		!A.usable({ rows: 2, cols: 3, fields: ['h1', 'h2', 'v1', 'v2', 'y', 'hl'], zones: GRID.zones }));
	check('nothing at all is not', !A.usable(null) && !A.usable({}));
}

group('the blend is the raw editor\'s, whole');
{
	eq('54 to 10 over 64, truncated', A.blend(cell(1000, 100)), blendOf(1000, 100));
	eq('and it truncates rather than rounds', A.blend(cell(1, 1)), 1);
	// The camera names its fields; a grid that lists them in another order is
	// read by name, not by position.
	const s = { h2: 0, v2: 1, y: 2, hl: 3 };
	eq('fields are found by name when the grid says where they are',
		A.blend([1000, 100, 5, 0], s), blendOf(1000, 100));
}

group('which cells a rectangle covers: by their centres');
{
	eq('the whole frame is every cell',
		A.cells({ x0: 0, y0: 0, x1: 1, y1: 1 }, 2, 3), { r0: 0, r1: 1, c0: 0, c1: 2 });
	// Column centres on three columns sit at 1/6, 1/2 and 5/6.
	eq('a band across the middle third takes the middle column only',
		A.cells({ x0: 0.3, y0: 0, x1: 0.7, y1: 1 }, 2, 3), { r0: 0, r1: 1, c0: 1, c1: 1 });
	eq('grazing the next column does not pull it in',
		A.cells({ x0: 0.3, y0: 0, x1: 0.8, y1: 1 }, 2, 3), { r0: 0, r1: 1, c0: 1, c1: 1 });
	eq('reaching its centre does',
		A.cells({ x0: 0.3, y0: 0, x1: 0.84, y1: 1 }, 2, 3), { r0: 0, r1: 1, c0: 1, c1: 2 });
	eq('a rectangle holding no centre takes the cell under its middle',
		A.cells({ x0: 0.34, y0: 0.55, x1: 0.40, y1: 0.60 }, 2, 3), { r0: 1, r1: 1, c0: 1, c1: 1 });
	eq('rows are rows and columns are columns: the top-right corner',
		A.cells({ x0: 0.9, y0: 0, x1: 1, y1: 0.1 }, 2, 3), { r0: 0, r1: 0, c0: 2, c1: 2 });
	eq('the bottom-left corner',
		A.cells({ x0: 0, y0: 0.9, x1: 0.1, y1: 1 }, 2, 3), { r0: 1, r1: 1, c0: 0, c1: 0 });
	eq('on a 15 x 17 grid a 2 % square in the middle is one cell',
		A.cells({ x0: 0.5, y0: 0.5, x1: 0.52, y1: 0.52 }, 15, 17), { r0: 7, r1: 7, c0: 8, c1: 8 });
	eq('and a whole frame is all 255',
		A.cells({ x0: 0, y0: 0, x1: 1, y1: 1 }, 15, 17), { r0: 0, r1: 14, c0: 0, c1: 16 });
	check('no area is no cells', A.cells({ x0: 0.5, y0: 0, x1: 0.5, y1: 1 }, 2, 3) === null);
	check('a NaN is no cells', A.cells({ x0: NaN, y0: 0, x1: 1, y1: 1 }, 2, 3) === null);
	check('a grid with no rows is no cells', A.cells({ x0: 0, y0: 0, x1: 1, y1: 1 }, 0, 3) === null);
	check('nothing is no cells', A.cells(null, 2, 3) === null);
}

group('the outline is the cells, not the drag');
{
	unitNear('the middle column of two rows', A.bounds({ r0: 0, r1: 1, c0: 1, c1: 1 }, 2, 3),
		{ x0: 1 / 3, y0: 0, x1: 2 / 3, y1: 1 });
	unitNear('every cell is the whole frame', A.bounds({ r0: 0, r1: 1, c0: 0, c1: 2 }, 2, 3),
		{ x0: 0, y0: 0, x1: 1, y1: 1 });
	check('a range off the grid is nothing', A.bounds({ r0: 0, r1: 2, c0: 0, c1: 2 }, 2, 3) === null);
	check('an inverted range is nothing', A.bounds({ r0: 1, r1: 0, c0: 0, c1: 2 }, 2, 3) === null);
}

group('one number from the cells');
{
	const all = A.measure(GRID, { r0: 0, r1: 1, c0: 0, c1: 2 });
	const want = GRID.zones.reduce((s, z) => s + blendOf(z[1], z[3]), 0) / 6;
	check('the whole grid is the mean of every blend', all && near(all.value, want), JSON.stringify(all));
	eq('and every cell counts as measured',
		[all.measured, all.clipped, all.dark, all.total], [6, 0, 0, 6]);
	const one = A.measure(GRID, { r0: 1, r1: 1, c0: 2, c1: 2 });
	check('one cell is its own blend', one && one.value === blendOf(6000, 600), JSON.stringify(one));
	const col = A.measure(GRID, { r0: 0, r1: 1, c0: 1, c1: 1 });
	check('a column is the mean of its two cells',
		col && near(col.value, (blendOf(2000, 200) + blendOf(5000, 500)) / 2), JSON.stringify(col));

	// A lamp in the rectangle: the cell under it has clipped pixels, and its
	// pinned sums would otherwise be the biggest number in the mean.
	const lamp = { rows: 2, cols: 3, zones: GRID.zones.map((z, i) => (i === 4 ? cell(65535, 65535, 60000, 12) : z)) };
	const m = A.measure(lamp, { r0: 1, r1: 1, c0: 0, c1: 2 });
	check('a clipped cell is left out', m && near(m.value, (blendOf(4000, 400) + blendOf(6000, 600)) / 2), JSON.stringify(m));
	eq('and counted', [m.measured, m.clipped, m.dark, m.total], [2, 1, 0, 3]);

	// A cell in shadow, under 15 % of the grid's median luma, measures noise.
	const shade = { rows: 2, cols: 3, zones: GRID.zones.map((z, i) => (i === 0 ? cell(9000, 900, 1000) : z)) };
	const d = A.measure(shade, { r0: 0, r1: 0, c0: 0, c1: 2 });
	check('a dark cell is left out', d && near(d.value, (blendOf(2000, 200) + blendOf(3000, 300)) / 2), JSON.stringify(d));
	eq('and counted', [d.measured, d.clipped, d.dark, d.total], [2, 0, 1, 3]);
	// The floor is the grid's, not the rectangle's: the same dark cell asked
	// for alone is still dark, not the brightest thing in a one-cell median.
	const alone = A.measure(shade, { r0: 0, r1: 0, c0: 0, c1: 0 });
	check('alone it is still dark, and there is nothing to measure',
		alone && alone.value === null && alone.dark === 1, JSON.stringify(alone));

	const glare = { rows: 2, cols: 3, zones: GRID.zones.map((z) => cell(z[1], z[3], z[4], 3)) };
	const g = A.measure(glare, { r0: 0, r1: 1, c0: 0, c1: 2 });
	check('every cell clipped is null, not zero', g && g.value === null && g.clipped === 6, JSON.stringify(g));

	// Lens cap on: every cell is black, the median is zero, nothing is under
	// it, and the answer is a reading of zero -- a scene, not an absence.
	const black = { rows: 2, cols: 3, zones: GRID.zones.map(() => cell(0, 0, 0)) };
	const b = A.measure(black, { r0: 0, r1: 1, c0: 0, c1: 2 });
	check('a black frame reads zero', b && b.value === 0 && b.measured === 6, JSON.stringify(b));

	const swapped = {
		rows: 1, cols: 2, fields: ['y', 'hlcnt', 'v2', 'h2', 'v1', 'h1'],
		zones: [[10000, 0, 100, 1000, 2, 1], [10000, 0, 200, 2000, 2, 1]],
	};
	const s = A.measure(swapped, { r0: 0, r1: 0, c0: 0, c1: 1 });
	check('fields are read by the grid\'s own names',
		s && near(s.value, (blendOf(1000, 100) + blendOf(2000, 200)) / 2), JSON.stringify(s));

	check('cells off the grid are nothing', A.measure(GRID, { r0: 0, r1: 1, c0: 0, c1: 3 }) === null);
	check('an unusable grid is nothing', A.measure({ rows: 2, cols: 3, zones: [] }, { r0: 0, r1: 0, c0: 0, c1: 0 }) === null);
}

// The map, as preview-focus.js builds it: the group standing in as a stream of
// its own, so mj-region.js's main-to-shown map becomes group-to-shown.
function geomFor(groupWH, streams, shown, decoded) {
	const grid = { stream: -1, frame: groupWH, view: [0, 0, groupWH[0], groupWH[1]] };
	const map = R.view(groupWH, streams.concat([grid]), -1, shown);
	const cur = streams.filter((s) => s.stream === shown)[0];
	return {
		map: map,
		group: { w: groupWH[0], h: groupWH[1] },
		declared: { w: cur.frame[0], h: cur.frame[1] },
		decoded: decoded || { w: cur.frame[0], h: cur.frame[1] },
	};
}

group('a rectangle on the sub stream, the sub stream showing the whole frame');
{
	const G = [2592, 1944];
	const geom = geomFor(G, [
		{ stream: 0, frame: G, view: [0, 0, 2592, 1944] },
		{ stream: 1, frame: [640, 360], view: [0, 0, 2592, 1944] },
	], 1);
	check('the map came back', !!geom.map);
	unitNear('the whole picture is the whole frame',
		A.fromShown({ x: 0, y: 0, w: 640, h: 360 }, geom), { x0: 0, y0: 0, x1: 1, y1: 1 });
	unitNear('a tenth in the middle is a tenth in the middle',
		A.fromShown({ x: 320, y: 180, w: 64, h: 36 }, geom), { x0: 0.5, y0: 0.5, x1: 0.6, y1: 0.6 });
	// WebRTC delivered a smaller picture than the channel declares: the same
	// part of the scene is fewer pixels, and the answer must not move.
	const small = Object.assign({}, geom, { decoded: { w: 320, h: 180 } });
	unitNear('a downscaled decode does not move the rectangle',
		A.fromShown({ x: 160, y: 90, w: 32, h: 18 }, small), { x0: 0.5, y0: 0.5, x1: 0.6, y1: 0.6 });
	const back = A.toShown({ x0: 0.5, y0: 0.5, x1: 0.6, y1: 0.6 }, geom);
	check('and back onto the picture', back && near(back.x, 320) && near(back.y, 180) &&
		near(back.w, 64) && near(back.h, 36), JSON.stringify(back));
	const u = { x0: 0.25, y0: 0.125, x1: 0.75, y1: 0.5 };
	unitNear('a round trip is the identity', A.fromShown(A.toShown(u, geom), geom), u);
}

group('a rectangle on a sub stream cropped from the frame');
{
	// The lower-right quarter of the sensor, at 640x360.
	const G = [2592, 1520];
	const geom = geomFor(G, [
		{ stream: 0, frame: G, view: [0, 0, 2592, 1520] },
		{ stream: 1, frame: [640, 360], view: [1296, 760, 1296, 760] },
	], 1);
	check('the map came back', !!geom.map);
	unitNear('the whole picture is the quarter it shows, not the whole frame',
		A.fromShown({ x: 0, y: 0, w: 640, h: 360 }, geom), { x0: 0.5, y0: 0.5, x1: 1, y1: 1 });
	unitNear('its top-left corner is the middle of the frame',
		A.fromShown({ x: 0, y: 0, w: 64, h: 36 }, geom), { x0: 0.5, y0: 0.5, x1: 0.55, y1: 0.55 });
	const whole = A.toShown({ x0: 0, y0: 0, x1: 1, y1: 1 }, geom);
	check('the whole frame drawn on it runs off the top-left, unclamped',
		whole && near(whole.x, -640) && near(whole.y, -360) && near(whole.w, 1280) && near(whole.h, 720),
		JSON.stringify(whole));
	// The middle column's centre sits exactly on the quarter's left edge, and
	// on the edge is inside: the bottom row from the middle column out.
	eq('cells for that quarter are the lower-right ones',
		A.cells(A.fromShown({ x: 0, y: 0, w: 640, h: 360 }, geom), 2, 3),
		{ r0: 1, r1: 1, c0: 1, c1: 2 });
}

group('the main stream, which is the frame itself');
{
	const G = [2592, 1944];
	const geom = geomFor(G, [
		{ stream: 0, frame: G, view: [0, 0, 2592, 1944] },
	], 0);
	unitNear('pixels are fractions of the frame',
		A.fromShown({ x: 1296, y: 972, w: 259.2, h: 194.4 }, geom), { x0: 0.5, y0: 0.5, x1: 0.6, y1: 0.6 });
}

group('what the camera has not said');
{
	const G = [2592, 1944];
	const geom = geomFor(G, [
		{ stream: 0, frame: G, view: [0, 0, 2592, 1944] },
		{ stream: 1, frame: [640, 360], view: [0, 0, 2592, 1944] },
	], 1);
	check('no map is nothing', A.fromShown({ x: 0, y: 0, w: 10, h: 10 }, Object.assign({}, geom, { map: null })) === null);
	check('no decoded size is nothing', A.fromShown({ x: 0, y: 0, w: 10, h: 10 }, Object.assign({}, geom, { decoded: null })) === null);
	check('a zero-size group is nothing', A.fromShown({ x: 0, y: 0, w: 10, h: 10 }, Object.assign({}, geom, { group: { w: 0, h: 1944 } })) === null);
	check('no rectangle is nothing', A.fromShown(null, geom) === null);
	check('a rectangle of no width is nothing', A.fromShown({ x: 0, y: 0, w: 0, h: 10 }, geom) === null);
	check('a NaN corner is nothing', A.fromShown({ x: NaN, y: 0, w: 10, h: 10 }, geom) === null);
	check('an unusable map from the camera is nothing',
		A.fromShown({ x: 0, y: 0, w: 10, h: 10 }, geomFor(G, [
			{ stream: 1, frame: [640, 360], view: [0, 0, 0, 1944] },
		], 1)) === null);
	check('and the way back refuses the same', A.toShown({ x0: 0, y0: 0, x1: 1, y1: 1 }, Object.assign({}, geom, { map: null })) === null);
}

done();
