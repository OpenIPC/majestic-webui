// The region editor's verdict on a rectangle somebody typed.
//
// This exists because the subject fails silently, and in the direction that
// costs the most. Every branch renders a confident-looking chip beside the
// coordinates -- the version this replaced printed `0%` for a region of zero
// width, `1%` for one nine thousand pixels off the picture and `1085048%` for
// one bigger than the sensor, all in the same quiet grey as a region that
// works -- so a wrong branch does not degrade the fix for
// OpenIPC/majestic-webui#330, it reverts it.
//
// It also cannot be reproduced on demand: reaching most of these branches on a
// real camera needs one at a known main resolution, a frame size that has
// already arrived from the player's codec event, and someone willing to type
// coordinates the editor is supposed to talk them out of. The numbers below
// are the ones majestic actually stores and the ones the lab camera actually
// reported.
'use strict';

const path = require('path');
const { check, group, done } = require('./assert');

const R = require(path.join(__dirname, '..', 'www', 'a', 'mj-region.js'));

// The lab camera's main stream, and a rotated one: portrait is where a typed
// coordinate is most likely to be out of bounds, because the two numbers swap
// and nothing on the page says so.
const MAIN = { w: 2592, h: 1520 };
const PORTRAIT = { w: 1080, h: 1920 };

group('parse accepts exactly what the camera can store');
{
	const r = R.parse('10x20x300x400');
	check('four whole numbers', r && r.x === 10 && r.y === 20 && r.w === 300 && r.h === 400);
	check('zero is a number', !!R.parse('0x0x0x0'));
	// The camera accepts a blank there, so this IS a region it stores.
	// Rejecting it here would be the page inventing a rule the camera has not
	// got, and the page would be wrong about a config already on a card.
	const sp = R.parse('0x0x10x 10');
	check('a leading blank is skipped, as the camera skips it', sp && sp.h === 10);

	// The one that mattered: the camera stores "-5" as 4294967291 while the
	// editor drew it at minus five. Neither is what was typed and only one was
	// on screen.
	check('a minus sign is not a coordinate', R.parse('-5x-5x100x100') === null);
	check('a fraction is not a coordinate', R.parse('1.5x2x3x4') === null);
	check('three numbers are not a region', R.parse('10x20x30') === null);
	check('five numbers are not a region', R.parse('1x2x3x4x5') === null);
	check('words are not a region', R.parse('abcxdefxghixjkl') === null);
	check('an empty string is not a region', R.parse('') === null);
	check('nothing at all is not a region', R.parse(null) === null);
	check('a stray comma is not a separator', R.parse('0x0x10x10,9x9x19x19') === null);
}

group('a region with no area is named, not scored');
{
	// Point 3 of the issue, in the reporter's own example: "100x100x 0x10 is a
	// size error ... it is not visible".
	const v = R.verdict(R.parse('100x100x0x10'), MAIN, 'region');
	check('zero width is bad', v.cls === 'bad');
	check('and is called what it is', v.text === 'no area');
	check('with a sentence behind it', /no width or height/.test(v.title));

	check('zero height too', R.verdict(R.parse('100x100x10x0'), MAIN).cls === 'bad');
	check('zero everything too', R.verdict(R.parse('0x0x0x0'), MAIN).cls === 'bad');

	// Said without bounds as well: this verdict needs no frame to be certain,
	// and a camera whose frame size has not arrived yet is exactly when
	// somebody is typing.
	const nb = R.verdict(R.parse('100x100x0x10'), null);
	check('and said before the frame size arrives', nb.cls === 'bad' && nb.text === 'no area');
}

group('a region outside the picture is named, not scored');
{
	// Point 4: the camera clamps every edge into the frame, so this arrives as
	// a rectangle with no area. It used to read `1%`.
	const off = R.verdict(R.parse('9000x9000x100x100'), MAIN, 'region');
	check('entirely outside is bad', off.cls === 'bad');
	check('and is called what it is', off.text === 'off picture');
	check('the sentence names the frame it is outside of', /2592 × 1520/.test(off.title));

	// Exactly at the far edge is outside it: a region starting on the last
	// column has no column left to watch.
	check('starting at the right edge is outside', R.verdict(R.parse('2592x0x10x10'), MAIN).cls === 'bad');
	check('starting at the bottom edge is outside', R.verdict(R.parse('0x1520x10x10'), MAIN).cls === 'bad');
	// One pixel inside the edge is still a region, and the last pixel of the
	// frame is a region that fits exactly: "outside" has to mean outside, or
	// the editor talks people out of the edges of their own picture.
	check('the last pixel of the frame fits', R.verdict(R.parse('2591x1519x1x1'), MAIN).cls === 'ok');
	check('and one that overhangs it is clipped, not off',
		R.verdict(R.parse('2591x1519x10x10'), MAIN).text === '0% · clipped');
}

