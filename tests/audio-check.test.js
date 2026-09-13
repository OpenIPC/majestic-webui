// The audio soundcheck: the measurement, the verdict table and the loop that
// chooses a level.
//
// All of it fails silently and none of it can be reproduced on demand. A
// verdict reached from a wrong measurement renders the same confident sentence
// as a right one; a level chosen from a misread buffer is a plausible number;
// and the loop that converges on a good setting would, if it were wrong, simply
// stop somewhere and look finished. Checking any of it for real needs a camera,
// a speaker, a room and somebody listening.
//
// Here the samples are built by construction and every side effect is stubbed.
// The convergence test is the one worth reading: it invents a camera whose gain
// curve the test chooses and the code cannot know, which is the whole claim —
// that the loop lands on a good level by measuring, not by knowing what any
// particular chip does with a number.
'use strict';

const path = require('path');
const { check, group, done } = require('./assert');

const ac = require(path.join(__dirname, '..', 'www', 'a', 'audio-check.js'));

// A sine of `n` samples at peak amplitude `amp`. RMS is amp/sqrt(2), so the
// expected reading is known in closed form and the assertions below are
// arithmetic rather than a recorded number.
function sine(n, amp, freq, rate) {
	const out = new Int16Array(n);
	const f = freq || 1000;
	const sr = rate || 48000;
	for (let i = 0; i < n; i++)
		out[i] = Math.round(amp * Math.sin((2 * Math.PI * f * i) / sr));
	return out;
}

function bytesOf(samples) {
	const b = new Uint8Array(samples.length * 2);
	for (let i = 0; i < samples.length; i++) {
		b[i * 2] = samples[i] & 0xff;
		b[i * 2 + 1] = (samples[i] >> 8) & 0xff;
	}
	return b;
}

group('measure');
{
	const full = sine(4800, 32767);
	const m = ac.measure(full);
	// A full-scale sine reads -3.01 dBFS RMS, which is the one number in this
	// file that is not a choice.
	check('a full-scale sine reads about -3 dBFS',
		Math.abs(m.rmsDb + 3.01) < 0.1, 'got ' + m.rmsDb);
	check('and its peak reads about 0 dBFS', Math.abs(m.peakDb) < 0.1);

	const half = ac.measure(sine(4800, 16384));
	check('halving the amplitude costs 6 dB',
		Math.abs(half.rmsDb - m.rmsDb + 6.02) < 0.1,
		'got ' + (m.rmsDb - half.rmsDb));

	check('an empty buffer is not a reading', ac.measure(new Int16Array(0)) === null);
	check('and neither is nothing at all', ac.measure(null) === null);

	// The distinction the whole file turns on.
	const deadRun = ac.measure(new Int16Array(ac.DEAD_RUN + 10));
	check('a long run of exact zeroes is a dead input', deadRun.dead === true);

	// A genuinely quiet room still wanders, so it must NOT read as dead however
	// low it is — this is the case that would otherwise send somebody looking
	// for a broken microphone because their office is quiet.
	const quiet = new Int16Array(ac.DEAD_RUN * 2);
	for (let i = 0; i < quiet.length; i++) quiet[i] = i % 3 === 0 ? 1 : -1;
	const q = ac.measure(quiet);
	check('a very quiet but live input is not dead', q.dead === false);
	check('and it still reads as very quiet', q.rmsDb < -80, 'got ' + q.rmsDb);

	const clipped = new Int16Array(4800);
	for (let i = 0; i < clipped.length; i++)
		clipped[i] = i % 2 ? 32767 : -32767;
	check('a buffer at the rails is clipping', ac.measure(clipped).clipping === true);
	// A sine that peaks at full scale spends about a eighth of every cycle
	// within a fraction of a dB of the rails, so it counts too — deliberately.
	// One more dB into that camera and it would be flat-topped, which is what
	// the soundcheck is there to stop somebody choosing.
	check('and so does a sine that peaks at full scale', m.clipping === true);
	// With any real headroom it must not, or every loud room would be reported
	// as distorting and the recommendation would walk the level down forever.
	check('a sine with headroom is not clipping',
		ac.measure(sine(4800, 20000)).clipping === false);
	check('nor is one just under the threshold',
		ac.measure(sine(4800, ac.CLIP_LEVEL - 1)).clipping === false);

	// Negative full scale is one louder than positive, and treating it as an
	// overflow is how a clipped buffer starts reading as a quiet one.
	const neg = new Int16Array([-32768, -32768, -32768, -32768]);
	check('negative full scale is a sample, not an overflow',
		ac.measure(neg).peak === 32768);
}

