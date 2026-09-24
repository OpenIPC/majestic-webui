/*
 * The focus page: the camera's AF grid, drawn over the frame where the editor
 * can be had and read out as numbers where it cannot.
 *
 * The camera's ISP already measures, per frame, how much detail sits in each
 * cell of a grid over the picture. Reduced to one number that is what an
 * autofocus pass hunts; a person turning a barrel is solving the other problem
 * -- WHERE the detail is -- so the grid goes to the editor whole.
 *
 * Nothing here writes to the camera. Unlike the colour host next door there is
 * no apply, no countdown and no revert, because a measurement has nothing to
 * take back.
 */
(function () {
	const $ = (id) => document.getElementById(id);
	let editor = null, plainTimer = null;

	/* How long the grid may be stale. The ISP recomputes it every frame; asking
	 * faster only spends the camera's CPU on the same answer twice, and asking
	 * much slower makes a lens feel like it is responding late. */
	const INTERVAL_MS = 700;

	/* The camera's own blend of the two banks it measures, and the one thing in
	 * here that must not be invented locally: it has to be the number the
	 * editor would have drawn, or the fallback and the display disagree about
	 * which way is sharper.
	 *
	 * h2 and v2, never h1 and v1. Both horizontal banks report real numbers
	 * over the same zones, and only the second is tuned to track focus -- the
	 * first is a wider companion that can read HIGHER as the picture blurs. */
	function blend(z) {
		return Math.trunc((z[1] * 54 + z[3] * 10) / 64);
	}

	function stamp() {
		return 'focus-' + new Date().toISOString()
			.replace(/[-:]/g, '').slice(0, 15) + '.dng';
	}

	/*
	 * The backdrop frame. The grid is live, the picture under it is not, and
	 * that is deliberate -- a lens being turned does not move the grid, only
	 * the numbers in it, so a still costs nothing and a live preview is not
	 * this editor's job.
	 */
	function capture() {
		return apiFetch('/image.dng', { credentials: 'same-origin' })
			.then(function (r) {
				if (r.status === 501)
					throw new Error('Raw capture is switched off for this camera. ' +
						'Turn it on in Settings, under Live — the focus grid is drawn ' +
						'over a frame, so it needs one.');
				if (r.status === 404)
					throw new Error('This firmware does not serve raw frames, and the ' +
						'focus grid is drawn over one.');
				if (r.status === 503)
					throw new Error('The camera is already busy with a raw frame. Most ' +
						'cameras take them one at a time — wait for that one to finish ' +
						'and ask again.');
				if (!r.ok) throw new Error('The camera answered ' + r.status + '.');
				return r.arrayBuffer();
			})
			.then(function (buf) {
				return { bytes: new Uint8Array(buf), name: stamp() };
			});
	}

	/* One AF grid, handed over whole and in the camera's own units, because the
	 * editor does the deciding: which zones measured, which are blown out or
	 * too dark to believe, and where the sharpest one is. */
	function zones() {
		return apiFetch('/api/v1/isp/af-zones.json', { credentials: 'same-origin' })
			.then(function (r) {
				if (!r.ok) {
					const err = new Error(explain(r.status));
					/* Only a 404 is the firmware saying it has no such endpoint,
					 * which no amount of asking again will change. Everything
					 * else -- a 503 while the pipeline is down for an upgrade, a
					 * server error, a dropped connection -- can answer
					 * differently in a minute, and must not be presented as a
					 * dead end. */
					err.permanent = r.status === 404;
					throw err;
				}
				return r.json();
			});
	}

	function explain(status) {
		if (status === 404)
			return 'This firmware does not serve AF statistics, so there is nothing ' +
				'for this page to show.';
		if (status === 503)
			return 'The camera is not reporting AF statistics. Either this part has ' +
				'no AF block, or its video pipeline is not running right now — a ' +
				'firmware upgrade in progress will do that, and finishes on its own.';
		if (status === 401 || status === 403)
			return 'The camera refused the request. Signing in again usually fixes it.';
		if (!status)
			return 'The camera could not be reached.';
		return 'The camera answered ' + status + '.';
	}

	/* The grid's shape has to hold before anything is drawn from it. The count
	 * alone does not establish it: rows and cols that are zero, fractional or
	 * negative all satisfy a truthiness check and then divide a frame into
	 * cells that are empty, lopsided or off-screen. */
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

	/* The editor grows a Focus tab only when it is given somewhere to read
	 * statistics from, so this page asks once before mounting rather than
	 * mounting and discovering. A tab that can only ever apologise is worse
	 * than saying plainly there is nothing to show. */
	function probe() {
		return zones().then(function (g) {
			if (!usable(g)) {
				const e = new Error('The camera sent a focus grid this page could ' +
					'not read. Its shape and its contents disagree.');
				e.permanent = false;
				throw e;
			}
			return g;
		});
	}

	function hideAll() {
		['focus-editor-host', 'focus-loading', 'focus-plain', 'focus-unsupported']
			.forEach(function (id) { $(id).hidden = true; });
	}

	/* Nothing to read. The retry is offered only where asking again could
	 * answer differently, because a permanent absence with a Try again button
	 * is an invitation to keep pressing. */
	function unsupported(e) {
		hideAll();
		$('focus-unsupported-txt').textContent = (e && e.message) || explain(0);
		$('focus-unsupported-acts').hidden = !!(e && e.permanent);
		$('focus-unsupported').hidden = false;
	}

	/*
	 * The editor never arrived, but the camera is answering. Degraded rather
	 * than broken: the sharpest cell of the grid, read out and kept current, is
	 * what a lens is actually focused by.
	 *
	 * A plain maximum, and it says so on the page -- the editor additionally
	 * judges which zones are too dark or too blown to believe, and this does
	 * not. The counts are shown beside it so the number can be judged.
	 */
	function plain(why) {
		hideAll();
		// It is the display that is missing, not the camera and not its route:
		// this module is imported by THIS BROWSER, from a CDN or from whatever
		// MJ_RAW_BASE names. Blaming the camera's network sends someone to
		// check a link that was never in the path.
		$('focus-plain-why').textContent = why;
		$('focus-plain').hidden = false;

		const tick = function () {
			zones().then(function (g) {
				if (!usable(g)) throw new Error('unreadable');
				let best = -1, at = null, dark = 0, blown = 0;
				for (let i = 0; i < g.zones.length; i++) {
					const z = g.zones[i], v = blend(z);
					if (z[4] === 0) dark++;
					if (z[5] > 0) blown++;
					if (v > best) { best = v; at = i; }
				}
				$('focus-plain-peak').textContent = String(best);
				$('focus-plain-where').textContent = at === null ? '' :
					'Row ' + (Math.floor(at / g.cols) + 1) + ', column ' +
					(at % g.cols + 1) + ' of ' + g.rows + ' × ' + g.cols + '.';
				$('focus-plain-counts').textContent =
					(dark ? dark + ' zones too dark to measure. ' : '') +
					(blown ? blown + ' zones blown out. ' : '') +
					'This is the highest cell, without the display’s judgement ' +
					'of which cells are worth believing.';
			}).catch(function () {
				// One missed read is not worth a page of explanation while the
				// number beside it is still the last good one; the poll keeps
				// going and the next answer replaces this.
				$('focus-plain-counts').textContent =
					'The camera did not answer that request. Still asking…';
			});
		};
		tick();
		plainTimer = setInterval(tick, INTERVAL_MS);
	}

	function mount(g) {
		hideAll();
		$('focus-loading').hidden = false;
		const host = $('focus-editor-host');
		host.hidden = false;
		return MajesticRaw.mount(host, {
			capture: capture,
			/* Read-only, so unlike the colour host this is the whole contract:
			 * somewhere to read a grid from, and how often. */
			focus: { zones: zones, intervalMs: INTERVAL_MS },
			// The editor covers the navbar, so its Back button is the only way
			// out. It goes where the nav entry came from.
			onExit: function () { location.href = 'camera.cgi'; },
		}).then(function (ed) {
			editor = ed;
			$('focus-loading').hidden = true;
		}).catch(function () {
			plain('The focus display could not be loaded. This browser fetches it ' +
				'from the internet the first time the page is opened, so a browser ' +
				'with no route to it never gets one. The camera is answering, so ' +
				'the reading below is live — only the picture and the heatmap over ' +
				'it are missing.');
		});
	}

	document.addEventListener('DOMContentLoaded', function () {
		if (!$('focus-editor-host')) return;
		probe().then(function (g) {
			// A browser too old to parse the loader's dynamic import never
			// defines MajesticRaw at all. The camera still answers, so this is
			// the same degraded page rather than an apology.
			if (typeof MajesticRaw === 'undefined' || !MajesticRaw.available) {
				plain('This browser is missing what the focus display needs to run. ' +
					'The camera is answering, so the reading below is live — only ' +
					'the picture and the heatmap over it are missing.');
				return;
			}
			return mount(g);
		}).catch(unsupported);
	});

	// Kept reachable for a console poke, and so the editor is not garbage from
	// the module's point of view while the page lives.
	window.MajesticFocusPage = {
		current: function () { return editor; },
		stop: function () { if (plainTimer) { clearInterval(plainTimer); plainTimer = null; } },
	};
})();
