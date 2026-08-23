// Factory reset: stream `sysupgrade -n --web` through j/run.cgi into the pane on
// fw-reset.cgi, then wait for the camera to come back and hand the user over to
// it. Vanilla JS; `$` and `termWriter` come from main.js.
//
// Not the /ws/upgrade socket fw-update.js uses: that endpoint exists to drive a
// firmware flash, and a reset writes no image. run.cgi is the plain streaming
// pipe this page has always used. What changed is what happens around it.
//
// The old version lived inline in the CGI and did two things that no longer
// hold. It read the stream a line at a time and appended each one, which is
// fine for `Stopping crond: OK` and useless for a meter that redraws itself
// with a bare \r — hence the terminal writer. And when the stream ended it
// navigated straight to fw-restart.cgi, on the assumption that sysupgrade had
// been told -x and had left the rebooting to us. It hasn't for a while:
// wiping rootfs_data rewrites the flash the camera is running from, so
// sysupgrade reboots regardless and says so. Two things followed from that.
// The hop landed on a camera that was already going down — and it would have
// asked for a *second* reboot if it had arrived. And it never even ran: the
// stream does not end, it dies with the camera, so the read rejects and the
// navigation after the loop was never reached (issue #154). Hence the catch
// below, and a watch that waits for the camera instead of racing it.
(function () {
	const out = $('#output');
	if (!out) return;
	const term = termWriter(out);
	const dec = new TextDecoder('utf-8');

	// Same two markers fw-update.js reads, for the same reasons. "Protected:
	// flashing continues" is sysupgrade's point of no return, printed just before
	// the erase; "Unconditional reboot" is it announcing the reboot it is about
	// to take. die() prints "<reason> Aborting." — before the RAM pivot that
	// leaves the camera untouched and running, so it is the one ending that must
	// not start a reboot watch.
	const flashMarker = /Protected: flashing/i;
	const rebootMarker = /Unconditional reboot|Rebooting now/i;
	const abortMarker = /Aborting\./;
	let sawFlash = false, sawReboot = false, aborted = false;
	// Whether a single byte ever arrived. Tells "the reset ran and ended" apart
	// from "the request never got off the ground" — a lapsed session (majestic
	// answers a bare 401), a camera already busy, a reload of this page while
	// the previous run holds the lock. Those deserve their own wording rather
	// than a verdict on a reset that never started.
	let gotOutput = false;
	// Markers can straddle two frames, so match against a rolling window rather
	// than each chunk in isolation.
	let recent = '';

	function status(cls, msg) {
		const s = $('#fw-reset-status');
		s.className = 'alert alert-' + cls;
		s.textContent = msg;
	}

	// Every tick forks a dozen processes and makes a loopback request into the
	// majestic that is streaming this log. Fine on an idle camera, ruinous on one
	// erasing its own flash — and it matters now in a way it did not before,
	// because --web keeps majestic alive to be hammered (issue #154).
	if (typeof stopHeartbeat === 'function') stopHeartbeat();

	function append(t) {
		// term.write() returns the chunk with ANSI stripped and nothing else done
		// to it — the raw stream, not what ended up on screen. The markers are
		// whole-line messages and must not depend on how the redraws rendered.
		recent = (recent + term.write(t)).slice(-512);
		if (!sawFlash && flashMarker.test(recent)) sawFlash = true;
		if (!sawReboot && rebootMarker.test(recent)) sawReboot = true;
		if (!aborted && abortMarker.test(recent)) aborted = true;
	}

	// rawFetch, not apiFetch, here and in ping() below — and never a bare fetch.
	//
	// Not apiFetch: the reset erases the overlay, and /etc/majestic.token with it,
	// then reboots, so losing the session is the EXPECTED end of this page rather
	// than an error. apiFetch would redirect to the login form on the 401 that
	// follows, throwing the transcript away at the moment it matters most, and its
	// never-settling promise would strand the watch before it could hand the user
	// back.
	//
	// But rawFetch all the same, because the two halves are separate concerns:
	// opting out of the redirect is not opting out of the header. This page runs
	// precisely when the camera has just forgotten every session there was, so its
	// requests are the ones that get answered 401 — and without
	// X-Requested-With majestic attaches WWW-Authenticate to them and Safari
	// raises the native dialog over the transcript, which is the bug #154 opened
	// on in the first place.
	async function stream() {
		const r = await rawFetch('/cgi-bin/j/run.cgi?cmd=' + btoa(out.dataset.cmd));
		// Not encodeURIComponent()'d: run.cgi eval()s QUERY_STRING as shell with
		// only & → ; substituted, so nothing decodes percent-escapes on the way
		// back out. base64's / and = survive a query string as they are.
		if (!r.ok) throw new Error('run.cgi answered ' + r.status);
		const rd = r.body.getReader();
		for (;;) {
			const { value, done } = await rd.read();
			if (done) return;
			gotOutput = true;
			append(dec.decode(value, { stream: true }));
		}
	}

	// Reachable at all, whatever it answers. A 401 is a camera that is serving
	// again and has simply forgotten us, which is exactly what a wiped overlay
	// leaves behind — so it counts as up, and the navigation that follows will
	// collect the login page on its own.
	function ping() {
		const ctl = new AbortController();
		const to = setTimeout(() => ctl.abort(), 2500);
		return rawFetch('/?_=' + Date.now(), { cache: 'no-store', signal: ctl.signal })
			.then(() => { clearTimeout(to); return true; })
			.catch(() => { clearTimeout(to); return false; });
	}

	function goBack() {
		status('success', 'The camera is back. Taking you to it…');
		// A navigation, so majestic answers it with the login page rather than a
		// bare 401 — and after a wipe it will, because the reboot cleared the
		// in-RAM sessions and the erase took the stay-signed-in key with it.
		// replace(), not href: this document is finished, and leaving it in
		// history hands Back a page that looks alive and is not.
		setTimeout(() => location.replace('/cgi-bin/status.cgi'), 1500);
	}

	// Confirm the camera actually went before declaring it back, so a poll that
	// starts a moment too early cannot mistake the still-running camera for the
	// rebooted one and navigate into a connection that is about to be cut.
	function pollBack() {
		let downSeen = false, tries = 0;
		const DOWN_TRIES = 30;   // ~90s; reboot -d 1 -f follows the announcement at once
		const UP_TRIES = 200;    // ~10 min; a first boot onto a fresh overlay is slow
		status('warning', 'The camera is rebooting — waiting for it to come back…');
		async function tick() {
			const up = await ping();
			if (!downSeen) {
				if (!up) { downSeen = true; tries = 0; }
				// Still answering well past the point it said it was rebooting. Either
				// it came back while we were between polls or it never dropped a
				// connection we noticed; either way it is serving now, so stop
				// watching and go.
				else if (++tries > DOWN_TRIES) { goBack(); return; }
			} else if (up) {
				goBack();
				return;
			} else if (++tries > UP_TRIES) {
				status('danger', 'The camera has not come back. Check it manually — the reset itself finished, see the log above.');
				return;
			}
			setTimeout(tick, 3000);
		}
		tick();
	}

	stream().then(() => false, () => true).then(streamFailed => {
		// Tidy whatever redraw the stream stopped in the middle of.
		term.commit();
		if (sawReboot || (streamFailed && sawFlash)) {
			term.note('--- connection to the camera ended here; it is rebooting ---');
			pollBack();
			return;
		}
		if (aborted) {
			status('danger', 'The reset was aborted — see the log above. The camera is unchanged.');
		} else if (!gotOutput) {
			// Nothing came back at all, so there is no log to read and nothing was
			// erased. Say that rather than passing judgement on a run that never
			// started.
			status('danger', 'Could not start the reset — the camera did not answer. Reload the page and try again.');
		} else {
			// No reboot announced and no abort. sysupgrade ran to the end of what it
			// was asked to do without wiping anything, which is what happens when it
			// finds nothing to do at all.
			status('warning', 'The reset finished without rebooting the camera — see the log above.');
		}
		if (typeof startHeartbeat === 'function') startHeartbeat();
	});
})();