group('samplesFromBytes');
{
	const s = ac.samplesFromBytes(new Uint8Array([0x00, 0x01, 0xff, 0xff, 0x00, 0x80]));
	check('little-endian pairs', s[0] === 256);
	check('and negatives sign-extend', s[1] === -1 && s[2] === -32768);

	const odd = ac.samplesFromBytes(new Uint8Array([0x10, 0x00, 0x7f]));
	check('a trailing half sample is dropped, not invented', odd.length === 1);

	// Round trip, because the browser reads bytes and everything else here
	// speaks samples.
	const orig = sine(512, 20000);
	const back = ac.samplesFromBytes(bytesOf(orig));
	let same = back.length === orig.length;
	for (let i = 0; same && i < orig.length; i++) same = back[i] === orig[i];
	check('samples survive the round trip', same);
}

group('diagnose');
{
	check('no configuration yet is a blocker',
		ac.diagnose(null).blocked === true);
	check('both switches off says so',
		/both/.test(ac.diagnose({ audio: { enabled: false, outputEnabled: false } }).why));

	const noSpk = ac.diagnose({ audio: { enabled: true, outputEnabled: false } });
	check('a speaker switched off blocks the test', noSpk.blocked === true);
	check('and it is the speaker that is named', /speaker/.test(noSpk.why));

	const noMic = ac.diagnose({ audio: { enabled: false, outputEnabled: true } });
	check('a microphone switched off blocks the measurement',
		noMic.blocked === true);
	// The half that still works must not be hidden behind the half that does
	// not, or a camera with no microphone loses a speaker test that would have
	// told its owner something.
	check('but the speaker can still be tested alone', noMic.speakerOnly === true);

	check('with both on there is nothing in the way',
		ac.diagnose({ audio: { enabled: true, outputEnabled: true } }) === null);
}

group('stimulus');
{
	const s = ac.stimulus(48000, 1);
	check('it is as long as it was asked for', s.length === 48000);

	let peak = 0, sum = 0, maxStep = 0;
	for (let i = 0; i < s.length; i++) {
		const a = Math.abs(s[i]);
		if (a > peak) peak = a;
		sum += s[i];
		if (i) {
			const d = Math.abs(s[i] - s[i - 1]);
			if (d > maxStep) maxStep = d;
		}
	}
	// Headroom, so the test sound is not what clips.
	check('it leaves headroom', peak > 0.8 * ac.FULL_SCALE && peak < 0.9 * ac.FULL_SCALE,
		'peak ' + peak);
	check('it carries no DC', Math.abs(sum / s.length) < 1);
	// A phase discontinuity at the join would step by about twice the peak,
	// and that click is louder than the tone it is meant to be measuring.
	check('the tone and the sweep join without a step', maxStep < peak,
		'largest step ' + maxStep + ' against peak ' + peak);
	check('it fades in and out', s[0] === 0 && s[s.length - 1] === 0);

	check('the rate it is built at is the rate it was given',
		ac.stimulus(8000, 2).length === 16000);
}

group('recommend');
{
	const at = (db) => ({ rmsDb: db, dead: false, clipping: false });

	const up = ac.recommend(at(-50), 30);
	check('too quiet asks for more', up.level > 30 && up.done === false);
	const down = ac.recommend(at(-4), 70);
	check('too loud asks for less', down.level < 70 && down.done === false);
	check('in the window is finished',
		ac.recommend(at(ac.TARGET_DBFS), 55).done === true);

	// A clipped reading understates how far over it is, so its own level is not
	// evidence of anything except "too high" — it must go down regardless.
	const clip = ac.recommend({ rmsDb: -30, dead: false, clipping: true }, 80);
	check('clipping goes down even when the level reads quiet', clip.level < 80);

	const dead = ac.recommend({ rmsDb: -Infinity, dead: true }, 40);
	check('a dead input is a failure, not a level to chase',
		dead.failed === true && dead.done === true);

	check('nothing to measure is not a recommendation',
		ac.recommend(null, 40).done === false);

	check('it never asks for a level below the floor',
		ac.recommend(at(-1), 3, { min: 0 }).level >= 0);
	check('or above the ceiling',
		ac.recommend(at(-90), 98, { max: 100 }).level <= 100);
	check('and at the rail with nowhere to go it stops',
		ac.recommend(at(-90), 100, { max: 100 }).done === true);
}

