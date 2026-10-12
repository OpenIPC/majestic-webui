// Double-tap a point of the picture and the camera turns to put it in the
// middle: click-to-centre, the surveillance clients' way to a fixed target
// (Axis, Milestone, Genetec, Avigilon), where the stick is for following.
//
// It is one counted move per axis -- no speed to choose and no stop that a
// slow link could lose -- so it needs a motor that counts its steps and knows
// how many make a frame of the picture: `frame=WxH` on the capability line
// (majestic-af, from the board's gpiostep.conf).
//
// Pure: no DOM, no fetch. `preview-ptz.js` asks it what the camera offers and
// what to send for a point.
(function (root, factory) {
	const api = factory();
	root.MajesticPtzCentre = api;
	if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this, function () {
	'use strict';

	// The steps a whole frame takes, across and down, or null where the
	// camera does not say.
	function frame(caps) {
		const m = typeof caps === 'string' && / frame=(\d+)x(\d+)(\s|$)/.exec(' ' + caps);
		if (!m) return null;
		const w = +m[1], h = +m[2];
		return w > 0 && h > 0 ? { w: w, h: h } : null;
	}

	// What centres the point `nx`, `ny` (0..1 across and down the frame):
	// the steps per axis (pan + right, tilt + up), the moves that make them,
	// and about how long the head takes. `mount` is how the picture is turned
	// over: a mirrored picture's right is the head's left, a flipped one's up
	// its down. A point within half a step of the middle needs no move on that
	// axis.
	function plan(nx, ny, f, mount) {
		const o = mount || {};
		// Rounded away from the middle alike both ways: Math.round takes -33.5
		// to -33 and 33.5 to 34, a step short to the left and down only.
		const even = (v) => (v < 0 ? -Math.round(-v) : Math.round(v));
		let pan = even((nx - 0.5) * f.w);
		let tilt = even((0.5 - ny) * f.h);
		if (o.mirror) pan = -pan;
		if (o.flip) tilt = -tilt;
		pan = pan || 0;
		tilt = tilt || 0;
		const moves = [];
		if (pan) moves.push({ verb: pan > 0 ? 'right' : 'left', steps: Math.min(Math.abs(pan), 1000) });
		if (tilt) moves.push({ verb: tilt > 0 ? 'up' : 'down', steps: Math.min(Math.abs(tilt), 1000) });
		// How long, for the ring that shows where the head is going: a
		// gpiostep head's pan step is 16 ms and its tilt step 24 ms at the top
		// rate, and the two axes take turns. A guide, not a promise.
		const ms = Math.abs(pan) * 16 + Math.abs(tilt) * 24;
		return { pan: pan, tilt: tilt, moves: moves, ms: ms };
	}

	return { frame: frame, plan: plan };
});
