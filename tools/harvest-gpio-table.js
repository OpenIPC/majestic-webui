#!/usr/bin/env node
// Turn the wiki's board GPIO table into the prior the pin sweep drives by.
//
// www/a/ircut-scan.js has always taken its candidate ORDER from the IRCUT1 /
// IRCUT2 columns of OpenIPC/wiki en/gpio-settings.md, as a flat list with no
// SoC attached. The same table names each board's RESET, USB_ENA, illuminator
// and strap pads in the columns beside them, and none of that was read — so on
// an SSC338Q the sweep drove the board's RESET pad on its first trial and
// USB_ENA on its second, nineteen trials before it reached the pair it was
// looking for. Harvesting the whole row instead of two columns of it is the
// fix, and doing it mechanically is what keeps the data honest as the table
// grows.
//
// Usage: node tools/harvest-gpio-table.js <path to wiki checkout> [> out.js]
// Writes www/a/ircut-pads.js on stdout.
//
// A cell counts as a pad only when it parses as a number, which is what drops
// board names, model strings and the prose some cells carry without having to
// enumerate which columns hold what. An `i` suffix (the table's mark for an
// active-low pad) and `a/b` (two pads for one function) are both read.
//
// KNOWN GAP, and it is stated rather than papered over: a table is read only
// where a column names the part, which is every board table but not the
// per-function map some pages carry (the GK7205V510 `Function | GPIO / PWM`
// block is the one today). Those name exactly the pads worth demoting — an
// ethernet PHY reset, a sensor power-down — and this harvester does not see
// them, so those parts get the behaviour the sweep had before this file. A
// second shape is worth teaching it when there are two of them, not one.

'use strict';

const fs = require('fs');
const path = require('path');

const wiki = process.argv[2];
if (!wiki) {
	process.stderr.write('usage: harvest-gpio-table.js <wiki checkout>\n');
	process.exit(2);
}
const src = path.join(wiki, 'en', 'gpio-settings.md');
const md = fs.readFileSync(src, 'utf8');

// The column that names the part, and the columns that are prose about the
// board rather than a pad. Everything else is read for numbers.
const SOC_COLS = ['processor'];
const COIL_COLS = ['ircut1', 'ircut2'];

const norm = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
const cells = (line) => line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

// Every integer in a cell. `9i` is pad 9 held low for its active state, `60/59`
// is two pads for one function, `[MS-J10](…)` and `2M-M2103` are not pads at
// all and must not contribute the digits they happen to contain — hence the
// anchored form rather than a scan for /\d+/.
function pads(cell) {
	if (!cell) return [];
	const out = [];
	cell.split('/').forEach((part) => {
		const m = /^\s*(\d{1,3})\s*i?\s*(\[\^\d+\])?\s*$/.exec(part);
		if (m) out.push(Number(m[1]));
	});
	return out;
}

const coils = {};   // soc -> [[a,b], …]
const busy = {};    // soc -> Set of pads the table names as something else
const rows = { total: 0, kept: 0 };

let head = null;
md.split('\n').forEach((line) => {
	if (line.indexOf('|') < 0) { head = null; return; }
	const c = cells(line);
	// A header row is one carrying the column that names the part.
	if (c.some((x) => SOC_COLS.indexOf(norm(x)) >= 0)) { head = c.map(norm); return; }
	// The |---|---| rule under a header, and any table this does not understand.
	if (!head || /^[-: ]+$/.test(c.join(''))) return;

	rows.total++;
	const socIdx = head.findIndex((h) => SOC_COLS.indexOf(h) >= 0);
	const soc = norm(c[socIdx]);
	if (!soc) return;
	rows.kept++;

	const pair = [];
	c.forEach((cell, i) => {
		const col = head[i];
		if (col === undefined) return;
		const p = pads(cell);
		if (!p.length) return;
		if (COIL_COLS.indexOf(col) >= 0) {
			pair[COIL_COLS.indexOf(col)] = p[0];
			// A board listing two pads in one coil column still puts both
			// beyond demotion — either may be a coil somewhere.
			p.forEach((n) => { (coils[soc] = coils[soc] || []); });
		} else if (SOC_COLS.indexOf(col) < 0) {
			busy[soc] = busy[soc] || new Set();
			p.forEach((n) => busy[soc].add(n));
		}
	});
	if (pair.length === 2 && pair[0] !== undefined && pair[1] !== undefined) {
		coils[soc] = coils[soc] || [];
		if (!coils[soc].some((q) => q[0] === pair[0] && q[1] === pair[1]))
			coils[soc].push([pair[0], pair[1]]);
	}
	// A single-coil board still tells us that pad is a coil, which is enough to
	// keep it off the busy list even though it names no pair.
	if (pair[0] !== undefined || pair[1] !== undefined) {
		coils[soc] = coils[soc] || [];
		coils[soc].single = coils[soc].single || new Set();
		[pair[0], pair[1]].forEach((n) => {
			if (n !== undefined) coils[soc].single.add(n);
		});
	}
});

