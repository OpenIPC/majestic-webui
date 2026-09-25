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

group('a number list the camera declares keeps its shape');

const XL = { items: 'integer', labels: ['Threshold', 'Slope', 'Limit'], minimum: [0, 0, 0], maximum: [2047, 15, 2047] };
const cells = T.listCells(XL);
check('one cell per label', cells.length === 3 && cells[1].label === 'Slope');
check('each cell carries its own range', cells[1].max === 15 && cells[2].max === 2047);
check('a 0–2047 cell is not a switch', cells[0].bool === false);
const EN = T.listCells({ items: 'integer', labels: ['1', '2', '3'], minimum: [0, 0, 0], maximum: [1, 1, 1] });
check('a whole 0–1 cell is a switch', EN.every(c => c.bool));
check('a decimal 0–1 cell is not',
	T.listCells({ items: 'number', labels: ['a'], minimum: [0], maximum: [1] })[0].bool === false);
check('no labels, no cells', T.listCells(null).length === 0);

check('commas', T.parseList('15,12,2047', 3).join('|') === '15|12|2047');
check('spaces as the camera also reads them', T.parseList(' 15 12  2047 ', 3).join('|') === '15|12|2047');
check('comma and space together', T.parseList('200, 200, -110', 3).join('|') === '200|200|-110');
check('unset is every cell empty', T.parseList(undefined, 3).join('|') === '||');
check('a number is kept as written', T.parseList('0.103686,1e-06', 2).join('|') === '0.103686|1e-06');

// The round trip is the property that matters: an untouched row must not be
// a change, or Save lights up on a page nobody edited.
check('what the camera stores comes back identical',
	T.joinList(T.parseList('200,200,-110,461,-415,0,0', 7)) === '200,200,-110,461,-415,0,0');
check('every cell empty clears the key', T.joinList(['', ' ', '']) === '');
check('a gap is kept for the camera to refuse', T.joinList(['1', '', '3']) === '1,,3');

group('a text list and a number per row keep what the camera means');

check('servers split on commas', T.splitStrings('stun:a:3478,turn:b:3478').length === 2);
check('and on whitespace', T.splitStrings('stun:a:3478  turn:b:3478').join('|') === 'stun:a:3478|turn:b:3478');
check('nothing is no items', T.splitStrings('').length === 0 && T.splitStrings(null).length === 0);
check('joined with commas, blanks dropped', T.joinStrings(['stun:a', ' ', 'turn:b ']) === 'stun:a,turn:b');
check('no items is the default', T.joinStrings(['', ' ']) === '');
// An empty offset box is no shift; a list of no shifts is no list.
check('an empty box is 0', T.joinRowNumbers(['-10', '', '5']) === '-10,0,5');
check('trailing zeros drop', T.joinRowNumbers(['-3', '0', '']) === '-3');
check('all empty is unset', T.joinRowNumbers(['', '']) === '');

done();
