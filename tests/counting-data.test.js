// The Counting page's reading of the camera's history.
//
// It earns a test because it fails silently and in the worst direction: an
// hour the camera did not count, drawn as an hour of zero visitors, looks
// exactly like a quiet hour. Reproducing the cases on a camera means unplugging
// it for an hour, running it without a card, or redrawing its lines -- and
// then looking at a chart that is plausible whichever way it is wrong.
'use strict';

const path = require('path');
const { check, group, done } = require('./assert');

const D = require(path.join(__dirname, '..', 'www', 'a', 'counting-data.js'));

// 2026-10-13 09:00 UTC, an hour boundary.
const H = 1791882000;

group('a missing hour is not counted, never zero');
{
	const hist = {
		step: 'hour',
		buckets: [
			{ t: H, covered: 3600, lines: [{ in: 5, out: 3 }], zones: [] },
			{ t: H + 7200, covered: 600, lines: [{ in: 1, out: 0 }], zones: [] },
		],
	};
	const s = D.slots(hist, H, H + 3 * 3600 - 1, H + 10 * 3600);
	check('one slot per hour of the range', s.length === 3);
	check('a whole hour is full', s[0].state === 'full');
	check('the gap carries no numbers', s[1].state === 'none' && s[1].lines === undefined);
	check('ten minutes of an hour is part of one', s[2].state === 'part');
	const t = D.totals(s, 1, 0);
	check('totals add the counted hours only', t.known === 2 && t.lines[0].in === 6 && t.lines[0].out === 3);
}

group('the hour still running is full if counted throughout so far');
{
	const now = H + 1200;
	const s = D.slots({ step: 'hour', buckets: [{ t: H, covered: 1200, lines: [], zones: [] }] }, H, now, now);
	check('20 of the 20 minutes so far', s.length === 1 && s[0].state === 'full');
}

group('nothing counted means unknown, not zero');
{
	const s = D.slots({ step: 'hour', buckets: [] }, H, H + 3599, H + 7200);
	const t = D.totals(s, 1, 1);
	check('no slot is known', t.known === 0);
	check('a failed fetch is no answer', D.state(null) === 'unknown');
	check('off is off', D.state({ enabled: false }) === 'off');
	check('on with nothing to count', D.state({ enabled: true, lines: [], zones: [] }) === 'empty');
	check('on', D.state({ enabled: true, lines: [{}], zones: [] }) === 'on');
}

group('dwell bins in words, and the middle stay');
{
	const e = [10, 30, 60, 120, 300, 600, 1800];
	const w = D.dwellBins(e);
	check('one more bin than edges', w.length === 8);
	check(w[0] + ' … ' + w[7], w[0] === 'under 10 s' && w[7] === 'over 30 min');
	check(w[3], w[3] === '1 min – 2 min');
	check('no stays, no median', D.medianBin([0, 0, 0, 0, 0, 0, 0, 0], e) === null);
	check('median bin', D.medianBin([1, 1, 5, 0, 0, 0, 0, 1], e) === '30 s – 1 min');
}

group('a tile says how much of the period was counted');
{
	const now = H + 13 * 3600;
	const all = D.slots({ step: 'hour', buckets: Array.from({ length: 13 }, (_, i) => ({ t: H + i * 3600, covered: 3600, lines: [], zones: [] })) }, H, now, now);
	check('a fully counted period says nothing', D.coverage(all, 'hour', now) === null);
	const late = D.slots({ step: 'hour', buckets: [{ t: H + 12 * 3600, covered: 600, lines: [], zones: [] }] }, H, now, now);
	check('ten minutes of thirteen hours', D.coverage(late, 'hour', now) === 'counted for 10 min of 13 hours');
	const some = D.slots({ step: 'hour', buckets: [0, 1, 2].map((i) => ({ t: H + i * 3600, covered: 3600, lines: [], zones: [] })) }, H, now, now);
	check('three of thirteen hours', D.coverage(some, 'hour', now) === 'counted for 3 of 13 hours');
	const none = D.slots({ step: 'hour', buckets: [] }, H, now, now);
	check('nothing counted says so', D.coverage(none, 'hour', now) === 'not counted');
}

