// Stage chrome for the Live View page: the control bar's visibility, the
// fullscreen button, and the snapshot button. Deliberately a separate file
// from preview-page.js — that one is executed by tests/auto-source.test.js in
// a bare vm with no document/navigator, so everything that exists purely to
// drive the DOM lives here, where the page is guaranteed to be real.
// `$`, `apiFetch`, `mjConfig` and `mjGet` are globals from main.js.
(function () {
	// Two of these are shared with mj-settings.cgi's Live adjustments stage,
	// which builds its chrome client-side and so has no elements at load time.
	// They are published before the early return below for exactly that reason.
	// What is NOT shared is the bar's auto-hide: on that panel the bar carries
	// the night/IR/lamp indicators, which are state you have to be able to read
	// without waving a mouse at the picture first.
	window.MajesticHero = {
		// Fullscreen on the STAGE rather than the video element, so the bar and
		// everything else overlaid on the picture comes along. Hidden where the
		// API is missing (iOS Safari) rather than shown and broken.
		wireFullscreen: function (stage, btn) {
			if (!stage || !btn || !stage.requestFullscreen || !document.fullscreenEnabled) return;
			btn.hidden = false;
			btn.addEventListener('click', () => {
				if (document.fullscreenElement) document.exitFullscreen();
				else stage.requestFullscreen().catch(() => {});
			});
			document.addEventListener('fullscreenchange', () => {
				const on = document.fullscreenElement === stage;
				btn.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Fullscreen');
				btn.title = on ? 'Exit fullscreen' : 'Fullscreen';
			});
		},

		// Snapshot: the camera's own /image.jpg, not a capture of the <video> —
		// full sensor resolution, whatever size the player happens to be drawn
		// at. That endpoint is the JPEG channel, so the button only appears when
		// that channel is on.
		wireSnapshot: function (btn) {
			if (!btn) return;
			mjConfig().then(cfg => {
				btn.hidden = mjGet(cfg, 'jpeg.enabled') !== true;
			});
			btn.addEventListener('click', () => {
				btn.disabled = true;
				apiFetch('/image.jpg', { credentials: 'same-origin', cache: 'no-store' })
					.then(r => { if (!r.ok) throw new Error(r.status); return r.blob(); })
					.then(b => {
						const d = new Date(), p = n => String(n).padStart(2, '0');
						const name = 'snapshot-' + d.getFullYear() + p(d.getMonth() + 1) +
							p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) +
							p(d.getSeconds()) + '.jpg';
						const url = URL.createObjectURL(b);
						const a = document.createElement('a');
						a.href = url;
						a.download = name;
						a.click();
						// Revoked on a delay: revoking synchronously races the
						// download in some browsers.
						setTimeout(() => URL.revokeObjectURL(url), 5000);
					})
					.catch(() => {})
					.finally(() => { btn.disabled = false; });
			});
		},
	};

	const stage = $('#mj-stage'), bar = $('#mj-bar');
	if (!stage || !bar) return;

	// --- Bar visibility. CSS shows the bar on :hover (mouse) and
	// :focus-within (keyboard); this handles the rest: mouse movement keeps it
	// up briefly even when :hover is unreliable (e.g. straight after
	// fullscreen), and on touch — where hover does not exist — a tap on the
	// picture toggles it. Taps on the bar, the PTZ pad or the stats panel are
	// interactions with those, not requests to hide them.
	let hideTimer = null;
	function show(ms) {
		stage.classList.add('mj-show');
		clearTimeout(hideTimer);
		if (ms) hideTimer = setTimeout(() => stage.classList.remove('mj-show'), ms);
	}
	stage.addEventListener('pointermove', e => {
		if (e.pointerType === 'mouse') show(2500);
	});
	stage.addEventListener('pointerdown', e => {
		if (e.pointerType !== 'touch') return;
		if (e.target.closest('.mj-bar, .mj-ptz, #mj-stats, #mj-adapt')) return;
		if (stage.classList.contains('mj-show')) {
			stage.classList.remove('mj-show');
			clearTimeout(hideTimer);
		} else {
			show(4000);
		}
	});

	window.MajesticHero.wireFullscreen(stage, $('#mj-fs'));
	window.MajesticHero.wireSnapshot($('#mj-snap'));
})();
