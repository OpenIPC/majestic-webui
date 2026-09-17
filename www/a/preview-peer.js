/* The other camera's view of the part you drew.
 *
 * A camera calibrated against another one that sees the same scene can say
 * where a rectangle of its own picture lands in the other's: GET
 * /api/v1/calibration/map answers with the rectangle in the peer's pixels and
 * the address of the peer's snapshot cropped to exactly that. This is the
 * control that asks. Draw a rectangle on the live picture and the answer
 * appears as a note with a link; the link opens the peer's crop in a new tab,
 * under that camera's own login.
 *
 * The crop is never embedded here. A cookie for this camera must not travel
 * to another one (cameras-switch.js says why), so the peer's picture is
 * fetched by nobody but the viewer, on the peer's own origin, with whatever
 * credential the viewer has there. What this page shows is where the
 * rectangle lands and the way to it.
 *
 * Its own file, like preview-still.js and preview-roi.js: tests/auto-source
 * and tests/staging run preview-page.js in a bare vm with no layout, no fetch
 * and no canvas, and preview-page.js does not know this exists. The rubber
 * band is preview-zoom's element and preview-zoom's drawing rules, copied
 * rather than shared: while this control is armed its listeners run first, in
 * the capture phase, and stop the event there, so the same drag does not also
 * pan or zoom.
 */
