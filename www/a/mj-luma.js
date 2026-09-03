// Luma histogram for the Live adjustments preview.
//
// Why the browser and not the camera: the question an installer has while
// tuning is "am I blowing the sky or crushing the shadows", and the honest
// answer is about the picture that comes out — after the ISP knobs, after the
// encoder. That picture is already decoded in the <video> element, so a canvas
// readback answers it for free and costs the camera nothing. There is no
// endpoint to add and no per-frame work on a 32 MB board.
//
// A separate file for two reasons. mj-settings.js is about the form, and the
// arithmetic here fails SILENTLY — a histogram computed wrongly still draws a
// plausible shape, and nobody notices that "2.1% blown" is off by a factor of
// three by looking at it. tests/luma.test.js drives `histogram` directly.
(function () {
	'use strict';

	// 64 buckets: enough that a clipped edge is a visible spike and few enough
	// that the shape is readable in a 23rem panel.
	const BINS = 64;
	// The sample is a thumbnail, not the frame. A luma distribution is a
	// statistic — 160x90 is 14,400 pixels, which is plenty for one. The
	// getImageData off this small target is cheap; what is NOT cheap is the
	// draw that fills it from a large software-decoded canvas — see tick().
	const SW = 160, SH = 90;

	// Rec.709, because that is what an H.264 HD stream is: using the 601
	// coefficients on 709 content skews the mean by a couple of per cent and
	// biases it differently in greens than in reds.
	function luma(r, g, b) {
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	}

	// Pure, so the test can hand it bytes it made up. `data` is RGBA, as
	// getImageData gives it.
	//
	// `low`/`high` are the fraction of pixels in the first and last bucket.
	// They are the point of the whole panel: everything else here is a shape,
	// but those two numbers are the fault an installer is actually looking for.
	function histogram(data, w, h) {
		const bins = new Array(BINS).fill(0);
		const n = w * h;
		let sum = 0;
		for (let i = 0; i < n; i++) {
			const p = i * 4;
			const y = luma(data[p], data[p + 1], data[p + 2]);
			// Bucket the rounded 8-bit code value, not the raw float. The 709
			// coefficients do not sum to exactly 1 in binary — 0.2126 + 0.7152
			// + 0.0722 lands a hair under — so a grey pixel at 128 computes as
			// 127.99999999999999 and truncates into the bucket below. On a
			// greyscale ramp that shows up as buckets of 3 and 5 where every
			// one should hold 4, which is the one case where a reader can check
			// the answer by eye.
			const c = Math.round(y);
			// 255 must land in the last bucket, not one past it.
			let b = (c * BINS) >> 8;
			if (b >= BINS) b = BINS - 1;
			bins[b]++;
			sum += y;
		}
		return {
			bins: bins,
			total: n,
			mean: n ? sum / n : 0,
			low: n ? bins[0] / n : 0,
			high: n ? bins[BINS - 1] / n : 0,
		};
	}

	// An SVG path over a 0..BINS x 0..100 box, drawn as steps rather than a
	// curve — a histogram is buckets, and a smoothed one invents detail between
	// them that the data does not have.
	//
	// The vertical scale is logarithmic. A linear one is dominated by whatever
	// the scene's most common tone is, which flattens the shadow and highlight
	// tails into an invisible smear along the axis — and the tails are the part
	// worth looking at.
	function path(bins) {
		let peak = 0;
		for (let i = 0; i < bins.length; i++) if (bins[i] > peak) peak = bins[i];
		if (!peak) return 'M0,100 L' + bins.length + ',100 Z';
		const norm = (v) => Math.log1p((v / peak) * 24) / Math.log(25);
		let d = 'M0,100';
		for (let i = 0; i < bins.length; i++) {
			const y = (100 - norm(bins[i]) * 94).toFixed(2);
			d += ' L' + i + ',' + y + ' L' + (i + 1) + ',' + y;
		}
		return d + ' L' + bins.length + ',100 Z';
	}

	// opts.video  () => the <video> to sample. A getter, not a node: the MSE
	//             player swaps its element on every reconnect, so a captured
	//             one is detached within a session and samples nothing.
	// opts.onData (result) — result is what histogram() returns, plus `path`.
	// opts.hz     samples per second (default 4).
	function start(opts) {
		const canvas = document.createElement('canvas');
		canvas.width = SW;
		canvas.height = SH;
		// willReadFrequently: this is a readback loop, and without it the
		// browser keeps the surface on the GPU and pays a stall per getImageData.
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		let timer = null;
		let stopped = false;
		// One readback in flight at a time. The canvas path below is async, so
		// without this a slow readback would pile the next tick's on top of it
		// — the exact stall this guard exists to bound turned into a queue of
		// them. A tick that finds one already running simply skips, which for a
		// histogram sampled several times a second costs nothing.
		let busy = false;
		// Set once if a browser exposes createImageBitmap but refuses this
		// canvas source, so the loop stops asking it every tick and stays on the
		// synchronous path — see the catch below.
		let bitmapBroken = false;

		// Draw the (already thumbnail-sized) source into the sampling canvas and
		// turn it into a histogram. `source` is either a bitmap the browser has
		// already scaled to SWxSH off-thread, or a <video> the browser scales
		// down for free as it draws — both leave getImageData reading 14,400
		// pixels and nothing larger.
		function sampleFrom(source) {
			try {
				ctx.drawImage(source, 0, 0, SW, SH);
				const d = ctx.getImageData(0, 0, SW, SH).data;
				const r = histogram(d, SW, SH);
				r.path = path(r.bins);
				opts.onData(r);
			} catch (e) {
				// A frame that cannot be drawn (mid-teardown, or a tainted
				// canvas on some future cross-origin source) is not worth
				// killing the loop over; the next tick may well work.
			}
		}

		function tick() {
			if (stopped) return;
			const v = opts.video();
			// Nothing to read: the tab is hidden, the player has not attached
			// yet, or the stream dropped. Say nothing rather than draw a lie —
			// an empty histogram would read as "the picture is black".
			// A canvas is as good a drawImage source as a video and has neither
			// readyState nor videoWidth, so the guard asks each what it can
			// answer. Without it the sampler no-ops for ever against the
			// software-decode rung, and an empty histogram reads as "the
			// picture is black" rather than as "nothing is being measured".
			//
			// But a canvas's SIZE is not the answer: one is 300x150 from the
			// moment it exists, so width alone would accept a surface nothing
			// has been decoded into yet and publish black as a measurement.
			// Only whoever paints it knows, so it must say so — `__mjPainted`,
			// an expando rather than an attribute because cloneNode copies
			// attributes and a replaced canvas would inherit a claim it has
			// not earned. Unmarked means unknown, and unknown means silent.
			const drawable = v && (v.tagName === 'CANVAS'
				? v.__mjPainted === true
				: (v.readyState >= 2 && v.videoWidth > 0));
			if (!document.hidden && drawable && !busy) {
				// A <video> is cheap to sample: the browser scales it down as it
				// draws, so the synchronous path stays well inside a frame.
				//
				// A software-decode CANVAS is not. drawImage() from a full-res
				// WebGL surface forces a GPU->CPU readback of the WHOLE frame
				// before the downscale, and on a weak client decoding a 2592x1520
				// stream that measured ~570ms — four times a second, jamming the
				// main thread and every transport switch riding on it (#288).
				// createImageBitmap does the readback AND the downscale off the
				// main thread and hands back a bitmap already sized SWxSH, so the
				// draw above reads back nothing larger than the thumbnail. It
				// snapshots the source at call time, exactly as drawImage would,
				// so it captures the same frame from a preserveDrawingBuffer:false
				// context rather than a blank one.
				if (v.tagName === 'CANVAS' && typeof createImageBitmap === 'function' &&
					!bitmapBroken) {
					busy = true;
					createImageBitmap(v, {
						resizeWidth: SW, resizeHeight: SH, resizeQuality: 'low',
					}).then(function (bmp) {
						// Publish only if this is still the picture on screen. A
						// channel or transport switch can land between the snapshot
						// and here — the software player even swaps its canvas node
						// — and a histogram of the frame that WAS is a wrong answer
						// dressed as the current one, worse than one tick's gap. `v`
						// is the superseded node after such a switch, so the
						// identity check against the live element catches it.
						if (!stopped && opts.video() === v && v.__mjPainted === true) {
							sampleFrom(bmp);
						}
						bmp.close();
						busy = false;
					}).catch(function () {
						// The browser has createImageBitmap but will not take this
						// source. Stop asking it and fall back to the synchronous
						// readback rather than leave the histogram blank for ever —
						// the stall is the lesser fault, and only where it is forced.
						bitmapBroken = true;
						busy = false;
						if (!stopped && opts.video() === v && v.__mjPainted === true) {
							sampleFrom(v);
						}
					});
				} else {
					sampleFrom(v);
				}
			}
			timer = setTimeout(tick, 1000 / (opts.hz || 4));
		}

		tick();
		return {
			stop: function () {
				stopped = true;
				if (timer) clearTimeout(timer);
				timer = null;
			},
		};
	}

	const api = { start: start, histogram: histogram, path: path, BINS: BINS };
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticLuma = api;
})();
