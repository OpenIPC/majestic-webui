// Firmware update over the robust /ws/upgrade WebSocket.
// majestic stops video (frees RAM), streams download+verify here, then is
// killed at the flash step; the page switches to "rebooting", polls until the
// camera returns, and then checks the version it came back on — sysupgrade
// reboots on failure too, so coming back is not by itself evidence of anything.
// A local .tgz is first POSTed to /upload, then flashed via sysupgrade
// --archive. Vanilla JS; `$` is the querySelector helper from main.js.
(function () {
	const out = $('#fw-output');
	const ansi = /[][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
	const dec = new TextDecoder('utf-8');

	// sysupgrade prints "Protected: flashing continues…" at its point of no
	// return, immediately before the first erase, and the "… updated" lines once a
	// partition has been written. Seeing one tells a real flash apart from a
	// socket that dropped during the quiet download.
	//
	// Nothing printed EARLIER belongs here. "Unmounting SD card" comes from
	// check_sdcard and "Received and unpacked" from the end of the download —
	// both run before the flash, so listing them meant sawFlash was already true
	// before the download even started, and the "may have failed" diagnosis below
	// was unreachable for the whole life of the feature (issue #120).
	const flashMarker = /Protected: flashing|Stopping web server before flashing|Kernel updated|RootFS updated/i;
	let sawFlash = false;

	// sysupgrade's die() prints "<reason> Aborting.". For a failure before the
	// first write it now exits without rebooting, which leaves this socket open on
	// a `tail -F` that will never emit another line — so notice it here rather
	// than sitting on "Upgrading…" forever.
	const abortMarker = /Aborting\./;
	let aborted = false;

	// compare_versions() prints this when the image on offer is the one already
	// installed, and then nothing is written. Reflashing the same build is a
	// reasonable thing to do, but the version check below cannot tell that apart
	// from a flash that silently did nothing — both end on the version they
	// started on. Without this, "nothing needed doing" is reported as "the update
	// did not apply", which reads as a failure (issue #120).
	const noopMarker = /Same version, nothing to update/i;
	let noop = false;

	// Whether --force_ver was requested. It reflashes the same version on purpose,
	// so an unchanged version afterwards is a success, not a failure.
	let forced = false;

	// The version this page was rendered with, compared against the rebooted
	// camera's. A failed sysupgrade reboots too, so "it answered again" is not
	// evidence that anything was flashed (issue #120, t31x).
	const installedEl = $('#fw-installed');
	const installedBefore = installedEl ? installedEl.textContent.trim() : '';

	function status(cls, msg) {
		const s = $('#fw-status');
		s.className = 'alert alert-' + cls;
		s.textContent = msg;
	}
	// Give the header widgets back to a page that is going to stay put. Called on
	// every outcome that leaves the user on this page with a camera that is idle
	// again — but deliberately NOT when we last saw it mid-flash, where polling it
	// is the thing we were trying to avoid.
	function resumeHeartbeat() {
		if (typeof startHeartbeat === 'function') startHeartbeat();
	}
	// This pane is a <pre>, but everything writing into it assumes a terminal:
	// curl's download meter and flashcp's progress both redraw one line in place
	// with a bare \r. Appended verbatim, each redraw lands after the last instead
	// of replacing it, and the bar smears across the pane in unreadable columns
	// (issue #134). Stripping ANSI does not help — \r is a control character, not
	// an escape sequence, so it survives the regex above.
	//
	// So be just enough of a terminal for that: \n commits the line, \r returns
	// the cursor to column 0, anything else overwrites at the cursor. Overwriting
	// rather than clearing matters — a redraw shorter than the one before it
	// leaves the tail of the longer line visible, which is what a real terminal
	// does and what makes curl's meter look right as it shrinks.
	//
	// Two text nodes keep it cheap: finished lines are appended once and never
	// touched again, and only the line still being drawn is rewritten. The
	// console page has an actual terminal (xterm.js) and needs none of this.
	const doneNode = document.createTextNode('');
	const lineNode = document.createTextNode('');
	out.appendChild(doneNode);
	out.appendChild(lineNode);
	// The line being drawn is an array of characters, not a string: the cursor can
	// land anywhere in it, and rebuilding a string per character (slice + concat +
	// slice) is quadratic in the line length. curl's meter is short enough not to
	// care, but a tool emitting a long line with no newline would have made this
	// the slowest thing on the page.
	let lineArr = [];   // the line currently being drawn, after the last \n
	let col = 0;        // cursor position within it

	// Markers can straddle two frames, so match against a rolling window of the
	// recent stream rather than each chunk in isolation.
	let recent = '';
	function append(t) {
		const s = t.replace(ansi, '');
		let commit = '';
		for (let i = 0; i < s.length; i++) {
			const ch = s[i];
			if (ch === '\n') {
				commit += lineArr.join('') + '\n';
				lineArr = [];
				col = 0;
			} else if (ch === '\r') {
				col = 0;
			} else {
				lineArr[col++] = ch;
			}
		}
		// One join per frame rather than a string rebuild per character; finished
		// lines leave through appendData and are never re-copied.
		if (commit) doneNode.appendData(commit);
		lineNode.data = lineArr.join('');
		out.scrollTop = out.scrollHeight;
		// Deliberately still the raw stream: the markers below are whole-line
		// messages, and matching them on what was received rather than on what
		// survived the redraws keeps this decoupled from the rendering.
		recent = (recent + s).slice(-512);
		if (!sawFlash && flashMarker.test(recent)) sawFlash = true;
		if (!noop && noopMarker.test(recent)) noop = true;
		if (!aborted && abortMarker.test(recent)) {
			aborted = true;
			if (sawFlash) {
				// Already past the first erase. sysupgrade still reboots from here —
				// the partition is written either way — so let pollBack run and
				// report whatever the camera comes back as.
				status('danger', 'The upgrade failed after flashing had started — see the log below. Waiting for the camera…');
			} else {
				// Nothing reached flash, so no reboot is coming and the log above is
				// the whole story. Say so now instead of waiting out pollBack.
				status('danger', 'The upgrade was aborted — see the log below. Nothing was written to flash, so the camera is unchanged.');
				resumeHeartbeat();
			}
		}
	}
	function showProgress() {
		$('#fw-controls').style.display = 'none';
		$('#fw-progress').style.display = '';
		// The camera is about to spend minutes downloading and flashing, often on
		// one core. Stop polling pulse.cgi at it — each tick forks a dozen
		// processes and makes a loopback request into the majestic that is
		// streaming this log (issue #120).
		if (typeof stopHeartbeat === 'function') stopHeartbeat();
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
		aborted = false;
		recent = '';
		forced = p.force;
		noop = false;
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
			if (aborted && !sawFlash) return;   // gave up before touching flash; no reboot is coming
			status('warning', 'Waiting for the camera to reboot — do not power off…');
			pollBack();
		};
		ws.onerror = () => { if (!opened) { status('danger', 'Could not start the upgrade. Another session may be in progress, or the camera is unreachable.'); resumeHeartbeat(); } };
	}

	// Read the version the camera is running NOW. Re-fetches this page instead of
	// adding an endpoint — fw-update.cgi already renders it, and the value has to
	// come from the rebooted camera rather than from this stale document.
	// Returns null if it cannot be established (camera still coming up, or a
	// --reset run bounced us to the password page), which callers treat as
	// "unknown", not as "failed".
	async function installedNow() {
		const ctl = new AbortController();
		const to = setTimeout(() => ctl.abort(), 5000);
		try {
			const r = await fetch('fw-update.cgi?_=' + Date.now(), { cache: 'no-store', signal: ctl.signal });
			if (!r.ok) return null;
			const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
			const el = doc.getElementById('fw-installed');
			return el ? el.textContent.trim() : null;
		} catch (err) {
			return null;
		} finally {
			clearTimeout(to);
		}
	}

	// The camera answered again. Decide success on the version it came back on,
	// not on the fact that it answered: sysupgrade's die() reboots on failure
	// too, so down-then-up is exactly what a failed upgrade looks like as well
	// (issue #120, t31x — "the page refreshes, but the firmware is not updated").
	async function confirmUpgrade() {
		status('warning', 'Camera is back — checking the installed version…');
		// It answers / as soon as majestic is up, which can be before the CGI is
		// ready, so give the version a few tries before settling for "unknown".
		let now = null;
		for (let i = 0; i < 5 && now === null; i++) {
			if (i) await new Promise(r => setTimeout(r, 2000));
			now = await installedNow();
		}
		if (now && installedBefore && now === installedBefore && !forced) {
			if (noop) {
				// sysupgrade said so itself: the image offered was the one already
				// installed, so it wrote nothing. Nothing failed.
				status('success', 'Already running ' + now + ' — nothing to update.');
				setTimeout(() => location.href = 'status.cgi', 1500);
				return;
			}
			status('danger', 'The camera rebooted but is still running ' + now +
				' — the update did not apply. Check the log above and try again.');
			resumeHeartbeat();
			return;
		}
		status('success', now ? 'Updated — now running ' + now + '.' : 'Camera is back online.');
		setTimeout(() => location.href = 'status.cgi', 1500);
	}

	// Confirm a real reboot before reporting done: the camera must first go
	// UNREACHABLE, then come back — and then confirmUpgrade checks what it came
	// back as.
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
					else { status('danger', 'The camera never rebooted — the update may have failed. Check the log above and try again.'); resumeHeartbeat(); }
					return;
				}
			} else {
				if (up) { confirmUpgrade(); return; }
				if (++tries > UP_TRIES) { status('danger', 'The camera has not returned. Check it manually.'); resumeHeartbeat(); return; }
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
			if (!r.ok) { status('danger', 'Upload failed (' + r.status + ').'); resumeHeartbeat(); return; }
			append('Uploaded ' + f.name + ' (' + f.size + ' bytes)\n');
			startUpgrade('/tmp/firmware.tgz');
		} catch (err) {
			status('danger', 'Upload error: ' + err);
			resumeHeartbeat();
		}
	});
})();
