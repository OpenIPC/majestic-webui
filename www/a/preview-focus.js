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
	const Ear = window.MajesticFocusEar;
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
		const off = mjMetricsSubscribe((s) => {
			const v = s && s.ok && s.m && s.m.v ? s.m.v.isp_afmetrics : undefined;
			if (Number.isFinite(v) && v >= 0) {
				ctl.hidden = false;
				off();
			}
		});
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
		function render(events, now) {
			const t0 = now !== undefined ? now : actx.currentTime;
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
		snd.render(p.events);
	}

	/* ---- the poll ----------------------------------------------------- */

	function poll() {
		if (!running || paused) return;
		const my = ++seq;
		const ac = typeof AbortController === 'function' ? new AbortController() : null;
		inflight = ac;
		const deadline = ac ? setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS) : null;
		api(URL, Object.assign({ credentials: 'same-origin', cache: 'no-store' },
			ac ? { signal: ac.signal } : {}))
			.then((r) => (r.ok ? r.text() : Promise.reject(r.status)))
			.then((text) => {
				if (my !== seq || !running) return;
				const v = Ear.readValue(text);
				if (v === null) {
					/* An empty body from a camera that answered: the chip has
					 * no statistic. Not a failure to retry, a fact. */
					absent();
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
		card.hidden = false;
		paint({ now: null, best: null, phase: 'listening' });
		poll();
		schedTimer = setInterval(sched, SCHED_MS);
		wake();
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
