// The words a <select> puts on an enum member, and the width it is given for
// them.
//
// Majestic's enums are machine tokens — `auto`, `off`, `pwm1` — and a page
// that prints one raw asks the reader to work out the behaviour from four
// letters. `x-enum-titles` lets the daemon name a member the way `title`
// names a row, and the whole of it fails silently:
//
//   * a map the reader refuses — the wrong shape, an empty string, a member it
//     does not mention — falls back to the token, which is exactly what the
//     page looked like before the title existed. Nothing throws and nothing
//     logs; the option just says `auto` again.
//   * a select does not wrap, it truncates. The row's width cap is chosen from
//     the length of the options, and choosing it from the VALUES while
//     drawing the TITLES clips a long title to "Follows day/nig" with no
//     symptom anywhere but the pixels.
//
// Neither is reproducible on demand: it needs a camera whose schema carries
// the annotation, and the fallback is by construction indistinguishable from
// the old page. The function is lifted out of the shipped file rather than
// copied here, so a change to it is what this measures.
'use strict';

const fs = require('fs');
const path = require('path');
const { check, group, done } = require('./assert.js');

const SRC = fs.readFileSync(
	path.join(__dirname, '..', 'www', 'a', 'mj-settings.js'), 'utf8');

const from = SRC.indexOf('\tfunction enumTitle(sub, v) {');
const to = SRC.indexOf('\n\t}\n', from);
const enumTitle = from > 0 && to > from
	? new Function(SRC.slice(from, to + 3) + '\nreturn enumTitle;')()
	: null;

group('the title a member goes by');
{
	check('the function is where the test can reach it', typeof enumTitle === 'function');

	const sub = {
		enum: ['off', 'manual', 'auto'],
		'x-enum-titles': { auto: 'Follows day/night' },
	};
	check('a titled member says its title', enumTitle(sub, 'auto') === 'Follows day/night');
	// A schema naming one member and leaving the obvious ones is the point of
	// a map: the others must still draw, as themselves.
	check('an untitled member of a titled enum says nothing',
		enumTitle(sub, 'off') === '' && enumTitle(sub, 'manual') === '');
	check('and a schema with no map at all says nothing',
		enumTitle({ enum: ['off'] }, 'off') === '');
	check('nor does a missing schema throw', enumTitle(null, 'off') === '' &&
		enumTitle(undefined, 'off') === '');

	// Every one of these is a title that would blank the option it names.
	check('an empty title is not a title',
		enumTitle({ 'x-enum-titles': { auto: '' } }, 'auto') === '');
	check('neither is whitespace',
		enumTitle({ 'x-enum-titles': { auto: '   ' } }, 'auto') === '');
	check('neither is a non-string',
		enumTitle({ 'x-enum-titles': { auto: 7 } }, 'auto') === '' &&
		enumTitle({ 'x-enum-titles': { auto: null } }, 'auto') === '');

	// The shape somebody writes on the first try. Read as a map it is indexed
	// by the member's value, which is nonsense for a string enum and quietly
	// plausible for a numeric one — and then relabels by position the day the
	// daemon inserts a member.
	check('a parallel list is refused, not indexed',
		enumTitle({ 'x-enum-titles': ['Off', 'Manual', 'Follows day/night'] }, 0) === '' &&
		enumTitle({ 'x-enum-titles': ['Off', 'Manual'] }, '1') === '');
	check('and so is a map that is not an object',
		enumTitle({ 'x-enum-titles': 'Follows day/night' }, 'auto') === '');

	// A member named after something on Object's prototype would otherwise
	// hand back a function and read as a title of some sort.
	check('an inherited property is not a title',
		enumTitle({ 'x-enum-titles': {} }, 'constructor') === '' &&
		enumTitle({ 'x-enum-titles': {} }, 'toString') === '');

	// majestic writes enum members as strings, but nothing stops a numeric
	// one, and a map keyed by the number has to answer for it.
	check('a numeric member is keyed by its own text',
		enumTitle({ 'x-enum-titles': { 2: 'Two' } }, 2) === 'Two');
}

group('and the width the row is given for them');
{
	// The cap is a class on the row, decided before the options exist, so
	// there is no measurement to fall back on: it has to be chosen from the
	// same strings the options will carry.
	const at = SRC.indexOf("p = el('p', 'select mj-row');");
	const block = at > 0 ? SRC.slice(at, at + 2400) : '';
	check('the select row is still built where this can find it', at > 0);
	check('the option words are worked out before the width is chosen',
		block.indexOf('const optText = enumVals.map(') > 0 &&
		block.indexOf('const optText') < block.indexOf('mj-wide'));
	check('and the width cap is decided on those words, not on the values',
		/optText\.some\(\w+ => \w+\.length > 14\)/.test(block) &&
		!/enumVals\.some\(o => String\(o\)\.length > 14\)/.test(block));
	check('the options themselves are drawn from the same words',
		/enumVals\.map\(\(o, i\) => option\(o,[^;]*optText\[i\]\)\)/.test(block));
}

done();
