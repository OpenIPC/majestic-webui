// MajesticTimeline — the day model the recordings ribbon is drawn from.
//
// Here for the same reason as the mp4 index: every failure is silent and
// convincing. A clip placed at the wrong minute draws a ribbon that looks
// right, a gap that fails to appear is indistinguishable from a camera that
// never stopped, and an estimated duration presented as exact is a timeline
// that lies about what is on the card. None of that throws, and none of it is
// visible in a screenshot.
//
// The cases are the ones a real card produces: majestic names clips %H-%M so
// starts are minute-resolution, the newest clip of today is still being
// written, the camera gets restarted leaving holes, and a recording running
// over midnight is cut at the date change.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const SRC = path.join(__dirname, '..', 'www', 'a', 'timeline.js');

function load() {
	const ctx = { window: {}, console: console };
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx);
	return ctx.window.MajesticTimeline;
}

const T = load();
const HOUR = 3600;
const clip = (name, size) => ({ name: name, size: size || 400000000, mtime: 0 });
const SPLIT = 1200;   // records.split 20, in seconds

// ---- placing clips ------------------------------------------------------

group('reading a clip start out of its filename');

check('%H-%M is the default records.filename',
	T.startOfName('12-04.mp4') === 12 * HOUR + 4 * 60,
	'got ' + T.startOfName('12-04.mp4'));
check('%H-%M-%S is the other spelling people set',
	T.startOfName('12-04-30.mp4') === 12 * HOUR + 4 * 60 + 30);
check('midnight places at zero, not at the end of the day',
	T.startOfName('00-00.mp4') === 0);
check('an impossible hour is declined rather than wrapped',
	T.startOfName('25-00.mp4') === null);
check('an impossible minute is declined too',
	T.startOfName('12-99.mp4') === null);
check('a name in some other scheme is declined, not guessed',
	T.startOfName('recording_004.mp4') === null);

{
	const day = T.buildDay([clip('12-04.mp4'), clip('weird-name.mp4')], { splitSec: SPLIT });
	check('an unplaceable clip stays listed but off the ribbon',
		day.clips.length === 1 && day.unplaced.length === 1,
		day.clips.length + '/' + day.unplaced.length);
	check('and is still identifiable by name',
		day.unplaced[0].name === 'weird-name.mp4');
}

// ---- durations ----------------------------------------------------------

group('how long a clip is, before anything has been indexed');

{
	// three back-to-back clips, then the camera was off, then one more
	const day = T.buildDay([
		clip('08-00.mp4'), clip('08-20.mp4'), clip('08-40.mp4'),
		clip('11-47.mp4'),
	], { splitSec: SPLIT });

	check('a clip that is followed immediately ends where the next begins',
		day.clips[0].dur === SPLIT, 'got ' + day.clips[0].dur);
	check('and that is exact, not an estimate — the next file opening IS this one closing',
		day.clips[0].estimated === false);
	check('the clip before a gap falls back to the configured split',
		day.clips[2].dur === SPLIT, 'got ' + day.clips[2].dur);
	check('and says so', day.clips[2].estimated === true);
	check('a lone trailing clip on a past day gets the split too',
		day.clips[3].dur === SPLIT && day.clips[3].estimated === true);
}

{
	// the camera restarted 7 minutes into a slot, so the clip is short
	const day = T.buildDay([clip('09-00.mp4'), clip('09-07.mp4')], { splitSec: SPLIT });
	check('a short clip is measured by the next one, not by the split',
		day.clips[0].dur === 7 * 60, 'got ' + day.clips[0].dur);
}

{
	// today: the newest clip is still being written
	const now = 13 * HOUR + 12 * 60;
	const day = T.buildDay([clip('12-24.mp4'), clip('13-04.mp4')], {
		splitSec: SPLIT, nowSec: now,
	});
	const last = day.clips[1];
	check('the newest clip of today ends at now, not a full split later',
		last.end === now, 'got ' + last.end);
	check('and is flagged as still recording', last.recording === true);
	check('an earlier clip today is not flagged as recording',
		!day.clips[0].recording);
}

{
	// yesterday: nothing is being written, so nothing may be flagged live
	const day = T.buildDay([clip('23-50.mp4')], { splitSec: SPLIT });
	check('a clip running past midnight is cut at the date change',
		day.clips[0].end === T.DAY, 'got ' + day.clips[0].end);
	check('nothing on a past day claims to be recording',
		!day.clips[0].recording);
}

