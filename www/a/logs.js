// Live log viewer for info-logs.cgi.
// Streams majestic's /ws/logs WebSocket (a single `logread -f` over which klogd
// has already merged kernel + application logs) and renders it with a source
// selector, free-text filter, pause, clear and download. Vanilla JS, no deps.
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

	function atBottom() {
		return el.scrollHeight - el.clientHeight - el.scrollTop < 4;
	}
	function makeRow(l) {
		const d = document.createElement('div');
		d.className = 'log-line ' + sevClass(l);
		d.textContent = l;
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
		const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = 'majestic-logs.txt';
		a.click();
		URL.revokeObjectURL(a.href);
	});
})();
