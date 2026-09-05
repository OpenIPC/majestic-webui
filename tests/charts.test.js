// charts.js — the shared sparkline and axis-chart primitives, driven against
// two series measured on a real camera.
//
// This file exists because the subject fails SILENTLY and cannot be reproduced
// on demand. A sparkline draws a confident-looking trace whatever its window
// and whatever its scale; nothing reports that the window is too short to hold
// the trend, or that the scale has flattened it to three pixels. Reaching the
// failure needs a camera that is actually leaking, which is how it survived to
// be found by the reporter of OpenIPC/majestic#311 rather than by us: memory
// climbed 50% to 80% in five minutes and the tile drew a horizontal line.
//
// What must hold, in one sentence each: a fixed scale draws a LEVEL, so idle
// drift stays flat and only the window decides whether a real climb is visible;
// an auto scale draws a SHAPE, so idle drift fills the box and the two cameras
// become indistinguishable; `slot` widens a sparkline's span without
// lengthening its path and measures that span in SECONDS, so neither a slow
// poll nor a failed one can stretch it past what it claims, while a caller that
// does not ask draws exactly what it drew before; and the axis caption is
// derived from the window rather than written beside it, so the two cannot
// drift apart.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const SRC = path.join(__dirname, '..', 'www', 'a', 'charts.js');

// A host element with just enough surface for makeSpark/makeChart.
function makeHost(width) {
	return {
		clientWidth: width || 250, style: {}, textContent: '', innerHTML: '',
		_kids: [], appendChild(k) { this._kids.push(k); },
	};
}

function boot() {
	const clock = { t: 0 };
	const node = () => ({
		attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, appendChild() {},
	});
	const sandbox = {
		document: { createElementNS: () => node() },
		performance: { now: () => clock.t * 1000 },
		addEventListener() {}, setTimeout() {}, clearTimeout() {},
		$: () => null, console,
	};
	sandbox.window = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'charts.js' });
	return { MC: sandbox.MjCharts, clock };
}

function series(name) {
	return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')
		.split('\n')
		.filter(l => l.trim() && l.trim()[0] !== '#')
		.map(Number);
}

// Feed a series at the dashboard's 2s poll, moving the clock as the browser
// would — the slotted sparkline reads it, so a test that froze time would
// deal every sample into one slot.
function feed(MC, clock, sparks, vals, step) {
	vals.forEach(v => {
		clock.t += step == null ? 2 : step;
		sparks.forEach(sp => MC.pushSpark(sp, v));
	});
}

// How far the drawn trace travels vertically, read back out of the path the
// sparkline emitted — the same thing an eye judges "is it going up" by.
function travel(sp) {
	const d = sp.line.attrs.d || '';
	const ys = d.split(/[ML]/).filter(s => s.trim())
		.map(s => parseFloat(s.trim().split(/\s+/)[1]));
	if (!ys.length) return 0;
	return Math.max.apply(null, ys) - Math.min.apply(null, ys);
}
function points(sp) {
	return ((sp.line.attrs.d || '').match(/[ML]/g) || []).length;
}

const H = 38;                       // the sparkline's viewBox height
const TILE_PX = 26;                 // .st-tile-spark's real height
const px = units => units / H * TILE_PX;

const CLIMB = series('mem-climb.txt');   // 46.3% -> 82.7% over 5.3 min
const IDLE = series('mem-idle.txt');     // three minutes of a camera at rest

// ── the measurement that started this ───────────────────────────────────────

