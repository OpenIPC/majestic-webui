// What the autofocus is doing, in words, from a status endpoint that cannot say.
//
// `GET /autofocus/status` returns one of:
//
//   idle | running | preempted | done fv=… peak=… start=… mag=… pos=… steps=… path=…
//   failed: focus port is not open | failed: no focus statistic
//   failed: lens does not respond
//
// and it carries NO pass identity — no id, no sequence, no timestamp. Nothing in
// the string distinguishes this page's pass from another tab's, from ONVIF's, or
// from the one that ended last week. It is also STICKY: `preempted` and every
// `failed:` stand until some later pass overwrites them, and `idle` is only ever
// seen before the first pass since the plugin loaded. So a page that simply read
// the status out loud would announce a stranger's interruption as its own news,
// on every load, forever.
//
// Hence the one rule this module exists to enforce:
//
//   The page speaks only about passes it started or booked itself, inside a
//   bounded window. Otherwise it is silent — and silence never means "idle".
//
// A *generation* is armed by exactly three events, and nothing else can arm one:
//
//   operator    the Autofocus button was pressed; the trigger's own reply
//               (`started`/`restarted`) is proof a pass exists
//   afterZoom   a zoom verb was released; majestic books a pass ~1.2 s later.
//               There is NO reply to prove it, so this generation may only claim
//               a terminal status after it has actually seen `running`.
//
// Pure: no DOM, no fetch, no timers. `preview-ptz.js` drives it and paints the
// result; `tests/af-state.test.js` drives it with a fake clock. Modelled on
// preview-chain.js, which pulled the same kind of walk out of two pages.
(function (root, factory) {
	const api = factory();
	root.MajesticAfState = api;
	if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this, function () {
	'use strict';

	// A pass can run 10-20 s warm and 40-90 s cold, and a seeded pass that finds
	// nothing re-runs — so the engine's own worst case is about three minutes.
	// Past this we stop asking and say we never heard, rather than say it worked.
	const BUDGET_MS = 200000;
	// How long a pass has to have been running before the wait is worth
	// explaining. Under this a cold search and a warm one look the same.
	const LONG_MS = 25000;

	function isFailure(s) { return s.indexOf('failed:') === 0; }
	function isDone(s) { return s.indexOf('done') === 0; }
	function isTerminal(s) {
		return isDone(s) || isFailure(s) || s === 'preempted';
	}

	// The daemon's own reason, turned into a sentence about this camera. An
	// unrecognised `failed:` is passed through rather than swallowed: a class
	// this page has not heard of is still the engine's best account of itself.
	function failureWords(s) {
		const why = s.slice('failed:'.length).trim();
		if (why === 'focus port is not open')
			return 'The camera could not open the focus motor’s serial port.';
		if (why === 'no focus statistic')
			return 'This camera’s image pipeline does not report a focus measurement, so it cannot focus itself.';
		if (why === 'lens does not respond')
			return 'The lens did not answer.';
		return 'Autofocus failed: ' + why + '.';
	}

	// `mag=-1.0` means the lens MCU never reported its zoom position, so the
	// engine has no parfocal seed and every pass seeks the near stop first.
	// That is why autofocus is slow on this camera, and nothing else says so.
	function magUnknown(s) {
		return / mag=-1\.0(?:\D|$)/.test(s);
	}

	// Where the lens ended up, against the best sharpness this pass has any
	// evidence for: the peak the sweep saw, or the reading it started from,
	// whichever is higher. All three numbers come from the same pass on the
	// same scene, so they ARE comparable — which is what makes this the one
	// honest judgement available about a statistic that has no scale between
	// cameras.
	//
	// `start` belongs in it because the two failures observed look nothing
	// alike. One sweeps past a good peak and parks a quarter below it
	// (fv=9427 peak=13050 start=10809). The other gives up early on a peak
	// that was never as sharp as where it began (fv=9612 peak=9688
	// start=12045) — which passes a peak-only test at 99% while having plainly
	// made the picture worse. Both are "I pressed Autofocus and it got blurry".
	//
	// Null when anything is missing or the best is zero: nothing was
	// measurable, which is a different story and not this one's to tell.
	function shortOfBest(s) {
		const fv = /(?:^|\s)fv=(\d+)/.exec(s);
		const pk = /(?:^|\s)peak=(\d+)/.exec(s);
		const st = /(?:^|\s)start=(\d+)/.exec(s);
		if (!fv || !pk) return null;
		const best = Math.max(+pk[1], st ? +st[1] : 0);
		return best > 0 ? +fv[1] / best : null;
	}

	function create(opts) {
		const o = opts || {};
		const budget = o.budgetMs || BUDGET_MS;
		const longMs = o.longMs || LONG_MS;

		// The status as of the moment the current generation was armed. A
		// terminal string equal to this one proves nothing — it is what was
		// already standing.
		let baseline = null;
		let kind = null;          // 'operator' | 'afterZoom' | null
		let armedAt = 0;
		let sawRunning = false;
		let held = false;         // one of our own lens buttons is down
		let saidMagOnce = false;
		// Did a press of ours preempt this pass? `preempted` alone cannot say —
		// another tab, an ONVIF client or the daemon's own day/night transition
		// reach the engine the same way. Telling the operator they cancelled
		// something they did not touch is the same class of lie as announcing a
		// stranger's pass, so the two get different sentences.
		let causedByUs = false;

		function disarm() {
			kind = null;
			baseline = null;
			sawRunning = false;
			causedByUs = false;
		}

		// The first status we ever see, before anything is armed. Recorded, never
		// spoken: this is the sticky residue the rule above exists to ignore.
		function observe(status) {
			if (!kind) baseline = status;
		}

		function arm(k, status, now) {
			kind = k;
			baseline = status === undefined ? baseline : status;
			armedAt = now;
			sawRunning = false;
			causedByUs = false;
		}

		// A lens button went down. Any manual verb preempts a running pass, and a
		// manual FOCUS verb additionally cancels the pass a zoom booked — so an
		// afterZoom generation has nothing left to wait for and must not sit out
		// its budget only to report that no result arrived.
		function manual(verb, now) {
			held = true;
			const focus = verb === 'near' || verb === 'far';
			if (kind === 'afterZoom' && focus) { disarm(); return; }
			if (!kind) return;
			// The pass is being taken over and the status will say `preempted` in
			// a moment. Keep the generation so we can word it, and remember that
			// the interruption was ours.
			causedByUs = true;
			void now;
		}

		function release() { held = false; }

		function step(status, now) {
			const s = (status || '').trim();

			// A held button drives the status to `preempted` continuously — that
			// is the button, not an outcome. Defer everything until it is up.
			if (held) return { say: null, poll: true };

			if (!kind) { observe(s); return { say: null, poll: false }; }

			if (s === 'running') {
				sawRunning = true;
				// The budget bounds a pass that never ENDS, not only one that
				// never starts. `running` used to return here before the check
				// below, so an engine stuck in it left "searching the full
				// range" on the picture for as long as the page stayed open —
				// a progress message with no terminating case, which reads as
				// an autofocus that never converges even when the fault is the
				// lens not answering.
				if (now - armedAt >= budget) {
					disarm();
					return {
						say: 'Autofocus is still searching after ' +
							Math.round(budget / 1000) +
							' seconds. Something is wrong with the lens or its ' +
							'wiring — press Near or Far to take it back.',
						poll: false, sticky: true,
					};
				}
				const word = kind === 'afterZoom'
					? 'Autofocus after zoom…'
					: 'Autofocus…';
				// Only once it is genuinely taking a long time. `running` is
				// asserted up to 8 s before the motor moves, so an early elapsed
				// figure would be describing a wait, not a search.
				const long = now - armedAt >= longMs;
				return {
					say: long ? word + ' (searching the full range)' : word,
					poll: true,
				};
			}

			if (isTerminal(s)) {
				// afterZoom has no trigger reply to link it to a pass, so a
				// terminal string only belongs to it once `running` was seen.
				// An operator generation may accept a terminal string that
				// merely differs from the baseline — an instant `failed:` never
				// reaches `running` and would otherwise be swallowed.
				const ours = sawRunning ||
					(kind !== 'afterZoom' && s !== baseline);
				if (!ours) {
					if (now - armedAt >= budget) {
						disarm();
						return { say: null, poll: false };
					}
					return { say: null, poll: true };
				}
				const ours2 = causedByUs;
				disarm();
				if (isDone(s)) {
					// A pass that ends well below the best it has evidence
					// for did not finish, whatever the word says. Measured on
					// an 85H50AI, the full-range search fails in two shapes:
					// it sweeps past a good peak and parks a quarter below it
					// (four passes out of four), or it gives up early on a
					// peak lower than where it began — 50 seconds to leave the
					// picture a fifth blurrier than before the press. A seeded
					// search lands on its peak exactly, in a fifth of the
					// time. Calling the first kind "finished" is how autofocus
					// comes to look broken while the page endorses it.
					//
					// Pressing again IS the remedy, and that is not a guess:
					// the second press has the position the first one left, so
					// it takes the seeded path. Measured, back to back: 53 s
					// ending at 73% of peak, then 8 s ending at 100%.
					const q = shortOfBest(s);
					if (q !== null && q < 0.9) {
						// Which remedy is true depends on whether the lens has
						// told the camera where its zoom is. Measured on an
						// 85H50AI: with the position UNKNOWN, five passes in a
						// row took the full-range path and every one stopped
						// short — pressing again is not a fix, and saying so
						// would send the operator round the same 50 seconds.
						// A single zoom is what makes the MCU report the
						// position (it only reports while the motor turns);
						// after that the search settles onto the seeded path
						// and lands on its peak exactly, in about 8 seconds.
						return {
							say: magUnknown(s)
								? 'Autofocus stopped short, and it is searching ' +
									'blind: the lens has not reported its zoom ' +
									'position since the camera restarted. Nudge ' +
									'the zoom once — it settles after that.'
								: 'Autofocus stopped short — the picture is less ' +
									'sharp than this pass had already seen. ' +
									'Press Autofocus again.',
							poll: false, settled: true, transient: true,
						};
					}
					let say = 'Autofocus finished.';
					if (magUnknown(s) && !saidMagOnce) {
						saidMagOnce = true;
						say += ' This lens does not report its zoom position, ' +
							'so every autofocus searches the whole range.';
					}
					return { say: say, poll: false, settled: true, transient: true };
				}
				if (isFailure(s))
					return { say: failureWords(s), poll: false, sticky: true };
				// preempted
				if (ours2)
					return { say: 'Autofocus cancelled.', poll: false, transient: true };
				return { say: 'Autofocus was interrupted.', poll: false, transient: true };
			}

			// `idle`, or anything unrecognised, while armed: nothing has happened
			// yet. Wait it out, then admit we never heard rather than claim it
			// finished.
			if (now - armedAt >= budget) {
				disarm();
				return {
					say: 'Autofocus did not report a result.',
					poll: false, transient: true,
				};
			}
			return { say: null, poll: true };
		}

		// The trigger's own reply. This is the only proof a pass exists that the
		// operator path ever gets.
		function trigger(reply, status, now) {
			const r = (reply || '').trim();
			if (r === 'started' || r === 'restarted') {
				// `restarted` means a press preempted a running pass and re-armed
				// it. That is bookkeeping: the operator pressed Autofocus and
				// autofocus is running. Saying anything else invites the reading
				// that the press failed — which is what the CGI used to report.
				arm('operator', status, now);
				return { say: 'Autofocus…', poll: true };
			}
			if (r === 'busy') {
				// NOT "one is already running". A trigger that lands on a
				// running pass answers `restarted` and preempts it; `busy` is
				// af_trigger's -1 — the engine unavailable or shutting down.
				// So nothing started, there is nothing to watch, and there is
				// nothing worth putting over the picture either: the press did
				// not take and pressing again is the whole remedy.
				disarm();
				return { say: null, poll: false };
			}
			if (r === 'unavailable') {
				disarm();
				return { say: 'This camera’s autofocus cannot run.', poll: false, withdraw: true };
			}
			// No reply at all. The request did not get through, which is not a
			// statement about the lens — the control stays exactly as it was.
			disarm();
			return { say: 'The camera did not answer.', poll: false, transient: true };
		}

		function zoomReleased(status, now) {
			arm('afterZoom', status, now);
			return { poll: true };
		}

		return {
			trigger: trigger,
			zoomReleased: zoomReleased,
			manual: manual,
			release: release,
			step: step,
			observe: observe,
			armed: function () { return kind; },
		};
	}

	return { create: create, BUDGET_MS: BUDGET_MS, LONG_MS: LONG_MS };
});
