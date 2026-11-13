// A list of objects the camera declares, read as a table: one row per item, one
// cell per member `items` names.
//
// The destinations board in mj-settings.js draws the one object list that has
// an address to read (items with a `url` member). Every other object list — the
// calibration lens table, its peers, its pairings — is plain data, and until
// this file it was drawn by that board anyway: every member hidden behind an
// address the row does not have, a warning under every saved row that it would
// be ignored, and a canonical form that drops any row without an address. That
// last one is the dangerous part: the first edit to such a table posted `[]`
// and deleted every row the camera held.
//
// What lives here is the part that fails silently when it is wrong: how a cell
// becomes a value of the member's declared type, which rows are kept, and what
// the list reduces to for change tracking. Kept away from the DOM so
// tests/table.test.js can ask it.
(function () {
	'use strict';

	// The value a cell holds, in the type `items` declares for its member.
	//
	// An empty cell stays '' rather than becoming 0: an unset member and a zero
	// are different settings (a principal point left empty means the centre of
	// the frame; 0 is its left edge), and tidy() drops the empty one so the
	// camera answers from its own default. Text that is not a number is kept
	// as typed, so the camera refuses the save instead of the page storing a
	// number nobody wrote.
	function cellValue(type, raw) {
		if (type === 'boolean') return !!raw;
		if (type === 'integer' || type === 'number') {
			const s = typeof raw === 'string' ? raw.trim() : raw;
			if (s === '' || s === null || s === undefined) return '';
			const n = Number(s);
			if (!Number.isFinite(n)) return raw;
			if (type === 'integer' && !Number.isInteger(n)) return raw;
			return n;
		}
		return raw === null || raw === undefined ? '' : String(raw);
	}

	// One row, tidied: strings trimmed, empty members left out.
	function tidy(row) {
		const out = {};
		if (!row || typeof row !== 'object') return out;
		Object.keys(row).forEach(function (k) {
			const v = row[k];
			if (v === undefined || v === null) return;
			if (typeof v === 'string') {
				const t = v.trim();
				if (t !== '') out[k] = t;
				return;
			}
			out[k] = v;
		});
		return out;
	}

	// The list as it is saved. The only row dropped is one with nothing in it
	// at all — a row added and never filled. A half-filled row is kept: it is
	// something somebody typed, and the camera is the one to refuse it.
	function normalise(rows) {
		if (!Array.isArray(rows)) return [];
		return rows.map(tidy).filter(function (r) {
			return Object.keys(r).length > 0;
		});
	}

	// What the list reduces to for change detection: one string, keys in a
	// fixed order so retyping a row's members in a different order is not a
	// change.
	function canon(rows) {
		return JSON.stringify(normalise(rows).map(function (r) {
			const o = {};
			Object.keys(r).sort().forEach(function (k) { o[k] = r[k]; });
			return o;
		}));
	}

	// The titles of the members `required` names that this row leaves empty.
	// Advisory only: the page says so under the row and still sends it.
	function missing(row, required, props) {
		if (!Array.isArray(required)) return [];
		const t = tidy(row);
		return required.filter(function (m) { return !(m in t); })
			.map(function (m) { return (props && props[m] && props[m].title) || m; });
	}

	// ---- A fixed-length number list kept as text (x-list) ----------------
	//
	// "200,200,-110,461,-415,0,0" in the camera's config, seven labelled boxes
	// on the page. The camera declares the count, each cell's name and range,
	// and whether they are whole numbers; it refuses a list that breaks any of
	// it, so what matters here is only that the page never changes a list on
	// its way through — an untouched row must read back exactly as it came.

	function num(v) { return typeof v === 'number' && Number.isFinite(v); }

	// The cells, one per number. A whole-number cell whose range is exactly
	// 0 to 1 is a switch.
	function listCells(xl) {
		if (!xl || !Array.isArray(xl.labels)) return [];
		const integer = xl.items === 'integer';
		const mins = Array.isArray(xl.minimum) ? xl.minimum : [];
		const maxs = Array.isArray(xl.maximum) ? xl.maximum : [];
		return xl.labels.map(function (label, i) {
			const min = num(mins[i]) ? mins[i] : null;
			const max = num(maxs[i]) ? maxs[i] : null;
			return {
				label: String(label), min: min, max: max, integer: integer,
				bool: integer && min === 0 && max === 1,
			};
		});
	}

	// The stored text as `n` cells, each the number as it was written ('' for
	// one that is not there). Commas or whitespace between numbers, as the
	// camera reads them.
	function parseList(v, n) {
		const out = [];
		const parts = (v === null || v === undefined) ? []
			: String(v).trim().split(/[\s,]+/).filter(function (t) { return t !== ''; });
		for (let i = 0; i < n; i++) out.push(i < parts.length ? parts[i] : '');
		return out;
	}

	// The cells back as the text the camera stores: comma-joined, no spaces,
	// which is how it writes them. Every cell empty is '' — the key cleared,
	// the camera's own value standing. A partly filled list keeps its gaps and
	// goes to the camera as typed, to be refused there rather than guessed at
	// here.
	function joinList(cells) {
		const t = (cells || []).map(function (c) {
			return c === null || c === undefined ? '' : String(c).trim();
		});
		if (t.every(function (c) { return c === ''; })) return '';
		return t.join(',');
	}

	// ---- A list of text items kept comma-joined (x-strings) --------------

	// The items, commas or whitespace between them as the camera reads them.
	function splitStrings(v) {
		if (v === null || v === undefined) return [];
		return String(v).split(/[\s,]+/).filter(function (t) { return t !== ''; });
	}

	// The items back as the camera stores them; blank rows are dropped, and
	// no items at all is '' — the camera's own default.
	function joinStrings(items) {
		return (items || []).map(function (t) { return String(t).trim(); })
			.filter(function (t) { return t !== ''; }).join(',');
	}

	// One number per row of a sibling list (x-row-of), as stored: an empty
	// box is 0 — no shift, which is what a missing number means to the camera
	// — and trailing zeros are dropped, so a list nobody filled in is ''.
	function joinRowNumbers(cells) {
		const t = (cells || []).map(function (c) {
			const s = c === null || c === undefined ? '' : String(c).trim();
			return s === '' ? '0' : s;
		});
		while (t.length && Number(t[t.length - 1]) === 0) t.pop();
		return t.join(',');
	}

	const api = {
		cellValue: cellValue, tidy: tidy, normalise: normalise,
		canon: canon, missing: missing,
		listCells: listCells, parseList: parseList, joinList: joinList,
		splitStrings: splitStrings, joinStrings: joinStrings,
		joinRowNumbers: joinRowNumbers,
	};
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticTable = api;
})();