group('a fixed scale draws a level, and only the window decides what of a trend survives');
{
	const { MC, clock } = boot();

	const shipped = MC.makeSpark(makeHost(), '#000', 0, 100);          // cap 60
	feed(MC, clock, [shipped], CLIMB);
	const shippedPx = px(travel(shipped));

	check('the two-minute window shows only the tail of the climb',
		shipped.ys.length === 60 &&
		Math.abs(Math.min.apply(null, shipped.ys) - CLIMB[CLIMB.length - 60]) < 1e-9,
		'kept ' + shipped.ys.length + ' samples from ' + Math.min.apply(null, shipped.ys).toFixed(1) + '%');

	check('and a 36-point climb comes out under 5px of a 26px tile',
		shippedPx < 5, shippedPx.toFixed(1) + 'px');

	const idle = MC.makeSpark(makeHost(), '#000', 0, 100);
	feed(MC, clock, [idle], IDLE);
	check('a camera at rest draws flat on the same scale, as it should',
		px(travel(idle)) < 0.5, px(travel(idle)).toFixed(2) + 'px');
}
{
	// The window is the fix, not the scale. Same scale, an hour of room.
	const { MC, clock } = boot();
	const hour = MC.makeSpark(makeHost(), '#000', 0, 100, 360, 10);
	feed(MC, clock, [hour], CLIMB);
	const hourPx = px(travel(hour));
	check('holding the whole climb on that same fixed scale more than doubles the travel',
		hourPx > 7, hourPx.toFixed(1) + 'px against the shipped 3.5px');
	check('and it spans the whole climb, newest value live at the end',
		hour.ys[hour.ys.length - 1] === CLIMB[CLIMB.length - 1] &&
		hour.ys[0] < 47, hour.ys[0].toFixed(1) + '% .. ' + hour.ys[hour.ys.length - 1].toFixed(1) + '%');
}
{
	const { MC, clock } = boot();
	const idleHour = MC.makeSpark(makeHost(), '#000', 0, 100, 360, 10);
	feed(MC, clock, [idleHour], IDLE);
	check('the camera at rest is still flat, so the widening invents nothing',
		px(travel(idleHour)) < 0.5, px(travel(idleHour)).toFixed(2) + 'px');
}

group('an auto scale draws a shape, which is why it cannot be the fix here');
{
	const { MC, clock } = boot();
	const idle = MC.makeSpark(makeHost(), '#000', null, null, 360, 10);
	feed(MC, clock, [idle], IDLE);
	const b2 = boot();
	const climb = b2.MC.makeSpark(makeHost(), '#000', null, null, 360, 10);
	feed(b2.MC, b2.clock, [climb], CLIMB);

	check('0.07 points of idle drift fills the whole box',
		px(travel(idle)) > TILE_PX - 0.01, px(travel(idle)).toFixed(1) + 'px');
	check('so a camera at rest and one filling up draw the same height',
		Math.abs(travel(idle) - travel(climb)) < 0.01,
		travel(idle).toFixed(1) + ' vs ' + travel(climb).toFixed(1));
}

// ── `slot`: a wider span, not a longer path — and measured in seconds ───────

group('slot widens the span without lengthening the path');
{
	const { MC, clock } = boot();
	const dense = MC.makeSpark(makeHost(), '#000', 0, 100, 360);
	const slotted = MC.makeSpark(makeHost(), '#000', 0, 100, 360, 10);

	check('a sparkline with nothing pushed draws nothing',
		points(slotted) === 0);

	feed(MC, clock, [dense, slotted], CLIMB);

	// 160 samples 2s apart is 320s, which is 33 ten-second slots.
	check('a ten-second slot over 320s of polling holds 33 points, not 160',
		slotted.ys.length === 33 && dense.ys.length === 160,
		slotted.ys.length + ' against ' + dense.ys.length);
	// A slot is overwritten, not averaged, so the trace is the series read at
	// a lower rate rather than a smoothing of it — and the newest point tracks
	// every push, so the tile is live between slot boundaries.
	check('the newest point is live between boundaries rather than blank until the next one',
		slotted.ys[slotted.ys.length - 1] === CLIMB[CLIMB.length - 1]);

	// The default has to be invisible: every other sparkline in the WebUI
	// passes no slot and must keep drawing exactly what it drew.
	const c = boot();
	const a = c.MC.makeSpark(makeHost(), '#000', 0, 100);
	const b = c.MC.makeSpark(makeHost(), '#000', 0, 100, 60);
	feed(c.MC, c.clock, [a, b], CLIMB);
	check('omitting it is a point per push, capped by count, unchanged',
		a.line.attrs.d === b.line.attrs.d && a.ys.length === 60);
}

