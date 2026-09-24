/*
 * The focus page: the editor, mounted with the camera's AF statistics and
 * nothing else it does not need.
 *
 * The camera's ISP already measures, per frame, how much detail sits in each
 * cell of a grid over the picture. That is what an autofocus pass hunts, and
 * reduced to one number it is all a pass needs. A person turning a barrel is
 * solving the other problem -- WHERE the detail is -- so this hands over the
 * grid and lets the editor draw it.
 *
 * Nothing here writes to the camera. Unlike the colour host next door there is
 * no apply, no countdown and no revert, because a measurement has nothing to
 * take back.
 */
(function () {
	const $ = (id) => document.getElementById(id);
	let editor = null;

	/* How long the grid may be stale. The ISP recomputes it every frame; asking
	 * faster than that only spends the camera's CPU on the same answer twice,
	 * and asking much slower makes a lens feel like it is responding late. */
	const INTERVAL_MS = 700;

	function stamp() {
		return 'focus-' + new Date().toISOString()
			.replace(/[-:]/g, '').slice(0, 15) + '.dng';
	}

	/*
	 * The backdrop frame. The grid is live, the picture under it is not, and
	 * that is deliberate -- a lens being turned does not move the grid, only
	 * the numbers in it, so a still costs nothing and a live preview is not
	 * this editor's job. The editor's own panel says as much on screen.
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

	/*
	 * One AF grid.
	 *
	 * Handed over whole, in the camera's own units, because the editor does the
	 * deciding: which zones measured, which are blown out or too dark to
	 * believe, and where the sharpest one is. Reducing here would throw away
	 * exactly what this page exists to show.
	 */
	function zones() {
		return apiFetch('/api/v1/isp/af-zones.json', { credentials: 'same-origin' })
			.then(function (r) {
				if (!r.ok) throw new Error(explain(r.status));
				return r.json();
			});
	}

	/* The camera's own words are an HTTP status line and an error page, neither
	 * of which belongs in front of an operator. 503 covers two different causes
	 * and the page cannot tell them apart from the status alone, so it names
	 * both rather than guessing at one and sending someone to check the wrong
	 * thing. */
	function explain(status) {
		if (status === 404)
			return 'This firmware does not serve AF statistics.';
		if (status === 503)
			return 'The camera is not reporting AF statistics. Either this part has ' +
				'no AF block, or its video pipeline is not running right now — a ' +
				'firmware upgrade in progress will do that.';
		if (status === 401 || status === 403)
			return 'The camera refused the request. Signing in again usually fixes it.';
		return 'The camera answered ' + status + '.';
	}

	/* The editor grows a Focus tab only when it is given somewhere to read
	 * statistics from, so this page asks once before mounting rather than
	 * mounting and discovering. A tab that can only ever apologise is worse
	 * than a page that says plainly there is nothing to show. */
	function probe() {
		return zones().then(function (g) {
			if (!g || !g.rows || !g.cols || !Array.isArray(g.zones))
				throw new Error('The camera sent a grid this page could not read.');
			return true;
		});
	}

	function unsupported(e) {
		$('focus-editor-host').hidden = true;
		$('focus-loading').hidden = true;
		$('focus-fallback').hidden = true;
		$('focus-unsupported-txt').textContent = e && e.message
			? e.message : explain(0);
		$('focus-unsupported').hidden = false;
	}

	/* The editor could not be fetched, which says nothing about the camera --
	 * so this must not be worded as though the camera were at fault. */
	function fallback(e) {
		$('focus-editor-host').hidden = true;
		$('focus-loading').hidden = true;
		$('focus-unsupported').hidden = true;
		$('focus-fallback-txt').textContent = e && e.message === 'unsupported-browser'
			? 'This browser is missing what the focus display needs to run.'
			: 'The focus display could not be loaded. It is fetched from the internet ' +
				'the first time it is opened, so a camera with no route out never gets it.';
		$('focus-fallback').hidden = false;
	}

	function mount() {
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
		}).catch(fallback);
	}

	document.addEventListener('DOMContentLoaded', function () {
		if (!$('focus-editor-host')) return;
		// A browser too old to parse the loader's dynamic import never defines
		// MajesticRaw at all, and reaching for it here would throw before the
		// fallback had been shown -- leaving the blank page this path exists to
		// avoid.
		if (typeof MajesticRaw === 'undefined' || !MajesticRaw.available) {
			fallback(new Error('unsupported-browser'));
			return;
		}
		probe().then(mount).catch(unsupported);
	});

	// Kept reachable for a console poke, and so the editor is not garbage from
	// the module's point of view while the page lives.
	window.MajesticFocusPage = { current: function () { return editor; } };
})();
