// How fast a pan/tilt move runs, as the pad asks for it.
//
// `POST /ptz?move=<verb>&speed=<1..100>` sets a move's speed as a percentage of
// the lens's top rate, but only a motor driver that says so on its capability
// line (`GET /ptz`, " speeds=1-100") keeps it -- a gpiostep pan/tilt head. Every
// other lens has one speed, and the pad offers no control for it there rather
// than a slider that changes nothing.
//
// Pure: no DOM, no fetch. `preview-ptz.js` asks it two things: whether to show
// the control at all, and what to add to a move's query.
(function (root, factory) {
	const api = factory();
	root.MajesticPtzSpeed = api;
	if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this, function () {
	'use strict';

	// Speeds apply to pan and tilt: a zoom or focus motor is never driven at one.
	const PAN_TILT = { up: 1, down: 1, left: 1, right: 1 };

	// Does the capability line offer a speed? The token, not a substring: the
	// serial lenses' line carries "speed=<baud>", which is not this.
	function offered(caps) {
		return typeof caps === 'string' && / speeds=\d+-\d+(\s|$)/.test(' ' + caps);
	}

	// What a move of `verb` adds to its query at `pct` percent: nothing at the
	// top rate (100) or for a verb that has no speed, so the request is the one
	// every camera already understands; otherwise "&speed=<n>", n whole, 1..99.
	function query(verb, pct) {
		if (!PAN_TILT[verb]) return '';
		const n = Math.round(Number(pct));
		if (!isFinite(n) || n >= 100) return '';
		return '&speed=' + (n < 1 ? 1 : n);
	}

	return { offered: offered, query: query };
});
