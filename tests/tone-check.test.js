// The automatic-tuning sentence and the knob comparison behind it.
//
// Here for the reason ircut-check's table is: every branch renders a
// confident sentence, so a wrong branch reads exactly like a right one, and
// reaching most of them on a real camera needs weather. "Nothing to do — the
// picture already uses the range it has" is what a reader sees when the
// controller has in fact stood down for low light, and nothing else on the
// page contradicts it.
//
// The gauge values below are measured ones rather than invented: a scene
// already using its range, the same scene flattened, and one carrying both
// deep shade and full sun at once. That last combination is the one a made-up
// fixture never has — wide and clipping at the same time — and it is exactly
// the case a controller watching span alone gets wrong.
'use strict';

const path = require('path');
const { check, group, done } = require('./assert');

const tc = require(path.join(__dirname, '..', 'www', 'a', 'tone-check.js'));

// The settings page's answer for a saved key. Undefined for a key the page
// does not carry, which is a case the comparison has to survive.
function savedFrom(map) {
	return (dot) => (dot in map ? map[dot] : null);
}

const STOCK = savedFrom({
	'isp.dehaze': 125,
	'image.contrast': 50,
	'image.luminance': 50,
	'image.saturation': 50,
});

group('tone-check: off, and the three ways of not knowing');

// With the feature switched off the camera publishes none of these gauges.
// Absent gauges are therefore ambiguous on their own, and the switch — which
// the settings page knows independently — is what resolves them. Getting this
// wrong prints a confident "Off" beside a lit Automatic chip.
{
	const d = tc.describe(null, STOCK, false);
	check('no sample, switch off: definitely off',
		d.on === false && d.known === true && d.head === 'Off');
	check('and claims no knob has moved', d.moved.length === 0);
	check('and is not claiming to measure anything', d.measuring === false);
}
{
	const d = tc.describe({ state: null, span: null }, STOCK, false);
	check('a sample with no state and the switch off is off',
		d.on === false && d.known === true && d.head === 'Off');
}
{
	// A build that has the feature and does not publish these metrics. It is
	// ON — the switch says so — and this page cannot say what it is doing.
	// The one answer that must never appear here is "Off".
	const d = tc.describe({ state: null }, STOCK, true);
	check('switch on but no state gauge is not reported as off',
		d.head !== 'Off');
	check('it is reported as unanswered', d.known === false);
	check('and warns rather than reassuring', d.tone === 'warn');
}
{
	// The page has not worked out the switch yet. Saying either thing would
	// be a guess, so it says nothing and the caller hides the row.
	const d = tc.describe({ state: null }, STOCK, null);
	check('an unknown switch yields nothing to render', d.known === false);
	check('and no sentence to render it with', d.head === '');
}

group('tone-check: running and idle');

// A scene already using 195 of the 255 available, nothing clipped: the
// correct action is none, and the panel has to say so without sounding like
// the feature is broken.
{
	const d = tc.describe({
		state: 1, headroom: 100, span: 195, clipLo: 0, clipHi: 0,
		dehaze: 125, contrast: 50, luminance: 50, saturation: 50,
	}, STOCK, true);
	check('idle is on', d.on === true);
	check('idle says the picture is fine', d.head === 'Picture is fine');
	check('and that there is nothing to do', d.tail === 'nothing to do');
	// The span is a FIGURE, not a clause: figures() prints it under this
	// sentence with a label, and a number in both places is furniture.
	check('and leaves the span to the figure row', d.tail.indexOf('195') < 0);
	check('idle is a quiet tone', d.tone === 'ok');
	check('no knob is held away from the operator', d.moved.length === 0);
}

group('tone-check: working');

// The same scene flattened by a low contrast baseline, caught mid-ramp:
// dehaze and saturation lifted, contrast not yet.
{
	const s = {
		state: 2, headroom: 100, span: 88, clipLo: 0, clipHi: 0,
		dehaze: 189, contrast: 22, luminance: 42, saturation: 67,
	};
	const saved = savedFrom({
		'isp.dehaze': 125, 'image.contrast': 22,
		'image.luminance': 42, 'image.saturation': 50,
	});
	const d = tc.describe(s, saved);
	check('working says what it is improving', d.head === 'Improving a flat picture');
	check('working is an active tone', d.tone === 'work');
	// The two that actually differ from the operator's saved values, and not
	// the two that match them — a panel that lists all four teaches the
	// reader that the controller is fighting knobs it has not touched.
	check('names only the knobs that moved',
		d.moved.length === 2 &&
		d.moved.map(m => m.key).sort().join(',') === 'dehaze,saturation');
	// The moved settings are the reason, not the instruction: behind the "?"
	// (#581), with their live values, while the first line says to leave it.
	check('the reason names them with their live values',
		d.why.indexOf('dehaze 189') >= 0 && d.why.indexOf('saturation 67') >= 0);
	check('and the first line keeps them out of the way', d.tail === 'nothing to do');
	check('and carries the baseline it compared against',
		d.moved[0].base === 125 && d.moved[0].live === 189);
}

