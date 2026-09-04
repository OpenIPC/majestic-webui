// What the camera will do with a rectangle somebody typed.
//
// The region editor on the Motion detection and Overlay leaves stores
// "XxYxWxH" strings, and until now it accepted whatever four numbers it could
// read out of one. OpenIPC/majestic-webui#330 is what that costs, in the
// reporter's own words: "it is possible to enter the size of the zone with a
// zero value, which is incorrect -- it is not visible", and "entering
// coordinates and size is not limited by the image resolution field".
//
// Both land in the same place on the camera. Each region edge is clamped into
// the frame before anything is compared against it, so a region of zero width
// and a region nine thousand pixels off the picture BOTH end up as a rectangle
// with no area, and a rectangle with no area can never contain movement.
// Detection is limited to the regions listed and does not fall back to the
// whole picture when they are unusable, so one mistyped region does not narrow
// the watch: it ends it. Nothing on the camera says so. The stream keeps
// running, the counters keep counting, and majestic.yaml holds exactly what
// was typed.
//
// This module is the decision, kept away from the DOM so it can be tested:
// getting it wrong is silent in the worst way, because every branch of it
// renders a confident-looking chip beside the coordinates -- the shipped
// version printed `0%` for a zero-width region, `1%` for one entirely off the
// picture, and `1085048%` for one bigger than the sensor, all in the same
// quiet grey as a region that works.
(function () {
	'use strict';

	// Four UNSIGNED WHOLE numbers, because that is the whole of what the camera
	// can store -- measured by writing each of these through /api/v1/config and
	// reading back what it did with them, not assumed.
	//
	// The editor used to use `Number`, which accepts more, and the difference
	// was not cosmetic: `-5` parses there as minus five, and the camera stores
	// it as 4294967291. The editor drew a rectangle off the top-left corner
	// while the camera held one four billion pixels to the right. Neither was
	// what was typed, and only one of them was on screen.
	//
	// Each part is trimmed first, because the camera accepts a blank there:
	// `0x0x10x 10` is a region it stores, and calling it invalid here would be
	// the page inventing a rule the camera does not have.
	function parse(s) {
		const p = String(s == null ? '' : s).split('x').map(function (t) {
			return t.trim();
		});
		if (p.length !== 4) return null;
		for (let i = 0; i < 4; i++)
			if (!/^[0-9]+$/.test(p[i])) return null;
		return { x: +p[0], y: +p[1], w: +p[2], h: +p[3] };
	}

	// The part of `r` that is inside a `b`-sized frame, which is the part the
	// camera keeps. Null when nothing of it is.
	function clip(r, b) {
		if (!r || !b || !b.w || !b.h) return null;
		const w = Math.min(r.x + r.w, b.w) - Math.max(r.x, 0);
		const h = Math.min(r.y + r.h, b.h) - Math.max(r.y, 0);
		return w > 0 && h > 0 ? { w: w, h: h } : null;
	}

	// The verdict for one row: a class, the chip's text, and the sentence
	// behind it. `thing` is the caller's noun ("region", "mask") -- the two
	// callers of the editor promise different things and must not share a
	// sentence, but they fail in exactly the same way and can share this.
	//
	// `b` may be null: the frame size has not arrived yet, or the camera has no
	// main resolution set. Then only the two verdicts that need no bounds are
	// available, and the rest is left unsaid rather than guessed. A judgement
	// that cannot be made is not made.
	function verdict(r, b, thing) {
		thing = thing || 'region';
		if (!r) return { cls: 'bad', text: 'not XxYxWxH', title: '' };
		if (!r.w || !r.h)
			return {
				cls: 'bad', text: 'no area',
				title: 'This ' + thing + ' has no width or height, so the camera ' +
					'does nothing with it.',
			};
		if (!b || !b.w || !b.h) return { cls: 'ok', text: '', title: '' };
		const c = clip(r, b);
		const size = b.w + ' × ' + b.h;
		if (!c)
			return {
				cls: 'bad', text: 'off picture',
				title: 'This ' + thing + ' is entirely outside the ' + size +
					' picture, so the camera does nothing with it.',
			};
		// The share of the CLIPPED rectangle, not of the typed one: the clipped
		// one is what is really being watched, and the difference is the whole
		// of what an out-of-bounds region gets wrong.
		const pct = Math.round(c.w * c.h / (b.w * b.h) * 100) + '%';
		if (c.w < r.w || c.h < r.h)
			return {
				cls: 'bad', text: pct + ' · clipped',
				title: 'Part of this ' + thing + ' is outside the ' + size +
					' picture. Only the part inside it counts, and that is the ' +
					'share shown.',
			};
		return { cls: 'ok', text: pct, title: 'share of the frame' };
	}

	// How many rows are regions, and how many of those the camera will do
	// nothing with. Counted from the same verdict the rows print, so the head's
	// count and the list beside it can never disagree. An empty row is not a
	// region yet -- it is the one somebody has just opened to type into.
	function tally(rows, b, thing) {
		let n = 0, bad = 0;
		(rows || []).forEach(function (raw) {
			if (!raw) return;
			n++;
			if (verdict(parse(raw), b, thing).cls === 'bad') bad++;
		});
		return { n: n, bad: bad };
	}

	const api = { parse: parse, clip: clip, verdict: verdict, tally: tally };
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticRegion = api;
})();
