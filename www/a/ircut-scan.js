// Finding the IR-cut wiring by driving it.
//
// The camera cannot tell you which pads its filter is on. On a camera still
// running vendor firmware it nearly could — the stock app leaves those pads
// configured as driven outputs, which is how ipctool's gpio_possible_ircut()
// spots them — but that evidence dies with the flash. After conversion a
// default majestic.yaml claims no pins, nothing has ever touched those pads,
// and the registers know nothing. What is left is to drive them and watch.
//
// PAIRS, NOT PADS, and this is the whole shape of the thing. The first version
// of this file pulsed one pad at a time, which cannot work: an IR-cut filter is
// driven by an H-bridge across TWO pads, and no single-pad operation actuates
// it. Measured on a XiongMai 85H50AI, every state reachable with one pad:
//
//   float either pad          -> filter OPEN (the brake is released)
//   both pads low             -> holds its position, no current
//   pad A high, pad B low     -> moves one way
//   pad B high, pad A low     -> moves the other way
//
// The single-pad sweep still reported a hit, and that is the cautionary part:
// what it saw was the filter springing open because a pad had been handed back
// floating — a change the pulse did not cause, credited to whichever pad
// happened to be under the sweep at the time. It named a real IR-cut pad by
// luck. A scan that can be right by accident is not a scan.
//
// Two more consequences of the same measurement:
//
//   THE BRAKE HOLDS THE RESULT. Both pads low is zero current and holds
//   whatever position the actuation reached, so j/gpio.cgi leaves a pair braked
//   rather than handing it back. Restoring the pads as found would discard the
//   actuation before anything could look at it.
//
//   THE FILTER TYPE IS DISCOVERABLE. Float the pads after a successful close: a
//   filter that springs open is brake-held and its pads must stay driven, one
//   that stays closed is a latching type. That is worth knowing and costs one
//   extra trial.
(function () {
	'use strict';

	// How much of the frame's colour has to move before a pair is a candidate.
	// Far above frame-to-frame noise on a still scene (under 0.02) and far below
	// the ~0.98 a real filter produces between open and closed.
	const HIT_DELTA = 0.25;
	// Settle between actuating and believing the picture: the filter is
	// mechanical and the encoder is a couple of frames behind it.
	const SETTLE_MS = 900;

	// Pairs that carry an IR-cut somewhere in the OpenIPC wiki's GPIO table,
	// commonest first. A prior over PAIRS of numbers — no vendor is named and
	// none has to be, because the same pairs recur across unrelated makers. It
	// only decides the order things are tried; nothing is excluded by it.
	const KNOWN_PAIRS = [
		[11, 10], [8, 9], [12, 13], [53, 54], [5, 6], [1, 2], [14, 15], [13, 15],
		[33, 34], [38, 39], [43, 44], [50, 51], [52, 53], [58, 57], [60, 59],
		[64, 65], [68, 70], [78, 79], [80, 81], [23, 24], [18, 19], [3, 4],
		[120, 121], [225, 226],
	];

	function key(a, b) { return a < b ? a + ':' + b : b + ':' + a; }

	// Every candidate pair the kernel's pad list allows, ordered by how likely
	// it is to be the filter. Tiers, widening:
	//   1. pairs the wiki has actually seen
	//   2. neighbours within one bank — an H-bridge takes both its inputs from
	//      one place, and every wiki pair but one is same-bank
	//   3. any two pads in one bank
	//   4. across banks, only when asked: Anjoy's SSC377 keeps its coils on 11
	//      and 80, so it exists, but it is thousands of trials
	function pairs(info, opts) {
		opts = opts || {};
		const skip = {};
		(info.assigned || []).forEach((a) => { skip[a.pin] = 1; });
		(opts.exclude || []).forEach((p) => { skip[p] = 1; });
		// A line a kernel DRIVER holds is wired to something deliberate and is
		// the class of pad that resets a PHY or drops a rail. "sysfs" is only an
		// export — majestic's, and on a brake-held board it keeps those pads
		// driven precisely because that is what holds the filter — so those stay
		// candidates.
		(info.held || []).forEach((h) => {
			if (h.owner && h.owner !== 'sysfs') skip[h.pin] = 1;
		});
		(opts.notGpio || []).forEach((p) => { skip[p] = 1; });

		const banks = (info.banks || []).map((b) => {
			const pads = [];
			for (let i = 0; i < b.n; i++) if (!skip[b.base + i]) pads.push(b.base + i);
			return pads;
		});
		const all = {};
		banks.forEach((p) => p.forEach((n) => { all[n] = 1; }));

		const out = [];
		const seen = {};
		const add = (a, b) => {
			if (!all[a] || !all[b] || a === b) return;
			const k = key(a, b);
			if (seen[k]) return;
			seen[k] = 1;
			out.push([a, b]);
		};

		KNOWN_PAIRS.forEach((p) => add(p[0], p[1]));
		banks.forEach((pads) => {
			for (let i = 0; i + 1 < pads.length; i++)
				if (pads[i + 1] === pads[i] + 1) add(pads[i], pads[i + 1]);
		});
		banks.forEach((pads) => {
			for (let i = 0; i < pads.length; i++)
				for (let j = i + 1; j < pads.length; j++) add(pads[i], pads[j]);
		});
		if (opts.exhaustive) {
			const flat = Object.keys(all).map(Number).sort((x, y) => x - y);
			for (let i = 0; i < flat.length; i++)
				for (let j = i + 1; j < flat.length; j++) add(flat[i], flat[j]);
		}
		return out;
	}

	// Did the picture move, and which way? Rising gmin means the frame gained
	// the infrared cast, so that actuation OPENED the filter.
	function classify(from, to) {
		const d = to - from;
		if (Math.abs(d) < HIT_DELTA) return null;
		return { delta: d, opens: d > 0 };
	}

	// Did the last run leave a pair mid-actuation? j/gpio.cgi writes both pads
	// to flash and syncs BEFORE touching a register, so a journal whose
	// actuation began before this boot is the fingerprint of a pair that took
	// the camera down. `survived` is written after the call returns, so its
	// absence is the tell.
	function casualty(info) {
		const s = info && info.scan;
		if (!s || !s.pins || s.survived) return null;
		if (info.boot !== undefined && s.started !== undefined && s.started < info.boot)
			return { pins: s.pins, at: s.started };
		return null;
	}

	// The run. `io` is injected so the ordering can be tested without hardware:
	//   io.drive(a, b) -> actuate a high against b low, leaving the pair braked
	//   io.release(a, b) -> float both, undoing the brake
	//   io.look() -> stats from a/ircut-check.js
	//   io.wait(ms), io.onStep({a, b, index, total}), io.stopped()
	//
	// Nothing is written to the camera's configuration here. The scan proposes;
	// saving and testing are separate, deliberate acts.
	function run(io, list, opts) {
		opts = opts || {};
		const settle = opts.settleMs === undefined ? SETTLE_MS : opts.settleMs;

		// The baseline is read before anything is driven. Folding the first
		// trial's own result into it would make that pair invisible — and the
		// first pair is not an arbitrary one, it is the likeliest filter in the
		// list, so the scan would be blindest exactly where it should be
		// sharpest.
		let base = null;

		const trial = (a, b) =>
			io.drive(a, b)
				.then((r) => (r && r.done === false) ? null
					: io.wait(settle).then(() => io.look()))
				.then((after) => {
					if (!after) return null;
					const c = classify(base.gmin, after.gmin);
					if (c) base = after;
					return c ? { a: a, b: b, opens: c.opens, after: after } : null;
				});

		const step = (i) => {
			if (i >= list.length || (io.stopped && io.stopped()))
				return Promise.resolve({ found: null, done: i >= list.length });
			const a = list[i][0], b = list[i][1];
			if (io.onStep) io.onStep({ a: a, b: b, index: i, total: list.length });
			// Both orderings before moving on: one of them drives the direction
			// the filter is not already in, and only that one changes anything.
			return trial(a, b)
				.then((hit) => hit || trial(b, a))
				.then((hit) => {
					if (hit) return { found: hit, done: false };
					// Ruled out: hand the pads back the way they were found,
					// which for an untouched pad is floating.
					return io.release(a, b).then(() => step(i + 1));
				});
		};

		return io.look().then((first) => {
			base = first;
			return step(0);
		}).then((res) => {
			if (!res.found) return res;
			return finish(io, res.found, base, settle).then((d) => {
				res.pins = d;
				return res;
			});
		});
	}

	// A hit tells us the pair and which pad drove which way. Two things are
	// still worth one trial each: leaving the filter CLOSED (the right position
	// for daylight, and the one whose picture is worth showing), and finding out
	// whether the pads have to stay driven to keep it there.
	function finish(io, hit, base, settle) {
		// The actuation that produced the magenta cast opened it, so the other
		// ordering closes it.
		const closeHigh = hit.opens ? hit.b : hit.a;
		const otherPad = hit.opens ? hit.a : hit.b;

		const out = {
			// Named for what was measured, not for a config key: which pad,
			// driven high against the other, closes the filter.
			closesWhenHigh: closeHigh,
			opensWhenHigh: otherPad,
			// The mapping majestic's two keys want. Verified on a XiongMai
			// 85H50AI, where irCutPin1=11 / irCutPin2=10 is correct and driving
			// 10 high is what closes — so the closing pad is irCutPin2. A board
			// that disagrees is caught by the filter test, which already knows
			// how to say "wired backwards".
			irCutPin1: otherPad,
			irCutPin2: closeHigh,
			brakeHeld: null,
			// The pair is a measurement and stands on its own — it was watched
			// moving the picture. Everything after it (classifying the filter,
			// leaving it closed) can still fail, and when it does the caller
			// has to be told rather than shown a clean "Found it".
			settled: false,
		};

		const ensureClosed = () => hit.opens
			? io.drive(closeHigh, otherPad).then(() => io.wait(settle))
			: Promise.resolve();

		return ensureClosed()
			// Float the pair and look: a filter that springs open is brake-held
			// and its pads must stay driven for the day position to survive; one
			// that stays closed is a latching type and can be let go.
			.then(() => io.release(closeHigh, otherPad))
			.then(() => io.wait(settle))
			.then(() => io.look())
			.then((floated) => {
				out.brakeHeld = classify(base.gmin, floated.gmin) !== null
					? true
					: (floated.gmin >= 0.9 ? true : false);
				// Put it back where daylight wants it either way.
				return io.drive(closeHigh, otherPad);
			})
			.then(() => { out.settled = true; return out; })
			.catch(() => out);
	}

	const api = {
		pairs: pairs, classify: classify, casualty: casualty, run: run, finish: finish,
		KNOWN_PAIRS: KNOWN_PAIRS, HIT_DELTA: HIT_DELTA, SETTLE_MS: SETTLE_MS,
	};
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticIrcutScan = api;
})();
