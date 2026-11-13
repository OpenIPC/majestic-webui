// The settings page's third documentation tier, and the control that opens it
// (www/a/mj-help.js).
//
// Every branch here produces a page that looks completely ordinary when it is
// wrong, which is why it is a module and why this file exists.
//
// A "?" on a row with nothing behind it is indistinguishable from a working one
// until somebody presses it. A hint clamped where nothing was hidden is just a
// shorter hint. A fold that slams shut on the next keystroke reads as a
// misclick. And a search that quietly stops covering the text it used to cover
// reads as the setting not existing -- which is the failure that would follow
// the daemon moving six kilobytes of prose from `hint` into `help` with nothing
// on this side following it.
//
// None of the four throws, logs, or can be reproduced without a camera whose
// schema carries the exact text in question -- and on the day this ships, no
// camera emits `help` at all, so the clamp path is the only one anybody sees.
'use strict';

const path = require('path');
const { check, group, done } = require('./assert');

const HELP = require(path.join(__dirname, '..', 'www', 'a', 'mj-help.js'));

// The hint box as the page renders it: 12.5px text on an 18.125px line.
const LH = 18.125;
const lines = (n) => LH * n;

group('which world a field is in');
check('a field with help folds on its help',
	HELP.foldOf({ hint: 'short', help: 'the long one' }, false) === 'help');
check('help wins even when the hint also overflows',
	HELP.foldOf({ hint: 'x'.repeat(400), help: 'the long one' }, true) === 'help');
check('a long hint with no help clamps instead',
	HELP.foldOf({ hint: 'x'.repeat(400) }, true) === 'clamp');
check('a hint that fits is left alone',
	HELP.foldOf({ hint: 'short' }, false) === 'none');
check('no texts at all is nothing',
	HELP.foldOf({}, false) === 'none');
check('a missing field is nothing rather than a throw',
	HELP.foldOf(null, true) === 'none');

// A daemon that emits the key but no words must not produce a circle that opens
// an empty box. That control is worse than no control: it is the one thing a
// reader cannot tell apart from a broken one.
group('an empty help is not help');
check('empty string', HELP.foldOf({ hint: 'h', help: '' }, false) === 'none');
check('whitespace only', HELP.foldOf({ hint: 'h', help: '   \n\t' }, false) === 'none');
check('null', HELP.foldOf({ hint: 'h', help: null }, false) === 'none');
check('a number is not text either',
	HELP.foldOf({ hint: 'h', help: 42 }, false) === 'none');
// ...and the same field, once it overflows, still gets the clamp it deserves.
check('an empty help does not suppress the clamp',
	HELP.foldOf({ hint: 'x'.repeat(400), help: '' }, true) === 'clamp');

group('the clamp threshold, measured rather than counted');
check('exactly four lines fits', HELP.overflows(lines(4), LH, 4) === false);
check('five lines overflows', HELP.overflows(lines(5), LH, 4) === true);
check('three lines fits', HELP.overflows(lines(3), LH, 4) === false);
// getBoundingClientRect returns fractions; a box of exactly four lines has been
// seen to measure a few hundredths over, and a clamp that fired on that would
// cut one line off a hint that fits.
check('a hair over four lines still fits', HELP.overflows(lines(4) + 0.4, LH, 4) === false);
check('a hair under five lines overflows', HELP.overflows(lines(5) - 0.4, LH, 4) === true);
check('the default line count is used when none is given',
	HELP.overflows(lines(5), LH) === true && HELP.overflows(lines(4), LH) === false);
check('four is the default', HELP.LINES === 4);

// The rule this project has a name for: an absent reading is not a zero. A row
// that is display:none measures nothing, and calling that "it fits" would mark
// it judged while it was invisible -- so when it is later revealed it keeps a
// verdict taken about a box that was never laid out.
group('an unmeasurable row is unknown, not fitting');
check('height 0 is null, not false', HELP.overflows(0, LH, 4) === null);
check('and null is not a fold', HELP.foldOf({ hint: 'x'.repeat(400) }, null) === 'none');
check('no line-height is null too', HELP.overflows(lines(9), 0, 4) === null);
check('a line-height that did not parse is null',
	HELP.overflows(lines(9), NaN, 4) === null);
check('a height that did not parse is null',
	HELP.overflows(NaN, LH, 4) === null);

group('the fold stays where the reader put it');
check('a query hit opens a fold nobody touched', HELP.foldState(false, true) === true);
check('clearing the query closes it again', HELP.foldState(false, false) === false);
check('a hand-opened fold stays open under a hit', HELP.foldState(true, true) === true);
// The regression a naive setFold(row, hit) ships: type one character and every
// fold the reader opened by hand disappears.
check('a hand-opened fold survives the query ceasing to match',
	HELP.foldState(true, false) === true);

// A daemon may ship both texts long, and then the row has two things to open.
// One press means both: two marks for one intent would be a reader choosing
// which half of an explanation they wanted.
group('a row can have a long hint AND a help, and one mark opens both');
check('help still decides which world the row is in',
	HELP.foldOf({ hint: 'x'.repeat(400), help: 'and a long one' }, true) === 'help');
check('the hint is still measured in that world',
	HELP.overflows(lines(9), LH, 4) === true);
// The regression this guards: an earlier cut skipped the measurement whenever
// a help was present, so a 10-line hint sat open above a mark that claimed to
// be hiding something.
check('a short hint beside a help is not clamped',
	HELP.overflows(lines(2), LH, 4) === false);

group('the search follows the words wherever they went');
const F = { dot: 'records.encryption', title: 'Encrypt recordings',
	hint: 'What protects a finished clip.', help: 'chip binds every clip to this SoC.' };
check('by title', HELP.matches(F, 'encrypt') === true);
check('by hint', HELP.matches(F, 'finished') === true);
check('by help', HELP.matches(F, 'chip') === true);
check('by the key\'s own last segment', HELP.matches(F, 'encryption') === true);
check('case does not matter', HELP.matches(F, 'CHIP') === true);
check('a word in none of them does not match', HELP.matches(F, 'bitrate') === false);
check('an empty query matches everything', HELP.matches(F, '   ') === true);
check('a missing field does not throw', HELP.matches(null, 'x') === false);
// The guard that says this change did not move existing results: a field with
// no help matches exactly what it matched before.
const NOHELP = { dot: 'video0.bitrate', title: 'Bitrate', hint: 'kbps' };
check('a field with no help still matches its title', HELP.matches(NOHELP, 'bitr') === true);
check('...and its hint', HELP.matches(NOHELP, 'kbps') === true);
check('...and nothing else', HELP.matches(NOHELP, 'chip') === false);

done();