{
	const day = T.buildDay([clip('12-04.mp4')], { splitSec: SPLIT, nowSec: 13 * HOUR });
	check('an exact duration from the index replaces the estimate',
		T.applyExactDuration(day, '12-04.mp4', 1112) &&
		day.clips[0].dur === 1112 && day.clips[0].estimated === false,
		'dur ' + day.clips[0].dur);
	check('and a clip that is not there is not invented',
		T.applyExactDuration(day, 'nope.mp4', 100) === false);
}

// ---- coverage and gaps --------------------------------------------------

group('coverage — what the ribbon actually draws');

{
	const day = T.buildDay([
		clip('06-00.mp4'), clip('06-20.mp4'), clip('06-40.mp4'),   // 06:00-07:00
		clip('09-35.mp4'),                                          // 09:35-09:55
	], { splitSec: SPLIT });
	const cov = T.coverage(day);

	check('abutting clips merge into one stretch of footage',
		cov.length === 2, 'got ' + cov.length + ' segments');
	check('the merged stretch spans all of them',
		cov[0].from === 6 * HOUR && cov[0].to === 7 * HOUR,
		cov[0].from + '..' + cov[0].to);
	check('and remembers which clips it came from',
		cov[0].clips.length === 3);

	const g = T.gaps(day);
	check('the hole between them is a gap', g.length === 1);
	check('the gap is exactly the time not recorded',
		g[0].from === 7 * HOUR && g[0].to === 9 * HOUR + 35 * 60,
		g[0].from + '..' + g[0].to);
}

{
	const day = T.buildDay([clip('06-00.mp4')], { splitSec: SPLIT });
	check('time before the first clip is not a gap — nothing was missed there',
		T.gaps(day).length === 0);
}

{
	const day = T.buildDay([], { splitSec: SPLIT });
	check('an empty day has no coverage', T.coverage(day).length === 0);
	check('and no gaps either', T.gaps(day).length === 0);
}

// ---- hit testing --------------------------------------------------------

group('scrubbing');

{
	const day = T.buildDay([clip('06-00.mp4'), clip('09-35.mp4')], { splitSec: SPLIT });

	const hit = T.at(day, 6 * HOUR + 90);
	check('a moment inside a clip resolves to that clip and an offset',
		hit && hit.clip.name === '06-00.mp4' && hit.offset === 90,
		JSON.stringify(hit && { n: hit.clip.name, o: hit.offset }));
	check('the first frame of a clip belongs to it',
		T.at(day, 6 * HOUR).offset === 0);
	check('the instant a clip ends belongs to the next one, not this one',
		T.at(day, 6 * HOUR + SPLIT) === null);
	check('a moment in a gap resolves to nothing rather than snapping',
		T.at(day, 8 * HOUR) === null);

	check('skipping forward from a gap lands on the next footage',
		T.nextCovered(day, 8 * HOUR) === 9 * HOUR + 35 * 60,
		'got ' + T.nextCovered(day, 8 * HOUR));
	check('skipping from inside footage stays put',
		T.nextCovered(day, 6 * HOUR + 10) === 6 * HOUR + 10);
	check('past the last footage there is nowhere to skip to',
		T.nextCovered(day, 23 * HOUR) === null);
}

// ---- the detail window --------------------------------------------------

group('the zoom window can never leave the day');

{
	const w = T.window(12 * HOUR + 30 * 60, HOUR);
	check('centres on the playhead', w.from === 12 * HOUR && w.to === 13 * HOUR,
		w.from + '..' + w.to);

	const early = T.window(5 * 60, HOUR);
	check('clamps at midnight instead of going negative',
		early.from === 0 && early.width === HOUR, early.from + '/' + early.width);

	const late = T.window(T.DAY - 60, HOUR);
	check('clamps at the end of the day', late.to === T.DAY, 'got ' + late.to);

	const huge = T.window(12 * HOUR, T.DAY * 3);
	check('a window wider than a day is the day', huge.width === T.DAY);
}

// ---- formatting ---------------------------------------------------------

group('what the numbers read as');

check('clock is wall time, zero padded', T.clock(12 * HOUR + 4 * 60 + 7) === '12:04:07');
check('hhmm drops the seconds', T.hhmm(12 * HOUR + 4 * 60 + 7) === '12:04');
check('duration under a minute is seconds', T.duration(42) === '42 s');
check('duration reads like the clip list', T.duration(1112) === '18 min 32 s');
check('a whole number of minutes drops the seconds', T.duration(1200) === '20 min');
check('hours read as hours', T.duration(3 * HOUR + 25 * 60) === '3 h 25 min');
check('bytes match the size on the card', T.bytes(373011831) === '356 MB');
check('gigabytes get a decimal', T.bytes(11 * 1073741824) === '11.0 GB');

done();
