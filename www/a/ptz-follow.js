// Follow a person with the pan/tilt head (ptz.track), as the pad offers it.
//
// The camera turns the head toward the person its object detector sees, in
// counted steps. That needs two things the page can ask about: a motor that
// counts steps (the capability line, `GET /ptz`, carries " steps=") and the
// detector switched on and reporting people (objectDetect.enabled, and
// objectDetect.people not off). With either missing the toggle would switch a
// setting that does nothing, so the pad does not offer it.
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

	function offered(caps, cfg) {
		const od = cfg && cfg.objectDetect;
		return counts(caps) && !!(od && od.enabled === true && od.people !== false);
	}

	function on(cfg) {
		return !!(cfg && cfg.ptz && cfg.ptz.track === true);
	}

	// Both at once, for a fresh read: whether to show the switch, and how.
	function view(caps, cfg) {
		const show = offered(caps, cfg);
		return { show: show, on: show && on(cfg) };
	}

	function body(want) {
		return JSON.stringify({ ptz: { track: !!want } });
	}

	return { offered: offered, on: on, view: view, body: body };
});
