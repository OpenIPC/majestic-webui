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
	 * Writing a solved matrix to the camera, and being able to take it back.
	 *
	 * Both keys go together because one Calibrate produces both, and they are
	 * different transforms: isp.colorMatrix drives the live picture, and
	 * isp.dngColorMatrix is what a RAW snapshot carries. Neither is derived
	 * from the other.
	 *
	 * What makes this safe is remembering what was there first. A matrix that
	 * ruins the picture also ruins the view you would use to notice, and the
	 * setting survives a reboot, so the camera would come back still wrong.
	 */
	let previous = null;

	function fmt(m) {
		return Array.prototype.map.call(m, function (v) { return (+v).toFixed(4); }).join(' ');
	}

	/*
	 * Both keys in one POST /api/v1/config, which is the batch write: the
	 * server walks every leaf, aborts on the first one it rejects, and only
	 * then reloads and saves. Two keys that must agree cannot be written by two
	 * requests, and /api/v1/set is the single-key variant the WebUI does not
	 * use.
	 *
	 * null REMOVES a leaf. That is the only way to put an optional setting back
	 * the way it was found -- an empty string reaches the setter and is a value
	 * like any other -- and putting things back is this whole feature's safety
	 * net, so the difference is the point rather than a detail.
	 */
	function configBody(colorMatrix, dngColorMatrix) {
		return JSON.stringify({ isp: { colorMatrix: colorMatrix, dngColorMatrix: dngColorMatrix } });
	}

	function setKeys(colorMatrix, dngColorMatrix) {
		return apiFetch('/api/v1/config', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'same-origin',
			body: configBody(colorMatrix, dngColorMatrix),
		}).then(function (r) {
			if (!r.ok) throw new Error('The camera answered ' + r.status + '.');
		});
	}

	function readKeys() {
		return apiFetch('/api/v1/config.json', { credentials: 'same-origin' })
			.then(function (r) {
				if (!r.ok) throw new Error('The camera would not say what it is set to now.');
				return r.json();
			})
			.then(function (cfg) {
				const isp = (cfg && cfg.isp) || {};
				// null for a key that was not there, so restoring removes it
				// again rather than leaving an empty value behind.
				return {
					colorMatrix: 'colorMatrix' in isp ? isp.colorMatrix : null,
					dngColorMatrix: 'dngColorMatrix' in isp ? isp.dngColorMatrix : null,
				};
			});
	}

	/* Older majestic answers 202 and ignores null leaves, so a revert that
	 * meant to remove a key has to be checked rather than assumed -- the same
	 * reason mj-settings.js re-reads after a save. */
	function confirmRestored(was) {
		return readKeys().then(function (now) {
			if (now.colorMatrix === was.colorMatrix &&
				now.dngColorMatrix === was.dngColorMatrix) return;
			throw new Error('the camera did not take the old settings back; ' +
				'this firmware may be too old to remove a setting.');
		});
	}

	/* Best effort if the tab goes away mid-countdown. keepalive lets a request
	 * outlive the page; nothing guarantees it arrives, which is why the editor
	 * asks for confirmation rather than treating this as the safety net.
	 *
	 * Registered once and kept, reading `previous` when it fires rather than
	 * closing over it. Arming a fresh one per apply left a handler per
	 * calibration, and clearing `previous` is then the single thing that
	 * disarms all of it -- which is what keep() below does. */
	let unloadArmed = false;
	function armUnloadRevert() {
		if (unloadArmed) return;
		unloadArmed = true;
		window.addEventListener('pagehide', function () {
			if (!previous) return;
			try {
				fetch('/api/v1/config', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					credentials: 'same-origin',
					keepalive: true,
					body: configBody(previous.colorMatrix, previous.dngColorMatrix),
				});
			} catch (e) { /* the page is going; nothing to report it to */ }
		});
	}

	const calibrate = {
		holdSeconds: 30,
		apply: function (solved) {
			return readKeys().then(function (was) {
				previous = was;
				armUnloadRevert();
				return setKeys(fmt(solved.ccm), fmt(solved.colorMatrix));
			});
		},
		revert: function () {
			if (!previous) return Promise.resolve();
			const was = previous;
			return setKeys(was.colorMatrix, was.dngColorMatrix)
				.then(function () { return confirmRestored(was); })
				.then(function () { previous = null; });
		},
		/* Confirmed. Forgetting what was there before is what stands the unload
		 * handler down -- without this it would put the old matrix back the
		 * next time the page closed, undoing a calibration on purpose kept. */
		keep: function () {
			previous = null;
			return Promise.resolve();
		},
	};

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
			calibrate: calibrate,
			/* Plate reading, and only when there is somewhere to read from.
			 *
			 * The models are an opt-in download under a non-commercial licence
			 * (see lpr-loader.js), so on a camera nobody has configured one for
			 * there is no reader — and without a reader there is nothing to
			 * detect, so nothing to meter or stack either. Passing the
			 * capability anyway would grow a Plates tab that could only ever
			 * apologise. The editor's own rule, the one the Capture button
			 * follows: a control that can never work is worse than none.
			 *
			 * An older editor ignores this key, which is why raw-loader.js is
			 * pinned to the release that reads it. */
			plates: (window.MajesticPlates && window.MajesticPlates.readerSupported)
				? window.MajesticPlates : undefined,
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
