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

let _mjCfg;
function mjConfig() {
	if (!_mjCfg)
		_mjCfg = fetch('/api/v1/config.json', { credentials: 'same-origin' })
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

async function* makeTextFileLineIterator(url) {
	const td = new TextDecoder('utf-8');
	const response = await fetch(url);
	const rd = response.body.getReader();
	let { value: chunk, done: readerDone } = await rd.read();
	chunk = chunk ? td.decode(chunk) : '';
	const re = /\r?\n/gm;
	let startIndex = 0;
	let result;

	for (;;) {
		result = re.exec(chunk);
		if (!result) {
			if (readerDone) {
				break;
			}

			let remainder = chunk.substr(startIndex);
			({ value: chunk, done: readerDone } = await rd.read());
			chunk = remainder + (chunk ? td.decode(chunk) : '');
			startIndex = re.lastIndex = 0;
			continue;
		}

		yield chunk.substring(startIndex, result.index);
		startIndex = re.lastIndex;
	}

	if (startIndex < chunk.length) {
		yield chunk.substr(startIndex);
	}

	if (el.dataset['reboot'] === "true") {
		location.href = '/cgi-bin/fw-restart.cgi'
	}

	if ($('form input[type=submit]')) {
		$('form input[type=submit]').disabled = false;
	}
}

async function runCmd(msg) {
	for await (let line of makeTextFileLineIterator('/cgi-bin/j/run.cgi?' + msg + '=' + btoa(el.dataset['cmd']))) {
		const regex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
		line = line.replace(regex, '');
		el.innerHTML += line + '\n';
	}
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
	fetch('/cgi-bin/j/pulse.cgi', { signal: ctl.signal })
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
	$$('.btn-danger, .btn-warning, .confirm').forEach(el => {
		// for input, find its parent form and attach listener to it submit event
		if (el.nodeName === "INPUT") {
			while (el.nodeName !== "FORM") el = el.parentNode
			el.addEventListener('submit', ev => (!confirm("Are you sure?")) ? ev.preventDefault() : null)
		} else {
			el.addEventListener('click', ev => (!confirm("Are you sure?")) ? ev.preventDefault() : null)
		}
	});

	$$('.refresh').forEach(el => el.addEventListener('click', refresh));

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
