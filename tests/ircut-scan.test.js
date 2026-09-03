// Finding the IR-cut wiring by driving pairs of pads.
//
// This exists because the subject drives hardware blind and reports a verdict
// nobody can check by eye. Two GPIO numbers written into majestic's config look
// exactly as plausible when they are wrong as when they are right.
//
// The cautionary history is worth stating, because the tests are shaped by it.
// The first version pulsed ONE pad at a time and reported a hit — and the hit
// was an artefact: handing a pad back floating springs a brake-held filter
// open, and that change got credited to whichever pad was under the sweep. It
// named a real IR-cut pad by luck. So the fixtures below model the mechanism
// measured on a XiongMai 85H50AI, not a convenient abstraction of it:
//
//   float either pad       -> OPEN
//   both low (braked)      -> holds position, zero current
//   a high against b low   -> moves one way
//   b high against a low   -> moves the other way
'use strict';

const path = require('path');
const { check, group, done } = require('./assert');

const scan = require(path.join(__dirname, '..', 'www', 'a', 'ircut-scan.js'));

const banks = (n, base) => {
	const b = { banks: [], assigned: [], held: [] };
	for (let i = 0; i < n; i++) b.banks.push({ base: (base || 0) + i * 8, n: 8 });
	return b;
};
const B10 = banks(10);
const OPEN = { gmin: 1.0 }, CLOSED = { gmin: 0.03 };

// A filter on pads `pa`/`pb`, brake-held or latching, driven through the same
// io the real scan uses.
function camera(pa, pb, opts) {
	opts = opts || {};
	const log = [];
	let closed = !!opts.startClosed;
	let braked = true;
	return {
		log: log,
		get closed() { return closed; },
		io: {
			drive: (a, b) => {
				log.push('drive ' + a + ',' + b);
				braked = true;
				if ((a === pb && b === pa)) closed = true;      // pb high closes
				else if ((a === pa && b === pb)) closed = false; // pa high opens
				return Promise.resolve({ done: true });
			},
			release: (a, b) => {
				log.push('release ' + a + ',' + b);
				// Floating the FILTER's pads springs a brake-held one open.
				if (opts.latching) return Promise.resolve({ done: true });
				if ((a === pa || a === pb) && (b === pa || b === pb)) {
					braked = false;
					closed = false;
				}
				return Promise.resolve({ done: true });
			},
			look: () => Promise.resolve(closed ? CLOSED : OPEN),
			wait: () => Promise.resolve(),
		},
	};
}

// ---------------------------------------------------------------------------
group('pairs: the search space, narrowest tier first');
{
	const p = scan.pairs(B10);
	check('the commonest wiki pair is tried first',
		p[0][0] === 11 && p[0][1] === 10, JSON.stringify(p[0]));
	const adj = p.findIndex((x) => x[0] === 16 && x[1] === 17);
	const far = p.findIndex((x) => x[0] === 16 && x[1] === 20);
	check('neighbours in a bank come before distant ones in it', adj < far, adj + ' vs ' + far);
	// An H-bridge takes both inputs from one place, and every wiki pair but
	// Anjoy's SSC377 (11 and 80) is same-bank. Cross-bank is thousands of
	// trials, so it is opt-in rather than default.
	const cross = p.filter((x) => Math.floor(x[0] / 8) !== Math.floor(x[1] / 8) &&
		!scan.KNOWN_PAIRS.some((k) => k[0] === x[0] && k[1] === x[1]));
	check('cross-bank pairs are not in the default list', cross.length === 0, cross.length);
	check('...but exhaustive asks for them',
		scan.pairs(B10, { exhaustive: true }).length > p.length * 10);
	check('no pair is repeated',
		new Set(p.map((x) => Math.min(...x) + ':' + Math.max(...x))).size === p.length);
	check('no pad is paired with itself', p.every((x) => x[0] !== x[1]));
}

