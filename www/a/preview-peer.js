/* The other camera's picture, laid over this one where it belongs.
 *
 * A camera calibrated against another one that sees the same scene can say
 * where that camera's whole picture lies in its own: the four corners,
 * through the inverse of the calibrated ground-plane homography
 * (GET /api/v1/calibration/coverage). Switch Peer on and that outline is
 * drawn on the live picture, so you know where the other camera looks.
 * Click inside it and the other camera's live video is warped onto exactly
 * that quadrilateral: the same place, the same scale, aligned with this
 * picture on the plane the calibration was measured on, and sharper,
 * because the other camera has many more pixels on it. Click again, or
 * press Esc, and it is gone. Zoom the page as usual and the overlay comes
 * with it, which is where the magnification is.
 *
 * The video comes from the other camera directly, and without a second
 * login: this camera holds a pairing with it (a token, never a password,
 * entered once right here) and brokers a MEDIA-SCOPED session for this page
 * (GET /api/v1/calibration/peer) -- good for that camera's video for a
 * quarter of an hour and for nothing else, carried in the socket's URL
 * because a cookie for one origin never travels to another. The player is
 * mj-preview.js's, mounted off to the side and pointed at that origin, and
 * its whole stage is put in place with one CSS perspective transform. A
 * page whose build lacks it, or a browser that cannot play the stream, gets
 * the other camera's snapshots instead, warped the same way.
 *
 * Its own file, like preview-still.js and preview-roi.js: tests/auto-source
 * and tests/staging run preview-page.js in a bare vm with no layout, no fetch
 * and no canvas, and preview-page.js does not know this exists. While the
 * control is armed its listeners run first, in the capture phase, and watch
 * a press inside the outline: a release within a few pixels of it is a
 * click, and toggles the overlay. The press itself stays the page's
 * throughout, so a drag inside the outline pans, or draws the zoom
 * rectangle, exactly as it does with the control off. Only a double-click
 * is kept from the page there, because two clicks already mean something.
 */
