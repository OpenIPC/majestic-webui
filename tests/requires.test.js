// The x-requires evaluator behind the settings form's "the camera is quietly
// doing something else" warning.
//
// This exists because the subject fails silently, and in the one direction
// that costs the most. If the evaluator wrongly decides a requirement is met,
// no warning draws -- and a form with no warning on it looks exactly like a
// camera doing what it was told. That is the state OpenIPC/majestic#311 was
// filed from, so a bug here does not degrade the fix, it reverts it.
//
// It also cannot be reproduced on demand. Seeing the real thing needs a camera
// with `video1.enabled` false, `outgoing.substream` true and something
// watching the stream to notice the resolution is wrong. Here the schema
// fragments are the ones majestic actually emits and the values are the ones
// its config and schema actually carry, which is the whole point.
'use strict';

const fs = require('fs');
const path = require('path');
const { check, group, done } = require('./assert');

const req = require(path.join(__dirname, '..', 'www', 'a', 'mj-requires.js'));

// The condition majestic emits for outgoing.substream, verbatim. `when` and
// `equals` are both the STRING "true", because the camera's schema annotation
// carries values as strings; the config they are compared against carries
// booleans.
const SUBSTREAM = {
	when: 'true',
	field: 'video1.enabled',
	equals: 'true',
	message: 'The sub stream is disabled, so the main stream is published instead.',
};

// A lookup standing in for a page: `self` is the annotated control's own value
// (substream), `saved` the config behind the other tabs.
const page = (self, cfg) => ({
	self: () => self,
	saved: (dot) => dot.split('.').reduce((o, k) => (o == null ? undefined : o[k]), cfg),
});
const saved = (cfg) => page(true, cfg);

group('the operator compares across JSON types, because the schema and the config disagree');
{
	// The schema says the string "true"; the config says the boolean true; a
	// schema default says the boolean false. Compared untouched, every boolean
	// condition would be false and every warning would be permanently on --
	// or, for `notEquals`, permanently off.
	check('string "true" matches boolean true', req.matches({ equals: 'true' }, true));
	check('string "true" does not match boolean false', !req.matches({ equals: 'true' }, false));
	check('string "false" matches boolean false', req.matches({ equals: 'false' }, false));
	check('numbers compare as text too', req.matches({ equals: '25' }, 25));
	check('notEquals is the mirror', req.matches({ notEquals: 'true' }, false));
	check('notEquals rejects a match', !req.matches({ notEquals: 'true' }, true));
	check('in accepts a member', req.matches({ in: ['h264', 'h265'] }, 'h265'));
	check('in rejects a non-member', !req.matches({ in: ['h264', 'h265'] }, 'mjpeg'));
}

group('an unknown condition holds, so a newer camera degrades to silence');
{
	// A build that does not know an operator must not strand a warning on
	// screen that nothing on the page can clear, nor hide a visibleWhen row it
	// cannot reveal.
	check('an operator from the future holds', req.matches({ startsWith: 'rtmp' }, 'rtsp://x'));
	check('a condition with no operator holds', req.matches({ field: 'video1.enabled' }, false));
	check('no condition at all holds', req.matches(null, false));
	check('a requirement with no field is satisfied', req.met({ equals: 'true' }, saved({})));
	check('a null requirement is satisfied', req.met(null, saved({})));

	// Nothing could answer for the controlling field -- no mounted control, no
	// saved value, no schema default. Warning would be a definite claim made
	// from no data, and nothing on the page could clear it.
	check('an unresolvable controlling field is satisfied',
		req.met(SUBSTREAM, { self: () => true }));
	check('and says nothing', req.notice(SUBSTREAM, { self: () => true }) === '');
}

group('the condition is scoped to the field it annotates');
{
	// Both substream fields default to off. Without `when` the form would
	// announce a substitution on every camera that never asked for one, which
	// is a warning that is always on -- furniture, not information.
	const off = { video1: { enabled: false } };
	check('substream off says nothing', req.notice(SUBSTREAM, page(false, off)) === '');
	check('substream on says it', req.notice(SUBSTREAM, page(true, off)) === SUBSTREAM.message);
	// The control's value is a JSON boolean; `when` is the string "true".
	check('the self value coerces too', !req.met(SUBSTREAM, page(true, off)));
	check('a missing self lookup is satisfied', req.met(SUBSTREAM, {
		saved: () => false,
	}));
	// A condition with no `when` applies whatever the field holds -- the
	// annotation is optional and the old meaning has to survive.
	const always = { field: 'video1.enabled', equals: 'true', message: 'x' };
	check('no when means always', !req.met(always, page(false, off)));
}

