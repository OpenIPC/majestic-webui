// Live log viewer for info-logs.cgi.
// Streams majestic's /ws/logs WebSocket (a single `logread -f` over which klogd
// has already merged kernel + application logs) and renders it with a source
// selector, free-text filter, pause, clear and download. Vanilla JS, no deps.
//
// The buffer holds raw syslog lines; timestamps are converted to the viewer's
// timezone only at render time (see fmtLine), so filtering and severity classing
// keep working on the untouched wire format.
(function () {
	const MAX_LINES = 2000;
	const el = $('#log');
	const elSource = $('#log-source');
	const elFilter = $('#log-filter');
	const elPause = $('#log-pause');
	const elClear = $('#log-clear');
	const elDownload = $('#log-download');

	const lines = []; // ring buffer of raw syslog lines
	let paused = false;

	// Each syslog line is: "<Mon DD HH:MM:SS> <host> <facility>.<severity> <prog>[pid]: msg"
	const SOURCES = {
		all: () => true,
		majestic: l => /\bmajestic[[:]/.test(l),
		kernel: l => /\bkernel:|\bkern\./.test(l),
	};
	function matches(l) {
		const src = SOURCES[elSource.value] || SOURCES.all;
		if (!src(l)) return false;
		const q = elFilter.value.trim().toLowerCase();
		return !q || l.toLowerCase().includes(q);
	}

	function sevClass(l) {
		const m = l.match(/^\S+\s+\d+\s+\S+\s+\S+\s+\w+\.(\w+)\s/);
		switch (m && m[1]) {
			case 'emerg': case 'alert': case 'crit': case 'err':
				return 'log-err';
			case 'warning': case 'warn':
				return 'log-warn';
			case 'debug':
				return 'log-debug';
			default:
				return '';
		}
	}

	// syslogd formats every line with ctime() in its own timezone and stores only
	// the resulting string (busybox sysklogd/syslogd.c), discarding the time_t --
	// so the stamp arrives device-local with no year and no zone, and nothing
	// downstream can re-zone it unaided. j/logmeta.cgi supplies both missing
	// halves: the offset syslogd is actually running under, and the camera clock
	// the year is inferred from. Until it answers, lines render as they arrive.
	const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const TS_RE = /^(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+/;
	let tzOffsetMs = null; // null until logmeta.cgi answers
	let deviceSkewMs = 0;  // device epoch - browser epoch

	function fmtLine(raw) {
		if (tzOffsetMs === null) return raw;
		const m = TS_RE.exec(raw);
		if (!m) return raw;
		const mon = MONTHS.indexOf(m[1]);
		if (mon < 0) return raw;
		// The fields are device-local wall clock; Date.UTC reads them as UTC, so
		// subtracting the offset lands on the true instant.
		const deviceNow = Date.now() + deviceSkewMs;
		const year = new Date(deviceNow + tzOffsetMs).getUTCFullYear();
		let ms = Date.UTC(year, mon, +m[2], +m[3], +m[4], +m[5]) - tzOffsetMs;
		// No year in the wire format, so every January a December line looks like
		// the future. More than a day ahead of the camera's own clock means it
		// belongs to last year.
		if (ms > deviceNow + 86400000)
			ms = Date.UTC(year - 1, mon, +m[2], +m[3], +m[4], +m[5]) - tzOffsetMs;
		// Only the stamp is replaced; host, facility.severity and the message stay
		// exactly as syslogd wrote them.
		return new Date(ms).toLocaleString() + ' ' + raw.slice(m[0].length);
	}

	fetch('/cgi-bin/j/logmeta.cgi').then(r => r.json()).then(meta => {
		tzOffsetMs = parseTzOffsetMs(meta.tz_offset); // main.js
		deviceSkewMs = (Number(meta.time_now) * 1000) - Date.now();
		render(); // redraw whatever arrived while this was in flight
	}).catch(() => {});

	function atBottom() {
		return el.scrollHeight - el.clientHeight - el.scrollTop < 4;
	}
	function makeRow(l) {
		const d = document.createElement('div');
		// Severity is read off the *raw* line: sevClass counts whitespace-separated
		// tokens, and a localised stamp ("8/12/2026, 6:52:37 PM") has a different
		// shape, so classing the formatted string would silently match nothing.
		d.className = 'log-line ' + sevClass(l);
		d.textContent = fmtLine(l);
		return d;
	}
	function render() {
		const stick = atBottom();
		el.textContent = '';
		const frag = document.createDocumentFragment();
		for (const l of lines) if (matches(l)) frag.appendChild(makeRow(l));
		el.appendChild(frag);
		if (stick) el.scrollTop = el.scrollHeight;
	}
	function pushLine(l) {
		lines.push(l);
		if (lines.length > MAX_LINES) lines.shift();
		if (paused || !matches(l)) return;
		const stick = atBottom();
		el.appendChild(makeRow(l));
		while (el.childElementCount > MAX_LINES) el.removeChild(el.firstChild);
		if (stick) el.scrollTop = el.scrollHeight;
	}

	const proto = location.protocol === 'https:' ? 'wss' : 'ws';
	const ws = new WebSocket(proto + '://' + location.host + '/ws/logs');
	ws.binaryType = 'arraybuffer';
	const dec = new TextDecoder('utf-8');
	let partial = '';
	ws.onmessage = e => {
		const parts = (partial + dec.decode(new Uint8Array(e.data), { stream: true })).split('\n');
		partial = parts.pop();
		for (const p of parts) if (p) pushLine(p);
	};
	ws.onclose = () => pushLine('--- log stream closed ---');
	ws.onerror = () => pushLine('--- connection error ---');

	elSource.addEventListener('change', render);
	elFilter.addEventListener('input', render);
	elPause.addEventListener('click', () => {
		paused = !paused;
		elPause.textContent = paused ? '▶ Resume' : '⏸ Pause';
		if (!paused) render();
	});
	elClear.addEventListener('click', () => { lines.length = 0; render(); });
	elDownload.addEventListener('click', () => {
		// What is on screen, not the raw buffer -- the raw form is what `logread`
		// over SSH already gives you.
		const blob = new Blob([lines.map(l => fmtLine(l)).join('\n') + '\n'], { type: 'text/plain' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = 'majestic-logs.txt';
		a.click();
		URL.revokeObjectURL(a.href);
	});
})();