// Working before anything has been actuated: every knob still equals its
// baseline. The sentence must still say something, rather than trail off
// after the dash.
{
	const d = tc.describe({
		state: 2, headroom: 100, span: 71, clipLo: 0, clipHi: 0,
		dehaze: 125, contrast: 50, luminance: 50, saturation: 50,
	}, STOCK, true);
	check('working with nothing moved still has a tail', d.tail.length > 0);
	check('and does not fall back to quoting the span', d.tail.indexOf('71') < 0);
}

group('tone-check: the two standing-down states');

// Deep shade and full sun in one frame: span 210, and 4.07% of the picture
// already crushed. The controller stops rather than trade shadows for range.
//
// The reader needs to know that nothing more is coming, and NOT to be handed
// "stretching further would clip — 4.1% crushed and 0.6% blown", which reads
// as a fault report, names its failure mode in jargon, and quotes two shares
// against budgets this page does not hold. The picture is as good as this
// scene allows, and the two shares are figures with labels.
{
	const d = tc.describe({
		state: 3, headroom: 100, span: 210, clipLo: 40670, clipHi: 6291,
		dehaze: 125, contrast: 50, luminance: 50, saturation: 50,
	}, STOCK, true);
	check('holding says it is as good as the scene gets', d.head === 'As good as this scene gets');
	check('holding is not dressed as a fault', d.tone === 'ok');
	check('and that there is nothing to do', d.tail === 'nothing to do');
	check('with the reason in plain words behind the "?"',
		d.why.indexOf('detail') >= 0);
	check('and quotes neither clipping share',
		d.tail.indexOf('4.1') < 0 && d.tail.indexOf('0.6') < 0 &&
		d.tail.indexOf('%') < 0);
}
{
	const d = tc.describe({
		state: 4, headroom: 20, span: 96, clipLo: 0, clipHi: 0,
		dehaze: 125, contrast: 50, luminance: 50, saturation: 50,
	}, STOCK, true);
	check('low light says so', d.head === 'Too dark to improve');
	check('low light warns -- it is the state where it cannot help',
		d.tone === 'warn');
	// The one state with something to do, and the thing to do is light:
	// what #581 asked for, "Too dark -- turn on the lamp or Night mode".
	check('and says what to do about it',
		/Night mode/.test(d.tail) && /lamp/.test(d.tail));
	check('with the mechanism behind the "?", not in the first line',
		d.why.indexOf('noise') >= 0 && d.tail.indexOf('noise') < 0 &&
		d.tail.indexOf('20%') < 0);
}
{
	const d = tc.describe({
		state: 0, headroom: null, span: null, clipLo: null, clipHi: null,
		dehaze: 125, contrast: 50, luminance: 50, saturation: 50,
	}, STOCK, true);
	// On with no measurement is NOT the same as idle, and must not be
	// softened into it: a camera whose sampling source never answers sits
	// here for ever.
	check('no reading is distinguished from idle', d.head === 'No reading');
	check('and warns rather than reassures', d.tone === 'warn');
}

group('tone-check: paused while somebody adjusts by hand');

// Nothing is sampled during a hold, so every gauge freezes at its last
// value. It is its own state precisely so the page stops presenting those as
// current — otherwise the panel states a span from minutes ago as the
// picture's own, with every number in the sentence real and none of it true
// any more.
{
	const d = tc.describe({
		state: 5, headroom: 100, span: 90, clipLo: 0, clipHi: 0,
		dehaze: 125, contrast: 50, luminance: 50, saturation: 50,
	}, STOCK, true);
	check('paused is on', d.on === true);
	check('paused says it is paused', d.head === 'Paused');
	check('and quotes no measurement at all',
		d.tail.indexOf('90') < 0 && d.tail.indexOf('span') < 0);
	check('paused is not dressed as a verdict about the picture',
		d.tone === 'off');
	check('paused says it is not measuring', d.measuring === false);
}
{
	// The four actuator gauges freeze with the rest. Reporting them as moved
	// would keep the slider marks and locked read-outs claiming to show
	// where the camera is right now.
	const d = tc.describe({
		state: 5, headroom: 100, span: 90, clipLo: 0, clipHi: 0,
		dehaze: 255, contrast: 85, luminance: 62, saturation: 90,
	}, STOCK, true);
	check('paused reports no knob as moved, however far they were',
		d.moved.length === 0);
}

group('tone-check: a missing number never becomes a wrong one');

{
	const d = tc.describe({
		state: 1, headroom: null, span: null, clipLo: null, clipHi: null,
		dehaze: null, contrast: null, luminance: null, saturation: null,
	}, STOCK, true);
	check('idle with nothing measured still has a sentence', d.tail.length > 0);
	check('and does not claim a knob moved', d.moved.length === 0);
}
{
	// The page does not carry isp.dehaze — an operator on a build without it.
	// An unknown baseline cannot be compared, and reporting the knob anyway
	// would be a comparison against nothing.
	const d = tc.describe({
		state: 2, headroom: 100, span: 88,
		dehaze: 255, contrast: 50, luminance: 50, saturation: 50,
	}, savedFrom({ 'image.contrast': 50, 'image.luminance': 50, 'image.saturation': 50 }), true);
	check('an unknown baseline is not compared',
		d.moved.every(m => m.key !== 'dehaze'));
}
{
	const d = tc.describe({ state: 9, span: 100 }, STOCK, true);
	check('an unknown verdict still renders', d.on === true && d.head === 'Tuning');
	check('and says which one it did not know', d.tail.indexOf('9') >= 0);
}

