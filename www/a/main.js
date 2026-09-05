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
// outlive their own session must not be redirected out from under: update.js
// expects a 401 while the camera reboots mid-upgrade and handles it itself, with
// wording that depends on knowing an upgrade was in flight, and factory-reset.js
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
			.then(r => r.ok ? r.json() : Promise.reject(r.status))
			.catch(() => {
				// Resolve {} for this caller, but don't cache it: a transient
				// failure at page load must not read as "everything disabled"
				// for the rest of the page's life — the next call retries.
				_mjCfg = null;
				return {};
			});
	return _mjCfg;
}

function mjGet(cfg, dot) {
	return dot.split('.').reduce((o, k) => (o == null ? undefined : o[k]), cfg);
}

// Camera wall clock. /etc/timezone is a display label, not an IANA name --
// time.js writes it de-underscored ("America/New York"), which
// Intl.DateTimeFormat rejects with a RangeError. So the camera's zone is applied
// as the numeric offset pulse.cgi reports, and the result is formatted as if it
// were UTC. Loaded on every page (p/header.cgi), so time.js reuses both.
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

// ...and the reader's own clock, which is the one the signature bar shows. Not
// polled: the browser already knows the time, and it knows it in the zone the
// person is actually in, which is more than the camera can say. Time only —
// today's date is in the tooltip, because the bar is glanced at rather than
// read and the full "8/29/2026, 5:47:07 PM" it used to carry crowded the row.
function localClock() {
	const el = $('#time-local');
	if (!el) return;
	const tick = () => {
		const d = new Date();
		el.textContent = d.toLocaleTimeString();
		el.dateTime = d.toISOString();
		el.title = d.toLocaleDateString(undefined, {
			weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
		});
		// Re-armed on the next second boundary rather than every 1000 ms: a fixed
		// interval started mid-second slides against the wall clock and makes the
		// display visibly skip a second every minute or so.
		setTimeout(tick, 1000 - (Date.now() % 1000));
	};
	tick();
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
// Shared by the two pages that stream sysupgrade — update.js over /ws/upgrade
// and factory-reset.js over j/run.cgi. They render the identical output, so the
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

// The heartbeat polls majestic's /metrics — served straight from the daemon's
// memory, no forks — and everything the topbar shows is derived from it in the
// browser. The one fact the daemon cannot know (overlay df) comes from the
// slimmed j/pulse.cgi, fetched every 15th tick. Pages that take the camera
// over can still switch the whole thing off (see fw-update.js, issue #120).
let heartbeatStopped = false;
let heartbeatTimer = null;
let mjMetricsSubs = [];
let mjMetricsLast = null;
let mjPrevSample = null;
let mjFails = 0;
let mjTickN = 0;

// Other scripts (status.js) consume the poll through here instead of running a
// second one. A subscriber that registers after a tick gets the latest good
// sample immediately; failures are announced but never remembered.
function mjMetricsSubscribe(fn) {
	mjMetricsSubs.push(fn);
	if (mjMetricsLast) fn(mjMetricsLast);
}

function mjMetricsPublish(s) {
	if (s.ok) mjMetricsLast = s;
	mjMetricsSubs.forEach(fn => { try { fn(s); } catch (e) {} });
}

// Prometheus text → { v, cpuTotal, cpuIdle, rx, tx }. `v` maps every unlabelled
// metric to its number; of the labelled families only cpu and net are wanted,
// summed over their labels — the rest (task_seconds, node_uname_info) are
// skipped unread. First write wins on a duplicated name: majestic on Ingenic
// emits isp_exptime twice, canonical ISP block first, so first-wins reads the
// same value before and after the daemon-side fix.
function parseMetrics(text) {
	const m = { v: Object.create(null), cpuTotal: 0, cpuIdle: 0, rx: 0, tx: 0 };
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const ln = lines[i];
		if (!ln || ln.charCodeAt(0) === 35) continue; // '#'
		const sp = ln.lastIndexOf(' ');
		if (sp < 0) continue;
		// +'' is 0, not NaN, so a line that ends in a space would otherwise
		// mint a metric with value 0 out of nothing.
		const key = ln.slice(0, sp), vs = ln.slice(sp + 1);
		if (!vs) continue;
		const val = +vs;
		if (isNaN(val)) continue;
		if (key.indexOf('{') >= 0) {
			if (key.startsWith('node_cpu_seconds_total')) {
				m.cpuTotal += val;
				if (key.indexOf('mode="idle"') >= 0) m.cpuIdle += val;
			} else if (key.startsWith('node_network_receive_bytes_total')) {
				if (key.indexOf('device="lo"') < 0) m.rx += val;
			} else if (key.startsWith('node_network_transmit_bytes_total')) {
				if (key.indexOf('device="lo"') < 0) m.tx += val;
			}
			continue;
		}
		if (!(key in m.v)) m.v[key] = val;
	}
	// Kernels older than 3.14 omit MemAvailable, and /metrics mirrors
	// /proc/meminfo verbatim, so the metric is absent rather than zero — left
	// alone that reads as 100% used (issue #116). Rebuild the kernel's own
	// si_mem_available() estimate from the parts that are present; wmark_low is
	// not in /proc/meminfo, so this runs ~2% optimistic. Clamped to MemTotal so
	// memAvail <= memTotal is an invariant every consumer can rely on.
	const v = m.v;
	if (!('node_memory_MemAvailable_bytes' in v))
		v.node_memory_MemAvailable_bytes =
			(v.node_memory_MemFree_bytes || 0) +
			(v.node_memory_Active_file_bytes || 0) +
			(v.node_memory_Inactive_file_bytes || 0) +
			(v.node_memory_SReclaimable_bytes || 0);
	if (v.node_memory_MemTotal_bytes &&
		v.node_memory_MemAvailable_bytes > v.node_memory_MemTotal_bytes)
		v.node_memory_MemAvailable_bytes = v.node_memory_MemTotal_bytes;
	return m;
}

