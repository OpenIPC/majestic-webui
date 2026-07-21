// Firmware update over the robust /ws/upgrade WebSocket.
// majestic stops video (frees RAM), streams download+verify here, then is
// killed at the flash step; the page switches to "rebooting" and polls until
// the camera returns. A local .tgz is first POSTed to /upload, then flashed via
// sysupgrade --archive. Vanilla JS; `$` is the querySelector helper from main.js.
(function () {
	const out = $('#fw-output');
	const ansi = /[][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
	const dec = new TextDecoder('utf-8');

	// sysupgrade prints one of these only after the (silent) download, once it is
	// into the point-of-no-return flash. Seeing one lets us tell a real flash
	// apart from an idle-timeout disconnect during the quiet download/time-sync.
	const flashMarker = /Received and unpacked|Kernel updated|RootFS updated|Unmounting|Unconditional reboot|Protected: flashing/i;
	let sawFlash = false;

	function status(cls, msg) {
		const s = $('#fw-status');
		s.className = 'alert alert-' + cls;
		s.textContent = msg;
	}
	function append(t) {
		const s = t.replace(ansi, '');
		if (!sawFlash && flashMarker.test(s)) sawFlash = true;
		out.textContent += s;
		out.scrollTop = out.scrollHeight;
	}
	function showProgress() {
		$('#fw-controls').style.display = 'none';
		$('#fw-progress').style.display = '';
	}
	function params(source) {
		const on = id => { const el = $('#' + id); return !!(el && el.checked); };
		return { source, kernel: on('fw_kernel'), rootfs: on('fw_rootfs'),
			reset: on('fw_reset'), force: on('fw_force') };
	}

	function startUpgrade(source) {
		const p = params(source);
		if (!p.kernel && !p.rootfs) { status('danger', 'Select kernel and/or rootfs.'); return; }
		showProgress();
		sawFlash = false;
		status('warning', 'Preparing — freeing memory…');
		const proto = location.protocol === 'https:' ? 'wss' : 'ws';
		const ws = new WebSocket(proto + '://' + location.host + '/ws/upgrade');
		ws.binaryType = 'arraybuffer';
		let opened = false;
		ws.onopen = () => { opened = true; ws.send(JSON.stringify(p)); status('warning', 'Upgrading — do not power off…'); };
		ws.onmessage = e => append(dec.decode(new Uint8Array(e.data), { stream: true }));
		// The socket can close because majestic was killed at the reboot, or
		// because it idled out during a quiet phase (download / time-sync). Either
		// way the flash may still be running, so confirm an actual reboot
		// (down-then-up) before declaring anything — never assume a close means
		// success. (Keeping the socket alive through the quiet phases is a
		// server-side concern: majestic pings /ws/upgrade while the child is idle.)
		ws.onclose = () => {
			if (!opened) return;   // handshake failed → onerror reports it
			status('warning', 'Waiting for the camera to reboot — do not power off…');
			pollBack();
		};
		ws.onerror = () => { if (!opened) status('danger', 'Could not start the upgrade. Another session may be in progress, or the camera is unreachable.'); };
	}

	// Confirm a real reboot before reporting done: the camera must first go
	// UNREACHABLE, then come back. A dropped socket alone is not proof — on a
	// failed upgrade the camera stays up, and blindly reloading would report a
	// success that never happened (issue #120, t31x).
	function pollBack() {
		function ping() {
			const ctl = new AbortController();
			const to = setTimeout(() => ctl.abort(), 2500);
			return fetch('/?_=' + Date.now(), { cache: 'no-store', signal: ctl.signal })
				.then(() => { clearTimeout(to); return true; })
				.catch(() => { clearTimeout(to); return false; });
		}
		let downSeen = false, tries = 0;
		const DOWN_TRIES = 160;   // ~8 min: silent download (≤2 min) + verify + flash + reboot
		const UP_TRIES = 200;     // ~10 min: a stale-clock first boot can fsck and take minutes
		async function tick() {
			const up = await ping();
			if (!downSeen) {
				if (!up) { downSeen = true; tries = 0; status('warning', 'Camera is rebooting — waiting for it to come back…'); }
				else if (++tries > DOWN_TRIES) {
					if (sawFlash) status('warning', 'Still flashing — the camera has not rebooted yet. Give it a few minutes, then reload.');
					else status('danger', 'The camera never rebooted — the update may have failed. Check the log above and try again.');
					return;
				}
			} else {
				if (up) { status('success', 'Camera is back online.'); setTimeout(() => location.href = 'status.cgi', 1500); return; }
				if (++tries > UP_TRIES) { status('danger', 'The camera has not returned. Check it manually.'); return; }
			}
			setTimeout(tick, 3000);
		}
		tick();
	}

	const g = $('#fw-install-github');
	if (g) g.addEventListener('click', e => { e.preventDefault(); startUpgrade('github'); });

	const u = $('#fw-install-upload');
	if (u) u.addEventListener('click', async e => {
		e.preventDefault();
		const f = $('#fw-file').files[0];
		if (!f) { status('danger', 'Choose a firmware .tgz first.'); return; }
		showProgress();
		status('warning', 'Uploading firmware…');
		try {
			const r = await fetch('/upload', { method: 'POST', headers: { 'File-Location': '/tmp/firmware.tgz' }, body: f });
			if (!r.ok) { status('danger', 'Upload failed (' + r.status + ').'); return; }
			append('Uploaded ' + f.name + ' (' + f.size + ' bytes)\n');
			startUpgrade('/tmp/firmware.tgz');
		} catch (err) {
			status('danger', 'Upload error: ' + err);
		}
	});
})();
