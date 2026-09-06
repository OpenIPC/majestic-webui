// Where the overlay sits (www/a/mj-place.js).
//
// This is the arithmetic issue #340 is about, and it fails silently in the way
// that matters most: an overlay placed wrongly still renders, still records and
// still looks exactly like an overlay, because the camera burns it into the
// stream whatever the numbers say. Nothing anywhere reports "this is measured
// from the wrong edge". You find out when the second camera does not match the
// first — which is what the reporter of #340 found, after tuning a layout by
// hand and being unable to reproduce it.
//
// It also cannot be reproduced on demand from the browser: the maths only shows
// itself through a drag against a letterboxed picture whose size depends on the
// window, the stream and the sensor. Held still here as plain numbers, every
// case is one line.
'use strict';

const path = require('path');
const { check, group, done } = require('./assert');

const P = require(path.join(__dirname, '..', 'www', 'a', 'mj-place.js'));

// A 16:9 picture inset in a stage, and an overlay box inside it. Deliberately
// not at the origin — an offset measured from the stage instead of from the
// picture is the classic slip, and it is invisible when pic.x is 0.
const PIC = { x: 40, y: 20, w: 800, h: 450 };
const BOX = { w: 160, h: 24 };
const FRAME = { w: 1920, h: 1080 };
const EM = 20;                       // 1920 / 96 * 1.0, the camera's own derivation

const near = (a, b, eps) => Math.abs(a - b) <= (eps === undefined ? 1e-9 : eps);

group('anchors');
check('nine of them', P.ANCHORS.length === 9);
check('bottom-right is 1,1', P.nameOf(1, 1) === 'bottom-right');
check('top-left is -1,-1', P.nameOf(-1, -1) === 'top-left');
check('centre is 0,0', P.nameOf(0, 0) === 'center');
check('a name maps back to its sides', P.sidesOf('bottom-right').x === 1 &&
	P.sidesOf('bottom-right').y === 1);
check('proportional is not an anchor', P.sidesOf('proportional') === null);
check('and is recognised as the legacy mode', P.isProportional('proportional'));
check('an unknown name is treated as proportional, not as a corner',
	P.isProportional('nonsense-from-a-hand-edited-config'));

group('which unit a stored offset is written in');
check('a percentage', P.unitOf('2%') === '%');
check('with a space', P.unitOf(' 2 % ') === '%');
check('em, case-insensitively', P.unitOf('1.5EM') === 'em');
check('a bare non-zero is pixels — a camera set up in pixels keeps them',
	P.unitOf('16') === 'px');
check('an explicit px', P.unitOf('16px') === 'px');
// 0 is the same position in all three units, so it carries no choice; the
// caller resolves null to a share of the frame, which travels between channels.
check('a bare zero infers nothing', P.unitOf('0') === null);
check('an empty field infers nothing', P.unitOf('') === null);
check('so does a missing one', P.unitOf(null) === null);
check('and the default it resolves to is a share', P.DEFAULT_UNIT === '%');

group('reading an offset back, whatever it was written in');
check('2% of 1920 is 0.02', near(P.toFrac('2%', FRAME.w, EM), 0.02));
check('192px of 1920 is 0.1', near(P.toFrac('192', FRAME.w, EM), 0.1));
check('px suffix reads the same as bare', near(P.toFrac('192px', FRAME.w, EM), 0.1));
check('2em at 20px is 40/1920', near(P.toFrac('2em', FRAME.w, EM), 40 / 1920));
check('nonsense is zero, not NaN', P.toFrac('twelve', FRAME.w, EM) === 0);
check('a zero span does not divide by zero', P.toFrac('16', 0, EM) === 0);

group('writing it back in the unit asked for');
check('a share', P.fromFrac(0.02, '%', FRAME.w, EM) === '2%');
check('pixels are whole', P.fromFrac(0.1, 'px', FRAME.w, EM) === '192');
check('em carries its suffix', P.fromFrac(40 / 1920, 'em', FRAME.w, EM) === '2em');
check('a share keeps one decimal', P.fromFrac(0.0215, '%', FRAME.w, EM) === '2.2%');

group('changing the unit must not move the overlay');
// The complaint in #340 was the opposite of this: the old placer always wrote a
// percentage, so one nudge of a camera configured in pixels threw its numbers away.
for (const [from, to] of [['2%', 'px'], ['192', '%'], ['2em', '%'], ['2%', 'em'],
	['192px', 'em'], ['1.5em', 'px']]) {
	const before = P.toFrac(from, FRAME.w, EM);
	const after = P.toFrac(P.convert(from, to, FRAME.w, EM), FRAME.w, EM);
	check(from + ' → ' + to + ' holds its position', near(before, after, 6e-4),
		before + ' vs ' + after);
}

group('an offset is measured from its own anchor');
{
	const at = { x: PIC.x + 100, y: PIC.y + 60 };
	const left = P.dragWithin(PIC, BOX, P.sidesOf('top-left'), at);
	check('anchored left, the offset is the gap on the left',
		near(left.fx, 100 / PIC.w), String(left.fx));
	const right = P.dragWithin(PIC, BOX, P.sidesOf('top-right'), at);
	// the same drop, measured from the other edge: 800 - 100 - 160 = 540
	check('anchored right, it is the gap on the right',
		near(right.fx, 540 / PIC.w), String(right.fx));
	check('anchored top, the vertical gap is from the top',
		near(left.fy, 60 / PIC.h), String(left.fy));
	const bottom = P.dragWithin(PIC, BOX, P.sidesOf('bottom-left'), at);
	// 450 - 60 - 24 = 366
	check('anchored bottom, it is from the bottom',
		near(bottom.fy, 366 / PIC.h), String(bottom.fy));
}

