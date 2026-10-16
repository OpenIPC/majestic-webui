// Which way the head turns for a direction on the picture (www/a/ptz-orient.js).
//
// What fails silently: a camera mounted upside down, mirrored, or turned on
// its side whose arrows steer the head the wrong way. The pad still moves the
// head, every request still answers 200, and only someone watching the
// picture swing away from the arrow they pressed can tell (#691). The order --
// mirror and flip at the sensor, the quarter turn after, clockwise -- was
// measured on an hi3516av300, and is what these pin.
const { check, done } = require('./assert.js');
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got));
const O = require('../www/a/ptz-orient.js');

eq('no image section is no reading', O.of(undefined), null);
eq('an empty fetch is no reading', O.of(null), null);
eq('defaults are upright', O.of({}), { mirror: false, flip: false, rotate: 0 });
eq('the rotation arrives as a string', O.of({ rotate: '270', mirror: true }), { mirror: true, flip: false, rotate: 270 });
eq('a rotation the camera does not offer is none', O.of({ rotate: '45' }).rotate, 0);

const up = { mirror: false, flip: false, rotate: 0 };
eq('upright, right is right', O.verb('right', up), 'right');
eq('no reading is taken as upright', O.verb('up', null), 'up');
eq('mirrored, right is the head\'s left', O.verb('right', { mirror: true }), 'left');
eq('mirrored, up is still up', O.verb('up', { mirror: true }), 'up');
eq('flipped, up is the head\'s down', O.verb('up', { flip: true }), 'down');
eq('flipped, left is still left', O.verb('left', { flip: true }), 'left');
eq('upside down (mirror and flip), every arrow is reversed',
	['up', 'right', 'down', 'left'].map((v) => O.verb(v, { mirror: true, flip: true })), ['down', 'left', 'up', 'right']);
eq('upside down, a diagonal is reversed', O.verb('upleft', { mirror: true, flip: true }), 'downright');
eq('turned clockwise, the picture\'s right is the head\'s up',
	['right', 'down', 'left', 'up'].map((v) => O.verb(v, { rotate: 90 })), ['up', 'right', 'down', 'left']);
eq('turned counter-clockwise, the picture\'s right is the head\'s down',
	['right', 'down', 'left', 'up'].map((v) => O.verb(v, { rotate: 270 })), ['down', 'left', 'up', 'right']);
// On its side a mirror shows as the picture turned top to bottom -- the
// measurement that settled the order -- so it reverses what up does, not right.
eq('turned clockwise and mirrored, right is unchanged and up is reversed',
	['right', 'up'].map((v) => O.verb(v, { rotate: 90, mirror: true })), ['up', 'right']);
eq('turned clockwise, a diagonal turns with it', O.verb('upright', { rotate: 90 }), 'upleft');
eq('a half turn reverses both', O.verb('upright', { rotate: 180 }), 'downleft');
eq('what is not a direction passes as it came',
	['stop', 'tele', 'wide', 'near', 'far', 'af'].map((v) => O.verb(v, { mirror: true, flip: true, rotate: 90 })),
	['stop', 'tele', 'wide', 'near', 'far', 'af']);

eq('a stepped move is a vector, mirrored', O.vec(1, 1, { mirror: true }), { x: -1, y: 1 });
eq('a stepped move on its side swaps the axes', O.vec(1, 0, { rotate: 90 }), { x: 0, y: 1 });
eq('no zero comes out negative', O.vec(0, 1, { mirror: true }), { x: 0, y: 1 });

eq('upright, across is the pan', O.axes(true, false, up), { across: true, down: false });
eq('on its side, across is the tilt', O.axes(true, false, { rotate: 270 }), { across: false, down: true });
eq('mirroring changes no axis', O.axes(false, true, { mirror: true }), { across: false, down: true });

done();