group('tone-check: the figures under the sentence');

// The four a reader can act on, and the rule that governs all of them: a
// figure is printed because the camera published it, never because the row
// wants four cells.
{
	const s = {
		state: 3, headroom: 100, span: 172, clipLo: 20851, clipHi: 3495,
		dehaze: 125, contrast: 50, luminance: 50, saturation: 50,
	};
	const f = tc.figures(s, true);
	check('four gauges, four figures', f.length === 4);
	check('in the order the picture is read in',
		f.map(x => x.key).join(',') === 'span,clipLo,clipHi,headroom');
	check('the range is a share of the whole scale, not a luma span',
		f[0].value === '67%' && f[0].value.indexOf('255') < 0);
	check('the clipping shares are percentages',
		f[1].value === '2.1%' && f[2].value === '0.3%');
	check('headroom is a percentage of the range, not a gain',
		f[3].value === '100%' && f[3].label.indexOf('gain') < 0);
	check('every figure is labelled in words, not gauge names',
		f.every(x => x.label.indexOf('_') < 0 && /^[A-Z]/.test(x.label)));
}
{
	// A part whose AE will not state its gain publishes no headroom, ever.
	// Three figures is the honest row; a fourth reading 0% would say the
	// sensor is out of range in broad daylight.
	const f = tc.figures({
		state: 1, headroom: null, span: 195, clipLo: 0, clipHi: 0,
	}, true);
	check('an absent gauge is left out, not zeroed', f.length === 3);
	check('and the ones present are unaffected',
		f.map(x => x.key).join(',') === 'span,clipLo,clipHi');
}
{
	// Zero IS a reading: no pixel is crushed. It must survive the same test
	// that drops an absent gauge, which is why figures() tests for null
	// rather than for truth.
	const f = tc.figures({ state: 1, span: 0, clipLo: 0, clipHi: 0,
		headroom: 0 }, true);
	check('a measured zero is printed, not dropped', f.length === 4);
	check('a black picture reads as a zero range', f[0].value === '0%');
	check('and no headroom reads as none', f[3].value === '0%');
}
{
	// PAUSED: every gauge here is frozen at the reading taken before the
	// operator started adjusting. Four real numbers, none of them true any
	// more, under a sentence that says the camera has stopped looking.
	const s = { state: 5, headroom: 100, span: 90, clipLo: 0, clipHi: 0 };
	const d = tc.describe(s, STOCK, true);
	check('paused is not measuring', d.measuring === false);
	check('and publishes no figures at all',
		tc.figures(s, d.measuring).length === 0);
}
{
	check('no sample, no figures', tc.figures(null, true).length === 0);
}

group('tone-check: every verdict says what to do, and keeps the why apart (#581)');
{
	const base = { headroom: 50, span: 120, clipLo: 0, clipHi: 0,
		dehaze: 125, contrast: 50, luminance: 50, saturation: 50 };
	const S = tc.STATE;
	const all = [S.UNAVAILABLE, S.IDLE, S.WORKING, S.HOLDING, S.LOWLIGHT, S.PAUSED]
		.map(st => tc.describe(Object.assign({ state: st }, base), STOCK, true))
		.concat([tc.describe(null, STOCK, true), tc.describe(null, STOCK, false)]);
	check('every verdict has a first line to act on',
		all.every(d => d.head && d.tail));
	check('and a reason for the "?"', all.every(d => typeof d.why === 'string' && d.why));
	// A first line quoting the camera's scale or a raw share is a reading, not
	// an instruction; those belong to the figures and the "?".
	check('no first line carries a raw number or a luma scale',
		all.every(d => !/\d|255|%/.test(d.head + d.tail)));
}

group('tone-check: the span band drawn over the histogram');

{
	check('no span, no band', tc.spanBand({ state: 1, span: null }) === null);
	check('null sample, no band', tc.spanBand(null) === null);
}
{
	const b = tc.spanBand({ span: 255 });
	check('a full span covers the axis', b.lo === 0 && b.hi === 1);
}
{
	const b = tc.spanBand({ span: 0 });
	check('a zero span is a line in the middle', b.lo === 0.5 && b.hi === 0.5);
}
{
	const b = tc.spanBand({ span: 128 });
	check('half a span is half the axis, centred',
		Math.abs((b.hi - b.lo) - 128 / 255) < 1e-9 &&
		Math.abs((b.lo + b.hi) / 2 - 0.5) < 1e-9);
}
{
	// The daemon clamps span to 0..255 by construction, but the page is
	// reading a number off the network and must not paint outside the plot if
	// that ever stops being true.
	const b = tc.spanBand({ span: 400 });
	check('an impossible span is clamped to the axis', b.lo === 0 && b.hi === 1);
}

done();
