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

const path = require('path');
const { check, group, done } = require('./assert');

const req = require(path.join(__dirname, '..', 'www', 'a', 'mj-requires.js'));

// The condition majestic emits for outgoing.substream, verbatim: `equals` is
// the STRING "true", because the camera's schema annotation carries the value
// as a string.
const SUBSTREAM = {
	field: 'video1.enabled',
	equals: 'true',
	message: 'The second stream (video1) is disabled, so the main stream is published instead.',
};

const saved = (cfg) => ({ saved: (dot) => dot.split('.').reduce((o, k) => (o == null ? undefined : o[k]), cfg) });

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
		saved: () => undefined,
		fallback: () => false,
	}) === SUBSTREAM.message);

	// Editing video1.enabled on the Video tab and coming back without saving
	// should clear the warning, the same way visibleWhen rows react.
	check('an unsaved edit clears it', req.notice(SUBSTREAM, {
		mounted: () => true,
		saved: () => false,
	}) === '');
}

group('an unmet requirement with nothing to say stays quiet');
{
	// The message is the entire content of the warning -- this module has no
	// idea what any field means. An empty box under a control is worse than no
	// box, so a condition without one draws nothing even though it is unmet.
	const mute = { field: 'video1.enabled', equals: 'true' };
	const off = saved({ video1: { enabled: false } });
	check('the requirement is still unmet', !req.met(mute, off));
	check('but nothing is drawn', req.notice(mute, off) === '');
}

done();
