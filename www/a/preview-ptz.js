// The PTZ pads, on the video. Loaded only via p/motor.cgi, which live.cgi
// includes only when the camera has motors. `$` and `apiFetch` are globals
// from main.js.
//
// Two protocols behind one pad, and two doors. Stepped backends (gpio-motors,
// the motor profiles) are binaries on the camera, so they go through
// j/ptz.cgi as ?h=&v= magnitudes and their buttons carry data-dir. The serial
// backends are majestic's — it owns that UART — so those go straight to
// POST /ptz?move=, and their buttons carry data-act. The markup decides which
// kind this camera has; this file just reads what the buttons say, which is
// why the door needs no flag of its own.
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
	// The reason the pads will not move anything, when there is one, joins the
	// toast stack — it is a sentence, and everything below is a grid of 40px
	// buttons. Independent of the mount: the stack bounds its own width and
	// sits under the chip, so this shows whether or not a pad does.
	const why = $('#mj-ptz-why'), toasts = $('#mj-toasts');
	if (why && toasts) { toasts.appendChild(why); why.hidden = false; }
	// The autofocus line joins the same stack, and for the same reason the
	// sentence above does — but it stays `hidden`, because it has nothing to
	// say until a pass this page started or booked is under way. Left where
	// haserl emitted it, it renders BELOW the video instead of over it: the
	// pads are emitted after the player and relocated, and this is emitted with
	// them.
	const afLine = $('#mj-af-say');
	if (afLine && toasts) toasts.appendChild(afLine);
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
	let holdBtn = null, holdOwner = null, holdKick = null, holdStart = 0;

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
		// POST, always: every request this makes moves a motor or steps a
		// pad, and the endpoint refuses anything else. A GET would be
		// issuable by any page the operator happens to have open.
		apiFetch('/cgi-bin/j/ptz.cgi?' + query,
			{ method: 'POST', credentials: 'same-origin' })
			// The body, not just the headers: j/ptz.cgi answers 200 before it
			// does anything, so the headers arrive in milliseconds. Reading
			// to the end of the body is what keeps one request in flight at
			// a time — the stepped backends still block for the length of
			// their step.
			.then(r => r.text())
			.catch(() => {})
			.finally(() => {
				inflight = false;
				const q = queuedStop;
				queuedStop = null;
				if (q) req(q, true);
			});
	}

	// The serial backends are majestic's: it owns that UART and serves the
	// verbs at POST /ptz?move=…, so the browser asks it rather than forking a
	// shell to relay the same words over loopback. Which door a button uses is
	// not a new flag — the markup already decides it, and always did:
	// `data-act` is the serial pad, `data-dir` the stepped one.
	//
	// The duration rides as its own query parameter. The camera parses `move`
	// and `ms` as parameters rather than sniffing the URL for a word, so a verb
	// cannot be smuggled inside another value, and it is the camera that
	// decides how to pass the pair on to the motor.
	//
	// Held ticks are NOT gated on a request being in flight, and that inversion
	// is the point. j/ptz.cgi's exit marked the end of a pulse, so dropping a
	// tick while one was outstanding was how a hold measured itself out. /ptz
	// answers in about 30 ms (measured on an hi3516ev300, for a move asked to
	// run two seconds) because the motor's deadline lives in the daemon, so a
	// tick now exists only to re-arm that deadline — and the moment one request
	// is outstanding is the moment the next one matters most. Dropped, the
	// deadline expires and the sweep stalls mid-press: measured over the lab
	// link, a 250 ms ticker against a ~500 ms round trip left ONE coarse
	// request in a 1.2 s hold, and the release landed 376 ms late.
	//
	// Bounded rather than free: past a few outstanding requests the link, not
	// the ticker, is the problem, and piling on cannot help. `stop` is never
	// bounded and never dropped — a stop that vanished leaves a motor running
	// to its deadline, which is the one failure with a physical cost.
	let outstanding = 0;
	function move(verb, ms, isStop) {
		let url = '/ptz?move=' + encodeURIComponent(verb);
		if (ms) url += '&ms=' + ms;
		if (!isStop && outstanding >= 3) return;
		outstanding++;
		apiFetch(url, { method: 'POST', credentials: 'same-origin' })
			// The body decides, not the status. majestic answers /ptz with a
			// BODYLESS 200 when the sensor driver did not come up, and the
			// plugin answers `unavailable` — also 200 — when the focus port is
			// closed, which is the state a camera lands in after the motorized
			// lens setting is toggled without a restart. A status-code check
			// calls both of those a move.
			.then(r => (r.ok ? r.text() : Promise.reject(r.status)))
			.then(t => {
				const body = t.trim();
				if (body === 'unavailable') say(LENS_SHUT);
				else if (body && afLine && afLine.textContent === LENS_SHUT) say('');
			})
			.catch(() => {})
			.finally(() => { outstanding--; });
	}
	const LENS_SHUT = 'The camera is not driving the lens. Restart majestic to ' +
		'load the motor driver.';
	// ---- Autofocus -------------------------------------------------------
	//
	// The engine is majestic's, so the browser asks majestic: `GET /autofocus`
	// to trigger and `GET /autofocus/status` to watch. Both are served on this
	// same origin, which is the standing rule — a CGI carries only what the
	// daemon cannot answer, and this is the daemon's own business.
	//
	// The status path is fetched EXACTLY, with no query string of any kind.
	// The camera answers the status only for that precise path and treats
	// anything else beginning `/autofocus` as a request to RUN one — so
	// `/autofocus/status?t=1` is not a poll, and a cache buster appended here
	// would start a focus pass every time it fired.
	const AF_URL = '/autofocus';
	const AF_STATUS_URL = '/autofocus/status';
	const afSay = $('#mj-af-say');
	const afState = window.MajesticAfState ? window.MajesticAfState.create() : null;
	let afTimer = null, zoomTouched = false;

	// A result is news, not a standing condition: "Autofocus finished" that
	// never leaves is clutter over the picture within a minute of using the
	// pad. Outcomes clear themselves; only a `failed:` — which describes
	// something still true about the camera — stays until the next pass
	// replaces it.
	let sayTimer = null;
	function say(text, transient) {
		if (!afSay) return;
		if (sayTimer) { clearTimeout(sayTimer); sayTimer = null; }
		afSay.textContent = text || '';
		afSay.hidden = !text;
		if (text && transient) {
			sayTimer = setTimeout(() => {
				sayTimer = null;
				afSay.textContent = '';
				afSay.hidden = true;
			}, 4000);
		}
	}
	// majestic answers /autofocus and /ptz with a bodyless 200 when the sensor
	// driver did not come up, so the status code alone is not an answer. Every
	// caller here judges the body.
	function afText(url) {
		return apiFetch(url, { credentials: 'same-origin' })
			.then(r => (r.ok ? r.text() : Promise.reject(r.status)))
			.then(t => t.trim());
	}
	function afStop() {
		if (afTimer) { clearTimeout(afTimer); afTimer = null; }
	}
	function afTick(delay) {
		afStop();
		if (!afState) return;
		afTimer = setTimeout(() => {
			afTimer = null;
			afText(AF_STATUS_URL).then(s => {
				const r = afState.step(s, Date.now());
				if (r.say !== null && r.say !== undefined) say(r.say, r.transient);
				if (r.poll) afTick(1000);
			}, () => {
				// A failed poll is not a verdict about the pass. Keep watching
				// on a longer beat; the budget inside the reducer ends it.
				if (afState.armed()) afTick(2000);
			});
		}, delay);
	}
	function triggerAf() {
		if (!afState) return;
		afText(AF_URL).then(reply => {
			// No status read here on purpose. The baseline has to be what stood
			// BEFORE this pass — read after the trigger it would be this pass's
			// own `running`, i.e. the generation comparing itself against
			// itself. `observe()` keeps the last idle sighting, and passing
			// undefined keeps it.
			const r = afState.trigger(reply, undefined, Date.now());
			say(r.say, r.transient);
			if (r.withdraw) {
				const b = mount.querySelector('[data-act="af"]');
				if (b) b.hidden = true;
			}
			if (r.poll) afTick(200);
		}, () => say('The camera did not answer.'));
	}
	// "Best sharpness since you started focusing" is only meaningful within one
	// scene at one zoom, so the stats panel's high-water mark is cleared
	// whenever either moves. Guarded: the panel is a separate module and may
	// not be loaded at all.
	function focusReset() {
		const st = window.MajesticStats;
		if (st && typeof st.focusReset === 'function') st.focusReset();
	}
	function afManual(verb) {
		if (!afState) return;
		afState.manual(verb, Date.now());
		if (!afState.armed()) { afStop(); say(''); }
	}
	// One status read at mount, doing two jobs.
	//
	// The reply is the sticky residue the reducer has to recognise in order to
	// ignore it — without it the first press would take whatever was standing
	// (a `preempted` from days ago) as its own generation's starting point.
	//
	// And whether there IS a reply is the capability answer. majestic 404s
	// /autofocus and /ptz outright when isp.autofocus.enabled is off, so a
	// definite 404 withdraws the control and the focus caption stays plain. An
	// answer promotes the caption to "Manual focus", because now there is
	// something automatic to contrast it with. Anything else — a timeout, a
	// proxy, a camera mid-restart — changes nothing: could not ask is not an
	// answer about the hardware, and this is exactly the camera where the
	// operator has just turned the setting on and is waiting to see it.
	if (afState && afSay) {
		apiFetch(AF_STATUS_URL, { credentials: 'same-origin' }).then((r) => {
			if (r.status === 404) {
				const cap = $('#mj-af-cap');
				const btn = mount.querySelector('[data-act="af"]');
				if (cap) cap.hidden = true;
				if (btn) btn.hidden = true;
				return;
			}
			if (!r.ok) return;
			const fc = $('#mj-focus-cap');
			if (fc) fc.textContent = 'Manual focus';
			return r.text().then((s) => afState.observe(s.trim()));
		}, () => {});
	}

	// A tap is a nudge, a hold is a sweep — the same split Axis's optics API
	// makes with ±smallStep and ±bigStep, and the reason manual focus on a
	// 500 ms step is unusable for anything delicate. The COARSE step is the
	// operator's own isp.autofocus.pulse: send no duration and the camera uses
	// it, so anyone who tuned that keeps exactly what they tuned. The FINE step
	// is a fifth of it, floored at the key's own minimum. No new setting, and
	// nothing in localStorage — the camera already stores this, and a step that
	// lived in one browser would not be the step the next operator got.
	let fineMs = 100;
	if (typeof mjConfig === 'function') {
		mjConfig().then((c) => {
			const af = c && c.isp && c.isp.autofocus;
			const n = parseInt(af && af.pulse, 10);
			if (n >= 50) fineMs = Math.max(50, Math.round(n / 5));
		}, () => {});
	}

	// What one press of this button means, from its own dataset.
	function fire(btn, ms) {
		if (btn.dataset.act) {
			const act = btn.dataset.act;
			// Autofocus is not a move and must not take the lease. j/ptz.cgi
			// used to hold its HTTP request open for the whole pass — 60 polls
			// of `sleep 1` plus a `curl -m 2` each, so up to about three
			// minutes of a held connection — and because `req` allows one
			// request in flight, every Near/Far/Wide/Tele press during that
			// window was silently dropped. The camera would have preempted
			// happily; the browser never asked it to. Triggering directly and
			// watching the status is what ends that, rather than a longer
			// timeout somewhere.
			if (act === 'af') { triggerAf(); focusReset(); return; }
			move(act, ms, act === 'stop');
			if (act === 'wide' || act === 'tele') {
				zoomTouched = true;
				focusReset();
				// A zoom preempts a running pass exactly as a focus nudge does,
				// so the reducer has to know this page caused it. Without this
				// the interruption read as a stranger's and the operator was
				// told autofocus "was interrupted" by their own zoom.
				afManual(act);
			}
			else if (act === 'near' || act === 'far') afManual(act);
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
		holdStart = Date.now();
		// The press cannot yet know whether it is a tap or a hold, so it sends
		// the fine step and the ticker takes over. The first coarse tick is
		// timed to land as that fine pulse expires rather than at the usual
		// quarter second, or a hold would be a nudge, a stall, then motion.
		const fine = (btn.dataset.act && btn.dataset.act !== 'stop') ? fineMs : 0;
		fire(btn, fine);
		holdKick = setTimeout(() => {
			holdKick = null;
			fire(btn);
			holdTimer = setInterval(() => fire(btn), TICK_MS);
		}, fine || TICK_MS);
	}
	function clearHold() {
		if (holdTimer) { clearInterval(holdTimer); holdTimer = null; }
		if (holdKick) { clearTimeout(holdKick); holdKick = null; }
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
		const heldMs = Date.now() - holdStart;
		clearHold();
		// A tap must not be cut short by its own release. The fine pulse is
		// self-terminating — the camera stops the motor on the deadline that
		// press armed — so a press shorter than the step sends no stop and the
		// nudge completes. Anything longer is a sweep, and a sweep has to be
		// told to stop or the motor runs on to its deadline.
		if (btn && btn.dataset.act && heldMs >= fineMs) move('stop', 0, true);
		// Letting go of a zoom is what books a focus pass: majestic waits for
		// the wire to go quiet (700 ms) after the move's own deadline and then
		// runs one. Nothing told the operator that, so a picture that went soft
		// and re-sharpened a second after they stopped touching anything read
		// as the camera misbehaving. Arm the watch here and it announces
		// itself.
		if (btn && zoomTouched &&
			(btn.dataset.act === 'wide' || btn.dataset.act === 'tele')) {
			zoomTouched = false;
			if (afState && afSay) {
				// Armed synchronously, on the release itself. It used to read
				// the status first and arm in the callback, which let a slow
				// answer land after the operator had pressed Autofocus and
				// relabel their own pass as an automatic one. Nothing needed
				// that round trip: passing no status keeps the baseline the
				// mount probe recorded, which is the same thing the trigger
				// does.
				afState.zoomReleased(undefined, Date.now());
				afTick(1200);
			}
		}
		if (afState) { afState.release(); }
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
		//
		// It goes through the same press-and-release pair as a pointer rather
		// than calling fire() alone, because everything that has to happen when
		// a lens button comes UP lives in stopHold(): the autofocus watch a zoom
		// books, and the release of the flag that tells the status reducer a
		// button is down. A keyboard nudge that only fired left that flag set
		// for the life of the page, and from then on the reducer deferred every
		// reading and no pass ever reported a result — an autofocus that looked
		// like it never converged, from one press of Space on Near.
		btn.addEventListener('click', e => {
			if (e.detail !== 0) return;
			const axis = axisFor(btn.dataset.act);
			startHold(btn, 'kb');
			stopHold('kb');
			void axis;
		});
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
