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
		// The same question the missing-pin finding asks, and it has to be the
		// same question. It used to be EITHER coil, on the reasoning that a
		// half-configured camera is not an unfitted one — true, but it made the
		// dismissal impossible to use on exactly the camera that was showing
		// the banner. With only the closing coil assigned majestic still moves
		// nothing, so the banner stands and offers Dismiss; pressing it
		// recorded the claim, and the next load read a coil, called it a
		// contradiction, and deleted it again. Dismiss, reload, banner (#273).
		//
		// A claim is only contradicted by a filter this camera can actually
		// drive. A pad assigned to a coil that majestic never reaches is not
		// one, and someone pressing Dismiss under that banner is answering
		// about the state they are looking at.
		const n = nm || {};
		return has(n.irCutPin1);
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

	// What the camera says it is waiting, when that is longer than what was
	// asked for — and nothing at all when it is not.
	//
	// This replaced a sentence stating flatly that automatic mode "slows itself
	// down after each flip". Nothing here had ever measured that: across every
	// transition observed on an hi3516ev300 the dwell gauge read back exactly
	// the configured delay and never more. It may well be true on some build,
	// and that is the point — the daemon publishes the wait it is applying, so
	// a page that can READ the number has no business asserting the mechanism
	// behind it. If a backoff exists, this prints it; if it does not, this says
	// nothing and the advice below still stands.
	function stretched(nm, sample) {
		if (!sample || typeof sample.dwell !== 'number' || sample.dwell < 0) return '';
		// Whichever way it is about to go decides which delay was asked for.
		const asked = sample.night ? pin(nm.autoDayDelay) : pin(nm.autoNightDelay);
		if (asked === null || sample.dwell <= asked) return '';
		return 'The camera has already stretched its wait to ' + sample.dwell +
			' s, up from the ' + asked + ' s set below. ';
	}

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
		// majestic drives the filter from irCutPin1 — the OPENING coil, the
		// pad it raises for night — and returns early when it is unset,
		// whatever else is configured. So a camera holding only the closing
		// coil is exactly as unable to move the filter as one holding nothing,
		// and gets the same finding with a different sentence.
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
		// vendors — the units differ (Q10 on HiSilicon and SigmaStar, log2×32
		// on Ingenic) and so do the sensor-specific ceilings, so no one
		// threshold means anything. isp_avelum is published everywhere now and
		// does not help either, for the same reason the frame cannot supply
		// it: auto-exposure drives metered luminance toward its target
		// whatever the light, so a correctly exposed midnight frame and a
		// correctly exposed noon frame have the same mean by construction.
		// Hence the wording of the finding below names what it cannot rule
		// out instead of pretending to.
		// The day gate needs a camera that SAID it is day. Coercing an absent
		// gauge to 0 would let the picture warn about an open filter on a
		// camera that never reported day or night at all.
		const pictureOpen = !!(pic && pic.look === 'open' && pic.streak >= PIC_STREAK &&
			sample && sample.night === 0);

		// Parked: the operator switched the filter off while keeping
		// its wiring. That is a decision, not a defect — every accusation
		// about a filter that does not move stands down, and one observation
		// says what is going on and where the switch is. Explicit === false:
		// an older daemon has no such key, and absent must not read as off.
		const ircutParked = nm.irCutEnabled === false;
		if (ircutParked) {
			if (driveable) {
				out.push({
					id: 'ircut-parked', level: 'info',
					title: 'The IR-cut filter is switched off',
					detail: 'Its pins stay configured, but nothing moves the ' +
						'filter until "Drive the IR-cut filter" is turned back ' +
						'on. Wherever it sits now is where it stays — open in ' +
						'daylight reads magenta, and that is the switch, not ' +
						'the wiring.',
					fix: 'nightMode',
				});
			}
		} else if (!driveable) {
			out.push({
				id: 'no-pins', level: 'danger',
				title: 'Majestic cannot move the IR-cut filter',
				detail: (has(nm.irCutPin2)
					? 'The closing coil is connected, but the opening coil is ' +
						'not, and majestic gives up unless the opening coil has ' +
						'a pad, whatever the other one holds. So nothing moves ' +
						'the filter and it stays wherever it powered up. Left ' +
						'open in daylight it makes the whole picture magenta.'
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
				detail: 'Only the opening coil is assigned, so majestic holds ' +
					'that one pad at a level \u2014 high for night, low for ' +
					'day \u2014 rather than pulsing a pair of coils. That is ' +
					'right for a board whose filter is switched through a ' +
					'driver chip rather than driven coil by coil, and "Single ' +
					'IRcut is inverted" is what swaps which level means night. ' +
					'If the filter in this camera has two coils, assign the closing ' +
					'coil as well: on its own, one coil of a pair is left ' +
					'carrying current for as long as the camera stays in that ' +
					'position.',
				fix: 'nightMode',
			});
		}

		// The switch that only means something in the mode above. Someone who
		// turns it on with both coils assigned has changed nothing and has no
		// way to find that out — the field carries no description on a majestic
		// that predates one, and even with it a settings page cannot say
		// whether THIS camera is in the mode. Reported here, where it can, and
		// it is where the reporter's own question gets its answer: the pad that
		// drives a single-pad filter goes on the opening coil (#273).
		if (on(nm.irCutSingleInvert) && driveable && !single) {
			out.push({
				id: 'invert-inert', level: 'info',
				title: '"Single IRcut is inverted" is doing nothing here',
				detail: 'That switch only applies where one pad drives the ' +
					'filter, and both coils are assigned, so majestic pulses ' +
					'the pair and never reads it. To drive the filter from one ' +
					'pad, leave the closing coil unassigned \u2014 the opening ' +
					'coil is the one majestic drives, and this switch then ' +
					'chooses which level means night.',
				fix: 'nightMode',
			});
		}

		// With nothing wired and nothing calibrated, what happens next depends
		// on the daemon. A current one takes the automatic exposure-based mode
		// — an observation, not a fault — and says so in night_mode_source
		// (carried here as sample.src, null when the gauge is absent). One
		// whose SoC reports no exposure state retires the monitor and says
		// source 0. An older daemon says nothing and is genuinely blind: it
		// owns the three runtime switches (wireRuntime hides them while the
		// monitor is on) and then never decides anything, so day/night is
		// frozen AND unreachable.
		const senses = has(nm.lightSensorPin) ||
			(has(nm.minThreshold) && has(nm.maxThreshold));
		if (monitor && !senses) {
			const src = sample && sample.src != null ? sample.src : null;
			if (src === 4) {
				out.push({
					id: 'auto-active', level: 'info',
					title: 'Automatic day/night is watching the exposure',
					detail: 'No sensor is wired and no thresholds are set, so ' +
						'the camera decides from its own exposure state: night ' +
						'when the sensor runs out of shutter and gain, day when ' +
						'the gain settles back down. Nothing needs calibrating; ' +
						'the thresholds and delays below tune it if the defaults ' +
						'switch too early or too late.',
					fix: 'nightMode',
				});
			} else if (src === 0) {
				out.push({
					id: 'auto-retired', level: 'warning',
					title: 'This camera cannot watch the light by itself',
					detail: 'Automatic day/night is on, but this SoC reports ' +
						'no exposure state to decide from, so it has stood ' +
						'down. Wire a daylight sensor to a GPIO pad and assign ' +
						'it on the map for it to have something to watch.',
					fix: 'nightMode',
				});
			} else {
				out.push({
					id: 'monitor-blind', level: 'warning',
					title: 'Automatic day/night has nothing to watch',
					detail: 'Automatic day/night is on, but nothing tells it how ' +
						'dark it is: no daylight sensor is connected, and no day ' +
						'or night threshold is set. Current firmware decides ' +
						'from the sensor’s own exposure in this situation — ' +
						'this camera has not reported that mode, so a firmware ' +
						'update would give it that.',
					fix: 'nightMode',
				});
			}
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

		// The lamp's own park switch, same shape as the filter's: wiring
		// kept, nothing driven, said once as an observation.
		if (nm.backlightEnabled === false &&
			(has(nm.backlightPin) || (nm.backlightPwmChannel &&
				nm.backlightPwmChannel !== 'none'))) {
			out.push({
				id: 'light-parked', level: 'info',
				title: 'The camera light is switched off',
				detail: 'Its wiring stays configured, but night mode leaves ' +
					'it dark until "Drive the camera light" is turned back on.',
				fix: 'nightMode',
			});
		}

		if (driveable && !monitor) {
			out.push({
				id: 'manual-only', level: 'info',
				title: 'Day/night switching is manual',
				detail: 'The filter is wired but Automatic day/night is off, so ' +
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
		// A parked filter cannot follow the monitor, so the disagreement the
		// conflict finding convicts on is the expected state, not a fault.
		if (monitor && driveable && !ircutParked && known(sample)) {
			if (!agrees(sample) && track.conflictS >= CONFLICT_S) {
				out.push({
					id: 'conflict', level: 'danger',
					title: 'Night mode and the IR-cut filter disagree',
					detail: 'Automatic day/night says it is ' +
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
						(HUNT_WINDOW_S / 60) + ' minutes. ' +
						(sample && sample.src === 4
							? stretched(nm, sample) +
								'Something in view is moving the light on and off — ' +
								'a security lamp, headlights, a sign. Raising ' +
								'"Seconds of brightness before day" and "Seconds ' +
								'of darkness before night" makes the camera sit ' +
								'each one out.'
							: 'Widen the gap between the day and night thresholds ' +
								'so dusk cannot sit on the boundary.'),
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

	// What the light-monitor panel should show for the current sample: the
	// value to chart, the threshold bands to shade behind it, and the one
	// sentence that says what the monitor is doing right now. Pure — the
	// gauges arrive in `v` (the heartbeat's metric map) and the config in
	// `nm` — so the countdown arithmetic and the band construction are
	// testable without a camera at dusk.
	//
	// `chart` says whether there is a continuous value to plot. It is false
	// for every state that has nothing to draw — the switch off, a wired
	// daylight sensor (light or dark and nothing in between), an ADC pad whose
	// reading is never published, a monitor that stood down, an older daemon
	// that says nothing about what it watches. Those used to return null,
	// which took the whole block off the page, so the panel existed only in
	// the two configurations that draw a graph. The reporter of #325 searched
	// a camera in none of them for a section naming the very switch they were
	// being asked to turn on, found it in two hints, and concluded the feature
	// had not shipped for their SoC. A sentence is not a graph, but it is an
	// answer, and it is beside the switch.
	//
	// The local clock behind the countdown, kept here rather than in the page
	// so that it can be driven by a fake one. Two moments, and conflating them
	// is what makes this subtle:
	//
	//   `seen`   the last time the camera ANSWERED. Past `staleS` of silence
	//            the projection stops: a failed poll leaves the last sample
	//            standing, and ageing that one walks the countdown to zero and
	//            announces a switch on behalf of a camera that has gone away.
	//   `anchor` the last time its answer CHANGED. The streak gauge is coarse
	//            — a second on one board, five on another — and the heartbeat
	//            polls every two, so most polls during a pending switch repeat
	//            the previous value. Re-anchoring on those throws away the
	//            second just counted and puts the number back UP: 50, 49, 50,
	//            49. The anchor therefore moves only on a reading that differs,
	//            which covers forward progress and a restarted streak alike.
	function projector(staleS) {
		const limit = typeof staleS === 'number' ? staleS : 6;
		let last = null, anchor = 0, seen = 0;
		const differs = (a, b) =>
			a.night_auto_streak_seconds !== b.night_auto_streak_seconds ||
			a.night_auto_pending !== b.night_auto_pending ||
			a.night_auto_dwell_seconds !== b.night_auto_dwell_seconds;
		return {
			// A successful poll. Returns the age to read this sample forward by.
			push: function (v, nowS) {
				if (!v) { last = null; return 0; }
				if (!last || differs(last, v)) anchor = nowS;
				last = v;
				seen = nowS;
				return nowS - anchor;
			},
			// A tick between polls; null when there is nothing honest left to
			// project from.
			age: function (nowS) {
				if (!last || nowS - seen > limit) return null;
				return nowS - anchor;
			},
		};
	}

	// null now means only that the camera has not answered yet.
	//
	// `ageS` is how long ago `v` was sampled. The camera advances its streak
	// counter on its own schedule — a second here, five seconds on the board
	// the reporter of #325 was watching — and the page polls on a third, so a
	// countdown printed straight from the two gauges lurches by whatever the
	// two cadences happen to beat out. Ageing the streak locally makes it fall
	// a second at a time and resync on every sample: the number is still the
	// camera's, read forward by a clock rather than invented.
	function monitorView(nm, v, ageS) {
		nm = nm || {};
		if (!v) return null;
		const src = ('night_mode_source' in v) ? v.night_mode_source : null;

		// An absent night_enabled is a camera whose state is unknown, and an
		// unknown is not a day — the sentence then simply skips the word.
		const modeWord = v.night_enabled === 1 || v.night_enabled === true
			? 'Night. '
			: v.night_enabled === 0 || v.night_enabled === false ? 'Day. ' : '';

		// Only a camera with a dimmable lamp publishes a duty; a switched
		// lamp gets no invented percentage, and 0 on a dimmer is a real
		// reading (the lamp parked dark), not an absence.
		const duty = v.night_light_duty;
		const lampNote = typeof duty === 'number' && duty >= 0
			? ' Lamp at ' + duty + '%.' : '';

		// A state with no plot: one sentence, no bands, no value.
		const say = (mode, line) => ({
			mode: mode, chart: false, value: null, marks: [],
			line: line, unit: '',
		});

		// The name is the one the switch itself wears on this page. Everything
		// here used to call it "the light monitor", which is what majestic's
		// own hints call it and what nothing on screen is labelled — so the
		// page explained a control using a word the page never printed.
		if (!on(nm.lightMonitor)) {
			return say('off', 'Off — nothing switches this camera between day ' +
				'and night on its own. Turn on Automatic day/night below and ' +
				'this panel says what it is watching.');
		}

		if (src === 4) {
			const dayG = pin(nm.autoDayGain) !== null ? pin(nm.autoDayGain) : 2;
			const nightG = pin(nm.autoNightGain);
			// Each threshold is a rule at its own level rather than a shaded
			// region: the level is the whole fact, and a region's size follows
			// the scale, which is what made the day marker shrink to nothing
			// as the gain rose. Only a threshold that EXISTS gets a line — an
			// automatic camera with no night gain set has no night level to
			// draw, and the sentence says so instead.
			const marks = [{ v: dayG, color: '#2fb673', label: 'day' }];
			if (nightG !== null) {
				marks.push({ v: nightG, color: '#e0a020', label: 'night' });
			}
			const gm = v.night_auto_gain_milli;
			const pend = v.night_auto_pending;
			// A countdown is arithmetic on two gauges; with either missing
			// there is no number to count from, and "switching in 0 s" would
			// be a confident sentence made of nothing.
			const dwell = v.night_auto_dwell_seconds;
			const held = v.night_auto_streak_seconds;
			// Only ever forward, and never past the end: a sample that is
			// somehow stamped in the future must not make the countdown climb,
			// and a monitor whose switch is late must not print a negative.
			// Rounded, not floored. A retell landing 0.9 s after its sample
			// floors to nothing and reprints the number it just printed, so
			// the countdown stutters — 13, 13, 11, 11 — which is the jerk it
			// was meant to remove wearing a smaller amplitude.
			const streak = typeof held === 'number'
				? held + (typeof ageS === 'number' && ageS > 0 ? Math.round(ageS) : 0)
				: null;
			// Bounded by the dwell at the top as well as by zero at the
			// bottom. The countdown is arithmetic on two gauges, and a streak
			// that comes back NEGATIVE — which is what a monotonic-looking
			// "seconds held" turns into the moment the camera's clock is
			// stepped by an NTP correction — makes the subtraction produce a
			// wait LONGER than the one the operator configured. The reporter
			// of #325 was shown 250 s against a 60 s setting. Nothing can be
			// held for less than no time, and nothing can be waited for longer
			// than the dwell, so neither end of that is a reading worth
			// repeating.
			const left = typeof dwell === 'number' && streak !== null
				? Math.max(0, Math.min(dwell, dwell - streak)) : null;
			const inLeft = left === null ? '.' :
				' — switching in ' + left + ' s if it stays.';
			const line = pend === 1
				? 'Dark enough for night' + inLeft
				: pend === 2
					? 'Bright enough for day' + inLeft
					: modeWord + 'Watching the sensor gain' +
						(nightG === null
							? '; night comes when the exposure runs out.'
							: '.');
			return {
				mode: 'auto', chart: true,
				value: gm != null && gm >= 0 ? gm / 1000 : null,
				marks: marks, line: line + lampNote,
				unit: 'x',
			};
		}

		// Source 3 (ADC) is deliberately not here: its reading never appears
		// on /metrics, so there is nothing continuous to chart and isp_again
		// would be a different quantity wearing the monitor's clothes. It gets
		// a sentence of its own below instead.
		//
		// The `src === null` half is the older daemon that publishes no
		// source, and there the precedence has to be reproduced rather than
		// guessed at: a daylight sensor pin decides BEFORE the thresholds do,
		// so a camera holding both is charting a gauge that is not driving it.
		// Hence the pin test here as well as in its own branch below.
		if (src === 2 ||
			(src === null && !has(nm.lightSensorPin) &&
				has(nm.minThreshold) && has(nm.maxThreshold))) {
			const lo = pin(nm.minThreshold), hi = pin(nm.maxThreshold);
			const marks = [];
			if (lo !== null) marks.push({ v: lo, color: '#2fb673', label: 'day' });
			if (hi !== null) marks.push({ v: hi, color: '#e0a020', label: 'night' });
			return {
				mode: 'thresholds', chart: true,
				value: ('isp_again' in v) ? v.isp_again : null,
				marks: marks,
				line: modeWord +
					'Comparing raw sensor gain against the thresholds ' +
					'(vendor-specific units).' + lampNote,
				unit: '',
			};
		}

		// A wired photocell is the one door with no reading behind it: the pad
		// is high or low and nothing in between, so the honest answer is which
		// way it is pointing and why there is no line under it.
		if (src === 1 || (src === null && has(nm.lightSensorPin))) {
			return say('sensor', modeWord + 'The daylight sensor decides. It ' +
				'reports light or dark and nothing in between, so there is no ' +
				'reading to plot here.' + lampNote);
		}
		if (src === 3) {
			return say('adc', modeWord + 'A voltage on the daylight sensor pad ' +
				'decides. The camera does not publish that voltage, so there ' +
				'is nothing to plot here.' + lampNote);
		}
		// The monitor is on and the daemon says nothing is driving it. The
		// finding above names the two ways out; this only says the state.
		if (src === 0) {
			return say('idle', modeWord + 'Nothing is deciding: this camera ' +
				'reports no exposure to watch, and no daylight sensor or ' +
				'threshold is set.' + lampNote);
		}
		return say('unknown', modeWord + 'This firmware does not report what ' +
			'the monitor is watching.' + lampNote);
	}

	const api = {
		diagnose: diagnose, tracker: tracker, monitorView: monitorView,
		projector: projector,
		stats: stats, irLook: irLook, colourLook: colourLook,
		look: look, lookAt: lookAt,
		verdict: verdict, probe: probe, snapshot: snapshot, wired: wired,
		HUNT_WINDOW_S: HUNT_WINDOW_S, HUNT_FLIPS: HUNT_FLIPS,
		CONFLICT_S: CONFLICT_S, PIC_STREAK: PIC_STREAK,
	};
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticIrcut = api;
})();
