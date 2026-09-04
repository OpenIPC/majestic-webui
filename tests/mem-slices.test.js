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
// the camera reports it; a key the camera does not report yields null rather
// than a zero that would read as "nothing here"; and the sentence under the
// chart never says nothing happened over a window in which something did.
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

// The sentence under the chart, lifted the same way. It carries MEM_NAMES,
// MEM_PEAK and spanWords with it.
const lift = (re, extra) => {
	const hit = SRC.match(re);
	if (!hit) {
		console.log('  FAIL could not find ' + re + ' in www/a/dashboard.js');
		process.exit(1);
	}
	return hit[0];
};
const memSentence = vm.runInNewContext('(function(){' +
	lift(/\n\tconst MEM_NAMES = \[[^\]]*\];/) +
	lift(/\n\tconst MEM_PEAK = \d+;/) +
	lift(/\n\tfunction spanWords\(sec\) \{[\s\S]*?\n\t\}\n/) +
	lift(/\n\tfunction memSentence\(pts, held, total\) \{[\s\S]*?\n\t\}\n/) +
	'return memSentence})()', { Math: Math });

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

// The reporter of #322 ran the merged panel on their own gk7205v210 and it
// drew Other climbing 10 -> 24.5 MB through four minutes of streaming and
// falling back as the stream stopped — under a sentence reading "Other -0.1
// MB". The chart showed the event; the sentence, which is the half people
// quote, denied it.
group('the sentence cannot say nothing happened over a window in which something did');
{
	// Five slices; index 4 is Other. Values in MB, times in seconds.
	const at = (t, other) => ({ t: t, v: [0, 1.5, 4, 0.1, other] });
	const climb = [at(0, 10), at(60, 15), at(120, 20), at(180, 24.5), at(240, 10.1)];
	const said = memSentence(climb, 17 * MB, 34 * MB);

	check('the net change is still reported, unrounded away',
		said.indexOf('Other +0.1') >= 0, said);
	check('and the peak both ends hide is named outright',
		said.indexOf('Other rose to 24.5 MB and came back') >= 0, said);
	check('the window it covers is stated, not assumed',
		said.indexOf('Over the last 4 min') >= 0, said);
	check('and what is held leads, as before',
		said.indexOf('Holding 17 of 34 MB.') === 0, said);

	// A trace that only ever went up has no excursion to name — the delta
	// already says everything, and a second clause repeating it would be noise.
	const rising = [at(0, 10), at(120, 17), at(240, 24.5)];
	check('a monotonic climb gets no peak clause, since the delta already says it',
		memSentence(rising, 17 * MB, 34 * MB).indexOf('rose to') < 0);

	// Ordinary breathing must not trip it, or the clause appears forever and
	// stops meaning anything.
	const wobble = [at(0, 10), at(120, 10.6), at(240, 10)];
	check('a sub-megabyte wobble is breathing, not an event',
		memSentence(wobble, 17 * MB, 34 * MB).indexOf('rose to') < 0);

	// A slice the camera never reported takes no part in the sentence.
	const half = [{ t: 0, v: [null, 1.5, 4, 0.1, 10] },
		{ t: 240, v: [null, 1.5, 4, 0.1, 24.5] }];
	check('a slice reported as nothing is not named at all',
		memSentence(half, 17 * MB, 34 * MB).indexOf('Video buffers') < 0);

	check('and one sample is a level, with no change to claim',
		memSentence([at(0, 10)], 17 * MB, 34 * MB) === 'Holding 17 of 34 MB.');
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
