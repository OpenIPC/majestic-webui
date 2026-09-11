// What frame rate the camera can actually reach at a given resolution.
//
// The daemon publishes two things on a `fps` field: `maximum`, the best rate
// reachable at SOME resolution, and `x-fps-caps`, a rate per resolution it
// offers. A page that reads only `maximum` — which is every page before this
// module — shows one bound at every resolution, so the control reads the same
// whether you pick 352x288 or 2592x1520. On a camera whose sensor has a binning
// mode at 64 fps and whose encoder manages 26 at full size, that single number
// is wrong at both ends: it promises 64 where the answer is 26, and it hides
// the 64 behind a resolution nobody would guess to try.
//
// Its own file, and pure, for the same reason mj-tree.js is: this fails
// silently. A control bounded wrongly is still a control, a slider that stops
// too early looks exactly like a slider, and reproducing it needs a camera with
// more than one sensor mode. tests/fps-caps.test.js is what can ask it.
(() => {
	'use strict';

	function parseWH(s) {
		const m = /^\s*(\d+)\s*x\s*(\d+)\s*$/i.exec(String(s == null ? '' : s));
		return m ? { w: +m[1], h: +m[2] } : null;
	}

	function isNum(v) { return typeof v === 'number' && !isNaN(v); }

	// The cap for `size`, or null when the field carries no per-size answer.
	//
	// Exact match only. The entries are measured points, not a curve, and the
	// daemon generates one per resolution it actually offers — so a size that is
	// not listed is one nobody measured, and interpolating between two
	// measurements is how a page starts promising rates that were never seen.
	// A caller with no match falls back to `maximum`, which is always safe: the
	// daemon clamps whatever gets past it either way.
	function capFor(sub, size) {
		if (!sub || !Array.isArray(sub['x-fps-caps'])) return null;
		const wh = parseWH(size);
		if (!wh) return null;
		for (const c of sub['x-fps-caps']) {
			if (c && c.w === wh.w && c.h === wh.h && isNum(c.fps) && c.fps > 0)
				return c.fps;
		}
		return null;
	}

	// The bound to put on the control: the per-size answer where there is one,
	// the field's own maximum otherwise.
	function boundFor(sub, size) {
		const cap = capFor(sub, size);
		if (cap !== null) return cap;
		return sub && isNum(sub.maximum) ? sub.maximum : null;
	}

	const api = { capFor, boundFor, parseWH };
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticFps = api;
})();
