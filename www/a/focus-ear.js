// Focus by ear: the sound grammar.
//
// An installer on a ladder cannot read a phone, so the camera's focus
// measurement is delivered through the ear: beeps that come faster and higher
// as the picture gets sharper, a low note when the lens has gone past the
// sharpest point, and one held tone when it is back on it. This module turns a
// stream of readings into that grammar and nothing else.
//
// What it refuses, and why:
//
// - No DOM, no fetch, no audio, no timers. preview-focus.js polls the camera,
//   paints the card and makes the sound; tests/focus-ear.test.js drives this
//   with a fake clock. Same split as af-state.js.
// - Never a percentage, a grade or the word "sharp". The statistic has no scale
//   between chips (an Ingenic reads 697 565 where an hi3516ev300 reads 9 000),
//   so only a reading's ratio to a reference from the same scene means
//   anything -- see the Focus note in preview-stats.js.
// - The reference is a ratchet with resets, not a sliding window. A window
//   forgets the peak while the installer stands still off it, and then holds
//   the tone on a soft lens. That is the one lie this must never tell.
// - A held tone needs a CONFIRMED peak. The reading's ratio to its own best is
//   1 all the way up a first climb, because the best ratchets with every
//   sample, so a plain ratio would sing "you are there" while still improving.
//   The tone holds only once the reading has fallen clearly below the best
//   since it was set -- the best is a turning point, not the top so far -- and
//   is back on it, flat, for long enough to be a place rather than a moment.
// - A reading is only good for STALE_MS. A tone that outlives the reading it
//   came from asserts a fact the camera stopped supplying; silence and a
//   "lost" cue are the honest answer, and null (an empty body) is ABSENT,
//   never zero: zero is a black scene and a real reading.
(function (root, factory) {
	const api = factory();
	root.MajesticFocusEar = api;
	if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this, function () {
	'use strict';

	const K = {
		// The glue's cadence; STALE_MS is sized from it.
		POLL_MS: 200,
		// Readings are smoothed over about this many samples (alpha 2/(N+1)).
		EMA_N: 3,
		// The best ratchets only when beaten by this much: four times the 0.5 %
		// jitter measured on a static scene, so noise cannot creep the best up.
		NEW_BEST_MARGIN: 0.02,
		// Fallen this far below the best, the best was a real peak.
		CONFIRM_DROP: 0.05,
		// The held tone: on from here, and off again only under CONT_OFF.
		CONT_ON: 0.97,
		CONT_OFF: 0.93,
		// "Gone past it": armed once the reading was near the best, fired once
		// it has clearly left it.
		PAST_ARM: 0.95,
		PAST_FIRE: 0.85,
		// Flat for this long before the held tone may start.
		PLATEAU_MS: 1200,
		// The window the slope is taken over, and how small a slope is flat,
		// per second, as a fraction of the best.
		TREND_MS: 1000,
		FLAT_PER_S: 0.02,
		// Without a reading for this long the sound stops.
		STALE_MS: 700,
		// A cue never repeats inside this.
		CUE_GAP_MS: 1500,
		// Under this fraction of the best for this long, the reference is
		// re-based: a hand re-zoom on a ladder, where no button is reachable.
		FAR_RESET_RATIO: 0.5,
		FAR_RESET_MS: 15000,
		// Beeps per second at the bottom and the top of the range.
		RATE_LO: 1.5,
		RATE_HI: 8,
		// Two octaves, above the 400 Hz a phone or a camera's own small speaker
		// rolls off under (measured in audio-check.js).
		PITCH_LO: 550,
		PITCH_HI: 2200,
		// Fewer readings than this is "listening": slow beeps and no verdict.
		MIN_SAMPLES: 3,
		// A beep is at most this long; short trains get shorter beeps.
		BEEP_MAX_MS: 70,
	};

	const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
	// 0 at a hundredth of the best or less, 1 at the best, logarithmic between.
	const closeness = (r) => (r <= 0 ? 0 : clamp(1 + Math.log10(r) / 2, 0, 1));

	// The camera's answer to /metrics/isp?value=isp_afmetrics: a bare number,
	// or the metric line itself on a build that answers that way, or nothing
	// at all where the chip has no statistic. Three answers, kept apart:
	// a number is a reading (0 included: a black scene); null is ABSENT --
	// nothing, or a negative, which is how some chips spell "no statistic"
	// (-1 was measured on an hi3518ev200); undefined is UNREADABLE -- text
	// that is not a number, an error page, a proxy's apology -- which says
	// nothing about the chip and must not be taken for absence.
	function readValue(text) {
		if (typeof text !== 'string') return undefined;
		const s = text.trim();
		if (!s) return null;
		const n = Number(s.split(/\s+/).pop());
		if (!Number.isFinite(n)) return undefined;
		if (n < 0) return null;
		return n;
	}

	function create() {
		const alpha = 2 / (K.EMA_N + 1);
		let ema = null, best = null, confirmed = false, samples = 0;
		let peakRef = null;         // the best as it stood when it was confirmed
		let lastAt = null;          // when the last good reading arrived
		let trail = [];             // [{ t, v }] over the last TREND_MS
		let flatSince = null;
		let pastArmed = false;
		let continuous = false;
		let lostSaid = false;       // the lost cue, once per outage
		let farSince = null;        // when the reading fell under FAR_RESET_RATIO
		let memory = null;          // a confirmed peak the far re-base put aside
		const lastCue = { best: -Infinity, past: -Infinity, lost: -Infinity };
		let last = quiet('listening', null);

		function quiet(phase, cue) {
			return { now: ema, best: best, ratio: null, phase: phase, rate: 0,
				pitch: null, continuous: false, cue: cue };
		}

		function cueOnce(kind, now) {
			if (now - lastCue[kind] < K.CUE_GAP_MS) return false;
			lastCue[kind] = now;
			return true;
		}

		// A new reference: the reading in hand becomes the best, with nothing
		// yet known about whether it is a peak.
		function rebase() {
			best = ema;
			peakRef = null;
			confirmed = false;
			pastArmed = false;
			continuous = false;
			flatSince = null;
			farSince = null;
		}

		// Start over, a zoom, an autofocus: a new scene, so nothing of the old
		// one may leak into it -- not the best, not the smoothed reading it
		// would be blended with, not a freshness or an outage. The first
		// reading after this is the baseline, on its own.
		function reset(now) {
			ema = null;
			best = null;
			peakRef = null;
			confirmed = false;
			pastArmed = false;
			continuous = false;
			flatSince = null;
			farSince = null;
			memory = null;
			lastAt = null;
			lostSaid = false;
			samples = 0;
			trail = [];
			last = quiet('listening', null);
			void now;
		}

		function slopeOf(now) {
			if (!trail.length || !best) return 0;
			const oldest = trail[0];
			const dt = (now - oldest.t) / 1000;
			if (dt < 0.4) return 0;
			return (ema - oldest.v) / dt / best;
		}

		function step(reading, now) {
			if (reading === null || reading === undefined || !Number.isFinite(reading)) {
				continuous = false;
				last = quiet('absent', null);
				return last;
			}
			lastAt = now;
			lostSaid = false;
			ema = ema === null ? reading : ema + alpha * (reading - ema);
			samples++;
			trail.push({ t: now, v: ema });
			while (trail.length && trail[0].t < now - K.TREND_MS) trail.shift();

			let cue = null;
			if (best === null) {
				rebase();
			} else if (ema > best * (1 + K.NEW_BEST_MARGIN)) {
				// The smoothed reading lags a moving lens, so a lens brought back
				// to rest on the peak reads a little HIGHER than the sweep's
				// record of it. That is the same peak, read better -- the best
				// moves up and the confirmation stands. Only a reading clearly
				// above the confirmed peak is a different, higher one, and only
				// that earns the chime: a first climb, where every sample is a
				// new best, chimes nothing.
				const higher = confirmed && ema > peakRef * (1 + K.CONFIRM_DROP);
				best = ema;
				if (higher) {
					confirmed = false;
					continuous = false;
					if (cueOnce('best', now)) cue = 'best';
				}
			} else if (!confirmed && ema < best * (1 - K.CONFIRM_DROP)) {
				confirmed = true;
				peakRef = best;
			}
			// A best of zero -- a black scene, or a lens cap -- has nothing to
			// be close to: the far end of the grammar, not the near one.
			const ratio = best > 0 ? clamp(ema / best, 0, 1) : 0;

			// Far below the best for a long time is not a lens off its peak, it
			// is a different scene: re-base and start again from here. The
			// confirmed peak is put aside rather than forgotten, because the
			// other thing that reads exactly like this is a lens parked at its
			// end stop -- an autofocus pass does it for twenty seconds -- and
			// a lens that then comes back onto that peak has found it again,
			// not a new one to confirm from scratch.
			if (ratio < K.FAR_RESET_RATIO) {
				if (farSince === null) farSince = now;
				else if (now - farSince >= K.FAR_RESET_MS) {
					if (confirmed) memory = { best: best, peakRef: peakRef };
					rebase();
				}
			} else {
				farSince = null;
			}
			if (memory !== null && ema >= memory.best * (1 - K.CONFIRM_DROP)) {
				best = Math.max(ema, best);
				peakRef = memory.peakRef;
				confirmed = true;
				memory = null;
			}
			const r = best > 0 ? clamp(ema / best, 0, 1) : 0;

			const slope = slopeOf(now);
			const flat = samples >= K.MIN_SAMPLES && Math.abs(slope) < K.FLAT_PER_S &&
				trail.length >= 2 && now - trail[0].t >= 0.4 * K.TREND_MS;
			flatSince = flat ? (flatSince === null ? now : flatSince) : null;

			if (r >= K.PAST_ARM) pastArmed = true;
			if (pastArmed && r < K.PAST_FIRE) {
				pastArmed = false;
				if (cue === null && cueOnce('past', now)) cue = 'past';
			}

			if (continuous) {
				if (r < K.CONT_OFF) continuous = false;
			} else if (r >= K.CONT_ON && confirmed && flatSince !== null &&
				now - flatSince >= K.PLATEAU_MS) {
				continuous = true;
			}

			const listening = samples < K.MIN_SAMPLES;
			// Two decades of the ratio, logarithmically: a focus curve is narrow
			// against the lens's travel, so a linear map would sit at the slow
			// end for most of a sweep and then do everything at once. This way
			// "getting warmer" is audible from a tenth of the best, and the
			// last stretch is left to the low note and the held tone.
			const y = closeness(r);
			const rate = listening ? K.RATE_LO : K.RATE_LO + (K.RATE_HI - K.RATE_LO) * y;
			const pitch = K.PITCH_LO * Math.pow(K.PITCH_HI / K.PITCH_LO, y);
			const held = !listening && continuous;
			const phase = listening ? 'listening'
				: held ? 'peak'
				: slope > K.FLAT_PER_S ? 'sharper'
				: slope < -K.FLAT_PER_S ? 'softer' : 'steady';
			last = { now: ema, best: best, ratio: r, phase: phase, rate: rate,
				pitch: pitch, continuous: held, cue: cue };
			return last;
		}

		// No new reading. The stale watchdog runs here, and so does the plateau
		// clock: a held tone may start between two readings.
		function tick(now) {
			if (lastAt === null) return quiet('listening', null);
			if (now - lastAt > K.STALE_MS) {
				let cue = null;
				if (!lostSaid) {
					lostSaid = true;
					if (cueOnce('lost', now)) cue = 'lost';
				}
				continuous = false;
				flatSince = null;
				const out = quiet('stale', cue);
				out.ratio = last.ratio;
				last = Object.assign({}, out, { cue: null });
				return out;
			}
			if (!continuous && last.ratio !== null && last.ratio >= K.CONT_ON &&
				confirmed && samples >= K.MIN_SAMPLES && flatSince !== null &&
				now - flatSince >= K.PLATEAU_MS) {
				continuous = true;
				last = Object.assign({}, last, { continuous: true, phase: 'peak', cue: null });
				return last;
			}
			return Object.assign({}, last, { cue: null });
		}

		function state() {
			return { ema: ema, best: best, peakRef: peakRef, confirmed: confirmed, samples: samples,
				phase: last.phase, continuous: continuous };
		}

		return { step: step, tick: tick, reset: reset, state: state };
	}

	// Beep timing for one look-ahead window, in the audio clock's seconds, so
	// it can be asserted in node. The cursor carries the next beep's time
	// across windows, which is what keeps a rate change from double-beeping,
	// and whether a held tone is sounding.
	function plan(out, fromT, toT, cursor) {
		const c = cursor || { nextBeepAt: null, holding: false };
		const events = [];
		// Silence asked for is not the same as a window with no beep in it:
		// at slow rates most windows hold no beep while one is already
		// scheduled just past them, and that one must sound. `silent` is the
		// order to take back whatever was scheduled.
		if (!out || (out.rate <= 0 && !out.continuous)) {
			return { events: events, silent: true, cursor: { nextBeepAt: null, holding: false } };
		}
		if (out.continuous) {
			events.push({ kind: 'hold', f: out.pitch });
			return { events: events, silent: false, cursor: { nextBeepAt: null, holding: true } };
		}
		const period = 1 / out.rate;
		let next = c.nextBeepAt;
		if (next === null || next < fromT) next = fromT;
		const ms = Math.min(K.BEEP_MAX_MS, 500 / out.rate);
		while (next < toT) {
			events.push({ kind: 'beep', at: next, f: out.pitch, ms: ms });
			next += period;
		}
		return { events: events, silent: false, cursor: { nextBeepAt: next, holding: false } };
	}

	return { K: K, create: create, readValue: readValue, plan: plan };
});
