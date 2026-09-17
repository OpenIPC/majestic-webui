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
 * control is armed its listeners run first, in the capture phase, and stop a
 * press inside the outline there, so the click does not also pan or zoom.
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
	let learning = null;
	function geometryFresh() {
		if (geom && geom.at === shownStream()) return Promise.resolve(true);
		if (!learning) learning = learnGeometry().then(() => { learning = null; return !!geom; });
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
	let askTimer = null, placeTimer = null, outlineGen = 0;

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
		outline.hidden = true;
		stage.appendChild(outline);
	}

	function tagText() {
		const name = peerName();
		if (O.on) {
			const what = O.lost ? 'snapshots' : O.playing ? 'LIVE' : 'connecting…';
			return name + ' · ' + what + ' · click or Esc to hide';
		}
		return name + ' sees this · click inside to see its picture here';
	}

	/* The outline in stage pixels, from the corners the camera gave and the
	 * placement now; and the overlay with it. */
	function placeOutline() {
		if (!outline) return;
		if (!quad || !armed && !O.on) { outline.hidden = true; corners = null; placeOverlay(); return; }
		if (geom && geom.at !== shownStream()) { geometryFresh().then(placeOutline); return; }
		const pts = quad.map((c) => toStage(c[0], c[1]));
		if (pts.some((p) => !p)) { outline.hidden = true; corners = null; placeOverlay(); return; }
		corners = pts;
		const ring = pts.map((p) => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ');
		outlinePoly.setAttribute('points', ring);
		const sw = stage.clientWidth, sh = stage.clientHeight;
		outlineDim.setAttribute('d', 'M0,0H' + sw + 'V' + sh + 'H0Z M' + ring.replace(/ /g, 'L') + 'Z');
		outlineDim.setAttribute('class', 'mj-peer-dim' + (O.on ? ' mj-peer-dim-off' : ''));
		const top = pts.reduce((a, p) => (p.y < a.y ? p : a), pts[0]);
		outlineTag.setAttribute('x', top.x.toFixed(1));
		outlineTag.setAttribute('y', (top.y - 6).toFixed(1));
		outlineTag.textContent = tagText();
		outline.hidden = false;
		placeOverlay();
	}

	async function askOutline() {
		const peer = peerName();
		if (!peer || !doors.coverage) return;
		const my = ++outlineGen;
		let next = null, size = null;
		try {
			const res = await api(COVERAGE + '?peer=' + encodeURIComponent(peer), { credentials: 'same-origin' });
			if (res.ok) {
				const j = await res.json();
				if (j && Array.isArray(j.quad) && j.quad.length === 4 &&
					j.quad.every((c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]))) {
					next = j.quad;
					size = j.row ? parseSize(j.row.size) : null;
				}
			}
		} catch (e) { next = null; }
		if (my !== outlineGen) return;
		quad = next;
		if (size) O.size = size;
		placeOutline();
	}

	function outlineOn(on) {
		buildOutline();
		if (on) {
			if (!askTimer) { askOutline(); askTimer = setInterval(askOutline, OUTLINE_ASK_MS); }
			if (!placeTimer) placeTimer = setInterval(placeOutline, PLACE_MS);
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
		const s = streamOf(wantSub() ? 1 : 0);
		if (s && s.w > 0 && s.h > 0) return { w: s.w, h: s.h };
		return O.size || null;
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
		[O.handle ? O.handle.stage : null, O.still].forEach((el) => {
			if (!el) return;
			const s = el.style;
			s.width = f.w + 'px';
			s.height = f.h + 'px';
			s.transformOrigin = '0 0';
			s.transform = t;
		});
	}

	/* Which of the peer's streams to watch. The sub stream when the peer has
	 * one in H.264: every browser decodes that natively, and 1280x720 is more
	 * than an overlay a few hundred pixels wide can show, while a 2592x1944
	 * H.265 main stream through the software rung is eight frames a second of
	 * mostly grey in a browser without hardware HEVC. The main stream when
	 * there is nothing else, and the codec the peer named for each, so the
	 * transport ladder knows what it is being handed. */
	function streamOf(id) { return O.sess && O.sess.streams ? O.sess.streams.find((s) => s.id === id) : null; }
	function wantSub() { const s = streamOf(1); return !!(s && s.codec === 'h264'); }

	/* The configuration the embedded player reads: the peer's codecs as it
	 * named them (else H.265 assumed, so the software rung is on the ladder),
	 * whether there is a sub stream to prefer, and this camera's ICE
	 * settings, which are the LAN's. */
	function peerConfig() {
		const main = streamOf(0), sub = streamOf(1);
		return {
			video0: { codec: (main && main.codec) || O.codec || 'h265' },
			video1: { enabled: wantSub(), codec: (sub && sub.codec) || 'h264' },
			webrtc: myConfig && myConfig.webrtc ? myConfig.webrtc : {},
		};
	}

	function mountPlayer() {
		if (O.handle || !O.sess) return;
		const P = window.MajesticPreview;
		if (!P || typeof P.mount !== 'function') { fallbackToStills(); return; }
		O.handle = P.mount(O.host, {
			config: peerConfig,
			where: 'peer',
			picker: false, snapshot: false, fullscreen: false, inline: true,
			origin: () => (O.sess ? O.sess.url : ''),
			session: () => (O.sess ? O.sess.id : ''),
			onFrame: (w, h, codec) => {
				O.frame = w > 0 && h > 0 ? { w: w, h: h } : null;
				if (codec) O.codec = String(codec);
				placeOverlay();
			},
			onPlaying: () => {
				O.playing = true;
				O.lost = false;
				if (O.stillTimer) { clearInterval(O.stillTimer); O.stillTimer = null; }
				/* A fresh keyframe now, so the picture under the snapshot is a
				 * picture by the time the snapshot goes. */
				try {
					const p = O.handle && O.handle.player ? O.handle.player() : null;
					if (p && typeof p.requestIdr === 'function') p.requestIdr();
				} catch (e) {}
				const my = gen;
				setTimeout(() => { if (my === gen && O.on && O.playing) stopStills(); }, PLAY_GRACE_MS);
				placeOutline();
			},
			onLost: () => { O.playing = false; fallbackToStills(); },
		});
		if (!O.handle) { fallbackToStills(); return; }
		/* The player starts on the sub stream when the configuration offers
		 * one and nothing was remembered; said explicitly here so a
		 * remembered choice from another page never decides for this one. */
		const want = wantSub() ? 1 : 0;
		if (O.handle.stream && O.handle.stream() !== want && O.handle.setStream) O.handle.setStream(want);
		placeOverlay();
	}

	function unmountPlayer() {
		if (O.handle && O.handle.destroy) { try { O.handle.destroy(); } catch (e) {} }
		O.handle = null;
		O.frame = null;
		O.playing = false;
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
	async function ensureSession(peer, retry) {
		let res = null, body = null;
		try {
			res = await api(PEER + '?peer=' + encodeURIComponent(peer), { credentials: 'same-origin' });
			try { body = await res.json(); } catch (e) { body = null; }
		} catch (e) { res = null; }
		if (!res) { say('could not reach the camera'); return null; }
		if (res.ok && body && typeof body.session === 'string' && typeof body.url === 'string') {
			const expires = Number.isFinite(body.expires) && body.expires > 0 ? body.expires : null;
			const streams = Array.isArray(body.streams)
				? body.streams.filter((s) => s && Number.isFinite(s.id) && typeof s.codec === 'string')
					.map((s) => ({ id: s.id | 0, codec: s.codec, w: s.width | 0, h: s.height | 0 }))
				: [];
			return { url: body.url.replace(/\/+$/, ''), id: body.session, expires: expires, size: parseSize(body.size), streams: streams };
		}
		if (res.status === 409 && body && body.paired === false) {
			offerPairing(peer, retry, typeof body.url === 'string' && /^https?:\/\//.test(body.url) ? body.url : '');
			return null;
		}
		say((body && body.reason) || ('the camera could not reach ' + peer + ' (' + res.status + ')'));
		return null;
	}

	/* The session is good for a quarter of an hour (the camera's word, else
	 * assumed); a fresh one is fetched before it runs out so a reconnect never
	 * carries a dead one. The answer is kept only for the overlay that asked. */
	function scheduleRefresh(peer) {
		if (O.sessTimer) clearTimeout(O.sessTimer);
		const ms = Math.max(30, (O.sess && O.sess.expires ? O.sess.expires : 900) * 0.8) * 1000;
		O.sessTimer = setTimeout(async () => {
			O.sessTimer = null;
			const my = gen;
			const s = await ensureSession(peer, () => {});
			if (my !== gen || !O.on) return;
			if (!s) { overlayOff(); return; }
			O.sess = s;
			scheduleRefresh(peer);
		}, ms);
	}

	/* ---- on and off ---------------------------------------------------------- */

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
			const s = await ensureSession(peer, overlayOn);
			if (my !== gen) return;
			if (!s) return;
			buildOverlay();
			O.peer = peer;
			O.sess = s;
			if (s.size) O.size = s.size;
			scheduleRefresh(peer);
			clearNote();
			O.on = true;
			showStillOnce();
			mountPlayer();
			placeOutline();
		} finally {
			if (my === gen) O.pending = false;
		}
	}

	function overlayOff() {
		/* Anything still in flight -- a session, a map -- lands on an overlay
		 * that is gone, and must not switch it back on. */
		gen++;
		O.pending = false;
		if (!O.on && !O.sess) return;
		unmountPlayer();
		stopStills();
		if (O.sessTimer) { clearTimeout(O.sessTimer); O.sessTimer = null; }
		O.sess = null;
		O.on = false;
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
		if (box.checked !== armed) box.checked = armed;
		/* One drawing control at a time: the other one is disarmed rather
		 * than left to fire on the same press. */
		const area = $('#mj-area');
		if (armed && area && area.checked) {
			area.checked = false;
			area.dispatchEvent(new Event('change'));
		}
		if (!armed) overlayOff();
		outlineOn(armed);
	}
	box.addEventListener('change', () => setArmed(box.checked));
	if (pick) pick.addEventListener('change', () => {
		/* The overlay, its session and its outline were the previous peer's. */
		overlayOff();
		quad = null;
		corners = null;
		if (armed) askOutline();
	});

	function stagePoint(e) {
		const r = stage.getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	}

	/* A press inside the outline is this control's, and is stopped here in
	 * the capture phase so the page neither pans nor captures the pointer; a
	 * release within a few pixels of it is a click, and toggles the overlay.
	 * A press anywhere else is the page's, as it always was. */
	function down(e) {
		if (!armed) return;
		if (e.button != null && e.button > 0) return;
		if (e.target && e.target.closest && e.target.closest(CHROME)) return;
		/* The zoom-to-area tool draws its rectangle over the outline too,
		 * and that is how the overlay gets looked at closely: its drag is
		 * the page's, not ours. */
		const area = $('#mj-area');
		if (area && area.checked) return;
		const p = stagePoint(e);
		if (!inside(p.x, p.y)) return;
		e.stopImmediatePropagation();
		press = { id: e.pointerId, x: p.x, y: p.y };
	}
	function move(e) {
		if (armed && !press) {
			const p = stagePoint(e);
			stage.classList.toggle('mj-peer-in', inside(p.x, p.y));
		}
		if (!press || e.pointerId !== press.id) return;
		e.stopImmediatePropagation();
	}
	function up(e, commit) {
		if (!press || e.pointerId !== press.id) return;
		e.stopImmediatePropagation();
		const p = stagePoint(e);
		const click = commit && Math.abs(p.x - press.x) <= CLICK_SLOP && Math.abs(p.y - press.y) <= CLICK_SLOP;
		press = null;
		if (!click) return;
		if (O.on) overlayOff(); else overlayOn();
	}
	stage.addEventListener('pointerdown', down, true);
	stage.addEventListener('pointermove', move, true);
	stage.addEventListener('pointerup', (e) => up(e, true), true);
	stage.addEventListener('pointercancel', (e) => up(e, false), true);

	document.addEventListener('keydown', (e) => {
		if (e.key !== 'Escape') return;
		if (O.on || O.pending) { overlayOff(); e.stopPropagation(); return; }
		if (armed) { setArmed(false); e.stopPropagation(); return; }
		if (!note.hidden) { clearNote(); e.stopPropagation(); }
	});

	/* The map is per shown stream and goes stale the moment the viewer changes
	 * channel; dropped first, so a placement arriving before the refresh
	 * lands converts nothing rather than converting wrongly. */
	window.addEventListener('mj-stream-changed', () => {
		geom = null;
		clearNote();
		learnGeometry().then(placeOutline);
	});
	window.addEventListener('resize', () => placeOutline());

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
		await learnGeometry();
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
			matrix: O.matrix, frame: peerFrame(),
			session: O.sess ? Object.assign({}, O.sess) : null,
		}),
	};
})();