// A pad that is a coil on ANY board with this part is never demoted on any
// other. Two boards can share a SoC and disagree about every pad on it, and
// the cost of the two mistakes is not symmetric: a demoted coil costs a slow
// scan, a promoted reset line costs the camera. Coils win.
const out = {};
Object.keys(busy).concat(Object.keys(coils)).forEach((soc) => {
	const safe = new Set();
	((coils[soc] || []).single || new Set()).forEach((n) => safe.add(n));
	(coils[soc] || []).forEach((q) => { safe.add(q[0]); safe.add(q[1]); });
	const b = Array.from(busy[soc] || new Set())
		.filter((n) => !safe.has(n))
		.sort((x, y) => x - y);
	const c = (coils[soc] || []).map((q) => [q[0], q[1]]);
	if (!b.length && !c.length) return;
	out[soc] = { coils: c, busy: b };
});

const socs = Object.keys(out).sort();
const lit = (v) => JSON.stringify(v);

process.stderr.write(
	`harvested ${rows.kept} of ${rows.total} table rows, ${socs.length} parts\n`);

process.stdout.write(`// GENERATED by tools/harvest-gpio-table.js — do not edit by hand.
// Source: OpenIPC/wiki en/gpio-settings.md. Re-run after that table changes:
//
//   node tools/harvest-gpio-table.js ../wiki > www/a/ircut-pads.js
//
// What the pin sweep knows about a part before it drives anything. Two lists
// per part, and the difference between them is the difference between a
// measurement and a prior:
//
//   coils  the IR-cut pairs the table records for this part. Tried FIRST, so a
//          listed board is normally found on trial one instead of trial twenty.
//   busy   the pads the same rows name as something that is not an IR-cut
//          coil — reset lines, USB enables, illuminators, strap pins. Tried
//          LAST, never skipped: these rows are per BOARD, and a board this
//          table has never seen may put a coil exactly where another one puts
//          its reset. Demotion costs such a board a slow scan; exclusion would
//          cost it the scan altogether.
//
// A pad listed as a coil on any board with this part is absent from busy, even
// where another board with the same part uses it for something else. The two
// mistakes do not cost the same: driving a reset line stops the camera.
(function () {
	'use strict';

	const TABLE = {
`);
socs.forEach((soc) => {
	process.stdout.write(`\t\t${soc}: { coils: ${lit(out[soc].coils)}, busy: ${lit(out[soc].busy)} },\n`);
});
process.stdout.write(`	};

	// The part as the camera spells it — sysinfo's \`soc\`, which is ipcinfo's
	// chip name on most vendors and the boot loader's \`soc\` on SigmaStar — is
	// not spelled the way the wiki's first column is (\`Hi3516Ev300\` against
	// \`hi3516ev300\`, \`Gk7205v200\` against \`gk7205v200\`). Both ends are
	// reduced to letters and digits so neither has to be authoritative.
	function norm(soc) {
		return String(soc || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
	}

	// Always an object, never null: a caller that has to test before reading is
	// a caller that will one day forget, and "this part is not in the table" is
	// an ordinary answer rather than an error. An unknown part gets the
	// behaviour the sweep had before this file existed.
	function forSoc(soc) {
		const e = TABLE[norm(soc)];
		return {
			coils: e ? e.coils.map((p) => [p[0], p[1]]) : [],
			busy: e ? e.busy.slice() : [],
			known: !!e,
		};
	}

	const api = { forSoc: forSoc, TABLE: TABLE };
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticIrcutPads = api;
})();
`);
