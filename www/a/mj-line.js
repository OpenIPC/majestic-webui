// The counting lines, as the camera stores them and as a person draws them.
//
// majestic keeps every line in one string -- "[name:]x1,y1,x2,y2" entries
// separated by ';', in main-stream pixels -- and refuses the WHOLE string if
// any entry in it is malformed: counting then counts no line at all, says so
// once in the log, and the page has no other way to find out. So the editor
// never writes a string the camera would refuse, and this module is the rule
// it writes by, kept away from the DOM so it can be tested.
//
// The direction matters as much as the position. "In" is the side to the
// LEFT walking from the first point to the second (in picture coordinates,
// where y grows downwards), which is a convention nobody guesses; the editor
// draws an arrow pointing into the "in" side so the line says which way is
// in, and flipping a line swaps its two points rather than storing a flag.
(function () {
	'use strict';

	// A name labels the camera's metrics, so it is what Prometheus allows in
	// a label value without escaping, and what majestic accepts.
	const NAME = /^[A-Za-z0-9_-]{1,31}$/;

	// The camera's string to lines: [{name, x1, y1, x2, y2, named}], or null
	// for a string the camera would refuse. An unnamed entry gets the name
	// the camera gives it, line<N>, and `named: false` so writing it back
	// does not turn the camera's default into a name somebody chose.
	function parse(s) {
		const out = [];
		const text = String(s == null ? '' : s);
		for (const raw of text.split(';')) {
			const e = raw.trim();
			if (!e) continue;
			let name = null, rest = e;
			const colon = e.indexOf(':');
			if (colon >= 0) {
				name = e.slice(0, colon);
				rest = e.slice(colon + 1);
				if (!NAME.test(name)) return null;
			}
			const p = rest.split(',').map((t) => t.trim());
			if (p.length !== 4 || p.some((t) => !/^-?[0-9]+(\.[0-9]+)?$/.test(t))) return null;
			const n = p.map(Number);
			out.push({
				name: name || 'line' + (out.length + 1),
				named: name !== null,
				x1: n[0], y1: n[1], x2: n[2], y2: n[3],
			});
		}
		if (out.length > 8) return null;
		return out;
	}

	// Lines back to the camera's string. Coordinates are written whole: the
	// camera's pixels are whole, and a drag produces fractions nobody chose.
	function format(lines) {
		// A line somebody named keeps its name; one they did not is written
		// unnamed, so the camera numbers it by position as it always has.
		return (lines || []).map((l) => {
			const c = [l.x1, l.y1, l.x2, l.y2].map((v) => Math.round(v)).join(',');
			return (l.named ? l.name + ':' : '') + c;
		}).join(';');
	}

	// What the camera will do with one line, against the main stream's size
	// `b` ({w, h}, or null when it is not known): null when it counts, else
	// the sentence for why it does not. A line too short to cross, or one with
	// no part inside the picture, is stored and never counts anything.
	function verdict(l, b) {
		if (!l) return 'This line is not one the camera can read.';
		if (!NAME.test(l.name)) return 'Its name can only have letters, digits, - and _.';
		const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
		if (len < 8) return 'This line is too short for anyone to cross it.';
		if (b && b.w && b.h) {
			const out = (x, y) => x < 0 || y < 0 || x > b.w || y > b.h;
			if (out(l.x1, l.y1) && out(l.x2, l.y2) && !crossesFrame(l, b))
				return 'This line is outside the picture, so nobody can cross it.';
		}
		return null;
	}

	// Whether a segment with both ends outside the frame still passes through
	// it: the Liang-Barsky clip of the segment against [0,w] x [0,h] leaves
	// something.
	function crossesFrame(l, b) {
		let t0 = 0, t1 = 1;
		const dx = l.x2 - l.x1, dy = l.y2 - l.y1;
		const edges = [[-dx, l.x1], [dx, b.w - l.x1], [-dy, l.y1], [dy, b.h - l.y1]];
		for (const [p, q] of edges) {
			if (p === 0) {
				if (q < 0) return false;
				continue;
			}
			const r = q / p;
			if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
		}
		return t1 > t0;
	}

	// Where the "in" arrow goes, in the same coordinates as the line: from the
	// midpoint, `len` along the unit normal pointing to the in side. With y
	// down, left of (dx, dy) is (dy, -dx).
	function inArrow(l, len) {
		const dx = l.x2 - l.x1, dy = l.y2 - l.y1;
		const n = Math.hypot(dx, dy) || 1;
		const mx = (l.x1 + l.x2) / 2, my = (l.y1 + l.y2) / 2;
		return { x1: mx, y1: my, x2: mx + (dy / n) * len, y2: my + (-dx / n) * len };
	}

	// The same line pointing the other way: "in" becomes "out".
	function flip(l) {
		return Object.assign({}, l, { x1: l.x2, y1: l.y2, x2: l.x1, y2: l.y1 });
	}

	const api = { parse: parse, format: format, verdict: verdict, inArrow: inArrow, flip: flip, NAME: NAME };
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticLine = api;
})();
