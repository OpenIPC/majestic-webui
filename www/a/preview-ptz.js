// The PTZ pads, on the video. Loaded only via p/motor.cgi, which preview.cgi
// includes only when the camera has motors. `$` and `apiFetch` are globals
// from main.js.
//
// Two protocols behind one pad. Stepped backends (gpio-motors, the motor
// profiles) take ?h=&v= magnitudes and buttons carry data-dir; the Pelco-D
// backend (btzoom) takes ?act= verbs — four directions, zoom, focus — each a
// fixed timed pulse the camera ends by itself, and buttons carry data-act.
// The markup decides which kind this camera has; this file just reads what
// the buttons say.
//
// The pads are emitted after the player (the stage is already closed when
// the include runs) and moved into the stage's #mj-ptz mount here.
// Press-and-hold uses Pointer Events with capture: drifting off a small
// button mid-hold must not stop the pan. Arrow keys drive it too, but only
// while the stage itself has focus — inside the bar the arrows belong to the
// volume slider and the radio groups.
(function () {
	const pad = $('#mj-ptz-pad'), fn = $('#mj-ptz-fn');
	const mount = $('#mj-ptz'), stage = $('#mj-stage');
	// Either piece may be absent on its own: ptz_caps can leave a camera
	// with only the zoom/focus group (an XM zoom block has no pan/tilt) —
	// the pad must not be the thing the whole mount hinges on.
	if (!mount || (!pad && !fn)) return;
	if (fn) { mount.appendChild(fn); fn.hidden = false; }
	if (pad) { mount.appendChild(pad); pad.hidden = false; }
	mount.hidden = false;

	const STEP = 5, TICK_MS = 250;
	const DIRS = {
		ul: [-1, 1], uc: [0, 1], ur: [1, 1],
		lc: [-1, 0], cc: [0, 0], rc: [1, 0],
		dl: [-1, -1], dc: [0, -1], dr: [1, -1],
	};
	let inflight = false, holdTimer = null, queuedStop = null;

	// One request in flight at a time — a hold does not queue moves behind a
	// slow camera, it just measures out what the camera keeps up with. For
	// Pelco this is also the pulse pacing: btzoom answers only after its
	// pulse has ended, so a hold strings pulses end to end rather than
	// stacking them. The one press that must NOT be droppable is stop: a
	// Pelco pulse is in flight half the time, and a stop that vanished into
	// that window would let the hold's next pulse move a camera the user
	// just told to stand still — so it queues, and goes out the moment the
	// current request answers. apiFetch rather than fetch: a lapsed session
	// redirects to the login page instead of 401ing invisibly at 4 Hz.
	function req(query, isStop) {
		if (inflight) {
			if (isStop) queuedStop = query;
			return;
		}
		inflight = true;
		apiFetch('/cgi-bin/j/ptz.cgi?' + query, { credentials: 'same-origin' })
			// The body, not just the headers: j/ptz.cgi answers 200 before it
			// execs anything, so the headers arrive in milliseconds while the
			// motor is still moving. The body closes when the CGI exits —
			// that is the end of a Pelco pulse, and it is what makes a held
			// button string pulses end to end instead of stacking requests
			// four times a second behind the camera's port lock.
			.then(r => r.text())
			.catch(() => {})
			.finally(() => {
				inflight = false;
				const q = queuedStop;
				queuedStop = null;
				if (q) req(q, true);
			});
	}
	// What one press of this button means, from its own dataset.
	function fire(btn) {
		if (btn.dataset.act) {
			req('act=' + btn.dataset.act, btn.dataset.act === 'stop');
			return;
		}
		const d = DIRS[btn.dataset.dir];
		if (d) req('h=' + d[0] * STEP + '&v=' + d[1] * STEP);
	}
	function startHold(btn) {
		stopHold();
		fire(btn);
		holdTimer = setInterval(() => fire(btn), TICK_MS);
	}
	function stopHold() {
		if (holdTimer) { clearInterval(holdTimer); holdTimer = null; }
	}

	// The centre is a single press on both pads: the stepped backends call it
	// home/park (board-defined), Pelco calls it stop.
	const isCentre = btn => btn.dataset.dir === 'cc' || btn.dataset.act === 'stop';

	mount.querySelectorAll('button').forEach(btn => {
		if (isCentre(btn)) {
			// Stop first kills any hold still ticking (a keyboard hold can be
			// live while the mouse presses Stop), then fires — and for Pelco
			// the request itself is the un-droppable kind.
			btn.addEventListener('click', () => { stopHold(); fire(btn); });
			return;
		}
		btn.addEventListener('pointerdown', e => {
			e.preventDefault();
			// Capture keeps pointerup coming to this button however far the
			// finger or cursor wanders mid-hold.
			try { btn.setPointerCapture(e.pointerId); } catch (err) {}
			startHold(btn);
		});
		btn.addEventListener('pointerup', stopHold);
		btn.addEventListener('pointercancel', stopHold);
		// Enter/Space on a focused button: a single step or pulse, so the
		// keyboard can nudge precisely; sweeping is what the stage-level
		// arrows are for.
		btn.addEventListener('click', e => { if (e.detail === 0) fire(btn); });
	});

	if (stage && pad) {
		// Arrows resolve to whatever button the pad actually has for that
		// direction, so the same keys drive both protocols. No pad — a
		// zoom/focus-only camera — means the arrows have nothing to say.
		const KEYS = {
			ArrowUp: '[data-dir="uc"],[data-act="up"]',
			ArrowDown: '[data-dir="dc"],[data-act="down"]',
			ArrowLeft: '[data-dir="lc"],[data-act="left"]',
			ArrowRight: '[data-dir="rc"],[data-act="right"]',
		};
		stage.addEventListener('keydown', e => {
			// Only when the stage ITSELF is focused — focus on any control in
			// the bar means the arrows are that control's.
			if (e.target !== stage || !KEYS[e.key]) return;
			e.preventDefault();
			if (e.repeat) return;
			const btn = pad.querySelector(KEYS[e.key]);
			if (btn) startHold(btn);
		});
		stage.addEventListener('keyup', e => { if (KEYS[e.key]) stopHold(); });
	}
	// A hold must not outlive the page's attention: keyup and pointerup never
	// arrive in a window that lost focus mid-hold.
	window.addEventListener('blur', stopHold);
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) stopHold();
	});
})();
