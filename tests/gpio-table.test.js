// The harvester that turns the wiki's board GPIO table into www/a/ircut-pads.js.
//
// Its output decides which pads the pin sweep drives first and which it leaves
// until last, and both mistakes are silent. Demote a pad that is really a coil
// and the scan still works, just hundreds of trials later, which reads as "the
// scan did not find my filter". Fail to demote a pad that is really a reset
// line and the sweep drives it early — which is the fault this whole file
// exists because of.
//
// The generated file is committed, so nothing runs this at page load and no
// camera ever executes it. What it protects is the NEXT regeneration: today's
// table happens not to exercise the case below, so a bug in it changes no bytes
// and reviewing the regenerated diff would show nothing at all.
//
// Fed a synthetic table rather than the real wiki, which is a separate
// repository this one cannot depend on.
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { check, group, done } = require('./assert');

const TOOL = path.join(__dirname, '..', 'tools', 'harvest-gpio-table.js');

// Write a throwaway wiki checkout holding just the page the tool reads.
function harvest(markdown) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpio-table-'));
	fs.mkdirSync(path.join(root, 'en'), { recursive: true });
	fs.writeFileSync(path.join(root, 'en', 'gpio-settings.md'), markdown);
	try {
		const js = execFileSync('node', [TOOL, root], { encoding: 'utf8' });
		// The tool writes a browser module; read it the way node can.
		const mod = { exports: {} };
		new Function('module', 'exports', js)(mod, mod.exports);
		return mod.exports;
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

const table = (rows) =>
	'# t\n\n| Processor | IRCUT1 | IRCUT2 | LIGHT IR | RESET | USB_ENA | TESTED BOARDS |\n' +
	'|---|---|---|---|---|---|---|\n' + rows.join('\n') + '\n';

// ---------------------------------------------------------------------------
group('harvest: the ordinary row');
{
	const p = harvest(table(['| SSC338Q | 23 | 24 | 60 | 10 | 8 | MC800S-V3 |']))
		.forSoc('ssc338q');
	check('the part is known', p.known);
	check('its coils are the pair', JSON.stringify(p.coils) === '[[23,24]]',
		JSON.stringify(p.coils));
	check('its reset, lamp and USB pads are busy',
		[8, 10, 60].every((n) => p.busy.indexOf(n) >= 0), JSON.stringify(p.busy));
	check('and neither coil is', p.busy.indexOf(23) < 0 && p.busy.indexOf(24) < 0);
	check('a board name contributes no pads',
		p.busy.indexOf(800) < 0 && p.busy.indexOf(3) < 0, JSON.stringify(p.busy));
}

group('harvest: coils outrank another board\'s idea of the same pad');
{
	// Two boards, one part, disagreeing: the second calls 23 its reset. The
	// rows are per board and the costs are not symmetric — demoting a coil
	// costs a slow scan, driving a reset line costs the camera — so a pad that
	// is a coil anywhere must survive as a candidate everywhere.
	const p = harvest(table([
		'| SSC338Q | 23 | 24 | 60 | 10 | 8 | board-a |',
		'| SSC338Q | 40 | 41 | 61 | 23 | 9 | board-b |',
	])).forSoc('ssc338q');
	check('both pairs are recorded', p.coils.length === 2, JSON.stringify(p.coils));
	check('the contested pad is not demoted', p.busy.indexOf(23) < 0,
		JSON.stringify(p.busy));
	check('the other board\'s uncontested pads still are',
		p.busy.indexOf(9) >= 0 && p.busy.indexOf(61) >= 0, JSON.stringify(p.busy));
}

group('harvest: a coil cell naming two pads keeps both');
{
	// `60/59` in a coil column says both pads are coils on that board. The pair
	// can only take one of them — a pair is two pads and the cell does not say
	// which the other column is wired against — but the one left out must still
	// never be demoted. The code used to take p[0] for the pair and drop the
	// rest on the floor under a comment claiming it kept them, which changed no
	// bytes of the generated file because no row in the real table uses the
	// form yet.
	const p = harvest(table([
		'| SSC338Q | 60/59 | 24 | 12 | 10 | 8 | board-a |',
		'| SSC338Q | 40 | 41 | 13 | 59 | 9 | board-b |',
	])).forSoc('ssc338q');
	check('the pair takes the first of the two', JSON.stringify(p.coils[0]) === '[60,24]',
		JSON.stringify(p.coils));
	check('the second pad of the cell is not demoted', p.busy.indexOf(59) < 0,
		JSON.stringify(p.busy));
	check('even though another row calls it a reset',
		p.busy.indexOf(9) >= 0, JSON.stringify(p.busy));
}

group('harvest: what is not a pad');
{
	const md = '# t\n\n| Processor | IRCUT1 | IRCUT2 | RESET | BOARD |\n' +
		'|---|---|---|---|---|\n' +
		'| SSC338Q | 23 | 24 | 9i | [MS-J10](../en/device-ms-j10.md) |\n' +
		'|  | 11 | 12 | 7 | orphan with no part |\n';
	const all = harvest(md);
	const p = all.forSoc('ssc338q');
	check('an inverted pad is still a pad', p.busy.indexOf(9) >= 0,
		JSON.stringify(p.busy));
	check('a link in a board cell contributes nothing',
		p.busy.indexOf(10) < 0, JSON.stringify(p.busy));
	// A row with no part names nobody's pads, and must not land under the part
	// above it.
	check('a row naming no part is dropped',
		p.coils.every((q) => q[0] !== 11), JSON.stringify(p.coils));
}

group('harvest: a table it cannot read is skipped, not guessed at');
{
	// The per-function shape some pages carry has no column naming the part.
	// Reading it as though the first column were one would attribute another
	// part's pads to whatever came before.
	const md = '# t\n\n| Function | GPIO | Notes |\n|---|---|---|\n' +
		'| IRCUT1 / IRCUT2 | 10 / 11 | dual-pin ICR |\n' +
		'| Ethernet PHY reset | 23 | low |\n';
	const all = harvest(md);
	check('nothing is harvested from it',
		Object.keys(all.TABLE).length === 0, JSON.stringify(all.TABLE));
}

done();
