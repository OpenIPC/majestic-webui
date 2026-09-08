// How a main-stream rectangle lands on the stream being shown.
//
// This fails silently and in the worst direction: every branch draws a
// confident outline, and a wrong one sits beside the camera's own block on a
// different part of the picture -- which is exactly what the reporter of
// OpenIPC/majestic-webui#340 photographed with a crop on the main stream and
// the masks edited on the sub stream. Reaching it needs a camera with a crop
// configured, a sub stream that plays, and a mask, and a ratio that is right
// on every uncropped camera is what hides it everywhere else.
//
// The numbers are the lab hi3516ev300's: a 2592x1520 sensor frame, the main
// stream cropped to 1920x1080 at 320,160, the sub stream 704x576 showing the
// whole frame. The expected values are where the camera actually drew the
// mask, measured in a decoded frame of each stream, before the two-pixel
// alignment the hardware applies.
'use strict';

const path = require('path');
const { check, group, done } = require('./assert');

const R = require(path.join(__dirname, '..', 'www', 'a', 'mj-region.js'));

const GROUP = [2592, 1520];
const FULL = [0, 0, 2592, 1520];
const near = (a, b, eps) => Math.abs(a - b) <= (eps || 0.01);
const at = (m, x, y) => ({ x: m.k.x * x + m.o.x, y: m.k.y * y + m.o.y });

group('neither stream cropped: the plain ratio, with no offset');
{
	const m = R.view(GROUP, [
		{ stream: 0, frame: [2592, 1520], view: FULL },
		{ stream: 1, frame: [704, 576], view: FULL },
	], 0, 1);
	check('a map comes back', !!m);
	check('main frame is the space regions are written in', m.b.w === 2592 && m.b.h === 1520);
	check('shown frame is the sub stream', m.f.w === 704 && m.f.h === 576);
	const p = at(m, 300, 300);
	check('x is the width ratio', near(p.x, 300 * 704 / 2592));
	check('y is the height ratio', near(p.y, 300 * 576 / 1520));
	check('no offset', near(m.o.x, 0) && near(m.o.y, 0));
}

group('main stream cropped, sub stream whole: the reporter\'s configuration');
{
	const m = R.view(GROUP, [
		{ stream: 0, frame: [1920, 1080], view: [320, 160, 1920, 1080] },
		{ stream: 1, frame: [704, 576], view: FULL },
	], 0, 1);
	check('a map comes back', !!m);
	check('regions are written in the CROPPED main frame', m.b.w === 1920 && m.b.h === 1080);
	// 300x300x500x400 in main pixels: group 620,460 to 1120,860; on the sub
	// stream that is 620*704/2592 across and 460*576/1520 down.
	const lt = at(m, 300, 300), rb = at(m, 800, 700);
	check('left lands where the daemon puts it', near(lt.x, 620 * 704 / 2592));
	check('top lands where the daemon puts it', near(lt.y, 460 * 576 / 1520));
	check('right edge follows', near(rb.x, 1120 * 704 / 2592));
	check('bottom edge follows', near(rb.y, 860 * 576 / 1520));
	// The ratio the page used to draw put the same left edge at 300/1920 of
	// the picture, which is 110 sub-stream pixels; the block is at 168.
	check('and that is not where the ratio put it', !near(lt.x, 300 / 1920 * 704, 1));
}

group('main stream shown: a crop on it changes nothing about its own picture');
{
	const m = R.view(GROUP, [
		{ stream: 0, frame: [1920, 1080], view: [320, 160, 1920, 1080] },
		{ stream: 1, frame: [704, 576], view: FULL },
	], 0, 0);
	const p = at(m, 300, 300);
	check('identity on the main stream', near(p.x, 300) && near(p.y, 300));
	check('scale is one', near(m.k.x, 1) && near(m.k.y, 1));
}

group('sub stream cropped, main whole');
{
	const m = R.view(GROUP, [
		{ stream: 0, frame: [2592, 1520], view: FULL },
		{ stream: 1, frame: [640, 360], view: [1296, 760, 1296, 760] },
	], 0, 1);
	check('a map comes back', !!m);
	// A main-stream point at the group's centre is the sub stream's top-left.
	const c = at(m, 1296, 760);
	check('the group centre is the cropped sub stream\'s origin', near(c.x, 0) && near(c.y, 0));
	const e = at(m, 2592, 1520);
	check('the group corner is its far corner', near(e.x, 640) && near(e.y, 360));
	const off = at(m, 0, 0);
	check('a point outside the crop maps to a negative coordinate, not a clamped one', off.x < 0 && off.y < 0);
}

group('what the camera has not said');
{
	const streams = [{ stream: 0, frame: [2592, 1520], view: FULL }];
	check('no group frame is no map', R.view(null, streams, 0, 0) === null);
	check('a zero group frame is no map', R.view([0, 0], streams, 0, 0) === null);
	check('a stream the camera did not list is no map', R.view(GROUP, streams, 0, 1) === null);
	check('no streams at all is no map', R.view(GROUP, null, 0, 0) === null);
	check('a view with no area is no map',
		R.view(GROUP, [{ stream: 0, frame: [2592, 1520], view: [0, 0, 0, 0] }], 0, 0) === null);
	// A field that is not a number would come out of the arithmetic as NaN,
	// and a NaN is a rectangle nowhere on every outline, press and drag.
	check('a view with a missing origin is no map',
		R.view(GROUP, [{ stream: 0, frame: [2592, 1520], view: [null, 0, 2592, 1520] }], 0, 0) === null);
	check('a view with a string in it is no map',
		R.view(GROUP, [{ stream: 0, frame: [2592, 1520], view: ['0', 0, 2592, 1520] }], 0, 0) === null);
	check('a short view is no map',
		R.view(GROUP, [{ stream: 0, frame: [2592, 1520], view: [0, 0, 2592] }], 0, 0) === null);
	check('a frame that is not an array is no map',
		R.view(GROUP, [{ stream: 0, frame: '2592x1520', view: FULL }], 0, 0) === null);
	check('a group with an infinity in it is no map',
		R.view([Infinity, 1520], [{ stream: 0, frame: [2592, 1520], view: FULL }], 0, 0) === null);
	check('streams that are not a list is no map', R.view(GROUP, {}, 0, 0) === null);
	// A negative origin is a legitimate answer -- a crop can begin anywhere
	// -- so only the sizes are required to be positive.
	check('a view at a negative origin is still a map',
		R.view(GROUP, [{ stream: 0, frame: [2592, 1520], view: [-2, -2, 2592, 1520] }], 0, 0) !== null);
}

done();