function uptimeStr(s) {
	s = Math.max(0, s | 0);
	const d = (s / 86400) | 0, h = ((s % 86400) / 3600) | 0, m = ((s % 3600) / 60) | 0;
	return (d ? d + 'd ' : '') + (h || d ? h + 'h ' : '') + m + 'm';
}

function stopHeartbeat() {
	heartbeatStopped = true;
	clearTimeout(heartbeatTimer);
	heartbeatTimer = null;
}

function startHeartbeat() {
	if (!heartbeatStopped) return;
	heartbeatStopped = false;
	// A resume usually follows a reboot: forget the previous sample so CPU%
	// skips one tick instead of computing a delta across it, and refetch the
	// overlay figure immediately rather than up to 15 ticks from now.
	mjPrevSample = null;
	mjTickN = 0;
	heartbeat();
}

// Overlay usage is the one topbar figure /metrics cannot supply. It moves when
// config is written, not per second, so the slim pulse.cgi is asked every 15th
// tick (~30s) — fire-and-forget, never chained to the metrics fetch.
function pulseTick() {
	const ctl = new AbortController();
	const to = setTimeout(() => ctl.abort(), 5000);
	apiFetch('/cgi-bin/j/pulse.cgi', { signal: ctl.signal })
		.then(r => r.json())
		.then(json => {
			if (json.overlay_used !== '' && $('#pb-overlay'))
				setProgressBar('#pb-overlay', json.overlay_used, 'Overlay Usage');
		})
		.catch(() => {})
		.finally(() => clearTimeout(to));
}

