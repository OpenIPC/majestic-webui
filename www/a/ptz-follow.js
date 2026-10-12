// Follow with the pan/tilt head (ptz.track), as the pad offers it.
//
// The camera turns the head toward what its object detector sees -- people,
// cats and dogs, vehicles, as ptz.trackPeople / trackAnimals / trackVehicles
// on the PTZ settings tab choose -- in counted steps. That needs two things
// the camera's capability line (`GET /ptz`) says: a motor that counts steps
// (" steps=") and something to follow with (" follow=", the classes this
// camera can detect). Following does not need detection's alerts switched on,
// so their setting is not asked. With either token missing the toggle would
// switch a setting that does nothing, so the pad does not offer it.
//
// Pure: no DOM, no fetch. `preview-ptz.js` asks whether to show the toggle,
// what it shows now (view(), on every fresh read of the camera), and what to
// POST to /api/v1/config to change it.
(function (root, factory) {
	const api = factory();
	root.MajesticPtzFollow = api;
	if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this, function () {
	'use strict';

	// The token, as ptz-speed.js reads " speeds=": a whole word on the line.
	function counts(caps) {
		return typeof caps === 'string' && / steps=\d+(\s|$)/.test(' ' + caps);
	}

	// " follow=" and at least one class after it.
	function follows(caps) {
		return typeof caps === 'string' && / follow=[a-z]+(,[a-z]+)*(\s|$)/.test(' ' + caps);
	}

	function offered(caps) {
		return counts(caps) && follows(caps);
	}

	function on(cfg) {
		return !!(cfg && cfg.ptz && cfg.ptz.track === true);
	}

	// Both at once, for a fresh read: whether to show the switch, and how.
	function view(caps, cfg) {
		const show = offered(caps);
		return { show: show, on: show && on(cfg) };
	}

	function body(want) {
		return JSON.stringify({ ptz: { track: !!want } });
	}

	return { offered: offered, on: on, view: view, body: body };
});
