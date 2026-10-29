// What an OSD template's codes mean to the camera this page is talking to.
//
// The line is strftime letters for the clock and, on a camera that has them,
// %{name} or %{name:arg} tokens for its readings: %{temp}, %{ms}, %{exposure},
// %{zoom}, %{meter}, %{drums}. Cameras from before the tokens spelled three
// of those as letters (%f milliseconds, %@ zoom, %$ exposure) and stopped
// drawing the line at the first code they did not know. A newer camera prints
// an unknown code as written instead.
//
// A page served by one camera can be talking to a firmware of another age, so
// which of the two it is comes from the camera itself: the template field's
// hint names %{temp} where the tokens exist. Its own file, and pure, so
// tests/osd-codes.test.js can ask it.
(function () {
	'use strict';

	const CLOCK = 'aAhbBcCedDFgGHIjmMnprRsStTuUWVwxXyYzZ%';
	const TOKENS = ['temp', 'ms', 'exposure', 'zoom', 'meter', 'drums'];

	// Which spelling the camera reads, from the template field's schema.
	function dialect(schema) {
		const s = schema || {};
		const text = String(s.hint || '') + ' ' + String(s.help || '');
		return {
			tokens: text.includes('%{temp}'),
			// %{meter} came before the rest of the tokens
			meter: text.includes('%{meter'),
		};
	}

	// The codes in `t` the camera does not know, as written.
	function unknownCodes(t, d) {
		const letters = d.tokens ? CLOCK : CLOCK + 'f@$';
		const names = d.tokens ? TOKENS : d.meter ? ['meter', 'drums'] : [];
		const bad = [];
		// %% first, so "%%{temp}" is the text it says
		String(t).replace(/%%|%\{([^}:]*)(?::[^}]*)?\}|%[-_0]?(.)/g, (m, name, c) => {
			if (name !== undefined) {
				if (names.indexOf(name) < 0) bad.push(m);
			} else if (c !== undefined && letters.indexOf(c) < 0) {
				bad.push('%' + c);
			}
			return m;
		});
		return bad;
	}

	// What the camera does with a code it does not know, for the warning.
	function unknownEffect(d) {
		return d.tokens ? 'the camera prints it as written, not as a value'
			: 'it prints nothing from there on, so the rest of the line disappears';
	}

	// The template as pieces: each `known` format ({ id, fmt }) where it
	// stands, the rest as words or gaps. Longest match first, or %H:%M would
	// eat the front of %H:%M:%S; and a %% is text, so "%%{temp}" is not a
	// Temperature piece.
	function parse(t, known) {
		const byLength = known.slice().sort((a, b) => b.fmt.length - a.fmt.length);
		const out = [];
		let i = 0, lit = '';
		const flush = () => {
			if (!lit) return;
			// A run of nothing but spaces is a Gap; anything else is words.
			out.push(/^\s+$/.test(lit) ? { id: 'gap', fmt: lit } : { id: 'text', text: lit });
			lit = '';
		};
		while (i < t.length) {
			if (t.startsWith('%%', i)) { lit += '%%'; i += 2; continue; }
			const hit = byLength.find(k => t.startsWith(k.fmt, i));
			if (hit) { flush(); out.push({ id: hit.id, fmt: hit.fmt }); i += hit.fmt.length; }
			else { lit += t[i]; i++; }
		}
		flush();
		return out;
	}

	const api = { CLOCK, TOKENS, dialect, unknownCodes, unknownEffect, parse };
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticOsdCodes = api;
})();