group('pairs: the pad list is the SoC\'s, never a constant');
{
	check('a 17-bank SoC yields more pairs than a 10-bank one',
		scan.pairs(banks(17)).length > scan.pairs(B10).length);
	// Novatek numbers its pads in the 200s.
	const nt = scan.pairs({ banks: [{ base: 224, n: 16 }], assigned: [], held: [] });
	check('a non-zero base is honoured', nt.every((x) => x[0] >= 224 && x[1] >= 224));
	const owned = scan.pairs(Object.assign({}, B10, { assigned: [{ pin: 11 }] }));
	check('an assigned pad is in no pair', !owned.some((x) => x.indexOf(11) >= 0));
	// A driver's claim is hardware wired on purpose; a sysfs export is only
	// majestic's, and on a brake-held board it holds the filter.
	const h = scan.pairs(Object.assign({}, banks(1), {
		held: [{ pin: 3, owner: 'reset' }, { pin: 1, owner: 'sysfs' }],
	}));
	check('a driver-held line is in no pair', !h.some((x) => x.indexOf(3) >= 0));
	check('a sysfs export stays a candidate', h.some((x) => x.indexOf(1) >= 0));

	// The two coils are what this sweep is FOR. Skipping a pad already on one
	// of them made a camera with one coil assigned unable to find the pair
	// containing it: every pair that could have been the answer was absent from
	// the list, the sweep ran to the end, and it reported nothing (#273).
	const half = scan.pairs(Object.assign({}, B10, {
		assigned: [{ pin: 11, role: 'irCutPin1' }, { pin: 52, role: 'backlightPin' },
			{ pin: 66, role: 'lightSensorPin' }],
	}));
	check('a pad already on a coil is still a candidate',
		half.some((x) => x.indexOf(11) >= 0));
	check('and the pair it belongs to is still tried first',
		half[0][0] === 11 && half[0][1] === 10, JSON.stringify(half[0]));
	// Not a blanket un-skip: these two are deliberate assignments to another
	// function, and driving the lamp mid-sweep would change the very picture
	// the scan reads its answer off.
	check('the illuminator is not a candidate', !half.some((x) => x.indexOf(52) >= 0));
	check('nor is the daylight sensor', !half.some((x) => x.indexOf(66) >= 0));
}

// ---------------------------------------------------------------------------
group('classify: a change, not an absolute');
{
	check('open to closed is a hit', scan.classify(1.0, 0.03) !== null);
	check('closed to open is a hit, the other way',
		scan.classify(0.03, 1.0).opens === true);
	check('a still scene is not a hit', scan.classify(0.05, 0.06) === null);
	check('noise under the bar is not a hit',
		scan.classify(0.4, 0.4 + scan.HIT_DELTA - 0.01) === null);
}