group('a value is taken from the page first, then the config, then the schema');
{
	// The controlling field usually lives on another tab, so `saved` is the
	// normal answer. `mounted` exists for the case where both are on screen and
	// the edit has not been saved yet; `fallback` for a section the config file
	// never mentioned.
	const lookup = {
		mounted: (dot) => (dot === 'video1.enabled' ? 'mounted' : undefined),
		saved: (dot) => (dot === 'video1.enabled' ? 'saved' : undefined),
		fallback: (dot) => (dot === 'video1.enabled' ? 'fallback' : undefined),
	};
	check('a mounted control wins', req.resolve('video1.enabled', lookup) === 'mounted');
	check('the saved config is next', req.resolve('video1.enabled', {
		saved: lookup.saved, fallback: lookup.fallback,
	}) === 'saved');
	check('the schema default is last', req.resolve('video1.enabled', {
		fallback: lookup.fallback,
	}) === 'fallback');
	check('nothing to answer with is undefined',
		req.resolve('video1.enabled', {}) === undefined);

	// undefined means "this source cannot answer", not "the value is undefined"
	// -- a lookup that returns it must fall through rather than stop the search.
	check('an undefined mounted value falls through to saved', req.resolve('video1.enabled', {
		mounted: () => undefined, saved: () => 'saved',
	}) === 'saved');
	// ...but a falsy value is an answer, and this is the answer that matters:
	// video1.enabled === false is precisely the case being detected.
	check('a false mounted value stops the search', req.resolve('video1.enabled', {
		mounted: () => false, saved: () => true,
	}) === false);
}

group('the reported case: substream on, video1 off');
{
	const off = saved({ video1: { enabled: false }, outgoing: { substream: true } });
	const on = saved({ video1: { enabled: true }, outgoing: { substream: true } });

	check('the requirement is unmet', !req.met(SUBSTREAM, off));
	check('and the operator is told why', req.notice(SUBSTREAM, off) === SUBSTREAM.message);
	check('with video1 on it is met', req.met(SUBSTREAM, on));
	check('and nothing is said', req.notice(SUBSTREAM, on) === '');

	// A camera whose config predates video1, or a section the form is not
	// showing: the schema default stands in, and it is false, so the warning is
	// still correct.
	check('an absent video1 falls back to the schema default', req.notice(SUBSTREAM, {
		self: () => true,
		saved: () => undefined,
		fallback: () => false,
	}) === SUBSTREAM.message);

	// Editing video1.enabled on the Video tab and coming back without saving
	// should clear the warning, the same way visibleWhen rows react.
	check('an unsaved edit clears it', req.notice(SUBSTREAM, {
		self: () => true,
		mounted: () => true,
		saved: () => false,
	}) === '');
}

group('an unmet requirement with nothing to say stays quiet');
{
	// The message is the entire content of the warning -- this module has no
	// idea what any field means. An empty box under a control is worse than no
	// box, so a condition without one draws nothing even though it is unmet.
	const mute = { when: 'true', field: 'video1.enabled', equals: 'true' };
	const off = saved({ video1: { enabled: false } });
	check('the requirement is still unmet', !req.met(mute, off));
	check('but nothing is drawn', req.notice(mute, off) === '');
}