group('a centred axis writes no offset');
{
	const at = { x: PIC.x + 100, y: PIC.y + 60 };
	const top = P.dragWithin(PIC, BOX, P.sidesOf('top'), at);       // centre-x
	check('centre-x offers no horizontal offset', top.fx === 0);
	check('but still measures the vertical one', top.fy > 0);
	const leftMid = P.dragWithin(PIC, BOX, P.sidesOf('left'), at);  // centre-y
	check('centre-y offers no vertical offset', leftMid.fy === 0);
	const centre = P.dragWithin(PIC, BOX, P.sidesOf('center'), at);
	check('dead centre offers neither', centre.fx === 0 && centre.fy === 0);
}

group('the magnet pulls to zero, not to a corner');
{
	const sides = P.sidesOf('top-left');
	const just = P.dragWithin(PIC, BOX, sides, { x: PIC.x + P.SNAP - 1, y: PIC.y + 3 });
	check('inside the snap band, the offset is exactly zero',
		just.fx === 0 && just.fy === 0);
	const past = P.dragWithin(PIC, BOX, sides, { x: PIC.x + P.SNAP + 1, y: PIC.y + 3 });
	check('one pixel past it, it is not', past.fx > 0);
	// This is the whole of point 3: the old placer would have re-anchored here.
	const dragged = P.dragWithin(PIC, BOX, sides, { x: PIC.x + 700, y: PIC.y + 400 });
	check('dragging clear across the picture still returns only offsets',
		Object.keys(dragged).sort().join(',') === 'fx,fy');
	check('and they are large rather than re-anchored',
		dragged.fx > 0.8 && dragged.fy > 0.8);
}

group('a negative offset is impossible');
{
	// Dragged off the left edge entirely. The camera cannot draw a negative
	// offset, so the floor is 0 — and an unfloored value would sail past the
	// snap test and land as a large positive number on the far edge.
	const off = P.dragWithin(PIC, BOX, P.sidesOf('top-left'), { x: PIC.x - 200, y: PIC.y - 90 });
	check('off the near edge floors at zero', off.fx === 0 && off.fy === 0);
	const far = P.dragWithin(PIC, BOX, P.sidesOf('bottom-right'),
		{ x: PIC.x + PIC.w + 50, y: PIC.y + PIC.h + 50 });
	check('and off the far edge does too', far.fx === 0 && far.fy === 0);
}

group('a drop lands where it was dropped');
for (const name of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
	const sides = P.sidesOf(name);
	const at = { x: PIC.x + 300, y: PIC.y + 200 };
	const f = P.dragWithin(PIC, BOX, sides, at);
	const back = P.anchoredSpot(PIC, BOX, sides, f.fx, f.fy);
	check(name + ' round-trips through the anchor',
		near(back.x, at.x, 0.5) && near(back.y, at.y, 0.5),
		back.x + ',' + back.y + ' vs ' + at.x + ',' + at.y);
}

group('proportional — the camera default, and it stays that way');
{
	const atTopLeft = P.proportionalSpot(PIC, BOX, 16, 16);
	check('16 / 16 is the top-left corner',
		near(atTopLeft.x, PIC.x) && near(atTopLeft.y, PIC.y));
	const atBottomRight = P.proportionalSpot(PIC, BOX, -16, -16);
	check('-16 / -16 is the bottom-right corner',
		near(atBottomRight.x, PIC.x + PIC.w - BOX.w) &&
		near(atBottomRight.y, PIC.y + PIC.h - BOX.h));
	const middle = P.proportionalSpot(PIC, BOX, 0, 0);
	check('0 / 0 is the middle', near(middle.x, PIC.x + (PIC.w - BOX.w) / 2));

	for (const [px, py] of [[16, 16], [-16, -16], [0, 0], [8, -4], [-14, 14]]) {
		const spot = P.proportionalSpot(PIC, BOX, px, py);
		const back = P.dragProportional(PIC, BOX, spot);
		check('a drag at ' + px + '/' + py + ' writes the same pair back',
			back.posX === px && back.posY === py, back.posX + '/' + back.posY);
	}
	const beyond = P.dragProportional(PIC, BOX, { x: PIC.x - 400, y: PIC.y - 400 });
	check('dragged past the edge, it clamps rather than running away',
		beyond.posX === 16 && beyond.posY === 16);
	check('the pair is whole numbers, as the schema declares them',
		Number.isInteger(beyond.posX) && Number.isInteger(beyond.posY));
}

group('arrow keys add in the direction the eye expects');
// The sign depends on the anchor, because an offset grows AWAY from it. Getting
// this backwards is the single most annoying thing a numeric control can do.
check('anchored left, → grows the offset', P.nudge(P.sidesOf('top-left'), 'x', 1) === 1);
check('anchored left, ← shrinks it', P.nudge(P.sidesOf('top-left'), 'x', -1) === -1);
check('anchored right, → shrinks it', P.nudge(P.sidesOf('top-right'), 'x', 1) === -1);
check('anchored right, ← grows it', P.nudge(P.sidesOf('top-right'), 'x', -1) === 1);
check('anchored top, ↓ grows the vertical offset',
	P.nudge(P.sidesOf('top-left'), 'y', 1) === 1);
check('anchored bottom, ↓ shrinks it',
	P.nudge(P.sidesOf('bottom-left'), 'y', 1) === -1);
check('a centred axis does not move at all', P.nudge(P.sidesOf('top'), 'x', 1) === 0);

group('the words on screen');
check('a corner says its name', P.sayOf('bottom-right') === 'Bottom right');
check('and proportional says it is proportional', P.sayOf('proportional') === 'Proportional');

done();
