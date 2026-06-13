// Firmware update over the robust /ws/upgrade WebSocket.
// majestic stops video (frees RAM), streams download+verify here, then is
// killed at the flash step; the page switches to "rebooting" and polls until
// the camera returns. A local .tgz is first POSTed to /upload, then flashed via
// sysupgrade --archive. Vanilla JS; `$` is the querySelector helper from main.js.
(function () {
	const out = $('#fw-output');
	const ansi = /[][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
	const dec = new TextDecoder('utf-8');

	function status(cls, msg) {
		const s = $('#fw-status');
		s.className = 'alert alert-' + cls;
		s.textContent = msg;
	}
	function append(t) {
		out.textContent += t.replace(ansi, '');
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
		status('warning', 'Preparing — freeing memory…');
		const proto = location.protocol === 'https:' ? 'wss' : 'ws';
		const ws = new WebSocket(proto + '://' + location.host + '/ws/upgrade');
		ws.binaryType = 'arraybuffer';
		let opened = false;
		ws.onopen = () => { opened = true; ws.send(JSON.stringify(p)); status('warning', 'Upgrading — do not power off…'); };
		ws.onmessage = e => append(dec.decode(new Uint8Array(e.data), { stream: true }));
		// A flash only happens after the socket opened; a close without ever
		// opening means the handshake failed (let onerror report it).
		ws.onclose = () => { if (!opened) return; status('warning', 'Flashing & rebooting — do not power off. Waiting for the camera…'); pollBack(); };
		ws.onerror = () => { if (!opened) status('danger', 'Could not start the upgrade. Another session may be in progress, or the camera is unreachable.'); };
	}

	// After the WS drops (majestic killed at flash) poll until the camera is back.
	function pollBack() {
		let tries = 0;
		const t = setInterval(() => {
			if (++tries > 150) { clearInterval(t); status('danger', 'The camera has not returned. Check it manually.'); return; }
			const ctl = new AbortController();
			setTimeout(() => ctl.abort(), 2500);
			fetch('/?_=' + Date.now(), { cache: 'no-store', signal: ctl.signal })
				.then(() => { clearInterval(t); status('success', 'Camera is back online.'); setTimeout(() => location.href = 'status.cgi', 1500); })
				.catch(() => {});
		}, 3000);
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
