// The plates the camera reads, as they are read: the panel on the Licence
// plates settings page.
//
// The camera publishes a plate ONCE per vehicle, as a `plate` event on
// /ws/analytics -- {"src":"plate","active":true,"text":"A123BC77",
// "r":[[x,y,w,h,cls,score,id]]} -- and two seconds later an inactive one that
// takes it back. So the only record of a read, short of the log, the ONVIF
// metadata track or a recording, is that one message, and a page that shows
// "the latest event" as the analytics overlay does would show each plate for
// two seconds and then nothing. This keeps a list instead: newest first,
// capped, of the reads that arrived while the page was open. It says so on
// screen, because an empty list on a camera that read forty cars this morning
// is otherwise a false statement about the camera.
//
// The text comes off the websocket. The camera sends plate glyphs only, but
// this page must not be the thing that makes that load-bearing, so it reaches
// the DOM through textContent and nothing else.
(function () {
	'use strict';

	const MAX = 20;
	// The same plate again this soon is the same read reaching a page that
	// reconnected, not a second car.
	const SAME_MS = 5000;

	// --- the store: no DOM, so the tests can reach it ---------------------

	function store(max) {
		const cap = max || MAX;
		const list = [];
		return {
			// An event as /ws/analytics sends it. True when it added a read.
			offer: function (ev, now) {
				if (!ev || ev.src !== 'plate' || !ev.active) return false;
				if (typeof ev.text !== 'string' || !ev.text) return false;
				const text = ev.text.slice(0, 24);
				const last = list[0];
				if (last && last.text === text && now - last.at < SAME_MS) return false;
				const b = Array.isArray(ev.r) && Array.isArray(ev.r[0]) ? ev.r[0] : [];
				const score = typeof b[5] === 'number' ? b[5] : 0;
				const id = typeof b[6] === 'number' ? b[6] : 0;
				list.unshift({ text: text, score: score, vehicle: id, at: now });
				if (list.length > cap) list.length = cap;
				return true;
			},
			reads: function () { return list.slice(); },
		};
	}

	// What the page tells someone about the settings plates depend on: they
	// are read off the vehicles object detection reports, so with detection
	// off, or vehicles not asked for, plate reading has nothing to read but
	// what the motion fallback finds. Null when nothing is missing.
	function missing(config) {
		const od = (config && config.objectDetect) || {};
		const lpr = (config && config.lpr) || {};
		if (lpr.enabled !== true) return null;
		const out = [];
		if (od.enabled !== true) out.push('object detection is off');
		else if (od.vehicles !== true) out.push('object detection does not report vehicles');
		return out.length ? out : null;
	}

	// --- the mount: the DOM half -----------------------------------------

	function clock(t) {
		const opts = typeof window === 'object' && window.mjTimeOpts ? window.mjTimeOpts() : {};
		return new Date(t).toLocaleTimeString([], Object.assign(
			{ hour: '2-digit', minute: '2-digit', second: '2-digit' }, opts));
	}

	function mount(box) {
		if (!box) return null;
		const st = store();
		const list = document.createElement('ol');
		list.className = 'mj-plates-list';
		const empty = document.createElement('p');
		empty.className = 'mj-plates-empty';
		empty.textContent = 'Waiting for a plate. Reads appear here as the camera makes them, ' +
			'while this page is open.';
		box.appendChild(empty);
		box.appendChild(list);

		function paint() {
			const reads = st.reads();
			empty.hidden = reads.length > 0;
			while (list.firstChild) list.removeChild(list.firstChild);
			for (const r of reads) {
				const li = document.createElement('li');
				const t = document.createElement('span');
				t.className = 'mj-plates-time';
				t.textContent = clock(r.at);
				const p = document.createElement('span');
				p.className = 'mj-plates-text';
				p.textContent = r.text;
				const m = document.createElement('span');
				m.className = 'mj-plates-meta';
				m.textContent = (r.score ? r.score + '% sure' : '') +
					(r.vehicle ? (r.score ? ', ' : '') + 'vehicle #' + r.vehicle : '');
				li.appendChild(t);
				li.appendChild(p);
				li.appendChild(m);
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
		open();
		paint();

		return {
			destroy: function () {
				closed = true;
				if (ws) { try { ws.close(); } catch (e) {} }
			},
		};
	}

	const api = { store: store, missing: missing, mount: mount, MAX: MAX, SAME_MS: SAME_MS };
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticPlates = api;
})();
