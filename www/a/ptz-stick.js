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
	// `pan: false` or `tilt: false` is a head without that axis: the finger's
	// movement along it counts for nothing, and there are no diagonals.
	function aim(dx, dy, opts) {
		const o = opts || {};
		const radius = o.radius > 0 ? o.radius : 40;
		const dead = o.dead >= 0 && o.dead < radius ? o.dead : radius * 0.2;
		const pan = o.pan !== false, tilt = o.tilt !== false;
		if (!pan) dx = 0;
		if (!tilt) dy = 0;
		const dist = Math.hypot(dx, dy);
		if (!(dist > dead)) return null;
		const angle = Math.atan2(-dy, dx) * 180 / Math.PI;
		const set = o.diagonals && pan && tilt ? ALL : AXES;
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

	// The speed, in percent, for a finger `frac` of the way out. There is no
	// speed setting: how far the thumb goes is the speed, as the surveillance
	// clients' virtual joysticks do it (Avigilon, Senstar, Bosch). The curve is
	// an RC radio's expo -- gentle near the centre, where aiming is fine work,
	// steep towards the rim -- and the rim itself, where the arrows are, is the
	// whole speed. It lands on a few levels only, so a finger that wavers a
	// little does not send a new request for every pixel. The slowest level is
	// as slow as a motor goes: a gpiostep head runs no slower than about ten
	// steps a second, and a tap is still the one-step nudge below that.
	const LEVELS = [10, 15, 20, 30, 45, 65, 85, 100];
	const RIM = 0.85;
	function pct(frac) {
		const f = Math.max(0, Math.min(1, Number(frac) || 0));
		if (f >= RIM) return 100;
		const want = 10 + 90 * Math.pow(f / RIM, 2);
		let best = LEVELS[0];
		for (const l of LEVELS) if (Math.abs(l - want) < Math.abs(best - want)) best = l;
		return best;
	}

	return { verbs: verbs, diagonals: diagonals, aim: aim, pct: pct, CENTRE: CENTRE, LEVELS: LEVELS };
});
