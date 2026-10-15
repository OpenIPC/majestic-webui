// The counting-line editor's rule for what it writes.
//
// It earns a test because the camera refuses the WHOLE lines string over one
// bad entry, silently: counting then counts no line at all, and nothing on the
// page or the picture says so. And because the "in" arrow is a convention
// (left of first-to-second, with y down) that a sign error reverses without
// anything looking wrong -- a door that counts everyone coming in as going
// out draws exactly the same line.
'use strict';

const path = require('path');
const { check, group, done } = require('./assert');

const L = require(path.join(__dirname, '..', 'www', 'a', 'mj-line.js'));
const MAIN = { w: 1920, h: 1080 };
// What the camera declares for counting.lines in its schema (x-shapes).
const SP = L.spec({ kind: 'lines', maxItems: 8, namePattern: '^[A-Za-z0-9_-]{1,31}$' });

group('the camera\'s string, in and out');
{
	const l = L.parse('door:860,620,1260,620; 10,20,30,40');
	check('two lines', l && l.length === 2);
	check('a named one keeps its name', l[0].name === 'door' && l[0].named);
	check('an unnamed one is called what the camera calls it', l[1].name === 'line2' && !l[1].named);
	check('round trip', L.format(l) === 'door:860,620,1260,620;10,20,30,40');
	check('empty is no lines', Array.isArray(L.parse('')) && L.parse('').length === 0);
	check('three numbers is refused', L.parse('1,2,3') === null);
	check('a name the metrics cannot carry is refused', L.parse('front door:1,2,3,4', SP) === null);
	check('nine lines is refused', L.parse(Array(9).fill('0,0,100,100').join(';'), SP) === null);
	check('an empty name is refused', L.parse(':1,2,3,4') === null);
	check('a coordinate too large to be a number is refused', L.parse('1' + '0'.repeat(400) + ',2,3,4') === null);
	check('a drag\'s fractions are written whole', L.format([{ x1: 1.4, y1: 2.6, x2: 3, y2: 4, named: false }]) === '1,3,3,4');
}

group('the rules are the camera\'s, from its schema');
{
	const none = L.spec(undefined);
	check('nothing declared: no cap and no name rule', none.max === 0 && none.name === null);
	check('nothing declared: a ninth line is not refused here', L.parse(Array(9).fill('0,0,100,100').join(';'), none).length === 9);
	check('a declared cap is kept', L.spec({ maxItems: 3 }).max === 3);
	check('a cap that is not a whole number is no cap', L.spec({ maxItems: '3' }).max === 0);
	check('a pattern that does not compile is no rule', L.spec({ namePattern: '(' }).name === null);
	check('a declared pattern judges a name', L.nameOk(SP, 'door') && !L.nameOk(SP, 'front door'));
	const strict = L.spec({ namePattern: '^door[0-9]$' });
	check('an unnamed line is not judged by the name rule', L.verdict({ name: 'line1', named: false, x1: 0, y1: 540, x2: 1920, y2: 540 }, MAIN, strict) === null);
	check('a named one is', /name/.test(L.verdict({ name: 'line1', named: true, x1: 0, y1: 540, x2: 1920, y2: 540 }, MAIN, strict)));
	check('a bad name is the verdict', /name/.test(L.verdict({ name: 'a b', named: true, x1: 0, y1: 540, x2: 1920, y2: 540 }, MAIN, SP)));
}

group('the in arrow points to the left of first to second');
{
	// Left to right across the picture: in is UP (y smaller).
	const a = L.inArrow({ x1: 100, y1: 400, x2: 500, y2: 400 }, 50);
	check('horizontal, left to right: in is up', a.x1 === 300 && a.y2 < a.y1 && Math.abs(a.x2 - 300) < 1e-9);
	// Top to bottom: in is to the RIGHT (x larger).
	const b = L.inArrow({ x1: 960, y1: 0, x2: 960, y2: 1080 }, 50);
	check('vertical, top to bottom: in is right', b.x2 > b.x1);
	const f = L.flip({ x1: 1, y1: 2, x2: 3, y2: 4, name: 'd', named: true });
	check('flip swaps the ends and keeps the name', f.x1 === 3 && f.y2 === 2 && f.name === 'd');
}

group('lines the camera stores but never counts on');
{
	check('a good line counts', L.verdict({ name: 'door', x1: 0, y1: 540, x2: 1920, y2: 540 }, MAIN) === null);
	check('a dot is too short', /too short/.test(L.verdict({ name: 'a', x1: 5, y1: 5, x2: 6, y2: 6 }, MAIN)));
	check('outside the picture', /outside/.test(L.verdict({ name: 'a', x1: 2000, y1: 0, x2: 2100, y2: 500 }, MAIN)));
	check('both ends outside but passing through counts', L.verdict({ name: 'a', x1: -100, y1: 540, x2: 2100, y2: 540 }, MAIN) === null);
	check('no main size known: only the length is judged', L.verdict({ name: 'a', x1: 2000, y1: 0, x2: 2100, y2: 500 }, null) === null);
}

done();