// Every element here is $-guarded: this runs before the sample is published,
// so one absent element (a page without the full header, an older install)
// must degrade to a missing figure, not take the status dashboard down with it.
function renderTopbar(s) {
	const v = s.m.v;
	if (s.temp != null) {
		const st = $('#soc-temp');
		if (st) {
			st.textContent = s.temp.toFixed(0) + '°C';
			st.title = 'SoC temperature ' + st.textContent;
		}
	}

	// The camera's clock is worth a line only when it is wrong. It used to
	// be printed in full on every page, in the camera's own zone, which is
	// the one zone nobody reading the page is in — and on a camera whose
	// timezone was never set that reads "Etc/GMT", i.e. the time in
	// London. What device time is genuinely good for is catching a camera
	// that has drifted, because recordings and log rows are stamped by it
	// and nothing else on the page would show it. So only the drift is
	// left. (Skew is zone-independent: a correct camera reads 0 whatever
	// either timezone is, so anything here is a real clock problem.)
	const drift = $('#clock-drift');
	if (s.driftMs != null && drift) {
		const mins = Math.round(s.driftMs / 60000);
		const el = drift;
		// Cleared when the clocks agree, not left standing: the camera's
		// clock can be corrected while the page is open, and a stale warning
		// would outlive the fault it describes.
		const text = Math.abs(s.driftMs) > 60000
			? '⚠ camera ' + (mins > 0 ? '+' : '') + mins + 'm' : '';
		// Written only when it actually changes. The element is a live
		// region, and re-setting textContent to the same string still
		// replaces the text node — a screen reader would hear the same
		// warning read out afresh every two seconds for as long as the page
		// stayed open. (A plain `return` here would be worse than the noise
		// it saves: this runs inside the heartbeat's one handler, so it
		// would take memory, day/night and uptime down with it.)
		if (el.textContent !== text) {
			el.textContent = text;
			// Colour comes from #clock-drift in bootstrap.override.css, which
			// is theme-aware; .text-danger is one red for both themes and
			// fails contrast on each. Only the spacing is a utility.
			el.className = text ? 'ms-1' : '';
			if (text) {
				// The glyph and "+12m" are a shorthand that only reads next to
				// the clock beside it, and title is not exposed on a span nobody
				// can focus — so the sentence is what is announced.
				const why = 'Camera clock is ' + Math.abs(mins) + ' minutes ' +
					(mins > 0 ? 'ahead of' : 'behind') + ' this browser. Check Time Settings.';
				el.title = why;
				el.setAttribute('aria-label', why);
			} else {
				el.title = '';
				el.removeAttribute('aria-label');
			}
		}
	}

	if (s.memPct != null && $('#pb-memory'))
		setProgressBar('#pb-memory', Math.round(s.memPct), 'Memory Usage');

	const up = $('#uptime');
	if (up && s.sysUptimeS != null)
		up.textContent = 'Uptime:️ ' + uptimeStr(s.sysUptimeS);
}

