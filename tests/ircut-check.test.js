// The IR-cut diagnosis: the decision table, the two colour statistics and the
// probe sequence.
//
// This exists because every part of it fails silently and none of it can be
// reproduced on demand. The decision table renders a confident sentence
// whichever branch it takes, so a wrong branch reads exactly like a right one.
// The statistics produce a plausible number from any frame at all. And the
// probe moves a physical part of the camera — the one bug that matters there is
// a path that forgets to put the filter back, which leaves the camera in the
// state this whole feature exists to warn about, and which you would only find
// by watching a real camera at the moment a fetch happened to fail.
//
// Reproducing any of it for real needs a camera, a filter that moves and
// daylight. Here the frames are built by construction and the I/O is stubbed,
// which is the point.
//
// The thresholds the statistics are compared against were set from a paired
// capture of one scene on a XiongMai 85H50AI, minutes apart, filter open vs
// closed: gmin 1.000 open against 0.03-0.07 closed, magenta excess p25 +0.40
// against -0.11. Those numbers are recorded here rather than the frames — the
// pixels are a picture of somebody's window and this repository is public.
'use strict';

const path = require('path');
const { check, group, done } = require('./assert');

const ic = require(path.join(__dirname, '..', 'www', 'a', 'ircut-check.js'));

// An RGBA buffer of w*h pixels, each filled by px(i) -> [r, g, b].
function frame(w, h, px) {
	const d = new Uint8ClampedArray(w * h * 4);
	for (let i = 0; i < w * h; i++) {
		const c = px(i);
		d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255;
	}
	return d;
}
const flat = (c) => (w, h) => frame(w, h, () => c);
const near = (a, b, eps) => Math.abs(a - b) <= (eps || 1e-9);

const MAGENTA = [200, 40, 190];   // an open filter in daylight, exaggerated
const GREENY = [40, 200, 40];     // an ordinary scene with foliage in it
const GREY = [128, 128, 128];     // colorToGray night

const st = (c, w, h) => ic.stats(flat(c)(w || 20, h || 20), w || 20, h || 20);

// ---------------------------------------------------------------------------
group('stats: green as the valley, and magenta excess');
{
	const m = st(MAGENTA);
	check('magenta puts green at the minimum in every pixel', m.gmin === 1, m.gmin);
	// ((200+190)/2 - 40) / ((200+40+190)/3) = 155 / 143.333…
	check('magenta excess is the brightness-normalised (R+B)/2 - G',
		near(m.mex25, 155 / (430 / 3), 1e-9), m.mex25);

	const g = st(GREENY);
	check('a green frame never has green at the minimum', g.gmin === 0, g.gmin);
	check('a green frame has negative magenta excess', g.mex25 < 0, g.mex25);

	const y = st(GREY);
	check('grey trivially satisfies green-is-the-valley', y.gmin === 1, y.gmin);
	check('grey has exactly zero magenta excess', y.mex25 === 0, y.mex25);
}

group('stats: pixels that carry no colour are not counted');
{
	check('a near-black frame yields no usable pixels', st([10, 10, 10]).n === 0);
	check('a clipped frame yields no usable pixels', st([250, 252, 251]).n === 0);
	check('an empty sample reports zeroes, not NaN',
		st([0, 0, 0]).gmin === 0 && st([0, 0, 0]).mex25 === 0);
	// The gate is on the max channel: a dark pixel with one bright channel is
	// still a colour, and dropping it would bias the statistic toward greys.
	const mixed = ic.stats(frame(20, 20, i => (i < 200 ? [200, 40, 190] : [5, 5, 5])), 20, 20);
	check('only the lit half is counted', mixed.n === 200, mixed.n);
	check('and the verdict comes from that half alone', mixed.gmin === 1, mixed.gmin);
}

