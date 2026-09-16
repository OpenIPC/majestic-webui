// Finding out what a pin is wired to, by driving it and watching.
//
// TWO HUNTS, ONE DOOR, and the difference between them is the DETECTOR.
//
// The older one drives pins in PAIRS and reads its answer off the picture,
// because that is what an IR-cut filter is: two pins across a bridge, and the
// one thing on these pins the camera's own lens can see. It lived on the Day /
// Night page for that reason. But it finds a filter and it can never find
// anything else, and the person who prompted this work was soldering a
// wireless module to a converted camera -- he wanted the pin that switches it
// on, which changes nothing in frame.
//
// So there is a second hunt, and it asks a different question: not "did the
// picture change" but "did anything plug itself into this camera". A module
// coming up is not subtle -- an interface appears, a device enumerates, a card
// announces itself -- and the camera can see all of it without anyone
// watching. Hold a pin, look again, and the difference names what the pin
// does.
//
// That is why the whole thing lives with the pins now rather than with day and
// night: the filter is one of the things it can find, not its identity. Day /
// Night keeps what is genuinely its own -- which pin each coil is on, and
// testing the filter once they are set.
//
// The pure halves -- which pins to try, in what order, and what to make of an
// interrupted run -- stay in ircut-scan.js and pin-sweep.js, where they are
// tested without a browser. This file is the part you can see.
(function () {
	'use strict';

	// The section's own classes, set on every repaint because each card
	// replaces the last. Both, always: two of these four used to set only the
	// first, and the second is what gives the section its margin on the page it
	// now lives on.
	const HOST_CLASS = 'mj-ircut-scan mj-pins-hunt';

	const SCAN = () => window.MajesticIrcutScan;
	const SWEEP = () => window.MajesticPinSweep;

	function el(tag, cls, text) {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text !== undefined) e.textContent = text;
		return e;
	}

	function esc(s) {
		return String(s).replace(/[&<>"]/g, (c) =>
			({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
	}

	const API = '/api/v1/gpio';
	const FETCH = (u, o) => (window.apiFetch || window.fetch)(u, o);

	// What to say to somebody coming back to a scan that did not finish.
	//
	// Three things can have ended it and they need three different answers —
	// see resumeVerdict() in ircut-scan.js, where the distinction is drawn.
	// The one that matters most is 'cut': a pad can take ethernet down without
	// troubling the camera at all, so from the camera's side nothing went
	// wrong and it has no way to know. Only the browser saw the request
	// vanish, and only the person can say whether that pad is the reason.
	//
	// The host is the Pins page's own, handed in at mount. On the page this
	// came from it had to be one specific element, because the metrics
	// heartbeat wiped the obvious one on every tick and took the warning with
	// it -- a trap worth remembering, and no longer this file's to avoid.
	function resumeCard(info) {
		const S = SCAN();
		const host = hostOf();
		if (!SCAN || !host) return;

		const PADS = window.MajesticIrcutPads;
		const part = PADS ? PADS.forSoc(state.soc || '') : {};
		const total = S.pairs(info, { part: part }).length;
		const v = S.resumeVerdict(info, scanProgress(), total);
		if (!v) return;

		const pins = (v.pins || []).map(Number).filter((n) => !isNaN(n));
		const both = pins.length > 1;
		const named = both ? 'pins ' + esc(pins.join(' and ')) : 'pin ' + esc(String(pins[0]));

		host.hidden = false;
		host.className = HOST_CLASS;
		let body, cls, acts;
		if (v.kind === 'down') {
			cls = 'alert-warning';
			body = '<b>The last scan stopped the camera.</b> It was driving ' + named +
				' when it stopped answering. ' + (both ? 'Those pins have' : 'That pin has') +
				' been put on the camera\u2019s do-not-drive list and will not be tried ' +
				'again \u2014 by this page or anything else.';
			acts = [['Carry on', 'primary', 'go'], ['Start over', 'outline-secondary', 'reset']];
		} else if (v.kind === 'cut') {
			cls = 'alert-warning';
			body = '<b>The scan stopped while driving ' + named + '.</b> The camera stayed ' +
				'up, so something cut the connection rather than the camera crashing \u2014 ' +
				'which can be exactly what driving that pad does, if the network is on it. ' +
				'The camera has no way to know: from where it stands nothing went wrong.';
			acts = [['Never try ' + (both ? 'those two' : 'that one'), 'primary', 'avoid'],
				[(both ? 'They were' : 'It was') + ' fine, carry on', 'outline-secondary', 'go']];
		} else {
			cls = 'alert-secondary';
			body = '<b>' + v.done + ' of ' + v.total + ' pairs done.</b> The scan did not ' +
				'finish. Carrying on picks up the pairs it never reached.';
			acts = [['Carry on', 'primary', 'go'], ['Start over', 'outline-secondary', 'reset']];
		}

		host.innerHTML =
			'<div class="mj-live-grp-head"><span class="mj-cap">Find the day/night ' +
			'filter</span><span class="mj-live-rule"></span></div>' +
			'<div class="alert ' + cls + ' py-2 px-3 mb-2 small">' + body + '</div>' +
			'<div class="d-flex gap-2 align-items-center">' +
			acts.map((a) => '<button type="button" class="btn btn-' + a[1] +
				' btn-sm" data-do="' + a[2] + '">' + a[0] + '</button>').join('') +
			'</div>';

		host.querySelectorAll('button[data-do]').forEach((b) => {
			b.addEventListener('click', () => {
				const act = b.getAttribute('data-do');
				const go = () => openScan(state.info || info);
				if (act === 'reset') {
					// Forgetting where it got to is not forgetting what hurt
					// it. forget=progress drops the camera's record of the last
					// pads it drove and keeps its leave-alone list; this
					// browser's own progress goes with it.
					//
					// Clearing only the browser's half -- which is what this
					// did -- left the camera's record standing for good, and
					// that record is what a later visit reads to decide whether
					// anything went wrong.
					scanRemember(null);
					forgetProgress()
						.then(() => refreshInfo())
						.then((fresh) => openScan(fresh), () => go());
					return;
				}
				const p = scanProgress();
				if (p) { p.inflight = null; scanRemember(p); }
				if (act !== 'avoid') { go(); return; }
				Promise.all(pins.map((n) => scanAvoid(n, true)))
					.then(() => FETCH('/api/v1/gpio', { credentials: 'same-origin' }))
					.then((r) => r.json())
					.then((fresh) => { state.info = fresh; openScan(fresh); })
					.catch(() => go());
			});
		});
	}

	// ── remembering where a scan got to ─────────────────────────────────────
	//
	// In the BROWSER, and the asymmetry is the point: the camera is the thing
	// that reboots, the browser is not. Recording every tried pair on the
	// camera would be several hundred growing, synced writes to flash during
	// one sweep, to remember something this page already knows. What has to
	// live on the camera is the much smaller fact that a pin is dangerous —
	// that one must survive the reboot it caused, and it does.
	//
	// try/catch at both ends, a shape check on read, and a stamp of the state
	// it was measured against so it invalidates itself rather than being
	// replayed against a different board -- the idiom every other store in
	// this directory uses.
	// One store per hunt. They cover different ground -- pairs on one side,
	// single pads at a level on the other -- so a key shared between them
	// would have each skipping what the other had tried.
	/* A find on its way to the page that owns the wiring fields. sessionStorage
	 * rather than localStorage: a proposal must not outlive the tab, or a
	 * reader comes back next week to a Save bar holding pins from a board that
	 * is no longer on the desk. */
	const PROPOSAL_KEY = 'mj-ircut-proposal';

	const SCAN_KEY = 'mj-ircut-scan';
	const SWEEP_KEY = 'mj-pin-sweep';

	function progressIn(key) {
		try {
			const v = JSON.parse(localStorage.getItem(key) || 'null');
			if (!v || typeof v.sig !== 'string' || !Array.isArray(v.done)) return null;
			return v;
		} catch (e) {
			return null;
		}
	}

	function rememberIn(key, v) {
		try {
			if (v === null) localStorage.removeItem(key);
			else localStorage.setItem(key, JSON.stringify(v));
		} catch (e) {
			/* Not remembered is a worse hunt, not a broken one. */
		}
	}

	const scanProgress = () => progressIn(SCAN_KEY);
	const scanRemember = (v) => rememberIn(SCAN_KEY, v);
	const sweepProgress = () => progressIn(SWEEP_KEY);
	const sweepRemember = (v) => rememberIn(SWEEP_KEY, v);

	// Ask the camera to leave a pad alone, or take that back. The list is the
	// camera's because it has to outlive this page and the reboot that made it.
	function scanAvoid(pin, on) {
		return FETCH(API + '?' + (on ? 'avoid=' : 'unavoid=') + pin,
			{ method: 'POST', credentials: 'same-origin' })
			.then((r) => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)));
	}

	// Re-read what the camera says, because every one of these changes it and
	// redrawing from a stale copy shows the owner their press doing nothing.
	function refreshInfo() {
		return FETCH(API, { credentials: 'same-origin' })
			.then((r) => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
			.then((fresh) => { state.info = fresh; return fresh; });
	}

	// Starting over is TWO records, and until now this page cleared only one.
	//
	// The browser remembers which pairs it has tried; the camera separately
	// remembers the last pads it drove, written to flash before it touched
	// them so that it describes a camera which may never have come back.
	// Clearing the browser's half alone left the camera's standing for good,
	// and it is the half a later visit reads to decide whether anything went
	// wrong.
	//
	// forget=progress, never forget=all: the camera keeps what it has been
	// told to leave alone either way, and starting over is not a reason to
	// walk back onto a pad that stopped it.
	function forgetProgress() {
		return FETCH(API + '?forget=progress',
			{ method: 'POST', credentials: 'same-origin' })
			.then((r) => r.ok ? r.json() : null, () => null);
	}

	// The deliberate one. It is the only way back for a pad the camera went
	// down on, and the only thing here that throws evidence away -- so it asks
	// twice, and says what is being lost.
	function forgetAvoid() {
		return FETCH(API + '?forget=avoid',
			{ method: 'POST', credentials: 'same-origin' })
			.then((r) => r.ok ? r.json() : null, () => null);
	}

	// What the camera has been told to leave alone, in words and with a way
	// back. The list lives on the camera because it must outlive this page and
	// the reboot that made it -- and until now nothing here could show it
	// whole, or take any of it back except one pad at a time in the drawing.
	function avoidBlock(info) {
		const rows = (info.avoid || [])
			.filter((a) => a && typeof a.pin === 'number')
			.sort((a, b) => a.pin - b.pin);
		if (!rows.length) return '';
		const down = rows.filter((a) => a.why !== 'asked').length;
		const asked = rows.length - down;
		const bits = [];
		if (asked) bits.push(asked + ' you excluded');
		if (down) bits.push(down + ' that stopped the camera');

		return '<p class="x-small text-secondary mb-1 mt-3">The camera is ' +
			'leaving <b>' + rows.length + ' pin' + (rows.length > 1 ? 's' : '') +
			'</b> alone &mdash; ' + esc(bits.join(', ')) + '. ' +
			'<button type="button" class="btn btn-link btn-sm p-0 align-baseline ' +
			'x-small" data-do="show-avoid">show</button></p>' +
			'<div class="x-small text-secondary mb-0" id="mj-hunt-avoid" hidden>' +
			rows.map((a) => 'Pin ' + esc(String(a.pin)) + ' &mdash; ' +
				(a.why === 'asked' ? 'you excluded it' : 'it stopped the camera') +
				' <button type="button" class="btn btn-link btn-sm p-0 ' +
				'align-baseline x-small" data-try="' + esc(String(a.pin)) +
				'">try it again</button>').join('<br>') +
			'<p class="mb-0 mt-2" id="mj-hunt-forget">' +
			'<button type="button" class="btn btn-outline-secondary btn-sm" ' +
			'data-do="forget-avoid">Forget the whole list</button>' +
			(down
				? ' Including the pin' + (down > 1 ? 's' : '') + ' that stopped ' +
					'the camera. Nothing else anywhere remembers ' +
					(down > 1 ? 'those' : 'that') + '.'
				: '') +
			'</p></div>';
	}

	// Draw it, and wire the three things it can do.
	function wireAvoid(host, info) {
		const show = host.querySelector('button[data-do="show-avoid"]');
		const list = host.querySelector('#mj-hunt-avoid');
		if (show && list) {
			show.addEventListener('click', () => {
				list.hidden = !list.hidden;
				show.textContent = list.hidden ? 'show' : 'hide';
			});
		}
		const redraw = () => refreshInfo()
			.then((fresh) => {
				if (pins.changed) pins.changed();
				idleCard(fresh);
			})
			.catch(() => idleCard(state.info || info));

		host.querySelectorAll('button[data-try]').forEach((b) => {
			b.addEventListener('click',
				() => scanAvoid(Number(b.getAttribute('data-try')), false)
					.then(redraw, redraw));
		});

		const gone = host.querySelector('button[data-do="forget-avoid"]');
		if (!gone) return;
		gone.addEventListener('click', () => {
			// Asked twice on purpose. A pad the camera went down on is proof
			// that cost a crash and a reboot to earn, and there is no backup of
			// it anywhere -- one press should not be able to spend that.
			const p = host.querySelector('#mj-hunt-forget');
			p.innerHTML = '<b>Forget all of them?</b> ' +
				'<button type="button" class="btn btn-danger btn-sm" ' +
				'id="mj-hunt-forget-yes">Yes, forget</button> ' +
				'<button type="button" class="btn btn-outline-secondary btn-sm" ' +
				'id="mj-hunt-forget-no">Keep them</button>';
			p.querySelector('#mj-hunt-forget-no')
				.addEventListener('click', () => idleCard(state.info || info));
			p.querySelector('#mj-hunt-forget-yes')
				.addEventListener('click', () => forgetAvoid().then(redraw, redraw));
		});
	}

	// What the scan is going to leave alone, in one line and a list.
	//
	// Counted from the same facts the sweep is built from rather than
	// described in the abstract, so the number cannot drift away from what
	// actually happens.
	function skipped(info, range) {
		const owned = {}, avoided = {}, down = {};
		(info.assigned || []).forEach((a) => {
			if (a.role !== 'irCutPin1' && a.role !== 'irCutPin2') owned[a.pin] = 'the camera needs it';
		});
		(info.held || []).forEach((h) => {
			if (h.owner && h.owner !== 'sysfs') owned[h.pin] = 'a kernel driver holds it';
		});
		// What the chip says a pad is carrying right now. Present only where
		// the camera could ask — absent means "cannot check", not "all clear",
		// and the two must not read the same.
		const now = info.padNow;
		if (now) {
			Object.keys(now).forEach((k) => {
				owned[k] = now[k] ? 'carrying ' + now[k] : 'the camera needs it';
			});
		}
		(info.avoid || []).forEach((a) => {
			if (!a || typeof a.pin !== 'number') return;
			if (a.why === 'asked') avoided[a.pin] = 'you excluded it';
			else down[a.pin] = 'it stopped the camera';
		});

		let pads = 0;
		(info.banks || []).forEach((b) => { pads += b.n; });
		const nOwned = Object.keys(owned).length;
		const nAsked = Object.keys(avoided).length;
		const nDown = Object.keys(down).length;

		const bits = [];
		if (nOwned) bits.push(nOwned + ' the camera needs');
		if (nAsked) bits.push(nAsked + ' you excluded');
		if (nDown) bits.push(nDown + ' that stopped the camera');

		let words = '';
		words += bits.length
			? '<b>' + (nOwned + nAsked + nDown) + ' of ' + pads +
				' pins are being left alone</b> &mdash; ' +
				esc(bits.join(', ')) + '.'
			: 'Nothing is being left alone.';
		if (range) {
			words += ' Limited to pins ' +
				esc(range.from === undefined ? 'the start' : String(range.from)) + '&ndash;' +
				esc(range.to === undefined ? 'the end' : String(range.to)) + '.';
		}
		// Said plainly rather than implied by a smaller number: a camera whose
		// pads cannot be read has NOT been checked, and a page that stayed
		// quiet about that would be promising a safety the scan does not have.
		if (!now) {
			words += ' This camera cannot say what its pads are carrying, so only ' +
				'pads it has been told about are skipped.';
		}

		const rows = [];
		const add = (m) => Object.keys(m).sort((a, b) => a - b)
			.forEach((k) => rows.push('Pin ' + esc(k) + ' &mdash; ' + esc(m[k])));
		add(down); add(avoided); add(owned);
		return { words: words, detail: rows.length ? rows.join('<br>') : null };
	}

	// Finding the pins by driving them. This is the only control in the WebUI
	// that can stop a camera answering, so it asks first, in those words, and
	// the endpoint behind it journals each pad to flash before touching it.
	function openScan(info) {
		const S = SCAN();
		if (!SCAN) return;
		const host = hostOf();
		// Taking the element over destroys whatever verdict was in it, so the
		// assignment that verdict was measured against stops meaning anything.
		
		
		// What the wiki's table records about this part: the pairs to try first,
		// and the pads it names as a reset, a USB enable or an illuminator, to
		// try last. Absent for a part the table has never seen, which is the
		// behaviour the sweep had before the table was read at all.
		const PADS = window.MajesticIrcutPads;
		const part = PADS ? PADS.forSoc(state.soc || '') : {};
		// `exclude` is gone: what the camera has been told to leave alone
		// arrives in `info.avoid` and outlives this page, which the old
		// in-memory list did not — a second pin taking the camera down used to
		// lose the first.
		let stop = false;

		// Where this browser got to, if it was here before and the chip has
		// not changed under it.
		const sig = S.stamp(info);
		let prog = scanProgress();
		if (prog && prog.sig !== sig) {
			prog = null;
			scanRemember(null);
		}
		// The range the scan was STARTED with outranks whatever this page
		// happens to hold: a reload empties state.range, and carrying on over
		// the whole chip is not carrying on.
		const range = (prog ? SWEEP().storedRange(prog) : null) || state.range || null;
		state.range = range;
		const list = S.pairs(info, { part: part, only: range });
		const todo = prog ? S.remaining(list, prog.done) : list;

		host.hidden = false;
		host.className = HOST_CLASS;
		// Dressed as a group of this section, not as an announcement inside it:
		// micro-caps head, hairline to the margin, note on the right, small body
		// — the same head the deck gives Wiring and Connected to. A lead
		// paragraph at full body size was the only 1rem text on the page.
		host.innerHTML =
			'<div class="mj-live-grp-head"><span class="mj-cap">Find the day/night ' +
			'filter</span><span class="mj-live-rule"></span>' +
			'<span class="mj-live-note" id="mj-scan-n"></span></div>' +
			'<p class="small mb-2">Each pin is driven against another while the ' +
			'picture is watched for the filter to move. A filter is driven across ' +
			'two pins, so pairs are what get tried; the pairs other boards use go ' +
			'first, so this usually ends in seconds.</p>' +
			'<div class="alert alert-warning py-2 px-3 mb-2 small">' +
			'<b>This drives pins whose job is unknown.</b> One of them may reset the ' +
			'network, cut power to the sensor, or stop the camera answering. That risk ' +
			'cannot be removed &mdash; only made survivable: each pin is written to flash ' +
			'before it is driven, so a camera that has to be restarted comes back knowing ' +
			'which pin did it.</div>' +
			'<p class="x-small text-secondary mb-2">Pins already spoken for are skipped. ' +
			// Said only where it is true. The table is per board, so this is an
			// order and not a promise — the pads are still driven if nothing
			// before them moved the filter, which is why the warning above
			// keeps its wording either way.
			(part.known
				? 'Pins that other boards with this chip use for a reset, a USB enable ' +
					'or an illuminator are tried last, and the pairs recorded for it first. '
				: '') +
			'This reads the picture, so it needs daylight &mdash; at night nothing will ' +
			'look like it moved.</p>' +
			'<div class="d-flex gap-2 align-items-center">' +
			'<button type="button" class="btn btn-primary btn-sm" id="mj-scan-go">Start</button>' +
			'<button type="button" class="btn btn-outline-secondary btn-sm" id="mj-scan-no">Cancel</button>' +
			'</div>';
		host.querySelector('#mj-scan-n').textContent =
			(todo.length === list.length
				? list.length + ' pairs to try'
				: todo.length + ' of ' + list.length + ' left');

		// What is being left alone, counted and named. Somebody is about to
		// press a button that can take the camera away; the honest thing is to
		// say what it will touch before they do, rather than after.
		const left = skipped(info, range);
		const sum = el('p', 'x-small text-secondary mb-2');
		sum.innerHTML = left.words;
		if (left.detail) {
			const more = el('button', 'btn btn-link btn-sm p-0 align-baseline x-small');
			more.type = 'button';
			more.textContent = 'show';
			const det = el('div', 'x-small text-secondary mb-2');
			det.hidden = true;
			det.innerHTML = left.detail;
			more.addEventListener('click', () => {
				det.hidden = !det.hidden;
				more.textContent = det.hidden ? 'show' : 'hide';
			});
			sum.appendChild(document.createTextNode(' '));
			sum.appendChild(more);
			host.insertBefore(sum, host.querySelector('.d-flex'));
			host.insertBefore(det, host.querySelector('.d-flex'));
		} else {
			host.insertBefore(sum, host.querySelector('.d-flex'));
		}

		// "Only try pins N to M". The console script this replaces takes a
		// from/to range and walks straight through; here the list is
		// prioritised pairs, so a range limits WHICH PADS are in play rather
		// than where the walk starts. Carrying on from where a scan stopped is
		// a different thing and is handled above, better than a start number
		// could — it skips exactly what was tried, in any order.
		const rng = el('p', 'x-small text-secondary mb-2');
		rng.innerHTML = 'Only try pins <input type="number" class="mj-live-num" ' +
			'id="mj-scan-from" min="0" step="1" style="width:4.5rem"> to ' +
			'<input type="number" class="mj-live-num" id="mj-scan-to" min="0" ' +
			'step="1" style="width:4.5rem"> <span class="text-secondary">' +
			'&mdash; leave both empty for the whole chip</span>';
		host.insertBefore(rng, host.querySelector('.d-flex'));
		const from = rng.querySelector('#mj-scan-from');
		const to = rng.querySelector('#mj-scan-to');
		if (range && range.from !== undefined) from.value = range.from;
		if (range && range.to !== undefined) to.value = range.to;
		const reRange = () => {
			const f = from.value === '' ? undefined : Number(from.value);
			const t = to.value === '' ? undefined : Number(to.value);
			state.range = (f === undefined && t === undefined)
				? null : { from: f, to: t };
			openScan(info);
		};
		from.addEventListener('change', reRange);
		to.addEventListener('change', reRange);

		host.querySelector('#mj-scan-no').addEventListener('click', () => {
			stop = true;
			idleCard(state.info || info);
		});
		host.querySelector('#mj-scan-go').addEventListener('click', () => {
			host.innerHTML =
				'<div class="mj-live-grp-head"><span class="mj-cap">Scanning</span>' +
				'<span class="mj-live-rule"></span>' +
				'<span class="mj-live-note" id="mj-scan-s"></span></div>' +
				'<p class="small mb-2" id="mj-scan-t">Starting&hellip;</p>' +
				'<button type="button" class="btn btn-outline-secondary btn-sm" id="mj-scan-stop">Stop</button>';
			const t = host.querySelector('#mj-scan-t');
			const s = host.querySelector('#mj-scan-s');
			host.querySelector('#mj-scan-stop').addEventListener('click', () => { stop = true; });

			S.run({
				// A refusal and a failure are not the same answer. The endpoint
				// guards pads with owners and says so with a 200 carrying
				// done:false — that pair is skipped and the sweep goes on. A
				// request that does not arrive at all is a camera that has
				// stopped answering, and flattening it into "this pair did not
				// move anything" made the scan keep firing GPIO writes at a dead
				// camera for another two hundred pairs and then report that
				// nothing moved. It rejects now, and the sweep stops.
				// POST, not GET: driving a pad is a mutation, and a GET is what
				// a browser issues by itself — a prefetch, a restored tab, a
				// link from anywhere — carrying the session with it.
				// The in-flight pair is written BEFORE the request goes out and
				// cleared when it comes back. That one field is what lets a
				// later visit tell "the camera went down" from "something cut
				// the connection" — the camera journals the first for itself,
				// but the second leaves no trace on it at all, because from
				// where it stands nothing went wrong.
				drive: (a, b) => {
					const pr = scanProgress() || { sig: sig, done: [] };
					pr.range = range;
					pr.inflight = S.key(a, b);
					scanRemember(pr);
					return FETCH('/api/v1/gpio?pair=' + a + ',' + b,
						{ method: 'POST', credentials: 'same-origin' })
						.then((r) => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
						.then((j) => {
							const p2 = scanProgress();
							if (p2) { p2.inflight = null; scanRemember(p2); }
							return j;
						});
				},
				// Releasing a pair is the scan saying it is RULED OUT, so that
				// is where the pair is written down as done.
				//
				// It used to be recorded one step behind, at the start of the
				// next pair, which never recorded the last one: stopping a scan
				// and carrying on re-drove the pair it had just finished. The
				// range it was started with rides along, because a reload
				// empties the page's copy and resuming over the whole chip is
				// not resuming.
				release: (a, b) => {
					const pr = scanProgress() || { sig: sig, done: [] };
					pr.range = range;
					const k = S.key(a, b);
					if (pr.done.indexOf(k) < 0) pr.done.push(k);
					scanRemember(pr);
					return FETCH(
						'/api/v1/gpio?park=' + a + ',' + b + '&mode=float',
						{ method: 'POST', credentials: 'same-origin' })
						.then((r) => r.ok ? r.json()
							: Promise.reject(new Error('HTTP ' + r.status)));
				},
				look: () => window.MajesticIrcut.snapshot('/image.jpg'),
				wait: (ms) => new Promise((r) => setTimeout(r, ms)),
				stopped: () => stop || stopped,
				onStep: (st) => {
					t.textContent = 'Trying pins ' + st.a + ' and ' + st.b;
					s.textContent = (st.index + 1) + ' of ' + st.total;
					// Both pads, not just the first. A pair is what gets
					// driven, and lighting one of the two made the drawing
					// disagree with the sentence above it.
					pins.sweep(st.a, st.b);
				},
			}, todo).then((res) => {
				pins.sweep(null, null);
				// A sweep that ran to the end has nothing to carry on from.
				if (res.done) scanRemember(null);
				const found = res.pins;
				if (!found) {
					host.innerHTML = '<div class="mj-live-grp-head">' +
						'<span class="mj-cap">Find the day/night filter</span>' +
						'<span class="mj-live-rule"></span></div>' +
						'<div class="alert alert-secondary py-2 px-3 mb-0 small">' +
						'<b>Nothing moved the picture.</b> Either the filter is on a pair this ' +
						'scan did not reach, or there is not enough light to see it move. ' +
						'Try again in daylight, or set the pins by hand.' +
						// Named because it is a real class of camera the sweep
						// cannot reach, rather than a gap in the pad list. A
						// single-pad filter is moved by HOLDING one pad at a
						// level, and holding a pad is the thing this scan may
						// not do: on a two-coil board it would leave a winding
						// carrying current, which is why every actuation here
						// is a brief pulse across a pair. So that wiring is
						// found by hand and confirmed by the test (#273).
						'<br><br>A filter driven from a single pad is not something ' +
						'this sweep can find: it works by pulsing pairs, and a ' +
						'single-pad filter is moved by holding one pad at a level, ' +
						'which is not safe to do to a pad whose job is unknown. ' +
						'If yours is wired that way, put the pad on the opening coil ' +
						'yourself and press <b>Test the filter</b>.</div>';
					return;
				}
				// The pair itself was watched moving the picture, so it is
				// reported either way; what may be missing is the classification
				// and the guarantee that the filter was left closed.
				// brakeHeld is three-valued. null is a test that did not run:
				// one of these pads is already majestic's, so it was braked
				// rather than let go of, and there is no way to see whether the
				// filter would have sprung open. Saying "it holds its position
				// on its own" from that would be a claim made about a pad
				// nothing released (#273).
				const tail = !found.settled
					? 'The checks after that did not finish, so the filter may not have ' +
						'been left closed &mdash; look at the picture before trusting it.'
					: found.brakeHeld === null
						? 'Whether it holds its position on its own was not tested: ' +
							'majestic is already driving one of these pads, and letting ' +
							'go of it here would have moved the filter.'
						: found.brakeHeld
							? 'It springs open when the pins are released, so they have to stay driven.'
							: 'It holds its position on its own.';
				host.innerHTML = '<div class="mj-live-grp-head">' +
					'<span class="mj-cap">Find the day/night filter</span>' +
					'<span class="mj-live-rule"></span></div>' +
					'<div class="alert ' + (found.settled ? 'alert-success' : 'alert-warning') +
					' py-2 px-3 mb-2 small"><b>' +
					(found.settled ? 'Found it.' : 'Found the pins, but not cleanly.') + '</b> ' +
					'Pins ' + esc(String(found.irCutPin1)) + ' and ' + esc(String(found.irCutPin2)) +
					' drive the filter &mdash; ' + esc(String(found.closesWhenHigh)) +
					' is the one that closes it. ' + tail +
					'</div><button type="button" class="btn btn-primary btn-sm" id="mj-scan-use">' +
					'Use these as the filter&rsquo;s pins</button>' +
					'<p class="x-small text-secondary mb-0 mt-2" id="mj-scan-used"></p>';
				const said = host.querySelector('#mj-scan-used');
				host.querySelector('#mj-scan-use').addEventListener('click', () => {
					// PROPOSED, not written. "Nothing is written to majestic
					// behind anyone's back: the proposal is staged into the
					// hidden fields and the ordinary save bar appears"
					// (CLAUDE.md), and that is not a convention about where a
					// button lives -- the Day / Night page's filter test reads
					// the camera's wiring through those fields, and refuses to
					// run while they are dirty precisely so a verdict cannot
					// describe an assignment the camera never had. Writing the
					// config from another page steps around the one mechanism
					// that keeps that honest.
					//
					// So the find crosses the page boundary as a PROPOSAL and
					// is staged on arrival, where the save bar and the dirty
					// tracking already are. sessionStorage because it must not
					// outlive the tab: a proposal restored a week later would
					// stage wiring from a board that is no longer on the desk.
					//
					// Which pad OPENS and which CLOSES is the measurement, not
					// a convention -- swapping them leaves a filter that moves
					// the wrong way at dusk, which looks like a broken camera.
					try {
						sessionStorage.setItem(PROPOSAL_KEY, JSON.stringify({
							irCutPin1: found.irCutPin1,
							irCutPin2: found.irCutPin2,
							sig: SCAN().stamp(state.info || info),
						}));
					} catch (e) {
						said.textContent = 'This browser would not carry the '
							+ 'find across. The pins are ' + found.irCutPin1
							+ ' and ' + found.irCutPin2 + '; set them on the '
							+ 'Day / Night page.';
						return;
					}
					said.innerHTML = 'Taking you to <b>Day / Night</b>, where '
						+ 'these land in the wiring fields with the Save bar '
						+ 'up \u2014 nothing is written until you press it.';
					const link = document.querySelector(
						'#mj-settings-nav a.nav-link[href*="tab=nightMode"]');
					if (link) link.click();
					else location.href = 'camera.cgi?tab=nightMode';
				});
			});
		});
	}
	// The resting state: what this is, and the one button that starts it.
	//
	// The warning is not here. It belongs on the confirm card, next to the
	// press that actually drives a pad -- a page that shouts before you have
	// asked for anything is a page people learn to scroll past.
	function idleCard(info) {
		const host = hostOf();
		if (!host) return;
		host.hidden = false;
		host.className = HOST_CLASS;

		const why = cannotHunt(info);
		// Can this camera hold ONE pin and say what turned up?
		//
		// `attached` is the inventory the hold hunt diffs, and it arrives in
		// the same answer. A camera without it is one whose daemon predates
		// the hunt: the endpoint ignores an unknown parameter and hands back
		// its pad list, which this page would have read as "held it, nothing
		// happened" -- two hundred times, cheerfully, finding nothing. Offer
		// the hunt that exists rather than the one that does not.
		const canHold = !!(info && info.attached);
		const sp = sweepProgress();
		const carry = sp && sp.sig === SCAN().stamp(info) && sp.done.length
			? sp.done.length : 0;

		host.innerHTML =
			'<div class="mj-live-grp-head"><span class="mj-cap">Find a pin</span>' +
			'<span class="mj-live-rule"></span></div>' +
			'<p class="small mb-3">Something is soldered to a pin and you do not ' +
			'know which one. The camera can work it out on its own: it drives ' +
			'pins, one at a time, and watches for anything to change. You do not ' +
			'have to sit and watch \u2014 it does the watching.</p>' +
			(why ? '<p class="x-small text-secondary mb-0">' + esc(why) + '</p>' : '') +
			(why ? '' :
				'<div class="mj-hunt-offers">' +
				(!canHold ? '' :
				'<div class="mj-hunt-offer">' +
				'<button type="button" class="btn btn-primary btn-sm" id="mj-hunt-sweep">' +
				(carry ? 'Carry on finding it' : 'What is my pin wired to?') + '</button>' +
				'<p class="x-small text-secondary mb-0 mt-1">For anything that comes ' +
				'alive when it gets a signal \u2014 a wireless card, a card slot, a ' +
				'second network port, a relay board. The camera holds each pin in ' +
				'turn and tells you the moment something appears, or disappears.' +
				(carry
					? ' <b>' + carry + ' already tried.</b> <button type="button" ' +
						'class="btn btn-link btn-sm p-0 align-baseline x-small" ' +
						'data-do="sweep-reset">start over</button>'
					: '') +
				'</p></div>') +
				'<div class="mj-hunt-offer">' +
				'<button type="button" class="btn btn-outline-secondary btn-sm" ' +
				'id="mj-hunt-go">Which pins move the day/night filter?</button>' +
				'<p class="x-small text-secondary mb-0 mt-1">The filter is the one ' +
				'thing on these pins the camera can see through its own lens, so ' +
				'this one works differently: it drives pins two at a time and ' +
				'watches the picture. Needs daylight.</p></div>' +
				'</div>' +
				(canHold ? '' :
					'<p class="x-small text-secondary mb-0 mt-2">This camera\u2019s ' +
					'software is too old to hold a single pin and report what ' +
					'turned up, so only the filter hunt is offered. Updating it ' +
					'adds the other one.</p>')) +
			avoidBlock(info);

		const go = host.querySelector('#mj-hunt-go');
		if (go) go.addEventListener('click', () => openScan(state.info || info));
		const sw = host.querySelector('#mj-hunt-sweep');
		if (sw) sw.addEventListener('click', () => openSweep(state.info || info));
		const rst = host.querySelector('button[data-do="sweep-reset"]');
		if (rst) {
			rst.addEventListener('click', () => {
				sweepRemember(null);
				// Both records, not just this browser's -- see forgetProgress().
				forgetProgress()
					.then(() => refreshInfo())
					.then((fresh) => idleCard(fresh), () => idleCard(state.info || info));
			});
		}
		wireAvoid(host, info);
	}

	// A pin the camera stopped answering on, offered back to its owner.
	//
	// The browser is the only witness: the camera journals a pad that took it
	// DOWN, but one that merely cut the connection leaves no trace on it at all
	// because from where it stands nothing went wrong. Shown both while the
	// hunt is running and on a later visit, because a reload is exactly how
	// this ends.
	function lostCard(info, pin, level) {
		const host = hostOf();
		host.hidden = false;
		host.className = HOST_CLASS;
		host.innerHTML =
			'<div class="mj-live-grp-head"><span class="mj-cap">Find a pin</span>' +
			'<span class="mj-live-rule"></span></div>' +
			'<div class="alert alert-warning py-2 px-3 mb-2 small">' +
			'<b>The camera stopped answering while holding pin ' +
			esc(String(pin)) + ' ' + esc(level) + '.</b> If it is back now, the ' +
			'pin did not crash it \u2014 it cut this connection, which usually ' +
			'means the network is on that pin. That is worth knowing, and it is ' +
			'worth never touching again.</div>' +
			'<div class="d-flex gap-2 align-items-center">' +
			'<button type="button" class="btn btn-primary btn-sm" data-do="avoid">' +
			'Never try pin ' + esc(String(pin)) + ' again</button>' +
			'<button type="button" class="btn btn-outline-secondary btn-sm" ' +
			'data-do="go">It was fine, carry on</button></div>';

		host.querySelectorAll('button[data-do]').forEach((b) => {
			b.addEventListener('click', () => {
				// Cleared either way: kept, it would offer the same choice
				// again on the next visit whatever was answered.
				const pr = sweepProgress();
				if (pr) { pr.inflight = null; sweepRemember(pr); }
				if (b.getAttribute('data-do') !== 'avoid') {
					openSweep(state.info || info);
					return;
				}
				scanAvoid(pin, true)
					.then(() => (pins.changed ? pins.changed() : null))
					.then(() => refreshInfo())
					.then((fresh) => openSweep(fresh),
						() => openSweep(state.info || info));
			});
		});
	}

	// ── the general hunt: hold one pin, see what turns up ────────────────────
	//
	// This is the half that answers "how am I supposed to find a GPIO?". The
	// filter sweep next door reads its answer off the picture, which finds a
	// filter and can never find anything else: the pin that switches on a
	// wireless module changes nothing in frame.
	//
	// So the detector is the camera's own account of what is attached to it.
	// It lists that, holds one pin at a level, lists again, and the difference
	// names what the pin does. Nobody watches anything, which is the only way
	// a hunt over two hundred pins ever gets finished.

	function sweepSkipped(info, range, all) {
		const SW = SWEEP();
		const shown = SW.pads(info, { only: range });
		let pads = 0;
		(info.banks || []).forEach((b) => { pads += b.n; });
		let words = '<b>' + shown.length + ' pins</b> out of ' + pads +
			' will be tried, at two levels each. ';
		const left = pads - all.length;
		words += left
			? '<b>' + left + ' are being left alone</b> \u2014 they already have a ' +
				'job, or you told the camera to stay off them.'
			: 'Nothing is being left alone.';
		if (range) {
			words += ' Limited to pins ' +
				esc(range.from === undefined ? 'the start' : String(range.from)) + '\u2013' +
				esc(range.to === undefined ? 'the end' : String(range.to)) + '.';
		}
		if (!info.padNow) {
			words += ' This camera cannot say what its pins are carrying, so only ' +
				'pins it has been told about are skipped.';
		}
		return words;
	}

	function openSweep(info) {
		const SW = SWEEP(), S = SCAN();
		const host = hostOf();
		if (!SW || !S || !host) return;

		const sig = S.stamp(info);
		let prog = sweepProgress();
		if (prog && prog.sig !== sig) { prog = null; sweepRemember(null); }

		// A pin whose request never came back is answered before anything else
		// is offered, because carrying on would put it straight back in the
		// list and cut the connection again.
		if (prog && prog.inflight) {
			const bits = String(prog.inflight).split(':');
			if (bits.length === 2 && bits[0] !== '' && !isNaN(Number(bits[0]))) {
				lostCard(info, Number(bits[0]), bits[1]);
				return;
			}
			prog.inflight = null;
			sweepRemember(prog);
		}

		// The range the hunt was STARTED with outranks whatever this page
		// happens to hold: a reload empties state.range, and resuming over the
		// whole chip is not resuming.
		const range = (prog ? SWEEP().storedRange(prog) : null) || state.range || null;
		state.range = range;
		const all = SW.pads(info);
		const list = SW.steps(SW.pads(info, { only: range }));
		const todo = prog ? SW.remaining(list, prog.done) : list;
		let stop = false;

		host.hidden = false;
		host.className = HOST_CLASS;
		host.innerHTML =
			'<div class="mj-live-grp-head"><span class="mj-cap">Find what a pin ' +
			'is wired to</span><span class="mj-live-rule"></span>' +
			'<span class="mj-live-note">' +
			(todo.length === list.length
				? list.length + ' to try'
				: todo.length + ' of ' + list.length + ' left') +
			'</span></div>' +
			'<p class="small mb-2">The camera writes down everything plugged into ' +
			'it, then holds one pin at a time and looks again. If something came ' +
			'online \u2014 or went away \u2014 that pin is the one, and the camera ' +
			'says what it was. It stops as soon as it finds something.</p>' +
			'<div class="alert alert-warning py-2 px-3 mb-2 small">' +
			'<b>This drives pins whose job is unknown.</b> One of them may reset ' +
			'the network, cut power to the sensor, or stop the camera answering. ' +
			'That risk cannot be removed \u2014 only made survivable: each pin is ' +
			'written to flash before it is driven, so a camera that has to be ' +
			'restarted comes back knowing which pin did it, and will not try it ' +
			'again.</div>' +
			'<p class="x-small text-secondary mb-2" id="mj-sweep-left"></p>' +
			'<p class="x-small text-secondary mb-2">Only try pins ' +
			'<input type="number" class="mj-live-num" id="mj-sweep-from" min="0" ' +
			'step="1" style="width:4.5rem"> to <input type="number" ' +
			'class="mj-live-num" id="mj-sweep-to" min="0" step="1" ' +
			'style="width:4.5rem"> <span class="text-secondary">\u2014 leave both ' +
			'empty for the whole chip</span></p>' +
			'<div class="d-flex gap-2 align-items-center">' +
			'<button type="button" class="btn btn-primary btn-sm" id="mj-sweep-go">Start</button>' +
			'<button type="button" class="btn btn-outline-secondary btn-sm" id="mj-sweep-no">Cancel</button>' +
			'</div>';
		host.querySelector('#mj-sweep-left').innerHTML =
			sweepSkipped(info, range, all);

		const from = host.querySelector('#mj-sweep-from');
		const to = host.querySelector('#mj-sweep-to');
		if (range && range.from !== undefined) from.value = range.from;
		if (range && range.to !== undefined) to.value = range.to;
		const reRange = () => {
			const f = from.value === '' ? undefined : Number(from.value);
			const t = to.value === '' ? undefined : Number(to.value);
			state.range = (f === undefined && t === undefined) ? null : { from: f, to: t };
			openSweep(info);
		};
		from.addEventListener('change', reRange);
		to.addEventListener('change', reRange);

		host.querySelector('#mj-sweep-no').addEventListener('click', () => {
			stop = true;
			idleCard(state.info || info);
		});
		host.querySelector('#mj-sweep-go').addEventListener('click', () => {
			host.innerHTML =
				'<div class="mj-live-grp-head"><span class="mj-cap">Looking</span>' +
				'<span class="mj-live-rule"></span>' +
				'<span class="mj-live-note" id="mj-sweep-s"></span></div>' +
				'<p class="small mb-2" id="mj-sweep-t">Starting&hellip;</p>' +
				'<button type="button" class="btn btn-outline-secondary btn-sm" ' +
				'id="mj-sweep-stop">Stop</button>';
			const t = host.querySelector('#mj-sweep-t');
			const s = host.querySelector('#mj-sweep-s');
			host.querySelector('#mj-sweep-stop')
				.addEventListener('click', () => { stop = true; });

			SW.run({
				// POST, not GET: holding a pin is a mutation, and a GET is what
				// a browser issues by itself -- a prefetch, a restored tab, a
				// link from anywhere -- carrying the session with it.
				//
				// The pin in flight is written BEFORE the request goes out and
				// cleared when it comes back. That one field is what lets a
				// later visit say which pin cut the connection: the camera
				// journals a pin that took it DOWN, but a pin that only took
				// the network away leaves no trace on it at all, because from
				// where it stands nothing went wrong.
				hold: (pin, level) => {
					const pr = sweepProgress() || { sig: sig, done: [] };
					pr.range = range;
					pr.inflight = SW.key(pin, level);
					sweepRemember(pr);
					return FETCH(API + '?hold=' + pin + '&level=' + level,
						{ method: 'POST', credentials: 'same-origin' })
						.then((r) => r.ok ? r.json()
							: Promise.reject(new Error('HTTP ' + r.status)))
						.then((j) => {
							const p2 = sweepProgress();
							if (p2) { p2.inflight = null; sweepRemember(p2); }
							return j;
						});
				},
				stopped: () => stop || stopped,
				onStep: (st) => {
					t.textContent = 'Holding pin ' + st.pin + ' ' + st.level;
					s.textContent = (st.index + 1) + ' of ' + st.total;
					pins.sweep(st.pin, null);
				},
			}, todo).then((res) => {
				pins.sweep(null, null);
				// Recorded from the run's own list rather than one step behind
				// it. Writing "the previous one is done" at the START of each
				// step never records the LAST one, so stopping a hunt and
				// carrying on re-drove the pin it had just finished -- which on
				// a pin that cuts the network is not a wasted second, it is the
				// failure again.
				const pr = sweepProgress() || { sig: sig, done: [] };
				pr.range = range;
				pr.inflight = null;
				(res.tried || []).forEach((k) => {
					if (pr.done.indexOf(k) < 0) pr.done.push(k);
				});
				sweepRemember(pr);
				sweepFound(info, res, todo.length);
			}).catch((e) => {
				pins.sweep(null, null);
				host.innerHTML = '<div class="mj-live-grp-head">' +
					'<span class="mj-cap">Find a pin</span>' +
					'<span class="mj-live-rule"></span></div>' +
					'<div class="alert alert-danger py-2 px-3 mb-0 small">' +
					'The hunt could not finish: ' +
					esc(e && e.message ? e.message : String(e)) + '</div>';
			});
		});
	}

	// What the hunt turned up, and the one thing to do about it.
	function sweepFound(info, res, tried) {
		const SW = SWEEP();
		const host = hostOf();
		const head = '<div class="mj-live-grp-head"><span class="mj-cap">' +
			'Find a pin</span><span class="mj-live-rule"></span></div>';

		if (res.lost) {
			lostCard(info, res.lost.pin, res.lost.level);
			return;
		}

		if (!res.hit) {
			// A finished hunt has nothing to carry on from.
			if (!res.stopped) sweepRemember(null);
			host.innerHTML = head +
				'<div class="alert alert-secondary py-2 px-3 mb-2 small">' +
				(res.stopped
					? '<b>Stopped.</b> ' + res.tried.length + ' of ' + tried +
						' done; carrying on picks up where this left off.'
					: '<b>Nothing came or went.</b> Every pin the camera would ' +
						'touch was held high and then low, and nothing plugged into ' +
						'the camera changed. Either what you are looking for is on ' +
						'one of the pins being left alone, or it does not announce ' +
						'itself to the camera at all \u2014 a plain lamp or a relay ' +
						'with nothing behind it never will.') +
				(res.refused.length
					? '<br><br>' + res.refused.length + ' were refused: ' +
						esc(res.refused.slice(0, 3).map((r) => r.why).join('; ')) +
						(res.refused.length > 3 ? '\u2026' : '')
					: '') +
				'</div>' +
				'<button type="button" class="btn btn-outline-secondary btn-sm" ' +
				'id="mj-sweep-again">Back</button>';
			host.querySelector('#mj-sweep-again')
				.addEventListener('click', () => idleCard(state.info || info));
			return;
		}

		// Found. The sweep stops at the first difference on purpose: whatever
		// just came online is still online when the next pin is held, so every
		// later pin would report it again, or report it leaving.
		const hit = res.hit;
		sweepRemember(null);
		host.innerHTML = head +
			'<div class="alert alert-success py-2 px-3 mb-2 small">' +
			'<b>' + esc(SW.sentence(hit)) + '</b>' +
			(hit.partial
				? ' <br><br>The camera had more plugged into it than it can list, ' +
					'so check this one is really new before trusting it.'
				: '') +
			'<br><br>To have the camera do this at every start, pick pin ' +
			esc(String(hit.pin)) + ' in the drawing above, set it to <b>' +
			esc(hit.level === 'high' ? 'hold high' : 'hold low') + '</b> and keep it. ' +
			'It will be set that way before anything else runs, and it survives a ' +
			'power cut.</div>' +
			'<div class="d-flex gap-2 align-items-center">' +
			'<button type="button" class="btn btn-primary btn-sm" id="mj-sweep-pick">' +
			'Show me pin ' + esc(String(hit.pin)) + '</button>' +
			'<button type="button" class="btn btn-outline-secondary btn-sm" ' +
			'id="mj-sweep-done">Done</button></div>';
		host.querySelector('#mj-sweep-done')
			.addEventListener('click', () => idleCard(state.info || info));
		host.querySelector('#mj-sweep-pick').addEventListener('click', () => {
			if (pins.select) pins.select(hit.pin);
		});
	}

	// A sweep drives pads, and the camera refuses to drive any pair while it
	// cannot say what the pads already are -- no debugfs to name a line's
	// owner, or no boot loader environment to see the PTZ pads. Offering the
	// button anyway would spend a press to be told no, once per pad, so the
	// reason is said instead. Assigning a pin by hand still works: that writes
	// a number into a field and moves nothing.
	function cannotHunt(info) {
		const cant = [];
		if (info.ownersUnknown) cant.push('which pads the kernel already holds');
		if (info.ptzUnknown) cant.push('which pads the PTZ driver is on');
		if (!cant.length) return null;
		return 'This camera cannot say ' + cant.join(' or ') +
			', so it will not drive pads it has not been told about. Set the ' +
			'coils by hand on the Day / Night page instead.';
	}

	// ── mounting ────────────────────────────────────────────────────────────

	// `pins` is the Pins page's own handle, injected the way `io` is injected
	// into run(): this file never reaches into that page's DOM, and the two can
	// be changed apart. It owes us sweep(a, b) to light what is being driven,
	// select(pin) to open one pin's own controls, and changed() for when the
	// camera's answer has moved under it.
	const state = { info: null, range: null, soc: '', host: null, pins: null };
	let pins = null;
	const hostOf = () => state.host;

	/* Every running sweep asks this before its next pad.
	 *
	 * A hunt is hundreds of requests that each drive hardware, and its Stop
	 * button lives in a box the page throws away whenever it repaints. Without
	 * a way in from outside, leaving the section detached the only control and
	 * left the sweep working through the chip with nobody watching it. */
	let stopped = false;

	function mount(host, opts) {
		opts = opts || {};
		stopped = false;
		state.host = host;
		state.soc = opts.soc || '';
		state.info = opts.info || null;
		pins = opts.pins || {};
		if (!SCAN() || !state.info) return;

		// The way in. Always drawn, because this is now the only place the
		// hunt can be started from -- on the page it came from there was a
		// button beside the pad map, and moving the panel without moving the
		// door left a section that could only ever resume something.
		idleCard(state.info);
		// And on top of it where a previous run did not finish, because
		// "carry on from pair 84" is a different offer from "start".
		resumeCard(state.info);

		/* The page owns this section's lifetime, so it owns stopping what is
		 * running in it. */
		return { stop: () => { stopped = true; } };
	}

	const api = { mount: mount };
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticPinHunt = api;
})();
