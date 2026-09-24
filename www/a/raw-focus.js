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

	/* 'stop' is not a move and must never be refused for lack of a motor: it is
	 * what every release path sends, including the ones that fire while the page
	 * is being torn down. */
	function move(verb) {
		const q = verb === 'stop' ? 'stop' : verb + ':' + HOLD_MS;
		return apiFetch('/ptz?move=' + encodeURIComponent(q),
			{ method: 'POST', credentials: 'same-origin' })
			.then(function (r) {
				if (!r.ok) throw new Error('the camera answered ' + r.status);
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

	return {
		zones: zones, intervalMs: INTERVAL_MS, ready: ready,
		move: move, moveRepeatMs: REPEAT_MS, motor: motor,
	};
})();