// The evaluator being right is only half of it: the warning has to reach the
// page. It did not, on the very first camera whose schema carried the
// annotation, and the way it failed is why this check is here rather than a
// note in a review.
//
// renderField() declared the field's value accessors by CAPTURING the widget's
// optional hatches -- `const getValue = control._get ? control._get : ...` --
// which meant they could not be declared until the branch that assigns those
// hatches had run, so they sat at the bottom of the function. The x-requires
// block well above them paints its warning on mount and reads `getValue` to do
// it. A `const` reached before its declaration is a ReferenceError, not an
// undefined, so the throw left renderField, took every field after the
// annotated one with it and the save bar with them: the Outgoing tab rendered
// three of its seven rows and could no longer be saved.
//
// The fix is the reading, not the position. Accessors that reach `control._get`
// / `._set` on every call can be declared before the widget exists, and there
// is then no line in that function above which a field's value may not be read
// -- so a new widget branch or annotation block cannot reintroduce this by
// being written in the wrong place. That is the property worth guarding, and
// the capture form is the one shape that takes it away.
//
// Only a camera running a majestic that emits `x-requires` shows the crash
// itself, so this reads the source instead. It fails loudly when it cannot
// find what it is describing, rather than passing against an empty haystack.
group('renderField reads the widget hatches on call, not at declaration');
{
	const src = fs.readFileSync(
		path.join(__dirname, '..', 'www', 'a', 'mj-settings.js'), 'utf8');
	const start = src.indexOf('function renderField(');
	check('renderField is where it was', start !== -1);

	if (start === -1) {
		// Slicing from -1 would hand the checks below an empty string and they
		// would all report ok. A guard that cannot find its subject says so once
		// and stops, instead of reporting four passes it never made.
		check('SKIPPED: cannot locate renderField', false);
	} else {
		const body = src.slice(start);
		for (const [name, hatch] of [['getValue', '_get'], ['setValue', '_set']]) {
			// The capture form is the bug: `const getValue = control._get ? ...`
			// pins the declaration below the widget dispatch.
			const captured = new RegExp(
				'const\\s+' + name + '\\s*=\\s*control\\.' + hatch + '\\b').test(body);
			check(name + ' does not capture control.' + hatch, !captured);
			// And the hatch has to actually be reached, inside the accessor's
			// own body, or it has stopped honouring the widgets that supply
			// one. Scoped to the declaration because the resolution picker
			// calls `control._get()` too, and a whole-function search would
			// pass on that alone.
			const at = body.indexOf('const ' + name);
			const decl = at === -1 ? '' : body.slice(at, at + 600);
			const called = new RegExp('control\\.' + hatch + '\\s*\\(').test(decl);
			check(name + ' calls control.' + hatch + ' instead', called);
		}
	}
}

// A rule that only bites when two settings coincide.
//
// majestic refuses live HLS on a camera whose recorder is in motion mode,
// because nothing is written between detections and the playlist has no new
// bytes to describe. It does NOT refuse it when the recorder is switched off:
// records.mode then describes nothing that is happening, and HLS serves out of
// memory exactly as it does on a camera with no card.
//
// One controlling field cannot say that. Written as "HLS requires
// records.mode continuous" the form would grey the switch out on a camera with
// recording off and tell its owner to change a setting that is inert — a
// warning about a configuration the camera deliberately allows, which nothing
// on the page can clear. So the condition arrives as alternatives, satisfied
// by either way out of the rule.
// It fails the same silent way the single-field shape does, which is why these
// belong beside those rather than in a suite of their own: get `any` wrong in
// one direction and no warning draws on the camera that needs one; get it wrong
// in the other and a warning sits on a valid camera with nothing on the page
// able to clear it. Neither states an error anywhere. And neither can be
// produced to order — seeing the real thing needs a camera recording on motion
// with HLS switched on, and then the same camera with recording off to prove
// the warning goes away again.
group('a requirement satisfied by any one of several alternatives');
{
	// Exactly what majestic emits, including the absent top-level `field`.
	const HLS = {
		when: 'true',
		any: [
			{ field: 'records.enabled', equals: 'false' },
			{ field: 'records.mode', notEquals: 'motion' },
		],
		message: 'Motion recording writes nothing between detections.',
	};

	const lookup = (hls, enabled, mode) => ({
		self: () => hls,
		saved: (dot) => dot === 'records.enabled' ? enabled
			: dot === 'records.mode' ? mode : undefined,
	});

	check('recording on and in motion mode is the one combination refused',
		req.met(HLS, lookup(true, true, 'motion')) === false);
	check('and it is the only one that says anything',
		req.notice(HLS, lookup(true, true, 'motion')) === HLS.message);

	check('recording off leaves the mode inert, so HLS is fine',
		req.met(HLS, lookup(true, false, 'motion')) === true);
	check('continuous recording is fine',
		req.met(HLS, lookup(true, true, 'continuous')) === true);
	check('and so is recording off in continuous mode',
		req.met(HLS, lookup(true, false, 'continuous')) === true);

	// `when` still scopes it to this field's own value: a camera with HLS off
	// must not be told anything about it.
	check('nothing is said about a switch that is off',
		req.met(HLS, lookup(false, true, 'motion')) === true);

	// Same fail-open rule as a single condition, applied per alternative: an
	// alternative whose field nothing can answer for satisfies the whole
	// requirement, because a warning drawn from no data cannot be cleared.
	check('an unresolvable alternative satisfies it',
		req.met(HLS, { self: () => true, saved: (dot) =>
			dot === 'records.mode' ? 'motion' : undefined }) === true);

	// A malformed or empty list is satisfied rather than stuck on screen.
	check('an empty list of alternatives is satisfied',
		req.met({ when: 'true', any: [] }, { self: () => true }) === true);
	check('a requirement with neither field nor any is satisfied',
		req.met({ when: 'true', message: 'x' }, { self: () => true }) === true);
}


done();
