/* The other camera's picture, in place, on this page.
 *
 * A camera calibrated against another one that sees the same scene can say
 * two things about it: where that camera's whole picture lies in this one
 * (GET /api/v1/calibration/coverage), and where a rectangle of this picture
 * lands in that one (GET /api/v1/calibration/map). This control is both, on
 * the live picture. Switch Peer on and the other camera's OUTLINE is drawn
 * on this picture, so you know where it looks before you draw anything.
 * Draw a rectangle inside it and the rectangle becomes a LOUPE: the other
 * camera's live video, cropped to the part you drew, in the place you drew
 * it. Drag it to move, drag its corner to resize; its toolbar shows the
 * whole of the other picture, swaps it with this one, goes full screen, pops
 * the video out, or closes it. Esc backs out one step.
 *
 * The video comes from the other camera directly, and without a second
 * login: this camera holds a pairing with it (a token, never a password,
 * entered once right here) and brokers a MEDIA-SCOPED session for this page
 * (GET /api/v1/calibration/peer) -- good for that camera's video for a
 * quarter of an hour and for nothing else, carried in the socket's URL
 * because a cookie for one origin never travels to another. The player is
 * mj-preview.js's, mounted inside the loupe and pointed at that origin; a
 * page whose build lacks it, or a browser that cannot play the stream, gets
 * the other camera's snapshots instead, cropped and polled.
 *
 * Its own file, like preview-still.js and preview-roi.js: tests/auto-source
 * and tests/staging run preview-page.js in a bare vm with no layout, no fetch
 * and no canvas, and preview-page.js does not know this exists. The rubber
 * band is preview-zoom's element and preview-zoom's drawing rules, copied
 * rather than shared: while this control is armed its listeners run first,
 * in the capture phase, and stop the event there, so the same drag does not
 * also pan or zoom.
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

	const MAP = '/api/v1/calibration/map';
	const COVERAGE = '/api/v1/calibration/coverage';
	const PEER = '/api/v1/calibration/peer';
	const PAIR = '/api/v1/calibration/pair';

	/* Where a press belongs to the control under it rather than to the
	 * picture -- preview-zoom's list, for the same bar, plus the loupe. */
	const CHROME = '.mj-bar, .mj-ptz, #mj-stats, #mj-toasts, #mj-peer-loupe';

	/* The outline is asked of the camera again this often while Peer is on
	 * (the lens may have moved), and laid out again this often (the viewer
	 * may have panned or zoomed). The snapshot fallback polls at this rate. */
	const OUTLINE_ASK_MS = 5000;
	const OUTLINE_PLACE_MS = 250;
	const STILL_MS = 1000;
	const INSET_MS = 125;
	/* A loupe smaller than this shows nothing anyone can read, so a smaller
	 * drawing is grown around its centre to it (kept on the picture); one
	 * still narrower than the toolbar hides its tag. */
	const LOUPE_MIN_W = 160, LOUPE_MIN_H = 90;
	const LOUPE_CRAMPED_W = 220, LOUPE_CRAMPED_H = 120;

	let peers = [];         /* names the calibration knows, as the camera spelt them */
	let geom = null;        /* null means NOT KNOWN -- never assume 1:1 */
	let geomGen = 0;        /* so an older /api/v1/osd answer cannot overwrite a newer */
	let armed = false, drawing = null;
	let gen = 0;            /* so a slow answer cannot land after a newer one */
	let doors = { map: false, peer: false };

	function api(url, init) {
		return typeof apiFetch === 'function'
			? apiFetch(url, init)
			: fetch(url, init);
	}

	/* A door exists when it refuses an empty question with 400. A camera that
	 * answers 404 has no such door. The map is what makes the control worth
	 * showing; without the peer door the loupe cannot fetch anything and the
	 * control says so instead of offering a feature the camera cannot do. */
	async function probe(url) {
		try {
			const res = await api(url, { credentials: 'same-origin' });
			return res.status === 400;
		} catch (e) {
			return false;
		}
	}

	/* The cameras this one is calibrated against, from its own configuration,
	 * in the order first written and without duplicates. */
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
	 * the scene while still looking like an answer. */
	async function learnGeometry() {
		const my = ++geomGen;
		const at = shownStream();
		if (at === null) { geom = null; return; }
		let next = null;
		try {
			const res = await api('/api/v1/osd', { credentials: 'same-origin' });
			if (res.ok) {
				const j = await res.json();
				const streams = Array.isArray(j.streams) ? j.streams : [];
				let main = null, declared = null;
				streams.forEach((st) => {
					if (!st || !Array.isArray(st.frame) || !(st.frame[0] > 0) || !(st.frame[1] > 0)) return;
					if (st.stream === 0) main = { w: st.frame[0], h: st.frame[1] };
					if (st.stream === at) declared = { w: st.frame[0], h: st.frame[1] };
				});
				let map = null, usable = !!(main && declared);
				if (usable && at !== 0) {
					map = window.MajesticRegion && j.group
						? window.MajesticRegion.view(j.group, streams, 0, at)
						: null;
					usable = !!(map && map.k && map.k.x && map.k.y);
				}
				if (usable) next = { at: at, main: main, declared: declared, map: map };
			}
		} catch (e) {
			next = null;
		}
		if (my === geomGen) geom = next;
	}

	/* Stage pixels <-> the main channel's. Stage to shown-stream pixels is
	 * preview-zoom's placement run backwards; shown to main is the camera's
	 * map, scaled by what the decoder actually produced against what the
	 * channel declares (WebRTC may send a smaller picture than configured). */
	function placement() {
		const zoom = window.MajesticZoom;
		if (!zoom || typeof zoom.view !== 'function') return null;
		const v = zoom.view();
		if (!v || !v.frame || !v.visible || !v.pic || !v.scale) return null;
		if (!geom) return null;
		const ax = v.frame.w / geom.declared.w, ay = v.frame.h / geom.declared.h;
		const k = geom.map
			? { kx: geom.map.k.x * ax, ky: geom.map.k.y * ay, ox: geom.map.o.x * ax, oy: geom.map.o.y * ay }
			: { kx: ax, ky: ay, ox: 0, oy: 0 };
		return { v: v, k: k };
	}

	/* The map is for the stream it was learnt on, and the served channel can
	 * change without the event the user-selection path sends: the camera may
	 * answer a request for one stream with the other, and the page then shows
	 * a picture the map does not describe. Anything about to convert asks for
	 * a fresh map first; one learning at a time. */
	let learning = null;
	function geometryFresh() {
		if (geom && geom.at === shownStream()) return Promise.resolve(true);
		if (!learning) learning = learnGeometry().then(() => { learning = null; return !!geom; });
		return learning;
	}

	function toMain(b) {
		const p = placement();
		if (!p) return { why: geom ? 'the picture has not been placed yet' : 'the camera has not said which stream is on screen' };
		/* A map for the stream just left converts this one confidently to the
		 * wrong place; refused rather than guessed. The callers ask
		 * geometryFresh() first, so this is the stream moving mid-drag. */
		if (geom.at !== shownStream()) return { why: 'the stream on screen changed; draw again' };
		const { v, k } = p;
		const shownX = (x) => v.visible.x + (x - v.pic.x) / v.scale;
		const shownY = (y) => v.visible.y + (y - v.pic.y) / v.scale;
		let x0 = (shownX(b.x) - k.ox) / k.kx, y0 = (shownY(b.y) - k.oy) / k.ky;
		let x1 = (shownX(b.x + b.w) - k.ox) / k.kx, y1 = (shownY(b.y + b.h) - k.oy) / k.ky;
		x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
		x1 = Math.min(geom.main.w, Math.ceil(x1)); y1 = Math.min(geom.main.h, Math.ceil(y1));
		if (!(x1 - x0 >= 1) || !(y1 - y0 >= 1)) return { why: 'the rectangle is off the picture' };
		return { rect: x0 + 'x' + y0 + 'x' + (x1 - x0) + 'x' + (y1 - y0) };
	}

	/* A point of the main channel, in stage pixels; null until placeable. */
	function toStage(x, y) {
		const p = placement();
		if (!p) return null;
		const { v, k } = p;
		const sx = k.kx * x + k.ox, sy = k.ky * y + k.oy;
		return { x: v.pic.x + (sx - v.visible.x) * v.scale, y: v.pic.y + (sy - v.visible.y) * v.scale };
	}

	function peerName() {
		if (pick && !pick.hidden && pick.value) return pick.value;
		return peers[0] || '';
	}

	/* ---- the note -------------------------------------------------------- */

	function empty(el) { while (el.firstChild) el.removeChild(el.firstChild); }

	function say(text) {
		empty(note);
		note.appendChild(document.createTextNode(text));
		note.hidden = false;
	}
	function clearNote() { note.hidden = true; }

	/* Pairing, once, right here: the other camera's password goes to this
	 * camera, which signs in there and keeps only the token it is handed
	 * back. `then` runs once the pairing took. */
	function offerPairing(peer, then, at) {
		empty(note);
		const form = document.createElement('form');
		form.className = 'mj-peer-pair';
		const label = document.createElement('span');
		/* With the address the password is about to go to: the camera's
		 * roster is filled by whatever announces itself on the link, and the
		 * operator is the one who knows whether that address is the peer. */
		label.textContent = 'To see ' + peer + ' here, this camera needs its password once' +
			(at ? ', which it sends to ' + at : '') + '. ';
		const input = document.createElement('input');
		input.type = 'password';
		input.autocomplete = 'off';
		input.placeholder = 'password on ' + peer;
		input.setAttribute('aria-label', 'password on ' + peer);
		const btn = document.createElement('button');
		btn.type = 'submit';
		btn.textContent = 'Pair';
		const why = document.createElement('span');
		why.className = 'mj-peer-pair-why';
		form.appendChild(label);
		form.appendChild(input);
		form.appendChild(btn);
		form.appendChild(why);
		form.addEventListener('submit', async (e) => {
			if (e && e.preventDefault) e.preventDefault();
			const password = input.value;
			if (!password) { why.textContent = 'the password is empty'; return; }
			btn.disabled = true;
			why.textContent = 'pairing…';
			let res = null, body = null;
			try {
				res = await api(PAIR, {
					method: 'POST', credentials: 'same-origin',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ peer: peer, password: password }),
				});
				try { body = await res.json(); } catch (err) { body = null; }
			} catch (err) { res = null; }
			input.value = '';
			btn.disabled = false;
			if (res && res.ok && body && body.paired === true) {
				clearNote();
				then();
				return;
			}
			why.textContent = !res ? 'could not reach the camera'
				: res.status === 403 ? peer + ' refused that password'
					: (body && body.reason) || ('the camera could not pair (' + res.status + ')');
		});
		note.appendChild(form);
		note.hidden = false;
		try { input.focus(); } catch (e) {}
	}

	/* ---- the outline: where the other camera looks ------------------------ */

	const SVG = 'http://www.w3.org/2000/svg';
	let outline = null, outlinePoly = null, outlineTag = null;
	let quad = null;            /* main-channel corners of the peer's picture */
	let askTimer = null, placeTimer = null;

	function buildOutline() {
		if (outline || typeof document.createElementNS !== 'function') return;
		outline = document.createElementNS(SVG, 'svg');
		outline.setAttribute('class', 'mj-peer-outline');
		outline.setAttribute('id', 'mj-peer-outline');
		outline.setAttribute('aria-hidden', 'true');
		outlinePoly = document.createElementNS(SVG, 'polygon');
		outlineTag = document.createElementNS(SVG, 'text');
		outline.appendChild(outlinePoly);
		outline.appendChild(outlineTag);
		outline.hidden = true;
		stage.appendChild(outline);
	}

	function placeOutline() {
		if (!outline) return;
		if (!quad || !armed && !loupeOpen()) { outline.hidden = true; return; }
		if (geom && geom.at !== shownStream()) { geometryFresh().then(placeOutline); return; }
		const pts = quad.map((c) => toStage(c[0], c[1]));
		if (pts.some((p) => !p)) { outline.hidden = true; return; }
		outlinePoly.setAttribute('points', pts.map((p) => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' '));
		const top = pts.reduce((a, p) => (p.y < a.y ? p : a), pts[0]);
		outlineTag.setAttribute('x', top.x.toFixed(1));
		outlineTag.setAttribute('y', (top.y - 6).toFixed(1));
		outlineTag.textContent = peerName() + ' sees this';
		outline.hidden = false;
	}

	async function askOutline() {
		const peer = peerName();
		if (!peer || !doors.map) return;
		const my = ++outlineGen;
		let next = null;
		try {
			const res = await api(COVERAGE + '?peer=' + encodeURIComponent(peer), { credentials: 'same-origin' });
			if (res.ok) {
				const j = await res.json();
				if (j && Array.isArray(j.quad) && j.quad.length === 4 &&
					j.quad.every((c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1])))
					next = j.quad;
			}
		} catch (e) { next = null; }
		if (my !== outlineGen) return;
		quad = next;
		placeOutline();
	}
	let outlineGen = 0;

	function outlineOn(on) {
		buildOutline();
		if (on) {
			if (!askTimer) { askOutline(); askTimer = setInterval(askOutline, OUTLINE_ASK_MS); }
			if (!placeTimer) placeTimer = setInterval(placeOutline, OUTLINE_PLACE_MS);
		} else {
			if (askTimer) { clearInterval(askTimer); askTimer = null; }
			if (placeTimer) { clearInterval(placeTimer); placeTimer = null; }
			quad = null;
			placeOutline();
		}
	}

	/* ---- the loupe: the other camera's video where you drew --------------- */

	const L = {
		el: null, host: null, still: null, inset: null, tag: null, bar: null, grip: null,
		peer: '', box: null,          /* stage px */
		rect: '', peerRect: null,      /* this camera's main px; the peer's main px {x,y,w,h} */
		size: null,                    /* the peer's declared picture {w,h}, from the map row */
		frame: null, codec: '',        /* what the peer's decoder produced */
		handle: null, playing: false, lost: false,
		sess: null, sessTimer: null, stillTimer: null, insetTimer: null,
		whole: false, swapped: false,
	};

	function loupeOpen() { return !!(L.el && !L.el.hidden); }

	function icon(d) {
		if (typeof document.createElementNS !== 'function') return document.createTextNode('');
		const s = document.createElementNS(SVG, 'svg');
		s.setAttribute('viewBox', '0 0 20 20');
		s.setAttribute('width', '16');
		s.setAttribute('height', '16');
		s.setAttribute('fill', 'none');
		s.setAttribute('stroke', 'currentColor');
		s.setAttribute('stroke-width', '1.6');
		s.setAttribute('stroke-linecap', 'round');
		s.setAttribute('stroke-linejoin', 'round');
		s.setAttribute('aria-hidden', 'true');
		const p = document.createElementNS(SVG, 'path');
		p.setAttribute('d', d);
		s.appendChild(p);
		return s;
	}

	function button(name, title, d, onClick) {
		const b = document.createElement('button');
		b.type = 'button';
		b.className = 'mj-hud-ico mj-loupe-btn';
		b.setAttribute('data-act', name);
		b.title = title;
		b.setAttribute('aria-label', title);
		b.appendChild(icon(d));
		b.addEventListener('click', (e) => { if (e && e.stopPropagation) e.stopPropagation(); onClick(); });
		return b;
	}

	function buildLoupe() {
		if (L.el) return;
		L.el = document.createElement('div');
		L.el.id = 'mj-peer-loupe';
		L.el.className = 'mj-loupe';
		L.el.hidden = true;
		L.host = document.createElement('div');
		L.host.className = 'mj-loupe-host';
		L.still = document.createElement('img');
		L.still.className = 'mj-loupe-still';
		L.still.alt = '';
		L.still.hidden = true;
		L.inset = document.createElement('canvas');
		L.inset.className = 'mj-loupe-inset';
		L.inset.hidden = true;
		L.inset.title = 'This camera. Click to swap back.';
		L.inset.addEventListener('click', (e) => { if (e && e.stopPropagation) e.stopPropagation(); setSwapped(false); });
		L.tag = document.createElement('span');
		L.tag.className = 'mj-loupe-tag';
		L.bar = document.createElement('div');
		L.bar.className = 'mj-hud mj-loupe-bar';
		L.bar.appendChild(button('whole', 'Whole picture of the other camera',
			'M3 5.5A1.5 1.5 0 0 1 4.5 4h11A1.5 1.5 0 0 1 17 5.5v9a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5zM7 8h6v4H7z',
			() => setWhole(!L.whole)));
		L.bar.appendChild(button('swap', 'Swap: the other camera fills the screen, this one becomes the inset',
			'M4 7h10l-3-3M16 13H6l3 3', () => setSwapped(!L.swapped)));
		L.bar.appendChild(button('fullscreen', 'Full screen',
			'M3 7.4V3h4.4M16.9 7.4V3h-4.4M3 12.6V17h4.4M16.9 12.6V17h-4.4', fullscreen));
		L.bar.appendChild(button('popout', 'Pop the video out into its own window',
			'M3 5.5A1.5 1.5 0 0 1 4.5 4h11A1.5 1.5 0 0 1 17 5.5v9a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5zM9 9h6v5H9z', popOut));
		L.bar.appendChild(button('close', 'Close (Esc)', 'M5 5l10 10M15 5L5 15', closeLoupe));
		L.grip = document.createElement('div');
		L.grip.className = 'mj-loupe-grip';
		L.grip.title = 'Drag to resize';
		L.el.appendChild(L.host);
		L.el.appendChild(L.still);
		L.el.appendChild(L.inset);
		L.el.appendChild(L.bar);
		L.el.appendChild(L.tag);
		L.el.appendChild(L.grip);
		L.el.addEventListener('dblclick', (e) => {
			if (e && e.target && e.target.closest && e.target.closest('.mj-loupe-bar, .mj-loupe-inset')) return;
			setSwapped(!L.swapped);
		});
		stage.appendChild(L.el);
	}

	function parseSize(s) {
		const m = typeof s === 'string' ? /^(\d+)x(\d+)$/.exec(s) : null;
		return m && +m[1] > 0 && +m[2] > 0 ? { w: +m[1], h: +m[2] } : null;
	}
	function parseRect(s) {
		const m = typeof s === 'string' ? /^(\d+)x(\d+)x(\d+)x(\d+)$/.exec(s) : null;
		return m && +m[3] > 0 && +m[4] > 0 ? { x: +m[1], y: +m[2], w: +m[3], h: +m[4] } : null;
	}

	/* The peer's picture as this page has it: the decoded frame when the
	 * player has one, else the size the calibration row declared. The
	 * rectangle is in the declared size's pixels, so it is scaled when the
	 * decoder produced something else. */
	function peerFrame() {
		return L.frame || L.size || null;
	}
	function peerRectInFrame() {
		const f = peerFrame(), r = L.peerRect;
		if (!f || !r) return null;
		const s = L.size || f;
		const ax = f.w / s.w, ay = f.h / s.h;
		return { x: r.x * ax, y: r.y * ay, w: r.w * ax, h: r.h * ay };
	}

	/* Where the loupe is on the stage: the box you drew, or the whole stage
	 * when swapped. */
	function loupeBox() {
		if (L.swapped) return { x: 0, y: 0, w: stage.clientWidth, h: stage.clientHeight };
		return L.box;
	}

	/* Position the loupe, and inside it the player's stage, so the part of
	 * the peer's picture you asked for fills the box (cover), or the whole of
	 * it fits (contain). What the player draws is the whole frame; the crop
	 * is the box's edge. */
	function layout() {
		if (!L.el || !L.box) return;
		const b = loupeBox();
		L.el.classList.toggle('mj-loupe-cramped', b.w < LOUPE_CRAMPED_W || b.h < LOUPE_CRAMPED_H);
		const st = L.el.style;
		st.left = b.x + 'px';
		st.top = b.y + 'px';
		st.width = b.w + 'px';
		st.height = b.h + 'px';
		const f = peerFrame(), r = peerRectInFrame();
		const inner = L.handle ? L.handle.stage : null;
		if (!inner || !f) return;
		let k, left, top;
		if (L.whole || !r) {
			k = Math.min(b.w / f.w, b.h / f.h);
			left = (b.w - f.w * k) / 2;
			top = (b.h - f.h * k) / 2;
		} else {
			k = Math.max(b.w / r.w, b.h / r.h);
			left = -(r.x * k) + (b.w - r.w * k) / 2;
			top = -(r.y * k) + (b.h - r.h * k) / 2;
		}
		const s = inner.style;
		s.width = (f.w * k).toFixed(2) + 'px';
		s.height = (f.h * k).toFixed(2) + 'px';
		s.left = left.toFixed(2) + 'px';
		s.top = top.toFixed(2) + 'px';
	}

	function tag() {
		if (!L.tag) return;
		const what = L.lost ? 'snapshots' : L.playing ? 'LIVE' : 'connecting…';
		L.tag.textContent = what + ' · ' + L.peer + (L.whole ? ' · whole picture' : '');
		L.tag.classList.toggle('mj-loupe-live', !!L.playing && !L.lost);
	}

	/* The configuration the embedded player reads: the peer's codec once its
	 * stream said, else assumed H.265 so the software rung is on the ladder;
	 * no sub channel, because the point of the loupe is detail; this camera's
	 * ICE settings, which are the LAN's. */
	function peerConfig() {
		const mine = typeof mjConfigNow === 'function' ? mjConfigNow() : null;
		return {
			video0: { codec: L.codec || 'h265' },
			video1: { enabled: false },
			webrtc: mine && mine.webrtc ? mine.webrtc : {},
		};
	}

	function mountPlayer() {
		if (L.handle || !L.sess) return;
		const P = window.MajesticPreview;
		if (!P || typeof P.mount !== 'function') { fallbackToStills(); return; }
		L.handle = P.mount(L.host, {
			config: peerConfig,
			where: 'peer',
			picker: false, snapshot: false, fullscreen: false, inline: true,
			origin: () => (L.sess ? L.sess.url : ''),
			session: () => (L.sess ? L.sess.id : ''),
			onFrame: (w, h, codec) => {
				L.frame = w > 0 && h > 0 ? { w: w, h: h } : null;
				if (codec) L.codec = String(codec);
				layout();
			},
			onPlaying: () => { L.playing = true; L.lost = false; stopStills(); tag(); },
			onLost: () => { L.playing = false; fallbackToStills(); },
		});
		if (!L.handle) { fallbackToStills(); return; }
		if (L.handle.stream && L.handle.stream() !== 0 && L.handle.setStream) L.handle.setStream(0);
		layout();
		tag();
	}

	function unmountPlayer() {
		if (L.handle && L.handle.destroy) { try { L.handle.destroy(); } catch (e) {} }
		L.handle = null;
		L.frame = null;
		L.playing = false;
	}

	/* No video: the peer's snapshot, cropped to the rectangle, once a second.
	 * A frozen picture that reads as live is the one dangerous thing here,
	 * so the tag says "snapshots" the whole time. */
	function fallbackToStills() {
		L.lost = true;
		tag();
		if (!L.still || L.stillTimer) return;
		L.still.hidden = false;
		const poll = () => {
			if (!L.sess || !L.peerRect) return;
			const r = L.whole ? null : L.peerRect;
			L.still.src = L.sess.url + '/image.jpg?' +
				(r ? 'crop=' + r.x + 'x' + r.y + 'x' + r.w + 'x' + r.h + '&' : '') +
				'session=' + encodeURIComponent(L.sess.id) + '&t=' + Date.now().toString(36);
		};
		poll();
		L.stillTimer = setInterval(poll, STILL_MS);
	}
	function stopStills() {
		if (L.stillTimer) { clearInterval(L.stillTimer); L.stillTimer = null; }
		if (L.still) { L.still.hidden = true; L.still.removeAttribute && L.still.removeAttribute('src'); }
		L.lost = false;
	}

	/* ---- the session on the peer ------------------------------------------ */

	/* Ask this camera for a way in to the peer. Resolves true with L.sess set,
	 * or false having said why -- and, when the answer is "not paired", having
	 * offered pairing, after which `retry` runs. */
	async function ensureSession(peer, retry) {
		let res = null, body = null;
		try {
			res = await api(PEER + '?peer=' + encodeURIComponent(peer), { credentials: 'same-origin' });
			try { body = await res.json(); } catch (e) { body = null; }
		} catch (e) { res = null; }
		if (!res) { say('could not reach the camera'); return false; }
		if (res.ok && body && typeof body.session === 'string' && typeof body.url === 'string') {
			L.sess = { url: body.url.replace(/\/+$/, ''), id: body.session, expires: body.expires | 0 };
			if (!L.size) L.size = parseSize(body.size);
			scheduleRefresh(peer);
			return true;
		}
		if (res.status === 409 && body && body.paired === false) {
			offerPairing(peer, retry, typeof body.url === 'string' && /^https?:\/\//.test(body.url) ? body.url : '');
			return false;
		}
		say((body && body.reason) || ('the camera could not reach ' + peer + ' (' + res.status + ')'));
		return false;
	}

	/* The session is good for a quarter of an hour; a fresh one is fetched
	 * before it runs out so a reconnect never carries a dead one. */
	function scheduleRefresh(peer) {
		if (L.sessTimer) clearTimeout(L.sessTimer);
		const ms = Math.max(30, (L.sess.expires || 900) * 0.8) * 1000;
		L.sessTimer = setTimeout(async () => {
			L.sessTimer = null;
			if (!loupeOpen()) return;
			const ok = await ensureSession(peer, () => {});
			if (!ok) closeLoupe();
		}, ms);
	}

	/* ---- opening, moving, closing ----------------------------------------- */

	async function ask(rect) {
		const peer = peerName();
		if (!peer) return null;
		let res, body = null;
		try {
			res = await api(MAP + '?peer=' + encodeURIComponent(peer) + '&rect=' + rect, { credentials: 'same-origin' });
			if (res.ok) body = await res.json();
		} catch (e) { res = null; }
		if (!res) { say('could not reach the camera'); return null; }
		if (!res.ok || !body || typeof body.rect !== 'string') {
			say(res.status === 404 ? 'this camera is not calibrated against ' + peer
				: res.status === 400 ? 'that rectangle lands nowhere in ' + peer + '’s picture'
					: 'the camera could not answer (' + (res.status || '?') + ')');
			return null;
		}
		return { peer: peer, rect: parseRect(body.rect), size: body.row ? parseSize(body.row.size) : null };
	}

	async function openLoupe(b, rect) {
		const my = ++gen;
		const a = await ask(rect);
		if (my !== gen || !a || !a.rect) return;
		buildLoupe();
		L.peer = a.peer;
		L.box = b;
		L.rect = rect;
		L.peerRect = a.rect;
		if (a.size) L.size = a.size;
		if (!doors.peer) {
			say('this camera cannot fetch ' + a.peer + '’s picture; its majestic predates the feature');
			return;
		}
		const retry = () => openLoupe(b, rect);
		if (!L.sess && !(await ensureSession(a.peer, retry))) return;
		if (my !== gen) return;
		clearNote();
		L.el.hidden = false;
		layout();
		mountPlayer();
		tag();
		/* Disarming after the drag stopped the outline while this answer was
		 * in flight; a loupe is a reason to keep drawing it. */
		outlineOn(true);
	}

	/* The rectangle moved or grew: the peer is asked where it lands now; the
	 * session and the player stay. */
	async function reframe() {
		await geometryFresh();
		const m = toMain(L.box);
		if (!m.rect) { say(m.why); return; }
		const my = ++gen;
		const a = await ask(m.rect);
		if (my !== gen || !a || !a.rect) return;
		L.rect = m.rect;
		L.peerRect = a.rect;
		if (a.size) L.size = a.size;
		clearNote();
		layout();
		if (L.lost) { stopStills(); fallbackToStills(); }
	}

	function closeLoupe() {
		if (!L.el) return;
		setSwapped(false);
		unmountPlayer();
		stopStills();
		if (L.sessTimer) { clearTimeout(L.sessTimer); L.sessTimer = null; }
		L.sess = null;
		L.el.hidden = true;
		L.box = null;
		L.peerRect = null;
		L.whole = false;
		L.el.classList.remove('mj-loupe-whole');
		outlineOn(armed);
	}

	function setWhole(on) {
		L.whole = !!on;
		if (L.el) L.el.classList.toggle('mj-loupe-whole', L.whole);
		layout();
		tag();
		if (L.lost) { stopStills(); fallbackToStills(); }
	}

	/* Swapped: the peer fills the stage and this camera becomes the inset, a
	 * canvas painted from this page's own live picture with the outline and
	 * the rectangle on it, so the context you drew in stays in view. Click
	 * the inset, double-click the picture, or Esc to swap back. */
	function setSwapped(on) {
		on = !!on;
		if (!L.el || L.swapped === on) return;
		L.swapped = on;
		L.el.classList.toggle('mj-loupe-swapped', on);
		stage.classList.toggle('mj-peer-swapped', on);
		if (on) {
			L.inset.hidden = false;
			drawInset();
			L.insetTimer = setInterval(drawInset, INSET_MS);
		} else {
			if (L.insetTimer) { clearInterval(L.insetTimer); L.insetTimer = null; }
			L.inset.hidden = true;
		}
		layout();
	}

	function liveMedia() {
		const els = stage.querySelectorAll ? stage.querySelectorAll('.mj-stage-media') : [];
		for (let i = 0; i < els.length; i++) {
			const e = els[i];
			if (e.style && e.style.display === 'none') continue;
			if (e.tagName === 'VIDEO' && e.readyState >= 2) return e;
			if (e.tagName === 'CANVAS') return e;
		}
		return null;
	}

	function drawInset() {
		const c = L.inset;
		if (!c || c.hidden || !c.getContext) return;
		const p = placement();
		const media = liveMedia();
		if (!p || !media) return;
		const fw = p.v.frame.w, fh = p.v.frame.h;
		const cw = Math.max(1, Math.round(c.clientWidth || 320));
		const ch = Math.max(1, Math.round(cw * fh / fw));
		if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
		const ctx = c.getContext('2d');
		if (!ctx) return;
		try { ctx.drawImage(media, 0, 0, cw, ch); } catch (e) { return; }
		/* Main-channel pixels onto the inset: shown-stream pixels through the
		 * map, then scaled to the canvas. */
		const k = p.k, sx = cw / fw, sy = ch / fh;
		const at = (x, y) => [(k.kx * x + k.ox) * sx, (k.ky * y + k.oy) * sy];
		if (quad) {
			ctx.beginPath();
			quad.forEach((q, i) => { const [x, y] = at(q[0], q[1]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
			ctx.closePath();
			ctx.fillStyle = 'rgba(92, 112, 232, 0.14)';
			ctx.fill();
			ctx.setLineDash([5, 3]);
			ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
			ctx.lineWidth = 1;
			ctx.stroke();
			ctx.setLineDash([]);
		}
		const r = parseRect(L.rect);
		if (r) {
			const [x0, y0] = at(r.x, r.y), [x1, y1] = at(r.x + r.w, r.y + r.h);
			ctx.strokeStyle = '#fff';
			ctx.lineWidth = 1.5;
			ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
		}
	}

	function fullscreen() {
		if (!L.swapped) setSwapped(true);
		if (document.fullscreenElement) return;
		if (stage.requestFullscreen) { try { stage.requestFullscreen().catch(() => {}); } catch (e) {} }
	}

	/* The browser's own picture-in-picture, which floats above every window;
	 * only a <video> can do it, so the software-decode rung and the snapshot
	 * fallback cannot. */
	function popOut() {
		const m = L.handle && L.handle.media ? L.handle.media() : null;
		if (!m || m.tagName !== 'VIDEO' || typeof m.requestPictureInPicture !== 'function') {
			say('this video cannot be popped out in this browser');
			return;
		}
		try { m.requestPictureInPicture().catch(() => say('the browser refused to pop the video out')); } catch (e) {}
	}

	/* Moving and resizing. A press inside the loupe reaches these from the
	 * stage's capture listeners below, which run before the zoom module's
	 * and stop the event there: otherwise the page would start a pan and
	 * capture the pointer, and a click on the toolbar would never land on
	 * its button. A press on the toolbar or the inset starts no grab. */
	let grab = null;
	function inLoupe(e) {
		return loupeOpen() && e.target && e.target.closest && !!e.target.closest('#mj-peer-loupe');
	}
	function loupeDown(e) {
		if (L.swapped || !L.box) return;
		if (e.button != null && e.button > 0) return;
		if (e.target && e.target.closest && e.target.closest('.mj-loupe-bar, .mj-loupe-inset')) return;
		const resize = !!(e.target && e.target.closest && e.target.closest('.mj-loupe-grip'));
		grab = { id: e.pointerId, x: e.clientX, y: e.clientY, box: Object.assign({}, L.box), resize: resize };
		try { L.el.setPointerCapture(e.pointerId); } catch (err) {}
	}
	function loupeMove(e) {
		if (!grab || e.pointerId !== grab.id) return;
		const dx = e.clientX - grab.x, dy = e.clientY - grab.y;
		const p = picRect();
		const b = grab.box;
		let nb;
		if (grab.resize) {
			nb = { x: b.x, y: b.y, w: clamp(b.w + dx, 24, p.r - b.x), h: clamp(b.h + dy, 24, p.b - b.y) };
		} else {
			nb = { x: clamp(b.x + dx, p.x, p.r - b.w), y: clamp(b.y + dy, p.y, p.b - b.h), w: b.w, h: b.h };
		}
		L.box = nb;
		layout();
	}
	function loupeUp(e, commit) {
		if (!grab || e.pointerId !== grab.id) return;
		try { L.el.releasePointerCapture(e.pointerId); } catch (err) {}
		const moved = grab.box.x !== L.box.x || grab.box.y !== L.box.y || grab.box.w !== L.box.w || grab.box.h !== L.box.h;
		grab = null;
		if (commit && moved) reframe();
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
		outlineOn(armed || loupeOpen());
	}
	box.addEventListener('change', () => setArmed(box.checked));
	if (pick) pick.addEventListener('change', () => { quad = null; if (armed || loupeOpen()) askOutline(); });

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

	/* The drawn box, grown around its centre to the loupe's minimum where it
	 * is smaller, and kept on the picture. The rectangle asked of the camera
	 * is this one, so what the loupe shows is what its box says. */
	function roomy(b) {
		const p = picRect();
		let w = Math.max(b.w, LOUPE_MIN_W), h = Math.max(b.h, LOUPE_MIN_H);
		w = Math.min(w, p.r - p.x); h = Math.min(h, p.b - p.y);
		let x = b.x + b.w / 2 - w / 2, y = b.y + b.h / 2 - h / 2;
		x = clamp(x, p.x, p.r - w); y = clamp(y, p.y, p.b - h);
		return { x: x, y: y, w: w, h: h };
	}

	function bandRect(e) {
		const s = stage.getBoundingClientRect(), p = picRect();
		const x = clamp(e.clientX - s.left, p.x, p.r), y = clamp(e.clientY - s.top, p.y, p.b);
		const x0 = clamp(drawing.x, p.x, p.r), y0 = clamp(drawing.y, p.y, p.b);
		return { x: Math.min(x0, x), y: Math.min(y0, y), w: Math.abs(x - x0), h: Math.abs(y - y0) };
	}

	function down(e) {
		if (inLoupe(e)) { e.stopImmediatePropagation(); loupeDown(e); return; }
		if (!armed) return;
		if (e.button != null && e.button > 0) return;
		if (e.target && e.target.closest && e.target.closest(CHROME)) return;
		if (drawing) return;
		e.stopImmediatePropagation();
		const r = stage.getBoundingClientRect();
		drawing = { id: e.pointerId, x: e.clientX - r.left, y: e.clientY - r.top };
		try { stage.setPointerCapture(e.pointerId); } catch (err) {}
	}
	function move(e) {
		if (grab) { e.stopImmediatePropagation(); loupeMove(e); return; }
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
		if (grab) { e.stopImmediatePropagation(); loupeUp(e, commit); return; }
		if (inLoupe(e)) { e.stopImmediatePropagation(); return; }
		if (!drawing || e.pointerId !== drawing.id) return;
		e.stopImmediatePropagation();
		const b = commit ? bandRect(e) : null;
		try { stage.releasePointerCapture(e.pointerId); } catch (err) {}
		drawing = null;
		/* The same floor as zoom-to-area: below it a drag is a slip or a
		 * click, and neither is a question. */
		const minW = Math.max(16, stage.clientWidth * 0.02);
		const minH = Math.max(16, stage.clientHeight * 0.02);
		const was = loupeOpen();
		if (b && b.w >= minW && b.h >= minH) {
			const rb = roomy(b);
			geometryFresh().then(() => {
				const m = toMain(rb);
				if (m.rect) {
					if (was) closeLoupe();
					openLoupe(rb, m.rect);
				} else {
					say(m.why);
				}
			});
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
		if (loupeOpen() && L.swapped) { setSwapped(false); e.stopPropagation(); return; }
		if (loupeOpen()) { closeLoupe(); e.stopPropagation(); return; }
		if (!note.hidden) { clearNote(); e.stopPropagation(); }
	});

	/* The map is per shown stream and goes stale the moment the viewer changes
	 * channel; dropped first, so a drag arriving before the refresh lands
	 * converts nothing rather than converting wrongly. The loupe stays where
	 * it is on the stage; the outline is laid out again from the new map. */
	window.addEventListener('mj-stream-changed', () => {
		geom = null;
		clearNote();
		learnGeometry().then(placeOutline);
	});

	(async function () {
		const [hasMap, hasPeer, names] = await Promise.all([probe(MAP), probe(PEER), learnPeers()]);
		if (!hasMap || !names.length) return;   /* left hidden */
		doors = { map: true, peer: hasPeer };
		peers = names;
		if (pick) {
			empty(pick);
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

	window.MajesticPeerCrop = {
		toMain: toMain,
		toStage: toStage,
		peers: () => peers.slice(),
		outline: () => (quad ? quad.map((c) => c.slice()) : null),
		loupe: () => ({
			open: loupeOpen(), box: L.box, rect: L.rect, peerRect: L.peerRect,
			whole: L.whole, swapped: L.swapped, playing: L.playing, lost: L.lost,
			session: L.sess ? Object.assign({}, L.sess) : null,
		}),
		layout: layout,
	};
})();
