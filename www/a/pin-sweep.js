// Finding out what a pad is wired to, by holding it and seeing what turns up.
//
// The other hunt in this directory drives PAIRS and reads the answer off the
// picture, because that is what an IR-cut filter is: two pads across a bridge,
// and the one thing on these pads a lens can see. It finds a filter and it can
// never find anything else. The person who prompted this work was not looking
// for a filter — he was soldering a wireless module to a converted camera and
// wanted the pad that switches it on, which changes nothing in frame.
//
// So this hunt has a different detector, and the point of it is that the
// detector is the CAMERA. A module coming up is not a subtle thing: an
// interface appears, a device enumerates on a USB bus, a card announces itself
// to the controller, a driver binds to an address. The camera lists what is
// attached to it, holds one pad at a level, lists again, and the difference
// names what the pad does. Nobody watches anything.
//
// The alternative was to put a person in front of the picture and have them
// confirm each pad in turn. Two hundred pads at a second and a half each is
// five minutes the camera can do alone and an afternoon a person will not
// finish — and half the finds here are things a person staring at a video
// stream could not see either.
//
// WHAT LEAVES COUNTS TOO. The camera reports departures the same way it
// reports arrivals, and that is the other half of the reported case: the pads
// around 45 on his board took ethernet down without troubling the camera at
// all. Held for a moment and handed straight back, that is a find with a name
// on it rather than a sweep that mysteriously stops.
(function () {
	'use strict';

	// High first, then low, and both because neither is the obvious one: an
	// enable line is usually active high, a reset usually active low, and a
	// board that wires either way round is normal. A whole pass at one level
	// before the other means the common case is found in half the time rather
	// than the average case being found in all of it.
	const LEVELS = ['high', 'low'];

	function key(pin, level) { return pin + ':' + level; }

	// Which pads may be held, in the order to try them.
	//
	// The same exclusions the pair sweep applies, for the same reasons, and
	// they are not repeated here — see pairs() in ircut-scan.js. Two
	// differences, both because this holds ONE pad rather than driving a
	// bridge:
	//
	//   The IR-cut coils are NOT candidates. A pair sweep is allowed to drive
	//   them because finding the filter is what it is for; holding one for a
	//   second leaves the bridge passing current through a winding sized for a
	//   tenth of one. The camera refuses these itself; the list leaves them out
	//   so the refusal is never reached.
	//
	//   There is no prior. There is no such thing as a pad wireless modules are
	//   usually on, so the order is simply low to high — predictable, which is
	//   worth more here than a guess dressed up as a ranking.
	function pads(info, opts) {
		opts = opts || {};
		const skip = {};
		(info.assigned || []).forEach((a) => { skip[a.pin] = 1; });
		(opts.exclude || []).forEach((p) => { skip[p] = 1; });
		(info.avoid || []).forEach((a) => {
			if (a && typeof a.pin === 'number') skip[a.pin] = 1;
		});
		(info.held || []).forEach((h) => {
			if (h.owner && h.owner !== 'sysfs') skip[h.pin] = 1;
		});
		// What the CHIP says the pad is carrying at this moment. Absent
		// entirely on a part with no pad table, and that absence is not an
		// all-clear — it is the camera being unable to ask.
		const now = info.padNow;
		if (now) Object.keys(now).forEach((p) => { skip[Number(p)] = 1; });

		const only = opts.only;
		const inRange = (pin) => !only ||
			((only.from === undefined || pin >= only.from) &&
				(only.to === undefined || pin <= only.to));

		const out = [];
		(info.banks || []).forEach((b) => {
			for (let i = 0; i < b.n; i++) {
				const pin = b.base + i;
				if (!skip[pin] && inRange(pin)) out.push(pin);
			}
		});
		return out.sort((x, y) => x - y);
	}

	// Every (pad, level) the sweep will try, in order. A whole pass at one
	// level before the next.
	function steps(list, levels) {
		const out = [];
		(levels || LEVELS).forEach((lv) => {
			(list || []).forEach((p) => { out.push([p, lv]); });
		});
		return out;
	}

	// What is left of `list` once everything in `done` is taken out, in order.
	function remaining(list, done) {
		const seen = {};
		(done || []).forEach((k) => { seen[k] = 1; });
		return (list || []).filter((s) => !seen[key(s[0], s[1])]);
	}

	// One arrival, in a sentence somebody who solders can act on.
	//
	// Where the thing names itself the name is used verbatim — a USB
	// descriptor says "802.11n WLAN Adapter", which is better than any phrase
	// this file could compose — and the kernel's own short name goes in
	// brackets after it, because that is what the owner will type next.
	function describe(thing) {
		if (!thing) return '';
		const name = thing.words || 'something';
		return thing.id && thing.id !== name ? name + ' (' + thing.id + ')' : name;
	}

	function list(names) {
		if (names.length < 2) return names[0] || '';
		return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
	}

	// The whole find, in one line: "Pin 47, held high, switched on a wireless
	// adapter (wlan0)." Arrivals and departures are gathered under their own
	// verb rather than each carrying one, because a pad that brings up two
	// things did one thing, not two.
	function sentence(hit) {
		if (!hit) return '';
		const came = [], went = [];
		(hit.found || []).forEach((t) => {
			(t.gone ? went : came).push(describe(t));
		});
		const parts = [];
		if (came.length) parts.push('switched on ' + list(came));
		if (went.length) parts.push('took away ' + list(went));
		if (!parts.length) return '';
		return 'Pin ' + hit.pin + ', held ' + hit.level + ', '
			+ parts.join(' and ') + '.';
	}

	// The run. `io` is injected so the ordering and the stopping rule can be
	// tested without hardware:
	//   io.hold(pin, level) -> {done, found: [{kind, id, words, gone}], partial, error}
	//   io.onStep({pin, level, index, total}), io.stopped()
	//
	// It stops at the FIRST pad that produces a difference. Carrying on would
	// be worse than useless: a module that has just been switched on is still
	// on when the next pad is held, so every later pad would either report the
	// same arrival again or report it leaving, and the one true answer would be
	// buried in a page of noise. The owner acts on the find and runs the sweep
	// again if they want another.
	//
	// Nothing is written to the camera's configuration here. The sweep
	// proposes; saving is a separate, deliberate act.
	function run(io, list, opts) {
		opts = opts || {};
		const out = { hit: null, tried: [], refused: [], stopped: false };
		const total = list.length;

		const step = (i) => {
			if (i >= total) return Promise.resolve(out);
			if (io.stopped && io.stopped()) {
				out.stopped = true;
				return Promise.resolve(out);
			}
			const pin = list[i][0], level = list[i][1];
			if (io.onStep) io.onStep({ pin: pin, level: level, index: i, total: total });
			return Promise.resolve(io.hold(pin, level)).then((r) => {
				r = r || {};
				// A refusal is not a failure of the sweep. The camera names a
				// pad it will not drive and why, and the sweep carries on --
				// the alternative is one console pad ending the whole run.
				if (r.error) {
					out.refused.push({ pin: pin, level: level, why: r.error });
					return step(i + 1);
				}
				out.tried.push(key(pin, level));
				const found = r.found || [];
				if (found.length) {
					out.hit = {
						pin: pin, level: level, found: found,
						partial: !!r.partial,
					};
					return out;
				}
				return step(i + 1);
			}, () => {
				// The request never came back. That is its own answer and the
				// caller has to be told which pad was in flight -- it is very
				// likely the pad that cut the connection, and it is the one
				// thing the camera cannot report about itself.
				out.lost = { pin: pin, level: level };
				return out;
			});
		};
		return step(0);
	}

	// describe() and LEVELS stay inside: one is how sentence() is built and the
	// other is what steps() defaults to, and neither is anybody else's.
	const api = {
		pads: pads, steps: steps, remaining: remaining, run: run,
		sentence: sentence, key: key,
	};
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticPinSweep = api;
})();
