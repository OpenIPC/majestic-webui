// Is the IR-cut filter configured, and is it actually moving?
//
// The filter is a latching solenoid: majestic pulses a GPIO to swing it in for
// daylight and out for night. Get that wrong and the camera does not complain
// anywhere — it streams, it records, ONVIF is happy, every counter looks
// normal. The only symptom is the picture, and the picture only tells you at
// the wrong time of day. The commonest fault is not a wrong value but a MISSING
// one: with no nightMode.irCutPin1 majestic never drives the filter at all, it
// stays wherever it powered up, and a camera left open in daylight streams a
// saturated magenta image that its owner assumes is a white-balance bug.
//
// Three things live here, in increasing order of what they cost and how sure
// they are:
//
//   diagnose()  reads config + the metrics the heartbeat already polls. Free,
//               passive, and catches the missing-pin case outright.
//   stats()     the two colour statistics that recognise an open filter in a
//               daylight frame.
//   probe()     drives the filter and watches the picture change. The only one
//               of the three that can tell "wired backwards" from "not wired",
//               because it is a measurement rather than an inference.
//
// A separate file because all of it fails silently. A decision table that
// reaches the wrong verdict still renders a confident sentence, and a colour
// statistic that is subtly wrong still produces a plausible number — neither is
// checkable by looking at the page, and neither can be reproduced on demand in
// a browser (it needs a camera, daylight and a filter that moves). tests/
// ircut-check.test.js drives all three directly.
(function () {
	'use strict';

	// ---------------------------------------------------------------------
	// Tier 0/1 — config and metrics
	// ---------------------------------------------------------------------

	// GPIO 0 is a real pin (the wiki lists RESET=0 on several XM boards), so
	// nothing here may test a pin for truthiness. Absent means absent.
	function pin(v) {
		// Number(false) is 0 and GPIO 0 is a real pin, so a boolean would sail
		// through as a configured pad and silence the missing-pin finding. Only
		// a number, or a string that is one, is a pin.
		if (typeof v === 'boolean') return null;
		if (v === null || v === undefined || v === '') return null;
		if (typeof v !== 'number' && typeof v !== 'string') return null;
		const n = Number(v);
		return isNaN(n) ? null : n;
	}
	const has = (v) => pin(v) !== null;

	// Is anything wired to the filter at all? The same question the missing-pin
	// finding asks, exported because the dashboard's "no filter here" dismissal
	// has to be dropped the moment the answer becomes yes — a claim that the
	// camera has no filter cannot outlive someone configuring one.
	function wired(nm) {
		// EITHER coil. The filter is an H-bridge across two pads and the map
		// assigns them independently, so a camera with only the opening coil
		// set is half-configured, not unfitted — and it is exactly the camera
		// that needs the missing-pin banner rather than a claim that there is
		// no filter here. diagnose() still decides separately whether the
		// wiring can actually drive anything.
		const n = nm || {};
		return has(n.irCutPin1) || has(n.irCutPin2);
	}
	// majestic writes booleans as booleans, but a hand-edited majestic.yaml can
	// leave "true" as a string and yaml-cli does not normalise it.
	const on = (v) => v === true || v === 'true' || v === 1 || v === '1';

	// Agreement, and the direction is measured rather than assumed: with the
	// filter in the day position majestic reports ircut_enabled 0 and the
	// picture is correctly coloured; toggling to ircut_enabled 1 opens the
	// filter and the same daylight scene turns magenta. So night and ircut
	// agree when they are equal — 0/0 is day with the filter closed, 1/1 is
	// night with it open.
	// Only meaningful when the camera actually reported both. An absent gauge
	// is not a zero: coercing one made a camera that publishes neither look
	// like day with the filter closed — a state that agrees with itself
	// perfectly and means nothing.
	function known(s) {
		return !!s && s.night !== null && s.night !== undefined &&
			s.ircut !== null && s.ircut !== undefined;
	}
	function agrees(s) {
		return (s.night | 0) === (s.ircut | 0);
	}

	const HUNT_WINDOW_S = 300;
	const HUNT_FLIPS = 3;
	const CONFLICT_S = 30;
	// Consecutive open-looking frames before the picture is allowed to say
	// anything. The dashboard samples every 5s, so this is ~20s of agreement —
	// enough that a frame caught mid-swing, or one magenta lorry crossing the
	// view, cannot raise a banner on its own.
	const PIC_STREAK = 4;

	// Findings, worst first. `fix` names the section to send someone to; the
	// consumer decides whether that becomes a link or a tab switch.
	//
	// `pic` is optional and is what the camera's own picture says: {look,
	// streak} from look() and tracker().picture(). It is deliberately never a
	// verdict on its own — see the note above the picture rules below.
	function diagnose(nm, sample, track, pic) {
		nm = nm || {};
		track = track || {};
		const out = [];
		const monitor = on(nm.lightMonitor);
		// majestic drives the filter from irCutPin1 and returns early when it
		// is unset, whatever else is configured — so a camera holding only the
		// opening coil is exactly as unable to move the filter as one holding
		// nothing, and gets the same finding with a different sentence.
		const driveable = has(nm.irCutPin1);
		// One coil assigned is not half a configuration: majestic switches to
		// single-pin mode and holds that one pad at a LEVEL — high for night,
		// or low with "Single IRcut is inverted" on — instead of pulsing the
		// pair. Legitimate on a board whose filter is switched by one GPIO
		// through a driver, and a slow way to cook a coil on a board that has
		// two. Nothing here can tell those boards apart, so this is stated
		// rather than judged (#273).
		const single = driveable && !has(nm.irCutPin2);

		// The one gate the picture gets, and it is the only portable one there
		// is. An open filter at NIGHT is correct, so the picture may only speak
		// while majestic is in day mode.
		//
		// There is no brightness gate, because there is no brightness to read.
		// isp_again would be the obvious one and it is not comparable across
		// vendors — the same "no gain at all" reads 1024 on HiSilicon, 126 on
		// Ingenic and 20855 on SigmaStar, and SigmaStar reports no isp_avelum
		// to fall back on. Nor can the frame supply it: auto-exposure drives
		// average luminance toward its target whatever the light, so a
		// correctly exposed midnight frame and a correctly exposed noon frame
		// have the same mean by construction. Hence the wording of the finding
		// below names what it cannot rule out instead of pretending to.
		// The day gate needs a camera that SAID it is day. Coercing an absent
		// gauge to 0 would let the picture warn about an open filter on a
		// camera that never reported day or night at all.
		const pictureOpen = !!(pic && pic.look === 'open' && pic.streak >= PIC_STREAK &&
			sample && sample.night === 0);

		if (!driveable) {
			out.push({
				id: 'no-pins', level: 'danger',
				title: 'Majestic cannot move the IR-cut filter',
				detail: (has(nm.irCutPin2)
					? 'The opening coil is connected, but the closing coil is ' +
						'not, and majestic drives the filter from the closing ' +
						'coil\u2019s pad \u2014 without it nothing moves the ' +
						'filter and it stays wherever it powered up. Left open ' +
						'in daylight it makes the whole picture magenta.'
					: 'Nothing is connected to the filter, so nothing moves it ' +
						'and it stays wherever it powered up. Left open in ' +
						'daylight it makes the whole picture magenta.') +
					// Two independent signals agreeing, so this is the one place
					// the picture is allowed to sound certain — and it still
					// only sharpens a finding that stands without it.
					(pictureOpen ? ' The picture agrees: the last few frames have ' +
						'exactly that cast, so the filter is open right now.' : ''),
				fix: 'nightMode',
			});
		} else if (pictureOpen) {
			// Pins are set, so the configuration looks right and only the
			// picture disagrees. That is a reason to MEASURE, not to accuse:
			// the innocent readings are named, and the answer is one button
			// away on the section this points at.
			out.push({
				id: 'picture-open', level: 'warning',
				title: 'The picture looks like an open IR-cut filter',
				detail: 'Recent frames have the magenta cast of infrared reaching ' +
					'the sensor while the camera is in day mode. The pins are ' +
					'configured, so run the IR-cut test to see whether the filter ' +
					'actually moves. A scene lit by an IR lamp, or by magenta ' +
					'light, looks the same from here.',
				fix: 'nightMode',
			});
		}

		// Said on the settings page and nowhere else. It is a true observation
		// about a working configuration, not a fault, so it must not become a
		// dashboard banner that a single-pin board can never be rid of — the
		// same rule that keeps 'manual-only' off the dashboard. It exists
		// because nothing on the page said what one assigned coil does, and a
		// reporter reasonably read the silence as the warning having been lost
		// (#273).
		if (single) {
			out.push({
				id: 'single-coil', level: 'info',
				title: 'The filter is driven from one pad',
				detail: 'Only the closing coil is assigned, so majestic holds ' +
					'that one pad at a level \u2014 one for day, the other for ' +
					'night \u2014 rather than pulsing a pair of coils. That is ' +
					'how a board is driven whose filter is switched by a single ' +
					'GPIO through a driver, and "Single IRcut is inverted" is ' +
					'the switch that swaps which level means night. If the ' +
					'filter in this camera has two coils, assign the opening ' +
					'coil as well: on its own, one coil of a pair is left ' +
					'carrying current for as long as the camera stays in that ' +
					'position.',
				fix: 'nightMode',
			});
		}

		// A monitor with nothing to watch is worse than no monitor: it owns the
		// three runtime switches (wireRuntime hides them while it is on) and
		// then never decides anything, so day/night is frozen AND unreachable.
		const senses = has(nm.lightSensorPin) ||
			(has(nm.minThreshold) && has(nm.maxThreshold));
		if (monitor && !senses) {
			out.push({
				id: 'monitor-blind', level: 'warning',
				title: 'The light monitor has nothing to watch',
				detail: 'The light monitor is on, but nothing tells it how dark ' +
					'it is: no daylight sensor is connected, and no day or night ' +
					'threshold is set.',
				fix: 'nightMode',
			});
		}

		// Thresholds are compared against isp_again, so min must sit BELOW max
		// to leave a band the camera can idle in. Equal is not "no hysteresis
		// but workable" — it is the same gain deciding both directions.
		const lo = pin(nm.minThreshold), hi = pin(nm.maxThreshold);
		if (lo !== null && hi !== null && lo >= hi) {
			out.push({
				id: 'thresholds', level: 'warning',
				title: 'Day and night thresholds leave no hysteresis',
				detail: 'The day threshold (' + lo + ') is not below the night ' +
					'threshold (' + hi + '), so there is no band between switching ' +
					'to night and switching back. Expect the camera to oscillate ' +
					'at dusk.',
				fix: 'nightMode',
			});
		}

		if (driveable && !monitor) {
			out.push({
				id: 'manual-only', level: 'info',
				title: 'Day/night switching is manual',
				detail: 'The filter is wired but the light monitor is off, so ' +
					'nothing moves it at dusk. That is a valid setup for a ' +
					'camera driven over the API; it is a fault if you expected ' +
					'the camera to switch itself.',
				fix: 'nightMode',
			});
		}

		// The two runtime checks below only mean anything while the monitor is
		// driving. With it off, every switch on the Live tab is manual and a
		// deliberate disagreement — filter open in daylight to check an IR
		// lamp, say — is exactly what someone might be doing right now.
		if (monitor && driveable && known(sample)) {
			if (!agrees(sample) && track.conflictS >= CONFLICT_S) {
				out.push({
					id: 'conflict', level: 'danger',
					title: 'Night mode and the IR-cut filter disagree',
					detail: 'The light monitor says it is ' +
						(sample.night ? 'night' : 'day') + ', but the filter has ' +
						'been in the ' + (sample.ircut ? 'night (open)' : 'day (closed)') +
						' position for ' + Math.round(track.conflictS) + 's. The ' +
						'monitor drives both, so they should not differ — which ' +
						'pads are connected is the first thing to check.',
					fix: 'nightMode',
				});
			}
			if (track.flips >= HUNT_FLIPS) {
				out.push({
					id: 'hunting', level: 'warning',
					title: 'The camera keeps switching between day and night',
					detail: track.flips + ' switches in the last ' +
						(HUNT_WINDOW_S / 60) + ' minutes. Widen the gap between the ' +
						'day and night thresholds so dusk cannot sit on the ' +
						'boundary.',
					fix: 'nightMode',
				});
			}
		}

		const rank = { danger: 3, warning: 2, info: 1 };
		return out.sort((a, b) => rank[b.level] - rank[a.level]);
	}

	// Watches the day/night pair over time so diagnose() can stay pure. The
	// clock is passed in and must be monotonic (performance.now), never the
	// camera's node_time_seconds: that gauge steps when NTP corrects it, and a
	// step would read as a flurry of switches.
	function tracker() {
		let flips = [];
		let last = null;
		let conflictAt = null;
		let openRun = 0;
		return {
			// Consecutive frames that looked open. Anything else — an ordinary
			// coloured frame, or one too dark to judge — resets the run rather
			// than merely failing to extend it: a picture that stopped agreeing
			// is not a picture that still agrees a bit.
			picture: function (l) {
				openRun = (l === 'open') ? openRun + 1 : 0;
				return openRun;
			},
			push: function (sample, nowS) {
				// An unreachable camera is not a camera holding still. Returning
				// zeroes without forgetting what came before let the next good
				// sample bill the whole offline gap as one continuing
				// disagreement, and a state that differed across the gap counted
				// as a switch that was never seen. Nothing observed, nothing
				// carried: the run starts again from the first sample back.
				if (!known(sample)) {
					last = null;
					conflictAt = null;
					flips = [];
					return { flips: 0, conflictS: 0 };
				}
				const night = sample.night | 0;
				if (last !== null && last !== night) flips.push(nowS);
				last = night;
				flips = flips.filter(t => nowS - t <= HUNT_WINDOW_S);

				// Timed from when the disagreement STARTED, not counted in
				// samples: the heartbeat backs off and skips ticks on a busy
				// camera, so a sample count is not a duration.
				if (agrees(sample)) conflictAt = null;
				else if (conflictAt === null) conflictAt = nowS;

				return {
					flips: flips.length,
					conflictS: conflictAt === null ? 0 : nowS - conflictAt,
				};
			},
		};
	}

	// ---------------------------------------------------------------------
	// The picture
	// ---------------------------------------------------------------------

	// Pixels darker than this carry no usable colour, and pixels this bright
	// are at or near clipping, where the ratio below is meaningless.
	const DARK = 15, CLIP = 247;
	// Below this many usable pixels the frame is night, a lens cap or a
	// teardown, and nothing here may be concluded from it.
	const MIN_PX = 200;
	// The sample is a thumbnail, not the frame: these are statistics, and
	// 160x90 is 14,400 pixels, plenty for a percentile and small enough that
	// neither the decode nor the readback is felt on a 5s poll.
	const SW = 160, SH = 90;

	// Two statistics over an RGBA buffer, as getImageData hands it over.
	//
	// gmin  — the fraction of usable pixels where green is the MINIMUM channel.
	//         With the filter open, near-infrared rides through the Bayer dyes
	//         into all three channels and the daylight colour matrix then
	//         amplifies what is left, and green ends up the valley in
	//         essentially every pixel. Measured on a paired capture of one
	//         scene: 1.000 open, 0.03-0.07 closed.
	// mex25 — magenta excess ((R+B)/2 - G, normalised by brightness) at the
	//         25th percentile. The percentile rather than the mean is what
	//         makes it a statement about the WHOLE frame rather than about its
	//         loudest part: it only crosses into positive once magenta covers
	//         three quarters of the picture, and gmin holds the range above
	//         that, so between them a magenta OBJECT has to fill nine tenths
	//         of the frame before the pair fires — at which point the frame is
	//         a magenta frame. A warm cast cannot do it at any strength:
	//         sunset and tungsten are R>G>B monotone, and green is never the
	//         valley in a monotone ramp.
	function stats(data, w, h) {
		const n = w * h;
		const vals = new Float64Array(n);
		let k = 0, valley = 0;
		for (let i = 0; i < n; i++) {
			const p = i * 4, r = data[p], g = data[p + 1], b = data[p + 2];
			const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
			if (mx <= DARK || mx >= CLIP) continue;
			const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
			if (g <= mn) valley++;
			const lum = (r + g + b) / 3;
			vals[k++] = ((r + b) / 2 - g) / (lum > 1 ? lum : 1);
		}
		if (!k) return { n: 0, gmin: 0, mex25: 0 };
		const a = Array.prototype.slice.call(vals.subarray(0, k))
			.sort(function (x, y) { return x - y; });
		return { n: k, gmin: valley / k, mex25: a[Math.floor(k * 0.25)] };
	}

	// Both conditions, never either alone. A night frame under colorToGray is
	// R=G=B, which satisfies "green is the minimum" in every pixel and would
	// fire gmin on its own; its magenta excess is 0, which is what stops it.
	function irLook(st) {
		return st.n >= MIN_PX && st.gmin >= 0.90 && st.mex25 >= 0.15;
	}
	// An ordinary coloured frame: green is the valley in only a minority of
	// pixels, which no amount of warm cast produces (a sunset is R>G>B, and
	// green is never the valley in a monotone ramp).
	function colourLook(st) {
		return st.n >= MIN_PX && st.gmin < 0.6;
	}
	// The three answers a frame can give, including "I cannot tell" — which is
	// what a night scene, a lens cap and a mid-swing capture all return.
	function look(st) {
		if (irLook(st)) return 'open';
		if (colourLook(st)) return 'colour';
		return 'none';
	}

	// A decoded <img>/<video> to a look, via the same downscale the probe uses.
	// Reads an element that is already on the page, so the passive check costs
	// no fetch, no session slot and no camera-side work at all.
	function lookAt(src) {
		try {
			const c = document.createElement('canvas');
			c.width = SW; c.height = SH;
			const ctx = c.getContext('2d');
			ctx.drawImage(src, 0, 0, SW, SH);
			return look(stats(ctx.getImageData(0, 0, SW, SH).data, SW, SH));
		} catch (e) {
			// A frame that cannot be drawn (mid-teardown, a zero-sized element,
			// a tainted canvas) is not a frame that says anything.
			return 'none';
		}
	}

	// ---------------------------------------------------------------------
	// Tier 3 — drive it and watch
	// ---------------------------------------------------------------------

	// `day` is the frame captured with majestic in its day position (metrics
	// reporting ircut_enabled 0), `other` the frame after toggling. Four
	// outcomes, and the fourth is the one that keeps this honest: a filter that
	// moves in the dark changes nothing a camera can see, and a camera is never
	// convicted on a test that could not look.
	function verdict(day, other) {
		const dOpen = irLook(day), oOpen = irLook(other);
		const dCol = colourLook(day), oCol = colourLook(other);
		if (dCol && oOpen) return {
			id: 'ok', level: 'ok',
			title: 'The IR-cut filter is wired correctly',
			detail: 'Closing it gave a normally coloured picture and opening it ' +
				'gave the magenta one, which is the right way round.',
		};
		if (dOpen && oCol) return {
			id: 'inverted', level: 'danger',
			title: 'The IR-cut filter is wired backwards',
			detail: 'The picture goes magenta in the DAY position, so the filter ' +
				'opens when it should close. Swap the two coils on the pin map. ' +
				'On a board with only one coil pad, turn on "Single IRcut is ' +
				'inverted" instead.',
		};
		if (dOpen && oOpen) return {
			id: 'stuck-open', level: 'danger',
			title: 'The filter did not move — it is stuck open',
			detail: 'Both positions gave a magenta picture, so the pulse is not ' +
				'reaching the solenoid. Check which pads the two coils are ' +
				'connected to.',
		};
		if (dCol && oCol) return {
			id: 'stuck-closed', level: 'warning',
			title: 'The filter did not move — it is stuck closed',
			detail: 'Both positions gave the same coloured picture. Daylight ' +
				'will look right and night will be almost black on a camera ' +
				'lit by infrared, because the filter goes on blocking exactly ' +
				'the light the illuminator emits; a white-light illuminator is ' +
				'not affected. Check which pads the two coils are connected to.',
		};
		return {
			id: 'unclear', level: 'info',
			title: 'Not enough light to tell',
			detail: 'Neither frame carried enough colour to judge — this test ' +
				'reads the filter off a daylight picture, so run it in daylight, ' +
				'with the lens seeing the scene.',
		};
	}

	// The sequence, with its I/O injected so the ordering can be tested without
	// a camera. `io.snap()` resolves to a stats object, `io.toggle()` flips the
	// filter, `io.state()` reads where the filter is RIGHT NOW, `io.wait(ms)`
	// settles.
	//
	// Two things here are about not lying rather than about working.
	//
	// WHERE IT STARTED is read from the camera, not from whatever the 2s
	// heartbeat last published. Which capture is the day one depends on it, so
	// a stale or absent sample does not produce a slightly-off label — it
	// silently swaps the two frames and reports correct wiring as backwards.
	//
	// WHETHER IT GOT BACK is part of the answer. The restore used to be
	// swallowed so that its failure could not replace the verdict; but a test
	// that moved the filter, failed to put it back, and then said "wired
	// correctly" has left a camera magenta in daylight — precisely the fault
	// this feature exists to find. The verdict is still returned, with
	// `restored: false` beside it, and the caller has to say so.
	function probe(io, startIrcut) {
		const settle = io.settleMs || 1500;
		let moved = false;
		const step = (s) => { if (io.onStep) io.onStep(s); };

		const restore = () => {
			if (!moved) return Promise.resolve(true);
			step('restore');
			return io.toggle().then(() => true, () => false);
		};

		const where = io.state
			? Promise.resolve().then(io.state).catch(() => null)
			: Promise.resolve(null);

		return where.then((live) => {
			// The live reading wins; the caller's guess is the fallback for a
			// camera that cannot answer.
			const start = (live === null || live === undefined) ? startIrcut : live;
			return Promise.resolve()
				.then(() => { step('first'); return io.snap(); })
				.then((first) => {
					step('toggle');
					return io.toggle()
						.then(() => { moved = true; return io.wait(settle); })
						.then(() => { step('second'); return io.snap(); })
						.then((second) => ({ first: first, second: second }));
				})
				.then((pair) => {
					// Which of the two was the day position depends on where the
					// filter started, not on the order they were captured in.
					const day = start ? pair.second : pair.first;
					const other = start ? pair.first : pair.second;
					const v = verdict(day, other);
					return restore().then((ok) => ({
						verdict: v, day: day, other: other, restored: ok,
					}));
				}, (err) => restore().then(() => { throw err; }));
		});
	}

	// Browser-side glue: a JPEG URL to a decoded frame's statistics.
	function snapshot(url) {
		// Through apiFetch and a blob, never Image.src, for the reason the
		// dashboard's snapshot poller gives: a same-origin request that can be
		// answered 401 has to ride the shared pair (the X-Requested-With
		// declaration plus the login redirect), or an expired session answers
		// this with the native Basic prompt that machinery exists to prevent.
		// The cache-buster is what makes the second capture a second capture.
		const bust = url + (url.indexOf('?') < 0 ? '?' : '&') + '_=' + Date.now();
		return window.apiFetch(bust, { cache: 'no-store', credentials: 'same-origin' })
			.then(r => r.ok ? r.blob() : Promise.reject(new Error('HTTP ' + r.status)))
			.then(blob => new Promise(function (resolve, reject) {
				const obj = URL.createObjectURL(blob);
				const img = new Image();
				const bin = (fn) => function () {
					// One revoke on either path: leaking a blob per capture
					// would be a slow leak on a page someone leaves open.
					URL.revokeObjectURL(obj);
					fn();
				};
				img.onload = bin(function () {
					try {
						const c = document.createElement('canvas');
						c.width = SW; c.height = SH;
						const ctx = c.getContext('2d');
						ctx.drawImage(img, 0, 0, SW, SH);
						resolve(stats(ctx.getImageData(0, 0, SW, SH).data, SW, SH));
					} catch (e) { reject(e); }
				});
				img.onerror = bin(function () { reject(new Error('snapshot could not be decoded')); });
				img.src = obj;
			}));
	}

	const api = {
		diagnose: diagnose, tracker: tracker,
		stats: stats, irLook: irLook, colourLook: colourLook,
		look: look, lookAt: lookAt,
		verdict: verdict, probe: probe, snapshot: snapshot, wired: wired,
		HUNT_WINDOW_S: HUNT_WINDOW_S, HUNT_FLIPS: HUNT_FLIPS,
		CONFLICT_S: CONFLICT_S, PIC_STREAK: PIC_STREAK,
	};
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticIrcut = api;
})();
