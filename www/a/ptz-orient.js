// Which way the head turns for a direction on the picture, however the
// picture is turned over (#691).
//
// The motors know nothing of how the picture is drawn: right is the head's
// right whatever image.mirror says. A camera hung upside down and put back
// upright with mirror and flip turned its head left for the right arrow and
// down for the up one, and on its side, with a quarter turn in force, the
// pan arrows tilted it. Every way the Live page steers -- the arrows, the arrow
// keys, the stick, a double-tap, a drag -- names a direction on the picture,
// and this is the one place that turns it into the head's.
//
// The order is the camera's, measured on an hi3516av300: the sensor mirrors
// and flips, and the quarter turn comes after, clockwise. With a quarter turn
// in force a mirror shows as the picture turned top to bottom, not left to
// right, so it is undone after the turn, never before.
//
// Pure: no DOM, no fetch. Vectors are (x right, y up).
(function (root, factory) {
	const api = factory();
	root.MajesticPtzOrient = api;
	if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this, function () {
	'use strict';

	// The camera's image section, as /api/v1/config.json gives it, read into
	// how the picture is turned -- or null, for a reading that is not one: no
	// image section is a camera not heard from, not one that is upright.
	//
	// The camera's config.json carries all three whether set or at their
	// defaults, so one that is missing, or not of its type, is a reading that
	// went wrong -- never upright by default.
	function of(image) {
		if (!image || typeof image !== 'object') return null;
		if (typeof image.mirror !== 'boolean' || typeof image.flip !== 'boolean') return null;
		const r = String(image.rotate);
		if (['0', '90', '180', '270'].indexOf(r) < 0) return null;
		return { mirror: image.mirror, flip: image.flip, rotate: +r };
	}

	// The head's direction for one on the picture. The picture is the sensor's
	// image mirrored and flipped, then turned clockwise; going back, the turn
	// is undone first. No turn known is the picture taken as upright.
	function vec(x, y, t) {
		if (!t) return { x: x, y: y };
		let a = x, b = y;
		// Clockwise by r is undone counter-clockwise by r.
		if (t.rotate === 90) { a = -y; b = x; }
		else if (t.rotate === 180) { a = -x; b = -y; }
		else if (t.rotate === 270) { a = y; b = -x; }
		if (t.mirror) a = -a;
		if (t.flip) b = -b;
		// -0 is a zero; a request would print it as one, but a test would not.
		return { x: a || 0, y: b || 0 };
	}

	const VEC = {
		right: [1, 0], upright: [1, 1], up: [0, 1], upleft: [-1, 1],
		left: [-1, 0], downleft: [-1, -1], down: [0, -1], downright: [1, -1],
	};
	// Is this verb a direction, rather than zoom, focus, stop or autofocus?
	const direction = (v) => Object.prototype.hasOwnProperty.call(VEC, v);

	// The head's verb for one on the picture. Anything that is not a
	// direction -- zoom, focus, stop, autofocus -- passes as it came.
	function verb(v, t) {
		const d = VEC[v];
		if (!d) return v;
		const h = vec(d[0], d[1], t);
		for (const k in VEC) if (VEC[k][0] === h.x && VEC[k][1] === h.y) return k;
		return v;
	}

	// Which directions on the picture the head can follow, from the axes it
	// has: on its side, the picture's across is the head's tilt.
	function axes(pan, tilt, t) {
		const side = !!t && (t.rotate === 90 || t.rotate === 270);
		return side ? { across: tilt, down: pan } : { across: pan, down: tilt };
	}

	return { of: of, vec: vec, verb: verb, direction: direction, axes: axes };
});