group('stats: the percentile describes the whole frame, not its loudest part');
{
	// 30% green, 70% magenta. The 25th percentile sits inside the green run,
	// so a magenta object — even a big one — cannot carry the statistic.
	const mixed = ic.stats(
		frame(20, 20, i => (i < 120 ? GREENY : MAGENTA)), 20, 20);
	check('p25 lands in the green run with 30% green', mixed.mex25 < 0, mixed.mex25);
	check('...while the mean would have been positive', mixed.gmin === 0.7, mixed.gmin);

	// The exact boundary, because it is the one worth knowing: p25 crosses
	// into the magenta run the moment green drops below a quarter of the
	// frame. So the percentile alone survives a magenta object up to 75% and
	// no further, and everything above that is held by gmin instead.
	const at75 = ic.stats(frame(20, 20, i => (i < 100 ? GREENY : MAGENTA)), 20, 20);
	check('at exactly 75% magenta the percentile has crossed', at75.mex25 > 0, at75.mex25);
	check('...and gmin is what refuses it', ic.irLook(at75) === false, at75.gmin);
	// Which sets the real limit on the pair: a magenta object has to cover
	// nine tenths of the picture before both statistics agree, and at that
	// point the frame IS a magenta frame.
	const at89 = ic.stats(frame(20, 20, i => (i < 44 ? GREENY : MAGENTA)), 20, 20);
	check('89% magenta is still refused', ic.irLook(at89) === false, at89.gmin);
	const at90 = ic.stats(frame(20, 20, i => (i < 40 ? GREENY : MAGENTA)), 20, 20);
	check('90% magenta is where the pair finally fires', ic.irLook(at90) === true, at90.gmin);
}

// ---------------------------------------------------------------------------
group('irLook needs BOTH statistics, or a night frame fires it');
{
	check('magenta reads as an open filter', ic.irLook(st(MAGENTA)) === true);
	// The regression this pair of conditions exists for: under colorToGray a
	// night frame is R=G=B, so green is the minimum in 100% of pixels and gmin
	// alone would convict a perfectly healthy camera every night.
	check('a colorToGray night frame does NOT read as an open filter',
		ic.irLook(st(GREY)) === false, st(GREY).gmin);
	check('an ordinary frame does not read as an open filter',
		ic.irLook(st(GREENY)) === false);
	check('an ordinary frame reads as coloured', ic.colourLook(st(GREENY)) === true);
	check('a magenta frame does not read as coloured', ic.colourLook(st(MAGENTA)) === false);
	check('a grey frame reads as neither',
		!ic.irLook(st(GREY)) && !ic.colourLook(st(GREY)));
}

group('irLook refuses to answer from too few pixels');
{
	// 10x10 = 100 usable pixels, below the floor: an almost-dark frame must not
	// be allowed to reach a verdict on a handful of lit pixels.
	const tiny = st(MAGENTA, 10, 10);
	check('100 pixels is below the floor', tiny.n === 100, tiny.n);
	check('and yields no verdict either way',
		!ic.irLook(tiny) && !ic.colourLook(tiny));
}

// ---------------------------------------------------------------------------
group('verdict: four outcomes, and the fourth is "could not look"');
{
	const open = st(MAGENTA), colour = st(GREENY), grey = st(GREY);
	check('closed in day, open at night is correct',
		ic.verdict(colour, open).id === 'ok');
	check('open in day is wired backwards',
		ic.verdict(open, colour).id === 'inverted');
	check('magenta in both positions is stuck open',
		ic.verdict(open, open).id === 'stuck-open');
	check('coloured in both positions is stuck closed',
		ic.verdict(colour, colour).id === 'stuck-closed');
	// Two grey frames differ in nothing measurable. Calling that "stuck" would
	// convict a camera on a test that could not see, which is the one verdict
	// this must never reach.
	check('two mono frames reach no verdict',
		ic.verdict(grey, grey).id === 'unclear');
	check('a dark frame reaches no verdict',
		ic.verdict(st([8, 8, 8]), st([8, 8, 8])).id === 'unclear');
	check('only "ok" is not a fault', ic.verdict(colour, open).level === 'ok' &&
		ic.verdict(open, colour).level === 'danger');
}

