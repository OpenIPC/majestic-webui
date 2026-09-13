// The PTZ pads, on the video. Loaded only via p/motor.cgi, which live.cgi
// includes only when the camera has motors. `$` and `apiFetch` are globals
// from main.js.
//
// Two protocols behind one pad. Stepped backends (gpio-motors, the motor
// profiles) take ?h=&v= magnitudes and buttons carry data-dir; the Pelco-D
// backend takes ?act= verbs — four directions, zoom, focus — driven by
// majestic, which owns that wire, and buttons carry data-act.
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
	// Which input owns the current hold, and which button it is driving. A
	// release only ends the hold it started: two fingers on the pad, or an
	// arrow pressed while another is still down, used to let the older one's
	// release stop the newer one's move — harmless while every press was a
	// self-terminating pulse, not harmless now that a release stops a motor.
	let holdBtn = null, holdOwner = null;

	// One request in flight at a time — a hold does not queue moves behind a
	// slow camera, it just measures out what the camera keeps up with. For
	// Pelco each tick re-arms the camera's auto-stop deadline, so the motor
	// runs continuously while the button is down rather than in steps. The
	// one press that must NOT be droppable is stop: a move is under way when
	// it is sent, and a stop that vanished would leave the motor running
	// until its deadline — so it queues, and goes out the moment the current
	// request answers. apiFetch rather than fetch: a lapsed session redirects
	// to the login page instead of 401ing invisibly at 4 Hz.
	function req(query, isStop) {
		if (inflight) {
			if (isStop) queuedStop = query;
			return;
		}
		inflight = true;
		apiFetch('/cgi-bin/j/ptz.cgi?' + query, { credentials: 'same-origin' })
			// The body, not just the headers: j/ptz.cgi answers 200 before it
			// does anything, so the headers arrive in milliseconds. Reading
			// to the end of the body is what keeps one request in flight at
			// a time — the stepped backends still block for the length of
			// their step, and the AF verb holds its request for the whole
			// pass.
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
	function startHold(btn, owner) {
		// Supersede whatever was held without sending a stop: the new verb is
		// going out in the same breath and would override it anyway.
		clearHold();
		holdBtn = btn;
		holdOwner = owner;
		fire(btn);
		holdTimer = setInterval(() => fire(btn), TICK_MS);
	}
	function clearHold() {
		if (holdTimer) { clearInterval(holdTimer); holdTimer = null; }
		holdBtn = null;
		holdOwner = null;
	}
	// Releasing a Pelco button has to say so. The camera runs the motor until
	// a deadline it re-arms on every request, which is what lets a hold be one
	// continuous move instead of a train of 500 ms steps — but it also means
	// the motor keeps going for that long after the last tick unless the
	// release is sent. (It stops by itself either way: that deadline is what
	// makes a closed tab or a dropped link safe.) The stepped backends move by
	// a fixed step per request and have nothing to stop.
	// `owner` names the input letting go; null means "whatever is held, stop"
	// (the Stop button, losing the window, the tab going away).
	function stopHold(owner) {
		if (owner != null && owner !== holdOwner) return;
		const btn = holdBtn;
		clearHold();
		if (btn && btn.dataset.act) req('act=stop', true);
	}

	// The centre is a single press on both pads: the stepped backends call it
	// home/park (board-defined), Pelco calls it stop. AF is single-press for
	// the opposite reason: a pass takes seconds, and a held button would
	// queue a fresh pass the moment each one finished — "one shot" must
	// mean one, however long the finger stays down.
	const isSingle = btn => btn.dataset.dir === 'cc' ||
		btn.dataset.act === 'stop' || btn.dataset.act === 'af';

	mount.querySelectorAll('button').forEach(btn => {
		if (isSingle(btn)) {
			// Stop first kills any hold still ticking (a keyboard hold can be
			// live while the mouse presses Stop), then fires — and for Pelco
			// the request itself is the un-droppable kind.
			btn.addEventListener('click', () => { stopHold(null); fire(btn); });
			return;
		}
		btn.addEventListener('pointerdown', e => {
			e.preventDefault();
			// Capture keeps pointerup coming to this button however far the
			// finger or cursor wanders mid-hold.
			try { btn.setPointerCapture(e.pointerId); } catch (err) {}
			startHold(btn, 'p' + e.pointerId);
		});
		btn.addEventListener('pointerup', e => stopHold('p' + e.pointerId));
		btn.addEventListener('pointercancel', e => stopHold('p' + e.pointerId));
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
			// the bar means the arrows are that control's. Shift is not ours
			// either: on a camera with a pad the plain arrows steer and shift
			// asks preview-zoom.js for the picture instead, so the keyboard
			// keeps both without either taking the other's keys.
			if (e.target !== stage || e.shiftKey || !KEYS[e.key]) return;
			e.preventDefault();
			if (e.repeat) return;
			const btn = pad.querySelector(KEYS[e.key]);
			if (btn) startHold(btn, 'k' + e.key);
		});
		stage.addEventListener('keyup', e => {
			if (KEYS[e.key]) stopHold('k' + e.key);
		});
	}
	// A hold must not outlive the page's attention: keyup and pointerup never
	// arrive in a window that lost focus mid-hold.
	window.addEventListener('blur', () => stopHold(null));
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) stopHold(null);
	});
})();
