/*
 * What the camera will ACTUALLY do with a rectangle you hand it.
 *
 * Two of them, and both fail silently, which is the only reason this file
 * exists rather than the page simply POSTing what was drawn:
 *
 *   * `/image.dng?crop=` snaps the rectangle OUTWARD onto the colour mosaic and
 *     the bit packing, and the file then describes what was really cut. Ask for
 *     an odd column and you get a different rectangle back -- one that still
 *     decodes into a photograph, so nothing looks wrong.
 *   * `isp.meterRect` reaches an ISP whose AE crop has a 256x120 MINIMUM. A
 *     50x14 plate is grown by a factor of twenty-five around its own centre.
 *     Auto-exposure then meters a car, not a plate, and the picture it produces
 *     is a perfectly ordinary picture.
 *
 * So the page has to be able to say what it is about to get, before it asks.
 * Both functions below are transcriptions of the daemon's own arithmetic --
 * `maj_align_rect()` in majestic's src/tools.c, and `HiSi_HAL_SetAeMetering()`
 * in src/hisi/hal.c -- integer truncation included. They are deliberately
 * boring: a paraphrase that rounds the other way is worth nothing, because the
 * whole point is agreeing with the camera rather than being reasonable.
 *
 * No DOM, no network, no camera. Everything here is arithmetic, which is what
 * lets tests/plate-roi.test.js reach it.
 */
