// Double-tap a point of the picture and the camera turns to put it in the
// middle: click-to-centre, the surveillance clients' way to a fixed target
// (Axis, Milestone, Genetec, Avigilon), where the stick is for following.
//
// It is one counted move per axis -- no speed to choose and no stop that a
// slow link could lose -- so it needs a motor that counts its steps and knows
// how many make a frame of the picture: `frame=WxH` on GET /ptz's capability
// line, next to `steps=`.
//
// Pure: no DOM, no fetch. `preview-ptz.js` asks it what the camera offers and
// what to send for a point.
(function (root, factory) {
	const PO = typeof module === 'object' && module.exports ? require('./ptz-orient.js') : root.MajesticPtzOrient;
	const api = factory(PO);
	root.MajesticPtzCentre = api;
	if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this, function (PO) {
	'use strict';

	// The steps a whole frame takes, across and down, or null where the
	// camera does not say.
	function frame(caps) {
		const m = typeof caps === 'string' && / frame=(\d+)x(\d+)(\s|$)/.exec(' ' + caps);
		if (!m) return null;
		const w = +m[1], h = +m[2];
		return w > 0 && h > 0 ? { w: w, h: h } : null;
	}

	// What brings the point `nx`, `ny` (0..1 across and down the frame) to
	// `tx`, `ty` -- the middle of what is on screen, which in Fill or a zoom is
	// not the middle of the frame; 0.5, 0.5 when not given: the steps per axis
	// (pan + right, tilt + up), the moves that make them, and about how long
	// the head takes. `turn` is how the picture is turned (ptz-orient.js): a
	// mirrored picture's right is the head's left, and on its side the
	// picture's across is the head's tilt. `pan: false` or `tilt: false` is a
	// head without that axis, which is not asked to turn it. A point within
	// half a step needs no move on that axis.
	function plan(nx, ny, f, opts) {
		const o = opts || {};
		const tx = o.tx >= 0 && o.tx <= 1 ? o.tx : 0.5;
		const ty = o.ty >= 0 && o.ty <= 1 ? o.ty : 0.5;
		return toward(nx - tx, ty - ny, f, o);
	}

	// What moving the picture by `dx`, `dy` -- fractions of the frame as
	// drawn, + right and down -- asks of the head: the content under the
	// finger follows it, as a map does, so a drag to the right turns the head
	// left and a drag down turns it up. Not held to the frame: a drag past its
	// edge is still that far. Same shape and options as plan().
	function drag(dx, dy, f, opts) {
		return toward(-dx, dy, f, opts || {});
	}

	// A turn of the picture by `x`, `y` (fractions of it, + right and up) as
	// the head's: its own direction, then its own frame's steps. The frame is
	// measured upright, so on its side the picture's across takes the head's
	// tilt steps.
	function toward(x, y, f, o) {
		const h = PO.vec(x, y, o.turn);
		return build(h.x * f.w, h.y * f.h, o);
	}

	// The steps (pan + right, tilt + up), the moves that make them, and about
	// how long the head takes, from the wanted turn in steps. `pan: false` or
	// `tilt: false` is a head without that axis, which is not asked to turn it.
	// Within half a step of nothing is nothing; one move is at most MAX steps.
	const MAX = 1000;
	function build(p, t, o) {
		// Rounded away from nothing alike both ways: Math.round takes -33.5
		// to -33 and 33.5 to 34, a step short to the left and down only.
		const even = (v) => (v < 0 ? -Math.round(-v) : Math.round(v));
		const cap = (v) => Math.max(-MAX, Math.min(MAX, v));
		const pan = (o.pan === false ? 0 : cap(even(p))) || 0;
		const tilt = (o.tilt === false ? 0 : cap(even(t))) || 0;
		const moves = [];
		if (pan) moves.push({ verb: pan > 0 ? 'right' : 'left', steps: Math.abs(pan) });
		if (tilt) moves.push({ verb: tilt > 0 ? 'up' : 'down', steps: Math.abs(tilt) });
		// How long, for what shows where the head is going: a gpiostep head's
		// pan step is 16 ms and its tilt step 24 ms at the top rate, and the
		// two axes take turns. A guide, not a promise.
		const ms = Math.abs(pan) * 16 + Math.abs(tilt) * 24;
		return { pan: pan, tilt: tilt, moves: moves, ms: ms };
	}

	return { frame: frame, plan: plan, drag: drag, MAX: MAX };
});
