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

	const saved = read(KEY);
	if (MODES.indexOf(saved) >= 0) mode = saved;

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

		// Free zoom is bounded by what is worth looking at: no further out than
		// the whole frame (or native, when the frame is smaller than the stage
		// -- past that it is only black), no further in than 3x native. The
		// presets are not clamped, because 1:1 means 1:1.
		scale = mode === 'fit' ? kFit
			: mode === 'one' ? 1
			: mode === 'free' ? clamp(scale, Math.min(kFit, 1), Math.max(kFill, 1) * 3)
			: kFill;

		const picW = frame.w * scale, picH = frame.h * scale;
		ox = picW <= sw ? (sw - picW) / 2 : clamp(sw / 2 - cx * picW, sw - picW, 0);
		oy = picH <= sh ? (sh - picH) / 2 : clamp(sh / 2 - cy * picH, sh - picH, 0);
		placed = true;

		place(picW, picH);
		annotate(sw, sh, picW, picH);
		stage.classList.toggle('mj-pannable', picW > sw + 1 || picH > sh + 1);
	}

	function panBy(dx, dy) {
		if (!frame || !placed) return;
		const sw = stage.clientWidth, sh = stage.clientHeight;
		const picW = frame.w * scale, picH = frame.h * scale;
		if (picW > sw) ox = clamp(ox + dx, sw - picW, 0);
		if (picH > sh) oy = clamp(oy + dy, sh - picH, 0);
		place(picW, picH);
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
		const next = clamp(scale * factor, Math.min(kFit, 1), Math.max(kFill, 1) * 3);
		if (next === scale) return;
		scale = next;
		mode = 'free';

		const picW = frame.w * scale, picH = frame.h * scale;
		ox = picW <= sw ? (sw - picW) / 2 : clamp(px - fx * picW, sw - picW, 0);
		oy = picH <= sh ? (sh - picH) / 2 : clamp(py - fy * picH, sh - picH, 0);

		place(picW, picH);
		annotate(sw, sh, picW, picH);
		stage.classList.toggle('mj-pannable', picW > sw + 1 || picH > sh + 1);
		syncRadios();
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
		write(KEY, m);
		syncRadios();
		layout();
	}

	MODES.forEach((m) => {
		const el = $(RADIOS[m]);
		if (el) el.addEventListener('change', () => { if (el.checked) setMode(m); });
	});

	// Unhidden only now: without this file the group would be three radios that
	// do nothing, and the page is correct (and Fit) without it.
	const ctl = $('#mj-view-ctl');
	if (ctl) ctl.hidden = false;
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

	stage.addEventListener('pointerdown', (e) => {
		lastType = e.pointerType;
		if (e.button != null && e.button > 0) return;
		if (e.target.closest && e.target.closest(CHROME)) return;
		pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pts.size === 1 && stage.classList.contains('mj-pannable')) {
			try { stage.setPointerCapture(e.pointerId); } catch (err) {}
			stage.classList.add('mj-panning');
		}
		if (pts.size === 2) pinchDist = 0;
	});

	stage.addEventListener('pointermove', (e) => {
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
		pts.delete(e.pointerId);
		if (pts.size < 2) pinchDist = 0;
		if (!pts.size) {
			stage.classList.remove('mj-panning');
			try { stage.releasePointerCapture(e.pointerId); } catch (err) {}
		}
	}
	stage.addEventListener('pointerup', endPointer);
	stage.addEventListener('pointercancel', endPointer);

	// Wheel pans; ctrl+wheel zooms, which is also what a trackpad pinch sends.
	// preventDefault only where the gesture was actually taken, so a browser
	// that would have done something useful with it still can.
	stage.addEventListener('wheel', (e) => {
		if (e.target.closest && e.target.closest(CHROME)) return;
		if (e.ctrlKey) {
			zoomAt(Math.exp(-e.deltaY / 300), e.clientX, e.clientY);
			e.preventDefault();
			return;
		}
		if (!stage.classList.contains('mj-pannable')) return;
		panBy(-e.deltaX, -e.deltaY);
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

	// ---- what the page tells this module -----------------------------------

	window.MajesticZoom = {
		// The stream's real pixel size, from the player's codec report. A
		// change of channel lands here too, and it drops a free zoom back to
		// the remembered preset: a scale chosen by pinching a 3840-wide frame
		// means nothing against a 704-wide one.
		setFrame: function (w, h) {
			if (!w || !h) return;
			const changed = !frame || frame.w !== w || frame.h !== h;
			frame = { w: w, h: h };
			if (changed && mode === 'free') {
				mode = MODES.indexOf(saved) >= 0 ? saved : 'fill';
				syncRadios();
			}
			layout();
		},

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
