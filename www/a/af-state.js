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
//   adopted     the trigger answered `busy`; someone else's pass is running and
//               we have said so, so we may as well report its end
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

	function create(opts) {
		const o = opts || {};
		const budget = o.budgetMs || BUDGET_MS;
		const longMs = o.longMs || LONG_MS;

		// The status as of the moment the current generation was armed. A
		// terminal string equal to this one proves nothing — it is what was
		// already standing.
		let baseline = null;
		let kind = null;          // 'operator' | 'adopted' | 'afterZoom' | null
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
				// operator/adopted may accept a terminal string that merely
				// differs from the baseline — an instant `failed:` never reaches
				// `running` and would otherwise be swallowed.
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
					let say = 'Autofocus finished.';
					if (magUnknown(s) && !saidMagOnce) {
						saidMagOnce = true;
						say += ' This lens does not report its zoom position, ' +
							'so every autofocus searches the whole range.';
					}
					return { say: say, poll: false, settled: true };
				}
				if (isFailure(s))
					return { say: failureWords(s), poll: false, sticky: true };
				// preempted
				if (ours2)
					return { say: 'Autofocus cancelled.', poll: false };
				return { say: 'Autofocus was interrupted.', poll: false };
			}

			// `idle`, or anything unrecognised, while armed: nothing has happened
			// yet. Wait it out, then admit we never heard rather than claim it
			// finished.
			if (now - armedAt >= budget) {
				disarm();
				return { say: 'Autofocus did not report a result.', poll: false };
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
				arm('adopted', status, now);
				return { say: 'Autofocus is already running.', poll: true };
			}
			if (r === 'unavailable') {
				disarm();
				return { say: 'This camera’s autofocus cannot run.', poll: false, withdraw: true };
			}
			// No reply at all. The request did not get through, which is not a
			// statement about the lens — the control stays exactly as it was.
			disarm();
			return { say: 'The camera did not answer.', poll: false };
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
