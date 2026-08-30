// The luma histogram behind the Live adjustments panel.
//
// This exists because the subject fails silently. A histogram computed with
// the wrong coefficients, the wrong bucket edges or the wrong denominator
// still draws a plausible shape over a live picture, and nobody reviewing a
// screenshot can tell that "2.1% blown" is off by a factor of three. The two
// clipping fractions are the only numbers on the panel an installer acts on,
// so they are the ones worth pinning to frames whose answer is known by
// construction.
//
// It also cannot be reproduced on demand in a browser: it needs a camera, a
// negotiated stream and a scene that clips. Here the frames are made up, which
// is the point.
'use strict';

const path = require('path');
const { check, group, done } = require('./assert');

const luma = require(path.join(__dirname, '..', 'www', 'a', 'mj-luma.js'));

// An RGBA buffer of w*h pixels, each filled by px(i) -> [r, g, b].
function frame(w, h, px) {
	const d = new Uint8ClampedArray(w * h * 4);
	for (let i = 0; i < w * h; i++) {
		const c = px(i);
		d[i * 4] = c[0];
		d[i * 4 + 1] = c[1];
		d[i * 4 + 2] = c[2];
		d[i * 4 + 3] = 255;
	}
	return d;
}

const grey = (v) => (w, h) => frame(w, h, () => [v, v, v]);
const near = (a, b, eps) => Math.abs(a - b) <= eps;

group('a flat frame lands in exactly one bucket');
{
	const black = luma.histogram(grey(0)(16, 16), 16, 16);
	check('black is 100% in the first bucket', black.low === 1, black.low);
	check('black clips nothing at the top', black.high === 0, black.high);
	check('black means 0', black.mean === 0, black.mean);

	const white = luma.histogram(grey(255)(16, 16), 16, 16);
	// The off-by-one that a naive `y * BINS / 255` makes: 255 lands in bucket
	// 64 of a 64-bucket array, so `high` reads 0 and a blown-out sky reports
	// no clipping at all.
	check('white is 100% in the last bucket', white.high === 1, white.high);
	check('white clips nothing at the bottom', white.low === 0, white.low);
	// Not ===: the 709 coefficients sum to a hair under 1 in binary, so a white
	// frame means 254.99999999999997. That is fine for a mean; it is NOT fine
	// for bucketing, which is why histogram() rounds before it buckets.
	check('white means 255', near(white.mean, 255, 1e-6), white.mean);

	const mid = luma.histogram(grey(128)(16, 16), 16, 16);
	check('mid grey clips at neither end', mid.low === 0 && mid.high === 0,
		mid.low + '/' + mid.high);
	check('mid grey means 128', mid.mean === 128, mid.mean);
	check('mid grey sits in the middle bucket',
		mid.bins.indexOf(Math.max.apply(null, mid.bins)) === 32,
		mid.bins.indexOf(Math.max.apply(null, mid.bins)));
}

group('clipping fractions are of the whole frame');
{
	// A quarter blown, a quarter crushed, half mid-grey.
	const d = frame(20, 20, (i) => (i < 100 ? [0, 0, 0] : i < 200 ? [255, 255, 255] : [128, 128, 128]));
	const r = luma.histogram(d, 20, 20);
	check('a quarter crushed reads 0.25', near(r.low, 0.25, 1e-9), r.low);
	check('a quarter blown reads 0.25', near(r.high, 0.25, 1e-9), r.high);
	check('the buckets add up to the pixel count',
		r.bins.reduce((a, b) => a + b, 0) === 400, r.bins.reduce((a, b) => a + b, 0));
	check('total is the pixel count, not the byte count', r.total === 400, r.total);
}

group('luma is Rec.709, not 601 and not an average');
{
	// The three primaries at full strength. 709 weights them 0.2126 / 0.7152 /
	// 0.0722; 601 weights them 0.299 / 0.587 / 0.114, and a plain average gives
	// all three 85. Each of those three answers is a different bucket.
	const one = (c) => luma.histogram(frame(4, 4, () => c), 4, 4).mean;
	check('pure red means ~54', near(one([255, 0, 0]), 54.2, 0.5), one([255, 0, 0]));
	check('pure green means ~182', near(one([0, 255, 0]), 182.4, 0.5), one([0, 255, 0]));
	check('pure blue means ~18', near(one([0, 0, 255]), 18.4, 0.5), one([0, 0, 255]));
	check('green is weighted far above red', one([0, 255, 0]) > one([255, 0, 0]) * 3);
}

group('a ramp fills every bucket evenly');
{
	// 256 columns, one per code value, so each of the 64 buckets should get
	// exactly four of them — the check that the bucket edges are uniform and
	// that nothing is being dropped or double-counted at a boundary.
	const d = frame(256, 1, (i) => [i, i, i]);
	const r = luma.histogram(d, 256, 1);
	check('every bucket is occupied', r.bins.every((b) => b > 0), r.bins.filter((b) => !b).length);
	check('every bucket holds exactly four values',
		r.bins.every((b) => b === 4), r.bins.join(','));
	check('a ramp means ~127.5', near(r.mean, 127.5, 0.6), r.mean);
}

group('the drawn path is a closed step function over the box');
{
	const r = luma.histogram(frame(64, 1, (i) => [i * 4, i * 4, i * 4]), 64, 1);
	const d = luma.path(r.bins);
	check('starts at the baseline', d.indexOf('M0,100') === 0, d.slice(0, 12));
	check('closes back to the baseline', /L64,100 Z$/.test(d), d.slice(-14));
	// Two points per bucket is what makes it steps rather than a curve.
	check('two vertices per bucket', (d.match(/L/g) || []).length === 64 * 2 + 1,
		(d.match(/L/g) || []).length);
	const ys = (d.match(/L\d+,([\d.]+)/g) || []).map((s) => Number(s.split(',')[1]));
	check('nothing escapes the box', ys.every((y) => y >= 0 && y <= 100));

	// The log scale exists so the tail that matters is legible. The number the
	// panel acts on is the 1%-clipped threshold, so that is the one to pin: a
	// bucket holding 1% of the peak must draw as a bar somebody can see, not as
	// a thickening of the axis. Linearly it would be 0.94% of the height.
	const spiky = new Array(luma.BINS).fill(0);
	spiky[0] = 10000;
	spiky[63] = 100;                      // 1% of the peak
	const h = luma.path(spiky).match(/L\d+,([\d.]+)/g).map((s) => Number(s.split(',')[1]));
	// index 126/127 are the last bucket's two vertices; 100 is the baseline.
	const tail = 100 - Math.min(h[126], h[127]);
	check('a bucket at 1% of the peak draws as a visible bar', tail > 5,
		tail.toFixed(2) + '%');
	check('and well above what a linear scale would give', tail > 0.94 * 4,
		tail.toFixed(2) + '% vs 0.94% linear');

	const flat = luma.path(new Array(luma.BINS).fill(0));
	check('an empty frame degrades to the baseline, not to NaN',
		flat.indexOf('NaN') < 0 && /^M0,100/.test(flat), flat);
}

done();
