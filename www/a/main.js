function $(n) {
	return document.querySelector(n)
}

function $$(n) {
	return document.querySelectorAll(n)
}

function refresh() {
	window.location.reload()
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms))
}

// Every same-origin request the UI makes should go through here.
//
// majestic answers an unauthenticated in-page fetch with a BARE 401 — no
// WWW-Authenticate — so the browser has nothing to raise a native Basic dialog
// from. That is the right thing for the server to do: the dialog cannot say
// where you were going, and Safari used to pop it every couple of seconds off
// the heartbeat alone once a session lapsed (issue #154).
//
// The cost is that the failure is now silent — a stale header bar, a save that
// quietly does nothing — so catch it in one place and go to the login page with
// somewhere to come back to.
//
// Deliberately NOT a patch over window.fetch. The pages that deliberately
// outlive their own session must not be redirected out from under: fw-update.js
// expects a 401 while the camera reboots mid-upgrade and handles it itself, with
// wording that depends on knowing an upgrade was in flight, and fw-reset.js
// streams the factory reset that destroys the session in the first place. A
// blanket redirect would race both and throw the transcript away. Anything that
// wants this behaviour opts in.
//
// Those pages still need the HEADER, though, and that is the half that was
// missed: suppressing the dialog and redirecting on 401 are separate concerns,
// and only the second is what they opt out of. rawFetch is the first half on its
// own — every same-origin request that can be answered 401 goes through one of
// the two, or Safari raises the native prompt this pair exists to prevent.
function rawFetch(url, init) {
	const opts = Object.assign({ credentials: 'same-origin' }, init || {});
	// Declare ourselves rather than leaving majestic to infer it. The signal it
	// had to work from — Sec-Fetch-Dest — is attached by the browser, not by us:
	// Safari only sends it from 16.4, and browsers withhold it from origins they
	// do not consider trustworthy, which is the plain-HTTP address a camera is
	// normally reached at. So the dialog this helper exists to prevent was still
	// firing after a reboot with "stay signed in" unticked (issue #120). A header
	// we set ourselves does not depend on either.
	//
	// Headers, not Object.assign: callers pass plain objects today, but a Headers
	// instance has no own enumerable properties, so assigning over one would
	// silently drop everything it carries. new Headers() accepts both.
	const headers = new Headers(opts.headers || {});
	headers.set('X-Requested-With', 'XMLHttpRequest');
	opts.headers = headers;
	return fetch(url, opts);
}

function apiFetch(url, init) {
	return rawFetch(url, init).then(r => {
		if (r.status !== 401) return r;
		// replace(), not href: this document is already dead — the promise below
		// never settles, so anything awaiting it stays awaiting forever. Leaving a
		// history entry lets Back restore exactly that from the bfcache after the
		// user signs in, giving them a page that looks alive and is not.
		location.replace('/login.html?next=' +
			encodeURIComponent(location.pathname + location.search));
		// Never settles. The navigation is already under way, and letting a
		// caller run its .then() on a 401 body would paint an error onto a page
		// that is in the middle of leaving.
		return new Promise(() => {});
	});
}

let _mjCfg;
function mjConfig() {
	if (!_mjCfg)
		_mjCfg = apiFetch('/api/v1/config.json', { credentials: 'same-origin' })
			.then(r => r.ok ? r.json() : {}).catch(() => ({}));
	return _mjCfg;
}

function mjGet(cfg, dot) {
	return dot.split('.').reduce((o, k) => (o == null ? undefined : o[k]), cfg);
}

// Camera wall clock. /etc/timezone is a display label, not an IANA name --
// fw-time.js writes it de-underscored ("America/New York"), which
// Intl.DateTimeFormat rejects with a RangeError. So the camera's zone is applied
// as the numeric offset pulse.cgi reports, and the result is formatted as if it
// were UTC. Loaded on every page (p/header.cgi), so fw-time.js reuses both.
// null, not 0, when the offset is missing or malformed: callers that can hold
// off (logs.js keeps lines raw until it knows the zone) must be able to tell
// "unknown" from a genuine +0000, or a camera on +0300 would silently render
// every log line three hours out.
function parseTzOffsetMs(s) {
	const m = /^([+-])(\d{2})(\d{2})$/.exec(s || '');
	if (!m || +m[3] > 59) return null;
	return (m[1] === '-' ? -1 : 1) * (+m[2] * 3600000 + +m[3] * 60000);
}

function fmtDeviceTime(epochMs, offsetMs) {
	return new Date(epochMs + offsetMs).toLocaleString(undefined, { timeZone: 'UTC' });
}

