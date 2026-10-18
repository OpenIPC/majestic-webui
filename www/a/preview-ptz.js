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
	// The pad's nine cells in the grid's order, as drawn, before anything here
	// replaces the middle one or adds controls of its own. The axes the head
	// has are the arrows the camera drew: a pan-only head has empty cells
	// where up and down would be. Read once, here, because lay() below moves
	// a lone pair of arrows onto the other axis.
	const slots = pad ? Array.from(pad.children) : [];
	const AXIS_SEL = { pan: '[data-act="left"],[data-act="right"],[data-dir="lc"],[data-dir="rc"]',
		tilt: '[data-act="up"],[data-act="down"],[data-dir="uc"],[data-dir="dc"]' };
	const headPan = !!(pad && pad.querySelector(AXIS_SEL.pan));
	const headTilt = !!(pad && pad.querySelector(AXIS_SEL.tilt));
	// There is no speed control: on the stick, how far the thumb goes is the
	// speed (ptz-stick.js), and anything else moves at the motor's own rate.
	const PS = window.MajesticPtzSpeed;
	// The capability line: the stick and Follow read it. A
	// failed ask is not a line that offers nothing -- it rejects, and is asked
	// again the next time someone wants it (caps()), rather than leaving the
	// stick on four slow directions for the life of the page.
	let capsP = null;
	const caps = () => {
		if (!capsP) {
			capsP = apiFetch('/ptz', { credentials: 'same-origin' })
				.then(r => (r.ok ? r.text() : Promise.reject(r.status)));
			capsP.catch(() => { capsP = null; });
		}
		return capsP;
	};
	// How the picture is turned (ptz-orient.js), for every way this page
	// steers: an arrow, a key or the stick names a direction on the picture,
	// and a mirrored, upside-down or sideways picture's right is not the
	// head's (#691). Read fresh, never the page-lifetime mjConfig() copy:
	// mirror and flip are set on the Settings page, so a change made there in
	// another tab is read when this one comes back into view.
	//
	// Not known is not upright. Until it has been read, and after a read that
	// failed, a direction is not sent: it asks again instead, and the press
	// after the answer moves the head. Sending the upright guess turned a
	// mirrored camera's head away from the arrow pressed, which is the fault
	// this exists for. Stop, zoom and focus are not directions and never wait.
	// One read at a time: a second asker is given the one under way.
	const PO = window.MajesticPtzOrient;
	let turn = null, turnP = null;
	const learnTurn = () => {
		if (!turnP) {
			turnP = apiFetch('/api/v1/config.json', { credentials: 'same-origin', cache: 'no-store' })
				.then(r => (r.ok ? r.json() : Promise.reject(r.status)))
				.then((c) => {
					// A missing or malformed image section is a camera not heard
					// from, not one that is upright.
					const t = PO ? PO.of(c && c.image) : null;
					if (!t) return Promise.reject(new Error('no orientation'));
					turn = t;
					lay();
					return turn;
				})
				// Any read that did not end in a reading forgets the last one:
				// the picture may have been turned since, and that is what the
				// read was asked to find out.
				.catch((e) => { turn = null; return Promise.reject(e); })
				.finally(() => { turnP = null; });
		}
		return turnP;
	};
	// A direction can go to the head only once the picture's turn is known.
	const steerable = () => {
		if (!PO || turn) return true;
		learnTurn().catch(() => {});
		return false;
	};
	// The picture's axes the head can follow.
	const screenAxes = () => (PO ? PO.axes(headPan, headTilt, turn) : { across: headPan, down: headTilt });

	// The arrows sit on the picture's axes the head can follow. A head with
	// both axes needs nothing moved; a pan-only or tilt-only head on a picture
	// lying on its side has its pair moved to the other axis, because there
	// its pan moves the picture up and down. Left in place, the left and right
	// arrows asked a pan-only head to tilt.
	const LOOK = {
		up: { dir: 'uc', label: 'Tilt up', d: 'M5.4 12.4 10 7.6l4.6 4.8' },
		down: { dir: 'dc', label: 'Tilt down', d: 'M5.4 7.6 10 12.4l4.6-4.8' },
		left: { dir: 'lc', label: 'Pan left', d: 'M12.4 5.4 7.6 10l4.8 4.6' },
		right: { dir: 'rc', label: 'Pan right', d: 'M7.6 5.4 12.4 10l-4.8 4.6' },
	};
	const SLOT = { up: 1, left: 3, right: 5, down: 7 };
	function lay() {
		if (!pad || slots.length !== 9 || headPan === headTilt || !turn) return;
		const want = screenAxes().across ? ['left', 'right'] : ['up', 'down'];
		const had = want[0] === 'left' ? ['up', 'down'] : ['left', 'right'];
		if (!slots[SLOT[had[0]]].matches('.mj-ptz-btn')) return;   // already there
		had.forEach((from, i) => {
			const to = want[i], a = SLOT[from], b = SLOT[to];
			const btn = slots[a], gap = slots[b];
			const m = document.createComment('');
			btn.replaceWith(m);
			gap.replaceWith(btn);
			m.replaceWith(gap);
			slots[a] = gap;
			slots[b] = btn;
			if (btn.dataset.act) btn.dataset.act = to;
			else btn.dataset.dir = LOOK[to].dir;
			btn.setAttribute('aria-label', LOOK[to].label);
			const path = btn.querySelector('path');
			if (path) path.setAttribute('d', LOOK[to].d);
		});
	}
	learnTurn().catch(() => {});
	document.addEventListener('visibilitychange', () => { if (!document.hidden) learnTurn().catch(() => {}); });
	// Follow, the same way: hidden until the camera says its motor counts steps
	// and that it can detect something to follow (ptz-follow.js). The switch
	// is the camera's setting, ptz.track, not a per-browser one, and another
	// operator can change it while this page is open. So
	// it is read fresh -- never the page-lifetime mjConfig() copy -- at mount,
	// whenever the page comes back into view, and after each write, and both
	// whether it shows and how it is set follow what came back.
	const followBox = $('#mj-ptz-follow'), followIn = $('#mj-ptz-follow-in');
	const PF = window.MajesticPtzFollow;
	if (followBox && followIn && PF) {
		let followGen = 0;   // a read that started before a later one, or a write, is dropped
		const followRefresh = () => {
			const gen = ++followGen;
			Promise.all([
				apiFetch('/ptz', { credentials: 'same-origin', cache: 'no-store' })
					.then(r => (r.ok ? r.text() : '')),
				apiFetch('/api/v1/config.json', { credentials: 'same-origin', cache: 'no-store' })
					.then(r => (r.ok ? r.json() : Promise.reject(r.status))),
			]).then(([caps, cfg]) => {
				if (gen !== followGen || followIn.disabled) return;
				const v = PF.view(caps, cfg);
				followIn.checked = v.on;
				followBox.hidden = !v.show;
				if (v.show) placeExtras();
				else showGear();
			}).catch(() => { /* no answer: leave it as it was */ });
		};
		followRefresh();
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'visible') followRefresh();
		});
		followIn.addEventListener('change', () => {
			const want = followIn.checked;
			followIn.disabled = true;
			followGen++;   // whatever a read in flight says predates this write
			apiFetch('/api/v1/config', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'same-origin',
				body: PF.body(want),
			}).then(r => { if (!r.ok) followIn.checked = !want; })
				.catch(() => { followIn.checked = !want; })
				.then(() => { followIn.disabled = false; followRefresh(); });
		});
	}
	// Folded on a small stage. The pad is about 140px square and the zoom/focus
	// cluster as tall again, so on a phone they covered a sixth of the picture or
	// more for somebody who came to look at it -- and a share's guest, who rarely
	// steers at all, met that before anything else. Behind one button there, the
	// same size as a pad button and in the same corner; open, the button stays
	// at the top of the column to fold it back. Whether it is open is
	// remembered per browser, so whoever does steer opens it once. A window
	// large enough for the pad never folds it and shows no button.
	//
	// LAST in the column, so at its foot: where the stage is too short for the
	// open column (a phone in landscape: 192px of stage, 355px of Pelco
	// cluster) the stylesheet's clamp keeps the bottom on screen and lets the
	// top run under the navbar. At the top, the button that closes the pads
	// went there with it, and the open state is remembered.
	const SMALL = '(max-width: 575.98px), (max-height: 480px)';
	const small = window.matchMedia ? window.matchMedia(SMALL) : null;
	const fold = document.createElement('button');
	fold.type = 'button';
	fold.className = 'mj-ptz-fold';
	fold.innerHTML = '<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" ' +
		'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
		'<path class="mj-ptz-fold-open" d="M10 2.5v15M2.5 10h15M7.5 5 10 2.5 12.5 5M7.5 15l2.5 2.5 2.5-2.5' +
		'M5 7.5 2.5 10 5 12.5M15 7.5l2.5 2.5-2.5 2.5"></path>' +
		'<path class="mj-ptz-fold-close" d="M5 5l10 10M15 5 5 15"></path></svg>';
	const OPEN_KEY = 'mj-ptz-open';
	let open = false;
	try { open = localStorage.getItem(OPEN_KEY) === '1'; } catch (e) { /* ignore */ }
	// Follow is a setting of the pad, not a control on it: on a small
	// stage it waits behind a gear, in a popover beside the column, so the
	// open pad is the arrows alone -- four stacked panels covered half a phone
	// (measured on an iPhone). On a larger stage it sits in the
	// column as before.
	const gear = document.createElement('button');
	gear.type = 'button';
	gear.className = 'mj-ptz-gear';
	gear.hidden = true;
	gear.setAttribute('aria-label', 'Pan and tilt settings');
	gear.title = 'Pan and tilt settings';
	gear.setAttribute('aria-expanded', 'false');
	gear.innerHTML = '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" ' +
		'stroke-width="1.5" stroke-linecap="round" aria-hidden="true">' +
		'<path d="M3.5 6h6M13.5 6h3M3.5 14h3M10.5 14h6"></path>' +
		'<circle cx="11.5" cy="6" r="2"></circle><circle cx="8.5" cy="14" r="2"></circle></svg>';
	const more = document.createElement('div');
	more.className = 'mj-ptz-more';
	more.id = 'mj-ptz-more';
	more.hidden = true;
	gear.setAttribute('aria-controls', more.id);
	const head = document.createElement('div');
	head.className = 'mj-ptz-head';
	// The Pelco pad's top corners are empty cells: the gear and the fold go
	// there and the open pad is no taller than its arrows. The eight-way pad
	// has diagonals in them, so there the two sit in a strip at its foot.
	const corners = !!(pad && pad.children.length > 2 &&
		pad.children[0].classList.contains('mj-ptz-void') &&
		pad.children[2].classList.contains('mj-ptz-void'));
	const isSmall = () => !!(small && small.matches);
	// Its bottom-left cell, for a handle that has no centre to take.
	const gripCorner = !!(pad && pad.children.length > 6 && pad.children[6].classList.contains('mj-ptz-void'));
	const hasExtras = () => !!(followBox && !followBox.hidden && followBox.isConnected);
	const popOpen = (on) => {
		more.hidden = !on;
		gear.setAttribute('aria-expanded', String(on));
		gear.classList.toggle('mj-ptz-gear-on', on);
	};
	function showGear() {
		gear.hidden = !(isSmall() && open && hasExtras());
		if (gear.hidden) popOpen(false);
	}
	// Follow to where it belongs at this size, and the gear shown
	// only when the popover would hold something.
	function placeExtras() {
		const home = isSmall() ? more : mount;
		for (const box of [followBox]) {
			if (!box || box.hidden) continue;
			if (box.parentNode !== home) {
				if (home === mount) mount.insertBefore(box, fold.parentNode === mount ? fold : null);
				else home.appendChild(box);
			}
		}
		showGear();
	}
	gear.addEventListener('click', (e) => { e.stopPropagation(); popOpen(more.hidden); });
	document.addEventListener('pointerdown', (e) => {
		if (!more.hidden && !more.contains(e.target) && e.target !== gear && !gear.contains(e.target)) popOpen(false);
	});
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && !more.hidden) { popOpen(false); gear.focus(); }
	});
	mount.appendChild(more);

	// ---- moving the pad --------------------------------------------------
	//
	// The pad covers a corner of the picture, and what is in that corner is
	// sometimes what the operator came to see. It moves: dragged by its
	// handle anywhere on the stage, it settles in the nearest corner, and the
	// corner is remembered per browser. The Pelco pad's centre was Stop, which
	// nothing needs -- every hold already stops on release -- and is the
	// stick's knob now (below), so its handle takes the empty bottom-left
	// corner; the eight-way pad keeps its Centre (home) and has its handle in
	// the strip with the gear and the fold.
	const CORNERS = ['br', 'bl', 'tl', 'tr'];
	const CORNER_KEY = 'mj-ptz-corner';
	const grip = document.createElement('button');
	grip.type = 'button';
	grip.className = 'mj-ptz-grip';
	grip.setAttribute('aria-label', 'Move the pad to another corner');
	grip.title = 'Drag to move the pad';
	grip.innerHTML = '<svg viewBox="0 0 20 20" width="18" height="18" fill="currentColor" aria-hidden="true">' +
		'<circle cx="7" cy="5" r="1.4"></circle><circle cx="13" cy="5" r="1.4"></circle>' +
		'<circle cx="7" cy="10" r="1.4"></circle><circle cx="13" cy="10" r="1.4"></circle>' +
		'<circle cx="7" cy="15" r="1.4"></circle><circle cx="13" cy="15" r="1.4"></circle></svg>';
	const stopBtn = pad ? pad.querySelector('[data-act="stop"]') : null;
	const PK = window.MajesticPtzStick;
	const stick = !!(stopBtn && PK);
	const knob = document.createElement('span');
	knob.className = 'mj-ptz-knob';
	knob.setAttribute('aria-hidden', 'true');
	if (stopBtn) stopBtn.replaceWith(stick ? knob : grip);
	if (stick) pad.classList.add('mj-ptz-stick');
	const gripInPad = !!stopBtn && !stick;
	let corner = 'br';
	try { if (CORNERS.indexOf(localStorage.getItem(CORNER_KEY)) >= 0) corner = localStorage.getItem(CORNER_KEY); } catch (e) { /* ignore */ }
	const setCorner = (c) => {
		corner = c;
		for (const k of CORNERS) stage.classList.toggle('mj-ptz-' + k, k === c && c !== 'br');
		try { localStorage.setItem(CORNER_KEY, c); } catch (e) { /* ignore */ }
		window.dispatchEvent(new Event('resize'));
	};
	setCorner(corner);
	let drag = null;
	grip.addEventListener('touchstart', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
	grip.addEventListener('pointerdown', (e) => {
		e.preventDefault();
		e.stopPropagation();
		try { grip.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
		drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
		mount.classList.add('mj-ptz-dragging');
	});
	grip.addEventListener('pointermove', (e) => {
		if (!drag || e.pointerId !== drag.id) return;
		const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
		if (Math.abs(dx) + Math.abs(dy) > 6) drag.moved = true;
		mount.style.transform = `translate(${dx}px, ${dy}px)`;
	});
	const endDrag = (e) => {
		if (!drag || e.pointerId !== drag.id) return;
		const moved = drag.moved;
		drag = null;
		mount.classList.remove('mj-ptz-dragging');
		if (moved) {
			const m = mount.getBoundingClientRect(), st = stage.getBoundingClientRect();
			const cx = m.left + m.width / 2 - st.left, cy = m.top + m.height / 2 - st.top;
			mount.style.transform = '';
			setCorner((cy < st.height / 2 ? 't' : 'b') + (cx < st.width / 2 ? 'l' : 'r'));
		} else {
			mount.style.transform = '';
		}
	};
	grip.addEventListener('pointerup', endDrag);
	grip.addEventListener('pointercancel', endDrag);
	// From the keyboard: Enter or Space takes it round the corners.
	grip.addEventListener('click', (e) => {
		if (e.detail !== 0) return;
		setCorner(CORNERS[(CORNERS.indexOf(corner) + 1) % CORNERS.length]);
	});

	const applyFold = () => {
		const folded = !!(small && small.matches) && !open;
		mount.classList.toggle('mj-ptz-folded', folded);
		mount.classList.toggle('mj-ptz-foldable', !!(small && small.matches));
		// Where the fold and the gear stand: folded, the fold alone in the
		// mount; open on a small stage, in the pad's corners or the strip.
		if (!isSmall() || folded) {
			mount.appendChild(fold);
			// The handle where the Pelco pad has none of its own: first in the
			// column on a large stage.
			if (!gripInPad) mount.insertBefore(grip, mount.firstChild);
		} else if (corners) {
			pad.appendChild(gear);
			pad.appendChild(fold);
			// A pad with empty corners but no Stop of its own (an eight-way
			// pad missing its diagonals): the handle takes the bottom-left
			// corner where that is empty too, else the strip below.
			if (!gripInPad) {
				if (gripCorner) { grip.classList.add('mj-ptz-grip-corner'); pad.appendChild(grip); }
				else { head.appendChild(grip); mount.appendChild(head); }
			}
		} else {
			head.appendChild(gear);
			if (!gripInPad) head.appendChild(grip);
			head.appendChild(fold);
			mount.appendChild(head);
		}
		if (folded) popOpen(false);
		showGear();
		fold.setAttribute('aria-expanded', String(!folded));
		const say = folded ? 'Show camera controls' : 'Hide camera controls';
		fold.setAttribute('aria-label', say);
		fold.title = say;
	};
	fold.addEventListener('click', () => {
		open = mount.classList.contains('mj-ptz-folded');
		try { localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch (e) { /* ignore */ }
		applyFold();
	});
	mount.appendChild(fold);
	applyFold();
	if (small) {
		if (small.addEventListener) small.addEventListener('change', placeExtras);
		else if (small.addListener) small.addListener(placeExtras);
	}
	if (small) {
		if (small.addEventListener) small.addEventListener('change', applyFold);
		else if (small.addListener) small.addListener(applyFold);
	}
	mount.hidden = false;

	const STEP = 5, TICK_MS = 250;
	// A held zoom is ONE long continuous move the camera's deadline keeps alive,
	// re-armed by each tick, not a train of short pulses. Long, because the tick
	// only has to LAND once to keep zooming for this whole span -- the author
	// measured a 250 ms ticker leaving a single 500 ms pulse in a 1.2 s hold over
	// a slow link, which reads exactly as "one step, then holding does nothing".
	const HOLD_MS = 1500;
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
	// `pct`, when given, is this move's speed (the stick's); without it the
	// motor runs at its own rate.
	function move(verb, ms, isStop, pct) {
		let endpoint = (window.ptzControl === 'anjoy') ? '/cgi-bin/j/ptz.cgi' : '/ptz';
		let url = endpoint + '?move=' + encodeURIComponent(verb);
		// The picture's direction to the head's, before the speed is picked:
		// on its side, the picture's across is the head's tilt.
		if (PO && PO.direction(verb)) {
			if (!steerable()) return;
			verb = PO.verb(verb, turn);
		}
		let url = '/ptz?move=' + encodeURIComponent(verb);
		if (ms) url += '&ms=' + ms;
		if (pct != null && PS) url += PS.query(verb, pct);
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
		// Focus by ear measures against the same best, and preview-focus.js
		// loads after this file: an event rather than a lookup, so the two
		// cannot disagree about when a scene changed.
		if (typeof CustomEvent === 'function')
			window.dispatchEvent(new CustomEvent('mj-focus-reset'));
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
	// /autofocus and /ptz outright when ptz.enabled is off, so a
	// definite 404 withdraws the control and the focus caption stays plain. An
	// answer promotes the caption to "Manual focus", because now there is
	// something automatic to contrast it with. Anything else — a timeout, a
	// proxy, a camera mid-restart — changes nothing: could not ask is not an
	// answer about the hardware, and this is exactly the camera where the
	// operator has just turned the setting on and is waiting to see it.
	if (afState && afSay && window.ptzControl !== 'anjoy') {
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
	// operator's own ptz.pulse: send no duration and the camera uses
	// it, so anyone who tuned that keeps exactly what they tuned. The FINE step
	// is a fifth of it, floored at the key's own minimum. No new setting, and
	// nothing in localStorage — the camera already stores this, and a step that
	// lived in one browser would not be the step the next operator got.
	let fineMs = 100;
	if (typeof mjConfig === 'function') {
		mjConfig().then((c) => {
			const n = parseInt(c && c.ptz && c.ptz.pulse, 10);
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
		if (!d) return;
		// The centre is home, not a direction, and never waits.
		if ((d[0] || d[1]) && !steerable()) return;
		const h = PO ? PO.vec(d[0], d[1], turn) : { x: d[0], y: d[1] };
		req('h=' + h.x * STEP + '&v=' + h.y * STEP);
	}
	function startHold(btn, owner) {
		// Supersede whatever was held without sending a stop: the new verb is
		// going out in the same breath and would override it anyway.
		clearHold();
		holdBtn = btn;
		holdOwner = owner;
		holdStart = Date.now();
		const act = btn.dataset.act;
		// Zoom is press-to-move: send one LONG continuous move at once and keep
		// re-arming it while the button is down; the release stops it. There is no
		// tap/hold guess to make -- a quick tap releases almost immediately and its
		// own stop cuts the move short, so the amount zoomed tracks how long the
		// button was held. This is robust where the old fine-pulse-then-ticker was
		// not: on a slow or lossy link a single tick that lands still zooms for
		// HOLD_MS instead of one 500 ms step, and there is no ticker-never-started
		// window that leaves a hold as one nudge.
		if (act === 'wide' || act === 'tele') {
			fire(btn, HOLD_MS);
			holdTimer = setInterval(() => fire(btn, HOLD_MS), TICK_MS);
			return;
		}
		// Focus keeps the fine-pulse-then-ticker model: the press cannot yet know
		// whether it is a tap or a hold, so it sends the fine step and the ticker
		// takes over. The first coarse tick is timed to land as that fine pulse
		// expires rather than at the usual quarter second, or a hold would be a
		// nudge, a stall, then motion.
		const fine = (act && act !== 'stop') ? fineMs : 0;
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
		// Zoom always issued a LONG continuous move (startHold), so every zoom
		// release must stop it, however brief -- a quick zoom tap is meant to be a
		// short nudge, and its stop is what makes it one. Focus sent a
		// self-terminating fine pulse, so there a press shorter than the step sends
		// no stop and the nudge completes; anything longer is a sweep that has to
		// be told to stop or the motor runs on to its deadline.
		const isZoom = btn && (btn.dataset.act === 'wide' || btn.dataset.act === 'tele');
		if (btn && btn.dataset.act && (isZoom || heldMs >= fineMs)) move('stop', 0, true);
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

	// A held button is not a long press on a page: no selection may start
	// from it (WebKit fires selectstart even where the stylesheet already
	// refused one, on older iOS) and no context menu -- Android's long-press
	// menu and a right click both came up over a button being held.
	mount.addEventListener('selectstart', e => e.preventDefault());
	mount.addEventListener('contextmenu', e => e.preventDefault());

	// The fold and the gear are the mount's own, not moves.
	mount.querySelectorAll('button:not(.mj-ptz-fold):not(.mj-ptz-gear):not(.mj-ptz-grip)').forEach(btn => {
		if (isSingle(btn)) {
			// Stop first kills any hold still ticking (a keyboard hold can be
			// live while the mouse presses Stop), then fires — and for Pelco
			// the request itself is the un-droppable kind.
			btn.addEventListener('click', () => { stopHold(null); fire(btn); });
			return;
		}
		// The stick's arrows are the stick's: a finger on one is a thumb on
		// the stick (below), and only the keyboard presses them as buttons.
		if (!(stick && pad.contains(btn))) {
			// iOS starts its long-press selection gesture from touchstart, before
			// any pointer event can refuse it; a held arrow must never be one.
			// Pointer events still fire, so the hold below is unaffected.
			btn.addEventListener('touchstart', e => { if (e.cancelable) e.preventDefault(); }, { passive: false });
			btn.addEventListener('pointerdown', e => {
				e.preventDefault();
				// Capture keeps pointerup coming to this button however far the
				// finger or cursor wanders mid-hold.
				try { btn.setPointerCapture(e.pointerId); } catch (err) {}
				startHold(btn, 'p' + e.pointerId);
			});
			btn.addEventListener('pointerup', e => stopHold('p' + e.pointerId));
			btn.addEventListener('pointercancel', e => stopHold('p' + e.pointerId));
		}
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
			startHold(btn, 'kb');
			stopHold('kb');
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
	// ---- the stick -------------------------------------------------------
	//
	// On the Pelco pad a finger anywhere on the arrows is a thumb on a stick:
	// the head turns towards it for as long as it is down and follows it as it
	// slides, so steering round means sliding, not lifting the finger to press
	// another arrow. Near the centre is slow and the rim fast, where the motor
	// keeps a speed (ptz-stick.js); back on the centre it stands still. The
	// diagonals go where the camera lists them, and the corners of the plus are
	// part of the stick too. A quick tap on an arrow is still a nudge: the
	// first move of a press is the fine pulse, as a held arrow's is.
	if (stick) {
		// Until the camera has said, four directions at the pad's speed; a
		// press asks again if it has not.
		let diag = false, speeds = false, known = false;
		const learn = () => {
			if (known) return;
			caps().then((t) => {
				diag = PK.diagonals(t);
				speeds = !!(PS && PS.offered(t));
				known = true;
			}, () => {});
		};
		learn();
		// The arrows by direction, read each time: lay() can move them.
		const arrowsNow = () => {
			const a = {};
			pad.querySelectorAll('[data-act]').forEach((b) => { a[b.dataset.act] = b; });
			return a;
		};
		let s = null;
		// The arrows a verb is made of, lit while the head turns that way.
		const light = (verb) => {
			const arrows = arrowsNow();
			for (const k in arrows) arrows[k].classList.toggle('mj-ptz-on', !!verb && verb.indexOf(k) >= 0);
		};
		const send = (ms) => {
			if (!s || !s.verb) return;
			if (!ms) s.long = true;
			move(s.verb, ms, false, s.pct);
		};
		const steer = (e) => {
			const dx = e.clientX - s.cx, dy = e.clientY - s.cy;
			const d = Math.hypot(dx, dy), k = d > s.r ? s.r / d : 1;
			knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
			const ax = screenAxes();
			const a = PK.aim(dx, dy, { radius: s.r, dead: s.r * 0.22, diagonals: diag, prev: s.verb, pan: ax.across, tilt: ax.down });
			const verb = a ? a.verb : null;
			const pct = a && speeds ? PK.pct(a.frac) : null;
			if (verb === s.verb && pct === s.pct) return;
			const was = s.verb;
			s.verb = verb;
			s.pct = pct;
			light(verb);
			if (!verb) {
				// Back on the centre: still, and ready to go again -- the fine
				// pulse included, which would otherwise run out its time.
				if (was) {
					move('stop', 0, true);
					s.long = true;   // a release from here is not a tap
				}
				return;
			}
			if (s.first) { send(); return; }
			s.first = Date.now();
			send(fineMs);
			s.kick = setTimeout(() => {
				if (!s) return;
				s.kick = null;
				send();
				s.timer = setInterval(() => send(), TICK_MS);
			}, fineMs);
		};
		const letGo = (e) => {
			if (!s || (e && e.pointerId !== s.id)) return;
			clearTimeout(s.kick);
			clearInterval(s.timer);
			// A tap shorter than the fine pulse is a nudge, and the pulse ends
			// it; anything longer was a sweep and is told to stop.
			if (s.verb && (s.long || Date.now() - s.first >= fineMs)) move('stop', 0, true);
			s = null;
			knob.style.transform = '';
			pad.classList.remove('mj-ptz-sticking');
			if (stage) stage.classList.remove('mj-steering');
			light(null);
		};
		// The settings, the fold and the handle are buttons on the pad, not
		// part of the stick.
		const own = (t) => !!(t && t.closest && t.closest('.mj-ptz-gear, .mj-ptz-fold, .mj-ptz-grip'));
		pad.addEventListener('touchstart', (e) => { if (!own(e.target) && e.cancelable) e.preventDefault(); }, { passive: false });
		pad.addEventListener('pointerdown', (e) => {
			if (own(e.target) || (e.pointerType === 'mouse' && e.button !== 0)) return;
			e.preventDefault();
			letGo();
			stopHold(null);
			learn();
			try { pad.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
			// The rim is where the arrows are: measured, since the pad's size
			// is the stylesheet's and changes with the screen.
			const kb = knob.getBoundingClientRect();
			const cx = kb.left + kb.width / 2, cy = kb.top + kb.height / 2;
			const arrows = arrowsNow();
			const ref = arrows.right || arrows.up;
			const rb = ref ? ref.getBoundingClientRect() : null;
			const r = rb ? Math.max(24, Math.hypot(rb.left + rb.width / 2 - cx, rb.top + rb.height / 2 - cy)) : 44;
			s = { id: e.pointerId, cx: cx, cy: cy, r: r, verb: null, pct: null, first: 0, long: false, kick: null, timer: null };
			pad.classList.add('mj-ptz-sticking');
			if (stage) stage.classList.add('mj-steering');
			steer(e);
		});
		pad.addEventListener('pointermove', (e) => { if (s && e.pointerId === s.id) steer(e); });
		pad.addEventListener('pointerup', letGo);
		pad.addEventListener('pointercancel', letGo);
		window.addEventListener('blur', () => letGo());
		document.addEventListener('visibilitychange', () => { if (document.hidden) letGo(); });
	}

	// ---- centre on a point -------------------------------------------------
	//
	// Double-tap (or double-click) a point of the picture and the head turns
	// to put it in the middle (ptz-centre.js): one counted move per axis, so
	// nothing to hold and nothing to stop, however slow the link. A ring at
	// the point glides to the middle of the picture over about the time the
	// head takes, so what was asked is on screen before the picture catches
	// up. Only where the camera says how many steps make a frame; there the
	// double-click is this, and Fit/Fill stays in the bar.
	const PC = window.MajesticPtzCentre;
	if (stage && PC && pad && pad.querySelector('[data-act]')) {
		// Neither is assumed: until the camera has said how many steps make a
		// frame and how its picture is turned, a double-tap does nothing (and
		// asks again). A picture taken for upright that is mirrored would send
		// the head away from the point.
		// A line in the toast stack. Not `say`: that is the autofocus line's,
		// and a block-level function of the same name would replace it.
		const tell = (text, ms) => {
			const box = $('#mj-toasts');
			if (!box) return;
			const p = document.createElement('p');
			p.className = 'mj-adapt-toast small';
			p.setAttribute('role', 'status');
			p.textContent = text;
			p.addEventListener('click', () => p.remove());
			box.appendChild(p);
			setTimeout(() => p.remove(), ms || 6000);
		};
		// Said once per browser, when it first becomes possible: a gesture
		// nobody is told about is one nobody finds.
		const HINT_KEY = 'mj-ptz-steer-hint';
		const hint = () => {
			let seen = false;
			try { seen = localStorage.getItem(HINT_KEY) === '1'; } catch (e) { /* show it */ }
			if (seen) return;
			try { localStorage.setItem(HINT_KEY, '1'); } catch (e) { /* once a page then */ }
			tell('Drag the picture to turn the camera; double-tap to centre a spot.', 8000);
		};
		let frame = null;
		const ready = () => !!(frame && turn);
		// A read that failed is asked again, a little later each time, and at
		// the next touch of the picture: a camera that did not answer at load
		// is not one without the gestures for the life of the page.
		const AGAIN_MS = [2000, 5000, 15000, 30000, 60000];
		let again = 0, againTimer = null;
		const retry = () => {
			if (againTimer || again >= AGAIN_MS.length) return;
			againTimer = setTimeout(() => {
				againTimer = null;
				again++;
				if (!frame) learnFrame();
				if (!turn) learnTurnHere();
			}, AGAIN_MS[again]);
		};
		const learnFrame = () => caps().then((t) => {
			frame = PC.frame(t);
			if (ready()) arrive();
		}, retry);
		const learnTurnHere = () => learnTurn().then(() => { if (ready()) arrive(); }, retry);
		learnFrame();
		learnTurnHere();
		stage.addEventListener('pointerdown', () => {
			if (ready()) return;
			if (!frame) learnFrame();
			if (!turn) learnTurnHere();
		}, true);
		// A picture standing still is not the live one: the uncompressed still
		// over it, or the snapshot under tap-to-play. Neither a drag nor a
		// double-tap turns the head for a picture that would not show the turn.
		const visible = (sel) => { const e = $(sel); return !!(e && !e.hidden); };
		const paused = () => stage.classList.contains('mj-stilled') || visible('#mj-snapshot') || visible('#mj-tap-play');
		const hasPan = headPan, hasTilt = headTilt;
		// One counted move per axis, both at once: the head runs a pan count
		// and a tilt count together. Rejects when either is refused -- or the
		// lens driver is absent, which answers 200 'unavailable'.
		const sendSteps = (moves) => Promise.all(moves.map((mv) =>
			apiFetch('/ptz?move=' + mv.verb + '&steps=' + mv.steps, { method: 'POST', credentials: 'same-origin' })
				.then((res) => (res.ok ? res.text() : Promise.reject(res.status)))
				.then((t) => { if (t.trim() === 'unavailable') throw new Error('unavailable'); })
		));
		const OVER = '.mj-bar, .mj-ptz, #mj-stats, #mj-toasts, #mj-tap-play, .mj-more-sheet';
		const media = () => {
			for (const m of stage.querySelectorAll('.mj-stage-media')) {
				if (!m.hidden && m.getBoundingClientRect().width > 0) return m;
			}
			return null;
		};
		const ring = (x, y, cx, cy, ms) => {
			const st = stage.getBoundingClientRect();
			const el = document.createElement('div');
			el.className = 'mj-centre-ring';
			el.setAttribute('aria-hidden', 'true');
			el.style.left = (x - st.left) + 'px';
			el.style.top = (y - st.top) + 'px';
			stage.appendChild(el);
			const glide = Math.max(250, Math.min(ms, 4000));
			const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
			el.style.transitionDuration = still ? '0ms' : glide + 'ms';
			requestAnimationFrame(() => requestAnimationFrame(() => {
				el.style.transform = `translate(${cx - x}px, ${cy - y}px)`;
				el.classList.add('mj-centre-going');
			}));
			let gone = false;
			const vanish = () => {
				if (gone) return;
				gone = true;
				el.style.transitionDuration = '0ms, 400ms';
				el.classList.add('mj-centre-done');
				setTimeout(() => el.remove(), 450);
			};
			setTimeout(vanish, (still ? 600 : glide) + 150);
			// The camera refused, or never answered: the ring says so where it
			// stands, rather than finishing a journey the head is not making.
			return {
				fail: () => {
					el.classList.add('mj-centre-failed');
					el.style.transitionDuration = '0ms';
					el.style.transform = getComputedStyle(el).transform;
					setTimeout(vanish, 500);
				},
			};
		};
		// Where the point is in the frame: the media element is the whole
		// frame as drawn, the letterbox, a Fill crop and a zoom included.
		//
		// The point goes to the middle of what is on screen -- the stage --
		// which in Fill or a zoom is not the middle of the frame: moved to the
		// frame's middle it could land off screen.
		const centreAt = (x, y) => {
			if (!frame) { learnFrame(); return false; }
			if (!turn) { learnTurnHere(); return false; }
			if (paused()) return false;
			// Not before the picture is laid out: until then the media box is
			// the stage's own, not a frame.
			const Z = window.MajesticZoom;
			if (!(Z && typeof Z.view === 'function' && Z.view())) return false;
			const m = media();
			if (!m) return false;
			const r = m.getBoundingClientRect();
			const nx = (x - r.left) / r.width, ny = (y - r.top) / r.height;
			if (!(nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1)) return false;
			const st = stage.getBoundingClientRect();
			let vx = st.left + st.width / 2, vy = st.top + st.height / 2;
			// A middle off the frame (it cannot be, laid out, but) falls back to
			// the frame's own, as plan() does.
			if (!(vx >= r.left && vx <= r.right)) vx = r.left + r.width / 2;
			if (!(vy >= r.top && vy <= r.bottom)) vy = r.top + r.height / 2;
			const p = PC.plan(nx, ny, frame, {
				turn: turn, pan: hasPan, tilt: hasTilt,
				tx: (vx - r.left) / r.width, ty: (vy - r.top) / r.height,
			});
			if (!p.moves.length) return true;
			stopHold(null);
			// The ring moves along the picture's axes the head is turning: on
			// its side, a pan moves it up or down.
			const side = turn.rotate === 90 || turn.rotate === 270;
			const across = side ? p.tilt : p.pan, down = side ? p.pan : p.tilt;
			const shown = ring(x, y, across ? vx : x, down ? vy : y, p.ms);
			// Both at once: the head runs a pan count and a tilt count
			// together. Either refused -- or the lens driver absent, which
			// answers 200 'unavailable' -- and the ring stops where it is.
			sendSteps(p.moves).catch(() => {
				shown.fail();
				tell('The camera did not turn. Try again.');
			});
			return true;
		};

		// ---- drag the picture to steer ---------------------------------
		//
		// In Fit and Fill a drag on the picture is handed here (preview-zoom's
		// setSteer()). The picture slides under the finger at once, showing
		// where the head will end up; on release the head turns that far, one
		// counted move per axis, and the picture eases back as the live one
		// arrives where the slide left it. Nothing is held and nothing has to
		// be stopped, so a slow link costs only the wait. Like a map: the
		// content under the finger follows it.
		const SLIDE_MIN = 8;   // px: under it the press was a tap (the bar, a double-tap)
		const reduced = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
		let slideTimer = null;
		// The picture's offset, eased over `ms` (0: at once). The inline
		// transition is taken off once it is done: preview-zoom eases the
		// media's own position, and a transition left here would replace it.
		const slide = (dx, dy, ms) => {
			clearTimeout(slideTimer);
			for (const m of stage.querySelectorAll('.mj-stage-media')) {
				m.style.transition = ms ? 'transform ' + ms + 'ms cubic-bezier(0.4, 0, 0.2, 1)' : 'none';
				m.style.transform = dx || dy ? 'translate(' + dx + 'px, ' + dy + 'px)' : '';
			}
			if (!dx && !dy) {
				slideTimer = setTimeout(() => {
					for (const m of stage.querySelectorAll('.mj-stage-media')) m.style.transition = '';
				}, ms + 50);
			}
		};
		let held = null;
		// Which drag is the latest: an earlier one's ease back and its answer
		// leave a newer drag's picture alone.
		let steerGen = 0;
		const steerer = {
			wants: (e) => {
				if (e.target.closest && e.target.closest(OVER)) return false;
				const Z = window.MajesticZoom;
				return ready() && !paused() && !!media() && !!(Z && typeof Z.view === 'function' && Z.view());
			},
			start: (e) => {
				steerGen++;
				held = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, dx: 0, dy: 0, on: false,
					r: media().getBoundingClientRect() };
			},
			move: (e) => {
				if (!held) return;
				held.lx = e.clientX;
				held.ly = e.clientY;
				const ax = screenAxes();
				let dx = ax.across ? e.clientX - held.x : 0, dy = ax.down ? e.clientY - held.y : 0;
				if (!held.on) {
					if (Math.hypot(e.clientX - held.x, e.clientY - held.y) <= SLIDE_MIN) return;
					held.on = true;
					stage.classList.add('mj-steering');
					stopHold(null);
				}
				// No further than one move can turn the head.
				// The frame's steps are the head's, measured upright: on its
				// side the picture's across takes the tilt's.
				const side = turn.rotate === 90 || turn.rotate === 270;
				const fw = side ? frame.h : frame.w, fh = side ? frame.w : frame.h;
				const mx = PC.MAX / fw * held.r.width, my = PC.MAX / fh * held.r.height;
				dx = Math.max(-mx, Math.min(mx, dx));
				dy = Math.max(-my, Math.min(my, dy));
				held.dx = dx;
				held.dy = dy;
				slide(dx, dy, 0);
			},
			end: (e, commit) => {
				const d = held;
				held = null;
				stage.classList.remove('mj-steering');
				if (!d || !d.on) return;
				const p = commit ? PC.drag(d.dx / d.r.width, d.dy / d.r.height, frame, {
					turn: turn, pan: hasPan, tilt: hasTilt,
				}) : null;
				if (!p || !p.moves.length) { slide(0, 0, 200); return; }
				// Held where it was let go for a moment -- the move is on its
				// way -- then eased back over about the head's time.
				const glide = Math.max(250, Math.min(p.ms, 4000));
				const still = reduced();
				const g = steerGen;
				const mine = () => g === steerGen && !held;
				const back = setTimeout(() => { if (mine()) slide(0, 0, still ? 0 : glide); }, still ? glide : 150);
				sendSteps(p.moves).catch(() => {
					clearTimeout(back);
					if (mine()) slide(0, 0, 200);
					tell('The camera did not turn. Try again.');
				});
			},
			cancel: () => {
				const d = held;
				held = null;
				stage.classList.remove('mj-steering');
				if (d && d.on) slide(0, 0, 200);
				return d ? { x: d.lx, y: d.ly } : null;
			},
		};
		// Once the camera has said how far a frame is and how its picture is
		// turned: the hint, and the drag.
		//
		// preview-zoom.js loads after this file, and the camera's answers can
		// land while the browser is still fetching it: then the drag is handed
		// over once the document has loaded, not dropped.
		const register = () => {
			const Z = window.MajesticZoom;
			if (!Z || typeof Z.setSteer !== 'function') return false;
			Z.setSteer(steerer);
			return true;
		};
		const arrive = () => {
			hint();
			if (register()) return;
			if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', register, { once: true });
			else setTimeout(register, 0);
		};
		// The pointer's double-click, ahead of preview-zoom.js's Fit/Fill
		// toggle (capture on the stage runs first), and only when it centred.
		let lastTouch = 0;
		stage.addEventListener('dblclick', (e) => {
			if (Date.now() - lastTouch < 800) return;
			if (e.target.closest && e.target.closest(OVER)) return;
			if (centreAt(e.clientX, e.clientY)) {
				e.preventDefault();
				e.stopImmediatePropagation();
			}
		}, true);
		// A finger's double-tap: two short taps close together. The first has
		// already shown (or hidden) the bar and the second puts it back, so
		// the bar ends as it was. A second finger makes it a pinch, not a tap.
		let down = null, prev = null, fingers = 0;
		stage.addEventListener('pointerdown', (e) => {
			if (e.pointerType !== 'touch') return;
			lastTouch = Date.now();
			fingers++;
			down = fingers === 1 && !(e.target.closest && e.target.closest(OVER))
				? { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now() } : null;
			if (fingers > 1) prev = null;
		});
		const up = (e) => {
			if (e.pointerType !== 'touch') return;
			fingers = Math.max(0, fingers - 1);
			const d = down;
			down = null;
			if (!d || e.pointerId !== d.id || e.type === 'pointercancel') return;
			const now = Date.now();
			// The same bound the drag starts at: past it the press was a steer,
			// and it is no half of a double-tap.
			if (now - d.t > 300 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > SLIDE_MIN) { prev = null; return; }
			if (prev && now - prev.t < 400 && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 40) {
				prev = null;
				centreAt(e.clientX, e.clientY);
				return;
			}
			prev = { x: e.clientX, y: e.clientY, t: now };
		};
		stage.addEventListener('pointerup', up);
		stage.addEventListener('pointercancel', up);
	}

	// A hold must not outlive the page's attention: keyup and pointerup never
	// arrive in a window that lost focus mid-hold.
	window.addEventListener('blur', () => stopHold(null));
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) stopHold(null);
	});
})();