// ---------------------------------------------------------------------------
group('probe: the sequence, and which frame was the day one');
{
	const io = (opts) => {
		const log = [];
		const base = {
			log: log,
			snap: function () { log.push('snap'); return Promise.resolve(opts.frames.shift()); },
			toggle: function () { log.push('toggle'); return Promise.resolve(1); },
			wait: function () { log.push('wait'); return Promise.resolve(); },
			settleMs: 0,
		};
		return Object.assign(base, opts.over || {});
	};

	const a = io({ frames: [st(GREENY), st(MAGENTA)] });
	ic.probe(a, 0).then(r => {
		check('starting closed: coloured then magenta is correct wiring',
			r.verdict.id === 'ok', r.verdict.id);
		check('the filter is put back', a.log.join(',') === 'snap,toggle,wait,snap,toggle',
			a.log.join(','));

		// Same two frames, opposite starting position: the SECOND capture is
		// the day one now, so the identical pair must reach the opposite
		// verdict. Reading the order instead of the state is the bug here.
		const b = io({ frames: [st(GREENY), st(MAGENTA)] });
		return ic.probe(b, 1).then(r2 => {
			check('starting open: the same pair is wired backwards',
				r2.verdict.id === 'inverted', r2.verdict.id);
		});
	}).then(() => {
		// A snapshot that fails after the filter has moved is exactly when a
		// naive implementation walks away leaving the camera open.
		const c = io({
			frames: [st(GREENY)],
			over: { snap: null },
		});
		let n = 0;
		c.snap = function () {
			c.log.push('snap');
			return ++n === 1 ? Promise.resolve(st(GREENY))
				: Promise.reject(new Error('camera busy'));
		};
		return ic.probe(c, 0).then(
			() => check('a failed second snapshot must not resolve', false),
			() => {
				check('a failed second snapshot still puts the filter back',
					c.log.join(',') === 'snap,toggle,wait,snap,toggle', c.log.join(','));
			});
	}).then(() => {
		// The mirror image: the toggle itself failed, so nothing moved and a
		// "restore" would be the thing that moves it.
		const d = io({ frames: [st(GREENY)] });
		d.toggle = function () { d.log.push('toggle'); return Promise.reject(new Error('no')); };
		return ic.probe(d, 0).then(
			() => check('a failed toggle must not resolve', false),
			() => check('a toggle that never moved is not "restored"',
				d.log.join(',') === 'snap,toggle', d.log.join(',')));
	}).then(() => {
		const e = io({ frames: [st(GREENY)] });
		e.snap = function () { e.log.push('snap'); return Promise.reject(new Error('no')); };
		return ic.probe(e, 0).then(
			() => check('a failed first snapshot must not resolve', false),
			() => check('a failed first snapshot touches nothing',
				e.log.join(',') === 'snap', e.log.join(',')));
	}).then(runRest);
}