group('the loop converges on a camera whose gain curve it cannot know');
{
	// An invented camera. `k` decibels per level point and an offset, neither
	// of which the code is told — the point is that it finds a good level by
	// measuring, because a real one differs per chip and per board and a page
	// has no way to look it up.
	function camera(k, offset) {
		return function (level) {
			const db = offset + level * k;
			// Above full scale the converter flattens, which is what clipping
			// is; below the floor there is still dither, so it is quiet rather
			// than dead.
			const amp = Math.min(ac.FULL_SCALE, Math.pow(10, db / 20) * ac.FULL_SCALE);
			const s = sine(4800, Math.max(1, Math.round(amp)));
			if (db > 0) for (let i = 0; i < s.length; i++) s[i] = i % 2 ? 32767 : -32767;
			return ac.measure(s);
		};
	}

	// Carries the previous point, which is what lets the step be read off the
	// camera's own curve instead of guessed. The panel does the same.
	function converge(cam, start) {
		let level = start;
		let previous = null;
		for (let i = 0; i < 8; i++) {
			const reading = cam(level);
			const r = ac.recommend(reading, level, { previous: previous });
			if (r.done) return { level: level, rounds: i };
			previous = { level: level, rmsDb: reading.rmsDb };
			level = r.level;
		}
		return { level: level, rounds: 8, gaveUp: true };
	}

	// Three different cameras, and from both ends of the dial on each.
	const curves = [
		{ name: 'a gentle dial', k: 0.6, offset: -75 },
		{ name: 'a steep dial', k: 1.4, offset: -110 },
		{ name: 'a dial with most of its range above the target', k: 0.35, offset: -52 },
		// The one that broke the fixed step on a camera: twelve points moved the
		// reading by 57 dB. A guessed slope oscillates between the rails here.
		{ name: 'a very steep dial, as measured on hardware', k: 4.75, offset: -200 },
	];
	for (const c of curves) {
		const cam = camera(c.k, c.offset);
		for (const start of [0, 100]) {
			const got = converge(cam, start);
			const reading = cam(got.level);
			const inWindow =
				Math.abs(reading.rmsDb - ac.TARGET_DBFS) <= ac.TARGET_WINDOW &&
				!reading.clipping;
			check(
				c.name + ', starting at ' + start + ', lands in the window',
				inWindow && !got.gaveUp,
				'level ' + got.level + ' reads ' + reading.rmsDb.toFixed(1) +
					' dBFS after ' + got.rounds + ' rounds');
		}
	}
}

group('verdict');
{
	const room = (db) => ({ rmsDb: db, dead: false, clipping: false });

	const heard = ac.verdict(room(-55), room(-20));
	check('a clear rise is a working speaker', heard.ok === true);
	check('and it is reported as a success', heard.severity === 'success');

	// The case that matters most: without comparing against the room, a noisy
	// room reads as a working speaker on a camera whose speaker is disconnected.
	const silent = ac.verdict(room(-30), room(-29));
	check('no rise above the room is not a working speaker', silent.ok === false);
	check('and it is a warning, not an error', silent.severity === 'warning');

	const loud = ac.verdict(room(-55), { rmsDb: -8, dead: false, clipping: true });
	check('a speaker heard while overloading still worked', loud.ok === true);
	check('but it is flagged', loud.severity === 'warning');

	const dead = ac.verdict(room(-55), { rmsDb: -Infinity, dead: true });
	check('a dead microphone is an error', dead.ok === false && dead.severity === 'danger');
	check('and it says the speaker was not tested', /not tested/.test(dead.detail));

	const gone = ac.verdict(room(-55), null);
	check('a measurement that stopped is an error, not a verdict',
		gone.ok === false && gone.severity === 'danger');
}

group('probe drives the whole sequence');
(async () => {
	{
		const steps = [];
		let playing = false;
		const res = await ac.probe({
			onStep: (s) => steps.push(s),
			play: async () => {
				playing = true;
				await new Promise((r) => setTimeout(r, 5));
				playing = false;
			},
			listen: async () => {
				// The room is quiet until the sound is playing, which is what
				// the sequence is supposed to arrange.
				const amp = playing ? 3000 : 30;
				await new Promise((r) => setTimeout(r, 1));
				return ac.measure(sine(4800, amp));
			},
		});
		check('it reports its steps in order',
			steps.join(',') === 'quiet,playing,done', steps.join(','));
		check('and reaches a verdict', res.ok === true);
	}

	{
		// The microphone is measured WHILE the sound plays. If the sequence
		// awaited the playing first, the second reading would be of the room
		// after it had finished and every camera would look broken.
		let order = [];
		await ac.probe({
			play: async () => {
				order.push('play-start');
				await new Promise((r) => setTimeout(r, 20));
				order.push('play-end');
			},
			listen: async () => {
				order.push('listen');
				await new Promise((r) => setTimeout(r, 1));
				return ac.measure(sine(4800, 1000));
			},
		});
		check('the second reading is taken before the sound has finished',
			order.indexOf('play-start') < order.lastIndexOf('listen') &&
				order.lastIndexOf('listen') < order.indexOf('play-end'),
			order.join(','));
	}

	{
		const res = await ac.probe({
			play: async () => {
				throw new Error('Audio output is not enabled');
			},
			listen: async () => ac.measure(sine(4800, 100)),
		});
		check('a camera that refused to play says so',
			res.ok === false && res.severity === 'danger');
		check('and repeats what it said', /not enabled/.test(res.detail));
	}

	group('listen');
	{
		const chunks = [bytesOf(sine(1000, 8000)), bytesOf(sine(1000, 8000))];
		let i = 0;
		const m = await ac.listen(async () => chunks[i++] || null, 500);
		check('it joins the chunks it was given', m.samples === 2000);

		check('and nothing arriving is not silence',
			(await ac.listen(async () => null, 50)) === null);
	}

	done();
})();