group('a region hanging over the edge is scored on the part that counts');
{
	// Half in, half out. The share is of the CLIPPED rectangle, because the
	// clipped one is what the camera watches; scoring the typed one overstates
	// the watch by exactly the part that was thrown away.
	const v = R.verdict(R.parse('2542x0x100x1520'), MAIN, 'region');
	check('clipping is flagged', v.cls === 'bad');
	check('and the share is of what is left', v.text === '2% · clipped');
	check('the sentence says which part counts', /Only the part inside/.test(v.title));

	// The one bigger than the sensor: it used to read 1085048%, which is not a
	// share of anything.
	const huge = R.verdict(R.parse('0x0x99999x99999'), MAIN);
	check('a region bigger than the frame is clipped, not 1085048%', huge.text === '100% · clipped');
}

group('a region that fits is scored, quietly');
{
	const half = R.verdict(R.parse('0x0x1296x1520'), MAIN, 'region');
	check('half the frame is 50%', half.text === '50%');
	check('and is not flagged', half.cls === 'ok');
	check('the whole frame is 100%', R.verdict(R.parse('0x0x2592x1520'), MAIN).text === '100%');

	// Rotated: the same coordinates that fit a landscape frame hang off a
	// portrait one, and this is the case the reporter's camera was in.
	check('landscape coordinates on a portrait frame are clipped',
		R.verdict(R.parse('0x0x1920x1080'), PORTRAIT).cls === 'bad');
	check('portrait coordinates on a portrait frame are not',
		R.verdict(R.parse('0x0x1080x1920'), PORTRAIT).text === '100%');
}

group('without a frame size, only the verdicts that need none are given');
{
	// A judgement that cannot be made is not made: with no main resolution set
	// and the picture on the sub stream, the editor does not know what the
	// coordinates are in, so it must not call an in-bounds region out of them.
	const v = R.verdict(R.parse('9000x9000x100x100'), null, 'region');
	check('nothing is claimed about bounds', v.cls === 'ok');
	check('and nothing is printed', v.text === '');
	check('a zero-size frame is no frame at all',
		R.verdict(R.parse('9000x9000x100x100'), { w: 0, h: 0 }).text === '');
}

group('the noun comes from the caller, because the promises differ');
{
	// The motion list and the privacy-mask list share this control and must not
	// share a sentence: one says where to watch, the other burns black into
	// everybody's picture.
	check('a region does nothing with it',
		/This region has no width/.test(R.verdict(R.parse('0x0x0x10'), MAIN, 'region').title));
	check('a mask says mask', /This mask has no width/.test(
		R.verdict(R.parse('0x0x0x10'), MAIN, 'mask').title));
	check('the default is region', /This region/.test(R.verdict(R.parse('0x0x0x10'), MAIN).title));
}

group('the tally counts what the rows say, so the head cannot disagree');
{
	const rows = ['0x0x100x100', '100x100x0x10', '9000x9000x100x100', '', 'nonsense'];
	const t = R.tally(rows, MAIN, 'region');
	check('an empty row is not a region yet', t.n === 4);
	check('three of the four are unusable', t.bad === 3);

	const good = R.tally(['0x0x100x100', '200x200x300x300'], MAIN);
	check('all usable counts none bad', good.n === 2 && good.bad === 0);
	check('no rows at all is not an error', R.tally([], MAIN).n === 0);
	check('no list at all is not an error', R.tally(null, MAIN).n === 0);

	// The case the reporter was in: every region unusable. The count is what
	// the page words its loudest sentence from -- detection is limited to the
	// regions listed and does not fall back to the whole picture, so this is
	// not a narrowed watch, it is no watch at all.
	const dead = R.tally(['100x100x0x10', '9000x9000x100x100'], MAIN);
	check('all bad is all bad', dead.n === 2 && dead.bad === 2);
}

done();
