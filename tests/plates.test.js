// The list of plates on the Licence plates page, and what it says is missing.
//
// Both fail silently. The camera publishes a plate once per vehicle and takes
// it back two seconds later, so a list that kept only the latest event, or
// dropped reads it should keep, is an empty panel on a camera that is reading
// plates -- a false statement about the camera, with nothing on screen to say
// so. And a warning about object detection that misreads the config either
// nags on a working camera or stays quiet on one that reads nothing.
'use strict';

const path = require('path');
const { check, group, done } = require('./assert');

const P = require(path.join(__dirname, '..', 'www', 'a', 'mj-plates.js'));

const plate = (text, over) => Object.assign({
	src: 'plate', active: true, w: 3840, h: 2160, n: 1, total: 1, text: text,
	r: [[1000, 900, 600, 400, 2, 87, 5]],
}, over || {});

group('a read is kept, newest first, and the clearing event is not a read');
{
	const s = P.store();
	check('a plate is taken', s.offer(plate('A123BC77'), 1000) === true);
	check('the inactive event that takes it back is not a read',
		s.offer({ src: 'plate', active: false, r: [] }, 3000) === false);
	check('and the read stays listed', s.reads().length === 1);
	s.offer(plate('X001XX799'), 4000);
	check('newest first', s.reads()[0].text === 'X001XX799' && s.reads()[1].text === 'A123BC77');
	check('score and vehicle are carried', s.reads()[0].score === 87 && s.reads()[0].vehicle === 5);
}

group('other sources, and malformed plates, are not reads');
{
	const s = P.store();
	check('object events are not plates',
		s.offer({ src: 'object', active: true, r: [[1, 1, 1, 1, 2, 50, 3]] }, 1) === false);
	check('a plate event without text is not a read', s.offer(plate(''), 1) === false);
	check('nor with text that is not a string', s.offer(plate(42), 1) === false);
	check('a plate with no box is still a read', s.offer(plate('A123BC77', { r: [] }), 1) === true);
	check('and has no score or vehicle', s.reads()[0].score === 0 && s.reads()[0].vehicle === 0);
}

group('the same read arriving twice is one read; the same plate later is another');
{
	const s = P.store();
	s.offer(plate('A123BC77'), 1000);
	check('a repeat within SAME_MS is dropped',
		s.offer(plate('A123BC77'), 1000 + P.SAME_MS - 1) === false);
	check('the same plate after it is a new read',
		s.offer(plate('A123BC77'), 1000 + P.SAME_MS + 1) === true);
}

group('two vehicles that read alike are two reads');
{
	const s = P.store();
	s.offer(plate('A123BC77'), 1000);
	check('the same text on another vehicle is kept',
		s.offer(plate('A123BC77', { r: [[1, 1, 1, 1, 2, 80, 9]] }), 1500) === true);
	check('and both are listed', s.reads().length === 2);
}

group('the list is capped');
{
	const s = P.store(3);
	for (let i = 0; i < 5; i++) s.offer(plate('A00' + i + 'AA77'), i * 10000);
	check('at its cap', s.reads().length === 3);
	check('keeping the newest', s.reads()[0].text === 'A004AA77' && s.reads()[2].text === 'A002AA77');
}

group('each glyph keeps its own confidence, and the weakest one is found');
{
	const s = P.store();
	s.offer(plate('A123BC77', { chars: [99, 98, 100, 61, 97, 99, 100, 100], read: 12 }), 1000);
	const r = s.reads()[0];
	check('one per glyph', r.chars.length === 8 && r.chars[3] === 61);
	check('the read is numbered', r.seq === 12);
	check('the least sure glyph', P.weakest(r) === 61);
	s.offer(plate('Ж1234ЛП', { chars: [90, 91, 92, 93, 94, 95, 96, 97, 98], read: 13 }), 2000);
	check('glyphs, not bytes: a Cyrillic plate gets seven',
		s.reads()[0].chars.length === 7);
	s.offer(plate('X001XX799', { chars: ['x', -5, 300, 88] }), 3000);
	const odd = s.reads()[0].chars;
	check('a value that is not a percentage is unknown, not 0% sure',
		odd[0] === null && odd[1] === null && odd[2] === null && odd[3] === 88);
	check('and the weakest ignores the unknown ones', P.weakest(s.reads()[0]) === 88);
	check('a read with no per-glyph confidence has no weakest', P.weakest({ chars: [] }) === null);
	check('nor one whose every value is unknown', P.weakest({ chars: [null, null] }) === null);
}

