// What leaves the Live bar on a small stage (preview-bar-sheet.js plan): the
// tuning groups, in the bar's order, and ⋯ More only when one of them shows.
// Both fail silently -- a group that should have moved leaves the bar four
// rows tall on a phone, and a More with nothing behind it opens an empty sheet.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'www', 'a', 'preview-bar-sheet.js'), 'utf8'), sandbox,
	{ filename: 'preview-bar-sheet.js' });
const B = sandbox.window.MajesticBarSheet;

const all = ['mj-view-ctl', 'mj-detail-ctl', 'mj-area-ctl', 'mj-peer-ctl', 'mj-audio-ctl', 'mj-talk-ctl',
	'mj-transport-ctl', 'mj-ear-ctl', 'mj-stats-ctl'];

group('a small stage');
{
	const p = B.plan(all, {}, true);
	check('the tuning groups move', p.moved.join() === B.SHEET.join());
	check('View stays in the bar', p.moved.indexOf('mj-view-ctl') < 0);
	check('in the bar\'s own order', p.moved.indexOf('mj-detail-ctl') < p.moved.indexOf('mj-stats-ctl'));
	check('More is offered', p.more === true);
}

group('what the camera has');
{
	const hidden = {};
	for (const id of B.SHEET) hidden[id] = true;
	check('every moved group hidden: no More', B.plan(all, hidden, true).more === false);
	hidden['mj-stats-ctl'] = false;
	check('one shown: More', B.plan(all, hidden, true).more === true);
	check('a group the page lacks is not moved', B.plan(['mj-stats-ctl'], {}, true).moved.join() === 'mj-stats-ctl');
}

group('a larger stage');
{
	const p = B.plan(all, {}, false);
	check('nothing moves', p.moved.length === 0);
	check('no More', p.more === false);
}

done();
