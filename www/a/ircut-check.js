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
		if (v === null || v === undefined || v === '') return null;
		const n = Number(v);
		return isNaN(n) ? null : n;
	}
	const has = (v) => pin(v) !== null;
	// majestic writes booleans as booleans, but a hand-edited majestic.yaml can
	// leave "true" as a string and yaml-cli does not normalise it.
	const on = (v) => v === true || v === 'true' || v === 1 || v === '1';

	// Agreement, and the direction is measured rather than assumed: with the
	// filter in the day position majestic reports ircut_enabled 0 and the
	// picture is correctly coloured; toggling to ircut_enabled 1 opens the
	// filter and the same daylight scene turns magenta. So night and ircut
	// agree when they are equal — 0/0 is day with the filter closed, 1/1 is
	// night with it open.
	function agrees(s) {
		return (s.night | 0) === (s.ircut | 0);
	}

	const HUNT_WINDOW_S = 300;
	const HUNT_FLIPS = 3;
	const CONFLICT_S = 30;

	// Findings, worst first. `fix` names the section to send someone to; the
	// consumer decides whether that becomes a link or a tab switch.
	function diagnose(nm, sample, track) {
		nm = nm || {};
		track = track || {};
		const out = [];
		const monitor = on(nm.lightMonitor);
		const driveable = has(nm.irCutPin1);

		if (!driveable) {
			out.push({
				id: 'no-pins', level: 'danger',
				title: 'Majestic cannot move the IR-cut filter',
				detail: 'nightMode.irCutPin1 is not set, so nothing drives the ' +
					'filter and it stays wherever it powered up. Left open in ' +
					'daylight it makes the whole picture magenta.',
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
				detail: 'nightMode.lightMonitor is on, but there is no ' +
					'lightSensorPin and no minThreshold/maxThreshold pair, so it ' +
					'has no input to switch on.',
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
				detail: 'minThreshold (' + lo + ') is not below maxThreshold (' +
					hi + '), so there is no gain band between switching to night ' +
					'and switching back. Expect the camera to oscillate at dusk.',
				fix: 'nightMode',
			});
		}

		if (driveable && !monitor) {
			out.push({
				id: 'manual-only', level: 'info',
				title: 'Day/night switching is manual',
				detail: 'The filter is wired but nightMode.lightMonitor is off, ' +
					'so nothing moves it at dusk. That is a valid setup for a ' +
					'camera driven over the API; it is a fault if you expected ' +
					'the camera to switch itself.',
				fix: 'nightMode',
			});
		}

		// The two runtime checks below only mean anything while the monitor is
		// driving. With it off, every switch on the Live tab is manual and a
		// deliberate disagreement — filter open in daylight to check an IR
		// lamp, say — is exactly what someone might be doing right now.
		if (monitor && driveable && sample) {
			if (!agrees(sample) && track.conflictS >= CONFLICT_S) {
				out.push({
					id: 'conflict', level: 'danger',
					title: 'Night mode and the IR-cut filter disagree',
					detail: 'The light monitor says it is ' +
						(sample.night ? 'night' : 'day') + ', but the filter has ' +
						'been in the ' + (sample.ircut ? 'night (open)' : 'day (closed)') +
						' position for ' + Math.round(track.conflictS) + 's. The ' +
						'monitor drives both, so they should not differ — the pin ' +
						'numbers are the first thing to check.',
					fix: 'nightMode',
				});
			}
			if (track.flips >= HUNT_FLIPS) {
				out.push({
					id: 'hunting', level: 'warning',
					title: 'The camera keeps switching between day and night',
					detail: track.flips + ' switches in the last ' +
						(HUNT_WINDOW_S / 60) + ' minutes. Widen the gap between ' +
						'minThreshold and maxThreshold so dusk cannot sit on the ' +
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
		return {
			push: function (sample, nowS) {
				if (!sample) return { flips: 0, conflictS: 0 };
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
				'opens when it should close. Swap nightMode.irCutPin1 and ' +
				'irCutPin2, or flip nightMode.irCutSingleInvert on a single-pin ' +
				'board.',
		};
		if (dOpen && oOpen) return {
			id: 'stuck-open', level: 'danger',
			title: 'The filter did not move — it is stuck open',
			detail: 'Both positions gave a magenta picture, so the pulse is not ' +
				'reaching the solenoid. Check the irCutPin1/irCutPin2 numbers ' +
				'against the board.',
		};
		if (dCol && oCol) return {
			id: 'stuck-closed', level: 'warning',
			title: 'The filter did not move — it is stuck closed',
			detail: 'Both positions gave the same coloured picture. Daylight ' +
				'will look right and night will be almost black, because the ' +
				'filter is blocking the IR lamp. Check the pin numbers.',
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
	// filter and resolves to the new ircut state, `io.wait(ms)` settles.
	//
	// The restore is guarded the way wireCompare's is: this control moves a
	// physical part of the camera, and every exit path — a failed snapshot, a
	// rejected toggle — has to put it back. Leaving a camera open in daylight
	// is precisely the fault this feature exists to find, and shipping a test
	// that can CAUSE it would be worse than shipping nothing.
	function probe(io, startIrcut) {
		const settle = io.settleMs || 1500;
		let moved = false;
		const step = (s) => { if (io.onStep) io.onStep(s); };

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
				const day = startIrcut ? pair.second : pair.first;
				const other = startIrcut ? pair.first : pair.second;
				return { verdict: verdict(day, other), day: day, other: other };
			})
			.finally(() => {
				if (!moved) return;
				step('restore');
				// Swallowed on purpose: the caller is about to be handed either
				// a verdict or the original failure, and a restore that also
				// failed must not replace either with its own error. The camera
				// state is reported by the heartbeat within 2s regardless.
				return io.toggle().catch(() => {});
			});
	}

	// Browser-side glue: a JPEG URL to an RGBA buffer, downscaled. A statistic
	// does not need the full frame — 160x90 is 14,400 pixels, plenty for a
	// percentile, and small enough that the decode is not felt.
	const SW = 160, SH = 90;
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
		verdict: verdict, probe: probe, snapshot: snapshot,
		HUNT_WINDOW_S: HUNT_WINDOW_S, HUNT_FLIPS: HUNT_FLIPS, CONFLICT_S: CONFLICT_S,
	};
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticIrcut = api;
})();
