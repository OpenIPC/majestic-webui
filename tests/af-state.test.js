// The autofocus status reducer (www/a/af-state.js).
//
// This earns a test the way preview-chain.js does, on both halves of the rule.
//
// It fails SILENTLY: every branch renders a confident, plausible sentence. A
// page announcing last week's `preempted` as news, attributing a stranger's
// pass to the button you just pressed, or staying mute through a real failure
// all look exactly like a page that is working. Nothing errors.
//
// And it cannot be reproduced on demand: you need a motorized lens, a 40-90 s
// cold pass, a sticky string left by a previous session, a second actor holding
// the port, and the 8 s the engine spends asserting `running` before the motor
// moves. A fixture table holds all of that still.
const { check, done } = require('./assert.js');

// assert.js's check() takes a boolean. These compare, and put the value that
// actually came back in the failure line — a reducer's wrong answer is a
// plausible sentence, so the diff has to be printed to be read.
const eq = (name, got, want) =>
	check(name, got === want, 'got ' + JSON.stringify(got));
const AF = require('../www/a/af-state.js');

// A pass that LANDED on its peak — the attribution cases below are about whose
// pass it was, not how well it went, so they must not trip the quality rule.
// Measured on an 85H50AI.
const DONE = 'done fv=12666 peak=12666 start=10430 mag=2.7 pos=9032 steps=60 path=1';
// Landed on its peak, so the wording under test is the mag note and not
// the stopped-short one.
const DONE_NOMAG = 'done fv=13288 peak=13288 start=10832 mag=-1.0 pos=2610 steps=107 path=1';

// A fresh page on a camera whose last pass was interrupted days ago. The whole
// reason this module exists.
{
	const af = AF.create();
	const r = af.step('preempted', 1000);
	eq('a sticky preempted on load says nothing', r.say, null);
	eq('and does not start polling for it', r.poll, false);
}

{
	const af = AF.create();
	const r = af.step('failed: lens does not respond', 1000);
	eq('a sticky failure on load says nothing', r.say, null);
}

{
	const af = AF.create();
	const r = af.step('idle', 1000);
	eq('idle on load says nothing', r.say, null);
}

// The ordinary operator pass.
{
	const af = AF.create();
	af.observe('idle');
	const t = af.trigger('started', 'idle', 0);
	eq('a press speaks at once', t.say, 'Autofocus…');
	eq('and polls', t.poll, true);
	eq('running is not narrated as motion',
		af.step('running', 1000).say, 'Autofocus…');
	const fin = af.step(DONE, 12000);
	eq('a done we started is ours', fin.say, 'Autofocus finished.');
	eq('and stops the poll', fin.poll, false);
}

// `restarted` is what a second press produces. The CGI used to report it as
// "engine did not answer" — a working autofocus described as a dead one.
{
	const af = AF.create();
	const t = af.trigger('restarted', 'running', 0);
	eq('restarted reads exactly like started', t.say, 'Autofocus…');
	eq('restarted keeps polling', t.poll, true);
}

// `busy` is af_trigger's -1 — the engine unavailable or shutting down. It is
// NOT "a pass is already running": a trigger that lands on a running pass
// answers `restarted` and preempts it. Saying "already running" described a
// state this reply never means, and put a standing sentence over the picture
// for a press that did nothing.
{
	const af = AF.create();
	const t = af.trigger('busy', 'running', 0);
	eq('busy claims nothing', t.say, null);
	eq('and starts no watch', t.poll, false);
	eq('and arms no generation', af.armed(), null);
}

{
	const af = AF.create();
	const t = af.trigger('unavailable', 'idle', 0);
	eq('unavailable is the one answer that withdraws the control',
		t.withdraw, true);
}

{
	const af = AF.create();
	const t = af.trigger('', 'idle', 0);
	eq('a request that did not get through is not a hardware verdict',
		t.say, 'The camera did not answer.');
	check('and withdraws nothing', !t.withdraw);
}

// An instant failure never reaches `running`. The operator path must still
// accept it — it differs from the baseline, and the trigger reply is the link.
{
	const af = AF.create();
	af.trigger('started', 'idle', 0);
	const r = af.step('failed: focus port is not open', 500);
	eq('an instant failure is attributed on the operator path',
		r.say, 'The camera could not open the focus motor’s serial port.');
	eq('a failure stands until something replaces it', r.sticky, true);
}

// The after-zoom pass has no trigger reply, so the same instant failure could
// equally be the residue of the previous pass. It must NOT be claimed.
{
	const af = AF.create();
	af.zoomReleased('failed: focus port is not open', 0);
	const r = af.step('failed: focus port is not open', 500);
	eq('after-zoom will not claim a terminal it never saw run', r.say, null);
	eq('but keeps watching inside its budget', r.poll, true);
}

{
	const af = AF.create();
	af.zoomReleased('idle', 0);
	eq('a booked pass names itself as one',
		af.step('running', 1500).say, 'Autofocus after zoom…');
	eq('and reports its end',
		af.step(DONE, 14000).say, 'Autofocus finished.');
}

// A held button drives the status to `preempted` for as long as it is down.
{
	const af = AF.create();
	af.trigger('started', 'idle', 0);
	af.step('running', 500);
	af.manual('near', 1000);
	const held = af.step('preempted', 1200);
	eq('a held button is not an outcome', held.say, null);
	eq('and the watch continues', held.poll, true);
	af.release();
	eq('the release reports the cancel',
		af.step('preempted', 2000).say, 'Autofocus cancelled.');
}

