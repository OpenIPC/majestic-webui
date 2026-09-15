// Hunting for a pin by driving it and watching for something to change.
//
// This lived on the Day / Night page, because what it was built to find is the
// IR-cut filter and it reads its answer off the picture. But what it DOES is
// drive arbitrary pads across the whole chip, and everything that makes it
// safe to do that -- the list of pads that must not be driven, the range, the
// record that survives the reboot a pad caused, the chip saying which pads are
// already carrying something -- is about GPIO in general and has nothing to do
// with day or night. Somebody hunting a WiFi enable reached for it too.
//
// So it lives with the pins now, and the filter is the thing it watches for
// rather than its identity. Day / Night keeps what is genuinely its own: which
// pad each coil is on, and testing the filter once they are set.
//
// The pure half -- which pairs to try, in what order, and what to make of an
// interrupted run -- stays in ircut-scan.js and is tested without a browser.
// This file is the part you can see.
(function () {
	'use strict';

	const SCAN = () => window.MajesticIrcutScan;

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
		host.className = 'mj-ircut-scan';
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
			'<div class="mj-live-grp-head"><span class="mj-cap">Find the pins</span>' +
			'<span class="mj-live-rule"></span></div>' +
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
					// it. The camera keeps its list; only this browser's
					// progress goes.
					scanRemember(null);
					go();
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
	const SCAN_KEY = 'mj-ircut-scan';

	function scanProgress() {
		try {
			const v = JSON.parse(localStorage.getItem(SCAN_KEY) || 'null');
			if (!v || typeof v.sig !== 'string' || !Array.isArray(v.done)) return null;
			return v;
		} catch (e) {
			return null;
		}
	}

	function scanRemember(v) {
		try {
			if (v === null) localStorage.removeItem(SCAN_KEY);
			else localStorage.setItem(SCAN_KEY, JSON.stringify(v));
		} catch (e) {
			/* Not remembered is a worse scan, not a broken one. */
		}
	}

	// Ask the camera to leave a pad alone, or take that back. The list is the
	// camera's because it has to outlive this page and the reboot that made it.
	function scanAvoid(pin, on) {
		return FETCH('/api/v1/gpio?' + (on ? 'avoid=' : 'unavoid=') + pin,
			{ method: 'POST', credentials: 'same-origin' })
			.then((r) => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)));
	}

	// What the scan is going to leave alone, in one line and a list.
	//
	// Counted from the same facts the sweep is built from rather than
	// described in the abstract, so the number cannot drift away from what
	// actually happens.
	function skipped(info, range, full) {
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

		let words = '<b>' + full.length + ' pairs</b> across ' + pads + ' pads. ';
		words += bits.length
			? '<b>' + (nOwned + nAsked + nDown) + ' pads are being left alone</b> &mdash; ' +
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
		const range = state.range || null;
		const list = S.pairs(info, { part: part, only: range });
		const full = range ? S.pairs(info, { part: part }) : list;
		let stop = false;

		// Where this browser got to, if it was here before and the chip has
		// not changed under it.
		const sig = S.stamp(info);
		let prog = scanProgress();
		if (prog && prog.sig !== sig) {
			prog = null;
			scanRemember(null);
		}
		const todo = prog ? S.remaining(list, prog.done) : list;

		host.hidden = false;
		host.className = 'mj-ircut-scan';
		// Dressed as a group of this section, not as an announcement inside it:
		// micro-caps head, hairline to the margin, note on the right, small body
		// — the same head the deck gives Wiring and Connected to. A lead
		// paragraph at full body size was the only 1rem text on the page.
		host.innerHTML =
			'<div class="mj-live-grp-head"><span class="mj-cap">Find the pins</span>' +
			'<span class="mj-live-rule"></span>' +
			'<span class="mj-live-note" id="mj-scan-n"></span></div>' +
			'<p class="small mb-2">Each pad is driven against another while the ' +
			'picture is watched for the filter to move. An IR-cut filter is driven ' +
			'across two pads, so pairs are what get tried; the pairs other boards ' +
			'use go first, so this usually ends in seconds.</p>' +
			'<div class="alert alert-warning py-2 px-3 mb-2 small">' +
			'<b>This drives pads whose job is unknown.</b> One of them may reset the ' +
			'network, cut power to the sensor, or stop the camera answering. That risk ' +
			'cannot be removed &mdash; only made survivable: each pad is written to flash ' +
			'before it is driven, so a camera that has to be restarted comes back knowing ' +
			'which pad did it.</div>' +
			'<p class="x-small text-secondary mb-2">Pads already spoken for are skipped. ' +
			// Said only where it is true. The table is per board, so this is an
			// order and not a promise — the pads are still driven if nothing
			// before them moved the filter, which is why the warning above
			// keeps its wording either way.
			(part.known
				? 'Pads that other boards with this SoC use for a reset, a USB enable ' +
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
		const left = skipped(info, range, full);
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
				release: (a, b) => FETCH('/api/v1/gpio?park=' + a + ',' + b + '&mode=float',
					{ method: 'POST', credentials: 'same-origin' })
					.then((r) => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))),
				look: () => window.MajesticIrcut.snapshot('/image.jpg'),
				wait: (ms) => new Promise((r) => setTimeout(r, ms)),
				stopped: () => stop,
				onStep: (st) => {
					t.textContent = 'Trying pins ' + st.a + ' and ' + st.b;
					s.textContent = (st.index + 1) + ' of ' + st.total;
					// Both pads, not just the first. A pair is what gets
					// driven, and lighting one of the two made the drawing
					// disagree with the sentence above it.
					pins.sweep(st.a, st.b);
					// Everything before this one is done. Recorded per step
					// rather than at the end, because the end is exactly what
					// an interrupted scan does not reach.
					if (st.index > 0) {
						const pr = scanProgress() || { sig: sig, done: [] };
						const k = S.key(todo[st.index - 1][0], todo[st.index - 1][1]);
						if (pr.done.indexOf(k) < 0) pr.done.push(k);
						scanRemember(pr);
					}
				},
			}, todo).then((res) => {
				pins.sweep(null, null);
				// A sweep that ran to the end has nothing to carry on from.
				if (res.done) scanRemember(null);
				const found = res.pins;
				if (!found) {
					host.innerHTML = '<div class="mj-live-grp-head">' +
						'<span class="mj-cap">Find the pins</span>' +
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
					'<span class="mj-cap">Find the pins</span>' +
					'<span class="mj-live-rule"></span></div>' +
					'<div class="alert ' + (found.settled ? 'alert-success' : 'alert-warning') +
					' py-2 px-3 mb-2 small"><b>' +
					(found.settled ? 'Found it.' : 'Found the pins, but not cleanly.') + '</b> ' +
					'Pins ' + esc(String(found.irCutPin1)) + ' and ' + esc(String(found.irCutPin2)) +
					' drive the filter &mdash; ' + esc(String(found.closesWhenHigh)) +
					' is the one that closes it. ' + tail +
					'</div><button type="button" class="btn btn-primary btn-sm" id="mj-scan-use">' +
					'Save these as the IR-cut filter</button>' +
					'<p class="x-small text-secondary mb-0 mt-2" id="mj-scan-used"></p>';
				const said = host.querySelector('#mj-scan-used');
				host.querySelector('#mj-scan-use').addEventListener('click', () => {
					// Written, and said out loud. On the page this came from the
					// find was staged into a form and the person pressed Save;
					// there is no such form here, and a button that quietly did
					// nothing until you found the right page would be worse than
					// one that writes and tells you.
					//
					// Which pad OPENS and which CLOSES is the measurement, not a
					// convention -- swapping them leaves a filter that moves the
					// wrong way at dusk, which looks like a broken camera.
					const q = 'nightMode.irCutPin1=' + found.irCutPin1 +
						'&nightMode.irCutPin2=' + found.irCutPin2;
					said.textContent = 'Saving\u2026';
					FETCH('/api/v1/set?' + q, { credentials: 'same-origin' })
						.then((r) => {
							if (!r.ok) throw new Error('HTTP ' + r.status);
							said.innerHTML = 'Saved. Test the filter on the ' +
								'<a href="#nightMode">Day / Night</a> page, which is ' +
								'where day and night are set up.';
						})
						.catch((e) => {
							said.textContent = 'The camera would not store that: ' +
								e.message + '. The pins are ' + found.irCutPin1 +
								' and ' + found.irCutPin2 + ' if you want to set ' +
								'them by hand.';
						});
				});
			}).catch((e) => {
				pins.sweep(null, null);
				host.innerHTML = '<div class="mj-live-grp-head">' +
					'<span class="mj-cap">Find the pins</span>' +
					'<span class="mj-live-rule"></span></div>' +
					'<div class="alert alert-danger py-2 px-3 mb-0 small">' +
					'The scan could not finish: ' + esc(e && e.message ? e.message : String(e)) +
					'</div>';
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
		host.className = 'mj-ircut-scan mj-pins-hunt';

		const why = cannotHunt(info);
		host.innerHTML =
			'<div class="mj-live-grp-head"><span class="mj-cap">Find a pin</span>' +
			'<span class="mj-live-rule"></span></div>' +
			'<p class="small mb-2">Do not know which pad something is on? The ' +
			'camera can drive pads in pairs and watch the picture for the ' +
			'IR-cut filter to move. It is the way to find a filter nobody has ' +
			'written down &mdash; and it drives pads whose job it does not ' +
			'know, so it asks before it starts.</p>' +
			(why
				? '<p class="x-small text-secondary mb-0">' + esc(why) + '</p>'
				: '<button type="button" class="btn btn-primary btn-sm" ' +
					'id="mj-hunt-go">Find the IR-cut filter</button>');
		const go = host.querySelector('#mj-hunt-go');
		if (go) go.addEventListener('click', () => openScan(state.info || info));
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
	// be changed apart. It owes us sweep(a, b), assign()/setAssign() for the
	// pins a find should be written to, and refresh().
	const state = { info: null, range: null, soc: '', host: null, pins: null };
	let pins = null;
	const hostOf = () => state.host;

	function mount(host, opts) {
		opts = opts || {};
		state.host = host;
		state.soc = opts.soc || '';
		state.info = opts.info || null;
		pins = opts.pins || {};
		if (!SCAN() || !state.info) return null;

		// The way in. Always drawn, because this is now the only place the
		// hunt can be started from -- on the page it came from there was a
		// button beside the pad map, and moving the panel without moving the
		// door left a section that could only ever resume something.
		idleCard(state.info);
		// And on top of it where a previous run did not finish, because
		// "carry on from pair 84" is a different offer from "start".
		resumeCard(state.info);
		return {
			open: () => openScan(state.info),
			reinfo: (fresh) => { state.info = fresh; },
			avoid: (pin, on) => scanAvoid(pin, on),
			info: () => state.info,
		};
	}

	const api = { mount: mount };
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticPinHunt = api;
})();
