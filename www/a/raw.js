/*
 * The raw page, which is the editor and nothing else.
 *
 * Everything a person does here -- take a frame, look at it, save it -- is done
 * in the editor's own chrome. This file's whole job is to mount it, tell it how
 * to reach the camera, and say something useful on the one path where it never
 * arrives.
 *
 * Frames are never written to the camera. A raw frame is several megabytes and
 * the flash it would land on is the one holding the firmware.
 */
(function () {
	const $ = (id) => document.getElementById(id);
	let editor = null;

	function stamp() {
		return 'raw-' + new Date().toISOString()
			.replace(/[-:]/g, '').slice(0, 15) + '.dng';
	}

	/*
	 * How the editor gets a frame.
	 *
	 * The status codes are answered by hand rather than passed through, because
	 * the editor shows whatever this throws and "the camera answered 501" is not
	 * something to put in front of an operator. Three of them mean three
	 * different things they can act on.
	 */
	function capture() {
		return apiFetch('/image.dng', { credentials: 'same-origin' })
			.then(function (r) {
				if (r.status === 501)
					throw new Error('Raw capture is switched off for this camera. ' +
						'Turn it on in Settings, under Live — the image settings are ' +
						'drawn there, not on a page of their own.');
				if (r.status === 404)
					throw new Error('This firmware does not serve raw frames. Raw capture ' +
						'needs a HiSilicon or Goke part whose SDK exposes the sensor’s own data.');
				if (r.status === 503)
					throw new Error('The camera could not spare the memory for a raw frame ' +
						'just now. Try again in a moment.');
				if (!r.ok) throw new Error('The camera answered ' + r.status + '.');
				return r.arrayBuffer();
			})
			.then(function (buf) {
				return { bytes: new Uint8Array(buf), name: stamp() };
			});
	}

	/* The editor could not be fetched. Say so once, and still offer the frame:
	 * a camera with no route out can capture and save perfectly well, it just
	 * cannot develop. */
	function fallback(e) {
		const host = $('raw-editor-host');
		if (host) host.hidden = true;
		$('raw-loading').hidden = true;
		// The import runs in the browser, not on the camera, and everything from a
		// blocked request to a parse error arrives here the same way. Naming a
		// cause the page never observed sends people to check a network that was
		// never the problem, so it says what happened and stops there.
		$('raw-fallback-txt').textContent = e && e.message === 'unsupported-browser'
			? 'This browser is missing what the editor needs to run. Raw frames can ' +
				'still be downloaded and opened in a desktop raw converter.'
			: 'The editor could not be loaded. It is fetched from the internet the ' +
				'first time it is opened, so a camera with no route out never gets it. ' +
				'Raw frames can still be downloaded and opened in a desktop raw converter.';
		$('raw-fallback').hidden = false;
	}

	function plainDownload() {
		const btn = $('raw-plain');
		btn.disabled = true;
		capture()
			.then(function (got) {
				const url = URL.createObjectURL(new Blob([got.bytes],
					{ type: 'image/x-adobe-dng' }));
				const a = document.createElement('a');
				a.href = url;
				a.download = got.name;
				a.click();
				setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
			})
			.catch(function (err) { $('raw-fallback-txt').textContent = err.message; })
			.then(function () { btn.disabled = false; });
	}

	function mount() {
		$('raw-fallback').hidden = true;
		$('raw-loading').hidden = false;
		const host = $('raw-editor-host');
		host.hidden = false;
		return MajesticRaw.mount(host, {
			capture: capture,
			// The editor covers the navbar, so its Back button is the only way
			// out of this page. It goes where the nav entry came from.
			onExit: function () { location.href = 'camera.cgi'; },
		}).then(function (ed) {
			editor = ed;
			// The editor covers the viewport, so the placeholder under it is
			// only wasted paint now.
			$('raw-loading').hidden = true;
		}).catch(fallback);
	}

	document.addEventListener('DOMContentLoaded', function () {
		if (!$('raw-editor-host')) return;
		$('raw-plain').addEventListener('click', plainDownload);
		// A browser too old to parse the loader's dynamic import never defines
		// MajesticRaw at all, and reaching for it here would throw before the
		// fallback had been shown -- leaving exactly the blank page this whole
		// path exists to avoid.
		if (typeof MajesticRaw === 'undefined' || !MajesticRaw.available) {
			fallback(new Error('unsupported-browser'));
			return;
		}
		mount();
	});

	// Kept reachable for a console poke and so the editor is not garbage from
	// the module's point of view while the page lives.
	window.MajesticRawPage = { current: function () { return editor; } };
})();