(function () {
	'use strict';

	/* The ISP's AE crop minimum on EV200/EV300/GK7205 -- the parts that have
	 * isp.meterRect at all. Smaller than this the hardware will not meter, so
	 * the daemon GROWS a smaller request rather than refusing it: a window too
	 * big is still far more selective than the whole frame, and refusing would
	 * leave the operator with nothing. */
	const AE_MIN_W = 256;
	const AE_MIN_H = 120;

	/* Pixels per packing group, and the crop alignment derived from it. A row
	 * is a whole number of bytes however its pixels are packed, so vertically
	 * only the colour mosaic's two is owed -- but the daemon uses ONE alignment
	 * for both axes so every rectangle goes through the same tested arithmetic,
	 * and this has to match that choice, not improve on it. */
	function groupPx(bits) {
		switch (bits) {
		case 8: case 16: return 1;
		case 10: case 14: return 4;
		case 12: return 2;
		default: return 0;
		}
	}

	function cropAlign(bits) {
		const px = groupPx(bits);
		if (!px) return 0;
		/* Rounded up to something even, because the mosaic needs two and a
		 * group of one or three would not give it. */
		return px % 2 ? px * 2 : px;
	}

	const isNat = (v) => typeof v === 'number' && isFinite(v) && v >= 0 && Math.floor(v) === v;

	function rectOk(r) {
		return !!r && isNat(r.left) && isNat(r.top) && isNat(r.width) && isNat(r.height);
	}

	/*
	 * What `/image.dng?crop=` will hand back.
	 *
	 * Returns the rectangle the camera will really cut, or null where the
	 * daemon refuses outright -- and it refuses in cases that look harmless:
	 *
	 *   * a rectangle with no area. Rounding the far edge up would turn
	 *     `15x0x0x16` into a whole alignment cell, so an unfilled size would
	 *     arrive covering something nobody asked about.
	 *   * an origin already off the picture: there is nothing left of it to keep.
	 *   * a bit depth whose packing nobody has measured.
	 *   * a picture width that is not itself on the alignment, because clipping
	 *     to the right-hand edge would then land between groups.
	 *
	 * The near edge goes DOWN and the far edge UP, both derived from the
	 * rectangle asked for -- never from the size rounded on its own, which is a
	 * different rectangle whenever the origin was not already aligned.
	 */
	function alignCrop(want, picW, picH, bits) {
		if (!rectOk(want) || !isNat(picW) || !isNat(picH) || !picW || !picH) return null;
		const align = cropAlign(bits);
		if (!align || picW % align) return null;
		if (!want.width || !want.height) return null;

		const x = want.left - (want.left % align);
		const y = want.top - (want.top % align);
		if (x >= picW || y >= picH) return null;

		let right = want.left + want.width;
		let bottom = want.top + want.height;
		const rr = right % align, br = bottom % align;
		if (rr) right += align - rr;
		if (br) bottom += align - br;

		/* Clipped to what REMAINS after the origin, and back onto the grid:
		 * the picture's own edge need not be a multiple of it. */
		const maxW = (picW - x) - ((picW - x) % align);
		const maxH = (picH - y) - ((picH - y) % align);
		let w = right - x, h = bottom - y;
		if (w > maxW) w = maxW;
		if (h > maxH) h = maxH;
		if (!w || !h) return null;

		return { left: x, top: y, width: w, height: h };
	}

	/* The query the daemon parses. Separate from alignCrop because a caller
	 * should be able to show what it asked for beside what it will get. */
	function cropQuery(r) {
		return r.left + 'x' + r.top + 'x' + r.width + 'x' + r.height;
	}

	/*
	 * What auto-exposure will actually meter.
	 *
	 * Returns the ISP crop the daemon will program, or null for "the whole
	 * picture" -- which is what an absent or zero-sized rectangle means, and is
	 * also how the setting is undone.
	 *
	 * The growth is CENTRE-PRESERVING: a plate-sized request keeps its centre
	 * on the plate rather than acquiring 178 px of bumper down one side. Every
	 * division is integer, and the halves are taken from different rectangles
	 * -- the centre from what was asked for, the offset from what will be
	 * programmed -- so this cannot be simplified into one expression without
	 * drifting off the daemon by a pixel.
	 *
	 * Note the daemon bounds each coordinate into the picture BEFORE any
	 * arithmetic, which is not the same as clamping the result: nothing
	 * validates a majestic.yaml against the schema, so the rectangle reaching
	 * the ISP can carry anything strtoul accepted.
	 */
	function meterCrop(want, picW, picH) {
		if (!isNat(picW) || !isNat(picH) || !picW || !picH) return null;
		if (!rectOk(want) || !want.width || !want.height) return null;

		const rx = Math.min(want.left, picW);
		const ry = Math.min(want.top, picH);
		const rw = Math.min(want.width, picW);
		const rh = Math.min(want.height, picH);

		let w = rw < AE_MIN_W ? AE_MIN_W : rw;
		let h = rh < AE_MIN_H ? AE_MIN_H : rh;
		if (w > picW) w = picW;
		if (h > picH) h = picH;

		const cx = rx + Math.floor(rw / 2);
		const cy = ry + Math.floor(rh / 2);
		let x = cx - Math.floor(w / 2);
		let y = cy - Math.floor(h / 2);
		x = Math.min(Math.max(x, 0), picW - w);
		y = Math.min(Math.max(y, 0), picH - h);

		return { left: x, top: y, width: w, height: h };
	}

	/* Was the request changed on the way in? The page needs this to decide
	 * whether to say anything at all -- "metering 256x120" is noise when that
	 * is what was asked for, and the one thing worth reporting when it is not. */
	function grown(want, got) {
		if (!want || !got) return false;
		return got.left !== want.left || got.top !== want.top ||
			got.width !== want.width || got.height !== want.height;
	}

	/* How many times bigger the metered area is than the region asked for.
	 * A plate is 50x14 and the floor is 256x120 -- a factor of forty-four, and
	 * a number worth putting in front of someone before they arm it. */
	function growthFactor(want, got) {
		if (!want || !got || !want.width || !want.height) return 1;
		return (got.width * got.height) / (want.width * want.height);
	}

	const api = {
		AE_MIN_W: AE_MIN_W, AE_MIN_H: AE_MIN_H,
		groupPx: groupPx, cropAlign: cropAlign,
		alignCrop: alignCrop, cropQuery: cropQuery,
		meterCrop: meterCrop, grown: grown, growthFactor: growthFactor,
	};
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticPlateRoi = api;
})();
