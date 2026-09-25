// Focus by ear: the sound grammar (www/a/focus-ear.js).
//
// Earns a test on both halves of the rule. It fails SILENTLY: every wrong
// answer is a plausible sound -- a held tone on a soft lens, a chime on every
// step of a climb, a beep that outlives the reading it came from -- and none of
// them errors. And it cannot be reproduced on demand: it needs a lens turned by
// hand through focus at a steady pace, twice, with the camera answering and
// then not. A shaped series holds all of that still.
const { check, done } = require('./assert.js');
const Ear = require('../www/a/focus-ear.js');
const K = Ear.K;

const eq = (name, got, want) =>
	check(name, got === want, 'got ' + JSON.stringify(got));

// A lens swept through focus at a steady pace: a bell over the sweep, sampled
// at the poll cadence. Not a capture; the shape is what matters.
function bell(n, peak, centre, width) {
	const out = [];
	for (let i = 0; i < n; i++)
		out.push(peak * Math.exp(-Math.pow((i - centre) / width, 2)));
	return out;
}
// Deterministic jitter of about +-0.5 %, the size measured on a static scene.
function jitter(v, i) { return v * (1 + 0.005 * Math.sin(i * 12.9898)); }

// Feed a series at the poll cadence, with the scheduler's 50 ms ticks between
// readings, and keep every output. Returns { outs, t } with t the clock after.
function run(ear, series, t0, opts) {
	const outs = [];
	let t = t0;
	for (let i = 0; i < series.length; i++) {
		const v = opts && opts.jitter ? jitter(series[i], i) : series[i];
		outs.push(ear.step(v, t));
		for (let k = 50; k < K.POLL_MS; k += 50) outs.push(ear.tick(t + k));
		t += K.POLL_MS;
	}
	return { outs: outs, t: t };
}
const cues = (outs, kind) => outs.filter((o) => o.cue === kind).length;
const anyHeld = (outs) => outs.some((o) => o.continuous);

// What the camera answers.
{
	eq('an empty body is absent', Ear.readValue(''), null);
	eq('so is whitespace', Ear.readValue(' \n'), null);
	eq('a bare number reads', Ear.readValue('6318'), 6318);
	eq('so does the metric line itself', Ear.readValue('isp_afmetrics 6318\n'), 6318);
	eq('zero is a reading, a black scene, not absence', Ear.readValue('0'), 0);
	eq('a negative is how a chip says it has no statistic', Ear.readValue('-1'), null);
	eq('text is absent', Ear.readValue('abc'), null);
	eq('and so is Infinity', Ear.readValue('Infinity'), null);
	eq('and a non-string', Ear.readValue(undefined), null);
}

// The everyday sweep: through the peak, hear the low note, turn back, hold.
{
	const ear = Ear.create();
	const up = bell(81, 10000, 40, 12);
	const first = run(ear, up, 0);
	const atStep = (i) => first.outs[i * 4];   // outputs are step, tick, tick, tick
	// The reference is the best so far, so a first climb IS the best so far at
	// every step: fast and high all the way up, and the news arrives the
	// moment the lens goes past -- slower and lower.
	check('a first climb is fast beeps throughout',
		atStep(10).rate >= K.RATE_HI - 0.01 && atStep(30).rate >= K.RATE_HI - 0.01,
		atStep(10).rate + ', ' + atStep(30).rate);
	check('past the peak the beeps slow down',
		atStep(60).rate < atStep(45).rate,
		atStep(45).rate + ' -> ' + atStep(60).rate);
	check('and drop in pitch',
		atStep(60).pitch < atStep(45).pitch,
		atStep(45).pitch + ' -> ' + atStep(60).pitch);
	const climb = first.outs.slice(0, 41 * 4);
	check('the tone is never held before the peak has been passed',
		!anyHeld(climb), climb.filter((o) => o.continuous).length + ' held outputs');
	eq('no chime on a first climb, however many new bests', cues(first.outs, 'best'), 0);
	eq('one low note after going past the peak', cues(first.outs, 'past'), 1);
	check('the low note comes after the peak, not before',
		first.outs.findIndex((o) => o.cue === 'past') > 40 * 4, '');
	check('and still no held tone on the far side', !anyHeld(first.outs), '');

	// Turn back onto the peak and stay there.
	const back = up.slice(0, 81).reverse().slice(0, 41);   // from the far end to the peak
	const hold = new Array(20).fill(10000);
	const second = run(ear, back.concat(hold), first.t, { jitter: true });
	check('coming back, the beeps speed up again',
		second.outs[36 * 4].rate > second.outs[20 * 4].rate &&
		second.outs[20 * 4].rate > second.outs[5 * 4].rate,
		second.outs[5 * 4].rate + ' -> ' + second.outs[20 * 4].rate + ' -> ' + second.outs[36 * 4].rate);
	check('back on the peak, the tone holds', anyHeld(second.outs), '');
	const firstHeld = second.outs.findIndex((o) => o.continuous);
	check('but only once the reading has sat flat there',
		firstHeld >= (back.length - 3) * 4, 'held at output ' + firstHeld + ' of ' + back.length * 4);
	const held = second.outs.slice(firstHeld);
	check('and stays held through the jitter of a static scene',
		held.every((o) => o.continuous), held.filter((o) => !o.continuous).length + ' drops');
	eq('the held tone has the phase word for it', held[0].phase, 'peak');
	// Past it again, the other way.
	const third = run(ear, bell(81, 10000, 40, 12).slice(41, 71), second.t);
	check('leaving the peak releases the tone',
		third.outs.some((o) => !o.continuous), '');
	eq('and says so once more', cues(third.outs, 'past'), 1);
}

