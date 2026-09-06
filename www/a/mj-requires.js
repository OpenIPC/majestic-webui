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
// A second shape carries a precedence rather than a substitution -- the
// day/night keys, where a sensor pin outranks the raw threshold pair, which
// outranks the automatic policy, and a camera with thresholds left over from
// earlier experimentation silently ignored a night gain multiple and both
// automatic delays (OpenIPC/majestic#314, from #325 here):
//
//     "x-requires": {
//       "whenSet": true,
//       "all": [
//         { "field": "nightMode.lightSensorPin", "unset": true,
//           "message": "Not in use while a daylight sensor pin is set: ..." },
//         { "field": "nightMode.minThreshold", "unset": true, "message": "..." },
//         { "field": "nightMode.maxThreshold", "unset": true, "message": "..." }
//       ]
//     }
//
// Every condition must hold and the first unmet one supplies the message, so
// the list is in precedence order; `whenSet` scopes the rule to the annotated
// field holding a value, as `when` scopes a boolean. There is no top-level
// `field`, so a build that predates `all` reads it as satisfied and says
// nothing -- the same degradation `any` chose.
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
	// Has a field no value? Three spellings of one fact, from three sources: a
	// key absent from the config resolves to undefined, a leaf the camera has
	// removed comes back as null, and an emptied number control reads ''. The
	// number 0 is none of them -- pad 0 is a real GPIO, and #273 was filed from
	// exactly a clear that had become 0.
	function isUnset(v) {
		return v === undefined || v === null || v === '';
	}

	function matches(cond, v) {
		if (!cond) return true;
		// Before the stringify below: String(undefined) is 'undefined', a value,
		// and an absent field would count as set. Only `unset: true` is ever
		// served; `unset: false` is accepted for symmetry, but note that met()
		// never gets here for a field no lookup could answer for -- that is
		// the fail-open rule, and it means a rule asking for PRESENCE cannot
		// tell an absent key from an unanswerable one and stays silent.
		if ('unset' in cond) return isUnset(v) === Boolean(cond.unset);
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
	// The condition that fails, or null when the requirement is satisfied.
	// A condition rather than a boolean because `all` carries a message per
	// condition, and notice() has to know which one to show.
	function unmet(req, lookup) {
		if (!req || (!req.field && !Array.isArray(req.any) && !Array.isArray(req.all))) return null;
		lookup = lookup || {};
		const self = () => (typeof lookup.self === 'function' ? lookup.self() : undefined);
		if (req.when !== undefined) {
			const s = self();
			if (s === undefined || String(s) !== String(req.when)) return null;
		}
		// `whenSet` is `when` for a field with no fixed value: the rule applies
		// while the annotated field holds one. An empty control that is being
		// ignored misleads nobody, and a missing self lookup is satisfied for
		// the same reason `when` treats it so.
		if (req.whenSet) {
			const s = self();
			if (s === undefined || isUnset(s)) return null;
		}

		// A list of alternatives, satisfied when any one of them holds.
		//
		// Some rules only bite when two settings coincide, and one equality
		// then says something broader than the camera enforces. Live HLS is
		// the case this was added for: motion recording defeats it only when
		// there IS a recorder running, so `records.mode` alone would grey the
		// switch out on a camera with recording off and tell its owner to
		// change a setting that is already inert.
		//
		// Same fail-open rule as everything else here, applied per
		// alternative: one whose field cannot be resolved satisfies the
		// requirement outright, because a warning drawn from no data is one
		// nothing on the page can clear.
		if (Array.isArray(req.any)) {
			if (!req.any.length) return null;
			const ok = req.any.some(function (alt) {
				if (!alt || !alt.field) return true;
				const av = resolve(alt.field, lookup);
				if (av === undefined) return true;
				return matches(alt, av);
			});
			return ok ? null : req;
		}

		// A list every condition of which must hold: a precedence, where the
		// annotated setting is outranked by any one of several others. The
		// first that fails is the answer, so the list's order is the order of
		// precedence and the note names what actually won. Same fail-open rule
		// per condition: one whose field nothing can answer for holds.
		if (Array.isArray(req.all)) {
			for (const cond of req.all) {
				if (!cond || !cond.field) continue;
				const cv = resolve(cond.field, lookup);
				if (cv === undefined) continue;
				if (!matches(cond, cv)) return cond;
			}
			return null;
		}

		const v = resolve(req.field, lookup);
		if (v === undefined) return null;
		return matches(req, v) ? null : req;
	}

	// Is the requirement satisfied? See unmet() for the rules.
	function met(req, lookup) {
		return unmet(req, lookup) === null;
	}

	// What to tell the operator, or '' when there is nothing to say. A
	// condition that is unmet but carries no message stays silent: an empty
	// warning box is worse than no warning box, and the message is the whole
	// content -- this module has no idea what the field means. A condition
	// inside `all` carries its own; the requirement's is the fallback.
	function notice(req, lookup) {
		const failed = unmet(req, lookup);
		if (!failed) return '';
		return failed.message || (req && req.message) || '';
	}

	const api = {
		matches: matches, resolve: resolve, met: met, unmet: unmet,
		notice: notice, isUnset: isUnset,
	};
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticRequires = api;
})();