// ---------------------------------------------------------------------------
function runRest() {
	group('diagnose: the missing pin is the headline');
	{
		const f = ic.diagnose({}, null, null);
		check('an empty nightMode reports no-pins', f[0].id === 'no-pins', f[0] && f[0].id);
		check('and reports it as a fault', f[0].level === 'danger');
		check('with nothing to add about a monitor that is off',
			f.filter(x => x.id === 'monitor-blind').length === 0);
	}

	group('diagnose: GPIO 0 is a pin, not an absence');
	{
		// Several XM boards in the wiki use GPIO 0. Testing a pin for
		// truthiness would report a correctly configured camera as broken.
		const f = ic.diagnose({ irCutPin1: 0, irCutPin2: 1 }, null, null);
		check('pin 0 counts as configured',
			f.filter(x => x.id === 'no-pins').length === 0, JSON.stringify(f.map(x => x.id)));
		check('a single-pin board is not a fault either',
			ic.diagnose({ irCutPin1: 8 }, null, null)
				.filter(x => x.id === 'no-pins').length === 0);
	}

	group('diagnose: the light monitor');
	{
		const blind = ic.diagnose({ irCutPin1: 11, lightMonitor: true }, null, null);
		check('a monitor with no sensor and no thresholds is flagged',
			blind.some(x => x.id === 'monitor-blind'));
		check('a monitor with a sensor pin is not',
			!ic.diagnose({ irCutPin1: 11, lightMonitor: true, lightSensorPin: 66 }, null, null)
				.some(x => x.id === 'monitor-blind'));
		check('a monitor with a threshold pair is not',
			!ic.diagnose({ irCutPin1: 11, lightMonitor: true, minThreshold: 1500, maxThreshold: 4000 },
				null, null).some(x => x.id === 'monitor-blind'));
		// A string "true" reaches here from a hand-edited majestic.yaml.
		check('lightMonitor as a string still counts as on',
			ic.diagnose({ irCutPin1: 11, lightMonitor: 'true' }, null, null)
				.some(x => x.id === 'monitor-blind'));
		check('pins wired but no monitor is only an observation',
			ic.diagnose({ irCutPin1: 11 }, null, null)
				.some(x => x.id === 'manual-only' && x.level === 'info'));
	}

	group('diagnose: thresholds need a band, not a point');
	{
		const bad = (lo, hi) => ic.diagnose(
			{ irCutPin1: 11, minThreshold: lo, maxThreshold: hi }, null, null)
			.some(x => x.id === 'thresholds');
		check('min above max is flagged', bad(4000, 1500));
		check('min equal to max is flagged too', bad(2000, 2000));
		check('min below max is fine', !bad(1500, 4000));
		check('one threshold alone says nothing', !bad(1500, undefined));
	}

	group('diagnose: a disagreement is only a fault when the monitor owns both');
	{
		const cfg = { irCutPin1: 11, lightSensorPin: 66, lightMonitor: true };
		const conflicted = { night: 0, ircut: 1 };
		check('day with an open filter, held, is a fault',
			ic.diagnose(cfg, conflicted, { conflictS: 60, flips: 0 })
				.some(x => x.id === 'conflict' && x.level === 'danger'));
		// The heartbeat is 2s, so a disagreement seen once is a filter caught
		// mid-swing, not a fault.
		check('a disagreement seen for a moment is not',
			!ic.diagnose(cfg, conflicted, { conflictS: 4, flips: 0 })
				.some(x => x.id === 'conflict'));
		// With the monitor off every switch on the Live tab is manual, and
		// someone holding the filter open to check an IR lamp is not a bug.
		check('a manual disagreement is never a fault',
			!ic.diagnose({ irCutPin1: 11 }, conflicted, { conflictS: 600, flips: 0 })
				.some(x => x.id === 'conflict'));
		check('night with an open filter agrees',
			!ic.diagnose(cfg, { night: 1, ircut: 1 }, { conflictS: 600, flips: 0 })
				.some(x => x.id === 'conflict'));
		check('day with a closed filter agrees',
			!ic.diagnose(cfg, { night: 0, ircut: 0 }, { conflictS: 600, flips: 0 })
				.some(x => x.id === 'conflict'));
	}

	group('diagnose: hunting, and the ordering of what it all reports');
	{
		const cfg = { irCutPin1: 11, lightSensorPin: 66, lightMonitor: true };
		check('repeated switching is flagged',
			ic.diagnose(cfg, { night: 0, ircut: 0 }, { flips: 3, conflictS: 0 })
				.some(x => x.id === 'hunting'));
		check('two switches in the window is not',
			!ic.diagnose(cfg, { night: 0, ircut: 0 }, { flips: 2, conflictS: 0 })
				.some(x => x.id === 'hunting'));
		const many = ic.diagnose(
			{ lightMonitor: true, minThreshold: 9, maxThreshold: 9 },
			{ night: 0, ircut: 1 }, { flips: 9, conflictS: 600 });
		check('the fault outranks the warnings', many[0].level === 'danger', many[0].level);
		check('and every level is sorted below the one before it',
			many.every((f, i) => i === 0 ||
				({ danger: 3, warning: 2, info: 1 })[f.level] <=
				({ danger: 3, warning: 2, info: 1 })[many[i - 1].level]),
			many.map(x => x.level).join(','));
	}

	group('tracker: durations from the clock, never from a sample count');
	{
		const t = ic.tracker();
		// The heartbeat skips ticks on a busy camera, so counting samples would
		// call a 30s disagreement 6s long, or the reverse.
		t.push({ night: 0, ircut: 1 }, 100);
		check('a disagreement starts at zero', t.push({ night: 0, ircut: 1 }, 100).conflictS === 0);
		check('and is measured off the clock',
			t.push({ night: 0, ircut: 1 }, 140).conflictS === 40);
		check('agreement clears it',
			t.push({ night: 0, ircut: 0 }, 150).conflictS === 0);
		check('and it starts again from there',
			t.push({ night: 1, ircut: 0 }, 160).conflictS === 0 &&
			t.push({ night: 1, ircut: 0 }, 170).conflictS === 10);
	}

	group('tracker: flips age out of the window');
	{
		const t = ic.tracker();
		let r = t.push({ night: 0, ircut: 0 }, 0);
		check('the first sample is not a flip', r.flips === 0);
		[1, 2, 3].forEach(i => { r = t.push({ night: i % 2, ircut: i % 2 }, i * 10); });
		check('three switches inside the window count three', r.flips === 3, r.flips);
		// 300s later the same three are history and must not still be raising
		// an alarm about a dusk that has long since passed.
		r = t.push({ night: 1, ircut: 1 }, 400);
		check('they age out of the window', r.flips === 0, r.flips);
	}

	done();
}
