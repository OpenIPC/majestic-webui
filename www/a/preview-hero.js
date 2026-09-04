// Stage chrome for the Live View page: the control bar's visibility, the
// fullscreen button, and the snapshot button. Deliberately a separate file
// from preview-page.js — that one is executed by tests/auto-source.test.js in
// a bare vm with no document/navigator, so everything that exists purely to
// drive the DOM lives here, where the page is guaranteed to be real.
// `$`, `apiFetch`, `mjConfig` and `mjGet` are globals from main.js.
(function () {
	// Two of these are shared with camera.cgi's Live adjustments stage,
	// which builds its chrome client-side and so has no elements at load time.
	// They are published before the early return below for exactly that reason.
	// What is NOT shared is the bar's auto-hide: on that panel the bar carries
	// the night/IR/lamp indicators, which are state you have to be able to read
	// without waving a mouse at the picture first.
	window.MajesticHero = {
		// Fullscreen on the STAGE rather than the video element, so the bar and
		// everything else overlaid on the picture comes along. Hidden where the
		// API is missing (iOS Safari) rather than shown and broken.
		//
		// Returns a disposer, because the listener is on `document` but closes
		// over one stage and one button. The Live page wires this once per load
		// and can ignore it; the settings stage is rebuilt on every visit to the
		// leaf, so without taking the listener back off, each visit would leave
		// another callback behind holding a detached stage.
		wireFullscreen: function (stage, btn) {
			if (!stage || !btn || !stage.requestFullscreen || !document.fullscreenEnabled) return null;
			btn.hidden = false;
			btn.addEventListener('click', () => {
				if (document.fullscreenElement) document.exitFullscreen();
				else stage.requestFullscreen().catch(() => {});
			});
			const onChange = () => {
				const on = document.fullscreenElement === stage;
				btn.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Fullscreen');
				btn.title = on ? 'Exit fullscreen' : 'Fullscreen';
			};
			document.addEventListener('fullscreenchange', onChange);
			return function () { document.removeEventListener('fullscreenchange', onChange); };
		},

		// Snapshot: the camera's own /image.jpg, not a capture of the <video> —
		// full sensor resolution, whatever size the player happens to be drawn
		// at. That endpoint is the JPEG channel, so the button only appears when
		// that channel is on.
		wireSnapshot: function (btn) {
			if (!btn) return;
			mjConfig().then(cfg => {
				btn.hidden = mjGet(cfg, 'jpeg.enabled') !== true;
			});
			btn.addEventListener('click', () => {
				btn.disabled = true;
				apiFetch('/image.jpg', { credentials: 'same-origin', cache: 'no-store' })
					.then(r => { if (!r.ok) throw new Error(r.status); return r.blob(); })
					.then(b => {
						const d = new Date(), p = n => String(n).padStart(2, '0');
						const name = 'snapshot-' + d.getFullYear() + p(d.getMonth() + 1) +
							p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) +
							p(d.getSeconds()) + '.jpg';
						const url = URL.createObjectURL(b);
						const a = document.createElement('a');
						a.href = url;
						a.download = name;
						a.click();
						// Revoked on a delay: revoking synchronously races the
						// download in some browsers.
						setTimeout(() => URL.revokeObjectURL(url), 5000);
					})
					.catch(() => {})
					.finally(() => { btn.disabled = false; });
			});
		},
	};

	const stage = $('#mj-stage'), bar = $('#mj-bar');
	if (!stage || !bar) return;

	// --- The bar and the PTZ pad share the bottom of the stage, and this is what
	// keeps them off each other. Both used to be placed against constants — the
	// pad at 3.25rem, the stats panel's ceiling at 5rem — and a constant is one
	// row of a bar that WRAPS. Measured at 390px the six groups this camera shows
	// want 855px against a 366px lane, so the bar is three rows there; the pad
	// draws over the bar, so it covered two of them (#318).
	//
	// Which of the two gives way depends on which dimension has room, and that is
	// the whole of the rule:
	//
	//   * Where the stage is tall enough to stack them, the pad rides ABOVE the
	//     bar's top row: --mj-bar-h, below. A portrait phone is this case —
	//     390x785 of stage, 200px of bar, and the pad clears it with 370 to
	//     spare.
	//   * Where it is not AND the stage is wider than it is tall, the pad stays
	//     in its corner and the BAR gives way sideways instead, reserving the
	//     pad's column (.mj-ptz-beside + --mj-ptz-w). A phone in landscape is
	//     this case and cannot be the other one: 301px of stage against a 211px
	//     zoom/focus cluster and a two-row bar do not stack in any arrangement —
	//     but the stage is 740 wide there, so the same groups take the same two
	//     rows in the lane that is left.
	//
	// Wider-than-tall is what says the second arrangement is affordable, and it
	// has to be asked: reserving 150px of a 320px stage leaves a lane narrower
	// than one group, and the bar answers by giving every group a row of its own
	// — measured at 320x568 with audio, 8 rows and 500px of bar over a 509px
	// stage. That is worse than the overlap it was trying to avoid, so a portrait
	// stage too small for either arrangement keeps the stacking and lets the
	// stylesheet's clamp hold the pad on screen (--mj-ptz-h).
	//
	// The question is asked of the bar's NATURAL height, which is why the class
	// comes off before the measurement rather than being toggled at the end:
	// reserving the column makes the bar taller, so a second pass that measured
	// the bar as the first pass left it would find even less room and keep the
	// answer alive after the stage had grown enough to make it wrong. The
	// arrangement would then depend on the order a window was resized in rather
	// than on the size it ended up. Removing and re-adding inside one callback
	// costs a second layout and paints nothing in between.
	//
	// The height published is to the top of the top ROW, not to the top of the
	// element: the bar's padding-top is the transparent end of its gradient, and
	// clearing that as well would push the pad a further 2rem up the picture for
	// nothing.
	//
	// Layout is when this runs, never the reveal: the bar fades in and out on
	// opacity, so its height is the same whether it is on screen or not, and
	// nothing keyed to it moves while somebody is holding the pad.
	const ptz = $('#mj-ptz');
	const GAP = 8;
	const stripHeight = () =>
		bar.clientHeight - (parseFloat(getComputedStyle(bar).paddingTop) || 0);
	const publishStrip = (strip) => {
		if (strip > 0) stage.style.setProperty('--mj-bar-h', strip.toFixed(2) + 'px');
	};
	const layoutChrome = () => {
		// offsetHeight rather than a class check: a camera with no PTZ at all
		// mounts nothing into #mj-ptz, and one whose ptz_caps drop the direction
		// pad mounts a shorter cluster than one that keeps it. With no pad there
		// is nothing to arrange — the stats panel still wants the strip's height.
		const padH = ptz ? ptz.offsetHeight : 0;
		if (!padH) {
			publishStrip(stripHeight());
			return;
		}
		stage.classList.remove('mj-ptz-beside');
		const natural = stripHeight();
		const beside = natural + GAP + padH > stage.clientHeight &&
			stage.clientWidth > stage.clientHeight;
		if (beside) stage.classList.add('mj-ptz-beside');
		publishStrip(beside ? stripHeight() : natural);
		// Published for the clamp that keeps the pad inside the stage whichever
		// arrangement is in force: pushed off the top it is not merely awkward,
		// it is unreachable — there is nothing to scroll.
		stage.style.setProperty('--mj-ptz-h', padH + 'px');
		stage.style.setProperty('--mj-ptz-w', ptz.offsetWidth + 'px');
	};
	layoutChrome();
	// The bar and the pad themselves, not the window: the groups the bar holds
	// are unhidden as the player learns what this camera has — a substream,
	// audio, a transport to offer — and preview-ptz.js mounts the pad when
	// j/ptz.cgi answers. Every one of those changes the arithmetic above with
	// the window standing still.
	if (typeof ResizeObserver === 'function') {
		try {
			const ro = new ResizeObserver(layoutChrome);
			ro.observe(bar);
			ro.observe(stage);
			if (ptz) ro.observe(ptz);
		} catch (e) {
			window.addEventListener('resize', layoutChrome);
		}
	} else {
		window.addEventListener('resize', layoutChrome);
	}

	// --- Bar visibility. CSS shows the bar on :hover (mouse) and
	// :focus-within (keyboard); this handles the rest: mouse movement keeps it
	// up briefly even when :hover is unreliable (e.g. straight after
	// fullscreen), and on touch — where hover does not exist — a tap on the
	// picture toggles it. Taps on the bar, the PTZ pad or the stats panel are
	// interactions with those, not requests to hide them.
	let hideTimer = null;
	function show(ms) {
		stage.classList.add('mj-show');
		clearTimeout(hideTimer);
		if (ms) hideTimer = setTimeout(() => stage.classList.remove('mj-show'), ms);
	}
	stage.addEventListener('pointermove', e => {
		if (e.pointerType === 'mouse') show(2500);
	});
	// A pan is not a tap. Dragging the picture (preview-zoom.js) begins with a
	// pointerdown on the stage as well, so the toggle waits for the pointer to
	// come back up and fires only if it barely moved — on the pointerdown it
	// flashed the bar at the start of every drag. 8px rather than 0 because a
	// finger never lifts from exactly where it landed.
	// A second finger cancels the tap outright, whatever the first one does. In
	// a pinch the finger that is not driving the zoom can easily stay inside
	// the 8px threshold, and lifting it would then toggle the bar as though
	// nobody had zoomed at all. Counted here rather than asked of
	// preview-zoom.js: the two hold their own pointer state, and a shared one
	// is a third thing to keep in step.
	let tapId = null, tapX = 0, tapY = 0, touching = 0;
	stage.addEventListener('pointerdown', e => {
		if (e.pointerType !== 'touch') return;
		touching++;
		if (touching > 1) tapId = null;
		if (e.target.closest('.mj-bar, .mj-ptz, #mj-stats, #mj-toasts')) return;
		if (touching > 1) return;
		tapId = e.pointerId;
		tapX = e.clientX;
		tapY = e.clientY;
	});
	stage.addEventListener('pointerup', e => {
		if (e.pointerType === 'touch') touching = Math.max(0, touching - 1);
		if (e.pointerId !== tapId) return;
		tapId = null;
		if (Math.abs(e.clientX - tapX) + Math.abs(e.clientY - tapY) > 8) return;
		if (stage.classList.contains('mj-show')) {
			stage.classList.remove('mj-show');
			clearTimeout(hideTimer);
		} else {
			show(4000);
		}
	});
	stage.addEventListener('pointercancel', e => {
		if (e.pointerType === 'touch') touching = Math.max(0, touching - 1);
		if (e.pointerId === tapId) tapId = null;
	});

	window.MajesticHero.wireFullscreen(stage, $('#mj-fs'));
	window.MajesticHero.wireSnapshot($('#mj-snap'));
})();