// ---------------------------------------------------------------------------
group('run: it finds the pair, and only the pair');
{
	const c = camera(11, 10);          // 10 high closes, 11 high opens
	scan.run(c.io, scan.pairs(B10), { settleMs: 0 }).then((r) => {
		check('a pair is found', !!r.found, JSON.stringify(r.found));
		check('it is the right one',
			r.pins && Math.min(r.pins.irCutPin1, r.pins.irCutPin2) === 10 &&
			Math.max(r.pins.irCutPin1, r.pins.irCutPin2) === 11, JSON.stringify(r.pins));
		check('and it knows which pad closes it', r.pins.closesWhenHigh === 10, r.pins.closesWhenHigh);
		check('the filter is left CLOSED, which is what daylight wants', c.closed === true);
		return second();
	}).catch((e) => check('run threw: ' + e.message, false));

	function second() {
		group('run: a filter buried deep in the list is still found');
		// Pads 20/21 are nobody's known pair — it has to walk into the
		// adjacent-in-bank tier to reach them.
		const c2 = camera(20, 21);
		return scan.run(c2.io, scan.pairs(B10), { settleMs: 0 }).then((r) => {
			check('found beyond the known-pairs tier',
				r.pins && Math.min(r.pins.irCutPin1, r.pins.irCutPin2) === 20, JSON.stringify(r.pins));
			check('nothing else was reported', r.found.a === 21 || r.found.a === 20);
			return third();
		});
	}

	function third() {
		group('run: both orderings are tried before a pair is dismissed');
		// Starting CLOSED, the closing ordering changes nothing — only the
		// opening one does. A scan that tried one ordering would walk past its
		// own filter.
		const c3 = camera(11, 10, { startClosed: true });
		return scan.run(c3.io, [[10, 11]], { settleMs: 0 }).then((r) => {
			check('a pair whose first ordering is a no-op is still caught', !!r.found);
			const drives = c3.log.filter((l) => l.indexOf('drive') === 0);
			check('both orderings were driven',
				drives.some((l) => l === 'drive 10,11') && drives.some((l) => l === 'drive 11,10'),
				drives.join(' | '));
			return fourth();
		});
	}

	function fourth() {
		group('run: a pad that is not the filter is handed back');
		const c4 = camera(11, 10);
		return scan.run(c4.io, [[30, 31], [11, 10]], { settleMs: 0 }).then((r) => {
			check('the ruled-out pair was released',
				c4.log.indexOf('release 30,31') >= 0, c4.log.slice(0, 6).join(' | '));
			check('and the real pair was still found', !!r.found);
			return fifth();
		});
	}

	function fifth() {
		group('run: nothing found');
		const c5 = camera(70, 71);
		return scan.run(c5.io, [[1, 2], [3, 4]], { settleMs: 0 }).then((r) => {
			check('no pair is reported', r.found === null);
			check('and it says it finished the list', r.done === true);
			return sixth();
		});
	}

	function sixth() {
		group('run: stopping');
		let stop = false;
		const c6 = camera(70, 71);
		const io = Object.assign({}, c6.io, { stopped: () => stop });
		const orig = c6.io.drive;
		io.drive = (a, b) => { if (c6.log.length > 3) stop = true; return orig(a, b); };
		return scan.run(io, scan.pairs(B10), { settleMs: 0 }).then((r) => {
			check('a stop request ends the sweep', r.found === null);
			check('and it does not claim to have finished', r.done === false);
			return seventh();
		});
	}

	function seventh() {
		group('finish: the filter type falls out of one extra trial');
		// Brake-held: floating the pads springs it open, so majestic has to keep
		// them driven for the day position to survive.
		const brake = camera(11, 10);
		return scan.run(brake.io, [[11, 10]], { settleMs: 0 }).then((r) => {
			check('a filter that springs open when floated is brake-held',
				r.pins.brakeHeld === true, String(r.pins.brakeHeld));
			check('a clean finish is marked settled', r.pins.settled === true);
			const latch = camera(11, 10, { latching: true });
			return scan.run(latch.io, [[11, 10]], { settleMs: 0 }).then((r2) => {
				check('one that holds through a float is latching',
					r2.pins.brakeHeld === false, String(r2.pins.brakeHeld));
				// The case the lab camera could not catch. Starting CLOSED makes
				// the hit the OPENING direction, and the classification then has
				// to compare against the picture after the filter is closed
				// again — not against the frame the hit left behind. The bug
				// only ever erred towards brake-held, which is what that camera
				// is, so the fixture agreed with it.
				const latchOpen = camera(11, 10, { latching: true, startClosed: true });
				return scan.run(latchOpen.io, [[11, 10]], { settleMs: 0 }).then((r3) => {
					check('a latching filter found by its OPENING direction is still latching',
						r3.pins.brakeHeld === false, String(r3.pins.brakeHeld));
					const brakeOpen = camera(11, 10, { startClosed: true });
					return scan.run(brakeOpen.io, [[11, 10]], { settleMs: 0 }).then((r4) => {
						check('and a brake-held one found the same way is still brake-held',
							r4.pins.brakeHeld === true, String(r4.pins.brakeHeld));
						// A pad majestic already holds on a coil is braked and
						// kept exported rather than floated, so the filter is
						// never let go of and the classification cannot be made.
						// null, not false: "it holds its position on its own"
						// would be a claim about a pad nothing released (#273).
						const held = camera(11, 10);
						const heldIo = Object.assign({}, held.io, {
							release: (a, b) => held.io.release(a, b)
								.then(() => ({ done: true, floated: false })),
						});
						return scan.run(heldIo, [[11, 10]], { settleMs: 0 }).then((r5) => {
							check('a release that did not float reports no classification',
								r5.pins.brakeHeld === null, String(r5.pins.brakeHeld));
							check('and the pair itself is still reported',
								r5.pins.irCutPin1 === 11 && r5.pins.irCutPin2 === 10);
							check('and the run still settles',
								r5.pins.settled === true);
							return eighth();
						});
					});
				});
			});
		});
	}

	function eighth() {
		group('run: a failed request stops the sweep, a refusal does not');
		// The endpoint guards pads with owners and says so with done:false —
		// skip that pair and carry on. A request that never arrives is a camera
		// that has stopped answering; treating it as "this pair moved nothing"
		// kept the scan firing GPIO writes at a dead camera for the rest of the
		// list and then reported that nothing moved.
		const refused = [];
		const ioRefuse = {
			drive: (a, b) => { refused.push(a + ',' + b); return Promise.resolve({ done: false, error: 'pad is already assigned' }); },
			release: () => Promise.resolve({ done: true }),
			look: () => Promise.resolve(OPEN),
			wait: () => Promise.resolve(),
		};
		return scan.run(ioRefuse, [[1, 2], [3, 4]], { settleMs: 0 }).then((r) => {
			check('a refused pair is skipped and the sweep continues',
				r.found === null && r.done === true, JSON.stringify(r));
			check('both pairs were offered', refused.length >= 2, refused.join(' | '));

			let n = 0;
			const ioDead = {
				drive: () => { n++; return n > 1 ? Promise.reject(new Error('HTTP 502')) : Promise.resolve({ done: true }); },
				release: () => Promise.resolve({ done: true }),
				look: () => Promise.resolve(OPEN),
				wait: () => Promise.resolve(),
			};
			return scan.run(ioDead, [[1, 2], [3, 4], [5, 6], [7, 8]], { settleMs: 0 }).then(
				() => check('a dead camera must not resolve as a finished scan', false),
				(e) => {
					check('the failure reaches the caller', /502/.test(e.message), e.message);
					// Four pairs, two orderings each, would be eight drives if
					// the sweep had carried on regardless.
					check('and the sweep stopped rather than working the list', n <= 2, 'drives=' + n);
					return ninth();
				});
		});
	}

	function ninth() {
		group('finish: an unfinished follow-up is not a clean find');
		// The pair was watched moving the picture, so it stands. Classifying the
		// filter and leaving it closed can still fail, and presenting that as
		// "Found it" would stage a mapping whose filter is sitting open.
		const c = camera(11, 10);
		let n = 0;
		const io = Object.assign({}, c.io, {
			release: (a, b) => { n++; return n > 0 ? Promise.reject(new Error('gone')) : c.io.release(a, b); },
		});
		return scan.run(io, [[11, 10]], { settleMs: 0 }).then((r) => {
			check('the pair is still reported', r.pins && r.pins.irCutPin1 === 11,
				JSON.stringify(r.pins));
			check('but it is not marked settled', r.pins.settled === false,
				String(r.pins.settled));
			return tenth();
		});
	}

	function tenth() {
		group('casualty: the pair that stopped the camera answering');
		const hung = scan.casualty({ boot: 2000, scan: { pins: [47, 48], started: 1900 } });
		check('an actuation predating this boot names both pads',
			hung && hung.pins.join(',') === '47,48', JSON.stringify(hung));
		check('a completed actuation is not a casualty',
			scan.casualty({ boot: 2000, scan: { pins: [47, 48], started: 1900, survived: true } }) === null);
		check('one from this boot is not a casualty',
			scan.casualty({ boot: 2000, scan: { pins: [47, 48], started: 2100 } }) === null);
		check('no journal, no casualty', scan.casualty({ boot: 2000, scan: {} }) === null);
		done();
	}
}
