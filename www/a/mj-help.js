// Which of a field's three texts goes where on the settings page, and whether
// the row needs the "?" that opens the rest.
//
// The schema has three documentation tiers. `title` is the NAME beside the
// control. `hint` is what you need in order to DECIDE — what it does, what it
// costs, the unit, the trap — and it stands alone under the control. `help` is
// what you need in order to UNDERSTAND — which clients, which SoCs, why this
// default, what failure looks like — and it is behind a disclosure, so nobody
// pays for it who did not ask.
//
// This is a module, and tested, because every decision in it produces a page
// that looks entirely ordinary when it is wrong. A "?" on a row with nothing
// behind it is indistinguishable from one that works until it is pressed; a
// hint clamped where nothing was hidden is just a shorter hint; and a search
// that stops finding a setting reads as the setting not existing. None of the
// three throws, logs, or can be reproduced without a camera whose schema
// carries the text in question.
//
// It is also the fallback that matters most. No camera in the field emits
// `help` on the day this ships, so the branch that clamps an over-long hint by
// MEASURE is not a consolation path — it is the whole visible feature, and it
// has to be right on its own.
//
// Pure: no DOM, no globals. The caller measures and the caller writes; this
// only answers.
(() => {
	'use strict';

	// How many lines of hint survive a clamp.
	//
	// Measured on the real page, in the hint's own 12.5px/18.125px: one line
	// holds 43 characters at 390px, 48 at 1280px and 63 at 2560px. Four lines
	// is therefore 172, 192 and 252 characters, which sits just above the band
	// where most hints live (48 of 199 are 121-180) and just below the 29 that
	// run past 180 and reach eight to ten lines on a phone.
	//
	// Three lines was the first choice and is wrong: it cuts at 129 characters
	// on a laptop and would put the control on 77 of 199 rows, which is
	// furniture rather than a signal. Five saves nothing worth a control — a
	// ten-line hint would still be five lines of grey under one setting.
	//
	// The number only decides where the cut falls; whether there IS one is
	// always a measurement, so on a wide monitor the control is simply absent
	// from rows that fit. A character threshold cannot have that property.
	const LINES = 4;

	// The text a tier actually carries. A tier is present only if it has
	// something to say: an empty string, whitespace, null and undefined are all
	// absent. This is the guard that stops a daemon emitting `help: ""` from
	// producing a circle that opens an empty box -- the archetypal control that
	// does nothing.
	function text(v) {
		return typeof v === 'string' && v.trim() ? v : '';
	}

	// Which world a field is in. `help` means the disclosure holds the schema's
	// own long text; `clamp` means there is no such text and the disclosure
	// un-cuts the hint instead; `none` means the row is what it always was.
	//
	// `overflowed` is the caller's measurement and has three states, not two --
	// see overflows(). Unknown is treated as "no fold", because the cost of
	// missing one is a long hint, and the cost of guessing is a button that
	// opens nothing.
	function foldOf(sub, overflowed) {
		if (!sub) return 'none';
		if (text(sub.help)) return 'help';
		return overflowed === true ? 'clamp' : 'none';
	}

	// Does this hint need cutting?
	//
	// Asked of the box BEFORE it is clamped, so its rendered height is its
	// content height and there is no scrollHeight/clientHeight dance with
	// -webkit-box, which is the least portable part of this.
	//
	// Three answers. A height of zero is not a hint that fits -- it is a row
	// that is display:none, or a stylesheet that has not arrived, and reading
	// it as "fits" is the mistake this project has a rule about: an absent
	// reading is not a zero. The caller must leave such a row alone rather than
	// clamp it or mark it measured, or a row revealed later keeps a verdict
	// taken while it was invisible.
	function overflows(height, lineHeight, lines) {
		const h = Number(height), lh = Number(lineHeight);
		if (!(lh > 0) || !(h > 0)) return null;
		const n = Number(lines) > 0 ? Number(lines) : LINES;
		// Half a line of slack: getBoundingClientRect returns fractions and a
		// box of exactly `n` lines has been seen to measure a few hundredths
		// over. Anything genuinely past the cut is a whole line taller.
		return h > lh * n + lh / 2;
	}

	// Is the fold open?
	//
	// Two independent reasons, and the OR between them is the whole point. A
	// reader who pressed the "?" must keep their fold through every later
	// keystroke, and a fold the SEARCH opened must close again when the query
	// stops matching. Deciding on the hit alone -- the obvious implementation --
	// slams a hand-opened fold shut the moment somebody types.
	function foldState(userOpen, queryHit) {
		return !!userOpen || !!queryHit;
	}

	// Does this field match the search?
	//
	// The same three texts the page draws, plus the key's own last segment
	// because four of about 170 fields ship no title and renderField falls back
	// to the key for display.
	//
	// `help` is in here for a reason worth stating: the split moves roughly six
	// kilobytes of the most specific prose in the schema out of `hint`, and a
	// search that did not follow it would stop finding settings by the words
	// that best identify them -- silently, since fewer results reads as the
	// setting not existing rather than as a broken index.
	function matches(f, q) {
		if (!f) return false;
		const needle = String(q == null ? '' : q).trim().toLowerCase();
		if (!needle) return true;
		const dot = String(f.dot || '');
		const tail = dot.slice(dot.lastIndexOf('.') + 1);
		return [f.title, f.hint, f.help, tail].some(
			s => String(s == null ? '' : s).toLowerCase().includes(needle));
	}

	const api = { LINES, text, foldOf, overflows, foldState, matches };
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticHelp = api;
})();