function heartbeat() {
	// Bound the request. The next tick is armed when this one settles, so a
	// fetch left hanging by a camera that is busy or half-rebooted would
	// otherwise stop the heartbeat for the rest of the page's life.
	const ctl = new AbortController();
	const to = setTimeout(() => ctl.abort(), 5000);
	if (mjTickN++ % 15 === 0) pulseTick();
	apiFetch('/metrics', { signal: ctl.signal })
		.then(r => r.ok ? r.text() : Promise.reject(r.status))
		.then(text => {
			mjFails = 0;
			const m = parseMetrics(text), v = m.v;
			const t = v.node_time_seconds || (Date.now() / 1000);
			// dt comes from the browser's monotonic clock, not from the camera's
			// node_time_seconds: that gauge has whole-second resolution (two polls
			// inside one second read dt=0) and moves when NTP steps the camera's
			// clock — either way every rate derived from dt would silently stop
			// or spike. The counters are camera-side but the clocks agree to well
			// under the error a 2s window already carries.
			const mono = performance.now() / 1000;
			const prev = mjPrevSample;
			let cpu = null;
			if (prev && m.cpuTotal > prev.m.cpuTotal) {
				const d = m.cpuTotal - prev.m.cpuTotal;
				cpu = Math.max(0, Math.min(100, (1 - (m.cpuIdle - prev.m.cpuIdle) / d) * 100));
			}
			const memTotal = v.node_memory_MemTotal_bytes || 0;
			const memAvail = v.node_memory_MemAvailable_bytes || 0;
			const sysUp = v.node_boot_time_seconds ? t - v.node_boot_time_seconds : null;
			// A daemon cannot have been up longer than the kernel, but its boot
			// stamp can say so: app_boot_time_seconds is the wall clock at daemon
			// start, and a camera without an RTC stamps it before NTP has fixed
			// that clock — after a power cycle the stamp sits hours in the past
			// and the "majestic uptime" dwarfs the system's. node_boot is derived
			// from /proc/uptime against the corrected clock, so it is the bound.
			let mjUp = v.app_boot_time_seconds ? t - v.app_boot_time_seconds : null;
			if (mjUp != null && sysUp != null && mjUp > sysUp) mjUp = sysUp;
			const s = {
				ok: true, fails: 0, t, dt: prev ? mono - prev.mono : null, cpu,
				memTotal, memAvail,
				memPct: memTotal ? (1 - memAvail / memTotal) * 100 : null,
				temp: ('node_hwmon_temp_celsius' in v) ? v.node_hwmon_temp_celsius : null,
				driftMs: v.node_time_seconds ? v.node_time_seconds * 1000 - Date.now() : null,
				sysUptimeS: sysUp,
				mjUptimeS: mjUp,
				// null, not 0, when the gauge is absent. A camera whose majestic
				// does not publish these is not a camera reporting day with the
				// filter closed, and anything reasoning about day/night has to be
				// able to tell those apart.
				night: ('night_enabled' in v) ? (v.night_enabled | 0) : null,
				ircut: ('ircut_enabled' in v) ? (v.ircut_enabled | 0) : null,
				light: ('light_enabled' in v) ? (v.light_enabled | 0) : null,
				rx: m.rx, tx: m.tx, m,
				// Consumers do their own counter deltas (net, venc bytes, md rects)
				// against this snapshot; CPU% is computed here because its state
				// belongs with the poll loop (see startHeartbeat).
				prev: prev ? { t: prev.t, rx: prev.m.rx, tx: prev.m.tx, v: prev.m.v } : null,
			};
			mjPrevSample = { t: t, mono: mono, m: m };
			renderTopbar(s);
			mjMetricsPublish(s);
		})
		.catch(() => {
			mjFails++;
			mjMetricsPublish({ ok: false, fails: mjFails });
		})
		.finally(() => {
			clearTimeout(to);
			// Re-arm once the poll has settled. The old `.then(setTimeout(...))`
			// ran setTimeout immediately and passed .then the timer id, so ticks
			// were scheduled 2s apart no matter how long the fetch took — they
			// piled up on exactly the busy camera that could least afford it.
			if (!heartbeatStopped)
				heartbeatTimer = setTimeout(heartbeat, 2000);
		});
}

// ---------------------------------------------------------------------------
// The behaviour layer bootstrap.bundle.min.js used to provide. The bundle was
// 80 KB of framework serving four modals, a handful of nav dropdowns, the
// navbar toggler and dismissable alerts — this is those four behaviours in
// plain JS against the same markup, so the purged Bootstrap CSS keeps styling
// everything. Modals are native <dialog>s now (Escape, focus and centring come
// from the platform); page code still says bootstrap.Modal.getOrCreateInstance
// and still listens for 'hidden.bs.modal', so only the markup changed.