group('a partial answer is unknown, not a state');
{
	check('enabled missing', D.state({ lines: [], zones: [] }) === 'unknown');
	check('on, but no lines or zones said', D.state({ enabled: true }) === 'unknown');
	const s = D.slots({ step: 'hour', buckets: [{ t: H, covered: 3600 }] }, H, H + 3599, H + 7200);
	check('a bucket without its readings is not counted', s[0].state === 'none');
}

group('history from other lines is not shown under these');
{
	const live = { rules: '5c1e07a2', lines: [{ name: 'door' }], zones: [{ name: 'zone1' }] };
	check('same', D.sameLayout({ rules: '5c1e07a2', lines: ['door'], zones: ['zone1'] }, live) === 'same');
	// The camera's `rules` covers position and direction, which names do not.
	check('the same names under other rules (a line turned round)',
		D.sameLayout({ rules: '0badf00d', lines: ['door'], zones: ['zone1'] }, live) === 'differ');
	// Not saying is not "changed".
	check('no rules on the history', D.sameLayout({ lines: ['door'], zones: ['zone1'] }, live) === 'unknown');
	check('no rules on the live answer', D.sameLayout({ rules: '5c1e07a2' }, { lines: [], zones: [] }) === 'unknown');
	check('no history', D.sameLayout(null, live) === 'unknown');
}

group('a bucket with a malformed reading is not counted');
{
	const Z = { entered: 1, peak: 1, mean: 0.5, dwell: [1, 0, 0, 0, 0, 0, 0, 0] };
	const one = (b) => D.slots({ step: 'hour', buckets: [Object.assign({ t: H, covered: 3600 }, b)] }, H, H + 3599, H + 7200)[0];
	check('a good bucket counts', one({ lines: [{ in: 1, out: 2 }], zones: [Z] }).state === 'full');
	check('a null line', one({ lines: [null], zones: [] }).state === 'none');
	check('a line without out', one({ lines: [{ in: 1 }], zones: [] }).state === 'none');
	check('a null zone', one({ lines: [], zones: [null] }).state === 'none');
	check('a dwell that is not a list', one({ lines: [], zones: [Object.assign({}, Z, { dwell: 3 })] }).state === 'none');
	check('a dwell with a non-number', one({ lines: [], zones: [Object.assign({}, Z, { dwell: [1, 'x'] })] }).state === 'none');
	const t = D.totals([one({ lines: [null], zones: [null] })], 1, 1);
	check('and the totals do not trip over it', t.known === 0);
}

group('follow needs a head that can follow');
{
	check('on, with steps and classes', D.canFollow(true, 'pan tilt steps=4096 follow=people'));
	check('on, no stepping motor', !D.canFollow(true, 'pan tilt follow=people'));
	check('on, nothing to follow with', !D.canFollow(true, 'pan tilt steps=4096'));
	check('off', !D.canFollow(false, 'pan tilt steps=4096 follow=people'));
	check('no capability line', !D.canFollow(true, null));
	// The PTZ pad's rule, not a copy: whatever it says goes.
	check('the pad\'s test decides', !D.canFollow(true, 'pan tilt steps=4096 follow=people', { offered: () => false }));
}

group('a fully counted slot is nearly all of it');
{
	const s = D.slots({ step: 'hour', buckets: [{ t: H, covered: 3420, lines: [], zones: [] }] }, H, H + 3599, H + 7200);
	check('57 of 60 minutes is part of an hour', s[0].state === 'part');
}

group('days back are calendar days');
{
	const t = D.daysBack(H, 6);
	check('local midnight', new Date(t * 1000).getHours() === 0);
	check('six days before', Math.round((D.dayStart(H) - t) / 86400) === 6);
}

group('days are local days');
{
	const s = D.slots({ step: 'day', buckets: [] }, H, H + 3 * 86400, H + 4 * 86400);
	check('every day slot starts at local midnight', s.every((x) => new Date(x.t * 1000).getHours() === 0));
	check('three or four days', s.length >= 3 && s.length <= 4);
}

done();
