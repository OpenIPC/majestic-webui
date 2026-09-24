/*
 * Live focus statistics for the raw editor's Focus tab.
 *
 * The camera's ISP already measures, per frame, how much detail sits in each
 * cell of a grid over the picture. Reduced to one number that is what an
 * autofocus pass hunts, and majestic has always exposed the number. A person
 * turning a barrel is solving the other problem -- WHERE the detail is -- so
 * the grid goes over as it was measured and the editor does the deciding.
 *
 * Read-only, unlike the colour host next door: this one measures and never
 * writes, so there is no apply, no countdown and no revert.
 */
window.MajesticFocus = (function () {
	/* How long the grid may be stale. The ISP recomputes it every frame; asking
	 * faster only spends the camera's CPU on the same answer twice, and asking
	 * much slower makes a lens feel like it is responding late. */
	const INTERVAL_MS = 700;

	/* A deadline on the one question asked before the editor mounts. A request
	 * that is refused rejects and a request that is answered resolves, but a
	 * socket that is simply never answered does neither -- and this promise is
	 * awaited on the path that mounts the editor, so without a deadline a hung
	 * connection would hold the raw page on "Loading the editor…" for good.
	 * An optional tab must not be able to cost the page its main function. */
	const PROBE_TIMEOUT_MS = 4000;

	/* Hold-to-run, in the motor's own terms.
	 *
	 * A move runs until this many milliseconds pass without another command for
	 * it, so the camera's stop is a deadline rather than an instruction and the
	 * lens keeps going only while the page keeps asking. HOLD_MS is therefore
	 * how long it overruns after the button comes up, and REPEAT_MS has to be
	 * comfortably shorter or the motion stutters as each pulse lapses before the
	 * next arrives.
	 *
	 * Deliberately not isp.autofocus.pulse, which the camera reports and which
	 * sizes a single operator nudge. Here the value is a timeout, and the
	 * default 500 ms would leave a lens creeping half a second past the release
	 * -- on a lens this is overshoot the operator then has to correct. */
	const HOLD_MS = 400;
	const REPEAT_MS = 200;

	/*
	 * One move. `&ms=` rather than a duration glued to the verb: both reach the
	 * daemon, but www/a/preview-ptz.js already drives this endpoint and one
	 * encoding for one thing is the point.
	 *
	 * THE BODY DECIDES, NOT THE STATUS, and that is not caution -- it is the
	 * lesson preview-ptz.js already paid for. majestic answers /ptz with a
	 * BODYLESS 200 when the sensor driver did not come up, and the plugin
	 * answers `unavailable`, also 200, when the focus port is shut -- the state
	 * a camera lands in when the motorised-lens setting is toggled without a
	 * restart. A status check calls both of those a move, and the editor would
	 * go on holding a button against a lens that never twitched.
	 */
	function move(verb) {
		let url = '/ptz?move=' + encodeURIComponent(verb);
		if (verb !== 'stop') url += '&ms=' + HOLD_MS;
		return apiFetch(url, { method: 'POST', credentials: 'same-origin' })
			.then(function (r) {
				if (!r.ok) throw new Error('the camera answered ' + r.status);
				return r.text();
			})
			.then(function (body) {
				const said = (body || '').trim();
				if (said === 'unavailable')
					throw new Error('the camera is not driving the lens — restart ' +
						'majestic to load the motor driver');
				if (!said)
					throw new Error('the camera did not answer the move');
				return said;
			});
	}

	/* The lens is asked what it can do, not assumed. `GET /ptz` answers a
	 * capability line -- actuator, port, state and the verbs this actuator's
	 * protocol actually carries -- and a camera with no motor plugin answers 404
	 * instead. Both near and far are required: a control that can only drive one
	 * way is a trap, because the way back is the one that is missing. */
	function canMove() {
		return apiFetch('/ptz', { credentials: 'same-origin' })
			.then(function (r) {
				if (!r.ok) return false;
				return r.text().then(function (line) {
					const m = /(^|\s)verbs=([^\s]*)/.exec(line || '');
					if (!m) return false;
					const verbs = m[2].split(',');
					return verbs.indexOf('near') >= 0 && verbs.indexOf('far') >= 0;
				});
			})
			.catch(function () { return false; });
	}

	function zones() {
		return apiFetch('/api/v1/isp/af-zones.json', { credentials: 'same-origin' })
			.then(function (r) {
				if (!r.ok) throw new Error(explain(r.status));
				return r.json();
			})
			.then(function (g) {
				/* Every answer, not just the first. The probe establishes that
				 * this camera HAS a grid; it says nothing about the one arriving
				 * two minutes later, and a host that advertises a shape has to
				 * hold to it on every poll or the guarantee is decorative. */
				if (!usable(g))
					throw new Error('the camera sent a focus grid whose shape and ' +
						'contents disagree');
				return g;
			});
	}

	/* The camera's own words are a status line and an error page, neither of
	 * which belongs in front of an operator. 503 covers two causes and the
	 * status cannot separate them, so it names both rather than guessing at one
	 * and sending half the people who see it to check the wrong thing. */
	function explain(status) {
		if (status === 404)
			return 'this firmware does not serve AF statistics';
		if (status === 503)
			return 'the camera is not reporting AF statistics — either this part ' +
				'has no AF block, or its video pipeline is not running right now';
		if (status === 401 || status === 403)
			return 'the camera refused the request; signing in again usually fixes it';
		return 'the camera answered ' + status;
	}

	/* The shape has to hold before anything is drawn from it. The count alone
	 * does not establish it: rows and cols that are zero, fractional or negative
	 * all satisfy a truthiness check and then divide a frame into cells that are
	 * empty, lopsided or off-screen. */
	function usable(g) {
		const whole = (v) => typeof v === 'number' && isFinite(v) &&
			Math.floor(v) === v && v > 0;
		if (!g || !whole(g.rows) || !whole(g.cols)) return false;
		if (!Array.isArray(g.zones) || g.zones.length !== g.rows * g.cols) return false;
		return g.zones.every(function (z) {
			return Array.isArray(z) && z.length === 6 &&
				z.every((v) => typeof v === 'number' && isFinite(v) && v >= 0);
		});
	}

	/*
	 * Asked once, at load, and answered before the editor is mounted.
	 *
	 * The editor grows a Focus tab only when it is handed this object, and a
	 * camera whose part has no AF block still loads the editor perfectly well
	 * -- so handing it over regardless would grow a tab that can only ever
	 * apologise. That is the rule the Capture button and the Plates tab already
	 * follow: a control that can never work is worse than none.
	 *
	 * Started here rather than in raw.js so it overlaps the loader and the
	 * stylesheet still arriving, and is usually settled by the time anything
	 * waits on it.
	 */
	const ready = Promise.race([
		zones().then(function () { return true; }, function () { return false; }),
		new Promise(function (resolve) {
			setTimeout(function () { resolve(false); }, PROBE_TIMEOUT_MS);
		}),
	]);

	/* Answered alongside the grid probe rather than after it: both are asked at
	 * load and the editor waits on the pair, so a camera that has a motor but no
	 * AF statistics still costs one round trip rather than two in series. */
	const motor = Promise.race([
		canMove(),
		new Promise(function (resolve) {
			setTimeout(function () { resolve(false); }, PROBE_TIMEOUT_MS);
		}),
	]);

	/* ---- tuning the filter -------------------------------------------- */

	const PROFILE = '/api/v1/isp/profile.ini';
	/* The four keys of the bank the focus reading comes from. The camera has
	 * twelve; these are the one filter that decides what it calls sharp. */
	const KEYS = {
		gain: 'iir1Gain', shift: 'iir1Shift',
		enable: 'iir1Enable', coring: 'iir1Coring',
	};
	const COUNT = { gain: 7, shift: 4, enable: 3, coring: 3 };
	/* The section keys the same values are written as when they go into a
	 * sensor profile, which is a different vocabulary for the same registers. */
	const INI = {
		gain: 'IIR1Gain', shift: 'IIR1Shift',
		enable: 'IIR1Enable', coring: null,
	};

	/*
	 * What the camera is RUNNING, which is not the same as what is configured.
	 *
	 * An unset isp.af.* key is genuinely unset -- the values it would hold live
	 * in the firmware, or in the sensor profile -- so reading the config would
	 * answer "nothing" for a camera running a perfectly good filter. The
	 * profile EXPORT is generated by reading the chip, so it says what is
	 * actually in force whether that came from the compiled-in defaults, a
	 * sensor profile or an operator's own key.
	 */
	function filters() {
		return apiFetch(PROFILE, { credentials: 'same-origin' })
			.then(function (r) {
				if (!r.ok) throw new Error('the camera answered ' + r.status);
				return r.text();
			})
			.then(function (text) {
				const sec = section(text, 'static_af');
				if (!sec)
					throw new Error('this firmware does not report its focus filter');
				const out = {};
				for (const k of Object.keys(KEYS)) {
					const v = k === 'coring' ? coringOf(sec) : numbers(sec[INI[k]]);
					if (!v || v.length !== COUNT[k])
						throw new Error('the camera reported a filter this page ' +
							'could not read');
					out[k] = v;
				}
				return out;
			});
	}

	/* Coring is three keys in a profile and one list in the config, because the
	 * profile names what the chip names and the config groups what is set
	 * together. Translated here rather than at either end. */
	function coringOf(sec) {
		const v = [sec.IIR1CoringTh, sec.IIR1CoringSlp, sec.IIR1CoringLmt]
			.map(function (x) { return numbers(x); });
		if (v.some(function (x) { return !x || x.length !== 1; })) return null;
		return [v[0][0], v[1][0], v[2][0]];
	}

	function numbers(raw) {
		if (raw === undefined || raw === null) return null;
		const out = [];
		for (const tok of String(raw).replace(/"/g, '').split(/[,\s]+/)) {
			if (tok === '') continue;
			const n = Number(tok);
			if (!Number.isFinite(n) || Math.floor(n) !== n) return null;
			out.push(n);
		}
		return out.length ? out : null;
	}

	/* One section of an ini, as plain keys. Deliberately small: the file is the
	 * camera's own export, not something a stranger wrote, and everything read
	 * from it is checked for shape by the caller anyway. */
	function section(text, want) {
		const lines = String(text || '').split(/\r?\n/);
		let inside = false;
		const out = {};
		for (const line of lines) {
			const s = line.trim();
			if (!s || s[0] === ';' || s[0] === '#') continue;
			if (s[0] === '[') { inside = s.slice(1, -1).trim() === want; continue; }
			if (!inside) continue;
			const eq = s.indexOf('=');
			if (eq < 0) continue;
			out[s.slice(0, eq).trim()] = s.slice(eq + 1).trim();
		}
		return Object.keys(out).length ? out : null;
	}

	function configBody(f) {
		const af = {};
		for (const k of Object.keys(KEYS)) {
			af[KEYS[k]] = f ? f[k].join(',') : null;
		}
		return JSON.stringify({ isp: { af: af } });
	}

	function postConfig(f) {
		return apiFetch('/api/v1/config', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'same-origin',
			body: configBody(f),
		}).then(function (r) {
			if (!r.ok) throw new Error('the camera answered ' + r.status);
		});
	}

	/* What the keys held before this page touched them, so putting it back is
	 * the state the operator had rather than "no key at all". Captured on the
	 * first apply only: a second trial is still undone to the same place. */
	let beforeTrial = null;

	function applyFilters(f) {
		const first = beforeTrial === null
			? apiFetch('/api/v1/config.json', { credentials: 'same-origin' })
				.then(function (r) { return r.ok ? r.json() : {}; })
				.then(function (cfg) {
					const af = (cfg && cfg.isp && cfg.isp.af) || {};
					beforeTrial = {};
					for (const k of Object.keys(KEYS)) {
						/* null, not absent: posting null REMOVES the key, which
						 * is what "it was never set" has to mean. Leaving it out
						 * of the body would keep the trial's value instead. */
						const v = numbers(af[KEYS[k]]);
						beforeTrial[k] = v && v.length === COUNT[k] ? v : null;
					}
				})
			: Promise.resolve();
		return first.then(function () { return postConfig(f); });
	}

	function revertFilters() {
		if (beforeTrial === null) return Promise.resolve();
		const had = beforeTrial;
		const body = {};
		for (const k of Object.keys(KEYS)) {
			body[KEYS[k]] = had[k] ? had[k].join(',') : null;
		}
		return apiFetch('/api/v1/config', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'same-origin',
			body: JSON.stringify({ isp: { af: body } }),
		}).then(function (r) {
			if (!r.ok) throw new Error('the camera answered ' + r.status);
			beforeTrial = null;
		});
	}

	/*
	 * Keeping writes the filter into the SENSOR PROFILE as well as leaving it
	 * in the configuration.
	 *
	 * The configuration is per camera and goes with the overlay -- a factory
	 * reset takes it. The profile is the file that ships inside a firmware
	 * image, so a filter written there is one somebody can build into their own
	 * firmware and flash onto every camera with that sensor. That is the whole
	 * reason for tuning one rather than living with what shipped.
	 */
	function keepFilters(f) {
		const ini = '[static_af]\n' +
			'IIR1Gain = "' + f.gain.join(', ') + '"\n' +
			'IIR1Shift = "' + f.shift.join(', ') + '"\n' +
			'IIR1Enable = "' + f.enable.join(', ') + '"\n' +
			'IIR1CoringTh = "' + f.coring[0] + '"\n' +
			'IIR1CoringSlp = "' + f.coring[1] + '"\n' +
			'IIR1CoringLmt = "' + f.coring[2] + '"\n';
		return apiFetch(PROFILE, {
			method: 'POST',
			headers: { 'Content-Type': 'text/plain; charset=utf-8' },
			credentials: 'same-origin',
			body: ini,
		}).then(function (r) {
			/* A camera whose profile cannot be written has still kept the
			 * filter in its configuration, and the countdown has already stood
			 * down. Saying nothing would let an operator believe it had gone
			 * into the image; the editor shows whatever this throws. */
			if (!r.ok)
				throw new Error('it is set on this camera, but the sensor ' +
					'profile could not be written (' + r.status + '), so it ' +
					'will not travel into a firmware image');
			beforeTrial = null;
		});
	}

	return {
		zones: zones, intervalMs: INTERVAL_MS, ready: ready,
		move: move, moveRepeatMs: REPEAT_MS, motor: motor,
		filters: filters, applyFilters: applyFilters,
		revertFilters: revertFilters, keepFilters: keepFilters,
		holdSeconds: 30,
	};
})();