group('the camera\'s history and the live socket make one list');
{
	const s = P.store();
	check('history is taken', s.history({ reads: [
		{ seq: 7, t: 5000, text: 'X001XX799', conf: 97, chars: [99, 99, 99, 99, 99, 99, 99, 99, 99], vehicle: 3, images: true },
		{ seq: 6, t: 1000, text: 'A123BC77', conf: 90, chars: [], vehicle: 0, images: false },
	] }) === true);
	check('newest first', s.reads()[0].seq === 7 && s.reads()[1].seq === 6);
	check('pictures as the camera says', s.reads()[0].images === true && s.reads()[1].images === false);
	check('the same read arriving live is not listed twice',
		s.offer(plate('X001XX799', { read: 7 }), 5200) === false);
	check('a new live read goes on top', s.offer(plate('B222BB22', { read: 8 }), 9000) === true &&
		s.reads()[0].seq === 8);
	check('a live read does not know about pictures', s.reads()[0].images === null);
}

group('a read seen live first takes the camera\'s account of it from history');
{
	const s = P.store();
	s.offer(plate('X001XX799', { read: 9, chars: [] }), 7000);
	check('it is listed', s.reads().length === 1 && s.reads()[0].images === null);
	s.history({ reads: [{ seq: 9, t: 6500, text: 'X001XX799', conf: 97,
		chars: [99, 99, 99, 99, 99, 99, 99, 99, 99], vehicle: 3, images: true }] });
	const r = s.reads()[0];
	check('still once', s.reads().length === 1);
	check('with the camera\'s time, score, glyphs and pictures',
		r.at === 6500 && r.score === 97 && r.chars.length === 9 && r.images === true);
}

group('reads the camera numbered differently are two reads, however alike');
{
	const s = P.store();
	s.offer(plate('A123BC77', { read: 20 }), 1000);
	check('a second numbered read of the same plate and vehicle is kept',
		s.offer(plate('A123BC77', { read: 21 }), 1500) === true && s.reads().length === 2);
}

group('a read whose time is not known says so, and goes last');
{
	const s = P.store();
	s.history({ reads: [
		{ seq: 2, text: 'A123BC77', conf: 90, chars: [], vehicle: 0, images: false },
		{ seq: 1, t: 1000, text: 'X001XX799', conf: 90, chars: [], vehicle: 0, images: false },
	] });
	check('no time is not the epoch', s.reads()[1].at === null && s.reads()[0].seq === 1);
	check('a document that is not one is ignored', s.history({}) === false && s.history(null) === false);
}

group('what plate reading is missing');
{
	check('nothing, with detection on and vehicles asked for', P.missing({
		lpr: { enabled: true }, objectDetect: { enabled: true, vehicles: true } }) === null);
	check('nothing to say while plate reading is off', P.missing({
		lpr: { enabled: false }, objectDetect: { enabled: false } }) === null);
	check('settings the camera did not send are not called off',
		P.missing({ lpr: { enabled: true } }) === null &&
		P.missing({ lpr: { enabled: true }, objectDetect: { enabled: true } }) === null);
	const off = P.missing({ lpr: { enabled: true }, objectDetect: { enabled: false } });
	check('detection off is said', off && off[0] === 'object detection is off');
	const noVeh = P.missing({ lpr: { enabled: true }, objectDetect: { enabled: true, vehicles: false } });
	check('vehicles not asked for is said',
		noVeh && noVeh[0] === 'object detection does not report vehicles');
	check('a config with no sections at all does not throw', P.missing({}) === null);
}

done();
