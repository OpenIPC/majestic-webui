// Does the speaker work, does the microphone hear it, and are the two levels
// anywhere near right?
//
// Nothing on the camera answers any of that. There is no level anywhere in the
// API — no meter, no peak, no RMS, nothing in the metrics — so the only way to
// know what a microphone is actually picking up is to read its samples and
// measure them here. That is exactly how the gain range for one SoC family was
// chosen in the first place: somebody streamed the raw capture at each setting,
// measured it by hand, and wrote the numbers down. This file is that procedure,
// for people who cannot do it.
//
// All of it fails silently, which is why it is a separate file with its own
// tests. A verdict reached from a wrong measurement still renders a confident
// sentence. A level computed from a buffer that arrived empty still produces a
// plausible number — and "quiet" and "no data at all" are the two answers that
// must never be confused, because one is a setting to change and the other is a
// microphone that is not there. None of it can be reproduced on demand in a
// browser: it needs a camera, a speaker, a room and a microphone. Here the
// samples are built by construction and the I/O is stubbed, which is the point.
//
// Three tiers, in increasing order of what they cost and how sure they are:
//
//   diagnose()  reads the configuration. Free, passive, and catches the
//               commonest fault outright — a switch that is off.
//   listen()    measures what the microphone is sending. Cheap, and the only
//               thing that can tell a quiet room from a dead input.
//   probe()     plays a known sound and measures what comes back. The only one
//               of the three that can separate "the speaker is silent" from
//               "the microphone is deaf", because it is a measurement rather
//               than an inference.
//
// Everything is measured in dBFS against a full-scale sine, so 0 is the loudest
// sample the format can hold and every reading here is negative.
(function () {
	'use strict';

	// Sixteen-bit samples, so this is the largest magnitude one can hold.
	// 32768 appears too — negative full scale is one louder than positive — and
	// treating it as an overflow rather than a sample is how a clipped buffer
	// starts reading as a quiet one.
	const FULL_SCALE = 32767;

	// A sample at or above this is touching the rails. Not 32767: a converter
	// that is clipping rarely lands exactly there, and a run of samples a
	// hair below full scale is the same distortion with a different number.
	const CLIP_LEVEL = 32200;

	// Fraction of samples at the rails before a reading is called clipped.
	// One sample in a thousand is a transient; a hundredth is a level set too
	// high.
	const CLIP_FRACTION = 0.01;

	// A run of exactly-zero samples this long means the input is not merely
	// quiet. Real capture has dither in it — even a muted analogue front end
	// delivers a wandering LSB — so a long run of identical zeroes is a stream
	// that nothing is filling. 4800 samples is a tenth of a second at 48 kHz
	// and a third of one at 16 kHz, both far longer than any silence a live
	// converter produces.
	const DEAD_RUN = 4800;

	// ...but a long run on its own is not enough, and assuming it was is how a
	// perfectly good microphone got called dead on a camera. A capture stream
	// really does hand over the occasional block of zeroes — at the start of a
	// subscription, or across a level change — and one of those inside an
	// otherwise loud reading is a gap, not a dead input. So the zeroes also
	// have to be almost all of what arrived.
	const DEAD_FRACTION = 0.98;

	// Where a level wants to sit. The window is wide because the right answer
	// depends on the room, and narrow enough that landing in it means the
	// quiet parts are above the noise and the loud parts are not clipping.
	const TARGET_DBFS = -20;
	const TARGET_WINDOW = 6;

	// ---------------------------------------------------------------------
	// Measurement
	// ---------------------------------------------------------------------

	function dbfs(amplitude) {
		if (!(amplitude > 0)) return -Infinity;
		return 20 * Math.log10(amplitude / FULL_SCALE);
	}

	// Peak, RMS, how much of it is at the rails, and the longest run of
	// exact zeroes, from interleaved 16-bit samples.
	//
	// Takes an Int16Array so the caller decides how the bytes became samples —
	// the browser reads a stream of little-endian pairs, a test builds them
	// directly. Returns null for an empty buffer rather than a zeroed reading:
	// no samples is not silence, and the difference is the whole point of the
	// dead-input check below.
	function measure(samples) {
		if (!samples || !samples.length) return null;

		let peak = 0;
		let sumsq = 0;
		let clipped = 0;
		let zeros = 0;
		let run = 0;
		let longestRun = 0;

		for (let i = 0; i < samples.length; i++) {
			const s = samples[i];
			const a = s < 0 ? -s : s;
			if (a > peak) peak = a;
			sumsq += s * s;
			if (a >= CLIP_LEVEL) clipped++;
			if (s === 0) {
				zeros++;
				run++;
				if (run > longestRun) longestRun = run;
			} else {
				run = 0;
			}
		}

		const rms = Math.sqrt(sumsq / samples.length);
		return {
			samples: samples.length,
			peak: peak,
			rms: rms,
			peakDb: dbfs(peak),
			rmsDb: dbfs(rms),
			clippedFraction: clipped / samples.length,
			clipping: clipped / samples.length >= CLIP_FRACTION,
			longestZeroRun: longestRun,
			zeroFraction: zeros / samples.length,
			// Exact zeroes for long enough AND for almost all of the reading:
			// nothing is filling the stream. Deliberately NOT "the level is
			// very low" — a quiet room is a setting to change, a dead input is
			// a camera to look at — and deliberately not a long run on its own,
			// which a live stream produces across a gap.
			dead:
				longestRun >= DEAD_RUN &&
				zeros / samples.length >= DEAD_FRACTION,
		};
	}

	// Little-endian 16-bit pairs into samples. Odd trailing byte dropped: a
	// chunked stream can cut anywhere, and half a sample is not one.
	function samplesFromBytes(bytes) {
		const n = bytes.length >> 1;
		const out = new Int16Array(n);
		for (let i = 0; i < n; i++) {
			const lo = bytes[i * 2];
			const hi = bytes[i * 2 + 1];
			const v = lo | (hi << 8);
			out[i] = v & 0x8000 ? v - 0x10000 : v;
		}
		return out;
	}

	// ---------------------------------------------------------------------
	// Tier 0 — the configuration, before anything is measured
	// ---------------------------------------------------------------------

	// What stops a test running at all, said as a sentence somebody can act on.
	// Returns null when nothing does.
	//
	// The two switches are separate on purpose. They gate different halves —
	// one decides whether the camera captures, the other whether it plays — and
	// a page that reported "audio is off" for either would send somebody to the
	// wrong control.
	function diagnose(cfg) {
		const get = (k) => (cfg && cfg.audio ? cfg.audio[k] : undefined);

		if (!cfg || !cfg.audio)
			return {
				blocked: true,
				why: 'The camera has not said what its audio settings are yet.',
			};

		// Absent is not false. A camera that never sent the key has not said
		// its microphone is off — it has said nothing — and a panel that turns
		// silence into "switched off" sends somebody looking for a control to
		// change that may not even be there.
		const micSaid = get('enabled') !== undefined;
		const spkSaid = get('outputEnabled') !== undefined;
		if (!micSaid || !spkSaid)
			return {
				blocked: true,
				unknown: true,
				why:
					'This camera has not said whether its microphone and speaker ' +
					'are switched on, so there is no way to tell what a test would ' +
					'be measuring.',
			};

		const mic = get('enabled') === true;
		const spk = get('outputEnabled') === true;

		if (!mic && !spk)
			return {
				blocked: true,
				why:
					'This camera has both its microphone and its speaker switched ' +
					'off, so there is nothing to test yet.',
			};
		if (!spk)
			return {
				blocked: true,
				why:
					'The speaker is switched off, so the camera cannot play the test ' +
					'sound.',
			};
		if (!mic)
			return {
				blocked: true,
				why:
					'The microphone is switched off, so nothing can measure what the ' +
					'speaker plays. The speaker can still be tested on its own.',
				// The speaker half does not need the microphone, and refusing
				// both would hide a test that would have worked.
				speakerOnly: true,
			};

		return null;
	}

	// ---------------------------------------------------------------------
	// The sound to play
	// ---------------------------------------------------------------------

	// A short burst a small speaker can actually reproduce, as 16-bit samples.
	//
	// The band matters more than anything else here, and it is the one thing
	// that is easy to get wrong: the speaker fitted to a camera is a ~30 mm
	// transducer built for speech, and rolls off hard below about 400 Hz. A
	// chord of low tones at full scale is inaudible through one while every
	// meter agrees it played — measured, on a camera, with a listener in the
	// room hearing nothing at all. So: a tone near the middle of the voice
	// band, then a sweep across it.
	//
	// 0.85 rather than 1.0 leaves headroom so the test itself is not what
	// clips, and the speaker is being asked about, not the arithmetic.
	function stimulus(rate, seconds) {
		const sr = rate > 0 ? rate : 8000;
		const secs = seconds > 0 ? seconds : 3;
		const n = Math.floor(sr * secs);
		const out = new Int16Array(n);

		// A quarter of the burst holds a steady tone, the rest sweeps. The
		// steady part is what a person recognises as "the camera beeped"; the
		// sweep is what stops one bad resonance deciding the verdict.
		const steady = Math.floor(n / 4);
		const f0 = 1000;
		const f1 = 3200;

		// Phase is carried across the join rather than restarted, or the
		// waveform steps at the moment the sweep begins and the click is
		// louder than the tone.
		const tSteady = steady / sr;
		const tSweep = Math.max(1 / sr, (n - steady) / sr);
		const phaseAtJoin = 2 * Math.PI * f0 * tSteady;

		for (let i = 0; i < n; i++) {
			const t = i / sr;
			let phase;
			if (i < steady) {
				phase = 2 * Math.PI * f0 * t;
			} else {
				// A linear chirp: frequency rises from f0 to f1 across the
				// sweep, so phase is the integral of that, f0*u + k*u^2/2.
				const u = t - tSteady;
				const k = (f1 - f0) / tSweep;
				phase = phaseAtJoin + 2 * Math.PI * (f0 * u + (k * u * u) / 2);
			}
			// A short taper at each end. A burst that starts at full amplitude
			// is a step, and a step is a click that measures as a transient in
			// every band at once.
			//
			// Named "taper" and not the obvious word, which is also a Bootstrap
			// class: the CSS subset is generated by scanning these files for
			// anything that looks like one, so the variable would have kept a
			// rule nothing uses. 126 bytes, on a partition where that is the
			// kind of saving the subset exists for.
			const taper = Math.min(1, Math.min(i, n - 1 - i) / (sr * 0.01));
			out[i] = Math.round(0.85 * FULL_SCALE * taper * Math.sin(phase));
		}
		return out;
	}

	// ---------------------------------------------------------------------
	// Tier 1 — what is the microphone sending
	// ---------------------------------------------------------------------

	// Reads samples for `ms` and measures them.
	//
	// `read` is injected: on a camera it pulls from the capture stream, in a
	// test it hands back whatever the test wants to have arrived. It returns
	// byte chunks, or null when there are no more.
	//
	// `onReady` fires once the FIRST chunk has arrived, which is the only
	// honest signal that samples are flowing — a request that has resolved has
	// not necessarily delivered anything yet. probe() waits for it before
	// starting the sound, because a subscription that takes a moment to open
	// would otherwise let a short burst finish before anything was listening,
	// and a working speaker would be reported as silent.
	async function listen(read, ms, onReady) {
		const deadline = Date.now() + (ms > 0 ? ms : 1000);
		const chunks = [];
		let total = 0;
		let announced = false;

		for (;;) {
			if (Date.now() >= deadline) break;
			const chunk = await read();
			if (!chunk || !chunk.length) break;
			if (!announced) {
				announced = true;
				if (onReady) onReady();
			}
			chunks.push(chunk);
			total += chunk.length;
		}

		if (!total) return null; /* nothing arrived; not silence */

		const joined = new Uint8Array(total);
		let at = 0;
		for (let i = 0; i < chunks.length; i++) {
			joined.set(chunks[i], at);
			at += chunks[i].length;
		}
		return measure(samplesFromBytes(joined));
	}

	// ---------------------------------------------------------------------
	// Choosing a level
	// ---------------------------------------------------------------------

	// What to change a level to, given what the microphone just read.
	//
	// Closed by measurement rather than by any table of what a setting means in
	// hardware, because that mapping differs per chip and per board and is not
	// something a page can know.
	//
	// The step is the interesting part. A first guess has to assume something,
	// and whatever it assumes will be wrong: on one camera twelve points moved
	// the reading by 57 dB, which a fixed "points per dB" turns into an
	// oscillation between the two rails that only stops by luck. So after the
	// first measurement the slope is no longer guessed — it is read off the two
	// most recent points, which is the camera's own curve in the region being
	// used, whatever shape it has elsewhere. `previous` is what carries that.
	//
	// The step is also capped. A pair of readings taken a fraction of a decibel
	// apart implies an enormous slope, and one bad pair should not be able to
	// throw the next round to the far end of the dial.
	function recommend(reading, level, opts) {
		const o = opts || {};
		const target = typeof o.target === 'number' ? o.target : TARGET_DBFS;
		const window = typeof o.window === 'number' ? o.window : TARGET_WINDOW;
		const lo = typeof o.min === 'number' ? o.min : 0;
		const hi = typeof o.max === 'number' ? o.max : 100;
		// The opening guess, used only until two points exist. Timid on
		// purpose: overshooting sends the next round to a rail, and an extra
		// round costs a second.
		const firstGuess = typeof o.gainPerDb === 'number' ? o.gainPerDb : 1.2;
		// No single step may cross more than this much of the dial.
		const maxStep = typeof o.maxStep === 'number' ? o.maxStep : 25;

		if (!reading)
			return { done: false, level: level, why: 'nothing arrived to measure' };

		if (reading.dead)
			return {
				done: true,
				level: level,
				failed: true,
				why: 'the microphone is not sending anything',
			};

		// A clipped reading carries no usable level: every sample is pinned at
		// the rail, so dBFS says "about zero" whatever the dial is doing, and a
		// slope computed from two such readings is describing noise. So step
		// blind — but step FULLY. Measured on a camera whose top third all
		// reads within 2 dB of full scale, a timid step spends the entire round
		// budget crossing ground that was never in doubt and then reports a
		// level that is still distorting. Undershooting is the cheaper mistake:
		// the reading below is real, so the very next round has a slope and
		// climbs back on evidence.
		if (reading.clipping) {
			const next = Math.max(lo, Math.round(level - maxStep));
			return {
				done: next === level,
				level: next,
				why: 'the level is loud enough to distort',
			};
		}

		const err = target - reading.rmsDb;
		if (Math.abs(err) <= window)
			return { done: true, level: level, why: 'the level is in a good range' };

		// Points per dB, from the last two points where there are two and the
		// pair says anything. Both guards matter: the same level twice divides
		// by zero, and two readings a hair apart imply a slope that is really
		// just noise.
		let pointsPerDb = firstGuess;
		const prev = o.previous;
		if (prev && isFinite(prev.rmsDb) && isFinite(reading.rmsDb)) {
			const dLevel = level - prev.level;
			const dDb = reading.rmsDb - prev.rmsDb;
			if (dLevel !== 0 && Math.abs(dDb) >= 1) {
				const slope = Math.abs(dLevel / dDb);
				if (slope > 0.02 && slope < 20) pointsPerDb = slope;
			}
		}

		// -Infinity when the reading was digital silence without being a dead
		// stream: a real setting, at the bottom of its range. Step by a fixed
		// amount rather than by an error that is not a number.
		let step = isFinite(err) ? err * pointsPerDb : 20;
		if (step > maxStep) step = maxStep;
		if (step < -maxStep) step = -maxStep;
		step = Math.round(step);
		// Rounding to zero while still outside the window would stall the loop
		// one step short of an answer.
		if (step === 0) step = err > 0 ? 1 : -1;

		let next = level + step;
		if (next < lo) next = lo;
		if (next > hi) next = hi;

		return {
			done: next === level,
			level: next,
			why: err > 0 ? 'the level is too quiet' : 'the level is too loud',
			pointsPerDb: pointsPerDb,
		};
	}

	// ---------------------------------------------------------------------
	// Tier 2 — play something and measure what comes back
	// ---------------------------------------------------------------------

	// The verdict, from a reading of the room before the sound and a reading
	// during it.
	//
	// The quiet reading is not decoration. Without it a noisy room reads as a
	// working speaker, and the whole test says yes to a camera whose speaker is
	// disconnected. What is being asked is not "was there sound" but "was there
	// MORE sound than before", which is the only question a single microphone
	// in an unknown room can answer.
	function verdict(before, during, opts) {
		const o = opts || {};
		// How much louder the room has to get before the speaker is credited.
		// Below this a reading is within what a room varies by on its own.
		const rise = typeof o.riseDb === 'number' ? o.riseDb : 6;

		if (!before || !during)
			return {
				ok: false,
				severity: 'danger',
				title: 'The test could not be measured.',
				detail:
					'The camera stopped sending microphone samples partway through, ' +
					'so there is nothing to compare.',
			};

		if (during.dead || before.dead)
			return {
				ok: false,
				severity: 'danger',
				title: 'The microphone is not sending anything.',
				detail:
					'Its samples are all silence, which is not what a working input ' +
					'produces even in a quiet room. The speaker was not tested, ' +
					'because nothing could hear it.',
			};

		const delta = during.rmsDb - before.rmsDb;

		if (delta < rise)
			return {
				ok: false,
				severity: 'warning',
				title: 'The microphone did not hear the test sound.',
				detail:
					'The room measured ' + before.rmsDb.toFixed(1) + ' dBFS before ' +
					'and ' + during.rmsDb.toFixed(1) + ' dBFS during, which is no ' +
					'more than it varies by on its own. Either the speaker is not ' +
					'making a sound or the microphone cannot hear it.',
				delta: delta,
			};

		if (during.clipping)
			return {
				ok: true,
				severity: 'warning',
				title: 'The speaker works, but the microphone is overloaded.',
				detail:
					'The test sound came back at ' + during.rmsDb.toFixed(1) +
					' dBFS and is distorting. Lower the microphone level, or the ' +
					'speaker level, until it is not.',
				delta: delta,
			};

		return {
			ok: true,
			severity: 'success',
			title: 'The speaker works and the microphone hears it.',
			detail:
				'The room rose from ' + before.rmsDb.toFixed(1) + ' to ' +
				during.rmsDb.toFixed(1) + ' dBFS while the test sound played.',
			delta: delta,
		};
	}

	// Drive the whole thing: measure the room, play the sound while measuring
	// again, and report.
	//
	// Every side effect is injected, so the sequence can be driven with no
	// camera at all. `onStep` reports progress in words rather than a bar,
	// because the steps have different lengths and a bar that jumps is worse
	// than a sentence that changes.
	async function probe(deps) {
		const step = deps.onStep || function () {};

		step('quiet');
		const before = await deps.listen(deps.quietMs || 1000);

		step('playing');
		// The order here is the measurement. Listening is started first and the
		// sound only begins once samples are actually arriving: the burst is a
		// few seconds long and a capture subscription does not open instantly,
		// so playing first lets part or all of it finish before anything is
		// listening — and a working speaker then gets the "nothing was heard"
		// verdict. Started and not awaited, because the two have to overlap.
		let startPlaying;
		const listening = new Promise((resolve) => {
			startPlaying = resolve;
		});
		const during = deps.listen(deps.soundMs || 2000, startPlaying);
		// ...but not for ever: if nothing ever arrives, onReady never fires, and
		// waiting on it alone would hang the panel. The measurement settling is
		// the other way out, and it carries the null that says so.
		await Promise.race([listening, during]);

		const played = deps.play();
		const measured = await during;
		let playError = null;
		try {
			await played;
		} catch (e) {
			playError = e;
		}

		step('done');

		if (playError)
			return {
				ok: false,
				severity: 'danger',
				title: 'The camera refused to play the test sound.',
				detail: String((playError && playError.message) || playError),
			};

		return verdict(before, measured, deps);
	}

	const api = {
		measure: measure,
		samplesFromBytes: samplesFromBytes,
		dbfs: dbfs,
		diagnose: diagnose,
		stimulus: stimulus,
		listen: listen,
		recommend: recommend,
		verdict: verdict,
		probe: probe,
		FULL_SCALE: FULL_SCALE,
		CLIP_LEVEL: CLIP_LEVEL,
		DEAD_RUN: DEAD_RUN,
		TARGET_DBFS: TARGET_DBFS,
		TARGET_WINDOW: TARGET_WINDOW,
	};
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticAudio = api;
})();
