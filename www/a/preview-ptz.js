// The PTZ pads, on the video. Loaded only via p/motor.cgi, which live.cgi
// includes only when the camera has motors. `$` and `apiFetch` are globals
// from main.js.
//
// Two protocols behind one pad. Stepped backends (gpio-motors, the motor
// profiles) take ?h=&v= magnitudes and buttons carry data-dir; the Pelco-D
// motor service takes ?act= verbs — four directions, zoom, focus — and
// buttons carry data-act.
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
	function stored(name, fallback) {
		try {
			const value = localStorage.getItem(name);
			return value == null ? fallback : value;
		} catch (e) { return fallback; }
	}
	function storedMs(name, fallback, min, max) {
		const value = parseInt(stored(name, String(fallback)), 10);
		return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
	}
	// Either piece may be absent on its own: ptz_caps can leave a camera
	// with only the zoom/focus group (an XM zoom block has no pan/tilt) —
	// the pad must not be the thing the whole mount hinges on.
	if (!mount || (!pad && !fn)) return;
	if (stored('openipc.motor.controls', 'auto') === 'hidden') return;
	if (fn) { mount.appendChild(fn); fn.hidden = false; }
	if (pad) { mount.appendChild(pad); pad.hidden = false; }
	mount.hidden = false;

	let afOverlay = null, afPollTimer = null, afHideTimer = null;
	let afSeenRunning = false, afWatchUntil = 0;
	function showAf(text, state) {
		if (stored('openipc.af.overlay', 'active') === 'off') return;
		if (!afOverlay) {
			afOverlay = document.createElement('div');
			afOverlay.className = 'mj-af-overlay';
			afOverlay.setAttribute('role', 'status');
			afOverlay.setAttribute('aria-live', 'polite');
			stage.appendChild(afOverlay);
		}
		afOverlay.textContent = text;
		afOverlay.dataset.state = state || 'running';
		afOverlay.hidden = false;
	}
	function hideAfLater() {
		clearTimeout(afHideTimer);
		afHideTimer = setTimeout(() => { if (afOverlay) afOverlay.hidden = true; }, 2000);
	}
	function updateZoomLabel(mag) {
		const el = $('#mj-ptz-zoom-label');
		if (!el) return;
		if (Number.isFinite(mag) && mag >= 1.0) {
			const clamped = Math.min(Math.max(mag, 1.0), 100.0);
			const formatted = clamped >= 10.0 ? clamped.toFixed(0) : clamped.toFixed(1);
			el.textContent = 'Zoom ' + formatted + '×';
			try { localStorage.setItem('openipc.zoom.lastMag', formatted); } catch (e) {}
		} else {
			el.textContent = 'Zoom';
		}
	}
	let lastFv = null;
	function updateFocusLabel(fv, isRunning, manualDir) {
		const el = $('#mj-ptz-focus-label');
		if (!el) return;
		if (fv != null && fv !== '' && fv !== '0') lastFv = fv;
		if (isRunning) {
			el.textContent = 'Focus AF…' + (lastFv ? ' (' + lastFv + ')' : '');
		} else if (manualDir) {
			el.textContent = 'Focus ' + manualDir + (lastFv ? ' (' + lastFv + ')' : '');
		} else if (lastFv) {
			el.textContent = 'Focus FV ' + lastFv;
		} else {
			el.textContent = 'Focus';
		}
	}
	let irisJog = 0;
	function updateIrisLabel(state) {
		const el = $('#mj-ptz-iris-label');
		if (!el) return;
		if (state) {
			el.textContent = 'Iris ' + state;
		} else if (irisJog !== 0) {
			el.textContent = 'Iris (' + (irisJog > 0 ? '+' : '') + irisJog + ')';
		} else {
			el.textContent = 'Iris';
		}
	}
	let panJog = 0, tiltJog = 0;
	function updateXyLabel(state) {
		const els = [$('#mj-ptz-xy-label'), $('#mj-ptz-xy-label-alt')];
		els.forEach(el => {
			if (!el) return;
			if (state) {
				el.textContent = state;
			} else {
				el.textContent = 'Pan/Tilt (X: ' + panJog + ' Y: ' + tiltJog + ')';
			}
		});
	}

	function parseLiveMag(str) {
		if (!str) return null;
		const live = /(?:^| )live_mag=([0-9.]+)/.exec(str);
		if (live) return +live[1];
		const matches = [...str.matchAll(/(?:^| )mag=([0-9.]+)/g)];
		return matches.length ? +matches[matches.length - 1][1] : null;
	}
	function fetchZoom() {
		apiFetch('/zoom', { credentials: 'same-origin' })
			.then(r => r.ok ? r.text() : '')
			.then(t => {
				const mag = parseLiveMag(t);
				updateZoomLabel(mag);
			})
			.catch(() => updateZoomLabel(null));
	}
	updateZoomLabel(null);
	updateIrisLabel();
	updateXyLabel();
	fetchZoom();

	function pollAf() {
		afPollTimer = null;
		apiFetch('/autofocus/status', { credentials: 'same-origin' })
			.then(r => r.ok ? r.text() : Promise.reject())
			.then(body => {
				const status = body.trim();
				const currentMag = parseLiveMag(status);
				if (currentMag != null) updateZoomLabel(currentMag);
				else fetchZoom();

				const fvMatch = status.match(/(?:^| )metric_fv=(\d+)/) || status.match(/(?:^| )fv=(\d+)/);
				const currentFv = fvMatch ? fvMatch[1] : null;

				const running = status.match(/^running(?: step=([^ ]+) fv=(\d+) peak=(\d+))?/);
				if (running) {
					afSeenRunning = true;
					updateFocusLabel(currentFv, true);
					const step = running[1] ? running[1].replace(/-/g, ' ') : 'starting';
					const metric = running[2] && running[2] !== '0' ? ' · FV ' + running[2] : '';
					const peak = running[3] && running[3] !== '0' ? ' · peak ' + running[3] : '';
					showAf('AF · ' + step + metric + peak, 'running');
					afPollTimer = setTimeout(pollAf, 250);
					return;
				}

				updateFocusLabel(currentFv, false);

				if (afSeenRunning) {
					afSeenRunning = false;
					const done = status.match(/^done fv=(\d+) peak=(\d+)/);
					if (done) {
						const magStr = currentMag != null ? ' · ' + currentMag.toFixed(1) + '×' : '';
						showAf('AF done' + magStr + ' · FV ' + done[1] + ' · peak ' + done[2], 'done');
					}
					else if (/^preempted(?: |$)/.test(status)) {
						// Zoom preempts the old AF pass before it starts a new one.
						// Do not present that expected handoff as an AF failure.
						if (Date.now() < afWatchUntil) {
							if (afOverlay) afOverlay.hidden = true;
							afPollTimer = setTimeout(pollAf, 250);
							return;
						}
						showAf('AF stopped', 'stopped');
					}
					else if (/^idle(?: |$)/.test(status) || /^cancelled(?: |$)/.test(status)) {
						if (afOverlay) afOverlay.hidden = true;
						return;
					}
					else showAf('AF · ' + (status || 'status unavailable'), 'failed');
					hideAfLater();
					return;
				}

				if (status.startsWith('idle') && afOverlay && !afOverlay.hidden) {
					afOverlay.hidden = true;
				} else if (afOverlay && !afOverlay.hidden && !afSeenRunning) {
					hideAfLater();
				}

				// A zoom pulse starts AF only after its motor request completes.
				// Ignore the previous pass result during that short gap.
				if (Date.now() < afWatchUntil) afPollTimer = setTimeout(pollAf, 250);
			})
			.catch(() => {
				fetchZoom();
				if (Date.now() < afWatchUntil || afSeenRunning)
					afPollTimer = setTimeout(pollAf, 500);
			});
	}
	pollAf();
	setInterval(() => { if (!afPollTimer && !afSeenRunning) pollAf(); }, 3000);

	let afTriggerMode = 'ptz';
	apiFetch('/cgi-bin/j/af_triggers.cgi', { credentials: 'same-origin' })
		.then(r => r.ok ? r.json() : null)
		.then(d => { if (d && d.trigger_mode) afTriggerMode = d.trigger_mode; })
		.catch(() => {});

	function shouldWatchAfAfter(axis) {
		if (afTriggerMode === 'manual') return false;
		if (afTriggerMode === 'zoom_only') return axis === 'zoom';
		if (afTriggerMode === 'pan_tilt_only') return axis === 'pan' || axis === 'tilt';
		return axis === 'zoom' || axis === 'pan' || axis === 'tilt';
	}

	function watchAf(durationMs) {
		afWatchUntil = Date.now() + (durationMs || 10000);
		afSeenRunning = false;
		clearTimeout(afHideTimer);
		if (!afPollTimer) afPollTimer = setTimeout(pollAf, 100);
	}
	document.addEventListener('mj-ptz-move', e => {
		const ms = e && e.detail && e.detail.durationMs ? Number(e.detail.durationMs) : 12000;
		watchAf(ms);
	});

	const STEP = 5, TICK_MS = 250;
	const PULSE_MS = {
		focus: storedMs('openipc.motor.focusClickMs', 70, 20, 1000),
		motor: storedMs('openipc.motor.moveClickMs', 150, 20, 1000),
		maximum: storedMs('openipc.motor.maxHoldMs', 5000, 500, 10000),
	};
	const DIRS = {
		ul: [-1, 1], uc: [0, 1], ur: [1, 1],
		lc: [-1, 0], cc: [0, 0], rc: [1, 0],
		dl: [-1, -1], dc: [0, -1], dr: [1, -1],
	};
	let inflight = false, activeKind = null, activeAbort = null;
	let activeTimeout = null;
	let holdTimer = null, queuedCommand = null, heldButton = null, holdOwner = null;
	let holdStarted = 0, releaseTimer = null, releaseAxis = null;

	// Keep one normal request in flight. A manual move can cancel the AF HTTP
	// request and wait behind it. Axis stop requests use separate connections,
	// so pointer release does not wait behind the active movement request.
	// apiFetch also sends an expired session to the login page.
	function req(query, kind) {
		// A release must stop its axis while the movement request is open.
		// Use a second connection because the service accepts an authorized
		// stop independently of the current lease owner.
		if (kind === 'stop') {
			apiFetch('/cgi-bin/j/ptz.cgi?' + query,
				{ method: 'POST', credentials: 'same-origin' })
				.then(r => r.text()).catch(() => {});
			return;
		}
		if (inflight) {
			if (activeKind === 'af') {
				queuedCommand = { query, kind };
				if (activeKind === 'af' && activeAbort) activeAbort.abort();
			}
			return;
		}
		inflight = true;
		activeKind = kind;
		activeAbort = new AbortController();
		// A movement is limited to five seconds. Do not let a lost CGI reply
		// disable this pad for the rest of the page session. AF has its own
		// longer server-side wait budget.
		activeTimeout = setTimeout(() => activeAbort && activeAbort.abort(),
			kind === 'af' ? 65000 : 8000);
		apiFetch('/cgi-bin/j/ptz.cgi?' + query, {
			method: 'POST',
			credentials: 'same-origin',
			signal: activeAbort.signal,
		})
			// The body, not just the headers: j/ptz.cgi answers 200 before it
			// execs anything, so the headers arrive in milliseconds while the
			// motor is still moving. The body closes when the CGI exits —
			// that is the end of a Pelco pulse, and it is what makes a held
			// button string pulses end to end instead of stacking requests
			// four times a second behind the camera's port lock.
			.then(r => r.text())
			.catch(() => {})
			.finally(() => {
				clearTimeout(activeTimeout);
				activeTimeout = null;
				inflight = false;
				activeKind = null;
				activeAbort = null;
				const next = queuedCommand;
				queuedCommand = null;
				if (next) req(next.query, next.kind);
			});
	}
	// What one press of this button means, from its own dataset.
	function axisFor(action) {
		if (action === 'left' || action === 'right') return 'pan';
		if (action === 'up' || action === 'down') return 'tilt';
		if (action === 'wide' || action === 'tele') return 'zoom';
		if (action === 'near' || action === 'far') return 'focus';
		if (action === 'open' || action === 'close') return 'iris';
		return 'all';
	}
	function fire(btn, durationMs) {
		if (btn.dataset.act) {
			const action = btn.dataset.act;
			if (action === 'af') watchAf();
			if (action === 'stop' || action === 'near' || action === 'far') {
				afWatchUntil = 0;
				afSeenRunning = false;
				if (afOverlay) afOverlay.hidden = true;
			}
			const kind = action === 'af' ? 'af' : action === 'stop' ? 'stop' : 'move';
			let query = 'act=' + action;
			if (durationMs) query += '&duration_ms=' + durationMs;
			req(query, kind);
			return;
		}
		const d = DIRS[btn.dataset.dir];
		if (d) req('h=' + d[0] * STEP + '&v=' + d[1] * STEP, 'move');
	}
	function startHold(btn, owner) {
		if (releaseTimer) {
			clearTimeout(releaseTimer);
			releaseTimer = null;
			if (releaseAxis && releaseAxis !== axisFor(btn.dataset.act)) {
				req('act=stop&axis=' + releaseAxis, 'stop');
			}
			releaseAxis = null;
		}
		if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
		heldButton = null;
		holdOwner = owner;
		if (btn.dataset.act) {
			const act = btn.dataset.act;
			if (act === 'open') updateIrisLabel('Open…');
			else if (act === 'close') updateIrisLabel('Close…');
			else if (act === 'near') updateFocusLabel(lastFv, false, 'Near…');
			else if (act === 'far') updateFocusLabel(lastFv, false, 'Far…');
			else if (act === 'left') { panJog--; updateXyLabel('Pan Left…'); }
			else if (act === 'right') { panJog++; updateXyLabel('Pan Right…'); }
			else if (act === 'up') { tiltJog++; updateXyLabel('Tilt Up…'); }
			else if (act === 'down') { tiltJog--; updateXyLabel('Tilt Down…'); }

			heldButton = btn;
			holdStarted = performance.now();
			fire(btn, PULSE_MS.maximum);
			holdTimer = setTimeout(() => {
				stopHold(owner);
			}, PULSE_MS.maximum);
			return;
		}
		const dir = btn.dataset.dir;
		if (dir) {
			if (dir.includes('l')) panJog--;
			if (dir.includes('r')) panJog++;
			if (dir.includes('u')) tiltJog++;
			if (dir.includes('d')) tiltJog--;
			updateXyLabel('Moving…');
		}
		fire(btn);
		holdTimer = setInterval(() => fire(btn), TICK_MS);
	}
	function stopHold(owner) {
		if (owner != null && owner !== holdOwner) return;
		if (heldButton) {
			const btn = heldButton;
			heldButton = null;
			holdOwner = null;
			if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
			const elapsed = performance.now() - holdStarted;
			releaseAxis = axisFor(btn.dataset.act);
			const dir = btn.dataset.act || '';
			const minimum = releaseAxis === 'focus' ? PULSE_MS.focus :
			                releaseAxis === 'zoom' ? 500 : PULSE_MS.motor;
			const actualMs = Math.round(Math.min(PULSE_MS.maximum, Math.max(minimum, elapsed)));
			const finish = () => {
				releaseTimer = null;
				const axis = releaseAxis;
				req('act=stop&axis=' + axis + '&moved_dir=' + encodeURIComponent(dir) + '&moved_ms=' + actualMs, 'stop');
				if (axis === 'zoom' || axis === 'pan' || axis === 'tilt') {
					if (shouldWatchAfAfter(axis)) watchAf();
					if (axis === 'zoom') {
						setTimeout(fetchZoom, 300);
						setTimeout(fetchZoom, 800);
					}
				} else if (axis === 'focus') {
					setTimeout(pollAf, 300);
					setTimeout(pollAf, 800);
				} else if (axis === 'iris') {
					if (btn.dataset.act === 'open') irisJog++;
					else if (btn.dataset.act === 'close') irisJog--;
					updateIrisLabel();
				}
				updateXyLabel();
				releaseAxis = null;
			};
			if (elapsed < minimum) releaseTimer = setTimeout(finish, minimum - elapsed);
			else finish();
			return;
		}
		if (holdTimer) { clearInterval(holdTimer); holdTimer = null; }
		updateXyLabel();
		holdOwner = null;
	}

	// The centre is a single press on both pads: the stepped backends call it
	// home/park (board-defined), Pelco calls it stop. AF is single-press for
	// the opposite reason: a pass takes seconds, and a held button would
	// queue a fresh pass the moment each one finished — "one shot" must
	// mean one, however long the finger stays down.
	const isSingle = btn => btn.dataset.dir === 'cc' ||
		btn.dataset.act === 'stop' || btn.dataset.act === 'af';

	mount.addEventListener('pointerdown', e => e.stopPropagation());
	mount.addEventListener('pointerup', e => e.stopPropagation());
	mount.addEventListener('click', e => e.stopPropagation());
	mount.addEventListener('dblclick', e => e.stopPropagation());
	mount.addEventListener('contextmenu', e => e.stopPropagation());

	mount.querySelectorAll('button').forEach(btn => {
		if (isSingle(btn)) {
			// Stop first kills any hold still ticking (a keyboard hold can be
			// live while the mouse presses Stop), then fires — and for Pelco
			// the request itself is the un-droppable kind.
			btn.addEventListener('click', (e) => {
				e.stopPropagation();
				e.preventDefault();
				if (btn.dataset.act === 'stop' || btn.dataset.dir === 'cc') {
					panJog = 0;
					tiltJog = 0;
					updateXyLabel();
				}
				stopHold(null);
				fire(btn);
			});
			return;
		}
		btn.addEventListener('pointerdown', e => {
			e.stopPropagation();
			e.preventDefault();
			// Capture keeps pointerup coming to this button however far the
			// finger or cursor wanders mid-hold.
			try { btn.setPointerCapture(e.pointerId); } catch (err) {}
			startHold(btn, 'p' + e.pointerId);
		});
		btn.addEventListener('pointerup', e => {
			e.stopPropagation();
			e.preventDefault();
			stopHold('p' + e.pointerId);
		});
		btn.addEventListener('pointercancel', e => {
			e.stopPropagation();
			stopHold('p' + e.pointerId);
		});
		// Enter/Space on a focused button: a single step or pulse, so the
		// keyboard can nudge precisely; sweeping is what the stage-level
		// arrows are for.
		btn.addEventListener('click', e => {
			e.stopPropagation();
			e.preventDefault();
			if (e.detail !== 0) return;
			const axis = axisFor(btn.dataset.act);
			if (axis === 'iris') {
				if (btn.dataset.act === 'open') irisJog++;
				else if (btn.dataset.act === 'close') irisJog--;
				updateIrisLabel();
			} else if (axis === 'pan') {
				if (btn.dataset.act === 'left') panJog--;
				else if (btn.dataset.act === 'right') panJog++;
				updateXyLabel();
			} else if (axis === 'tilt') {
				if (btn.dataset.act === 'up') tiltJog++;
				else if (btn.dataset.act === 'down') tiltJog--;
				updateXyLabel();
			} else if (axis === 'focus') {
				setTimeout(pollAf, 300);
			}
			if (axis === 'zoom' || axis === 'pan' || axis === 'tilt') {
				const pulseMs = axis === 'zoom' ? 500 : PULSE_MS.motor;
				const dir = btn.dataset.act || '';
				setTimeout(() => {
					req('act=stop&axis=' + axis + '&moved_dir=' + encodeURIComponent(dir) + '&moved_ms=' + pulseMs, 'stop');
					if (shouldWatchAfAfter(axis)) watchAf();
					if (axis === 'zoom') fetchZoom();
				}, axis === 'zoom' ? 520 : PULSE_MS.motor + 20);
			}
			fire(btn, axis === 'focus' ? PULSE_MS.focus :
			          axis === 'zoom' ? 500 : PULSE_MS.motor);
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