(function () {
	const instances = new Map();
	function Modal(el) {
		this._el = el;
		// <dialog> fires 'close' for Escape, dismiss buttons and hide() alike;
		// re-broadcast it under the name page code already listens for.
		el.addEventListener('close', () => el.dispatchEvent(new CustomEvent('hidden.bs.modal')));
		// A click that lands on the dialog element itself is on the backdrop —
		// the dialog has no padding of its own. Only close when the press
		// started there too, or selecting text in an input and releasing
		// outside would throw the modal (and the input) away.
		let pressOnBackdrop = false;
		el.addEventListener('pointerdown', e => { pressOnBackdrop = e.target === el; });
		el.addEventListener('click', e => { if (e.target === el && pressOnBackdrop) el.close(); });
	}
	Modal.prototype.show = function () { if (!this._el.open) this._el.showModal(); };
	Modal.prototype.hide = function () { this._el.close(); };
	Modal.getOrCreateInstance = function (el) {
		const node = typeof el === 'string' ? $(el) : el;
		if (!instances.has(node)) instances.set(node, new Modal(node));
		return instances.get(node);
	};
	window.bootstrap = { Modal: Modal };
})();

// Dropdowns: delegated, one open at a time, outside click or Escape closes.
// data-bs-popper="static" switches on the pure-CSS placement rules that
// Bootstrap itself uses when it skips Popper in navbars — which is every
// dropdown this UI has.
(function () {
	function closeMenus() {
		$$('.dropdown-menu.show').forEach(m => {
			m.classList.remove('show');
			const t = m.parentElement.querySelector('[data-bs-toggle="dropdown"]');
			if (t) { t.classList.remove('show'); t.setAttribute('aria-expanded', 'false'); }
		});
	}
	document.addEventListener('click', e => {
		const t = e.target.closest('[data-bs-toggle="dropdown"]');
		if (!t) { closeMenus(); return; }
		e.preventDefault();
		const menu = t.parentElement.querySelector('.dropdown-menu');
		if (!menu) return;
		const open = !menu.classList.contains('show');
		closeMenus();
		if (open) {
			menu.setAttribute('data-bs-popper', 'static');
			menu.classList.add('show');
			t.classList.add('show');
		}
		t.setAttribute('aria-expanded', String(open));
	});
	// Keyboard parity with the Bootstrap dropdown this replaces: arrows walk
	// the enabled items (down from the toggle enters at the top, up enters at
	// the bottom), ends clamp, Escape closes and hands focus back to the
	// toggle it came from.
	document.addEventListener('keydown', e => {
		const menu = $('.dropdown-menu.show');
		if (!menu) return;
		if (e.key === 'Escape') {
			const t = menu.parentElement.querySelector('[data-bs-toggle="dropdown"]');
			closeMenus();
			if (t) t.focus();
			return;
		}
		if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
		e.preventDefault();
		const items = Array.from(menu.querySelectorAll('.dropdown-item:not(.disabled)'));
		if (!items.length) return;
		const cur = items.indexOf(document.activeElement);
		let next;
		if (cur === -1) next = e.key === 'ArrowDown' ? 0 : items.length - 1;
		else next = e.key === 'ArrowDown' ? Math.min(cur + 1, items.length - 1) : Math.max(cur - 1, 0);
		items[next].focus();
	});
})();

// Mark the nav entry for the page being viewed. The server emits none: the
// nav is one static block shared by every page, and the hrefs already in the
// DOM are the only list of pages there is. Scoped to #navbarNav so the brand
// logo (also dashboard.cgi) is not marked. A page inside a dropdown lights its
// parent toggle too, or the collapsed menu gives no hint of where you are.
document.addEventListener('DOMContentLoaded', () => {
	const page = location.pathname.split('/').pop() || 'dashboard.cgi';
	$$('#navbarNav a[href]').forEach(a => {
		const href = a.getAttribute('href');
		if (href === '#' || href.includes('://')) return; // toggles, Sign out, openipc.cloud
		if (href.split('?')[0] !== page) return;
		a.classList.add('active');
		a.setAttribute('aria-current', 'page');
		const dd = a.closest('.dropdown');
		if (dd) {
			const t = dd.querySelector('[data-bs-toggle="dropdown"]');
			if (t) t.classList.add('active');
		}
	});
});

