/* Focus by ear: the Live page's half of it.
 *
 * An installer on a ladder turning a varifocal lens cannot read a phone. The
 * camera measures sharpness every frame, so this polls that one number five
 * times a second and plays it: beeps that come faster and higher the closer
 * the picture is to the best it has been, a low note when the lens has gone
 * past it, one held tone when it is back on it. The grammar itself is in
 * focus-ear.js and is tested there; this file is the poll, the sound and the
 * card, and nothing that could be tested without a browser.
 *
 * What it refuses, and why:
 *
 * - It never writes a setting and never calls /ptz. The pad owns the lens; this
 *   only listens to what the lens does.
 * - It never plays a sound that does not come from a reading younger than the
 *   reducer's STALE_MS. Silence is the honest answer to a camera that stopped
 *   answering, and the reducer's own watchdog is what enforces it: the poll
 *   feeds readings, the scheduler ticks, and a tone with no reading behind it
 *   cannot be planned.
 * - The AudioContext is created inside the toggle's own event, before any
 *   await. That gesture is what lets a phone make a sound at all; created a
 *   moment later it is created muted.
 * - The toggle stays hidden until the heartbeat has shown this camera reports
 *   the metric, and unless the browser can make a sound: a "By ear" control
 *   that could never work is the control this tree refuses to draw.
 * - Part of the picture is the camera's own grid, never a crop of the number.
 *   The card's Area button borrows the zoom module's rubber band for one drag,
 *   and what is listened to from then on is the mean over the focus grid's
 *   cells under that rectangle (focus-area.js), reached through the camera's
 *   per-stream windows. The button appears only once this camera has answered
 *   with a usable grid, and a click instead of a drag is the whole frame.
 * - Nothing here is in either test's SRCS list and preview-page.js does not
 *   know it exists, like preview-still.js; a build missing this file leaves
 *   the page as it was.
 */
