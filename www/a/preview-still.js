/* The best picture this camera can give you of one part of the scene.
 *
 * The live stream is the camera's compromise: a bitrate spread over the whole
 * frame, a quantiser deciding what to throw away, and -- when you have zoomed
 * in -- one stream pixel stretched over several screen ones. None of that is
 * recoverable from the video, however hard the encoder is pushed. What IS
 * available is the frame the encoder was handed before any of it happened:
 * majestic's /image.yuv420 serves that frame uncompressed, and since it learnt
 * ?crop= it will serve just the rectangle you are looking at.
 *
 * So this trades motion for detail, deliberately and only when asked. The
 * picture freezes and what replaces it is the same scene at the main channel's
 * full resolution with no quantiser in front of it -- which for a face or a
 * number plate is the difference between a guess and a reading.
 *
 * Its own file, not part of preview-page.js, for the reason preview-zoom.js
 * and preview-roi.js are: tests/auto-source.test.js and tests/staging.test.js
 * run that page in a bare `vm` whose stub elements have no canvas, no fetch and
 * no layout. Nothing here is in either SRCS list, and preview-page.js does not
 * know this exists.
 */
(function () {
	'use strict';

	const $ = (s) => document.querySelector(s);

	const stage = $('#mj-stage');
	const still = $('#mj-still');
	const ctl = $('#mj-detail-ctl');
	const box = $('#mj-detail');
	const note = $('#mj-still-note');
	if (!stage || !still || !ctl || !box || !note) return;

	/* The probe is a SIXTEEN PIXEL crop, not a frame.
	 *
	 * Asking for the whole picture to find out whether the endpoint exists
	 * would move twelve megabytes off the camera on every page load, take a
	 * capture slot while it did, and freeze nothing for anybody's benefit. A
	 * 16x16 crop is 384 bytes and answers the same question -- and it answers
	 * the one that actually matters, which is not "is there a /image.yuv420"
	 * but "does this build understand ?crop= and say what it sent". An older
	 * majestic serves the endpoint and ignores the parameter, so it would come
	 * back with a whole frame and no geometry headers; that is a no. */
	const PROBE = '/image.yuv420?crop=0x0x16x16';

	let supported = null;   /* null until asked: unknown is not "no" */
	let map = null;         /* main-stream <-> shown-stream, when the camera says */
	let mainSize = null;    /* the channel the crop is measured in */
	let shown = null;       /* the still on screen, or null */
	let busy = false;
	let gen = 0;            /* so a slow grab cannot land after a newer one */

	function get(res, name) {
		const v = res.headers.get(name);
		const n = v == null ? NaN : parseInt(v, 10);
		return Number.isFinite(n) && n > 0 ? n : 0;
	}

	async function probe() {
		try {
			const res = await fetch(PROBE, { credentials: 'same-origin' });
			if (!res.ok) return false;
			/* Read rather than trusted: a build that ignores ?crop= answers 200
			 * with the whole frame, and 16 is the width we asked for. */
			const w = get(res, 'X-Frame-Width'), h = get(res, 'X-Frame-Height');
			await res.arrayBuffer();
			return w === 16 && h === 16 && !!res.headers.get('X-Pixel-Format');
		} catch (e) {
			return false;
		}
	}

	/* Where the crop is measured. /image.yuv420 always takes from the MAIN
	 * channel, whatever the page happens to be watching, so a viewer on the sub
	 * stream still gets main-resolution detail -- that is most of the point.
	 * The rectangle therefore has to be expressed in main-stream pixels, and
	 * mj-region.js already owns that conversion for the motion and privacy
	 * editors. */
	async function learnGeometry() {
		try {
			const res = await fetch('/api/v1/osd', { credentials: 'same-origin' });
			if (!res.ok) return;
			const j = await res.json();
			const streams = Array.isArray(j.streams) ? j.streams : [];
			for (let i = 0; i < streams.length; i++) {
				const s = streams[i];
				if (s && s.stream === 0 && Array.isArray(s.frame))
					mainSize = { w: s.frame[0], h: s.frame[1] };
			}
			const now = window.MajesticLiveStream ? window.MajesticLiveStream() : 0;
			if (window.MajesticRegion && j.group)
				map = window.MajesticRegion.view(j.group, streams, 0, now | 0);
		} catch (e) {
			/* Not knowing is not a mapping of 1:1 -- see scales(). */
		}
	}

	/* Shown-stream pixels to the main channel's, and back.
	 *
	 * mj-region's map runs main -> shown, which is the direction every editor
	 * needs; this is the only caller that wants both ways, so the inverse lives
	 * here rather than getting a second spelling there. Without a map the two
	 * channels are assumed to frame the same scene, which is what every
	 * ordinary camera does and what the settings page already assumes -- and if
	 * that is wrong the crop is wrong by a scale factor, visibly, rather than
	 * silently. */
	function scales(frame) {
		if (map && map.k && map.k.x && map.k.y)
			return { kx: map.k.x, ky: map.k.y, ox: map.o.x, oy: map.o.y };
		if (mainSize && mainSize.w && mainSize.h && frame && frame.w && frame.h)
			return { kx: frame.w / mainSize.w, ky: frame.h / mainSize.h, ox: 0, oy: 0 };
		return { kx: 1, ky: 1, ox: 0, oy: 0 };
	}

	/* What to ask the camera for, and where to put what comes back.
	 *
	 * The two have to be derived from the SAME rectangle, and that rectangle
	 * has to be the one the camera will actually cut -- not the one asked for.
	 * The camera snaps a crop to the chroma grid -- origin down to an even
	 * pixel, far edge up to one -- because a 4:2:0 frame carries one chroma
	 * sample per 2x2 block of luma and an odd edge has no chroma of its own. So
	 * a request of 677x367x643x339 comes back as 676x366x644x340: up to a pixel
	 * wider on each side, and shifted. The reply says what was sent, in
	 * X-Frame-Width and X-Frame-Height, so this never has to guess.
	 *
	 * Laying that over the live picture as though it were the rectangle asked
	 * for puts it a pixel or two out, and at 260% one frame pixel is two and a
	 * half on screen, so the seam is plainly visible when the still goes up.
	 * Aligning here first makes the answer predictable: the camera is handed a
	 * rectangle that is already on its grid, so it returns exactly that, and
	 * the same rectangle decides where the picture is drawn. */
	function plan() {
		const zoom = window.MajesticZoom;
		if (!zoom || typeof zoom.view !== 'function') return null;
		const v = zoom.view();
		if (!v || !v.frame || !v.visible || !v.frame.w || !v.frame.h) return null;
		if (!v.pic || !v.scale) return null;
		const s = v.visible;
		if (!(s.w > 0) || !(s.h > 0)) return null;

		const k = scales(v.frame);
		/* Into main-channel pixels, where the crop is measured. */
		let x = (s.x - k.ox) / k.kx, y = (s.y - k.oy) / k.ky;
		let r = x + s.w / k.kx, b = y + s.h / k.ky;

		/* Onto the chroma grid, outward, exactly as the camera would. */
		const bw = mainSize && mainSize.w ? mainSize.w : Math.round(v.frame.w / k.kx);
		const bh = mainSize && mainSize.h ? mainSize.h : Math.round(v.frame.h / k.ky);
		x = Math.max(0, Math.floor(x / 2) * 2);
		y = Math.max(0, Math.floor(y / 2) * 2);
		r = Math.min(bw, Math.ceil(r / 2) * 2);
		b = Math.min(bh, Math.ceil(b / 2) * 2);
		const w = r - x, h = b - y;
		if (!(w >= 2) || !(h >= 2)) return null;

		/* And back to where those pixels are drawn. Stage coordinate of shown
		 * pixel X is pic.x + (X - visible.x) * scale, which is the arithmetic
		 * preview-zoom places the video with -- so the still lands on the same
		 * pixels rather than near them. */
		const sx = k.kx * x + k.ox, sy = k.ky * y + k.oy;
		const sw = k.kx * w, sh = k.ky * h;
		return {
			crop: { x: x, y: y, w: w, h: h },
			box: {
				left: v.pic.x + (sx - s.x) * v.scale,
				top: v.pic.y + (sy - s.y) * v.scale,
				width: sw * v.scale,
				height: sh * v.scale,
			},
		};
	}

	/* Semi-planar 4:2:0 to RGBA.
	 *
	 * The order of the chroma pair is READ, never assumed. majestic states it
	 * per generation -- gen 1-3 hand over NV12, gen 4 and later report what the
	 * channel is actually configured as -- and a decoder that guesses swaps red
	 * and blue on half the cameras in the field, which looks like a broken
	 * camera rather than a broken client.
	 *
	 * Chroma is INTERPOLATED, and sited the way 4:2:0 actually sites it:
	 * horizontally a chroma sample sits on the even luma column, vertically it
	 * sits halfway between the two luma rows it covers. Repeating the nearest
	 * sample instead -- which is what this did first, and what most quick
	 * converters do -- drags every colour edge half a chroma sample to one
	 * side. Measured against the live picture that is a whole luma pixel
	 * horizontally: the still sat one pixel right of the video it replaced,
	 * which on a magnified picture is a visible jump at the moment it appears.
	 * It also gives colour edges a staircase, on a feature whose entire claim
	 * is fidelity.
	 *
	 * BT.601 limited range, in integer arithmetic: this runs over a megapixel
	 * on a press and the browser is the only thing here with cycles to spare. */
	function toRGBA(buf, w, h, strideY, strideC, fmt) {
		const out = new Uint8ClampedArray(w * h * 4);
		const planar = fmt === 'GREY';
		const vFirst = fmt === 'NV21';
		const cOff = strideY * h;
		const cw = w >> 1, ch = h >> 1;

		/* One chroma pair, by its sample coordinates, clamped at the edges. */
		const cu = new Int32Array(2);
		function chromaAt(cx, cy) {
			if (cx < 0) cx = 0; else if (cx > cw - 1) cx = cw - 1;
			if (cy < 0) cy = 0; else if (cy > ch - 1) cy = ch - 1;
			const o = cOff + cy * strideC + cx * 2;
			cu[0] = buf[o + (vFirst ? 1 : 0)];
			cu[1] = buf[o + (vFirst ? 0 : 1)];
		}

		for (let y = 0; y < h; y++) {
			const rowY = y * strideY;
			/* Vertically centre-sited: chroma row j covers luma rows 2j, 2j+1
			 * and sits between them, so luma row y samples at y/2 - 1/4. */
			const fy = y * 0.5 - 0.25;
			const y0 = Math.floor(fy), wy = fy - y0;
			let o = y * w * 4;
			for (let x = 0; x < w; x++) {
				const Y = (buf[rowY + x] - 16) * 1192;
				let R, G, B;
				if (planar) {
					R = G = B = Y;
				} else {
					/* Horizontally co-sited: chroma i sits ON luma 2i. */
					const fx = x * 0.5;
					const x0 = Math.floor(fx), wx = fx - x0;
					chromaAt(x0, y0);
					const u00 = cu[0], v00 = cu[1];
					chromaAt(x0 + 1, y0);
					const u10 = cu[0], v10 = cu[1];
					chromaAt(x0, y0 + 1);
					const u01 = cu[0], v01 = cu[1];
					chromaAt(x0 + 1, y0 + 1);
					const u11 = cu[0], v11 = cu[1];
					const ut = u00 + (u10 - u00) * wx, ub = u01 + (u11 - u01) * wx;
					const vt = v00 + (v10 - v00) * wx, vb = v01 + (v11 - v01) * wx;
					const U = (ut + (ub - ut) * wy) - 128;
					const V = (vt + (vb - vt) * wy) - 128;
					R = Y + 1634 * V;
					G = Y - 833 * V - 400 * U;
					B = Y + 2066 * U;
				}
				out[o++] = R >> 10;
				out[o++] = G >> 10;
				out[o++] = B >> 10;
				out[o++] = 255;
			}
		}
		return new ImageData(out, w, h);
	}

	function say(msg) {
		note.textContent = msg || '';
		note.hidden = !msg;
	}

	/* The still's geometry is set HERE, not left to the stylesheet.
	 *
	 * It used to rely on .mj-still-media in bootstrap.override.css, and that is
	 * a file this module does not own: a camera running an older copy of it, or
	 * a browser holding one, drops the rule and the image falls back to static
	 * flow -- behind the absolutely-positioned video, which goes on playing.
	 * What the operator then sees is the note counting up next to a moving
	 * picture, which reads as "the still did not arrive" when in fact it did
	 * and is sitting underneath. Inline styles cannot go stale. The stylesheet
	 * rule stays as the same thing said twice, for anyone reading the CSS. */
	function dress(box) {
		const st = still.style;
		st.position = 'absolute';
		st.left = box.left.toFixed(2) + 'px';
		st.top = box.top.toFixed(2) + 'px';
		st.width = box.width.toFixed(2) + 'px';
		st.height = box.height.toFixed(2) + 'px';
		/* fill, not contain: the box IS the rectangle these pixels came from,
		 * so any letterboxing would be the picture disagreeing with itself. */
		st.objectFit = 'fill';
		st.background = 'transparent';
		st.zIndex = '2';
	}

	function clear() {
		gen++;
		shown = null;
		still.hidden = true;
		if (still.src && still.src.indexOf('blob:') === 0) URL.revokeObjectURL(still.src);
		still.removeAttribute('src');
		stage.classList.remove('mj-stilled');
		if (box.checked) box.checked = false;
		say('');
	}

	async function grab() {
		if (busy) return;
		const p = plan();
		if (!p) { say('nothing to grab yet'); box.checked = false; return; }
		const r = p.crop;

		busy = true;
		const mine = ++gen;
		say('grabbing…');
		try {
			const url = '/image.yuv420?crop=' + r.x + 'x' + r.y + 'x' + r.w + 'x' + r.h;
			const res = await fetch(url, { credentials: 'same-origin' });
			if (mine !== gen) return;

			if (res.status === 503) {
				/* Not an error, and worth saying in those words: the camera
				 * takes one uncompressed frame at a time, so this is somebody
				 * else's grab in flight -- or the operator's own, twice. */
				say('the camera is busy with another grab');
				box.checked = false;
				return;
			}
			if (!res.ok) {
				say('the camera refused: ' + res.status);
				box.checked = false;
				return;
			}

			const w = get(res, 'X-Frame-Width'), h = get(res, 'X-Frame-Height');
			const fmt = res.headers.get('X-Pixel-Format') || '';
			const sy = get(res, 'X-Stride-Luma') || w;
			const sc = get(res, 'X-Stride-Chroma') || sy;
			const buf = new Uint8Array(await res.arrayBuffer());
			if (mine !== gen) return;
			if (!w || !h || !fmt) { say('the camera did not say what it sent'); box.checked = false; return; }

			const need = sy * h + (fmt === 'GREY' ? 0 : sc * (h >> 1));
			if (buf.length < need) { say('the frame arrived short'); box.checked = false; return; }

			const cv = document.createElement('canvas');
			cv.width = w; cv.height = h;
			cv.getContext('2d').putImageData(toRGBA(buf, w, h, sy, sc, fmt), 0, 0);
			const blob = await new Promise((ok) => cv.toBlob(ok, 'image/png'));
			if (mine !== gen || !blob) return;

			/* The camera should have returned exactly the rectangle asked for,
			 * since it was handed one already on the grid. If it did not -- an
			 * older build, a clamp this page did not predict -- the picture and
			 * the box would disagree, so the box follows what ARRIVED. */
			const box2 = {
				left: p.box.left, top: p.box.top,
				width: p.box.width * (w / r.w), height: p.box.height * (h / r.h),
			};
			if (still.src && still.src.indexOf('blob:') === 0) URL.revokeObjectURL(still.src);
			dress(box2);
			still.src = URL.createObjectURL(blob);

			/* Shown only once the browser has actually decoded it. An <img>
			 * whose source fails reports complete with a natural size of zero
			 * and paints nothing at all -- so without this the page would go on
			 * to announce a still, and keep counting its age, over a live
			 * picture that never stopped moving. */
			try {
				/* The load events rather than img.decode(): the element is
				 * still hidden at this point, and decode() is specified
				 * against a displayed image -- some browsers reject it for one
				 * that is display:none, which would report a perfectly good
				 * still as a failure. */
				await new Promise((ok, no) => {
					still.onload = ok;
					still.onerror = () => no(new Error('decode'));
				});
			} catch (e) {
				if (mine !== gen) return;
				say('the still could not be displayed');
				box.checked = false;
				still.removeAttribute('src');
				return;
			}
			if (mine !== gen) return;
			if (!still.naturalWidth) {
				say('the still came back empty');
				box.checked = false;
				still.removeAttribute('src');
				return;
			}

			still.hidden = false;
			stage.classList.add('mj-stilled');
			shown = { w: w, h: h, at: Date.now() };
			paintNote();
		} catch (e) {
			if (mine === gen) { say('could not reach the camera'); box.checked = false; }
		} finally {
			busy = false;
		}
	}

	/* The age is stated, and it keeps counting.
	 *
	 * A frozen picture that looks live is the one genuinely dangerous thing
	 * this feature can do -- somebody reads a still as the current scene and
	 * acts on it. So the still says what it is and how old it is for as long as
	 * it is up, rather than saying it once at the moment nobody is worried. */
	function paintNote() {
		if (!shown) return;
		const age = Math.max(0, Math.round((Date.now() - shown.at) / 1000));
		say('Still · ' + shown.w + '×' + shown.h + ' sensor pixels · ' +
			(age < 1 ? 'just now' : age + 's ago'));
	}
	setInterval(() => { if (shown) paintNote(); }, 1000);

	box.addEventListener('change', () => {
		if (box.checked) grab(); else clear();
	});

	/* Any change of view drops the still, because it no longer describes what
	 * the control says it describes. Panning or zooming under a frozen picture
	 * would leave the two disagreeing with nothing on screen to say which is
	 * which. */
	if (window.MajesticZoom && typeof window.MajesticZoom.onView === 'function')
		window.MajesticZoom.onView(() => { if (shown || busy) clear(); });

	/* The map is per SHOWN stream, so it goes stale the moment the viewer
	 * changes channel -- and a stale one is worse than none: it converts the
	 * visible rectangle with the other channel's scale and grabs a region that
	 * is confidently somewhere else in the scene. Nothing on screen would say
	 * so, because a crop of the wrong place still looks like a picture. */
	window.addEventListener('mj-stream-changed', () => {
		if (shown || busy) clear();
		learnGeometry();
	});

	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && (shown || busy)) { clear(); e.stopPropagation(); }
	});
	still.addEventListener('click', clear);

	(async function () {
		supported = await probe();
		if (!supported) return;   /* left hidden: the camera cannot do this */
		await learnGeometry();
		ctl.hidden = false;
	})();

	window.MajesticStill = {
		supported: () => supported,
		plan: plan,
		toRGBA: toRGBA,
	};
})();