// ── notices ────────────────────────────────────────────────────────────
// The marks the .mj-notice component wears, and a builder for the pages that
// assemble a notice in the browser rather than in haserl. They live here
// rather than in each consumer because there are four of those and a severity
// mark that differs between two pages is worse than no mark at all;
// p/common.cgi's `notice` helper emits the same five paths from the shell.
//
// Drawn rather than typed. The glyphs these replace (&#9888;, &#8505;) paint
// whatever size and weight the font decided, which is how the Dashboard ended
// up with a 13x12px severity mark beside a 16x16px close button.
const MJ_NOTICE_ICONS = {
	danger: '<circle cx="12" cy="12" r="8.7"/><path d="M12 7.6v5"/><path d="M12 16.3h.01"/>',
	warn: '<path d="M12 4.6 21.2 19.4H2.8z"/><path d="M12 10.2v4"/><path d="M12 17.1h.01"/>',
	info: '<circle cx="12" cy="12" r="8.7"/><path d="M12 11.2v5.2"/><path d="M12 7.7h.01"/>',
	ok: '<circle cx="12" cy="12" r="8.7"/><path d="m8.3 12.3 2.6 2.6 4.9-5.3"/>',
};

function mjNoticeIcon(sev) {
	return '<svg class="mj-notice-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
		'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
		(MJ_NOTICE_ICONS[sev] || MJ_NOTICE_ICONS.info) + '</svg>';
}

// mjNotice('danger', '<b>Title</b> \u2014 sentence.',
//          {acts: '<a class="btn btn-sm btn-primary" href="network.cgi">Fix it</a>'})
// returns the notice's outer HTML as a string, because every caller here is
// building innerHTML for a container it owns.
//
// The action is a button and carries no arrow: btn-primary for the page that
// fixes this, btn-secondary for a second destination beside it, and
// btn-danger only where pressing acts on the camera rather than going
// somewhere -- that class is what this file hangs a confirm() off, so it must
// not be spent on navigation. p/common.cgi's `notice` states the rule in full
// and tests/notice.test.js holds it across every call site in the tree.
function mjNotice(sev, html, opts) {
	const o = opts || {};
	return '<div class="mj-notice mj-notice-' + sev + '"' +
		(o.id ? ' id="' + o.id + '"' : '') + ' role="alert">' +
		mjNoticeIcon(sev) +
		'<div class="mj-notice-txt">' + html +
		(o.body ? '<div class="mj-notice-body">' + o.body + '</div>' : '') + '</div>' +
		(o.acts ? '<span class="mj-notice-acts">' + o.acts + '</span>' : '') +
		(o.dismiss ? '<button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>' : '') +
		'</div>';
}

// Navbar toggler (the only collapse) and dismissable pieces. The slide
// animation is gone with the bundle; the toggle is instant.
document.addEventListener('click', e => {
	const c = e.target.closest('[data-bs-toggle="collapse"]');
	if (c) {
		const target = $(c.getAttribute('data-bs-target') || c.getAttribute('href'));
		if (target) {
			const open = target.classList.toggle('show');
			c.classList.toggle('collapsed', !open);
			c.setAttribute('aria-expanded', String(open));
		}
		return;
	}
	const d = e.target.closest('[data-bs-dismiss]');
	if (d) {
		const what = d.getAttribute('data-bs-dismiss');
		// .mj-notice as well as .alert: the notice component replaced the filled
		// block on every page banner, and a dismiss that closes only .alert is
		// an inert x on all of them.
		if (what === 'alert') { const a = d.closest('.alert, .mj-notice'); if (a) a.remove(); }
		else if (what === 'modal') { const dlg = d.closest('dialog'); if (dlg) dlg.close(); }
	}
});

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
	// Guarded on the spans so only stream-urls.cgi pays for the config fetch;
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

	localClock();
	heartbeat();
}

window.addEventListener('load', initAll);