(function () {
	'use strict';

	const $ = (s) => document.querySelector(s);
	const ctl = $('#mj-ear-ctl'), tog = $('#mj-ear'), card = $('#mj-ear-card');
	const nowEl = $('#mj-ear-now'), bestEl = $('#mj-ear-best');
	const wordEl = $('#mj-ear-word'), resetBtn = $('#mj-ear-reset');
	const note = $('#mj-ear-note');
	/* The rectangle's parts are optional: without any of them the mode works
	 * on the whole frame and the Area button is never shown. */
	const areaBtn = $('#mj-ear-area'), stage = $('#mj-stage');
	const Ear = window.MajesticFocusEar;
	const FA = window.MajesticFocusArea, RGN = window.MajesticRegion;
	const AC = window.AudioContext || window.webkitAudioContext;
	if (!ctl || !tog || !card || !nowEl || !bestEl || !wordEl || !resetBtn ||
		!note || !Ear || typeof AC !== 'function') return;
	const K = Ear.K;

	/* One number, answered out of the daemon's memory in about ten
	 * milliseconds, no auth, five bytes. The whole /metrics document is ten to
	 * thirty kilobytes and the page already polls it every two seconds; this
	 * is not a second copy of that poll, it is a different question asked at
	 * the pace a hand on a lens needs. Through apiFetch, like every camera
	 * request here, so a lapsed session redirects rather than looking like a
	 * camera that has no statistic. */
	const URL = '/metrics/isp?value=isp_afmetrics';
	const FETCH_TIMEOUT_MS = 1500;
	/* How far ahead beeps are scheduled on the audio clock, and how often the
	 * scheduler runs. The look-ahead must cover a scheduler period with room
	 * to spare, and the reducer's rate change reaches the ear within it. */
	const SCHED_MS = 50;
	const LOOKAHEAD_S = 0.15;
	const MASTER_GAIN = 0.3;
	const BEEP_GAIN = 0.7;

	/* The phase, as a word the card can carry. Short, because the card is read
	 * at arm's length if it is read at all. */
	const WORDS = {
		listening: 'listening…', sharper: 'sharper', softer: 'softer',
		steady: 'steady', peak: 'on the best', stale: 'no reading', absent: '',
	};

	function api(url, init) {
		return typeof apiFetch === 'function' ? apiFetch(url, init) : fetch(url, init);
	}

	/* Availability: the heartbeat has seen the metric on this camera. The
	 * subscription replays its last publication, so this settles within a
	 * heartbeat of the page loading; a later absence is the poll's business,
	 * not a reason to take the control away mid-session. */
	if (typeof mjMetricsSubscribe === 'function') {
		/* The subscription replays synchronously when a publication already
		 * exists, so the callback can run before the unsubscribe function has
		 * been handed back: `off` is assigned after, and called from the
		 * replay it would not exist yet. */
		let off = null, seen = false;
		off = mjMetricsSubscribe((s) => {
			const v = s && s.ok && s.m && s.m.v ? s.m.v.isp_afmetrics : undefined;
			if (Number.isFinite(v) && v >= 0) {
				ctl.hidden = false;
				seen = true;
				if (off) off();
			}
		});
		if (seen) off();
	}

	let ctx = null;
	let ear = null, running = false, paused = false;
	let seq = 0, inflight = null, pollTimer = null, schedTimer = null, fails = 0;
	let cursor = null, last = null, lock = null;
	let noteTimer = null;

	function say(text, ms) {
		if (noteTimer) { clearTimeout(noteTimer); noteTimer = null; }
		note.textContent = text || '';
		note.hidden = !text;
		if (text && ms) noteTimer = setTimeout(() => { note.hidden = true; }, ms);
	}

	function paint(out) {
		if (!out) return;
		const n = out.now === null ? '–' : String(Math.round(out.now));
		const b = out.best === null ? '–' : String(Math.round(out.best));
		if (nowEl.textContent !== n) nowEl.textContent = n;
		if (bestEl.textContent !== b) bestEl.textContent = b;
		const w = WORDS[out.phase] || '';
		if (wordEl.textContent !== w) wordEl.textContent = w;
	}

	/* ---- the sound ---------------------------------------------------- */

	/* The graph and everything that plays into it, bound to one context. A
	 * factory rather than closure state so the same code can be driven into an
	 * OfflineAudioContext by a check that has no ears: the rendered buffer is
	 * what proves a beep train beeps and a held tone holds. */
	function Sound(actx) {
		const osc = actx.createOscillator();
		osc.type = 'triangle';
		osc.frequency.value = K.PITCH_LO;
		const env = actx.createGain();
		env.gain.value = 0;
		const master = actx.createGain();
		master.gain.value = MASTER_GAIN;
		osc.connect(env);
		env.connect(master);
		master.connect(actx.destination);
		osc.start();
		let holding = false;
		let holdF = 0;

		/* A short tone of its own, so a cue can sound over the train rather
		 * than interrupt it. Five milliseconds in and fifteen out: at these
		 * pitches that is several cycles, and a click is a step the ramp does
		 * not allow. */
		function tone(f0, f1, ms, type, at, gain) {
			const o = actx.createOscillator();
			const g = actx.createGain();
			o.type = type;
			o.frequency.setValueAtTime(f0, at);
			if (f1) o.frequency.exponentialRampToValueAtTime(f1, at + ms / 1000);
			g.gain.setValueAtTime(0, at);
			g.gain.linearRampToValueAtTime(gain, at + 0.005);
			g.gain.setValueAtTime(gain, at + ms / 1000 - 0.015);
			g.gain.linearRampToValueAtTime(0, at + ms / 1000);
			o.connect(g);
			g.connect(master);
			o.start(at);
			o.stop(at + ms / 1000 + 0.01);
		}

		function cue(kind, at) {
			const t = at !== undefined ? at : actx.currentTime + 0.01;
			if (kind === 'best') {
				tone(1320, null, 80, 'triangle', t, 0.6);
				tone(1760, null, 80, 'triangle', t + 0.09, 0.6);
			} else if (kind === 'past') {
				/* Below the beep range and above what a small speaker can carry;
				 * square, so it is unmistakably not one of the beeps. */
				tone(520, null, 250, 'square', t, 0.35);
			} else if (kind === 'lost') {
				tone(660, 440, 220, 'triangle', t, 0.5);
			}
		}

		function letGo(now) {
			env.gain.cancelScheduledValues(now);
			env.gain.setValueAtTime(BEEP_GAIN, now);
			env.gain.linearRampToValueAtTime(0, now + 0.02);
			holding = false;
		}

		/* The planner's events onto the audio clock. Beeps are scheduled in
		 * the future and never re-scheduled: the cursor the planner carries is
		 * what keeps a rate change from beeping twice. A held tone glides its
		 * pitch rather than stepping it. `now` is the clock to measure from,
		 * the context's own unless a check supplies one. */
		function render(events, now, silent) {
			const t0 = now !== undefined ? now : actx.currentTime;
			if (silent) {
				/* Take back what was scheduled ahead, beeps included: a beep
				 * planned 150 ms out must not sound after the reading it
				 * came from was declared stale. */
				env.gain.cancelScheduledValues(t0);
				env.gain.setValueAtTime(holding ? BEEP_GAIN : 0, t0);
				env.gain.linearRampToValueAtTime(0, t0 + 0.02);
				holding = false;
				return;
			}
			let any = false;
			for (const e of events) {
				any = true;
				if (e.kind === 'hold') {
					/* Once. The planner says "hold" on every tick while the tone
					 * holds, and re-issuing the ramp each time restarted it --
					 * a chopped tone with a click at every restart. Only the
					 * pitch follows, and only when it has moved. */
					if (!holding) {
						env.gain.cancelScheduledValues(t0);
						env.gain.setValueAtTime(0, t0);
						env.gain.linearRampToValueAtTime(BEEP_GAIN, t0 + 0.03);
						osc.frequency.cancelScheduledValues(t0);
						osc.frequency.setValueAtTime(e.f, t0);
						holding = true;
						holdF = e.f;
					} else if (Math.abs(e.f - holdF) > holdF * 0.01) {
						osc.frequency.cancelScheduledValues(t0);
						osc.frequency.setValueAtTime(holdF, t0);
						osc.frequency.exponentialRampToValueAtTime(e.f, t0 + 0.05);
						holdF = e.f;
					}
					continue;
				}
				if (holding) letGo(t0);
				/* Never in the past, but as close to the planned time as the
				 * clock allows: a wider floor pushed every beep that fell just
				 * after a scheduling tick late by that much, audibly uneven. */
				const at = Math.max(e.at, t0 + 0.005);
				const end = at + e.ms / 1000;
				osc.frequency.setValueAtTime(e.f, at);
				env.gain.setValueAtTime(0, at);
				env.gain.linearRampToValueAtTime(BEEP_GAIN, at + 0.005);
				env.gain.setValueAtTime(BEEP_GAIN, end - 0.015);
				env.gain.linearRampToValueAtTime(0, end);
			}
			if (!any && holding) letGo(t0);
		}

		/* Silence, ramped, which is what keeps a stop from clicking. */
		function quiet() {
			const now = actx.currentTime;
			master.gain.cancelScheduledValues(now);
			master.gain.setValueAtTime(master.gain.value, now);
			master.gain.linearRampToValueAtTime(0, now + 0.03);
			holding = false;
		}
		function loud() {
			const now = actx.currentTime;
			master.gain.cancelScheduledValues(now);
			master.gain.setValueAtTime(master.gain.value, now);
			master.gain.linearRampToValueAtTime(MASTER_GAIN, now + 0.03);
		}

		return { render: render, cue: cue, quiet: quiet, loud: loud,
			isHolding: () => holding, master: master };
	}

	let snd = null;

	function sched() {
		if (!running || paused || !ctx || !ear || !snd) return;
		const out = ear.tick(performance.now());
		if (out.cue) snd.cue(out.cue);
		paint(out);
		last = out;
		const p = Ear.plan(out, ctx.currentTime, ctx.currentTime + LOOKAHEAD_S, cursor);
		cursor = p.cursor;
		snd.render(p.events, undefined, p.silent);
	}

	/* ---- the rectangle ------------------------------------------------ */

	/* Listening to part of the picture. The card's Area button borrows the
	 * zoom module's rubber band for one drag; the rectangle comes back in the
	 * shown stream's pixels, travels through the camera's own per-stream
	 * windows into the ISP frame the focus grid divides, and is snapped to the
	 * cells whose centres it holds. From then on the poll reads the grid and
	 * averages those cells (focus-area.js), and an outline on the stage shows
	 * the cells rather than the drag. A click instead of a drag is the whole
	 * frame, and so is pressing the button again. The button appears only once
	 * this session's probe has had a usable grid, and a session that ends drops
	 * the rectangle, so every session starts on the whole frame. */
	const ZONES_URL = '/api/v1/isp/af-zones.json';
	const OSD_URL = '/api/v1/osd';
	/* The ISP frame, standing in as a stream of its own for mj-region.js. */
	const GRID_STREAM = -1;
	const SVG = 'http://www.w3.org/2000/svg';
	const ZOOM = window.MajesticZoom;
	const canArea = !!(areaBtn && stage && FA && RGN && ZOOM &&
		typeof ZOOM.pickRect === 'function' && typeof ZOOM.view === 'function' &&
		typeof ZOOM.onView === 'function');

	let region = null;      /* { cells, unit }: the cells, and their outline in unit fractions */
	let grid = null;        /* { rows, cols }, once this session's probe has seen the grid */
	let geom = null;        /* { at, map, group, declared }, for the stream on screen */
	let learning = null, geomTried = 0;
	let picking = null;     /* withdraws the pick in progress */
	let outline = null, outlineRect = null, placedAt = '';
	let hintAt = 0, gen = 0;

	/* Which stream is on screen, or null when nobody will say. Null, never 0:
	 * a map built for the wrong stream lays the rectangle over the wrong cells
	 * and nothing reports it. */
	function shownStream() {
		if (typeof window.MajesticLiveStream !== 'function') return null;
		const n = window.MajesticLiveStream();
		return Number.isFinite(n) ? n | 0 : null;
	}

	/* The map from the ISP frame to the stream on screen, from the camera's
	 * own per-stream windows. Tagged with the stream it was learnt for: the
	 * served channel can change without the event the user-selection path
	 * sends, and a map for the channel just left converts confidently to the
	 * wrong place. */
	function learnGeometry() {
		const at = shownStream();
		if (at === null) { geom = null; return Promise.resolve(); }
		return api(OSD_URL, { credentials: 'same-origin' })
			.then((r) => (r.ok ? r.json() : null))
			.then((j) => {
				geom = null;
				if (!j || !Array.isArray(j.streams) || !Array.isArray(j.group)) return;
				const gw = j.group[0], gh = j.group[1];
				let declared = null;
				for (let i = 0; i < j.streams.length; i++) {
					const st = j.streams[i];
					if (st && st.stream === at && Array.isArray(st.frame) &&
						st.frame[0] > 0 && st.frame[1] > 0)
						declared = { w: st.frame[0], h: st.frame[1] };
				}
				if (!declared) return;
				const all = j.streams.concat([{ stream: GRID_STREAM, frame: [gw, gh], view: [0, 0, gw, gh] }]);
				const map = RGN.view(j.group, all, GRID_STREAM, at);
				if (!map || !map.k || !map.k.x || !map.k.y) return;
				geom = { at: at, map: map, group: { w: gw, h: gh }, declared: declared };
			})
			.catch(() => { geom = null; });
	}
	function geometryFresh() {
		if (!canArea) return Promise.resolve(false);
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

	/* A note that may be true on every poll, said once in a while. */
	function hint(text) {
		const t = performance.now();
		if (t - hintAt < 4000) return;
		hintAt = t;
		say(text, 3000);
	}

	function setPressed(on) {
		if (!areaBtn) return;
		areaBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
		areaBtn.classList.toggle('mj-hud-on', on);
	}

	/* This session's grid, asked for once at the start. The Area button
	 * appears only on a usable answer: a camera that serves no grid, or one
	 * whose shape does not hold, keeps the whole-frame number and no button. */
	function probeGrid() {
		if (!canArea) return;
		const my = gen;
		api(ZONES_URL, { credentials: 'same-origin', cache: 'no-store' })
			.then((r) => (r.ok ? r.json() : null))
			.then((g) => {
				if (!running || my !== gen) return;
				if (g && FA.usable(g)) {
					grid = { rows: g.rows, cols: g.cols };
					areaBtn.hidden = false;
				}
			})
			.catch(() => { /* no grid this session; the button stays hidden */ });
	}

	function setRegion(r) {
		const changed = !!region || !!r;
		region = r;
		setPressed(!!r);
		if (changed && ear) {
			/* The best from one source means nothing to the other. */
			ear.reset(performance.now());
			paint({ now: null, best: null, phase: 'listening' });
			fails = 0;
		}
		place();
		if (changed) say(r ? 'Listening to the outlined area.' : 'Listening to the whole frame.', 3000);
	}

	function cancelPick() {
		if (picking) { const c = picking; picking = null; c(); }
		setPressed(!!region);
	}

	/* The rubber band's answer: a rectangle, or null for a click. */
	function picked(rect) {
		picking = null;
		if (!rect) {
			const had = !!region;
			setRegion(null);
			if (!had) say('Listening to the whole frame.', 3000);
			return;
		}
		geometryFresh().then(() => {
			if (!running || !grid) { setPressed(!!region); return; }
			const g = geom && geom.at === shownStream() ? geom : null;
			const unit = g ? FA.fromShown(rect, { map: g.map, group: g.group, declared: g.declared, decoded: rect.frame }) : null;
			const cells = unit ? FA.cells(unit, grid.rows, grid.cols) : null;
			const bounds = cells ? FA.bounds(cells, grid.rows, grid.cols) : null;
			if (!bounds) {
				setPressed(!!region);
				say('Could not place that on the picture. Try again.', 5000);
				return;
			}
			setRegion({ cells: cells, unit: bounds });
		});
	}

	function buildOutline() {
		if (outline || typeof document.createElementNS !== 'function') return;
		outline = document.createElementNS(SVG, 'svg');
		outline.setAttribute('class', 'mj-focus-outline');
		outline.setAttribute('id', 'mj-focus-outline');
		outline.setAttribute('aria-hidden', 'true');
		outlineRect = document.createElementNS(SVG, 'rect');
		outline.appendChild(outlineRect);
		outline.style.display = 'none';
		stage.appendChild(outline);
	}

	/* The cells, on the stage: unit fractions through the map to the shown
	 * stream's pixels, then through the zoom module's placement. Re-run on
	 * every view change, so the outline pans and zooms with the picture. */
	function place() {
		if (!canArea) return;
		if (!outline) buildOutline();
		if (!outline) return;
		let box = null;
		if (region && running) {
			const g = geom && geom.at === shownStream() ? geom : null;
			if (!g) {
				/* One placement when the map lands, not one per tick spent
				 * waiting for it -- and none chained when nothing was asked. */
				const first = !learning;
				const p = geometryFresh();
				if (first && learning) p.then(place);
			}
			const v = ZOOM.view();
			const s = v && g ? FA.toShown(region.unit, { map: g.map, group: g.group, declared: g.declared, decoded: v.frame }) : null;
			if (s) {
				box = [v.pic.x + (s.x - v.visible.x) * v.scale, v.pic.y + (s.y - v.visible.y) * v.scale,
					s.w * v.scale, s.h * v.scale].map((n) => n.toFixed(1));
			}
		}
		if (!box) { outline.style.display = 'none'; placedAt = ''; return; }
		const key = box.join(' ');
		if (key !== placedAt) {
			outlineRect.setAttribute('x', box[0]);
			outlineRect.setAttribute('y', box[1]);
			outlineRect.setAttribute('width', box[2]);
			outlineRect.setAttribute('height', box[3]);
			placedAt = key;
		}
		outline.style.display = '';
	}

	/* ---- the poll ----------------------------------------------------- */

	/* One reading from whichever source is in force: the whole-frame number,
	 * or the mean over the rectangle's cells of the grid that number is made
	 * of. Both answer {v} in the reducer's three values -- a number, null for
	 * "nothing there", undefined for "could not read this one" -- and the grid
	 * says so with `area`, because null means different things from the two:
	 * from the whole frame it is a chip with no statistic; from a rectangle it
	 * is a rectangle with nothing measurable in it. */
	function read(init) {
		if (!region || !grid) {
			return api(URL, init)
				.then((r) => (r.ok ? r.text() : Promise.reject(r.status)))
				.then((text) => ({ v: Ear.readValue(text) }));
		}
		return api(ZONES_URL, init)
			.then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
			.then((g) => {
				if (!FA.usable(g)) return { v: undefined, area: true };
				if (g.rows !== grid.rows || g.cols !== grid.cols) {
					/* Not the grid the rectangle was laid on. The cells mean
					 * nothing on this one, so the whole frame it is. */
					setRegion(null);
					return { v: undefined, area: true };
				}
				const m = FA.measure(g, region.cells);
				return { v: m ? m.value : undefined, area: true };
			});
	}

	function poll() {
		if (!running || paused) return;
		const my = ++seq;
		const ac = typeof AbortController === 'function' ? new AbortController() : null;
		inflight = ac;
		const deadline = ac ? setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS) : null;
		read(Object.assign({ credentials: 'same-origin', cache: 'no-store' },
			ac ? { signal: ac.signal } : {}))
			.then((got) => {
				if (my !== seq || !running) return;
				const v = got.v;
				if (v === undefined) {
					/* Something that is not a number -- an error page, a
					 * proxy's apology, a grid that lost its shape. Says
					 * nothing about the chip; it is this poll that failed,
					 * and the next may not. */
					fails++;
					return;
				}
				if (v === null) {
					if (!got.area) {
						/* An empty body from a camera that answered: the chip
						 * has no statistic. Not a failure to retry, a fact. */
						absent();
						return;
					}
					/* Every cell in the rectangle clipped or dark: nothing
					 * there to measure. Not a reading, so the reducer hears
					 * silence and says "no reading"; the note says why. */
					fails = 0;
					hint('Nothing to measure in that area: too bright or too dark.');
					return;
				}
				fails = 0;
				const out = ear.step(v, performance.now());
				if (out.cue && snd) snd.cue(out.cue);
				paint(out);
				last = out;
			})
			.catch(() => {
				if (my !== seq) return;
				fails++;
			})
			.finally(() => {
				if (deadline !== null) clearTimeout(deadline);
				if (my === seq) inflight = null;
				if (running && !paused && my === seq) {
					const wait = fails ? Math.min(2000, K.POLL_MS << Math.min(fails, 4)) : K.POLL_MS;
					pollTimer = setTimeout(poll, wait);
				}
			});
	}

	function absent() {
		stop();
		say('This camera does not report a focus measurement.', 8000);
	}

	/* ---- lifecycle ---------------------------------------------------- */

	function start() {
		if (running) return;
		/* Synchronously, inside the gesture. */
		try {
			ctx = new AC();
		} catch (e) {
			tog.checked = false;
			say('This browser will not make a sound here.', 6000);
			return;
		}
		if (ctx.state !== 'running' && typeof ctx.resume === 'function') ctx.resume().catch(() => {});
		snd = Sound(ctx);
		ear = Ear.create();
		running = true;
		paused = false;
		fails = 0;
		cursor = null;
		gen++;
		card.hidden = false;
		paint({ now: null, best: null, phase: 'listening' });
		poll();
		schedTimer = setInterval(sched, SCHED_MS);
		wake();
		/* The grid and the map, asked for now so the Area button and the
		 * first drag are not waiting on them. */
		probeGrid();
		geometryFresh();
	}

	function stop() {
		if (!running) return;
		running = false;
		paused = false;
		seq++;
		if (inflight) { try { inflight.abort(); } catch (e) { /* already done */ } inflight = null; }
		if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
		if (schedTimer) { clearInterval(schedTimer); schedTimer = null; }
		quiet(true);
		ear = null;
		last = null;
		/* The rectangle goes with the session: a pick in progress is
		 * withdrawn, the outline comes down, and the button waits for the next
		 * session's probe. */
		cancelPick();
		region = null;
		grid = null;
		setPressed(false);
		if (areaBtn) areaBtn.hidden = true;
		place();
		card.hidden = true;
		tog.checked = false;
		release();
	}

	/* Silence, and the context with it when the mode ends. */
	function quiet(close) {
		const c = ctx;
		if (!c) return;
		try { if (snd) snd.quiet(); } catch (e) { /* a context already gone */ }
		cursor = null;
		if (close) {
			ctx = null; snd = null;
			setTimeout(() => { c.close().catch(() => {}); }, 60);
		}
	}

	function loud() {
		if (snd) snd.loud();
	}

	/* The screen. A phone that locks itself throttles the poll and suspends the
	 * sound, so the lock is asked for where it exists -- which it does not on
	 * the plain-http origin most cameras are reached on, the same wall the
	 * microphone and WebCodecs hit. Then the card says the one thing that
	 * helps. */
	function wake() {
		const wl = navigator.wakeLock;
		if (wl && typeof wl.request === 'function') {
			wl.request('screen').then((l) => { lock = l; }).catch(() => {});
			return;
		}
		say('Keep the screen on: turn off auto-lock while you focus.', 8000);
	}
	function release() {
		if (lock) { lock.release().catch(() => {}); lock = null; }
	}

	function pause() {
		if (!running || paused) return;
		paused = true;
		seq++;
		if (inflight) { try { inflight.abort(); } catch (e) { /* done */ } inflight = null; }
		if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
		quiet(false);
	}
	function resume() {
		if (!running || !paused) return;
		paused = false;
		if (ctx && ctx.state !== 'running' && typeof ctx.resume === 'function') {
			ctx.resume().catch(() => {});
		}
		loud();
		wake();
		poll();
		/* A phone back from its lock screen may keep the context suspended
		 * until a gesture: the card is the gesture. */
		setTimeout(() => {
			if (running && ctx && ctx.state !== 'running')
				say('Tap the numbers to bring the sound back.', 8000);
		}, 500);
	}

	tog.addEventListener('change', () => { if (tog.checked) start(); else stop(); });
	card.addEventListener('click', () => {
		if (ctx && ctx.state !== 'running' && typeof ctx.resume === 'function') {
			ctx.resume().catch(() => {});
		}
	});
	resetBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		if (ear) { ear.reset(performance.now()); paint({ now: null, best: null, phase: 'listening' }); }
		const st = window.MajesticStats;
		if (st && typeof st.focusReset === 'function') st.focusReset();
	});
	/* The pad's own resets -- a zoom, an autofocus -- reach here as an event,
	 * so the best this sound is measured against is the one the stats panel
	 * shows. */
	window.addEventListener('mj-focus-reset', () => { if (ear) ear.reset(performance.now()); });
	if (canArea) {
		areaBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			if (picking) { cancelPick(); return; }
			if (region) { setRegion(null); return; }
			if (!running || !grid) return;
			picking = ZOOM.pickRect(picked);
			if (!picking) { say('Could not start a drag on the picture.', 4000); return; }
			setPressed(true);
			say('Drag over the part to listen to. A click keeps the whole frame.', 6000);
			/* So the map is there by the time the drag ends. */
			geometryFresh();
		});
		ZOOM.onView(place);
		window.addEventListener('mj-stream-changed', () => {
			geom = null;
			geomTried = 0;
			if (region) geometryFresh().then(place);
		});
	}
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) pause(); else resume();
	});
	window.addEventListener('pagehide', stop);

	/* For a headless check, and for a console: what the mode is doing, and a
	 * meter on the sound itself -- RMS of the mixed output every few
	 * milliseconds for a while -- so beeps and held tones can be counted by a
	 * script that has no ears. */
	window.MajesticFocusEarLive = {
		debug: () => ({
			running: running, paused: paused,
			ctxState: ctx ? ctx.state : null,
			currentTime: ctx ? ctx.currentTime : null,
			last: last, state: ear ? ear.state() : null,
			source: region && grid ? 'area' : 'frame',
			region: region, grid: grid, picking: !!picking,
			outline: outline && outline.style.display !== 'none'
				? ['x', 'y', 'width', 'height'].map((a) => +outlineRect.getAttribute(a)) : null,
		}),
		/* The sound on a context of the caller's choosing: an offline one
		 * renders the real code into a buffer a script can count beeps in. */
		sound: (actx) => Sound(actx),
		meter: (ms, stepMs) => new Promise((resolve) => {
			if (!ctx || !snd) { resolve(null); return; }
			const master = snd.master;
			const an = ctx.createAnalyser();
			an.fftSize = 512;
			master.connect(an);
			const buf = new Float32Array(an.fftSize);
			const out = [];
			const t0 = performance.now();
			const iv = setInterval(() => {
				an.getFloatTimeDomainData(buf);
				let acc = 0;
				for (let i = 0; i < buf.length; i++) acc += buf[i] * buf[i];
				out.push({ t: Math.round(performance.now() - t0), rms: Math.sqrt(acc / buf.length) });
				if (performance.now() - t0 >= ms) {
					clearInterval(iv);
					try { master.disconnect(an); } catch (e) { /* gone */ }
					resolve(out);
				}
			}, stepMs || 10);
		}),
	};
})();
