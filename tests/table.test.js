// A list of objects that has no address, as mj-table.js reads one.
//
// The subject fails silently in the worst way available: the canonical form a
// list reduces to IS what gets posted, so a rule that drops a row deletes it
// from the camera, and the page looks exactly the same until the next reload.
// The calibration tables were drawn by the destinations board, whose rule
// keeps only rows with an address — none of theirs have one — so the first
// edit posted an empty list.
'use strict';

const path = require('path');
const { check, group, done } = require('./assert');

const T = require(path.join(__dirname, '..', 'www', 'a', 'mj-table.js'));

group('a cell becomes the type its member declares');

check('an integer cell is a number', T.cellValue('integer', '17500') === 17500);
check('a number cell keeps its fraction', T.cellValue('number', '0.25') === 0.25);
check('a negative number is read', T.cellValue('number', '-4.4e-06') === -4.4e-06);
// Unset and zero are different settings: an empty principal point means the
// centre of the frame, 0 means its left edge.
check('an empty integer cell stays unset, not 0', T.cellValue('integer', '') === '');
check('a blank number cell stays unset', T.cellValue('number', '   ') === '');
// Rounding a fraction would store a value nobody typed; the camera refuses it.
check('a fraction in an integer cell is left as typed',
	T.cellValue('integer', '2.5') === '2.5');
check('text in a number cell is left as typed', T.cellValue('number', 'abc') === 'abc');
check('a boolean cell is a boolean', T.cellValue('boolean', 1) === true);
check('a string cell stays a string', T.cellValue('string', '2.1') === '2.1');

group('no filled row is ever dropped');

const lens = [
	{ focal: 17500, cx: 1296, cy: 972 },
	{ mag: '2.9', focal: 4005 },
];
check('rows with no address survive', T.normalise(lens).length === 2);
check('a half-filled row is kept for the camera to judge',
	T.normalise([{ mag: '2.1' }]).length === 1);
check('a row added and never filled is dropped',
	T.normalise([{ mag: '', focal: '', cx: '' }, { focal: 1 }]).length === 1);
check('empty members are left out of a kept row',
	JSON.stringify(T.normalise([{ mag: ' ', focal: 5 }])) === '[{"focal":5}]');
check('a non-list reads as empty', T.normalise(null).length === 0);

group('the canonical form tracks edits and ignores key order');

check('key order is not a change',
	T.canon([{ focal: 1, mag: '2' }]) === T.canon([{ mag: '2', focal: 1 }]));
check('an edit inside a row is a change',
	T.canon([{ focal: 1 }]) !== T.canon([{ focal: 2 }]));
check('whitespace around a value is not a change',
	T.canon([{ peer: 'cam' }]) === T.canon([{ peer: ' cam ' }]));
check('the canonical form of the saved list round-trips',
	JSON.stringify(JSON.parse(T.canon(lens))) === T.canon(lens));

group('a required member left empty is named');

const props = { focal: { title: 'Focal length' }, mag: { title: 'Magnification' } };
check('a missing required member is named by its title',
	T.missing({ mag: '2.1' }, ['focal'], props).join() === 'Focal length');
check('a filled one is not', T.missing({ focal: 3 }, ['focal'], props).length === 0);
check('no required list, nothing missing', T.missing({}, undefined, props).length === 0);

done();