(function () {
	'use strict';

	const $ = (s) => document.querySelector(s);

	const stage = $('#mj-stage');
	const ctl = $('#mj-peer-ctl');
	const box = $('#mj-peer');
	const pick = $('#mj-peer-pick');
	const note = $('#mj-peer-note');
	if (!stage || !ctl || !box || !note) return;

	const COVERAGE = '/api/v1/calibration/coverage';
	const PEER = '/api/v1/calibration/peer';
	const PAIR = '/api/v1/calibration/pair';

	/* Where a press belongs to the control under it rather than to the
	 * picture -- preview-zoom's list, for the same bar. */
	const CHROME = '.mj-bar, .mj-ptz, #mj-stats, #mj-toasts';

	/* The outline is asked of the camera again this often while Peer is on
	 * (the lens may have moved), and everything is laid out again this often
	 * (the viewer may have panned or zoomed). The snapshot fallback polls at
	 * this rate. A press that moves less than this is a click. */
	const OUTLINE_ASK_MS = 5000;
	const PLACE_MS = 250;
	const STILL_MS = 1000;
	const CLICK_SLOP = 6;
	/* The snapshot stays on top this long after the video says it plays: the
	 * software rung paints what it decodes from the first packet, and until
	 * a keyframe arrives that is a grey field, not a picture. A keyframe is
	 * asked for at the same moment, so this is a ceiling, not a delay. */
	const PLAY_GRACE_MS = 1500;

	let peers = [];         /* names the calibration knows, as the camera spelt them */
	let myConfig = null;    /* this camera's configuration, for the peer player's ICE settings */
	let geom = null;        /* null means NOT KNOWN -- never assume 1:1 */
	let geomGen = 0;        /* so an older /api/v1/osd answer cannot overwrite a newer */
	let armed = false;
	let gen = 0;            /* so a slow answer cannot land after a newer one */
	let doors = { coverage: false, peer: false };

	function api(url, init) {
		return typeof apiFetch === 'function'
			? apiFetch(url, init)
			: fetch(url, init);
	}

	/* A door exists when it refuses an empty question with 400. A camera that
	 * answers 404 has no such door. The coverage is what makes the control
	 * worth showing; without the peer door nothing can be fetched and the
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
		myConfig = cfg || null;
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
	 * calibrates in the MAIN channel's pixels, and a corner placed on the sub
	 * stream as though it were the main one lands somewhere else in the scene
	 * while still looking like an answer. */
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

	/* The main channel's pixels to stage pixels: through the camera's map to
	 * the shown stream, scaled by what the decoder actually produced against
	 * what the channel declares (WebRTC may send a smaller picture than
	 * configured), then preview-zoom's placement. */
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
	 * a picture the map does not describe. Anything about to place asks for a
	 * fresh map first; one learning at a time. */
	let learning = null, geomTried = 0;
	function geometryFresh() {
		if (geom && geom.at === shownStream()) return Promise.resolve(true);
		/* Asked again after a failure, but not on every tick: what failed a
		 * moment ago has not changed. */
		if (!geom && !learning && Date.now() - geomTried < 2000) return Promise.resolve(false);
		if (!learning) {
			geomTried = Date.now();
			learning = learnGeometry().then(() => { learning = null; return !!geom; });
		}
		return learning;
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
	 * back. `then` runs once the pairing took. `at` is where the password is
	 * about to go, for the operator to see before typing. */
	function offerPairing(peer, then, at) {
		empty(note);
		const form = document.createElement('form');
		form.className = 'mj-peer-pair';
		const label = document.createElement('span');
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
	let outline = null, outlineDim = null, outlinePoly = null, outlineTag = null;
	let quad = null;            /* main-channel corners of the peer's picture */
	let corners = null;         /* the same, in stage pixels, as last placed */
	let askTimer = null, placeTimer = null, outlineGen = 0, saidCoverage = false;

	function buildOutline() {
		if (outline || typeof document.createElementNS !== 'function') return;
		outline = document.createElementNS(SVG, 'svg');
		outline.setAttribute('class', 'mj-peer-outline');
		outline.setAttribute('id', 'mj-peer-outline');
		outline.setAttribute('aria-hidden', 'true');
		/* Everything but the outline, dimmed a little while the control waits
		 * for a click: the one place a click does anything is the one place
		 * left bright. */
		outlineDim = document.createElementNS(SVG, 'path');
		outlineDim.setAttribute('class', 'mj-peer-dim');
		outlineDim.setAttribute('fill-rule', 'evenodd');
		outlinePoly = document.createElementNS(SVG, 'polygon');
		outlineTag = document.createElementNS(SVG, 'text');
		outline.appendChild(outlineDim);
		outline.appendChild(outlinePoly);
		outline.appendChild(outlineTag);
		showOutline(false);
		stage.appendChild(outline);
	}

	/* An SVG element has no `hidden` property -- HTMLElement's -- and the
	 * attribute set from script is easy to get wrong; the style is what the
	 * browser reads either way. Mirrored onto the property for callers that
	 * ask. */
	function showOutline(on) {
		outline.style.display = on ? '' : 'none';
		outline.hidden = !on;
	}

	function tagText() {
		const name = peerName();
		if (O.on) {
			const what = O.lost ? 'snapshots' : O.playing ? 'LIVE' : 'connecting…';
			const f = peerFrame();
			const only = adaptRefused === 0 ? ' · main stream not served here' : '';
			/* Its magnification, the way the page's chip states its own: the
			 * picture's width on screen against its pixels. */
			const css = shownWidth() / (window.devicePixelRatio || 1);
			const pct = f && css > 0 ? ' · ' + Math.round(100 * css / f.w) + '%' : '';
			return name + ' · ' + what + (f ? ' ' + f.w + '×' + f.h : '') + pct + only + ' · click or Esc to hide';
		}
		return name + ' sees this · click inside to see its picture here';
	}

	/* The outline in stage pixels, from the corners the camera gave and the
	 * placement now; and the overlay with it. */
	/* What was last written into the outline, so a placement that moved
	 * nothing writes nothing: this runs on every view change and every
	 * 250 ms, and an SVG attribute set to the value it already has still
	 * costs a layout. Reads come before writes for the same reason. */
	let placedRing = '', placedDim = '', placedDimClass = '', placedTag = '';
	function placeOutline() {
		if (!outline) return;
		if (!quad || !armed && !O.on) { showOutline(false); corners = null; placeOverlay(); return; }
		if (!geom || geom.at !== shownStream()) {
			/* One placement when the map lands, not one per tick spent
			 * waiting for it -- and none chained when nothing was asked. */
			const first = !learning;
			const p = geometryFresh();
			if (first && learning) p.then(placeOutline);
			return;
		}
		const pts = quad.map((c) => toStage(c[0], c[1]));
		if (pts.some((p) => !p)) { showOutline(false); corners = null; placeOverlay(); return; }
		corners = pts;
		const sw = stage.clientWidth, sh = stage.clientHeight;
		const ring = pts.map((p) => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ');
		const dim = 'M0,0H' + sw + 'V' + sh + 'H0Z M' + ring.replace(/ /g, 'L') + 'Z';
		const dimClass = 'mj-peer-dim' + (O.on ? ' mj-peer-dim-off' : '');
		const tag = tagText();
		if (ring !== placedRing) {
			outlinePoly.setAttribute('points', ring);
			/* Above the outline's top corner -- and inside the stage, which
			 * clips: zoomed into the picture the corner is off the top, and
			 * the tag is the one thing that says whether that picture is
			 * live, so it stays where it can be read. */
			const top = pts.reduce((a, p) => (p.y < a.y ? p : a), pts[0]);
			outlineTag.setAttribute('x', Math.min(Math.max(top.x, 4), Math.max(4, sw - 4)).toFixed(1));
			outlineTag.setAttribute('y', Math.min(Math.max(top.y - 6, 16), Math.max(16, sh - 6)).toFixed(1));
			placedRing = ring;
		}
		if (dim !== placedDim) { outlineDim.setAttribute('d', dim); placedDim = dim; }
		if (dimClass !== placedDimClass) { outlineDim.setAttribute('class', dimClass); placedDimClass = dimClass; }
		if (tag !== placedTag) { outlineTag.textContent = tag; placedTag = tag; }
		showOutline(true);
		placeOverlay();
	}

	/* The 250 ms tick: a placement, and the stream question the placement
	 * feeds. Not one function, because a placement also runs on every view
	 * change, and the question's dwell counts ticks, not pointer moves. */
	function tick() {
		placeOutline();
		adapt();
	}

	async function askOutline() {
		const peer = peerName();
		if (!peer || !doors.coverage) return;
		const my = ++outlineGen;
		let next = null, size = null, answered = false;
		try {
			const res = await api(COVERAGE + '?peer=' + encodeURIComponent(peer), { credentials: 'same-origin' });
			if (res.ok) {
				answered = true;
				const j = await res.json();
				if (j && Array.isArray(j.quad) && j.quad.length === 4 &&
					j.quad.every((c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]))) {
					next = j.quad;
					size = j.row ? parseSize(j.row.size) : null;
				}
			} else if (res.status >= 400 && res.status < 500) {
				/* The camera's word: no coverage for this peer. Said once, the
				 * first time, so the operator knows why nothing is drawn. */
				answered = true;
				let body = null;
				try { body = await res.json(); } catch (e) { body = null; }
				if (!saidCoverage) {
					saidCoverage = true;
					say((body && body.reason) || ('this camera has no calibration for ' + peer));
				}
			}
			/* Anything else -- a 5xx, a body that cannot be read -- is the
			 * camera failing to answer, not answering no: the last outline
			 * stands, and with it the overlay and the zoom it allows. */
		} catch (e) { answered = false; }
		if (my !== outlineGen) return;
		if (answered) quad = next;
		if (size) O.size = size;
		placeOutline();
	}

	function outlineOn(on) {
		buildOutline();
		if (on) {
			if (!askTimer) { askOutline(); askTimer = setInterval(askOutline, OUTLINE_ASK_MS); }
			if (!placeTimer) placeTimer = setInterval(tick, PLACE_MS);
		} else {
			if (askTimer) { clearInterval(askTimer); askTimer = null; }
			if (placeTimer) { clearInterval(placeTimer); placeTimer = null; }
			quad = null;
			placeOutline();
		}
	}

	/* Is a stage point inside the outline? Ray casting over the four
	 * corners; false until the outline has been placed. */
	function inside(x, y) {
		if (!corners) return false;
		let hit = false;
		for (let i = 0, j = 3; i < 4; j = i++) {
			const a = corners[i], b = corners[j];
			if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) hit = !hit;
		}
		return hit;
	}

	/* ---- the overlay: the other camera's picture on its quadrilateral ------ */

	const O = {
		el: null, host: null, still: null,
		on: false, peer: '',
		size: null,                    /* the peer's declared picture {w,h}, from the row */
		recovered: false,              /* a fresh session was already asked for, this overlay */
		frame: null, codec: '',        /* what the peer's decoder produced */
		handle: null, playing: false, lost: false,
		sess: null, sessTimer: null, stillTimer: null,
		pending: false,                /* being switched on: questions in flight */
		matrix: '',                    /* the transform last applied, for the tests */
	};

	function parseSize(s) {
		const m = typeof s === 'string' ? /^(\d+)x(\d+)$/.exec(s) : null;
		return m && +m[1] > 0 && +m[2] > 0 ? { w: +m[1], h: +m[2] } : null;
	}

	function buildOverlay() {
		if (O.el) return;
		O.el = document.createElement('div');
		O.el.id = 'mj-peer-overlay';
		O.el.className = 'mj-peer-overlay';
		O.el.hidden = true;
		O.host = document.createElement('div');
		O.host.className = 'mj-peer-host';
		O.still = document.createElement('img');
		O.still.className = 'mj-peer-still';
		O.still.alt = '';
		O.still.hidden = true;
		O.el.appendChild(O.host);
		O.el.appendChild(O.still);
		stage.appendChild(O.el);
	}

	/* The projective map from a W x H picture to the four stage corners --
	 * (0,0) to the first, (W,0) to the second, (W,H) to the third, (0,H) to
	 * the fourth, the order the camera gives the peer's corners in -- as the
	 * sixteen numbers of a CSS matrix3d with the origin at the top left.
	 * Heckbert's square-to-quad, then the picture's size folded in. Null for
	 * a quadrilateral that has collapsed. */
	function quadTransform(w, h, p) {
		if (!(w > 0) || !(h > 0) || !p || p.length !== 4) return null;
		const x0 = p[0].x, y0 = p[0].y, x1 = p[1].x, y1 = p[1].y, x2 = p[2].x, y2 = p[2].y, x3 = p[3].x, y3 = p[3].y;
		const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
		const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
		let g = 0, hh = 0;
		if (dx3 !== 0 || dy3 !== 0) {
			const det = dx1 * dy2 - dx2 * dy1;
			if (!det) return null;
			g = (dx3 * dy2 - dx2 * dy3) / det;
			hh = (dx1 * dy3 - dx3 * dy1) / det;
		}
		const a = x1 - x0 + g * x1, b = x3 - x0 + hh * x3, c = x0;
		const d = y1 - y0 + g * y1, e = y3 - y0 + hh * y3, f = y0;
		const m = [a / w, d / w, 0, g / w, b / h, e / h, 0, hh / h, 0, 0, 1, 0, c, f, 0, 1];
		if (m.some((v) => !Number.isFinite(v))) return null;
		if (Math.abs(a * e - b * d) < 1e-9) return null;
		/* Full precision: the perspective terms are tiny and a rounded one
		 * moves a far corner by pixels. */
		return 'matrix3d(' + m.join(',') + ')';
	}

	/* The peer's picture as this page has it: the decoded frame when the
	 * player has one, else the stream it is asked for, else the size the
	 * calibration row declared. All of them are the same picture at
	 * different sizes -- the transform is per size -- so any of them places
	 * the snapshot before the video says. */
	function peerFrame() {
		if (O.frame) return O.frame;
		const s = streamOf(currentStream());
		if (s && s.w > 0 && s.h > 0) return { w: s.w, h: s.h };
		return O.size || null;
	}

	/* How far the page may zoom while the other camera's picture is up: the
	 * page's own ceiling is 3x of ITS pixels, and the other camera's picture
	 * occupies a few hundred of them, so at that ceiling it is shown below
	 * its native size -- no magnification at all, where its own page reaches
	 * 3x. So 3x of the peer picture's pixels, in this frame's terms: the
	 * outline's top edge in the served stream's pixels, against the peer
	 * frame's width. Read by the zoom module at every zoom, so a switch
	 * from the peer's sub stream to its main raises it on the spot. */
	function peerCeiling() {
		if (!O.on || !quad) return 0;
		const p = placement(), f = peerFrame();
		if (!p || !f || !(f.w > 0)) return 0;
		const q = quad.map((c) => ({ x: p.k.kx * c[0], y: p.k.ky * c[1] }));
		const w = edgeWidth(q[0], q[1], q[2], q[3]);
		return w > 0 ? 3 * f.w / w : 0;
	}
	function setCeiling(on) {
		const z = window.MajesticZoom;
		if (z && typeof z.setCeiling === 'function') z.setCeiling(on ? peerCeiling : null);
	}

	/* Put the peer's picture on the outline: the player's stage (and the
	 * snapshot behind it) sized to the frame, at the stage's origin, with the
	 * one transform that lands its corners on the outline's. */
	function placeOverlay() {
		if (!O.el) return;
		const f = peerFrame();
		const show = O.on && !!corners && !!f;
		O.el.hidden = !show;
		if (!show) return;
		const t = quadTransform(f.w, f.h, corners);
		if (!t) { O.el.hidden = true; return; }
		O.matrix = t;
		/* Written once per value, per element: a style set to what it
		 * already holds is still a fresh transform on a promoted layer. The
		 * key lives on the element, so a player mounted anew is placed anew. */
		const key = f.w + 'x' + f.h + '|' + t;
		[O.handle ? O.handle.stage : null, O.still].forEach((el) => {
			if (!el || el.mjPeerPlaced === key) return;
			el.mjPeerPlaced = key;
			const s = el.style;
			s.width = f.w + 'px';
			s.height = f.h + 'px';
			s.transformOrigin = '0 0';
			s.transform = t;
		});
	}

	/* Which of the peer's streams to watch. The sub stream when the peer has
	 * one in H.264 -- every browser decodes that natively, and 1280x720 is
	 * more than an overlay a few hundred pixels wide can show, while a
	 * 2592x1944 H.265 main stream through the software rung is eight frames
	 * a second of mostly grey in a browser without hardware HEVC -- for as
	 * long as the picture on screen is narrower than the sub stream is. Zoom
	 * in past that and the sub stream is the thing being upscaled, so the
	 * main stream takes over; zoom back out and the sub returns. Hysteresis
	 * either side and a dwell of a few placements, so a wheel gesture does not
	 * switch back and forth on its way. The main stream alone when there is
	 * nothing else, and the codec the peer named for each, so the transport
	 * ladder knows what it is being handed.
	 *
	 * The ask is a preference, not an order: the peer can answer it with the
	 * other channel -- a codec this browser's WebRTC cannot take, a channel
	 * not there right now -- and the player follows what it was served. A
	 * channel the player was moved off after being asked for it is that
	 * answer, and it stands for as long as this player is mounted; asking
	 * again would reconnect once a second for ever, and never play. */
	const ADAPT_UP = 1.0, ADAPT_DOWN = 0.8, ADAPT_TICKS = 3;
	let adaptWant = -1, adaptTicks = 0, adaptAsked = -1, adaptRefused = -1;
	function streamOf(id) { return O.sess && O.sess.streams ? O.sess.streams.find((s) => s.id === id) : null; }
	function subNative() { const s = streamOf(1); return !!(s && s.codec === 'h264'); }
	function currentStream() { return O.handle && O.handle.stream ? O.handle.stream() : (subNative() ? 1 : 0); }
	/* The peer picture's width on screen, in device pixels: its top edge as
	 * placed, which is what the zoom scales. */
	/* The longer of the picture's two horizontal edges: under a perspective
	 * they differ, and the longer is where the pixels are. */
	function edgeWidth(a, b, c, d) {
		return Math.max(Math.hypot(b.x - a.x, b.y - a.y), Math.hypot(c.x - d.x, c.y - d.y));
	}
	function shownWidth() {
		if (!corners) return 0;
		return edgeWidth(corners[0], corners[1], corners[2], corners[3]) * (window.devicePixelRatio || 1);
	}
	function wantStream() {
		const sub = streamOf(1), main = streamOf(0);
		const cur = currentStream();
		let want = cur;
		if (!subNative()) want = 0;
		else if (!main) want = 1;
		else {
			const w = shownWidth();
			if (cur === 1 && sub.w > 0 && w > sub.w * ADAPT_UP) want = 0;
			else if (cur === 0 && sub.w > 0 && w > 0 && w < sub.w * ADAPT_DOWN) want = 1;
		}
		/* Whatever the rule says, a channel the peer refused is not asked
		 * for again: the answer stands, and the page follows it. */
		return want === adaptRefused ? cur : want;
	}
	function askStream(want) {
		adaptAsked = want;
		O.handle.setStream(want);
	}
	function adapt() {
		if (!O.on || !O.handle || !O.handle.setStream || !O.handle.stream) return;
		const cur = O.handle.stream();
		if (adaptAsked >= 0 && cur !== adaptAsked) {
			adaptRefused = adaptAsked;
			adaptAsked = -1;
			placeOutline();
			return;
		}
		const want = wantStream();
		if (want === cur) { adaptWant = -1; adaptTicks = 0; return; }
		if (want !== adaptWant) { adaptWant = want; adaptTicks = 0; }
		if (++adaptTicks < ADAPT_TICKS) return;
		adaptTicks = 0;
		adaptWant = -1;
		/* The switch reconnects; the snapshot bridges it, as at switch-on,
		 * and the last decoded size is the old stream's. */
		O.frame = null;
		O.playing = false;
		showStillOnce();
		askStream(want);
		placeOverlay();
	}

	/* The configuration the embedded player reads: the peer's codecs as it
	 * named them (else H.265 assumed, so the software rung is on the ladder),
	 * whether there is a sub stream to prefer, and this camera's ICE
	 * settings, which are the LAN's. */
	function peerConfig() {
		const main = streamOf(0), sub = streamOf(1);
		return {
			video0: { codec: (main && main.codec) || O.codec || 'h265' },
			video1: { enabled: subNative(), codec: (sub && sub.codec) || 'h264' },
			webrtc: myConfig && myConfig.webrtc ? myConfig.webrtc : {},
		};
	}

	let playSeq = 0;
	function mountPlayer() {
		if (O.handle || !O.sess) return;
		const P = window.MajesticPreview;
		if (!P || typeof P.mount !== 'function') { fallbackToStills(); return; }
		O.handle = P.mount(O.host, {
			config: peerConfig,
			where: 'peer',
			picker: false, snapshot: false, fullscreen: false, inline: true,
			/* The other camera's WebRTC refusing is nothing about this
			 * browser's transport: it must not park THIS page on MSE. */
			demote: false,
			origin: () => (O.sess ? O.sess.url : ''),
			session: () => (O.sess ? O.sess.id : ''),
			onFrame: (w, h, codec) => {
				const before = O.frame ? O.frame.w : 0;
				O.frame = w > 0 && h > 0 ? { w: w, h: h } : null;
				if (codec) O.codec = String(codec);
				placeOverlay();
				/* A smaller frame is a lower ceiling, and a view already past
				 * it is pulled back now rather than on the next wheel notch. */
				if (O.on && (O.frame ? O.frame.w : 0) !== before) setCeiling(true);
			},
			onPlaying: () => {
				O.playing = true;
				O.lost = false;
				/* A loss after a picture is a new incident, with its own
				 * fresh session to ask for. */
				O.recovered = false;
				if (O.stillTimer) { clearInterval(O.stillTimer); O.stillTimer = null; }
				/* A fresh keyframe now, so the picture under the snapshot is a
				 * picture by the time the snapshot goes. */
				try {
					const p = O.handle && O.handle.player ? O.handle.player() : null;
					if (p && typeof p.requestIdr === 'function') p.requestIdr();
				} catch (e) {}
				/* Keyed to this play, not to the overlay: a stream switch or a
				 * remount within the grace would otherwise have the OLD play's
				 * timer take the snapshot off the NEW stream's first frames. */
				const my = ++playSeq;
				setTimeout(() => { if (my === playSeq && O.on && O.playing) stopStills(); }, PLAY_GRACE_MS);
				placeOutline();
			},
			onLost: () => { O.playing = false; recover(); },
		});
		if (!O.handle) { fallbackToStills(); return; }
		/* The player starts on the sub stream when the configuration offers
		 * one and nothing was remembered; said explicitly here -- for the
		 * size on screen right now -- so a remembered choice from another
		 * page never decides for this one. */
		adaptWant = -1;
		adaptTicks = 0;
		adaptAsked = -1;
		adaptRefused = -1;
		const want = wantStream();
		if (O.handle.stream && O.handle.stream() !== want && O.handle.setStream) askStream(want);
		placeOverlay();
	}

	/* The player ran out of transports. On a pair like this the usual
	 * reason is not the network: the peer restarted and forgot every session
	 * it had minted, while this camera still answers the old one from its
	 * cache and this page still holds it, both with minutes left on their
	 * clocks. So, once per overlay, a fresh session is asked for -- the
	 * camera drops its cache on that word -- and the player is mounted again
	 * on it. A second loss is a real one: the snapshots, honestly labelled
	 * (they ride the same session, so they too are good only once it is). */
	async function recover() {
		if (O.recovered || !O.on || !O.peer) { fallbackToStills(); return; }
		O.recovered = true;
		const my = gen, peer = O.peer;
		const s = await ensureSession(peer, afterPairing(peer), true, () => my === gen);
		if (my !== gen || !O.on) return;
		if (!s) { fallbackToStills(); return; }
		O.sess = s;
		scheduleRefresh(peer);
		unmountPlayer();
		showStillOnce();
		mountPlayer();
		placeOutline();
	}

	function unmountPlayer() {
		if (O.handle && O.handle.destroy) { try { O.handle.destroy(); } catch (e) {} }
		O.handle = null;
		O.frame = null;
		O.playing = false;
		/* The stream question's state was this player's. */
		adaptWant = -1;
		adaptTicks = 0;
		adaptAsked = -1;
		adaptRefused = -1;
	}

	function stillUrl() {
		return O.sess.url + '/image.jpg?session=' + encodeURIComponent(O.sess.id) + '&t=' + Date.now().toString(36);
	}

	/* The peer's snapshot, warped the same way: once at switch-on, so there
	 * is a picture within a second while the video connects, and once a
	 * second for as long as no video plays. A frozen picture that reads as
	 * live is the one dangerous thing here, so the tag says which it is. */
	function showStillOnce() {
		if (!O.still || !O.sess) return;
		O.still.src = stillUrl();
		O.still.hidden = false;
	}
	function fallbackToStills() {
		if (!O.on) return;
		O.lost = true;
		placeOutline();
		if (!O.still || O.stillTimer) return;
		O.still.hidden = false;
		const poll = () => { if (O.sess) O.still.src = stillUrl(); };
		poll();
		O.stillTimer = setInterval(poll, STILL_MS);
	}
	function stopStills() {
		if (O.stillTimer) { clearInterval(O.stillTimer); O.stillTimer = null; }
		if (O.still) { O.still.hidden = true; if (O.still.removeAttribute) O.still.removeAttribute('src'); }
		O.lost = false;
	}

	/* ---- the session on the peer ------------------------------------------ */

	/* Ask this camera for a way in to the peer. Resolves the session -- {url,
	 * id, expires (seconds, or null where the camera did not say), size} --
	 * or null having said why; when the answer is "not paired", having
	 * offered pairing, after which `retry` runs. Writes nothing into the
	 * overlay: the caller decides whether its operation is still the current
	 * one by the time this answers, and only then keeps the session. */
	async function ensureSession(peer, retry, fresh, still) {
		let res = null, body = null;
		try {
			res = await api(PEER + '?peer=' + encodeURIComponent(peer) + (fresh ? '&fresh=1' : ''), { credentials: 'same-origin' });
			try { body = await res.json(); } catch (e) { body = null; }
		} catch (e) { res = null; }
		/* `still` says whether the ask is still wanted by the time it is
		 * answered: an ask cancelled by Esc offers no pairing form and says
		 * nothing, whatever came back. */
		const wanted = !still || still();
		if (!res) { if (wanted) say('could not reach the camera'); return null; }
		if (res.ok && body && typeof body.session === 'string' && typeof body.url === 'string') {
			const expires = Number.isFinite(body.expires) && body.expires > 0 ? body.expires : null;
			const at = Date.now();
			const streams = Array.isArray(body.streams)
				? body.streams.filter((s) => s && Number.isFinite(s.id) && typeof s.codec === 'string')
					.map((s) => ({ id: s.id | 0, codec: s.codec, w: s.width | 0, h: s.height | 0 }))
				: [];
			return { url: body.url.replace(/\/+$/, ''), id: body.session, expires: expires, at: at, size: parseSize(body.size), streams: streams };
		}
		if (!wanted) return null;
		if (res.status === 409 && body && body.paired === false) {
			offerPairing(peer, retry, typeof body.url === 'string' && /^https?:\/\//.test(body.url) ? body.url : '');
			return null;
		}
		say((body && body.reason) || ('the camera could not reach ' + peer + ' (' + res.status + ')'));
		return null;
	}

	/* What a pairing made from the form leads to. The overlay, if the
	 * control is still armed, the peer is still the one the form was offered
	 * for and nothing is already on its way; with the overlay up on snapshots
	 * -- the peer refused its session and then refused the token -- a fresh
	 * session for it; with the overlay up and playing, nothing. */
	function afterPairing(peer) {
		return () => {
			if (!armed || peerName() !== peer || O.pending) return;
			if (O.on) { if (O.lost) { O.recovered = false; recover(); } return; }
			overlayOn();
		};
	}

	/* A page served over https cannot open a socket, or an image, on an
	 * http camera: the browser refuses mixed content, silently. */
	function mixed(url) {
		return typeof location !== 'undefined' && location.protocol === 'https:' && /^http:/i.test(url);
	}

	/* The session is good for a quarter of an hour (the camera's word, else
	 * assumed); a fresh one is fetched before it runs out so a reconnect never
	 * carries a dead one. The answer is kept only for the overlay that asked. */
	function scheduleRefresh(peer) {
		if (O.sessTimer) clearTimeout(O.sessTimer);
		/* From the session's own age, not from now: a session kept from an
		 * earlier click has already spent some of its quarter-hour. */
		const ttl = (O.sess && O.sess.expires ? O.sess.expires : 900) * 1000;
		const at = O.sess && O.sess.at ? O.sess.at : Date.now();
		const ms = Math.max(30 * 1000, at + ttl * 0.8 - Date.now());
		O.sessTimer = setTimeout(async () => {
			O.sessTimer = null;
			const my = gen;
			const s = await ensureSession(peer, afterPairing(peer), false, () => my === gen);
			if (my !== gen || !O.on) return;
			if (!s) { overlayOff(true); return; }
			O.sess = s;
			scheduleRefresh(peer);
		}, ms);
	}

	/* ---- on and off ---------------------------------------------------------- */

	/* A session kept from the last time, still good for a while, for this
	 * peer: a click on, off and on again is one session on the peer, not
	 * three, and the peer keeps only so many. */
	function sessionStillGood(peer) {
		const s = O.sess;
		if (!s || O.peer !== peer) return false;
		const ttl = (s.expires || 900) * 1000;
		return Date.now() - s.at < ttl * 0.8;
	}

	async function overlayOn() {
		const peer = peerName();
		if (!peer) return;
		if (!doors.peer) {
			say('this camera cannot fetch ' + peer + '’s picture; its majestic predates the feature');
			return;
		}
		const my = ++gen;
		O.pending = true;
		try {
			const s = sessionStillGood(peer) ? O.sess : await ensureSession(peer, afterPairing(peer), false, () => my === gen);
			if (my !== gen) return;
			if (!s) return;
			if (mixed(s.url)) {
				say('this page is https and ' + peer + ' is http: the browser will not connect to it from here');
				return;
			}
			buildOverlay();
			O.peer = peer;
			O.sess = s;
			if (s.size) O.size = s.size;
			scheduleRefresh(peer);
			clearNote();
			O.on = true;
			O.recovered = false;
			stage.classList.add('mj-peer-on');
			setCeiling(true);
			showStillOnce();
			mountPlayer();
			placeOutline();
		} finally {
			if (my === gen) O.pending = false;
		}
	}

	/* Off. The session is kept (not refreshed) for a next click while it is
	 * good; `forget` drops it too, for a peer that is no longer the one. */
	function overlayOff(forget) {
		/* Anything still in flight -- a session being brokered, the grace
		 * timer -- lands on an overlay
		 * that is gone, and must not switch it back on. */
		gen++;
		O.pending = false;
		if (O.sessTimer) { clearTimeout(O.sessTimer); O.sessTimer = null; }
		if (forget) { O.sess = null; O.size = null; O.codec = ''; }
		if (!O.on) return;
		/* Off first: a player torn down below may report its loss on the
		 * way out, and a loss on an overlay that is off asks for nothing. */
		O.on = false;
		unmountPlayer();
		stopStills();
		stage.classList.remove('mj-peer-on');
		setCeiling(false);
		O.codec = '';
		O.size = null;
		if (O.el) O.el.hidden = true;
		placeOutline();
	}

	/* ---- arming and the click ---------------------------------------------- */

	let press = null;
	function setArmed(on) {
		armed = !!on;
		press = null;
		stage.classList.toggle('mj-peer-armed', armed);
		if (!armed) stage.classList.remove('mj-peer-in');
		if (armed) saidCoverage = false;
		if (box.checked !== armed) box.checked = armed;
		/* Off takes everything of this control's with it: the overlay, its
		 * session, and a note -- a pairing form, say -- still open. */
		if (!armed) { overlayOff(true); clearNote(); }
		outlineOn(armed);
	}
	box.addEventListener('change', () => setArmed(box.checked));
	if (pick) pick.addEventListener('change', () => {
		/* The overlay, its session, its outline and any note were the
		 * previous peer's. */
		overlayOff(true);
		clearNote();
		quad = null;
		corners = null;
		if (armed) askOutline();
	});

	/* Is the stage armed for a rectangle: the bar's Area, or a pick on behalf
	 * of another control? The zoom module marks the stage the same way for
	 * both; only the checkbox tells them apart, and that is not the question. */
	function drawArmed() {
		const area = $('#mj-area');
		if (area && area.checked) return true;
		return !!(stage.classList && typeof stage.classList.contains === 'function' &&
			stage.classList.contains('mj-armed'));
	}

	function stagePoint(e) {
		const r = stage.getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	}

	/* A press inside the outline is watched, never taken: it stays the
	 * page's, which pans on it or draws its zoom rectangle exactly as it
	 * does with the control off. A release within a few pixels of the
	 * press is a click, and toggles the overlay. With the zoom-to-area tool
	 * armed the press is that tool's rectangle over the outline, click or
	 * not. A press anywhere else is the page's, as it always was. */
	function down(e) {
		/* A second pointer while one is pressed is a pinch, not a click:
		 * neither finger's release toggles anything. */
		if (press) { press = null; return; }
		if (!armed) return;
		if (e.button != null && e.button > 0) return;
		if (e.target && e.target.closest && e.target.closest(CHROME)) return;
		/* The stage's own armed state, not the bar's checkbox: a rectangle
		 * asked for by another control -- focus by ear's Area -- arms the
		 * stage the same way and leaves the checkbox dark on purpose. */
		if (drawArmed()) return;
		const p = stagePoint(e);
		if (!inside(p.x, p.y)) return;
		press = { id: e.pointerId, x: p.x, y: p.y };
	}
	function move(e) {
		if (armed && !press) {
			const p = stagePoint(e);
			stage.classList.toggle('mj-peer-in', inside(p.x, p.y));
		}
	}
	function up(e, commit) {
		if (!press || e.pointerId !== press.id) return;
		const p = stagePoint(e);
		const click = commit && Math.abs(p.x - press.x) <= CLICK_SLOP && Math.abs(p.y - press.y) <= CLICK_SLOP;
		press = null;
		if (!click) return;
		/* A click while the session is still being asked for is neither a
		 * second ask -- the camera would broker another session for an
		 * answer this page then throws away -- nor a cancel, which Esc is.
		 * The answer is on its way. */
		if (O.pending) return;
		if (O.on) overlayOff(); else overlayOn();
	}
	/* Two clicks inside the outline have already toggled the overlay twice;
	 * the page's double-click -- Fill to Fit and back -- must not also jump
	 * the view from under them. */
	function dbl(e) {
		if (!armed) return;
		if (e.target && e.target.closest && e.target.closest(CHROME)) return;
		const p = stagePoint(e);
		if (inside(p.x, p.y)) e.stopImmediatePropagation();
	}
	stage.addEventListener('pointerdown', down, true);
	stage.addEventListener('pointermove', move, true);
	stage.addEventListener('pointerup', (e) => up(e, true), true);
	stage.addEventListener('pointercancel', (e) => up(e, false), true);
	stage.addEventListener('dblclick', dbl, true);

	/* In the capture phase, so this runs before the page's own Esc -- which
	 * drops a free zoom back to its preset -- and can stop it: with the
	 * other camera's picture up under a zoom, Esc takes the picture and
	 * leaves the zoom; the next Esc is the page's. */
	document.addEventListener('keydown', (e) => {
		if (e.key !== 'Escape') return;
		/* A rectangle being drawn is the innermost thing on the stage, and
		 * Esc is its way out first; the zoom module's own handler takes it. */
		if (drawArmed()) return;
		if (O.on || O.pending) { overlayOff(); e.stopPropagation(); return; }
		if (armed) { setArmed(false); e.stopPropagation(); return; }
		if (!note.hidden) { clearNote(); e.stopPropagation(); }
	}, true);

	/* The map is per shown stream and goes stale the moment the viewer changes
	 * channel; dropped first, so a placement arriving before the refresh
	 * lands converts nothing rather than converting wrongly. */
	window.addEventListener('mj-stream-changed', () => {
		geom = null;
		geomTried = 0;
		clearNote();
		geometryFresh().then(placeOutline);
	});
	/* Every time the view moves -- a pan, a zoom, the stage resized under a
	 * banner or into fullscreen -- the outline and the picture on it move
	 * with it at once, rather than at the next tick. The tick stays for what
	 * is not a view change. A page without the zoom module's view events
	 * falls back to the window. */
	if (window.MajesticZoom && typeof window.MajesticZoom.onView === 'function') window.MajesticZoom.onView(() => placeOutline());
	else window.addEventListener('resize', () => placeOutline());

	(async function () {
		const [hasCoverage, hasPeer, names] = await Promise.all([probe(COVERAGE), probe(PEER), learnPeers()]);
		if (!hasCoverage || !names.length) return;   /* left hidden */
		doors = { coverage: true, peer: hasPeer };
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
		await geometryFresh();
		ctl.hidden = false;
	})();

	window.MajesticPeerCrop = {
		toStage: toStage,
		inside: inside,
		quadTransform: quadTransform,
		peers: () => peers.slice(),
		outline: () => (quad ? quad.map((c) => c.slice()) : null),
		corners: () => (corners ? corners.map((p) => ({ x: p.x, y: p.y })) : null),
		overlay: () => ({
			on: O.on, pending: O.pending, playing: O.playing, lost: O.lost, peer: O.peer,
			matrix: O.matrix, frame: peerFrame(), stream: currentStream(), shownWidth: shownWidth(), refused: adaptRefused,
			session: O.sess ? Object.assign({}, O.sess) : null,
		}),
		/* One tick, for the tests: a placement and the stream question. */
		place: tick,
	};
})();
