// Follow a person with the pan/tilt head (ptz.track), as the pad offers it.
//
// The camera turns the head toward the person its NPU detector sees, in counted
// steps. That needs two things the page can ask about: a motor that counts
// steps (the capability line, `GET /ptz`, carries " steps=") and the detector
// switched on (npuDetect.enabled). With either missing the toggle would switch
// a setting that does nothing, so the pad does not offer it.
//
// Pure: no DOM, no fetch. `preview-ptz.js` asks whether to show the toggle,
// what it shows now, and what to POST to /api/v1/config to change it.
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
		return counts(caps) && !!(cfg && cfg.npuDetect && cfg.npuDetect.enabled === true);
	}

	function on(cfg) {
		return !!(cfg && cfg.ptz && cfg.ptz.track === true);
	}

	function body(want) {
		return JSON.stringify({ ptz: { track: !!want } });
	}

	return { offered: offered, on: on, body: body };
});
