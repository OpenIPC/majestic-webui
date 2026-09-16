// The camera spends its bits on whatever you have zoomed in on.
//
// An encoder spreads its budget evenly over the frame, so a face or a number
// plate filling two per cent of the picture gets about two per cent of the
// bits -- and rate control smooths away exactly the high-frequency detail the
// glyphs are made of. Zooming in does not help by itself: the browser is
// magnifying pixels that were already thrown away. What helps is telling the
// ENCODER, which every vendor's silicon has been able to do for years and
// which majestic never asked it to do.
//
// So there is nothing to press. Zoom into part of the picture and that part
// becomes an encoder region, at a lower quantiser than the rest; zoom back out
// and it goes away again. The rectangle is simply what is on screen, which is
// the one rectangle the viewer has already told the page they care about.
//
// Measured on a hi3516ev300 against a building facade: +7 to +10% of
// high-frequency detail inside the region. It is not a large number and it is
// not supposed to be -- nothing can give the region detail the sensor did not
// capture. What it removes is the compression mush on top of it.
//
// WHAT IT COSTS. The encoder does not get a bigger budget: what the region
// gains, the rest of the picture loses. On the same camera at 4 Mbps the
// background moved -0.6%, at 1 Mbps -5.9% for the same gain -- so how much it
// costs depends on how much spare bitrate the stream has, which is why the
// strength below is chosen from that rather than fixed.
//
// AND IT IS NOT PRIVATE. This changes the encoded stream, so it reaches every
// viewer, every NVR and the recording. That is the reason to prefer it over a
// private view -- the plate is in the clip you download tomorrow -- and it is
// why the status chip says so while it is in force. There is no control, but
// there is a statement: a page that quietly re-tuned the recording would be
// the worse trade.
//
// Nothing is saved. The regions go to /api/v1/live, which applies without
// writing majestic.yaml, and are taken back when the view opens out, when the
// tab is hidden and on the way off the page.
//
// `$`, `apiFetch`, `mjConfig`, `mjGet` and `mjMetricsSubscribe` are globals
// from main.js. A separate file from preview-page.js for the same reason
// preview-zoom.js is one: that file is executed by tests/auto-source.test.js
// and tests/staging.test.js in a bare vm with no document.
window.MajesticRoi = (function () {
	'use strict';

	const RGN = window.MajesticRegion;
	const ZOOM = window.MajesticZoom;
	// Without the view or the coordinate map there is no rectangle to send and
	// no way to place it on the other channels. The page is then exactly what
	// it was before this file existed. The stage is not tested for separately:
	// preview-zoom.js publishes nothing without one, so `ZOOM` IS that test.
	if (!RGN || !ZOOM || !ZOOM.onView) return { note: () => null };

	// How much of the frame has to be off screen before a region is worth
	// marking. A region covering most of the picture competes with itself: the
	// encoder has one budget and marking four fifths of it just moves a little
	// from the last fifth.
	//
	// Two thresholds, not one. A single one flaps: a pan at the boundary would
	// engage and release and engage again, re-programming the encoder each
	// time, and the picture would visibly pulse.
	const ENGAGE = 0.55;   // engage below this share of the frame on screen
	const RELEASE = 0.72;  // and hold until above this

	// How hard to push, chosen from how much room the stream has.
	//
	// Measured rather than guessed, and the direction is the opposite of the
	// intuitive one: the GAIN is the same either way (+7.2% at 4 Mbps and at
	// 1 Mbps on the same camera), so what the headroom decides is not what the
	// region gets but what the rest of the picture pays. With room to spare the
	// background barely noticed; at the ceiling it gave up 5.9%. So push
	// hardest where it is nearly free, and gently where every bit is taken from
	// somewhere else.
	//
	// -16 is where the curve flattens: -51 was worth another 0.8 of a per cent.
	// There is no point offering numbers past it.
	const STEPS = [
		{ used: 0.55, qp: -16 },
		{ used: 0.85, qp: -12 },
		{ used: Infinity, qp: -8 },
	];
	// Before a rate has been measured: the middle step. The gentle end would
	// under-serve a camera with room, and the hard end would take bits from one
	// that has none, on a guess.
	const UNKNOWN_QP = -12;

	// Long enough that a pan is one push rather than thirty, short enough that
	// letting go of the picture and looking at it feels immediate.
	const SETTLE_MS = 350;

	let supported = false;   // the camera declares the keys
	let channels = [];       // the encoders to mark, in majestic's numbering
	let engaged = false;     // is a region in force right now
	let sent = null;         // the rectangle last pushed, in frame pixels
	let timer = null;
	let rate = null;         // measured kbps of the channel on screen
	let hidden = false;      // the tab is in the background

	// ---- what the camera can do -------------------------------------------

	// The keys exist only on a camera whose encoder can program regions --
	// majestic declares them from the backend's own answer -- so their presence
	// in the configuration IS the capability, and it costs nothing to ask: the
	// Live page has already fetched this.
	mjConfig().then((cfg) => {
		if (mjGet(cfg, 'video0.roiRect') === undefined) return;
		for (let n = 0; n < 2; n++)
			if (mjGet(cfg, 'video' + n + '.enabled') !== false) channels.push(n);
		supported = channels.length > 0;
	});

	// ---- where the picture is, in the camera's own terms -------------------

	// What each channel shows of the sensor's frame. Null where the camera has
	// not said -- an older daemon 404s this -- and the caller then falls back
	// to the plain ratio, which is right exactly when no stream is cropped.
	let rects = null, rectsAsked = false;
	function readRects() {
		if (rectsAsked) return Promise.resolve(rects);
		rectsAsked = true;
		return apiFetch('/api/v1/osd', { credentials: 'same-origin' })
			.then(r => r.ok ? r.json() : Promise.reject(r.status))
			.then((j) => { rects = (j && j.group && j.streams) ? j : null; return rects; })
			.catch(() => { rects = null; return rects; });
	}

	function shownStream() {
		return window.MajesticLiveStream ? (window.MajesticLiveStream() | 0) : 0;
	}

	function frameOf(n) {
		if (!rects) return null;
		for (let i = 0; i < rects.streams.length; i++) {
			const s = rects.streams[i];
			if (s.stream === n) return { w: s.frame[0], h: s.frame[1] };
		}
		return null;
	}

	// One rectangle, from the channel it was measured on to the channel that is
	// about to be told about it. The map is mj-region.js's -- one stream's
	// pixels back to the sensor's frame by its own crop, forward again by the
	// other's -- asked here with "the channel being shown" where it says
	// "main", because that is the space this rectangle is written in.
	function forChannel(r, from, to) {
		if (from === to) return r;
		const m = rects && RGN.view(rects.group, rects.streams, from, to);
		if (!m) {
			// Nothing said about crops. The honest fallback is the ratio of the
			// two frames, exactly right while neither is cropped, and the same
			// thing the settings page falls back to.
			const f = frameOf(from), t = frameOf(to);
			if (!f || !t) return null;
			const kx = t.w / f.w, ky = t.h / f.h;
			return { x: r.x * kx, y: r.y * ky, w: r.w * kx, h: r.h * ky };
		}
		return {
			x: m.k.x * r.x + m.o.x, y: m.k.y * r.y + m.o.y,
			w: m.k.x * r.w, h: m.k.y * r.h,
		};
	}

	// ---- how hard to push --------------------------------------------------

	let ceiling = null;
	mjConfig().then((cfg) => {
		const b = mjGet(cfg, 'video' + shownStream() + '.bitrate');
		ceiling = typeof b === 'number' ? b : null;
	});

	mjMetricsSubscribe((s) => {
		if (!s || !s.ok || !s.m || !s.prev) { rate = null; return; }
		const k = 'venc' + shownStream() + '_rcvd_bytes';
		const now = s.m.v[k], was = s.prev.v[k];
		// `dt` and not the difference of the two `t`s: `t` is the CAMERA's wall
		// clock, which NTP steps and which a camera with no battery starts from
		// 1970 -- a step across two samples would mint a rate of several
		// gigabits or a negative one. `dt` is the browser's monotonic interval
		// between the same two polls, and is null on the first of them.
		const dt = s.dt;
		// A counter that did not move, one that restarted with the daemon, or
		// no interval at all: not knowing is not a rate of zero, and a zero here
		// would read as an idle stream with bitrate to spare.
		if (now === undefined || was === undefined || !(dt > 0) || now < was) {
			rate = null;
			return;
		}
		rate = (now - was) * 8 / 1000 / dt;
	});

	function qp() {
		if (!(ceiling > 0) || rate === null) return UNKNOWN_QP;
		const used = rate / ceiling;
		for (let i = 0; i < STEPS.length; i++)
			if (used < STEPS[i].used) return STEPS[i].qp;
		return STEPS[STEPS.length - 1].qp;
	}

	// ---- pushing -----------------------------------------------------------

	function push(r) {
		const from = shownStream();
		const body = {};
		for (let i = 0; i < channels.length; i++) {
			const n = channels[i];
			if (!r) {
				// The empty string, not an empty list: it means "put back what
				// is configured", which is what takes a live region away. A
				// list of no rectangles would instead clear regions somebody
				// saved.
				body['video' + n] = { roiRect: '', roiQp: '' };
				continue;
			}
			const m = forChannel(r, from, n);
			// A channel the camera would not describe is one this cannot place
			// a rectangle on. Skipped rather than guessed at -- a guess lands
			// the bits on the wrong part of the scene and nothing would say so.
			if (!m) continue;
			body['video' + n] = {
				roiRect: [
					Math.max(0, Math.round(m.x)), Math.max(0, Math.round(m.y)),
					Math.max(1, Math.round(m.w)), Math.max(1, Math.round(m.h)),
				].join('x'),
				roiQp: String(qp()),
			};
		}
		if (!Object.keys(body).length) return Promise.resolve(false);
		return apiFetch('/api/v1/live', {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		})
			.then(rp => rp.ok ? rp.json().catch(() => ({})) : Promise.reject(rp.status))
			.then((j) => {
				// The camera names what it could not carry. A refusal is this
				// camera saying its encoder has no regions after all, so the
				// feature puts itself away for the rest of the visit rather
				// than asking again on every pan.
				if (j && j.refused) { supported = false; return false; }
				return true;
			})
			.catch(() => false);
	}

	function clear() {
		if (timer) { clearTimeout(timer); timer = null; }
		if (!engaged) return;
		engaged = false;
		sent = null;
		push(null);
		repaintChip();
	}

	// Worth another push? A pan of a few pixels is not: it costs a request and
	// an encoder re-program for a rectangle in the same place. A twentieth of
	// the frame is about where a move becomes one somebody made on purpose.
	function moved(r, f) {
		if (!sent) return true;
		const dx = Math.abs(r.x - sent.x) + Math.abs(r.w - sent.w);
		const dy = Math.abs(r.y - sent.y) + Math.abs(r.h - sent.h);
		return dx > f.w / 20 || dy > f.h / 20;
	}

	// ---- the view decides --------------------------------------------------

	function consider(v) {
		if (!supported || hidden || !v) return;
		const f = v.frame, vis = v.visible;
		const share = (vis.w * vis.h) / (f.w * f.h);
		const want = engaged ? share < RELEASE : share < ENGAGE;

		if (!want) { clear(); return; }
		if (engaged && !moved(vis, f)) return;

		// On settle, not on every frame of a gesture. onView fires from the
		// middle of a pan, and pushing there would be one request per pointer
		// move -- on a camera whose whole HTTP server is one thread.
		if (timer) clearTimeout(timer);
		const r = { x: vis.x, y: vis.y, w: vis.w, h: vis.h };
		timer = setTimeout(() => {
			timer = null;
			readRects().then(() => push(r)).then((ok) => {
				if (!ok) { engaged = false; sent = null; repaintChip(); return; }
				engaged = true;
				sent = r;
				repaintChip();
			});
		}, SETTLE_MS);
	}
	ZOOM.onView(consider);

	// ---- what the page says about it ---------------------------------------

	// Repainted through the page's own chip, which already prints the codec,
	// the size, the rate and the scale. A line of its own would be another
	// thing floating over the picture; this is one more clause on the line that
	// is already there.
	function repaintChip() {
		if (window.MajesticPreviewChip) {
			try { window.MajesticPreviewChip(); } catch (e) {}
		}
	}

	// A tab left zoomed in would go on spending the camera's bits on a picture
	// nobody is looking at. Taken back when it goes away, put back when it
	// returns -- the next view event re-engages, and one is fired by the
	// layout the page runs when it becomes visible again.
	document.addEventListener('visibilitychange', () => {
		hidden = document.visibilityState === 'hidden';
		if (hidden) { clear(); return; }
		// Coming back does not move the picture, so no view event is coming:
		// ask the same question again against the view as it stands.
		consider(ZOOM.view());
	});

	// And on the way out. A page that closed zoomed in would leave one stream
	// spending its bits somewhere nobody is looking until the next restart.
	window.addEventListener('pagehide', () => { if (engaged) push(null); });

	// Changing channel changes both the ground the rectangle was measured on
	// and the bitrate the strength came from. The next view event re-engages
	// against the new frame; setFrame() fires one.
	window.addEventListener('mj-stream-changed', () => {
		clear();
		mjConfig().then((cfg) => {
			const b = mjGet(cfg, 'video' + shownStream() + '.bitrate');
			ceiling = typeof b === 'number' ? b : null;
		});
	});

	return {
		// What the status chip should add while a region is in force, or null.
		// The page asks; this file never touches the chip itself.
		note: function () {
			return engaged
				? { chip: ' · detail here',
					title: 'The camera is encoding the part you have zoomed '
						+ 'into at higher quality. It changes the stream '
						+ 'itself, so the detail is in the recording and in '
						+ 'every viewer’s picture, and the rest of the '
						+ 'frame gives up the bits it costs. Zoom back out to '
						+ 'stop.' }
				: null;
		},
	};
})();
