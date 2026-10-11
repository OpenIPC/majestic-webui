// The pad as a thumbstick (www/a/ptz-stick.js).
//
// What fails silently here: a diagonal sent to a camera that has none (the
// request is refused and the head stands still while the finger says go), a
// finger on the line between two directions flipping the head between them,
// and a speed that changes with every pixel the finger wavers -- each change
// a request over a link that may be a 4G relay.
const { check, done } = require('./assert.js');
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got));
const S = require('../www/a/ptz-stick.js');

const NEW = 'actuator=gpiostep pulse=500 state=ready verbs=stop,up,down,left,right,upleft,upright,downleft,downright speeds=1-100 steps=1';
const OLD = 'actuator=gpiostep pulse=500 state=ready verbs=stop,up,down,left,right speeds=1-100 steps=1';
eq('a plugin with the diagonals offers them', S.diagonals(NEW), true);
eq('an older plugin does not', S.diagonals(OLD), false);
eq('no answer offers none', S.diagonals(undefined), false);
eq('three of four is not an offer', S.diagonals('verbs=stop,upleft,upright,downleft'), false);
eq('the verbs are read off the line', S.verbs(OLD), ['stop', 'up', 'down', 'left', 'right']);

const R = { radius: 40, dead: 8 };
const at = (dx, dy, more) => S.aim(dx, dy, Object.assign({}, R, more));
eq('inside the dead zone the head stands still', at(5, -5), null);
eq('the centre is still', at(0, 0), null);
eq('right of centre is right', at(30, 0).verb, 'right');
eq('above the centre is up (screen y runs down)', at(0, -30).verb, 'up');
eq('below is down', at(0, 30).verb, 'down');
eq('left is left', at(-30, 0).verb, 'left');

eq('up and right with diagonals is upright', at(20, -20, { diagonals: true }).verb, 'upright');
eq('down and left with diagonals is downleft', at(-20, 20, { diagonals: true }).verb, 'downleft');
eq('without diagonals the stronger axis wins', at(25, -15).verb, 'right');
eq('without diagonals, the other way', at(15, -25).verb, 'up');
eq('a previous diagonal is not kept where there are none', at(20, -19, { prev: 'upright' }).verb, 'right');

// 30 degrees above right: nearer right than upright (45) by sector, but within
// right's sector plus the margin when right was what was sent.
const a30 = [Math.cos(Math.PI / 6) * 30, -Math.sin(Math.PI / 6) * 30];
eq('30 degrees, fresh, is upright with diagonals', at(a30[0], a30[1], { diagonals: true }).verb, 'upright');
eq('30 degrees after right stays right', at(a30[0], a30[1], { diagonals: true, prev: 'right' }).verb, 'right');
const a40 = [Math.cos(40 * Math.PI / 180) * 30, -Math.sin(40 * Math.PI / 180) * 30];
eq('40 degrees after right changes to upright', at(a40[0], a40[1], { diagonals: true, prev: 'right' }).verb, 'upright');
const a50 = [Math.cos(50 * Math.PI / 180) * 30, -Math.sin(50 * Math.PI / 180) * 30];
eq('four-way: 50 degrees after right stays right', at(a50[0], a50[1], { prev: 'right' }).verb, 'right');
const a60 = [Math.cos(60 * Math.PI / 180) * 30, -Math.sin(60 * Math.PI / 180) * 30];
eq('four-way: 60 degrees after right is up', at(a60[0], a60[1], { prev: 'right' }).verb, 'up');
eq('across the 180 line left stays left', at(-30, 2, { prev: 'left' }).verb, 'left');

eq('the dead zone edge is 0 of the way', Math.round(at(8.0001, 0).frac * 100), 0);
eq('the rim is all the way', at(40, 0).frac, 1);
eq('beyond the rim is still all the way', at(90, 0).frac, 1);
eq('halfway out', at(24, 0).frac, 0.5);

eq('near the centre a third of the speed', S.pct(0, 100), 30);
eq('at the rim the whole speed', S.pct(1, 100), 100);
eq('halfway, two thirds', S.pct(0.5, 100), 70);
eq('the pad setting is the top', S.pct(1, 60), 60);
eq('and scales the bottom', S.pct(0, 60), 20);
eq('never below ten', S.pct(0, 10), 10);
eq('in steps of ten: a waver does not change it', S.pct(0.51, 100), S.pct(0.53, 100));
eq('a nonsense setting is the full range', S.pct(1, 'fast'), 100);

done();
