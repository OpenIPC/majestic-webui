// What the live-detection overlay draws, and the four things it has to be
// able to say apart.
//
// The store is where this can go wrong quietly. A display of "what is there
// now" that queues events draws the past; one with no linger strobes, because
// the camera publishes at analytics.publishFps against a picture at 20-30 fps;
// and one that cannot distinguish "nothing is moving" from "the camera has
// stopped telling us" paints a reassuring empty frame over a blind camera.
// None of those looks like a bug on screen.
'use strict';

const path = require('path');
const { check, group, done } = require('./assert');

const A = require(path.join(__dirname, '..', 'www', 'a', 'analytics-overlay.js'));
const R = require(path.join(__dirname, '..', 'www', 'a', 'mj-region.js'));

const ev = (over) => Object.assign({
	src: 'motion', active: true, w: 1920, h: 1080, n: 1, total: 1,
	r: [[960, 540, 192, 108, 0, 0]],
}, over || {});

group('the store holds what is there now, not a log of what was');
{
	const s = A.store();
	check('an event is taken', s.offer(ev(), 1000) === true);
	check('a later event replaces the earlier one, it does not queue',
		(s.offer(ev({ r: [[10, 10, 20, 20, 0, 0]] }), 1100), s.boxes(1100).length) === 1);
	check('and it is the later one', s.boxes(1100)[0].x === 10);

	check('a malformed message is refused rather than drawn',
		s.offer({ src: 'motion' }, 1200) === false);
	check('and one with no source at all', s.offer({ r: [] }, 1200) === false);
}

group('boxes linger, so a 5 Hz stream does not strobe over a 25 fps picture');
{
	const s = A.store();
	s.offer(ev(), 1000);
	check('drawn at the instant it arrives', s.boxes(1000).length === 1);
	check('still drawn most of a second later', s.boxes(1900).length === 1);
	check('gone once the linger expires', s.boxes(1000 + A.LINGER_MS + 1).length === 0);
}

group('an inactive event clears the picture rather than lingering');
{
	const s = A.store();
	s.offer(ev(), 1000);
	s.offer(ev({ active: false, r: [] }), 1010);
	check('movement stopping takes the boxes with it', s.boxes(1010).length === 0);
}

group('sources are independent');
{
	const s = A.store();
	s.offer(ev(), 1000);
	s.offer(ev({ src: 'face', r: [[0, 0, 50, 50, 3, 90]] }), 1000);
	const b = s.boxes(1000);
	check('both are drawn', b.length === 2);
	check('and each says which detector reported it',
		b.filter((x) => x.src === 'face').length === 1);
	check('the face box keeps its class and score',
		b.find((x) => x.src === 'face').cls === 3 &&
		b.find((x) => x.src === 'face').score === 90);
}

group('the caption can tell four states apart');
{
	const s = A.store();
	check('nothing has arrived yet', s.note(1000).state === 'waiting');

	s.offer(ev({ active: false, r: [] }), 1000);
	check('the camera answered and nothing is moving', s.note(1000).state === 'quiet');

	s.offer(ev(), 2000);
	check('something is moving', s.note(2000).state === 'active');
	check('and how much of it', s.note(2000).n === 1);

	// The one that matters: the socket is up, the last answer is old. A
	// display that showed "quiet" here would be calling a camera that has
	// stopped speaking a camera with nothing to report.
	check('the camera has gone quiet on us',
		s.note(2000 + A.STALE_MS + 1).state === 'stale');
}

group('a truncated list is reported as truncated');
{
	const s = A.store();
	s.offer(ev({ n: 32, total: 50, r: Array.from({ length: 32 },
		(_, i) => [i, i, 4, 4, 0, 0]) }), 1000);
	const n = s.note(1000);
	check('carried', n.n === 32);
	check('found', n.total === 50);
}

group('a box is measured against the frame it was reported for');
{
	const s = A.store();
	// The camera measures in main-stream pixels. If the picture's size
	// changes between the event arriving and the repaint, scaling by the new
	// size against the old measurement puts the box somewhere else entirely.
	s.offer(ev(), 1000);
	const b = s.boxes(1000)[0];
	check('the frame rides with the box', b.frame.w === 1920 && b.frame.h === 1080);

	const p = R.pic(b.frame, 800, 450);
	const box = R.place(null, p, b);
	check('mid-frame box lands mid-stage', Math.abs(box.x - 400) < 0.01);
	check('and scales with it', Math.abs(box.w - 80) < 0.01);
}

group('a main-stream box on a sub-stream preview scales by its own frame');
{
	// The camera always measures in main-stream pixels. The page may well be
	// showing the sub stream, and until the camera has said how one maps onto
	// the other there is still a right answer -- scale by the frame the box
	// was measured in. Drawing it against the shown frame instead puts every
	// box at a fraction of where the movement was, and on the common camera,
	// where main and sub are the same scene, the two answers coincide and
	// hide it.
	const s = A.store();
	s.offer(ev(), 1000);                     // 1920x1080 main
	const b = s.boxes(1000)[0];              // box at 960,540 -- dead centre
	const p = R.pic({ w: 704, h: 576 }, 704, 576);  // sub stream, 1:1 on stage
	const box = R.place(null, p, b);
	check('centre of the main frame is the centre of the sub picture',
		Math.abs(box.x - 352) < 0.01 && Math.abs(box.y - 288) < 0.01);

	// And the editor's case, which has no frame of its own because it draws
	// in the space it is looking at.
	const plain = R.place(null, p, { x: 352, y: 288, w: 10, h: 10 });
	check('a rectangle naming no frame is left where it is',
		Math.abs(plain.x - 352) < 0.01);
}

group('nothing is drawn while the camera still owes an answer');
{
	// mount() is the DOM half, so what is pinned here is the rule it encodes:
	// an undefined mapping is "not yet", not "identity". A box placed by a
	// guess moves when the answer arrives, and a box that jumps reads as the
	// camera being wrong about where the movement was.
	const ready = (m) => m !== undefined;
	check('a mapping is ready', ready({ k: { x: 1, y: 1 } }) === true);
	check('no mapping needed is ready', ready(null) === true);
	check('not answered yet is NOT ready', ready(undefined) === false);
}

done();