(function () {
	'use strict';

	const $ = (s) => document.querySelector(s);

	const stage = $('#mj-stage');
	const band = $('#mj-marquee');
	const ctl = $('#mj-peer-ctl');
	const box = $('#mj-peer');
	const pick = $('#mj-peer-pick');
	const note = $('#mj-peer-note');
	if (!stage || !band || !ctl || !box || !note) return;

	const ENDPOINT = '/api/v1/calibration/map';

	let peers = [];         /* names the calibration knows, as the camera spelt them */
	let geom = null;        /* null means NOT KNOWN -- never assume 1:1 */
	let armed = false, drawing = null;
	let gen = 0;            /* so a slow answer cannot land after a newer one */

	function api(url, init) {
		return typeof apiFetch === 'function'
			? apiFetch(url, init)
			: fetch(url, init);
	}

	/* The endpoint exists when it refuses an empty question. A camera that
	 * answers 404 has no such door, and the control stays hidden: offering a
	 * feature the camera cannot do is worse than no feature. */
	async function probe() {
		try {
			const res = await api(ENDPOINT, { credentials: 'same-origin' });
			return res.status === 400;
		} catch (e) {
			return false;
		}
	}

	/* The cameras this one is calibrated against, from its own configuration,
	 * in the order first written and without duplicates. Nothing to offer
	 * where there are none. */
	async function learnPeers() {
		if (typeof mjConfig !== 'function' || typeof mjGet !== 'function') return [];
		const cfg = await mjConfig();
		const rows = mjGet(cfg, 'calibration.peers');
		const out = [];
		if (!Array.isArray(rows)) return out;
		rows.forEach((r) => {
			const name = r && typeof r.peer === 'string' ? r.peer.trim() : '';
			if (name && !out.some((n) => n.toLowerCase() === name.toLowerCase())) out.push(name);
		});
		return out;
	}

	function shownStream() {
		if (typeof window.MajesticLiveStream !== 'function') return null;
		const n = window.MajesticLiveStream();
		return Number.isFinite(n) ? n | 0 : null;
	}

	/* The main channel's size and the map from the shown stream to it -- the
	 * same two things preview-still.js learns, for the same reason: the camera
	 * calibrates in the MAIN channel's pixels, and a rectangle drawn on the sub
	 * stream converted as though it were the main one lands somewhere else in
	 * the scene while still looking like an answer. Null where the camera will
	 * not say, and the control then says so rather than guess. */
	async function learnGeometry() {
		const at = shownStream();
		if (at === null) { geom = null; return; }
		try {
			const res = await api('/api/v1/osd', { credentials: 'same-origin' });
			if (!res.ok) { geom = null; return; }
			const j = await res.json();
			const streams = Array.isArray(j.streams) ? j.streams : [];
			let main = null, declared = null;
			streams.forEach((st) => {
				if (!st || !Array.isArray(st.frame) || !(st.frame[0] > 0) || !(st.frame[1] > 0)) return;
				if (st.stream === 0) main = { w: st.frame[0], h: st.frame[1] };
				if (st.stream === at) declared = { w: st.frame[0], h: st.frame[1] };
			});
			if (!main || !declared) { geom = null; return; }
			let map = null;
			if (at !== 0) {
				map = window.MajesticRegion && j.group
					? window.MajesticRegion.view(j.group, streams, 0, at)
					: null;
				if (!map || !map.k || !map.k.x || !map.k.y) { geom = null; return; }
			}
			geom = { at: at, main: main, declared: declared, map: map };
		} catch (e) {
			geom = null;
		}
	}

	/* A rectangle in stage pixels to one in the main channel's, or null with a
	 * reason. Stage to shown-stream pixels is preview-zoom's placement run
	 * backwards; shown to main is the camera's map, scaled by what the decoder
	 * actually produced against what the channel declares (WebRTC may send a
	 * smaller picture than configured). Whole pixels, clamped to the frame. */
	function toMain(b) {
		const zoom = window.MajesticZoom;
		if (!zoom || typeof zoom.view !== 'function') return { why: 'the picture has not been placed yet' };
		const v = zoom.view();
		if (!v || !v.frame || !v.visible || !v.pic || !v.scale) return { why: 'the picture has not been placed yet' };
		if (!geom) return { why: 'the camera has not said which stream is on screen' };
		const ax = v.frame.w / geom.declared.w, ay = v.frame.h / geom.declared.h;
		const k = geom.map
			? { kx: geom.map.k.x * ax, ky: geom.map.k.y * ay, ox: geom.map.o.x * ax, oy: geom.map.o.y * ay }
			: { kx: ax, ky: ay, ox: 0, oy: 0 };
		const shownX = (x) => v.visible.x + (x - v.pic.x) / v.scale;
		const shownY = (y) => v.visible.y + (y - v.pic.y) / v.scale;
		let x0 = (shownX(b.x) - k.ox) / k.kx, y0 = (shownY(b.y) - k.oy) / k.ky;
		let x1 = (shownX(b.x + b.w) - k.ox) / k.kx, y1 = (shownY(b.y + b.h) - k.oy) / k.ky;
		x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
		x1 = Math.min(geom.main.w, Math.ceil(x1)); y1 = Math.min(geom.main.h, Math.ceil(y1));
		if (!(x1 - x0 >= 1) || !(y1 - y0 >= 1)) return { why: 'the rectangle is off the picture' };
		return { rect: x0 + 'x' + y0 + 'x' + (x1 - x0) + 'x' + (y1 - y0) };
	}

	function peerName() {
		if (pick && !pick.hidden && pick.value) return pick.value;
		return peers[0] || '';
	}

	/* ---- the note -------------------------------------------------------- */

	function say(text, link) {
		while (note.firstChild) note.removeChild(note.firstChild);
		note.appendChild(document.createTextNode(text));
		if (link) {
			note.appendChild(document.createTextNode(' · '));
			const a = document.createElement('a');
			a.href = link;
			a.target = '_blank';
			a.rel = 'noopener noreferrer';
			a.textContent = 'open on ' + peerName();
			note.appendChild(a);
		}
		note.hidden = false;
	}
	function clear() { note.hidden = true; gen++; }

	/* ---- the question ---------------------------------------------------- */

	async function ask(rect) {
		const peer = peerName();
		if (!peer) return;
		const my = ++gen;
		say('asking where ' + rect.replace(/x/g, ',').replace(/^(\d+),(\d+),(\d+),(\d+)$/, '$1,$2 $3×$4') + ' lands on ' + peer + '…');
		let res, body = null;
		try {
			res = await api(ENDPOINT + '?peer=' + encodeURIComponent(peer) + '&rect=' + rect,
				{ credentials: 'same-origin' });
			if (res.ok) body = await res.json();
		} catch (e) {
			res = null;
		}
		if (my !== gen) return;
		if (!res) { say('could not reach the camera'); return; }
		if (!res.ok || !body || typeof body.rect !== 'string') {
			say(res.status === 404 ? 'this camera is not calibrated against ' + peer
				: res.status === 400 ? 'that rectangle lands nowhere in ' + peer + '’s picture'
					: 'the camera could not answer (' + (res.status || '?') + ')');
			return;
		}
		const at = body.rect.split('x');
		const where = at.length === 4 ? at[0] + ',' + at[1] + ' ' + at[2] + '×' + at[3] : body.rect;
		const url = typeof body.url === 'string' && /^https?:\/\//.test(body.url) ? body.url : null;
		say('lands at ' + where + ' on ' + peer + (url ? '' : ' (not on this link, so no address)'), url);
	}

	/* ---- the rubber band, preview-zoom's rules ----------------------------- */

	function setArmed(on) {
		armed = !!on;
		drawing = null;
		band.hidden = true;
		stage.classList.toggle('mj-armed', armed);
		if (box.checked !== armed) box.checked = armed;
		/* One drawing control at a time: the other one is disarmed rather
		 * than left to fire on the same drag. */
		const area = $('#mj-area');
		if (armed && area && area.checked) {
			area.checked = false;
			area.dispatchEvent(new Event('change'));
		}
	}
	box.addEventListener('change', () => setArmed(box.checked));

	function picRect() {
		const sw = stage.clientWidth, sh = stage.clientHeight;
		const zoom = window.MajesticZoom;
		const v = zoom && typeof zoom.view === 'function' ? zoom.view() : null;
		if (!v || !v.pic) return { x: 0, y: 0, r: sw, b: sh };
		return {
			x: Math.max(0, v.pic.x), y: Math.max(0, v.pic.y),
			r: Math.min(sw, v.pic.x + v.pic.w), b: Math.min(sh, v.pic.y + v.pic.h),
		};
	}
	const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

	function bandRect(e) {
		const s = stage.getBoundingClientRect(), p = picRect();
		const x = clamp(e.clientX - s.left, p.x, p.r), y = clamp(e.clientY - s.top, p.y, p.b);
		const x0 = clamp(drawing.x, p.x, p.r), y0 = clamp(drawing.y, p.y, p.b);
		return { x: Math.min(x0, x), y: Math.min(y0, y), w: Math.abs(x - x0), h: Math.abs(y - y0) };
	}

	function down(e) {
		if (!armed) return;
		if (e.button != null && e.button > 0) return;
		if (drawing) return;
		e.stopImmediatePropagation();
		const r = stage.getBoundingClientRect();
		drawing = { id: e.pointerId, x: e.clientX - r.left, y: e.clientY - r.top };
		try { stage.setPointerCapture(e.pointerId); } catch (err) {}
	}
	function move(e) {
		if (!drawing || e.pointerId !== drawing.id) return;
		e.stopImmediatePropagation();
		const b = bandRect(e);
		band.hidden = false;
		band.style.left = b.x + 'px';
		band.style.top = b.y + 'px';
		band.style.width = b.w + 'px';
		band.style.height = b.h + 'px';
	}
	function finish(e, commit) {
		if (!drawing || e.pointerId !== drawing.id) return;
		e.stopImmediatePropagation();
		const b = commit ? bandRect(e) : null;
		try { stage.releasePointerCapture(e.pointerId); } catch (err) {}
		drawing = null;
		/* The same floor as zoom-to-area: below it a drag is a slip or a
		 * click, and neither is a question. */
		const minW = Math.max(16, stage.clientWidth * 0.02);
		const minH = Math.max(16, stage.clientHeight * 0.02);
		if (b && b.w >= minW && b.h >= minH) {
			const m = toMain(b);
			if (m.rect) ask(m.rect); else say(m.why);
		}
		setArmed(false);
	}
	stage.addEventListener('pointerdown', down, true);
	stage.addEventListener('pointermove', move, true);
	stage.addEventListener('pointerup', (e) => finish(e, true), true);
	stage.addEventListener('pointercancel', (e) => finish(e, false), true);

	document.addEventListener('keydown', (e) => {
		if (e.key !== 'Escape') return;
		if (armed) { setArmed(false); e.stopPropagation(); return; }
		if (!note.hidden) { clear(); e.stopPropagation(); }
	});

	/* The map is per shown stream and goes stale the moment the viewer changes
	 * channel; dropped first, so a drag arriving before the refresh lands
	 * converts nothing rather than converting wrongly. */
	window.addEventListener('mj-stream-changed', () => {
		geom = null;
		clear();
		learnGeometry();
	});

	(async function () {
		const [present, names] = await Promise.all([probe(), learnPeers()]);
		if (!present || !names.length) return;   /* left hidden */
		peers = names;
		if (pick) {
			while (pick.firstChild) pick.removeChild(pick.firstChild);
			names.forEach((n) => {
				const o = document.createElement('option');
				o.value = n;
				o.textContent = n;
				pick.appendChild(o);
			});
			pick.hidden = names.length < 2;
		}
		await learnGeometry();
		ctl.hidden = false;
	})();

	window.MajesticPeerCrop = { toMain: toMain, peers: () => peers.slice() };
})();
