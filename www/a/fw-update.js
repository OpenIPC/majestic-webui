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

	// sysupgrade announces the reboot before taking it. That announcement is the
	// earliest honest moment to start watching for the camera to come back, and
	// waiting for anything later is what made this page sit doing nothing while
	// the camera was already serving again in another tab.
	const rebootMarker = /Unconditional reboot|Rebooting now/i;

	// Whether --force_ver was requested. It reflashes the same version on purpose,
	// so an unchanged version afterwards is a success, not a failure.
	let forced = false;

	// When this run began, so a camera's own uptime can be read as "it booted
	// during this upgrade". See rebootedAlready().
	//
	// performance.now(), not Date.now(): this is a duration, and the wall clock
	// is the one thing that cannot be trusted to hold still here. sysupgrade
	// synchronises time mid-run, and the browser's own clock can be stepped by
	// NTP at any moment — either would move this baseline under us and turn the
	// comparison into a false "it rebooted" or a missed one.
	let startedAt = 0;

	// When the last byte of log arrived, and whether the watch for the camera's
	// return has already been started. See beginPollBack().
	let lastData = 0;
	let polling = false;
	let quietTimer = null;
	// How long the log may go silent, once the flash is under way, before the
	// camera is assumed to have gone. Generous, because a quiet stretch is normal
	// during the download and the time sync — but those happen before any write,
	// so this only ever arms itself after sawFlash.
	const QUIET_MS = 15000;

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
	// The stream stops wherever the camera happened to die, which is almost never
	// on a line boundary: flashcp redraws its meter with \r and no trailing
	// newline, so the last thing written stays half-drawn ("Verifying kb:
	// 4648/4836 (96%)") and the pane reads as hung rather than finished.
	function commitLine() {
		if (!lineArr.length) return;
		doneNode.appendData(lineArr.join('') + '\n');
		lineArr = [];
		col = 0;
		lineNode.data = '';
		out.scrollTop = out.scrollHeight;
	}

	// Only ws.onclose knows the stream is really over. The reboot announcement
	// and the silence heuristic both start the watch while the socket may still
	// deliver more, so writing this there would let genuine output land
	// underneath a note claiming the connection had already ended.
	let logClosed = false;
	function endLog() {
		if (logClosed) return;
		logClosed = true;
		commitLine();
		doneNode.appendData('--- connection to the camera ended here; it is rebooting ---\n');
		out.scrollTop = out.scrollHeight;
	}

	// Start watching for the camera to come back. Three things can get us here
	// and whichever happens first wins: sysupgrade announced the reboot, the log
	// went quiet after the flash had started, or the socket closed.
	//
	// Waiting on the socket alone was the mistake. A reboot that never disturbs
	// majestic — a same-version run writes nothing — closes no sockets, so the
	// browser is not told until the rebooted camera resets the stale connection,
	// about 30s later. Starting early costs nothing when the camera is still
	// working: pollBack only watches, and rebootedAlready() keeps answering false
	// while the reported uptime is older than this run.
	function beginPollBack(quiet) {
		if (polling) return;
		polling = true;
		if (quietTimer) { clearInterval(quietTimer); quietTimer = null; }
		// Tidy the half-drawn meter, but do NOT declare the stream over: the
		// socket can still be open here and more output may yet arrive.
		commitLine();
		// Getting here on silence rather than on a reboot announcement means the
		// transcript stops mid-flash, at whatever byte the camera reached — issue
		// #120 has it ending on "Verifying kb: 1056/4844 (21%)". That is expected:
		// majestic streams this log while its own text is paged in from the rootfs
		// partition sysupgrade is overwriting, and free_resources dropped the page
		// cache first, so the next fault it takes reads the new image at a stale
		// offset and kills it. The upgrade is fine — sysupgrade is detached and
		// carries on from RAM — but a pane that just freezes looks like one that
		// has hung, so mark the gap rather than leaving it unexplained.
		//
		// Worded as a gap, not as an ending: the socket may still be open, and
		// output that resumes must not land under a note saying it had stopped.
		if (quiet) {
			doneNode.appendData('--- no output for ' + (QUIET_MS / 1000) +
				's; the camera is busy flashing ---\n');
			out.scrollTop = out.scrollHeight;
		}
		// "do not power off" is a warning about an interrupted flash, so do not
		// say it when sysupgrade has already told us it wrote nothing.
		status('warning', noop
			? 'Already up to date — waiting for the camera to come back…'
			: 'Waiting for the camera to reboot — do not power off…');
		pollBack();
	}

	function append(t) {
		lastData = performance.now();
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
		// Said out loud by sysupgrade immediately before it reboots, so there is
		// nothing left to wait for.
		if (rebootMarker.test(recent)) beginPollBack();
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
				//
				// This is the one exit that leaves the socket open: sysupgrade gave up
				// without rebooting, so the `tail -F` behind it never emits again and
				// ws.onclose may never fire. Nothing else will stop the quiet timer,
				// and it would otherwise tick for the life of the tab.
				if (quietTimer) { clearInterval(quietTimer); quietTimer = null; }
				commitLine();
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
		startedAt = performance.now();
		lastData = startedAt;
		polling = false;
		logClosed = false;
		if (quietTimer) clearInterval(quietTimer);
		// The log dying mid-flash is the other way the camera leaves without
		// saying so — majestic is simply overwritten, and "Unconditional reboot"
		// never reaches us. Only armed once a write has actually started, so the
		// naturally quiet download and time-sync phases cannot trip it.
		quietTimer = setInterval(() => {
			if (polling) { clearInterval(quietTimer); quietTimer = null; return; }
			if (sawFlash && performance.now() - lastData > QUIET_MS) beginPollBack(true);
		}, 3000);
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
			if (aborted && !sawFlash) {
				// Gave up before touching flash; no reboot is coming, and the log
				// above is the whole story.
				if (quietTimer) { clearInterval(quietTimer); quietTimer = null; }
				commitLine();
				return;
			}
			// Usually last of the three triggers rather than first — by the time a
			// hard reboot resets this socket, beginPollBack() has normally already
			// run. Kept because it is the only one that fires when the camera goes
			// without a word.
			// The socket is genuinely closed now, so the transcript can be
			// closed off too — whichever trigger already started the watch.
			endLog();
			beginPollBack();
		};
		// Same cleanup as the pre-flash abort above: the timer is armed before the
		// socket is, so a handshake that never completes would leave it ticking.
		ws.onerror = () => {
			if (opened) return;
			if (quietTimer) { clearInterval(quietTimer); quietTimer = null; }
			status('danger', 'Could not start the upgrade. Another session may be in progress, or the camera is unreachable.');
			resumeHeartbeat();
		};
	}

	// Read the version the camera is running NOW. Re-fetches this page instead of
	// adding an endpoint — fw-update.cgi already renders it, and the value has to
	// come from the rebooted camera rather than from this stale document.
	// Returns an object:
	//   { needsAuth: true }  — reachable but the session is gone (the reboot
	//                          cleared it); the caller must send the user to log in.
	//   { version: string }  — the version string it came back on.
	//   { version: null }    — reachable but the version couldn't be established
	//                          (camera still coming up), which callers treat as
	//                          "unknown", not "failed".
	async function installedNow() {
		const ctl = new AbortController();
		const to = setTimeout(() => ctl.abort(), 5000);
		try {
			const r = await fetch('fw-update.cgi?_=' + Date.now(), { credentials: 'same-origin', cache: 'no-store', signal: ctl.signal });
			// Reachable, but our session no longer authenticates: the reboot cleared
			// it and a form login left no Basic to fall back on. That is itself proof
			// the camera came back — report it so the caller sends us to sign in,
			// rather than treating it as "still unknown" like an unreachable camera.
			if (r.status === 401 || r.status === 403) return { needsAuth: true };
			if (!r.ok) return { version: null };
			const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
			const el = doc.getElementById('fw-installed');
			return { version: el ? el.textContent.trim() : null };
		} catch (err) {
			return { version: null };
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
			const res = await installedNow();
			// We only get here once a reboot is established, and the reboot cleared
			// the session (majestic keeps them in RAM), so the version page will not
			// load until the user signs in again. Send them to the form. Deliberately
			// neutral wording, not "Updated": a failed sysupgrade reboots too, and
			// with the session gone we cannot read the version to tell which — the
			// status page will show what actually installed once they are back in.
			if (res.needsAuth) {
				status('warning', 'Camera is back — please sign in again to continue.');
				setTimeout(() => location.href =
					'/login.html?next=' + encodeURIComponent('/cgi-bin/status.cgi'), 1500);
				return;
			}
			now = res.version;
		}
		if (now && installedBefore && now === installedBefore && !forced) {
			if (noop) {
				// sysupgrade said so itself: the image offered was the one already
				// installed, so it wrote nothing. Nothing failed — so lead with the
				// good news. "Already running X — nothing to update" put the negative
				// first and read as a refusal to somebody who had just asked for an
				// upgrade (issue #120).
				status('success', 'Already up to date — running ' + now + '.');
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

	// Positive evidence that the camera restarted, instead of inferring it from a
	// gap in our own polling. The camera's uptime is compared against how long
	// this run has been going: anything smaller means it booted during the
	// upgrade, and anything larger means the boot predates it.
	//
	// The down-then-up watch below cannot see a reboot it was not awake for. When
	// nothing is flashed (a same-version run) majestic is never disturbed, so the
	// hard `reboot -f` closes no sockets: the browser only learns the connection
	// died when the REBOOTED camera resets it — measured at 30s after
	// "Unconditional reboot" on an av300, by which point the camera is already
	// back. downSeen then never flips, and a perfectly good upgrade was reported
	// as "the camera never rebooted".
	//
	// Returns false, never throws: on an older camera whose pulse.cgi predates
	// uptime_s this is simply unavailable, and the watch below still applies.
	async function rebootedAlready() {
		const ctl = new AbortController();
		const to = setTimeout(() => ctl.abort(), 2500);
		try {
			const r = await fetch('/cgi-bin/j/pulse.cgi?_=' + Date.now(), { credentials: 'same-origin', cache: 'no-store', signal: ctl.signal });
			// A 401 here is ambiguous — the session can be dropped without a reboot
			// (it expires, or another tab signs out) — so it is not proof of one.
			// Treat it as "can't tell" and let the unauthenticated / ping below be
			// the reboot detector; confirmUpgrade() handles the lost session once a
			// reboot is actually established.
			if (!r.ok) return false;
			const up = Number((await r.json()).uptime_s);
			if (!isFinite(up)) return false;
			// 5s of slack so a camera that booted moments before this page loaded
			// is not mistaken for one that rebooted just now.
			return up < (performance.now() - startedAt) / 1000 - 5;
		} catch (err) {
			return false;
		} finally {
			clearTimeout(to);
		}
	}

	// Confirm a real reboot before reporting done: the camera must either go
	// UNREACHABLE and come back, or tell us its uptime is younger than this run —
	// and then confirmUpgrade checks what it came back as.
	function pollBack() {
		function ping() {
			const ctl = new AbortController();
			const to = setTimeout(() => ctl.abort(), 2500);
			return fetch('/?_=' + Date.now(), { credentials: 'same-origin', cache: 'no-store', signal: ctl.signal })
				.then(() => { clearTimeout(to); return true; })
				.catch(() => { clearTimeout(to); return false; });
		}
		let downSeen = false, tries = 0;
		const DOWN_TRIES = 160;   // ~8 min: silent download (≤2 min) + verify + flash + reboot
		const UP_TRIES = 200;     // ~10 min: a stale-clock first boot can fsck and take minutes
		// A same-version run writes nothing, so there is no download or flash to
		// wait out — only the reboot itself. Giving that the full 8 minutes would
		// leave the page sitting on a camera that finished in seconds.
		const downTries = noop ? 20 : DOWN_TRIES;   // ~60s when nothing is being written
		async function tick() {
			const up = await ping();
			if (!downSeen) {
				if (!up) { downSeen = true; tries = 0; status('warning', 'Camera is rebooting — waiting for it to come back…'); }
				// It is answering, which is either "has not rebooted yet" or "already
				// finished and came back while we were not looking". Ask it directly,
				// but not on every tick — pulse.cgi forks a dozen processes, and the
				// whole point of stopHeartbeat() was to stop hammering it.
				else if (tries % 4 === 0 && await rebootedAlready()) { confirmUpgrade(); return; }
				else if (++tries > downTries) {
					if (sawFlash) status('warning', 'Still flashing — the camera has not rebooted yet. Give it a few minutes, then reload.');
					// Nothing was written, so "we never saw it go down" is not evidence
					// of a failure — there was nothing that could have failed. Take
					// sysupgrade at its word rather than crying wolf.
					else if (noop) { confirmUpgrade(); }
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
			const r = await fetch('/upload', { method: 'POST', credentials: 'same-origin', headers: { 'File-Location': '/tmp/firmware.tgz' }, body: f });
			if (!r.ok) { status('danger', 'Upload failed (' + r.status + ').'); resumeHeartbeat(); return; }
			append('Uploaded ' + f.name + ' (' + f.size + ' bytes)\n');
			startUpgrade('/tmp/firmware.tgz');
		} catch (err) {
			status('danger', 'Upload error: ' + err);
			resumeHeartbeat();
		}
	});
})();
