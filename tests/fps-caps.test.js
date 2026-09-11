// What frame rate the settings page offers at each resolution (www/a/mj-fps.js).
//
// This exists because the subject fails silently, in both directions, and
// neither shows up as anything but a working page.
//
// The daemon publishes `maximum` — the best rate reachable at SOME resolution —
// alongside `x-fps-caps`, the rate per resolution. A page that reads only
// `maximum` draws one bound at every size, which on a camera with a 64 fps
// binning mode and a 26 fps ceiling at full resolution is wrong at both ends: it
// offers 64 where the camera manages 26 (the stream then runs slower than the
// number the operator chose, or on an older daemon does not start at all), and
// it hides the 64 behind a resolution nobody would think to try. That is what
// the page did before this module, and it is what a gk7205v300 owner saw: a
// frame rate control that read the same whichever resolution they picked.
//
// It cannot be reproduced without a camera whose sensor has more than one mode,
// which is the one thing a fixture can hold still.
'use strict';

const path = require('path');
const { check, group, done } = require('./assert');

const FPS = require(path.join(__dirname, '..', 'www', 'a', 'mj-fps.js'));

// A gk7205v300 + imx335 as measured: binning reaches 64 at the small sizes, the
// 1080p crop 55, and the encoder falls away above 1080p regardless of sensor.
const FIELD = {
	type: 'integer', minimum: 1, maximum: 64, default: 0,
	'x-fps-sensor': 45,
	'x-fps-caps': [
		{ w: 640, h: 360, fps: 64 },
		{ w: 1280, h: 720, fps: 64 },
		{ w: 1920, h: 1080, fps: 55 },
		{ w: 2304, h: 1296, fps: 32 },
		{ w: 2592, h: 1520, fps: 26 },
	],
};

group('the bound follows the chosen resolution');
check('small sizes reach the binning mode', FPS.boundFor(FIELD, '1280x720') === 64);
check('1080p reaches the 1080p crop', FPS.boundFor(FIELD, '1920x1080') === 55);
check('full resolution is held by the encoder', FPS.boundFor(FIELD, '2592x1520') === 26);
check('the answer is not the same at every size',
	FPS.boundFor(FIELD, '1280x720') !== FPS.boundFor(FIELD, '2592x1520'));

group('sizes the daemon did not measure');
// An unlisted size falls back to `maximum` rather than to a neighbour's number.
// Interpolating between two measurements is how a page starts offering rates
// nobody observed; the daemon clamps what gets past the flat bound anyway.
check('an unlisted size falls back to maximum', FPS.boundFor(FIELD, '704x576') === 64);
check('an unparseable size falls back to maximum', FPS.boundFor(FIELD, 'auto') === 64);
check('no size at all falls back to maximum', FPS.boundFor(FIELD, '') === 64);
check('capFor says nothing rather than guessing', FPS.capFor(FIELD, '704x576') === null);

group('a daemon that publishes no caps');
// Older builds send neither key. The page must behave exactly as it did.
const PLAIN = { type: 'integer', minimum: 1, maximum: 120 };
check('the flat maximum is used', FPS.boundFor(PLAIN, '1920x1080') === 120);
check('no per-size answer is invented', FPS.capFor(PLAIN, '1920x1080') === null);

group('malformed caps are not trusted');
check('a zero rate is not a cap',
	FPS.capFor({ maximum: 30, 'x-fps-caps': [{ w: 640, h: 360, fps: 0 }] }, '640x360') === null);
check('a missing rate is not a cap',
	FPS.capFor({ maximum: 30, 'x-fps-caps': [{ w: 640, h: 360 }] }, '640x360') === null);
check('caps that are not an array are ignored',
	FPS.capFor({ maximum: 30, 'x-fps-caps': 64 }, '640x360') === null);

done();