// The bug this replaced: slots counted PUSHES, so a window of "an hour" was
// really 1800 successful polls. The dashboard's heartbeat arms its next tick 2s
// after the last one settled and pushes nothing at all for a poll that failed,
// so the trace quietly held more than the hour it claimed — on a widget with no
// axis to admit it with.
group('and it is seconds, so a stalled poll cannot stretch the span past its claim');
{
	const { MC, clock } = boot();
	const sp = MC.makeSpark(makeHost(), '#000', 0, 100, 6, 10);   // 60 seconds

	feed(MC, clock, [sp], new Array(40).fill(50));                // 80s of polling
	check('a full trace holds its cap and no more',
		sp.ys.length === 6, sp.ys.length + ' points');
	check('spanning no more than cap x slot seconds',
		(sp.ks[sp.ks.length - 1] - sp.ks[0]) < 6,
		(sp.ks[sp.ks.length - 1] - sp.ks[0]) * 10 + 's');

	clock.t += 600;                                               // ten dead minutes
	MC.pushSpark(sp, 90);
	check('ten minutes of failed polls leave nothing behind from before them',
		sp.ys.length === 1 && sp.ys[0] === 90,
		sp.ys.length + ' points, newest ' + sp.ys[sp.ys.length - 1]);

	feed(MC, clock, [sp], new Array(15).fill(70));                // 30s more
	check('and the trace refills from the resumed polling alone',
		sp.ys.length === 4 && (sp.ks[sp.ks.length - 1] - sp.ks[0]) < 6,
		sp.ys.length + ' points');
}

// ── the window and its caption ──────────────────────────────────────────────

group('the axis caption is derived from the window, not written beside it');
{
	const { MC } = boot();
	const cap = (win) => {
		const h = makeHost(400);
		const ch = MC.makeChart(h, win == null
			? { h: 40, lo: 0, hi: 10, colors: ['#000'] }
			: { h: 40, lo: 0, hi: 10, colors: ['#000'], win: win });
		MC.pushChart(ch, [1]);
		const m = h.innerHTML.match(/>(-[^<]+)</);
		return m && m[1];
	};
	check('the default still says -2 min, as it always did', cap(null) === '-2 min');
	check('an hour says -1 h', cap(3600) === '-1 h');
	check('the memory panel\'s ladder reads in whole minutes',
		cap(300) === '-5 min' && cap(600) === '-10 min' &&
		cap(1200) === '-20 min' && cap(2400) === '-40 min');
	check('and a window under a minute says seconds', cap(45) === '-45 s');
}

group('hide withholds a line, not a value');
{
	const { MC, clock } = boot();
	const host = makeHost(400);
	const ch = MC.makeChart(host, { h: 40, lo: 0, hi: 10, colors: ['#a1', '#b2'] });
	for (let i = 0; i < 5; i++) { clock.t = i * 10; MC.pushChart(ch, [3, 7]); }
	check('both series draw while nothing is hidden',
		host.innerHTML.indexOf('#a1') >= 0 && host.innerHTML.indexOf('#b2') >= 0);

	ch.cfg.hide = [true, false];
	MC.renderChart(ch);
	check('a hidden series stops being drawn',
		host.innerHTML.indexOf('#a1') < 0 && host.innerHTML.indexOf('#b2') >= 0);
	check('while its samples are still there to be read back',
		ch.pts.length === 5 && ch.pts.every(p => p.v[0] === 3),
		ch.pts.length + ' points');

	ch.cfg.hide = [false, false];
	MC.renderChart(ch);
	check('and unhiding draws the history it kept, not just what came after',
		host.innerHTML.indexOf('#a1') >= 0);
}

group('window and gap are per chart, because not every subject is a subject of now');
{
	const { MC, clock } = boot();
	const wide = makeHost(400), narrow = makeHost(400);
	const chWide = MC.makeChart(wide, {
		h: 40, lo: 0, hi: 10, colors: ['#000'], win: 3600, gap: 30,
	});
	const chNarrow = MC.makeChart(narrow, { h: 40, lo: 0, hi: 10, colors: ['#000'] });

	// Ten minutes of samples, ten seconds apart — the memory panel's cadence.
	for (let i = 0; i < 60; i++) {
		clock.t = i * 10;
		MC.pushChart(chWide, [5]);
		MC.pushChart(chNarrow, [5]);
	}
	check('the wide chart keeps every sample of the ten minutes',
		chWide.pts.length === 60, chWide.pts.length + ' points');
	check('the 2-minute chart has dropped all but its own window',
		chNarrow.pts.length === 13, chNarrow.pts.length + ' points');

	// A hole is relative to how often the caller pushes: 10s apart is normal
	// here and would be an outage on a 2s-paced chart.
	const strokes = html => (html.match(/stroke-width="2"/g) || []).length;
	check('a 10s cadence draws as one unbroken run under a gap that expects it',
		strokes(wide.innerHTML) === 1 &&
		(wide.innerHTML.match(/M/g) || []).length === 2,
		wide.innerHTML.match(/M/g).length + ' subpaths');
	check('and the same samples break the default-gap chart into isolated pieces',
		(narrow.innerHTML.match(/M/g) || []).length > 4);
}

