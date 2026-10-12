// Centre on a point (www/a/ptz-centre.js).
//
// What fails silently: a camera mounted upside down or mirrored that turns
// AWAY from the point tapped, a frame size read off the wrong token, and a
// tap just off the middle that sends a move of nothing.
const { check, done } = require('./assert.js');
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got));
const C = require('../www/a/ptz-centre.js');

const CAPS = 'actuator=gpiostep pulse=500 state=ready verbs=stop,up,down,left,right speeds=1-100 steps=1 frame=134x62';
eq('the frame is read off the line', C.frame(CAPS), { w: 134, h: 62 });
eq('a line without one offers none', C.frame('actuator=gpiostep pulse=500 state=ready verbs=stop,up steps=1'), null);
eq('no answer offers none', C.frame(undefined), null);
eq('a zero frame is none', C.frame('steps=1 frame=0x62'), null);
eq('a word that only ends in frame= is not it', C.frame('steps=1 keyframe=5x5'), null);

const F = { w: 134, h: 62 };
eq('the middle needs nothing', C.plan(0.5, 0.5, F).moves, []);
eq('just off the middle needs nothing', C.plan(0.502, 0.505, F).moves, []);
eq('the right edge is half a frame right', C.plan(1, 0.5, F).moves, [{ verb: 'right', steps: 67 }]);
eq('a quarter left', C.plan(0.25, 0.5, F).moves, [{ verb: 'left', steps: 34 }]);
eq('the top edge is half a frame up', C.plan(0.5, 0, F).moves, [{ verb: 'up', steps: 31 }]);
eq('lower right is right and down', C.plan(0.75, 0.75, F).moves, [{ verb: 'right', steps: 34 }, { verb: 'down', steps: 16 }]);
eq('mirrored, right of the picture is left of the head', C.plan(0.75, 0.5, F, { mirror: true }).moves, [{ verb: 'left', steps: 34 }]);
eq('flipped, the top of the picture is down for the head', C.plan(0.5, 0.25, F, { flip: true }).moves, [{ verb: 'down', steps: 16 }]);
eq('steps are signed for the ring', [C.plan(0.25, 0.75, F).pan, C.plan(0.25, 0.75, F).tilt], [-34, -16]);
eq('the time is the two axes in turn', C.plan(1, 0, F).ms, 67 * 16 + 31 * 24);

done();
