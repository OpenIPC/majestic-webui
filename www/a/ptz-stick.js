// The pad as a thumbstick: where the finger is, relative to the pad's centre,
// says which way the head turns and how fast.
//
// A finger held down and slid a little steers; lifting it to press another
// arrow is what the user asked to be rid of. The distance from the centre
// becomes the speed on a motor that keeps one (`speeds=` on the capability
// line); the direction becomes one of the camera's verbs -- the four axes, or
// eight where the camera lists the diagonals (`verbs=...,upleft,...`).
//
// Pure: no DOM, no fetch. `preview-ptz.js` asks it what the camera can do, and
// for each finger position what to send.
(function (root, factory) {
	const api = factory();
	root.MajesticPtzStick = api;
	if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this, function () {
	'use strict';

	// Each verb's direction, in degrees: 0 is right, 90 up (the screen's y runs
	// down, so it is turned over before it gets here).
	const CENTRE = {
		right: 0, upright: 45, up: 90, upleft: 135,
		left: 180, downleft: -135, down: -90, downright: -45,
	};
	const AXES = ['right', 'up', 'left', 'down'];
	const ALL = ['right', 'upright', 'up', 'upleft', 'left', 'downleft', 'down', 'downright'];
	// How far past its own sector the finger may drift before the verb changes:
	// a finger on the line between two directions would otherwise flip the
	// head between them with every tremor, each flip a request.
	const HYSTERESIS = 10;

	// The verbs on the capability line, or none.
	function verbs(caps) {
		const m = typeof caps === 'string' && / verbs=([a-z,]+)/.exec(' ' + caps);
		return m ? m[1].split(',').filter(Boolean) : [];
	}

	// Can it go diagonally? All four, or it is not offered: a camera listing
	// some would be a camera this was not written for.
	function diagonals(caps) {
		const v = verbs(caps);
		return ['upleft', 'upright', 'downleft', 'downright'].every((d) => v.indexOf(d) >= 0);
	}

	function apart(a, b) {
		const d = Math.abs(a - b) % 360;
		return d > 180 ? 360 - d : d;
	}

	// What a finger `dx`, `dy` pixels from the centre asks for: null inside the
	// dead zone (the head stands still), else the verb and how far out the
	// finger is, 0 at the dead zone's edge to 1 at `radius` and beyond.
	// `prev` is the verb sent last, kept while the finger stays near its sector.
	function aim(dx, dy, opts) {
		const o = opts || {};
		const radius = o.radius > 0 ? o.radius : 40;
		const dead = o.dead >= 0 && o.dead < radius ? o.dead : radius * 0.2;
		const dist = Math.hypot(dx, dy);
		if (!(dist > dead)) return null;
		const angle = Math.atan2(-dy, dx) * 180 / Math.PI;
		const set = o.diagonals ? ALL : AXES;
		const half = 180 / set.length;
		let verb = null;
		if (o.prev && set.indexOf(o.prev) >= 0 && apart(angle, CENTRE[o.prev]) <= half + HYSTERESIS) {
			verb = o.prev;
		} else {
			let best = 360;
			for (const v of set) {
				const d = apart(angle, CENTRE[v]);
				if (d < best) { best = d; verb = v; }
			}
		}
		const frac = Math.min(1, (dist - dead) / (radius - dead));
		return { verb: verb, frac: frac };
	}

	// The speed, in percent, for a finger `frac` of the way out with the pad's
	// own speed setting at `max`: from a third of it near the centre up to all
	// of it at the rim, in steps of ten, so a finger that wavers a little does
	// not send a new request for every pixel.
	function pct(frac, max) {
		const top = max > 0 && max <= 100 ? max : 100;
		const f = Math.max(0, Math.min(1, Number(frac) || 0));
		const p = Math.round(top * (1 / 3 + f * 2 / 3) / 10) * 10;
		return Math.max(10, Math.min(top, p));
	}

	return { verbs: verbs, diagonals: diagonals, aim: aim, pct: pct, CENTRE: CENTRE };
});
