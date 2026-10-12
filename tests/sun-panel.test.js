// What tonight comes to, under the twilight strip (www/a/sun-panel.js).
//
// The strip stands over one sentence, and that sentence reads exactly as
// confidently when it picks the wrong line, or misses that the line is never
// reached, as when it is right. The case it exists for cannot be produced on
// demand at all: a camera told "night at nautical dusk" in Moscow in June looks
// set up and never goes to night, and the page is the only place able to say
// so before it happens -- in June, at the camera. Here the camera's report is
// a literal.
'use strict';

const path = require('path');
const { check, group, done } = require('./assert');

const S = require(path.join(__dirname, '..', 'www', 'a', 'sun-panel.js'));

const LINES = [0, -6, -12];
const NAMES = {
	night: { 0: 'Sunset', '-6': 'Civil dusk', '-12': 'Nautical dusk' },
	day: { 0: 'Sunrise', '-6': 'Civil dawn', '-12': 'Nautical dawn' },
};

// A report the way GET /api/v1/sun answers it: every whole angle with this
// night's crossings, null where the sun does not reach the line.
function report(lowest, highest, times) {
	const lines = [];
	for (let a = 6; a >= -12; a--) {
		const t = times[a] || (a >= lowest ? ['20:00', '05:00'] : [null, null]);
		lines.push({ angle: a, dusk: t[0], dawn: t[1] });
	}
	return { place: true, clock: true, elevation: -3, lowest: lowest, highest: highest, lines: lines };
}

group('the sentence picks the chosen lines');
{
	const r = report(-41, 27, { '-6': ['18:16', '06:17'], '-3': ['17:58', '06:35'] });
	const t = S.tonight(r, -6, null, NAMES, LINES);
	check('one angle, both ways', t.state === 'ok' && /night from 18:16, day again from 06:17/.test(t.sentence), t.sentence);
	const t2 = S.tonight(r, -6, -3, NAMES, LINES);
	check('a later morning line is the dawn read', /day again from 06:35/.test(t2.sentence), t2.sentence);
	const t3 = S.tonight(r, -6, -9, NAMES, LINES);
	check('a day line under the night line is the night line', /day again from 06:17/.test(t3.sentence), t3.sentence);
	check('three named lines are marked', t.marks.map((m) => m.angle).join() === '0,-6,-12');
	check('each mark carries its own times', t.marks[1].dusk === '18:16' && t.marks[1].dawn === '06:17');
}

group('a night the sun does not reach is said, not left blank');
{
	// Moscow at midsummer: the sun gets no lower than -10.8.
	const r = report(-10.8, 57.7, {});
	const t = S.tonight(r, -12, null, NAMES, LINES);
	check('no night tonight', t.state === 'no-night', t.state);
	check('in words, with how low it does get',
		/does not go down to 12° below the horizon — it gets no lower than 11° below/.test(t.sentence), t.sentence);
	check('and who decides instead', /the picture decides/.test(t.sentence), t.sentence);
	check('the civil line is still reached there', S.tonight(r, -6, null, NAMES, LINES).state === 'ok');
	check('the unreached mark has no times', t.marks[2].dusk === null && t.marks[2].dawn === null);
}

group('a day the sun does not reach');
{
	// Murmansk at midwinter: civil twilight, no sunrise.
	const r = report(-44.5, -2.4, { 0: [null, null] });
	const t = S.tonight(r, -6, 0, NAMES, LINES);
	check('no day today', t.state === 'no-day' && /does not get up to the horizon today/.test(t.sentence), t.sentence);
}

group('nothing is claimed that cannot be known');
{
	check('no report, no sentence', S.tonight(null, -6, null, NAMES, LINES).sentence === '');
	const noPlace = S.tonight({ place: false, clock: true }, -6, null, NAMES, LINES);
	check('no place says so', noPlace.state === 'place' && /Say where the camera is/.test(noPlace.sentence));
	const noClock = S.tonight({ place: true, clock: false }, -6, null, NAMES, LINES);
	check('no clock says so', noClock.state === 'clock' && /clock has not been set/.test(noClock.sentence));
}

group('a reply is believed only as far as it goes');
{
	// A reply that is valid JSON and short of what the sentence needs is no
	// answer: not a missing place, not a white night, not "night from —".
	check('no place or clock flags: nothing said',
		S.tonight({ lines: [] }, -6, null, NAMES, LINES).state === 'unknown');
	check('a place flag that is not a boolean: nothing said',
		S.tonight({ place: 'yes', clock: true }, -6, null, NAMES, LINES).state === 'unknown');
	const noLines = S.tonight({ place: true, clock: true }, -6, null, NAMES, LINES);
	check('no lines and no lowest: nothing said, not a white night', noLines.state === 'unknown', noLines.state);
	const noTimes = S.tonight({ place: true, clock: true, lowest: -40, highest: 30,
		lines: [{ angle: -6, dusk: null, dawn: null }] }, -6, null, NAMES, LINES);
	check('a reached line with no times: nothing said, never "night from —"',
		noTimes.state === 'unknown' && noTimes.sentence === '', noTimes.sentence);
	const junk = S.tonight({ place: true, clock: true, lowest: -40, highest: 30,
		lines: [{ angle: -6, dusk: 'soon', dawn: 7 }] }, -6, null, NAMES, LINES);
	check('times that are not times are not shown', junk.state === 'unknown' &&
		junk.marks[1].dusk === null && junk.marks[1].dawn === null);
}

group('the scale comes from the schema');
{
	const sc = S.scale({ minimum: -12, maximum: 6, 'x-special': { 0: 'Sunset', '-6': 'Civil dusk', '-12': 'Nautical dusk' } });
	check('its range', sc.top === 6 && sc.bottom === -12);
	check('its named lines, highest first', sc.lines.join() === '0,-6,-12', sc.lines.join());
	check('+6 is the strip\'s left end', S.at(sc, 6) === 0);
	check('-12 is its right end', S.at(sc, -12) === 100);
	check('-3 is half way', S.at(sc, -3) === 50);
	const wider = S.scale({ minimum: -18, maximum: 0, 'x-special': { '-18': 'Astronomical dusk', 5: 'outside' } });
	check('a wider range is followed, and a name outside it dropped', wider.bottom === -18 && wider.lines.join() === '-18');
	check('no range, no strip', S.scale({ type: 'integer' }) === null);
	check('the horizon by name', S.angleWords(0) === 'the horizon');
	check('below', S.angleWords(-6) === '6° below the horizon');
}

done();