function setProgressBar(id, value, name) {
	$(id).setAttribute('aria-valuenow', value);
	$(id).title = name + ': ' + value + '%'
	const pb = $(id + ' .progress-bar');
	pb.style.width = value + '%';
	pb.classList = 'progress-bar';
	if (value > 95) {
		pb.classList.add('bg-danger');
	} else if (value > 90) {
		pb.classList.add('bg-warning');
	} else {
		pb.classList.add('bg-success');
	}
}

// A <pre> is not a terminal, but everything sysupgrade streams into one assumes
// it is: curl's download meter, flashcp's progress and flash_eraseall's erase
// counter all redraw a single line in place with a bare \r. Appended verbatim,
// each redraw lands after the last instead of replacing it, and the meter smears
// across the pane in unreadable columns (issue #134). Stripping ANSI does not
// help — \r is a control character, not an escape sequence, so it survives that
// regex.
//
// So be just enough of a terminal for that: \n commits the line, \r returns the
// cursor to column 0, anything else overwrites at the cursor. Overwriting rather
// than clearing matters — a redraw shorter than the one before it leaves the
// tail of the longer line visible, which is what a real terminal does and what
// makes curl's meter look right as it shrinks.
//
// Two text nodes keep it cheap: finished lines are appended once and never
// touched again, and only the line still being drawn is rewritten. The console
// page has an actual terminal (xterm.js) and needs none of this.
//
// Shared by the two pages that stream sysupgrade — fw-update.js over /ws/upgrade
// and fw-reset.js over j/run.cgi. They render the identical output, so the
// lesson above only wants learning once.
function termWriter(el) {
	// \u001b/\u009b escaped rather than written as the literal ESC and CSI bytes
	// the two copies of this carried: an invisible control character in a source
	// file survives only as long as nothing greps, copies or re-encodes the line.
	const ansi = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
	const doneNode = document.createTextNode('');
	const lineNode = document.createTextNode('');
	el.appendChild(doneNode);
	el.appendChild(lineNode);
	// The line being drawn is an array of characters, not a string: the cursor can
	// land anywhere in it, and rebuilding a string per character (slice + concat +
	// slice) is quadratic in the line length. curl's meter is short enough not to
	// care, but a tool emitting a long line with no newline would have made this
	// the slowest thing on the page.
	let lineArr = [];   // the line currently being drawn, after the last \n
	let col = 0;        // cursor position within it

	return {
		// Returns the chunk with ANSI removed, so a caller matching markers can
		// feed its rolling window the same text that was rendered rather than
		// stripping the stream a second time.
		write(t) {
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
			el.scrollTop = el.scrollHeight;
			return s;
		},
		// The stream stops wherever the camera happened to die, which is almost
		// never on a line boundary: the meters redraw with \r and no trailing
		// newline, so the last thing written stays half-drawn ("Verifying kb:
		// 4648/4836 (96%)") and the pane reads as hung rather than finished.
		commit() {
			if (!lineArr.length) return;
			doneNode.appendData(lineArr.join('') + '\n');
			lineArr = [];
			col = 0;
			lineNode.data = '';
			el.scrollTop = el.scrollHeight;
		},
		// A line of our own rather than the camera's. Commits whatever was
		// half-drawn first, so a note cannot land in the middle of a redraw.
		note(text) {
			this.commit();
			doneNode.appendData(text + '\n');
			el.scrollTop = el.scrollHeight;
		},
	};
}

// Every tick spawns j/pulse.cgi, which forks a dozen more processes and makes a
// loopback request to /metrics/isp. That is fine on an idle camera and ruinous
// on one that is flashing itself, so pages that take the camera over can switch
// it off (see fw-update.js, issue #120).
let heartbeatStopped = false;
let heartbeatTimer = null;

function stopHeartbeat() {
	heartbeatStopped = true;
	clearTimeout(heartbeatTimer);
	heartbeatTimer = null;
}

function startHeartbeat() {
	if (!heartbeatStopped) return;
	heartbeatStopped = false;
	heartbeat();
}