// A climb that stops short of the peak: fast beeps, never a held tone. The
// installer stopped somewhere, and the honest answer is "still improving".
{
	const ear = Ear.create();
	const up = bell(81, 10000, 40, 12).slice(0, 31);
	const r1 = run(ear, up, 0);
	const r2 = run(ear, new Array(25).fill(up[30]), r1.t, { jitter: true });
	check('fast beeps at the top of the climb so far',
		r2.outs[r2.outs.length - 1].rate >= K.RATE_HI - 0.01, String(r2.outs[r2.outs.length - 1].rate));
	check('but never a held tone', !anyHeld(r1.outs) && !anyHeld(r2.outs), '');
}

// Noise on a static scene, after a confirmed peak: nothing flaps, nothing chimes.
{
	const ear = Ear.create();
	const up = bell(81, 10000, 40, 12);
	let r = run(ear, up, 0);
	r = run(ear, up.slice(0, 81).reverse().slice(0, 41), r.t);
	r = run(ear, new Array(15).fill(10000), r.t, { jitter: true });
	check('(setup) the tone is held', anyHeld(r.outs), '');
	const still = run(ear, new Array(300).fill(10000), r.t, { jitter: true });
	eq('sixty seconds of jitter chime nothing', cues(still.outs, 'best'), 0);
	eq('and say past nothing', cues(still.outs, 'past'), 0);
	check('and the tone never drops',
		still.outs.every((o) => o.continuous), still.outs.filter((o) => !o.continuous).length + ' drops');
}

// A re-zoom by hand: the old best is unreachable now.
{
	const ear = Ear.create();
	const up = bell(81, 10000, 40, 12);
	let r = run(ear, up, 0);
	r = run(ear, up.slice(0, 81).reverse().slice(0, 41), r.t);
	r = run(ear, new Array(15).fill(10000), r.t);
	check('(setup) held on the first peak', anyHeld(r.outs), '');
	// The zoom ring moved: a new scene whose best is six tenths of the old.
	const low = bell(81, 6000, 40, 12);
	let s = run(ear, low, r.t);
	s = run(ear, low.slice(0, 81).reverse().slice(0, 41), s.t);
	s = run(ear, new Array(15).fill(6000), s.t, { jitter: true });
	check('without a reset the tone never holds on the lower peak', !anyHeld(s.outs), '');
	ear.reset(s.t);
	let u = run(ear, low, s.t);
	u = run(ear, low.slice(0, 81).reverse().slice(0, 41), u.t);
	u = run(ear, new Array(15).fill(6000), u.t, { jitter: true });
	check('after Start over it does', anyHeld(u.outs), '');
}

// The automatic re-base: far below the best for long enough is a new scene.
{
	const ear = Ear.create();
	const up = bell(81, 10000, 40, 12);
	let r = run(ear, up, 0);
	r = run(ear, up.slice(0, 81).reverse().slice(0, 41), r.t);
	r = run(ear, new Array(10).fill(10000), r.t);
	const farN = Math.ceil(K.FAR_RESET_MS / K.POLL_MS) + 5;
	const far = run(ear, new Array(farN).fill(2500), r.t, { jitter: true });
	check('under half the best for fifteen seconds re-bases the reference',
		ear.state().best < 4000, 'best=' + ear.state().best);
	const small = bell(81, 4200, 40, 12);
	let v = run(ear, small, far.t);
	v = run(ear, small.slice(0, 81).reverse().slice(0, 41), v.t);
	v = run(ear, new Array(15).fill(4200), v.t, { jitter: true });
	check('and the next peak, lower than the old one, can be held', anyHeld(v.outs), '');
}

