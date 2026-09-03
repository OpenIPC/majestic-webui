// Is a setting actually going to do anything?
//
// Some majestic settings are requests rather than decisions: the camera reads
// them, finds the thing they depend on switched off, substitutes something it
// can do, and carries on. `outgoing.substream` is the one this was written for
// -- it publishes the second stream only when `video1.enabled` is true, and
// with video1 off the camera publishes the MAIN stream instead.
//
// That substitution is right. Publishing the main stream beats publishing
// nothing, the setting is a legitimate thing to want, and it starts working
// the moment video1 is switched on. What was wrong is that nothing said it was
// happening. In OpenIPC/majestic#311 a camera published 1080p H.265 at roughly
// four times the bitrate its configuration described, over a link the reporter
// was already troubleshooting; asked to test the setting he toggled it, saw no
// change -- with video1 off both positions mean the same thing -- and reported
// that it made no difference, which reads as the setting not mattering rather
// than as it being inert.
//
// majestic now ships the condition in its schema, beside `x-live` and
// `x-reload`:
//
//     "x-requires": {
//       "field": "video1.enabled",
//       "equals": "true",
//       "message": "The second stream (video1) is disabled, so the main
//                   stream is published instead."
//     }
//
// This module is the decision, kept away from the DOM so it can be tested:
// getting it wrong is silent in the worst way, because a warning that never
// draws looks exactly like a camera doing what it was told.
//
// It also owns the operator that `visibleWhen` uses, so there is one
// implementation of "does this condition hold" rather than two that drift.
(() => {
	'use strict';

	// Does a condition hold for a value?
	//
	// Everything is compared as a string, and that is not laziness: the schema
	// carries `"equals": "true"` (JSON string, because that is what majestic's
	// annotation API takes) while the config carries `true` (JSON boolean) and
	// a schema default carries `false` (JSON boolean). Comparing those
	// untouched would make every boolean condition false, and the symptom would
	// be a warning that never appears -- invisible.
	//
	// An unrecognised operator holds. A frontend must never strand a warning on
	// screen that nothing on the page can clear, nor hide a row it does not
	// understand how to reveal, so a newer schema degrades to silence rather
	// than to noise.
	function matches(cond, v) {
		if (!cond) return true;
		v = String(v);
		if ('equals' in cond) return v === String(cond.equals);
		if ('notEquals' in cond) return v !== String(cond.notEquals);
		if (Array.isArray(cond.in)) return cond.in.map(String).includes(v);
		return true;
	}

	// What a controlling field is worth right now.
	//
	// The order matters and is the same one the settings form applies to
	// visibleWhen: a control mounted on the page wins, so an edit that has not
	// been saved yet is reflected immediately; failing that the saved config;
	// failing that the schema's default, for a section that is not rendered and
	// that the config file never mentioned.
	//
	// `lookup` supplies the three, each returning undefined when it cannot
	// answer. They are passed in rather than reached for because the first is
	// pure DOM and the other two are page state, and none of that belongs in a
	// decision that wants testing. `lookup.self` is separate: it answers for
	// the annotated field itself, which met() consults before anything else.
	function resolve(dot, lookup) {
		lookup = lookup || {};
		const order = ['mounted', 'saved', 'fallback'];
		for (const step of order) {
			if (typeof lookup[step] !== 'function') continue;
			const v = lookup[step](dot);
			if (v !== undefined) return v;
		}
		return undefined;
	}

	// Is the requirement satisfied? A malformed or absent condition counts as
	// satisfied, on the same fail-open reasoning as matches().
	//
	// Two things beyond the condition itself make it satisfied, and both exist
	// because a warning nobody can act on is worse than none:
	//
	//   `when` scopes it to the field's OWN value. Both substream fields
	//   default to off, so a condition testing only the controlling field would
	//   announce a substitution on a camera that never asked for one -- on
	//   every camera, permanently, which is how a warning becomes furniture.
	//
	//   An unresolvable controlling field. If no lookup can answer, a warning
	//   would be a definite claim made from no data, and nothing on the page
	//   could clear it. Same reasoning as an unknown operator holding.
	function met(req, lookup) {
		if (!req || !req.field) return true;
		lookup = lookup || {};
		if (req.when !== undefined) {
			const self = typeof lookup.self === 'function' ? lookup.self() : undefined;
			if (self === undefined || String(self) !== String(req.when)) return true;
		}
		const v = resolve(req.field, lookup);
		if (v === undefined) return true;
		return matches(req, v);
	}

	// What to tell the operator, or '' when there is nothing to say. A
	// condition that is unmet but carries no message stays silent: an empty
	// warning box is worse than no warning box, and the message is the whole
	// content -- this module has no idea what the field means.
	function notice(req, lookup) {
		if (met(req, lookup)) return '';
		return (req && req.message) || '';
	}

	const api = { matches: matches, resolve: resolve, met: met, notice: notice };
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticRequires = api;
})();