function heartbeat() {
	// Bound the request. The next tick is armed when this one settles, so a
	// fetch left hanging by a camera that is busy or half-rebooted would
	// otherwise stop the heartbeat for the rest of the page's life.
	const ctl = new AbortController();
	const to = setTimeout(() => ctl.abort(), 5000);
	apiFetch('/cgi-bin/j/pulse.cgi', { credentials: 'same-origin', signal: ctl.signal })
		.then((response) => response.json())
		.then((json) => {
			if (json.soc_temp !== '') {
				const st = $('#soc-temp')
				st.textContent = json.soc_temp;
				st.classList.add(['text-primary','bg-white','rounded','small']);
				st.title = 'SoC temperature ' + json.soc_temp;
			}

			// Device time, deliberately -- log rows render in the viewer's zone
			// (logs.js), so these two disagree by design. This bar is the one
			// place a camera whose clock is actually wrong must look wrong, so
			// flag real drift rather than hiding it behind the browser's clock.
			// (Skew is zone-independent: a correct camera reads 0 whatever the
			// timezones are, so anything here is a genuine clock problem.)
			if (json.time_now !== '') {
				const epochMs = json.time_now * 1000;
				// Unlike the log rows there is no raw form to fall back to here, so
				// an unknown offset renders as UTC rather than blanking the bar.
				const text = fmtDeviceTime(epochMs, parseTzOffsetMs(json.utc_offset) || 0) + ' ' + json.timezone;
				const skew = epochMs - Date.now();
				const el = $('#time-now');
				if (Math.abs(skew) > 60000) {
					const mins = Math.round(skew / 60000);
					el.textContent = text + ' ⚠ ' + (mins > 0 ? '+' : '') + mins + 'm';
					el.title = 'Camera clock is ' + Math.abs(mins) + ' minutes ' +
						(mins > 0 ? 'ahead of' : 'behind') + ' this browser. Check Time Settings.';
				} else {
					el.textContent = text;
					el.title = '';
				}
			}

			if (json.mem_used !== '') {
				setProgressBar('#pb-memory', json.mem_used, 'Memory Usage');
			}

			if (json.overlay_used !== '') {
				setProgressBar('#pb-overlay', json.overlay_used, 'Overlay Usage');
			}

			if (json.daynight_value !== '-1') {
				$('#daynight_value').textContent = '🌟 ' + json.daynight_value;
			}

			if (typeof(json.uptime) !== 'undefined' && json.uptime !== '') {
				$('#uptime').textContent = 'Uptime:️ ' + json.uptime;
			}

			// Majestic's own uptime, shown in the status-page Uptime card (if present)
			if (typeof(json.mj_uptime) !== 'undefined') {
				const mj = $('#st-uptime-mj');
				if (mj) mj.textContent = json.mj_uptime || '–';
			}
		})
		.finally(() => {
			clearTimeout(to);
			// Re-arm once the poll has settled. The old `.then(setTimeout(...))`
			// ran setTimeout immediately and passed .then the timer id, so ticks
			// were scheduled 2s apart no matter how long the CGI took — they piled
			// up on exactly the busy camera that could least afford it.
			if (!heartbeatStopped)
				heartbeatTimer = setTimeout(heartbeat, 2000);
		});
}

