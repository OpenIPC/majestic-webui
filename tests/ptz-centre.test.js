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
eq('mirrored, right of the picture is left of the head', C.plan(0.75, 0.5, F, { turn: { mirror: true } }).moves, [{ verb: 'left', steps: 34 }]);
eq('flipped, the top of the picture is down for the head', C.plan(0.5, 0.25, F, { turn: { flip: true } }).moves, [{ verb: 'down', steps: 16 }]);
// On its side (#691): the frame is measured upright, so the picture's across
// is the head's tilt and takes the tilt's steps.
eq('turned clockwise, right of the picture is up for the head', C.plan(1, 0.5, F, { turn: { rotate: 90 } }).moves, [{ verb: 'up', steps: 31 }]);
eq('turned clockwise, the top of the picture is left for the head', C.plan(0.5, 0, F, { turn: { rotate: 90 } }).moves, [{ verb: 'left', steps: 67 }]);
eq('turned the other way, right of the picture is down', C.plan(1, 0.5, F, { turn: { rotate: 270 } }).moves, [{ verb: 'down', steps: 31 }]);
eq('turned and mirrored, the top of the picture is right', C.plan(0.5, 0, F, { turn: { rotate: 90, mirror: true } }).moves, [{ verb: 'right', steps: 67 }]);
eq('turned clockwise, a drag right turns it down', C.drag(0.5, 0, F, { turn: { rotate: 90 } }).moves, [{ verb: 'down', steps: 31 }]);
eq('steps are signed for the ring', [C.plan(0.25, 0.75, F).pan, C.plan(0.25, 0.75, F).tilt], [-34, -16]);
eq('to the middle of what is on screen, not of the frame', C.plan(0.9, 0.5, F, { tx: 0.7, ty: 0.5 }).moves, [{ verb: 'right', steps: 27 }]);
eq('a point already at the middle on screen needs nothing', C.plan(0.7, 0.4, F, { tx: 0.7, ty: 0.4 }).moves, []);
eq('a target off the frame is the frame middle', C.plan(1, 0.5, F, { tx: 3 }).moves, [{ verb: 'right', steps: 67 }]);
eq('a pan-only head is not asked to tilt', C.plan(0.75, 0.1, F, { tilt: false }).moves, [{ verb: 'right', steps: 34 }]);
eq('a tilt-only head is not asked to pan', C.plan(0.75, 0.1, F, { pan: false }).moves, [{ verb: 'up', steps: 25 }]);
eq('the time is the two axes in turn', C.plan(1, 0, F).ms, 67 * 16 + 31 * 24);

// Drag: the content under the finger follows it, as a map does.
eq('a drag right turns the head left', C.drag(0.25, 0, F).moves, [{ verb: 'left', steps: 34 }]);
eq('a drag down turns it up', C.drag(0, 1 / 6, F).moves, [{ verb: 'up', steps: 10 }]);
eq('a drag up-left turns it right and down', C.drag(-0.25, -0.25, F).moves, [{ verb: 'right', steps: 34 }, { verb: 'down', steps: 16 }]);
eq('a drag past the frame is still that far', C.drag(-1.5, 0, F).moves, [{ verb: 'right', steps: 201 }]);
eq('mirrored, a drag right turns it right', C.drag(0.25, 0, F, { turn: { mirror: true } }).moves, [{ verb: 'right', steps: 34 }]);
eq('flipped, a drag down turns it down', C.drag(0, 1 / 6, F, { turn: { flip: true } }).moves, [{ verb: 'down', steps: 10 }]);
eq('a pan-only head drags only across', C.drag(0.25, 0.25, F, { tilt: false }).moves, [{ verb: 'left', steps: 34 }]);
eq('under half a step is nothing', C.drag(0.003, -0.007, F).moves, []);
eq('one move is at most MAX steps', C.drag(-20, 0, F).moves, [{ verb: 'right', steps: C.MAX }]);
eq('the pan is capped with it, for the preview', C.drag(-20, 0, F).pan, C.MAX);

done();