// A lens parked far away for long -- an autofocus pass sits at its end stop
// for twenty seconds -- then brought back onto the SAME peak. The re-base must
// not have thrown the peak away: the tone holds without a second confirmation.
{
	const ear = Ear.create();
	const up = bell(81, 10000, 40, 12);
	let r = run(ear, up, 0);
	r = run(ear, up.slice(0, 81).reverse().slice(0, 41), r.t);
	r = run(ear, new Array(15).fill(10000), r.t);
	check('(setup) held', anyHeld(r.outs), '');
	const parkN = Math.ceil(K.FAR_RESET_MS / K.POLL_MS) + 25;
	const park = run(ear, new Array(parkN).fill(100), r.t, { jitter: true });
	check('(setup) the reference was re-based while parked', ear.state().best < 200, 'best=' + ear.state().best);
	const back = up.slice(0, 41);   // a climb from the far end straight onto the peak
	let v = run(ear, back, park.t);
	v = run(ear, new Array(15).fill(10000), v.t, { jitter: true });
	check('back on the peak it found before, the tone holds', anyHeld(v.outs), '');
	eq('and no chime, it is the same peak', cues(v.outs, 'best'), 0);
}

// The chime: a genuinely higher peak after one you turned back from.
{
	const ear = Ear.create();
	const up = bell(81, 10000, 40, 12);
	let r = run(ear, up, 0);
	r = run(ear, up.slice(0, 81).reverse().slice(0, 41), r.t);
	r = run(ear, new Array(10).fill(10000), r.t);
	const higher = bell(81, 13000, 40, 12);
	const h = run(ear, higher, r.t);
	eq('a higher peak after a confirmed one chimes once', cues(h.outs, 'best'), 1);
}

// Absent and stale.
{
	const ear = Ear.create();
	const a = ear.step(null, 0);
	eq('an absent reading is its own phase', a.phase, 'absent');
	eq('with no sound', a.rate, 0);
	eq('and no held tone', a.continuous, false);
}
{
	const ear = Ear.create();
	const r = run(ear, bell(81, 10000, 40, 12).slice(0, 20), 0);
	check('(setup) beeping', r.outs[r.outs.length - 1].rate > 0, '');
	const s1 = ear.tick(r.t + 300);
	check('a reading 500 ms old still sounds', s1.rate > 0, String(s1.rate));
	const s2 = ear.tick(r.t + 800);
	eq('one 1000 ms old is stale', s2.phase, 'stale');
	eq('and silent', s2.rate, 0);
	eq('with the lost cue', s2.cue, 'lost');
	eq('said once', ear.tick(r.t + 900).cue, null);
	const b = ear.step(9000, r.t + 1000);
	check('a returning reading sounds again', b.rate > 0, String(b.rate));
	const s3 = ear.tick(r.t + 1000 + 2000);
	eq('and the next outage is said again', s3.cue, 'lost');
}

// Beep timing.
{
	const out = { rate: 4, pitch: 1000, continuous: false };
	const p = Ear.plan(out, 0, 5, null);
	eq('five seconds at 4 Hz is twenty beeps', p.events.length, 20);
	check('250 ms apart',
		p.events.every((e, i) => i === 0 || Math.abs(e.at - p.events[i - 1].at - 0.25) < 1e-9), '');
	check('none longer than the cap', p.events.every((e) => e.ms <= K.BEEP_MAX_MS), '');
	eq('the cursor carries the next beep', p.cursor.nextBeepAt, 5);
	const q = Ear.plan({ rate: 8, pitch: 1500, continuous: false }, 5, 6, p.cursor);
	eq('a rate change keeps the spacing, no double beep', q.events[0].at, 5);
	eq('and runs at the new rate', q.events.length, 8);
	const h = Ear.plan({ rate: 8, pitch: 1500, continuous: true }, 6, 7, q.cursor);
	eq('a held tone is one event', h.events.length, 1);
	eq('of the holding kind', h.events[0].kind, 'hold');
	eq('and the cursor says so', h.cursor.holding, true);
	const z = Ear.plan({ rate: 0, pitch: null, continuous: false }, 7, 8, h.cursor);
	eq('silence plans nothing', z.events.length, 0);
	eq('and lets go of the hold', z.cursor.holding, false);
	const late = Ear.plan(out, 10, 10.5, { nextBeepAt: 3, holding: false });
	eq('a cursor from the past beeps now rather than catching up', late.events[0].at, 10);
}

done();
