// The automatic-tuning sentence and the knob comparison behind it.
//
// Here for the reason ircut-check's table is: every branch renders a
// confident sentence, so a wrong branch reads exactly like a right one, and
// reaching most of them on a real camera needs weather. "Nothing to do — the
// picture already spans 198 of 255" is what a reader sees when the controller
// has in fact stood down for low light, and nothing else on the page
// contradicts it.
//
// The gauge values below are real readings taken off two lab cameras on
// 2026-09-20 — a hi3516ev300 + IMX335 courtyard camera in full sun, and the
// same camera with its contrast baseline dropped to flatten the picture.
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

group('tone-check: the controller is not running');

// image.tuning off, or a backend with no controller at all: majestic publishes
// none of the gauges. The distinction that matters is between this and a
// controller that is running and idle — they are one word apart on screen and
// completely different situations.
{
	const d = tc.describe(null, STOCK);
	check('null sample is reported as off', d.on === false && d.head === 'Off');
	check('and claims no knob has moved', d.moved.length === 0);
}
{
	const d = tc.describe({ state: null, span: null }, STOCK);
	check('a sample with no state is also off', d.on === false);
}

group('tone-check: running and idle');

// 12:53 UTC, courtyard, full sun. Span 195 of 255, nothing clipped: the
// correct action is none, and the panel has to say that without sounding
// like the feature is broken.
{
	const d = tc.describe({
		state: 1, headroom: 100, span: 195, clipLo: 0, clipHi: 0,
		dehaze: 125, contrast: 50, luminance: 50, saturation: 50,
	}, STOCK);
	check('idle is on', d.on === true);
	check('idle reads as nothing to do', d.head === 'Nothing to do');
	check('and quotes the span it measured', d.tail.indexOf('195') >= 0);
	check('idle is a quiet tone', d.tone === 'ok');
	check('no knob is held away from the operator', d.moved.length === 0);
}

group('tone-check: working');

// 12:14 UTC, same camera, contrast baseline dropped to 22 to flatten it.
// Mid-ramp: dehaze and saturation lifted, contrast not yet.
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
	check('working says it is lifting', d.head === 'Lifting the picture');
	check('working is an active tone', d.tone === 'work');
	// The two that actually differ from the operator's saved values, and not
	// the two that match them — a panel that lists all four teaches the
	// reader that the controller is fighting knobs it has not touched.
	check('names only the knobs that moved',
		d.moved.length === 2 &&
		d.moved.map(m => m.key).sort().join(',') === 'dehaze,saturation');
	check('the tail names them with their live values',
		d.tail.indexOf('dehaze 189') >= 0 && d.tail.indexOf('saturation 67') >= 0);
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
	}, STOCK);
	check('working with nothing moved still has a tail', d.tail.length > 0);
	check('and falls back to the span', d.tail.indexOf('71') >= 0);
}

group('tone-check: the two standing-down states');

// 09:57 UTC, courtyard, full sun with deep shade: 4.07% of the frame already
// crushed. The controller stops rather than trade shadows for range, and this
// is the state where the reader most needs to be told WHY nothing is moving.
{
	const d = tc.describe({
		state: 3, headroom: 100, span: 210, clipLo: 40670, clipHi: 6291,
		dehaze: 125, contrast: 50, luminance: 50, saturation: 50,
	}, STOCK);
	check('holding says it is held', d.head === 'Holding back');
	check('holding warns', d.tone === 'warn');
	check('and prints the crushed share as a percentage',
		d.tail.indexOf('4.1% crushed') >= 0);
	check('and the blown share too', d.tail.indexOf('0.6% blown') >= 0);
}
{
	const d = tc.describe({
		state: 4, headroom: 20, span: 96, clipLo: 0, clipHi: 0,
		dehaze: 125, contrast: 50, luminance: 50, saturation: 50,
	}, STOCK);
	check('low light says so', d.head === 'Too dark to help');
	check('low light warns', d.tone === 'warn');
	check('and quotes the headroom left', d.tail.indexOf('20%') >= 0);
}
{
	const d = tc.describe({
		state: 0, headroom: null, span: null, clipLo: null, clipHi: null,
		dehaze: 125, contrast: 50, luminance: 50, saturation: 50,
	}, STOCK);
	// On with no measurement is NOT the same as idle, and must not be
	// softened into it: a camera whose sampling source never answers sits
	// here for ever.
	check('no reading is distinguished from idle', d.head === 'No reading');
	check('and warns rather than reassures', d.tone === 'warn');
}

group('tone-check: paused while somebody adjusts by hand');

// The driver stops sampling during a hold, so every gauge freezes at its
// last value. Reported as its own state precisely so the page stops
// presenting those as current: on hardware this was observed insisting "the
// picture already spans 90 of 255" for a full minute while the picture
// spanned 192.
{
	const d = tc.describe({
		state: 5, headroom: 100, span: 90, clipLo: 0, clipHi: 0,
		dehaze: 125, contrast: 50, luminance: 50, saturation: 50,
	}, STOCK);
	check('paused is on', d.on === true);
	check('paused says it is paused', d.head === 'Paused');
	check('and quotes no measurement at all',
		d.tail.indexOf('90') < 0 && d.tail.indexOf('span') < 0);
	check('paused is not dressed as a verdict about the picture',
		d.tone === 'off');
}

group('tone-check: a missing number never becomes a wrong one');

{
	const d = tc.describe({
		state: 1, headroom: null, span: null, clipLo: null, clipHi: null,
		dehaze: null, contrast: null, luminance: null, saturation: null,
	}, STOCK);
	check('idle without a span omits the number', d.tail.indexOf('0') < 0);
	check('and does not claim a knob moved', d.moved.length === 0);
}
{
	// The page does not carry isp.dehaze — an operator on a build without it.
	// An unknown baseline cannot be compared, and reporting the knob anyway
	// would be a comparison against nothing.
	const d = tc.describe({
		state: 2, headroom: 100, span: 88,
		dehaze: 255, contrast: 50, luminance: 50, saturation: 50,
	}, savedFrom({ 'image.contrast': 50, 'image.luminance': 50, 'image.saturation': 50 }));
	check('an unknown baseline is not compared',
		d.moved.every(m => m.key !== 'dehaze'));
}
{
	const d = tc.describe({ state: 9, span: 100 }, STOCK);
	check('an unknown verdict still renders', d.on === true && d.head === 'Tuning');
	check('and says which one it did not know', d.tail.indexOf('9') >= 0);
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
