// The head's stored positions (Pelco-D presets), as the pad offers them.
//
// A Pelco-D pan/tilt head stores positions itself and drives back to one on
// command. The camera's capability line (`GET /ptz`) says how many it offers,
// " presets=1-N"; without that token the head has none and the pad shows no
// presets at all. The head cannot list which numbers are in use, so the camera
// keeps a name for each one stored through it, as rows of ptz.presets
// ({number, name}); those are what the pad lists. Preset 1 is listed as Home:
// on the bases this was written for it is the position the head returns to by
// itself, so it is always there to go to, and storing over it is confirmed.
//
// Pure: no DOM, no fetch. `preview-ptz.js` asks how many the head offers, what
// to list, which number a new one takes, and what to POST to /ptz.
(function (root, factory) {
	const api = factory();
	root.MajesticPtzPresets = api;
	if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this, function () {
	'use strict';

	// " presets=1-N", a whole word on the line, N 1..255; 0 when absent.
	function offered(caps) {
		if (typeof caps !== 'string') return 0;
		const m = / presets=1-(\d{1,3})(\s|$)/.exec(' ' + caps);
		const n = m ? parseInt(m[1], 10) : 0;
		return n >= 1 && n <= 255 ? n : 0;
	}

	// The rows the camera keeps, numbered 1..max and named, by number; Home
	// first, named or not.
	function list(cfg, max) {
		const rows = cfg && cfg.ptz && Array.isArray(cfg.ptz.presets) ? cfg.ptz.presets : [];
		const seen = new Set();
		const out = [];
		for (const r of rows) {
			const n = r && Number.isInteger(r.number) ? r.number : 0;
			if (n < 1 || n > max || seen.has(n)) continue;
			seen.add(n);
			const name = r && typeof r.name === 'string' && r.name.trim() ? r.name.trim() : 'Preset ' + n;
			out.push({ number: n, name: n === 1 ? 'Home: ' + name : name });
		}
		if (max >= 1 && !seen.has(1)) out.push({ number: 1, name: 'Home' });
		out.sort((a, b) => a.number - b.number);
		return out;
	}

	// The number a new preset takes: the lowest from 2 with no row, 0 when
	// every one the head offers has one. 1 is Home, never taken by default.
	function freeNumber(cfg, max) {
		const rows = cfg && cfg.ptz && Array.isArray(cfg.ptz.presets) ? cfg.ptz.presets : [];
		const used = new Set(rows.map(r => (r && Number.isInteger(r.number) ? r.number : 0)));
		for (let n = 2; n <= max; n++) if (!used.has(n)) return n;
		return 0;
	}

	// The request for one command: op is 'go', 'set' or 'clear'.
	function query(op, n, name) {
		let q = '/ptz?preset=' + encodeURIComponent(String(n)) + '&action=' + encodeURIComponent(op);
		if (op === 'set' && typeof name === 'string' && name.trim())
			q += '&name=' + encodeURIComponent(name.trim());
		return q;
	}

	return { offered: offered, list: list, freeNumber: freeNumber, query: query };
});
