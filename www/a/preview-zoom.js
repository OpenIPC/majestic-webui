// The Live page's view rule: how the stream's frame is fitted to a stage that
// is now the whole window, and how you reach the part of it that does not fit.
//
// The page used to answer this with CSS alone -- the stage reserved the
// stream's aspect ratio and `object-fit: contain` letterboxed inside it -- and
// that is still what happens if this file fails to load. What it could not do
// is cover the window: on a 2560x1440 monitor a 4:3 sensor was drawn at 1264 x
// 948, a third of the screen, with the rest of it black or empty page. Three
// presets and a pan replace the one behaviour:
//
//   Fill   scale = max(sw/fw, sh/fh)   covers the window; the long axis pans
//   Fit    scale = min(sw/fw, sh/fh)   the whole frame, letterboxed
//   1:1    scale = 1                   real pixels, for judging focus
//
// Deliberately a separate file from preview-page.js, for the same reason
// preview-hero.js is one: that file is executed by tests/auto-source.test.js
// and tests/staging.test.js in a bare vm with no document, so everything whose
// whole job is to drive the DOM lives here, where the page is real. What
// preview-page.js knows about this module is two guarded calls.
//
// `$` is a global from main.js.
(function () {
	const stage = $('#mj-stage');
	if (!stage) return;

	// The person's explicit choice, permanent -- the same contract as
	// mj-transport-pick, and for the same reason it is a single key: nothing
	// here demotes the view behind their back, so there is no second key
	// carrying an expiry and no way for a fallback to be mistaken for a
	// decision. A free zoom is not written: it is a gesture, not a choice.
	const KEY = 'mj-view-pick';
	const MODES = ['fit', 'fill', 'one'];
	const RADIOS = { fit: '#mj-view-fit', fill: '#mj-view-fill', one: '#mj-view-one' };
	// Where a press belongs to the control under it rather than to the picture.
	const CHROME = '.mj-bar, .mj-ptz, #mj-stats, #mj-toasts';

	function read(k) {
		try { return localStorage.getItem(k); } catch (e) { return null; }
	}
	function write(k, v) {
		try { localStorage.setItem(k, v); } catch (e) {}
	}
	function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

	let frame = null;      // {w, h} of the stream, once the codec is known
	let mode = 'fill';     // 'fit' | 'fill' | 'one' | 'free'
	let scale = 1;         // the scale in force
	let ox = 0, oy = 0;    // the picture's left/top inside the stage
	let placed = false;    // has a layout run against a known frame
	let onScale = null;    // who to tell when the scale moves

	const saved = read(KEY);
	if (MODES.indexOf(saved) >= 0) mode = saved;
	// The preset a free zoom falls back to. It has to track setMode(), not the
	// value read at startup: pick Fit, pinch, then change channel, and the
	// startup value would put you back on whatever you were using yesterday.
	let lastPreset = mode;

	// The chip prints the scale, and the scale moves without the player saying
	// anything — a preset, a pinch, a window resize. Over MSE the codec is
	// reported once when the connection opens, so a chip repainted only by
	// player events would carry the opening percentage for the whole session.
	function announce(prev) {
		if (onScale && prev !== scale) {
			try { onScale(); } catch (e) {}
		}
	}

	// ---- laying the picture out -------------------------------------------

	// The media elements are re-queried every time rather than held: the MSE
	// player replaces its <video> on every open and every reconnect, so a
	// stored reference is a detached node within a session -- the same trap the
	// transport swap hit.
	function place(picW, picH) {
		const els = stage.querySelectorAll('.mj-stage-media');
		for (let i = 0; i < els.length; i++) {
			const s = els[i].style;
			// inset:0 from the stylesheet is the no-JS fallback; it has to go
			// before pixels mean anything on all four sides.
			s.inset = 'auto';
			s.left = ox.toFixed(2) + 'px';
			s.top = oy.toFixed(2) + 'px';
			s.width = picW.toFixed(2) + 'px';
			s.height = picH.toFixed(2) + 'px';
		}
	}

	// Where the chrome that ANNOTATES the picture goes -- the chip, the stats
	// panel, the two toasts -- as CSS custom properties the stylesheet adds to
	// its own insets. Not the bar and not the PTZ pad: those are the player's
	// furniture, and furniture that jumps when you change zoom is worse than
	// furniture on a black band.
	//
	// Only called when the picture's SIZE changes, never on a pan: a picture
	// small enough to leave a band cannot be panned in the first place, so
	// panning never moves these.
	function annotate(sw, sh, picW, picH) {
		// Measured off the chip itself rather than guessed at, because its
		// width is its text -- "H265 3840×2160 · 25 fps · 67%" against "MJPEG"
		// -- and its height is the page's font size.
		const badge = $('#mj-badge');
		const cw = (badge && badge.offsetWidth) || 210;
		const ch = (badge && badge.offsetHeight) || 30;
		// Published for the toast stack, which hangs under the chip: the chip's
		// height is not a constant -- "MJPEG" against "H265 3840×2160 · 25 fps ·
		// 36% · Sub stream", which wraps to two lines on a phone -- so a toast
		// at a fixed offset from the top of the stage is either crowding it or
		// sitting on it.
		if (ch) stage.style.setProperty('--mj-chip-h', ch + 'px');
		const visW = Math.min(sw, picW), visH = Math.min(sh, picH);
		// A picture too small to carry the chip without the chip dominating it
		// hands the chrome back to the stage: a 390 x 219 phone in Fit, where
		// the chip is nearly half the width and there is 283px of band doing
		// nothing. It is the picture being too small that moves it -- never the
		// band merely existing, which is why 1841 x 1381 with 359px of gutter
		// keeps its chip on the picture.
		const roomy = visW >= cw * 3 && visH >= ch * 5;
		const set = (name, px) => stage.style.setProperty(name, (roomy ? Math.max(0, px) : 0) + 'px');
		set('--mj-pic-top', oy);
		set('--mj-pic-left', ox);
		set('--mj-pic-right', sw - (ox + picW));
	}

	// What a drag on the picture means, as two classes: the stylesheet reads
	// them for the cursor and the pointer handler reads them for the gesture.
	// They are mutually exclusive by construction, which is the whole idea --
	// a picture with nothing hidden has nothing to pan, so the drag is free,
	// and the useful thing to do with it is draw a rectangle to zoom into.
	// That is what makes Fit the state you can react from: see something
	// happen, drag a box round it, and you are on it, no control to visit
	// first. Where the picture DOES overflow the drag is the pan, and the Area
	// button is how you ask for a rectangle instead.
	function setAffordance(sw, sh, picW, picH) {
		const pannable = picW > sw + 1 || picH > sh + 1;
		stage.classList.toggle('mj-pannable', pannable);
		stage.classList.toggle('mj-drawable', placed && !pannable);
	}

	function layout() {
		const sw = stage.clientWidth, sh = stage.clientHeight;
		if (!frame || !frame.w || !frame.h || !sw || !sh) return;

		const kFit = Math.min(sw / frame.w, sh / frame.h);
		const kFill = Math.max(sw / frame.w, sh / frame.h);

		// What the middle of the window was looking at, in frame coordinates,
		// so that changing the scale keeps the same part of the scene under it
		// instead of throwing the view back to a corner.
		let cx = 0.5, cy = 0.5;
		if (placed && scale > 0) {
			cx = (sw / 2 - ox) / (frame.w * scale);
			cy = (sh / 2 - oy) / (frame.h * scale);
		}

		const prev = scale;
		scale = mode === 'fit' ? kFit
			: mode === 'one' ? 1
			: mode === 'free' ? clamp(scale, zoomFloor(kFit), zoomCeiling(kFill))
			: kFill;

		const picW = frame.w * scale, picH = frame.h * scale;
		ox = picW <= sw ? (sw - picW) / 2 : clamp(sw / 2 - cx * picW, sw - picW, 0);
		oy = picH <= sh ? (sh - picH) / 2 : clamp(sh / 2 - cy * picH, sh - picH, 0);
		placed = true;

		place(picW, picH);
		annotate(sw, sh, picW, picH);
		setAffordance(sw, sh, picW, picH);
		announce(prev);
	}

	// Free zoom is bounded by what is worth looking at. Out: no further than
	// the whole frame, or native when the frame is smaller than the stage --
	// past either it is only black. In: 3x native, EXCEPT that Fill itself can
	// need more than that (a 704x576 substream on a 1440p monitor is 364%), and
	// a bound below the preset in force would drag the picture back the moment
	// you touched it. Not `kFill * 3`: that read the enlargement Fill already
	// needed as the thing to triple, and offered 1092% on that substream.
	function zoomFloor(kFit) { return Math.min(kFit, 1); }
	function zoomCeiling(kFill) { return Math.max(kFill, 3); }

	function panBy(dx, dy) {
		if (!frame || !placed) return;
		const sw = stage.clientWidth, sh = stage.clientHeight;
		const picW = frame.w * scale, picH = frame.h * scale;
		if (picW > sw) ox = clamp(ox + dx, sw - picW, 0);
		if (picH > sh) oy = clamp(oy + dy, sh - picH, 0);
		place(picW, picH);
	}

	// Zoom to a rectangle drawn on the picture. The scale falls out of the
	// rectangle rather than being chosen, which is the point: a pinch is a
	// trackpad gesture and a mouse has no equivalent, and neither of them lets
	// you say WHICH part of the scene you meant.
	//
	// The rectangle is converted to frame coordinates first. Stage pixels mean
	// nothing across a scale change, and the scale is about to change.
	function zoomToRect(rx, ry, rw, rh) {
		if (!frame || !placed || rw <= 0 || rh <= 0) return;
		const sw = stage.clientWidth, sh = stage.clientHeight;
		const fx = (rx - ox) / scale, fy = (ry - oy) / scale;
		const fw = rw / scale, fh = rh / scale;

		const kFit = Math.min(sw / frame.w, sh / frame.h);
		const kFill = Math.max(sw / frame.w, sh / frame.h);
		// A little room around the selection, so what was asked for is not
		// flush against the edges of the window. Not much: drawing a rectangle
		// is a request for that rectangle, and the sibling project's 20% puts
		// a fifth of the screen back into context nobody asked to see.
		const PAD = 1.08;
		const prev = scale;
		scale = clamp(Math.min(sw / (fw * PAD), sh / (fh * PAD)),
			zoomFloor(kFit), zoomCeiling(kFill));
		mode = 'free';

		const picW = frame.w * scale, picH = frame.h * scale;
		// The selection's middle goes to the middle of the stage, then the
		// ordinary clamp pulls it back if that would show black. A rectangle
		// drawn in a corner therefore lands in that corner, not off the edge.
		const mx = fx + fw / 2, my = fy + fh / 2;
		ox = picW <= sw ? (sw - picW) / 2 : clamp(sw / 2 - mx * scale, sw - picW, 0);
		oy = picH <= sh ? (sh - picH) / 2 : clamp(sh / 2 - my * scale, sh - picH, 0);

		place(picW, picH);
		annotate(sw, sh, picW, picH);
		setAffordance(sw, sh, picW, picH);
		syncRadios();
		announce(prev);
	}

	// Zoom about a point on the screen -- the pointer, or the midpoint between
	// two fingers -- so what is under them stays under them.
	function zoomAt(factor, clientX, clientY) {
		if (!frame || !placed) return;
		const sw = stage.clientWidth, sh = stage.clientHeight;
		const r = stage.getBoundingClientRect();
		const px = clientX - r.left, py = clientY - r.top;
		const fx = (px - ox) / (frame.w * scale), fy = (py - oy) / (frame.h * scale);

		const kFit = Math.min(sw / frame.w, sh / frame.h);
		const kFill = Math.max(sw / frame.w, sh / frame.h);
		const next = clamp(scale * factor, zoomFloor(kFit), zoomCeiling(kFill));
		if (next === scale) return;
		const prev = scale;
		scale = next;
		mode = 'free';

		const picW = frame.w * scale, picH = frame.h * scale;
		ox = picW <= sw ? (sw - picW) / 2 : clamp(px - fx * picW, sw - picW, 0);
		oy = picH <= sh ? (sh - picH) / 2 : clamp(py - fy * picH, sh - picH, 0);

		place(picW, picH);
		annotate(sw, sh, picW, picH);
		setAffordance(sw, sh, picW, picH);
		syncRadios();
		announce(prev);
	}

	// ---- the control -------------------------------------------------------

	function syncRadios() {
		MODES.forEach((m) => {
			const el = $(RADIOS[m]);
			// .checked directly, never a dispatched change: this reflects a
			// decision already taken, and firing the event would re-enter
			// setMode and write a choice nobody made.
			if (el) el.checked = (m === mode);
		});
	}

	function setMode(m) {
		mode = m;
		lastPreset = m;
		write(KEY, m);
		syncRadios();
		layout();
	}

	// The stream's real pixel size. A change of channel lands here too, and it
	// drops a free zoom back to the preset chosen most recently: a scale
	// arrived at by pinching a 3840-wide frame means nothing against a
	// 704-wide one.
	function setFrame(w, h) {
		if (!w || !h) return;
		const changed = !frame || frame.w !== w || frame.h !== h;
		frame = { w: w, h: h };
		if (changed && mode === 'free') {
			mode = lastPreset;
			syncRadios();
		}
		layout();
	}

	// The MJPEG fallback is a different picture with its own resolution --
	// jpeg.size is configured separately from video0.size -- and place() sizes
	// every media element from one frame. Without this the fallback inherits
	// the box computed for the video stream that just failed, so Fill leaves
	// black bars and panning reaches places the image does not occupy. The
	// stream is multipart and fires load per frame in some browsers, hence the
	// dimension guard; hidden means preview-page.js has taken the stage back.
	const mjpeg = $('#live-mjpeg');
	if (mjpeg) {
		mjpeg.addEventListener('load', () => {
			if (mjpeg.style.display === 'none') return;
			setFrame(mjpeg.naturalWidth, mjpeg.naturalHeight);
		});
	}

	MODES.forEach((m) => {
		const el = $(RADIOS[m]);
		if (el) el.addEventListener('change', () => { if (el.checked) setMode(m); });
	});

	// Unhidden only now: without this file the group would be three radios that
	// do nothing, and the page is correct (and Fit) without it.
	const ctl = $('#mj-view-ctl');
	if (ctl) ctl.hidden = false;
	const areaCtl = $('#mj-area-ctl');
	if (areaCtl) areaCtl.hidden = false;
	syncRadios();

	// ---- gestures ----------------------------------------------------------

	// Pointer bookkeeping, because pinch needs two of them and a drag needs to
	// know it is alone. A press that lands on the bar, the pad or a panel is an
	// interaction with that control and never enters here -- preview-ptz.js
	// takes pointer capture on its buttons, but this listener is on the stage
	// and would otherwise see the event on the way up.
	const pts = new Map();
	let pinchDist = 0, pinchX = 0, pinchY = 0;
	let lastType = 'mouse';

	// Zoom-to-area. `armed` is the button's state; `band` is the drag in
	// progress, in stage coordinates.
	const areaBtn = $('#mj-area'), band = $('#mj-marquee');
	let armed = false, drawing = null;

	function setArmed(on) {
		armed = !!on && !!band;
		drawing = null;
		if (band) band.hidden = true;
		stage.classList.toggle('mj-armed', armed);
		// The checkbox is the control's state, so it is written rather than
		// asked -- Esc and the end of a drag both disarm without touching it.
		if (areaBtn && areaBtn.checked !== armed) areaBtn.checked = armed;
	}
	if (areaBtn) areaBtn.addEventListener('change', () => setArmed(areaBtn.checked));

	function bandRect(e) {
		const r = stage.getBoundingClientRect();
		const x = clamp(e.clientX - r.left, 0, r.width), y = clamp(e.clientY - r.top, 0, r.height);
		return {
			x: Math.min(drawing.x, x), y: Math.min(drawing.y, y),
			w: Math.abs(x - drawing.x), h: Math.abs(y - drawing.y),
		};
	}

	stage.addEventListener('pointerdown', (e) => {
		lastType = e.pointerType;
		if (e.button != null && e.button > 0) return;
		if (e.target.closest && e.target.closest(CHROME)) return;

		// Armed, or simply nothing to pan: either way the drag draws.
		if (armed || stage.classList.contains('mj-drawable')) {
			const r = stage.getBoundingClientRect();
			drawing = { x: e.clientX - r.left, y: e.clientY - r.top };
			try { stage.setPointerCapture(e.pointerId); } catch (err) {}
			return;
		}

		pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pts.size === 1 && stage.classList.contains('mj-pannable')) {
			try { stage.setPointerCapture(e.pointerId); } catch (err) {}
			stage.classList.add('mj-panning');
		}
		if (pts.size === 2) pinchDist = 0;
	});

	stage.addEventListener('pointermove', (e) => {
		if (drawing) {
			const b = bandRect(e);
			band.hidden = false;
			band.style.left = b.x + 'px';
			band.style.top = b.y + 'px';
			band.style.width = b.w + 'px';
			band.style.height = b.h + 'px';
			return;
		}
		const p = pts.get(e.pointerId);
		if (!p) return;
		const dx = e.clientX - p.x, dy = e.clientY - p.y;
		p.x = e.clientX; p.y = e.clientY;

		if (pts.size >= 2) {
			const it = pts.values(), a = it.next().value, b = it.next().value;
			const d = Math.hypot(a.x - b.x, a.y - b.y);
			const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
			if (pinchDist > 0 && d > 0) {
				zoomAt(d / pinchDist, mx, my);
				panBy(mx - pinchX, my - pinchY);
			}
			pinchDist = d; pinchX = mx; pinchY = my;
			return;
		}
		panBy(dx, dy);
	});

	function endPointer(e) {
		if (drawing) {
			const b = bandRect(e);
			try { stage.releasePointerCapture(e.pointerId); } catch (err) {}
			// A rectangle has to be deliberate. Below this it is a slip or a
			// click, and zooming 40x into a stray 3px drag is the worst
			// possible answer to one. The floor is a share of the stage with
			// an absolute minimum, so it means the same thing on a 2560px
			// monitor and a 390px phone.
			const minW = Math.max(16, stage.clientWidth * 0.02);
			const minH = Math.max(16, stage.clientHeight * 0.02);
			if (b.w >= minW && b.h >= minH) zoomToRect(b.x, b.y, b.w, b.h);
			// One drag, then it disarms itself: a mode you can forget you are
			// in is the wrong thing to leave over a picture that also steers a
			// camera.
			setArmed(false);
			return;
		}
		pts.delete(e.pointerId);
		if (pts.size < 2) pinchDist = 0;
		if (!pts.size) {
			stage.classList.remove('mj-panning');
			try { stage.releasePointerCapture(e.pointerId); } catch (err) {}
		}
	}
	stage.addEventListener('pointerup', endPointer);
	stage.addEventListener('pointercancel', endPointer);

	// The wheel zooms, about the pointer. It used to pan the overflowing axis,
	// which is what a Mac trackpad's two fingers want -- but a mouse wheel is
	// the only zoom a Windows or Linux viewer has without knowing that
	// ctrl+wheel is a thing, and the same input cannot mean pan on a picture
	// that overflows and zoom on one that does not without changing meaning
	// under the hand mid-gesture. Panning is the drag, on every platform and on
	// touch. ctrl+wheel is kept because that is what a trackpad pinch sends.
	stage.addEventListener('wheel', (e) => {
		if (e.target.closest && e.target.closest(CHROME)) return;
		zoomAt(Math.exp(-e.deltaY / (e.ctrlKey ? 300 : 500)), e.clientX, e.clientY);
		e.preventDefault();
	}, { passive: false });

	// The gesture people try first. Pointer only: on a touch screen the first
	// of the two taps has already toggled the control bar, and a control that
	// answers to half of somebody else's gesture is worse than one that does
	// not answer at all. The View group is the touch answer.
	stage.addEventListener('dblclick', (e) => {
		if (lastType === 'touch') return;
		if (e.target.closest && e.target.closest(CHROME)) return;
		setMode(mode === 'fill' ? 'fit' : 'fill');
	});

	// Arrows steer on a camera that has a pad -- that contract predates this
	// file and keeps the plain keys. Where there is no pad they are free, so
	// they pan; on a PTZ camera shift is what asks for the picture instead.
	// Asked at event time, not at load: the pad is mounted by preview-ptz.js.
	const KEYS = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [1, 0], ArrowRight: [-1, 0] };
	function hasPad() {
		const m = $('#mj-ptz');
		return !!(m && m.querySelector('.mj-ptz-pad'));
	}
	stage.addEventListener('keydown', (e) => {
		if (e.target !== stage) return;
		const d = KEYS[e.key];
		if (!d) return;
		if (hasPad() && !e.shiftKey) return;
		if (!stage.classList.contains('mj-pannable')) return;
		e.preventDefault();
		panBy(d[0] * 80, d[1] * 80);
	});

	// Escape is the way back out, and it is on the document rather than the
	// stage because arming is the closest thing this page has to a mode: it has
	// to be cancellable from wherever the pointer went after the button was
	// pressed. Armed, it disarms; free-zoomed, it returns to the preset in
	// force -- which is what the View group would do, one key instead of aiming
	// at a control that auto-hides. In fullscreen the browser takes the key
	// first and this never runs, which is the right precedence.
	document.addEventListener('keydown', (e) => {
		if (e.key !== 'Escape') return;
		if (armed) { setArmed(false); return; }
		if (mode === 'free') setMode(lastPreset);
	});

	// ---- what the page tells this module -----------------------------------

	window.MajesticZoom = {
		// The stream's real pixel size, from the player's codec report.
		setFrame: setFrame,

		// Called whenever the scale moves for a reason the player does not know
		// about — a preset, a pinch, a resize. preview-page.js repaints the
		// chip from it.
		onScale: function (fn) { onScale = fn; },

		// For the chip, which prints it: Fill covers the window by enlarging
		// the picture when the stream is smaller than the screen -- a 1080p
		// main on a 1440p monitor is drawn at 133% -- and nobody should be left
		// to conclude the camera went soft. 0 means "no frame yet", which the
		// caller renders as nothing rather than as 0%.
		scalePct: function () { return frame && placed ? Math.round(scale * 100) : 0; },

		// The chip's own width decides whether the chrome fits on the picture,
		// so a repaint of the chip can change the answer.
		refresh: function () {
			const sw = stage.clientWidth, sh = stage.clientHeight;
			if (frame && placed && sw && sh) annotate(sw, sh, frame.w * scale, frame.h * scale);
		},
	};

	// The stage, not the window: fullscreen resizes it without the viewport
	// moving, and so does a banner appearing above it.
	if (typeof ResizeObserver === 'function') {
		try { new ResizeObserver(layout).observe(stage); } catch (e) {
			window.addEventListener('resize', layout);
		}
	} else {
		window.addEventListener('resize', layout);
	}
})();