// A manual FOCUS move cancels the booking a zoom made, so there is no pass
// coming and nothing to wait for.
{
	const af = AF.create();
	af.zoomReleased('idle', 0);
	af.manual('near', 100);
	af.release();
	eq('a manual focus disarms the zoom booking', af.armed(), null);
	eq('and the page goes quiet', af.step('preempted', 200).say, null);
}

// A zoom during our own pass is a handoff, not a failure.
{
	const af = AF.create();
	af.trigger('started', 'idle', 0);
	af.step('running', 500);
	af.manual('tele', 1000);
	af.release();
	eq('a zoom keeps the generation rather than blaming anyone',
		af.armed(), 'operator');
}

// Someone else interrupted a pass we were watching.
{
	const af = AF.create();
	af.trigger('started', 'idle', 0);
	af.step('running', 500);
	const r = af.step('preempted', 3000);
	eq('an interruption with no cause of ours assigns no blame',
		r.say, 'Autofocus was interrupted.');
}

// The long-search disclosure.
{
	const af = AF.create();
	af.trigger('started', 'idle', 0);
	eq('a short wait is not explained away',
		af.step('running', 5000).say, 'Autofocus…');
	eq('a long one states what it is doing',
		af.step('running', 30000).say,
		'Autofocus… (searching the full range)');
}

// A pass that ends far below the peak it found has not finished, whatever the
// word says. These two lines are real, measured back to back on an 85H50AI.
{
	// Two failure shapes, both measured on an 85H50AI and both "I pressed
	// Autofocus and the picture got blurry". The first sweeps past a good peak
	// and parks a quarter below it. The second gives up early on a peak that
	// was never as sharp as where it began — 99% of its own peak, and a fifth
	// blurrier than before the press, so a peak-only test calls it a success.
	const COLD = 'done fv=9427 peak=13050 start=10809 mag=-1.0 pos=3260 steps=113 path=2';
	const GAVE_UP = 'done fv=9612 peak=9688 start=12045 mag=-1.0 pos=2450 steps=28 path=2';
	const TRACK = 'done fv=12490 peak=12490 start=11990 mag=2.7 pos=8952 steps=62 path=1';
	const af = AF.create();
	af.trigger('started', 'idle', 0);
	af.step('running', 500);
	const bad = af.step(COLD, 53000);
	check('a pass that parked below its own peak is not reported as success',
		/stopped short/.test(bad.say), bad.say);
	// The remedy has to match the state. With the zoom position unknown, five
	// passes in a row took the full-range path and every one stopped short, so
	// "press again" is not a fix — it is another 50 seconds of the same. A
	// single zoom is what makes the MCU report the position, and the search
	// settles after that.
	check('with the zoom position unknown it sends you to the zoom, not the button',
		/zoom/.test(bad.say) && !/Press Autofocus again/.test(bad.say), bad.say);

	const af3 = AF.create();
	af3.trigger('started', 'idle', 0);
	af3.step('running', 500);
	const worse = af3.step(GAVE_UP, 50000);
	check('a pass that ended blurrier than it began is caught too, ' +
		'though it sat on its own peak',
		/stopped short/.test(worse.say), worse.say);

	// Same shortfall, but the lens HAS reported its zoom: here the seeded path
	// is reachable and pressing again is the real remedy.
	const SHORT_KNOWN = 'done fv=9474 peak=12864 start=7733 mag=2.7 pos=6880 steps=122 path=2';
	const af4 = AF.create();
	af4.trigger('started', 'idle', 0);
	af4.step('running', 500);
	const known = af4.step(SHORT_KNOWN, 45000);
	check('with the zoom position known it says to press again',
		/Press Autofocus again/.test(known.say), known.say);

	const af2 = AF.create();
	af2.trigger('started', 'idle', 0);
	af2.step('running', 500);
	eq('a pass that landed on its peak is plainly finished',
		af2.step(TRACK, 8000).say, 'Autofocus finished.');
}

// mag=-1.0 is why autofocus is slow on that camera, and it is said once.
{
	const af = AF.create();
	af.trigger('started', 'idle', 0);
	af.step('running', 500);
	const first = af.step(DONE_NOMAG, 9000);
	check('a lens with no zoom report explains itself',
		/searches the whole range/.test(first.say), first.say);
	af.trigger('started', 'idle', 20000);
	af.step('running', 20500);
	const second = af.step(DONE_NOMAG, 30000);
	eq('but only once a session', second.say, 'Autofocus finished.');
}

// A pass that never ENDS has to be bounded too. `running` used to return
// before the budget check, so an engine stuck in it left "searching the full
// range" on the picture for as long as the page stayed open — a progress
// message with no terminating case, which is exactly what an autofocus that
// never converges looks like from the outside.
{
	const af = AF.create({ budgetMs: 1000 });
	af.trigger('started', 'idle', 0);
	eq('a running pass inside the budget keeps polling',
		af.step('running', 500).poll, true);
	const r = af.step('running', 2000);
	eq('past it, the page stops claiming a search is under way', r.poll, false);
	check('and names the lens as the suspect',
		/still searching/.test(r.say), r.say);
	eq('a standing fault is not swept away by a timer', r.sticky, true);
	eq('and the generation is over', af.armed(), null);
}

// Budget expiry must never read as success.
{
	const af = AF.create({ budgetMs: 1000 });
	af.trigger('started', 'idle', 0);
	const r = af.step('idle', 2000);
	eq('a pass that never reported is not a pass that worked',
		r.say, 'Autofocus did not report a result.');
	eq('and the watch ends', r.poll, false);
}

done();
