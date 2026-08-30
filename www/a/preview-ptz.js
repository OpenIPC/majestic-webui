// The PTZ D-pad, on the video. Loaded only via p/motor.cgi, which preview.cgi
// includes only when the camera has motors. `$` and `apiFetch` are globals
// from main.js.
//
// The pad is emitted after the player (the stage is already closed when the
// include runs) and moved into the stage's #mj-ptz mount here. Press-and-hold
// uses Pointer Events with capture: the old mouse handlers stopped the pan
// the moment the pointer drifted off a 2.3rem glyph, which on a moving
// picture is constantly. Arrow keys drive it too, but only while the stage
// itself has focus — inside the bar the arrows belong to the volume slider
// and the radio groups.
(function () {
	const pad = $('#mj-ptz-pad'), mount = $('#mj-ptz'), stage = $('#mj-stage');
	if (!pad || !mount) return;
	mount.appendChild(pad);
	pad.hidden = false;
	mount.hidden = false;

	const STEP = 5, TICK_MS = 250;
	const DIRS = {
		ul: [-1, 1], uc: [0, 1], ur: [1, 1],
		lc: [-1, 0], cc: [0, 0], rc: [1, 0],
		dl: [-1, -1], dc: [0, -1], dr: [1, -1],
	};
	let inflight = false, holdTimer = null;

	// One request in flight at a time — a hold does not queue moves behind a
	// slow camera, it just measures out what the camera keeps up with.
	// apiFetch rather than fetch: a lapsed session redirects to the login page
	// instead of 401ing invisibly at 4 Hz for ever.
	function fire(dir) {
		if (inflight) return;
		const d = DIRS[dir];
		if (!d) return;
		inflight = true;
		apiFetch('/cgi-bin/j/ptz.cgi?h=' + d[0] * STEP + '&v=' + d[1] * STEP,
			{ credentials: 'same-origin' })
			.catch(() => {})
			.finally(() => { inflight = false; });
	}
	function startHold(dir) {
		stopHold();
		fire(dir);
		holdTimer = setInterval(() => fire(dir), TICK_MS);
	}
	function stopHold() {
		if (holdTimer) { clearInterval(holdTimer); holdTimer = null; }
	}

	pad.querySelectorAll('button').forEach(btn => {
		const dir = btn.dataset.dir;
		// Board-defined home/park slot; a single step, not a hold.
		if (dir === 'cc') {
			btn.addEventListener('click', () => fire(dir));
			return;
		}
		btn.addEventListener('pointerdown', e => {
			e.preventDefault();
			// Capture keeps pointerup coming to this button however far the
			// finger or cursor wanders mid-hold.
			try { btn.setPointerCapture(e.pointerId); } catch (err) {}
			startHold(dir);
		});
		btn.addEventListener('pointerup', stopHold);
		btn.addEventListener('pointercancel', stopHold);
		// Enter/Space on a focused button: a single step, so the keyboard can
		// nudge precisely; sweeping is what the stage-level arrows are for.
		btn.addEventListener('click', e => { if (e.detail === 0) fire(dir); });
	});

	if (stage) {
		const KEYS = { ArrowUp: 'uc', ArrowDown: 'dc', ArrowLeft: 'lc', ArrowRight: 'rc' };
		stage.addEventListener('keydown', e => {
			// Only when the stage ITSELF is focused — focus on any control in
			// the bar means the arrows are that control's.
			if (e.target !== stage || !KEYS[e.key]) return;
			e.preventDefault();
			if (!e.repeat) startHold(KEYS[e.key]);
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
