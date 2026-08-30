// Stage chrome for the Live View page: the control bar's visibility, the
// fullscreen button, and the snapshot button. Deliberately a separate file
// from preview-page.js — that one is executed by tests/auto-source.test.js in
// a bare vm with no document/navigator, so everything that exists purely to
// drive the DOM lives here, where the page is guaranteed to be real.
// `$`, `apiFetch`, `mjConfig` and `mjGet` are globals from main.js.
(function () {
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
		if (e.target.closest('.mj-bar, .mj-ptz, #mj-stats, .mj-adapt-note')) return;
		if (stage.classList.contains('mj-show')) {
			stage.classList.remove('mj-show');
			clearTimeout(hideTimer);
		} else {
			show(4000);
		}
	});

	// --- Fullscreen. On the stage rather than the video element, so the bar,
	// the chip, the stats overlay and the PTZ pad all come along. Hidden where
	// the API is missing (iOS Safari) rather than shown and broken.
	const fs = $('#mj-fs');
	if (fs && stage.requestFullscreen && document.fullscreenEnabled) {
		fs.hidden = false;
		fs.addEventListener('click', () => {
			if (document.fullscreenElement) document.exitFullscreen();
			else stage.requestFullscreen().catch(() => {});
		});
		document.addEventListener('fullscreenchange', () => {
			const on = document.fullscreenElement === stage;
			fs.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Fullscreen');
			fs.title = on ? 'Exit fullscreen' : 'Fullscreen';
		});
	}

	// --- Snapshot: the camera's own /image.jpg, not a capture of the <video>
	// — full sensor resolution, whatever size this player happens to be drawn
	// at. That endpoint is the JPEG channel, so the button only appears when
	// that channel is on.
	const snap = $('#mj-snap');
	if (snap) {
		mjConfig().then(cfg => {
			snap.hidden = mjGet(cfg, 'jpeg.enabled') !== true;
		});
		snap.addEventListener('click', () => {
			snap.disabled = true;
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
				.finally(() => { snap.disabled = false; });
		});
	}
})();