function initAll() {
	$$('form').forEach(el => el.autocomplete = 'off');

	// For .warning and .danger buttons, ask confirmation on action.
	//
	// data-confirm overrides the wording. One shared "Are you sure?" meant that
	// rebooting the camera and wiping it back to factory asked the identical
	// question, on two buttons sitting next to each other — so the prompt carried
	// no information and became something to click through (issue #160). The
	// generic text stays for everything that has not said otherwise.
	$$('.btn-danger, .btn-warning, .confirm').forEach(el => {
		const ask = el.dataset.confirm || "Are you sure?";
		// for input, find its parent form and attach listener to it submit event
		if (el.nodeName === "INPUT") {
			while (el.nodeName !== "FORM") el = el.parentNode
			el.addEventListener('submit', ev => (!confirm(ask)) ? ev.preventDefault() : null)
		} else {
			el.addEventListener('click', ev => (!confirm(ask)) ? ev.preventDefault() : null)
		}
	});

	// A destructive switch has nothing to intercept at click time: it arms
	// something that happens later, when the form is submitted, so by the time
	// the real action runs the user is looking at a different button. Ask as it
	// is turned ON, and put it back if the answer is no. Turning one OFF is
	// always safe and never asks.
	$$('input[type=checkbox][data-confirm]').forEach(el => {
		el.addEventListener('change', () => {
			if (el.checked && !confirm(el.dataset.confirm)) el.checked = false;
		});
	});

	$$('.refresh').forEach(el => el.addEventListener('click', refresh));

	// Sign out: drop the server-side session, then land on the login page.
	// We navigate to /login.html rather than reloading, because a reload could
	// silently re-authenticate via any Basic credentials the browser still has
	// cached (and mint a fresh cookie) — from the login page a deliberate
	// re-login is required.
	const logout = $('#nav-logout');
	if (logout) {
		logout.addEventListener('click', async ev => {
			ev.preventDefault();
			try {
				const r = await apiFetch('/logout', { method: 'POST', credentials: 'same-origin' });
				// 200 cleared the session, 204 means there was none to clear — either
				// way the session is gone, so it is safe to leave. Only a network error
				// or a 5xx leaves it possibly alive: keep the user here to retry rather
				// than send them to the login page implying a sign-out that didn't take.
				if (r.ok) { location.href = '/login.html'; return; }
			} catch (e) { /* fall through to the error path */ }
			alert('Sign out failed — please try again.');
		});
	}

	// open links to external resources in a new window.
	$$('a[href^=http]').forEach(el => el.target = '_blank');

	// add auto toggle button and value display for range elements.
	$$('input[type=range]').forEach(el => {
		el.addEventListener('input', ev => {
			const id = ev.target.id.replace(/-range/, '');
			$('#' + id + '-show').textContent = ev.target.value;
			$('#' + id).value = ev.target.value;
		})
	});

	// show password when "show" checkbox is checked
	$$(".password input[type=checkbox]").forEach(el => {
		el.addEventListener('change', ev => {
			const pw = $('#' + ev.target.dataset['for']);
			pw.type = (el.checked) ? 'text' : 'password';
			pw.focus();
		});
	});

	// Endpoint URLs are rendered server-side against the camera's default-route
	// address, which is wrong the moment the WebUI is reached over a VPN, a
	// reverse proxy or a hostname (issue #164). Rewrite them to the address the
	// browser actually used. This has to happen here rather than in the haserl:
	// majestic's CGI bridge passes neither the port nor the scheme, and libevent
	// strips the port off HTTP_HOST. Runs before the .cp2cb wiring below so a
	// copy picks up the rewritten text.
	const epTls = location.protocol === 'https:';
	$$('.ep-http').forEach(el => el.textContent = epTls ? 'https' : 'http');
	$$('.ep-ws').forEach(el => el.textContent = epTls ? 'wss' : 'ws');
	// host and hostname both keep the brackets an IPv6 literal needs in a URL
	$$('.ep-host').forEach(el => el.textContent = location.host);      // host[:port]
	$$('.ep-addr').forEach(el => el.textContent = location.hostname);  // RTSP has its own port

	// ...and RTSP's own port is the one value on that page location cannot
	// supply, along with whether majestic is serving everything unauthenticated.
	// Both used to be read server-side out of /api/v1/config.json with
	// jsonfilter, which cost the camera a shell-out to a JSON parser -- and the
	// firmware a 63KB libubox -- to do what JSON.parse does here for nothing.
	// Guarded on the spans so only mj-endpoints.cgi pays for the config fetch;
	// mjConfig() caches, so a page that already asked does not ask twice.
	//
	// Majestic only range-checks rtsp.port on the write path, so a hand-edited
	// majestic.yaml can leave a port no URL can use. Anything outside 1-65535 is
	// ignored in favour of the default a bare rtsp:// implies, and 554 is left
	// off the URL entirely.
	if ($('.ep-rtsp') || $('#ep-unsafe')) mjConfig().then(cfg => {
		// The old server-side read saw every value as a string, so a port that
		// arrived quoted still worked. Coercing number|string (and nothing else,
		// so a stray `true` cannot become port 1) keeps that latitude.
		const raw = mjGet(cfg, 'rtsp.port');
		const port = (typeof raw === 'number' || typeof raw === 'string') ? Number(raw) : NaN;
		if (Number.isInteger(port) && port >= 1 && port <= 65535 && port !== 554)
			$$('.ep-rtsp').forEach(el => el.textContent = ':' + port);

		// Both notes start hidden, so this reveals exactly one -- and only once the
		// config is real. mjConfig() turns a failed or non-OK fetch into {}, which
		// is indistinguishable from "unsafe is off" if you only test the leaf, and
		// answering that with the authenticated note would be a security warning
		// failing open. The old server-side read did fail open that way (an empty
		// jsonfilter result rendered the authenticated note), but the read lived on
		// the camera, where the only way to come back empty was localhost failing.
		// From the browser the ways to come back empty are far broader, so the
		// section has to be present before either note is trusted.
		//
		// The string form is accepted alongside the boolean because jsonfilter
		// printed `true` for either. A majestic too old to report the key at all
		// still has a system section, so it keeps the authenticated note, as before.
		if (mjGet(cfg, 'system')) {
			const unsafe = mjGet(cfg, 'system.unsafe');
			const note = $(unsafe === true || unsafe === 'true' ? '#ep-unsafe' : '#ep-auth');
			if (note) note.hidden = false;
		}
	});

	// click-to-copy for .cp2cb snippets (HTTPS uses the clipboard API, plain
	// http falls back to a hidden textarea + execCommand)
	$$('.cp2cb').forEach(el => {
		el.title = 'Click to copy';
		el.addEventListener('click', () => {
			const text = el.textContent.trim();
			const flash = () => { el.title = 'Copied!'; setTimeout(() => el.title = 'Click to copy', 1000); };
			if (navigator.clipboard && window.isSecureContext) {
				navigator.clipboard.writeText(text).then(flash).catch(() => {});
			} else {
				const ta = document.createElement('textarea');
				ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
				document.body.appendChild(ta); ta.focus(); ta.select();
				try { document.execCommand('copy'); flash(); } catch (e) {}
				document.body.removeChild(ta);
			}
		});
	});

	heartbeat();
}

window.addEventListener('load', initAll);
