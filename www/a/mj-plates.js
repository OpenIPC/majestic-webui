// The plates the camera reads: the panel on the Licence plates settings page.
//
// The camera publishes a plate ONCE per vehicle, as a `plate` event on
// /ws/analytics -- {"src":"plate","active":true,"text":"A123BC77",
// "chars":[99,98,...],"read":12,"r":[[x,y,w,h,cls,score,id]]} -- and two
// seconds later an inactive one that takes it back. It also keeps the last
// reads itself, at GET /api/v1/plates, so the list starts with what was read
// before the page was opened and the socket adds to it.
//
// Each glyph is shown with how sure the reader was of it: a plate is as
// trustworthy as its least sure glyph, and the read's own score averages that
// away. A glyph under FLOOR is drawn amber, as the raw editor's Plates tab
// draws an uncertain one.
//
// With lpr.debug the camera keeps two pictures of each of its latest reads --
// the vehicle as the reader saw it, the plate outlined, and the plate crop it
// read -- at /api/v1/plates/<read>/{vehicle,plate}.jpg. They are the evidence
// that a read is right, so the row shows them; a read without them shows
// none.
//
// Every string here comes off the camera. It reaches the DOM through
// textContent and attributes set one by one, never as HTML.
(function () {
	'use strict';

	const MAX = 32;
	// The same plate, on the same vehicle, again this soon is the same read
	// reaching a page that reconnected, not a second car.
	const SAME_MS = 5000;
	// A glyph read less surely than this is drawn as doubtful.
	const FLOOR = 90;

	// --- the store: no DOM, so the tests can reach it ---------------------

	function glyphs(text) { return Array.from(text); }

	function store(max) {
		const cap = max || MAX;
		const list = [];

		// A value that is not a percentage is unknown, not "0% sure": the
		// camera did not say, and saying it was unsure would be a claim.
		function chars(a, n) {
			if (!Array.isArray(a)) return [];
			return a.slice(0, n).map(v => (typeof v === 'number' && v >= 0 && v <= 100) ? v : null);
		}

		// Newest first; a read whose time is unknown goes last.
		function order() {
			list.sort((a, b) => (b.at === null ? -Infinity : b.at) - (a.at === null ? -Infinity : a.at));
			if (list.length > cap) list.length = cap;
		}

		function put(read, authoritative) {
			// A read the camera numbered is the same read however it arrived;
			// what the camera keeps about it (its time, its score, whether it
			// has pictures) is the better account of it than the socket's.
			const same = read.seq ? list.find(r => r.seq === read.seq) : null;
			if (same) {
				if (!authoritative) return false;
				Object.assign(same, read);
				order();
				return true;
			}
			// Two reads the camera numbered differently are two reads. An
			// unnumbered one alike to another this soon is the same read
			// reaching a page that reconnected.
			for (const r of list) {
				if (read.seq && r.seq) continue;
				if (read.at === null || r.at === null || Math.abs(read.at - r.at) >= SAME_MS) continue;
				if (r.text === read.text && r.vehicle === read.vehicle) return false;
			}
			list.push(read);
			order();
			return true;
		}

		return {
			// An event as /ws/analytics sends it. True when it added a read.
			offer: function (ev, now) {
				if (!ev || ev.src !== 'plate' || !ev.active) return false;
				if (typeof ev.text !== 'string' || !ev.text) return false;
				const text = ev.text.slice(0, 24);
				const b = Array.isArray(ev.r) && Array.isArray(ev.r[0]) ? ev.r[0] : [];
				return put({
					seq: typeof ev.read === 'number' ? ev.read : 0,
					text: text,
					chars: chars(ev.chars, glyphs(text).length),
					score: typeof b[5] === 'number' ? b[5] : 0,
					vehicle: typeof b[6] === 'number' ? b[6] : 0,
					images: null, // not said on the socket: try, and hide on 404
					at: now,
				}, false);
			},
			// GET /api/v1/plates. True when it added any.
			history: function (doc) {
				if (!doc || !Array.isArray(doc.reads)) return false;
				let any = false;
				for (const r of doc.reads) {
					if (!r || typeof r.text !== 'string' || !r.text) continue;
					const text = r.text.slice(0, 24);
					any = put({
						seq: typeof r.seq === 'number' ? r.seq : 0,
						text: text,
						chars: chars(r.chars, glyphs(text).length),
						score: typeof r.conf === 'number' ? r.conf : 0,
						vehicle: typeof r.vehicle === 'number' ? r.vehicle : 0,
						images: r.images === true,
						at: typeof r.t === 'number' && r.t > 0 ? r.t : null,
					}, true) || any;
				}
				return any;
			},
			reads: function () { return list.slice(); },
		};
	}

	// The least sure glyph, or null without per-glyph confidence. A glyph
	// the camera gave no value for is not counted either way.
	function weakest(read) {
		const known = (read.chars || []).filter(v => v !== null);
		return known.length ? Math.min.apply(null, known) : null;
	}

	// What the page tells someone about the settings plates depend on: they
	// are read off the vehicles object detection reports, so with detection
	// off, or vehicles not asked for, plate reading has nothing to read but
	// what the motion fallback finds. Null when nothing is missing -- and
	// only what the camera's config SAYS is missing: a key it did not send is
	// not reported as off.
	function missing(config) {
		const od = (config && config.objectDetect) || {};
		const lpr = (config && config.lpr) || {};
		if (lpr.enabled !== true) return null;
		const out = [];
		if (od.enabled === false) out.push('object detection is off');
		else if (od.vehicles === false) out.push('object detection does not report vehicles');
		return out.length ? out : null;
	}

	// --- the mount: the DOM half -----------------------------------------

	function clock(t) {
		if (t === null) return 'time unknown';
		const opts = typeof window === 'object' && window.mjTimeOpts ? window.mjTimeOpts() : {};
		const d = new Date(t);
		const today = new Date().toDateString() === d.toDateString();
		return today
			? d.toLocaleTimeString([], Object.assign({ hour: '2-digit', minute: '2-digit', second: '2-digit' }, opts))
			: d.toLocaleString([], Object.assign({ month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }, opts));
	}

	function node(tag, cls, text) {
		const n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text !== undefined) n.textContent = text;
		return n;
	}

	// One column per glyph, its bar under it, so a doubtful position is
	// under the glyph it is about.
	function plateGlyphs(read) {
		const wrap = node('span', 'mj-plates-text');
		const gs = glyphs(read.text);
		gs.forEach((g, i) => {
			const col = node('span', 'mj-plates-glyph');
			col.appendChild(node('span', 'mj-plates-g', g));
			const c = read.chars[i];
			if (c !== undefined) {
				const bar = node('span', 'mj-plates-bar');
				if (c === null) {
					bar.classList.add('mj-plates-unknown');
					col.title = g + ': confidence not given';
				} else {
					if (c < FLOOR) bar.classList.add('mj-plates-low');
					col.title = g + ': ' + c + '% sure';
				}
				col.appendChild(bar);
			}
			wrap.appendChild(col);
		});
		return wrap;
	}

	function picture(read, what) {
		const a = node('a', 'mj-plates-pic mj-plates-' + what);
		a.href = '/api/v1/plates/' + read.seq + '/' + what + '.jpg';
		a.target = '_blank';
		a.rel = 'noopener';
		const img = node('img');
		img.loading = 'lazy';
		img.alt = what === 'plate' ? 'The plate as read' : 'The vehicle, the plate outlined';
		img.src = a.href;
		// No picture of this read (debug off when it was made, or gone):
		// nothing, rather than a broken image.
		img.addEventListener('error', () => { a.remove(); });
		a.appendChild(img);
		return a;
	}

	function mount(box, opts) {
		opts = opts || {};
		if (!box) return null;
		const st = store();
		const list = node('ol', 'mj-plates-list');
		const empty = node('p', 'mj-plates-empty');
		// What the list can and cannot say: until the camera has answered
		// for its earlier reads an empty list means nothing, and if it does
		// not answer, the list holds only what arrived since.
		const lost = node('p', 'mj-plates-empty',
			'The camera\'s earlier reads could not be loaded; this list holds only the ones made since the page was opened.');
		lost.hidden = true;
		box.appendChild(empty);
		box.appendChild(lost);
		box.appendChild(list);
		let history = 'loading'; // then 'ok' or 'failed'

		function paint() {
			const reads = st.reads();
			empty.hidden = reads.length > 0;
			empty.textContent = history === 'loading'
				? 'Loading the camera\'s last reads…'
				: history === 'ok'
					? 'No plates read yet. The camera keeps its last ' + MAX + ' reads; new ones appear here as they are made.'
					: 'No plates read since this page was opened.';
			lost.hidden = history !== 'failed' || reads.length === 0;
			while (list.firstChild) list.removeChild(list.firstChild);
			const pics = opts.pictures ? opts.pictures() : false;
			for (const r of reads) {
				const li = node('li');
				const low = weakest(r);
				if (low !== null && low < FLOOR) li.classList.add('mj-plates-doubt');
				li.appendChild(node('span', 'mj-plates-time', clock(r.at)));
				li.appendChild(plateGlyphs(r));
				const meta = [];
				if (r.score) meta.push(r.score + '% sure');
				if (low !== null && low < FLOOR) meta.push('least sure glyph ' + low + '%');
				if (r.vehicle) meta.push('vehicle #' + r.vehicle);
				li.appendChild(node('span', 'mj-plates-meta', meta.join(', ')));
				// A read the camera says has pictures, or a live one while it
				// keeps them: both are asked for, and vanish on a 404.
				if (r.seq && (r.images === true || (r.images === null && pics))) {
					const p = node('span', 'mj-plates-pics');
					p.appendChild(picture(r, 'plate'));
					p.appendChild(picture(r, 'vehicle'));
					li.appendChild(p);
				}
				list.appendChild(li);
			}
		}

		let ws = null, closed = false, retry = 1000;
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
				// Backing off, as the overlay does: a camera whose subscriber
				// slots are full will refuse the next session too.
				setTimeout(open, retry);
				retry = Math.min(retry * 2, 30000);
			};
		}

		fetch('/api/v1/plates', { credentials: 'same-origin' })
			.then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
			.then(doc => {
				if (closed) return;
				history = doc && Array.isArray(doc.reads) ? 'ok' : 'failed';
				st.history(doc);
				paint();
			})
			.catch(() => {
				if (closed) return;
				history = 'failed';
				paint();
			});
		open();
		paint();

		return {
			repaint: paint,
			destroy: function () {
				closed = true;
				if (ws) { try { ws.close(); } catch (e) {} }
			},
		};
	}

	const api = { store: store, missing: missing, weakest: weakest, mount: mount,
		MAX: MAX, SAME_MS: SAME_MS, FLOOR: FLOOR };
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticPlates = api;
})();
