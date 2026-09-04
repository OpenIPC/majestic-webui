// Factory reset: stream `sysupgrade -n --web` through j/run.cgi into the pane on
// factory-reset.cgi, then wait for the camera to come back and hand the user over to
// it. Vanilla JS; `$` and `termWriter` come from main.js.
//
// Not the /ws/upgrade socket update.js uses: that endpoint exists to drive a
// firmware flash, and a reset writes no image. run.cgi is the plain streaming
// pipe this page has always used. What changed is what happens around it.
//
// The old version lived inline in the CGI and did two things that no longer
// hold. It read the stream a line at a time and appended each one, which is
// fine for `Stopping crond: OK` and useless for a meter that redraws itself
// with a bare \r — hence the terminal writer. And when the stream ended it
// navigated straight to restart.cgi, on the assumption that sysupgrade had
// been told -x and had left the rebooting to us. It hasn't for a while:
// rootfs_data is the upper layer of the overlay the running root is assembled
// from, so erasing it takes the live filesystem with it and sysupgrade reboots
// regardless, saying so as it goes. Two things followed from that.
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

	// Same two markers update.js reads, for the same reasons. "Protected:
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
	// Whether the watch for the camera's return has already been started, so the
	// marker and the end of the stream can both ask for it.
	let polling = false;
	// When the last byte arrived, and the timer watching for it to stop.
	//
	// The third trigger, and the one this page was missing. The other two are the
	// reboot announcement and the stream settling, and a hard reboot can deny us
	// both at once: "Unconditional reboot" is printed microseconds before the
	// kernel goes, so it can still be in a socket buffer when the camera stops
	// being on the other end of it — and a machine that has gone sends no FIN, so
	// the read that follows neither resolves nor rejects. Reported on a
	// gk7205v300 whose transcript stopped on the last erase line: overlay wiped,
	// camera rebooted, page left sitting on "do not navigate away" for good
	// (issue #154). update.js has had this timer since #120; the reset page was
	// written with the other two triggers and not this one.
	let lastData = 0;
	let quietTimer = null;
	const QUIET_MS = 15000;
	// When this page — and so the reset it starts on load — began, for
	// rebootedAlready() to measure the camera's uptime against.
	const startedAt = performance.now();

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
		lastData = performance.now();
		// term.write() returns the chunk with ANSI stripped and nothing else done
		// to it — the raw stream, not what ended up on screen. The markers are
		// whole-line messages and must not depend on how the redraws rendered.
		recent = (recent + term.write(t)).slice(-512);
		if (!sawFlash && flashMarker.test(recent)) sawFlash = true;
		if (!aborted && abortMarker.test(recent)) aborted = true;
		// Start watching the moment sysupgrade says it is rebooting, not when the
		// stream finally dies. Those are not the same instant: measured on a
		// hi3516ev300 reset, "Unconditional reboot" arrived at 34.6s and the read
		// did not reject until 81.2s — 46 seconds of a page still saying "do not
		// navigate away" about a camera that had already gone. The socket only
		// fails once something notices the connection is dead, which can be long
		// after the camera stopped being on the other end of it.
		//
		// Starting early is free: pollBack() only watches, and it will not act on
		// an "up" until it has seen the camera go down first.
		if (!sawReboot && rebootMarker.test(recent)) {
			sawReboot = true;
			beginPollBack();
		}
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

	// Positive evidence that the camera restarted, instead of inferring it from a
	// gap in our own polling.
	//
	// The down-then-up watch below cannot see a reboot it was not awake for, and
	// on this page it is routinely not awake for it. When the reboot line never
	// leaves the socket buffer the quiet timer is the only trigger left, and that
	// opens the watch fifteen seconds after the last byte — while the camera's
	// whole absence is about as long. Measured on an hi3516ev300: gone at 8s,
	// serving again at 23s, and the first ping landed at 19s and was answered 500
	// by a majestic that had just started. That counts as up, correctly — but
	// nothing here could then tell "it has not gone yet" from "it went and came
	// back between two polls", so downSeen never flipped and the page sat on
	// "waiting for it to come back" for another three minutes about a camera that
	// was already back (issue #154). Which way a run falls is decided by a few
	// seconds of boot time: the same reset handed back in 25s on one run and 207s
	// on the next.
	//
	// So ask the camera rather than watching for a gap. Uptime is read from
	// majestic's /metrics (node_time − node_boot), which matters more here than
	// anywhere else it is used: the reset erases the overlay and the session with
	// it, and /metrics is served without auth, so it still answers the one page
	// whose credentials it has just destroyed. Extracted with a line match, not
	// the full parser — this runs against a camera in an unknown state and must
	// stay dumb.
	//
	// It is safe to read the two as a duration even though they are wall-clock
	// stamps: majestic derives the boot time from the clock it is answering with,
	// so a correction moves both and cancels. Measured on an hi3516ev300 by
	// stepping the camera two hours backwards mid-run — node_time and node_boot
	// both fell by 7200 and their difference stayed 517s, matching /proc/uptime.
	// A clock correction therefore cannot fake a reboot here, in either
	// direction.
	//
	// Returns false, never throws. On a majestic too old to export node_*, or one
	// holding an unclaimed camera behind a 401, it is simply unavailable and the
	// watch below still applies exactly as it did before — but it must not go on
	// COSTING anything either. Each call is awaited inside a poll, so a camera
	// that answers the reachability ping and then leaves this request to time out
	// would add its 2.5s to every one of the sixty polls the blind fallback is
	// allowed, stretching a three-and-a-half-minute wait towards eight. Hence the
	// strikes: three unusable answers in a row and the loop stops asking, so such
	// a camera costs three requests rather than sixty and the watch below runs at
	// the pace it was designed for. Three rather than one, because the answer
	// most worth having comes from a majestic that has been serving for four
	// seconds, which is exactly when it is entitled to a hiccup — on one measured
	// run the plain reachability ping was answered 500 by a daemon that had just
	// started.
	let uptimeStrikes = 0;
	async function rebootedAlready() {
		if (uptimeStrikes >= 3) return false;
		const ctl = new AbortController();
		const to = setTimeout(() => ctl.abort(), 2500);
		try {
			// No ?_= cache-buster here: majestic's /metrics routes query params into
			// its value filter and answers 200 with an EMPTY body for an unknown
			// key, so the buster would blind this check. cache:'no-store' alone
			// keeps the read fresh.
			const r = await rawFetch('/metrics', { cache: 'no-store', signal: ctl.signal });
			if (!r.ok) { uptimeStrikes++; return false; }
			const txt = await r.text();
			const num = name => {
				const m = txt.match(new RegExp('^' + name + ' ([0-9.]+)$', 'm'));
				return m ? Number(m[1]) : NaN;
			};
			const upFor = num('node_time_seconds') - num('node_boot_time_seconds');
			if (!isFinite(upFor)) { uptimeStrikes++; return false; }
			// An answer, whichever way it went: the camera can be asked, so a hiccup
			// earlier in the run must not still be held against it.
			uptimeStrikes = 0;
			// 5s of slack so a camera that booted moments before this page opened is
			// not mistaken for one that rebooted just now.
			return upFor < (performance.now() - startedAt) / 1000 - 5;
		} catch (err) {
			uptimeStrikes++;
			return false;
		} finally {
			clearTimeout(to);
		}
	}

	function goBack() {
		status('success', 'The camera is back. Taking you to it…');
		// A navigation, so majestic answers it with the login page rather than a
		// bare 401 — and after a wipe it will, because the reboot cleared the
		// in-RAM sessions and the erase took the stay-signed-in key with it.
		// replace(), not href: this document is finished, and leaving it in
		// history hands Back a page that looks alive and is not.
		setTimeout(() => location.replace('/cgi-bin/dashboard.cgi'), 1500);
	}

	// Whichever of the two triggers gets here first wins: sysupgrade announced the
	// reboot, or the stream died. Tidies the half-drawn redraw the announcement
	// interrupted, but does NOT declare the stream over — more output can still
	// arrive, and usually does.
	function beginPollBack(quiet) {
		if (polling) return;
		polling = true;
		if (quietTimer) { clearInterval(quietTimer); quietTimer = null; }
		term.commit();
		// Worded as a gap rather than an ending, and for the same reason the
		// commit above does not close the transcript: the stream may still be
		// alive, and output that resumes must not land under a note saying it had
		// stopped. If it really has gone, the `.then` below adds the ending.
		if (quiet) {
			term.note('--- no output for ' + (QUIET_MS / 1000) +
				's; the camera is erasing and about to reboot ---');
		}
		pollBack();
	}

	// Confirm the camera actually went before declaring it back, so a watch that
	// starts while it is still serving cannot mistake that for the rebooted
	// camera and navigate into a connection about to be cut.
	function pollBack() {
		let downSeen = false, tries = 0;
		const DOWN_TRIES = 60;   // ~3 min; the announcement can lead the reboot by a while
		const UP_TRIES = 200;    // ~10 min; a first boot onto a fresh overlay is slow
		status('warning', 'The camera is rebooting — waiting for it to come back…');
		async function tick() {
			const up = await ping();
			if (!downSeen) {
				if (!up) { downSeen = true; tries = 0; }
				// It is answering, which is either "has not rebooted yet" or "went and
				// came back while we were not looking" — and this watch opens late
				// enough that the second is the ordinary case, not the corner one. Ask
				// it directly rather than waiting out DOWN_TRIES.
				//
				// Every tick, where the upgrade page asks every fourth: that watch can
				// open minutes before the reboot, with the camera flashing and to be
				// disturbed as little as possible, while this one opens past the erase.
				// And a /metrics read is one request majestic answers out of its own
				// memory, not the heartbeat's dozen forks and loopback round trip that
				// stopHeartbeat() exists to stop.
				else if (await rebootedAlready()) { goBack(); return; }
				// Still answering well past the point it said it was rebooting, and it
				// will not say when it booted either. Either it came back while we were
				// between polls or it never dropped a connection we noticed; either way
				// it is serving now, so stop watching and go.
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

	// Armed before the request rather than on first output, so a run that never
	// produces any is still bounded — but it only ever acts once sawFlash, so the
	// naturally quiet stretches before the point of no return (service shutdown,
	// the SD unmount, staging the RAM root) cannot trip it.
	lastData = performance.now();
	quietTimer = setInterval(() => {
		if (polling) { clearInterval(quietTimer); quietTimer = null; return; }
		if (sawFlash && performance.now() - lastData > QUIET_MS) beginPollBack(true);
	}, 3000);

	stream().then(() => false, () => true).then(streamFailed => {
		if (quietTimer) { clearInterval(quietTimer); quietTimer = null; }
		// Tidy whatever redraw the stream stopped in the middle of.
		term.commit();
		// sawFlash alone, not `streamFailed && sawFlash`. How the stream ended says
		// nothing about whether a reboot is coming: past "Protected: flashing" the
		// camera is going down whatever happens next — a reset erases the overlay
		// the live root is assembled from, and even die() reboots from there. So a
		// stream that ends CLEANLY after that point used to fall through to "the
		// reset finished without rebooting the camera" and leave the page sitting
		// there, which is the same stuck page as the lost-marker case and reachable
		// whenever majestic closes the response as its CGI child dies (issue #154).
		if (sawReboot || sawFlash) {
			// Only here is the stream genuinely over, so only here may the transcript
			// be closed off — beginPollBack() may have run a minute ago on the
			// marker, and output that arrived since must not sit under a note
			// claiming the connection had already ended.
			term.note('--- connection to the camera ended here; it is rebooting ---');
			beginPollBack();
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
