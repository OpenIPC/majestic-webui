// The Memory panel's slices, checked against the three SoC metric fixtures.
//
// This earns a file because the failure is silent and needs hardware to reach:
// slices that do not add up to the total printed beside them still draw a
// confident chart, and the way it goes wrong is that a leak lands in a pool
// nothing plots and every visible line stays flat. That is exactly what the
// first cut of this panel did — on HiSilicon it named 5.9 of the 57.4 MB the
// note said was held, and the 47 MB it missed is the video buffer pool, on the
// SoC family OpenIPC/majestic#311 was reported from.
//
// What must hold: the named slices plus the remainder reconcile with
// MemTotal − MemAvailable exactly; the largest pool on each SoC is named where
// the camera reports it; and a key the camera does not report yields null
// rather than a zero that would read as "nothing here".
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

// memSlices lives inside dashboard.js's IIFE. Rather than execute that whole
// file against a stub DOM, lift the function out of the source and run it —
// so the test still breaks if the arithmetic in the shipped file changes.
const SRC = fs.readFileSync(
	path.join(__dirname, '..', 'www', 'a', 'dashboard.js'), 'utf8');
const m = SRC.match(/\n\tfunction memSlices\(v, held\) \{[\s\S]*?\n\t\}\n/);
if (!m) {
	console.log('  FAIL could not find memSlices() in www/a/dashboard.js');
	process.exit(1);
}
const memSlices = vm.runInNewContext(
	'(function(){' + m[0] + 'return memSlices})()', { Math: Math });

// The parser is main.js's; reuse it so the fixtures are read exactly as the
// browser reads them, MemAvailable synthesis for old kernels included.
const MAIN = fs.readFileSync(
	path.join(__dirname, '..', 'www', 'a', 'main.js'), 'utf8');
const pm = MAIN.match(/\nfunction parseMetrics\(text\) \{[\s\S]*?\n\}\n/);
const parseMetrics = vm.runInNewContext(
	'(function(){' + pm[0] + 'return parseMetrics})()', { Object: Object, isNaN: isNaN });

const MB = 1048576;
const NAMES = ['Video buffers', 'Programs', 'Kernel', 'RAM disk', 'Other'];

function load(fx) {
	const v = parseMetrics(fs.readFileSync(
		path.join(__dirname, 'fixtures', fx), 'utf8')).v;
	const held = v.node_memory_MemTotal_bytes - v.node_memory_MemAvailable_bytes;
	return { v: v, held: held, slices: memSlices(v, held) };
}

const SOCS = [
	['hisilicon', 'metrics-hisi.txt'],
	['ingenic', 'metrics-ingenic.txt'],
	['sigmastar', 'metrics-sstar.txt'],
];

group('the parts reconcile with the whole the note prints beside them');
SOCS.forEach(([soc, fx]) => {
	const { held, slices } = load(fx);
	const sum = slices.reduce((a, x) => a + (x || 0), 0);
	check(soc + ': named slices plus the remainder equal what is held',
		Math.abs(sum - held) < 1,
		(sum / MB).toFixed(1) + ' against ' + (held / MB).toFixed(1) + ' MB');
	check(soc + ': nothing is negative',
		slices.every(x => x == null || x >= 0),
		slices.map((x, i) => NAMES[i] + ' ' + (x == null ? 'n/a' : (x / MB).toFixed(1))).join(', '));
});

group('the biggest pool on each camera is named, not swept into the remainder');
{
	// HiSilicon reserves ~96MB of contiguous memory for the SDK's video
	// buffers and had 47 of it in use when this fixture was taken. Missing it
	// was the whole defect: the remainder would have been 82% of the total.
	const hi = load('metrics-hisi.txt');
	check('hisilicon: the video buffer pool is the largest slice',
		hi.slices.indexOf(Math.max.apply(null, hi.slices.map(x => x || 0))) === 0,
		(hi.slices[0] / MB).toFixed(1) + ' MB of ' + (hi.held / MB).toFixed(1));
	check('hisilicon: the remainder is a minority of what is held',
		hi.slices[4] < hi.held / 2,
		(hi.slices[4] / MB).toFixed(1) + ' MB unattributed');

	// The other two report no such pool, or a token one, and must not have a
	// zero drawn for something they never said.
	const ing = load('metrics-ingenic.txt');
	check('ingenic: a camera reporting no pool gets null, not a zero line',
		ing.slices[0] === null);
	// A token pool smaller than what the camera's own programs hold explains
	// none of the total once they are netted off it, so it reports nothing —
	// which is the under-claiming direction, and the remainder still carries
	// the bytes.
	const ss = load('metrics-sstar.txt');
	check('sigmastar: a pool too small to explain anything reports nothing',
		ss.slices[0] === 0, (ss.slices[0] / MB).toFixed(2) + ' MB');
}

// Measured on a lab camera: pages the CMA allocator has not claimed are
// movable, so writing into tmpfs raises the pool's used figure by the same
// bytes. Reading the raw difference reported that growth twice and invented a
// video-buffer leak that had not happened.
group('the pool is netted against what already names those bytes');
{
	const MT = 120 * MB;
	const at = (cmaUsed, shmem) => memSlices({
		node_memory_CmaTotal_bytes: 96 * MB,
		node_memory_CmaFree_bytes: 96 * MB - cmaUsed,
		node_memory_AnonPages_bytes: 2 * MB,
		node_memory_SUnreclaim_bytes: 4 * MB,
		node_memory_Shmem_bytes: shmem,
	}, MT - (60 * MB - cmaUsed));

	const before = at(30 * MB, 1 * MB);
	const after = at(45 * MB, 16 * MB);   // 15 MB written to the RAM filesystem
	check('15 MB into the RAM filesystem moves the RAM disk slice by 15',
		Math.round((after[3] - before[3]) / MB) === 15);
	check('and moves the pool by nothing, rather than by another 15',
		after[0] === before[0],
		((after[0] - before[0]) / MB).toFixed(1) + ' MB');
	check('so the slices grow by exactly what the camera actually took',
		Math.round((after.reduce((a, x) => a + x, 0) -
			before.reduce((a, x) => a + x, 0)) / MB) === 15);
}

group('an absent key is a hole, not a floor');
{
	const held = 100 * MB;
	check('a camera reporting nothing at all names no slice but the remainder',
		JSON.stringify(memSlices(Object.create(null), held)) ===
		JSON.stringify([null, null, null, null, held]));
	check('and with no total to work from even the remainder is unknown',
		memSlices(Object.create(null), null)[4] === null);
}

done();