group('a band is what the value is compared against, so the scale has to fit it');
{
	const { MC, clock } = boot();
	// The Day / Night light monitor's shape, measured on an hi3516ev300: gain
	// idling near 1024 while the day and night thresholds sit at 150000 and
	// 160000. Scaled from the data alone the plot topped out at 2000, both
	// bands clamped to the top edge, and the chart drew a flat line in a
	// uniformly tinted box — no answer at all to "how far is this from
	// switching" (#325).
	const bands = [
		{ from: 0, to: 150000, color: 'rgba(47,182,115,.10)', label: 'day' },
		{ from: 160000, to: null, color: 'rgba(255,193,7,.10)', label: 'night' },
	];
	const host = makeHost(400);
	const ch = MC.makeChart(host, { h: 110, lo: 0, hi: null, colors: ['#000'], bands: bands });
	for (let i = 0; i < 3; i++) { clock.t = i * 2; MC.pushChart(ch, [1024]); }
	const ticks = (host.innerHTML.match(/text-anchor="end">([\d.]+)</g) || [])
		.map(t => parseFloat(t.replace(/[^\d.]/g, '')));
	check('the top of the plot clears the night threshold',
		Math.max.apply(null, ticks) >= 160000,
		'top tick ' + Math.max.apply(null, ticks));

	// Both band labels used to be drawn at y1 + 10 whatever the band's drawn
	// height, so two bands clamped to the same edge printed "day" and "night"
	// on the same pixel — one unreadable smudge in the corner.
	const labelY = w => {
		const m = host.innerHTML.match(new RegExp('y="([\\d.]+)"[^>]*>' + w + '<'));
		return m ? parseFloat(m[1]) : null;
	};
	check('and both band names are on the plot, a line apart',
		labelY('day') != null && labelY('night') != null &&
		Math.abs(labelY('day') - labelY('night')) >= 12,
		'day at ' + labelY('day') + ', night at ' + labelY('night'));

	// An open end is not a number: 1e9 as a stand-in for "and above" would be
	// folded into the scale above and push the whole plot off the top.
	check('an open band end is not fitted into the scale',
		Math.max.apply(null, ticks) < 1e6, 'top tick ' + Math.max.apply(null, ticks));

	// The gutter has to hold the numbers it is about to print. At a flat 30px
	// — four monospace characters — a six-digit threshold lost its first two
	// digits off the left edge and read as "0000".
	const gutter = html => {
		const m = html.match(/text-anchor="end">[\d.]+<\/text>/) &&
			html.match(/<text x="([\d.]+)" y="[\d.]+" text-anchor="end">[\d.]+</);
		return m ? parseFloat(m[1]) : null;
	};
	check('the gutter widens for a six-digit axis',
		gutter(host.innerHTML) >= 6 * 6, 'label right edge at ' + gutter(host.innerHTML));
	const small = makeHost(400);
	const ch3 = MC.makeChart(small, { h: 110, lo: 0, hi: 100, colors: ['#000'] });
	MC.pushChart(ch3, [50]);
	check('and a short one still gets the gutter it always had',
		gutter(small.innerHTML) === 25, 'label right edge at ' + gutter(small.innerHTML));

	// A band with no room for its own name does not print it anywhere.
	const tight = makeHost(400);
	const ch2 = MC.makeChart(tight, {
		h: 110, lo: 0, hi: 100, colors: ['#000'],
		bands: [{ from: 99, to: 100, color: '#fff', label: 'sliver' }],
	});
	MC.pushChart(ch2, [50]);
	check('a band squeezed thinner than its label draws no label',
		tight.innerHTML.indexOf('sliver') < 0);
}

done();
