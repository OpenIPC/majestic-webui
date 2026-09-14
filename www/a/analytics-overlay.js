// What the camera's detectors are seeing, drawn over the live picture.
//
// The camera's own overlay burns boxes into the encoded stream, and how many
// it can draw is a property of the chip rather than of the scene: eight on one
// HiSilicon generation, one on another, none at all on a third, six on
// SigmaStar. It also fights the privacy masks for the same region hardware,
// and every box costs the encoder. Drawing them here costs the camera one
// small JSON message per event and has no such ceiling.
//
// The transport is /ws/analytics rather than a track inside the video, because
// the preview ladder is WebRTC, then MSE, then a software decoder: WebRTC
// carries no container to put a track in, and the MSE rung would have to demux
// it back out of every fragment before appending. One side channel serves all
// three rungs.
//
// ON ALIGNMENT, and what this does NOT yet do. Every event carries the
// presentation timestamp of the frame it describes, which is the same clock
// the video is in — so a box CAN in principle be pinned to its own frame. The
// page cannot do that yet, because nothing in the preview stack surfaces the
// timestamp of the frame currently on the glass. So what is drawn here is the
// camera's latest answer, held briefly, with its age stated. That is honest
// and it is already far past what the burned-in overlay could do; pinning each
// box to its frame is the next step, and it needs the player to say which
// frame it is showing, not a change here.
(function () {
	'use strict';

	// A detection is held this long after the event that reported it. The bus
	// publishes at analytics.publishFps (5 by default) against a picture at
	// 20-30, so without a linger every box would strobe: visible for one frame
	// in five, which reads as a fault rather than as a detection. Comfortably
	// longer than one publish interval at the slowest rate anyone would set.
	const LINGER_MS = 1200;

	// Past this the answer is not late, it is absent — the socket is up but
	// the camera has stopped speaking. The lane says so rather than leaving
	// the last boxes on screen, because a stale box over a changed scene is
	// worse than no box.
	const STALE_MS = 5000;

	// --- the store: no DOM, so the tests can reach it ---------------------

	function store() {
		const latest = Object.create(null);

		return {
			// An event as /ws/analytics sends it. Later events from one source
			// replace earlier ones: this is a "what is there now" display, not
			// a log, and queueing them would only ever draw the past.
			offer: function (ev, now) {
				if (!ev || typeof ev.src !== 'string') return false;
				if (!Array.isArray(ev.r)) return false;
				latest[ev.src] = { ev: ev, at: now };
				return true;
			},

			// Every box that should be on screen at `now`, flattened across
			// sources and tagged with the source that reported it so a caller
			// can colour by detector.
			boxes: function (now) {
				const out = [];
				for (const src in latest) {
					const held = latest[src];
					if (now - held.at > LINGER_MS) continue;
					if (!held.ev.active) continue;
					const r = held.ev.r;
					for (let i = 0; i < r.length; i++) {
						const b = r[i];
						if (!Array.isArray(b) || b.length < 4) continue;
						out.push({
							src: src,
							x: b[0], y: b[1], w: b[2], h: b[3],
							cls: b[4] || 0, score: b[5] || 0,
							// The frame the camera measured this against. Kept
							// per box rather than per repaint: the picture can
							// change size between an event arriving and the
							// next repaint, and a box scaled by the new size
							// against the old measurement lands in the wrong
							// place.
							frame: { w: held.ev.w, h: held.ev.h },
						});
					}
				}
				return out;
			},

			// What to say underneath. Four states, and they are deliberately
			// not three: "nothing is moving" and "the camera has stopped
			// telling us" look identical on screen and mean opposite things.
			note: function (now) {
				const keys = Object.keys(latest);
				if (!keys.length) return { state: 'waiting' };
				let newest = null;
				for (const k of keys) {
					if (!newest || latest[k].at > newest.at) newest = latest[k];
				}
				const age = now - newest.at;
				if (age > STALE_MS) return { state: 'stale', age: age };
				let n = 0, total = 0;
				for (const k of keys) {
					if (now - latest[k].at > LINGER_MS) continue;
					if (!latest[k].ev.active) continue;
					n += latest[k].ev.r.length;
					total += latest[k].ev.total || latest[k].ev.r.length;
				}
				if (!n) return { state: 'quiet', age: age };
				return { state: 'active', n: n, total: total, age: age };
			},
		};
	}

	// --- the mount: the DOM half -----------------------------------------

	function mount(preview, opts) {
		opts = opts || {};
		const RGN = window.MajesticRegion;
		if (!preview || !preview.overlay || !RGN) return null;

		const st = store();

		const layer = document.createElement('div');
		layer.className = 'mj-an-layer';
		// Pointer-transparent, and above the region editor's own layers: the
		// motion-detect tab draws its ROI rectangles in this same overlay and
		// its gestures are hit-tested by DOM order, so a layer that swallowed
		// a press would break the editor underneath it.
		preview.overlay.appendChild(layer);

		let ws = null, timer = null, closed = false, retry = 1000;

		function paint() {
			if (closed) return;
			const now = Date.now();
			const p = RGN.pic(
				preview.frame(), preview.stage.clientWidth,
				preview.stage.clientHeight);
			const boxes = p ? st.boxes(now) : [];

			// `view` has three answers and they are all different. A mapping
			// means "here is how main-stream pixels land on this picture";
			// null means "no mapping is needed, scale by the frames"; and
			// UNDEFINED means "the camera has such a report and has not
			// answered yet" -- so nothing is drawn, because a box placed by a
			// guess moves when the answer arrives, and a box that jumps reads
			// as the camera being wrong about where the movement was.
			const m = opts.view ? opts.view() : null;
			const ready = m !== undefined;

			// Built with DOM calls rather than an HTML string, because `src`
			// comes off the websocket. The camera only ever sends one of three
			// literals, but this page must not be the thing that makes that
			// load-bearing: a src closing the attribute and adding an event
			// handler would run in the browser of whoever is signed in. Every
			// other value here is a number this file computed.
			while (layer.firstChild) layer.removeChild(layer.firstChild);
			for (let i = 0; ready && i < boxes.length; i++) {
				const b = boxes[i];
				const box = RGN.place(m, p, b);
				if (!box || box.w <= 0 || box.h <= 0) continue;
				const el = document.createElement('div');
				el.className = 'mj-an-box';
				el.dataset.src = String(b.src);
				el.style.left = box.x.toFixed(1) + 'px';
				el.style.top = box.y.toFixed(1) + 'px';
				el.style.width = box.w.toFixed(1) + 'px';
				el.style.height = box.h.toFixed(1) + 'px';
				layer.appendChild(el);
			}
			if (opts.onNote) opts.onNote(st.note(now));
		}

		function open() {
			if (closed) return;
			const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
			try {
				ws = new WebSocket(proto + '//' + location.host + '/ws/analytics');
			} catch (e) {
				return;
			}
			ws.onmessage = function (m) {
				let ev = null;
				try { ev = JSON.parse(m.data); } catch (e) { return; }
				if (st.offer(ev, Date.now())) paint();
			};
			ws.onopen = function () { retry = 1000; };
			ws.onclose = function () {
				ws = null;
				if (closed) return;
				// Backing off rather than hammering: a camera that refused the
				// session because its subscriber slots are full will refuse
				// the next one too, and a reconnect loop against it is how a
				// page ends up denying the RTSP metadata track its slot.
				setTimeout(open, retry);
				retry = Math.min(retry * 2, 30000);
			};
		}

		open();
		// Repaint on a timer as well as on arrival: the linger has to expire
		// on its own, and the stage can be resized without an event.
		timer = setInterval(paint, 250);

		return {
			repaint: paint,
			destroy: function () {
				closed = true;
				if (timer) clearInterval(timer);
				if (ws) { try { ws.close(); } catch (e) {} }
				if (layer.parentNode) layer.parentNode.removeChild(layer);
			},
		};
	}

	const api = { store: store, mount: mount,
		LINGER_MS: LINGER_MS, STALE_MS: STALE_MS };
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticAnalytics = api;
})();
