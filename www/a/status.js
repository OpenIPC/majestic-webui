// Live status dashboard: parses majestic /metrics + /api/v1/config.json client-side.
(function () {
	const POLL = 2000, HISTORY = 60;
	let prev = null, fails = 0;
	const sparks = {};

	function parseMetrics(text) {
		const m = {
			cpuIdle: 0, cpuTotal: 0, rx: 0, tx: 0,
			memTotal: 0, memAvail: 0, temp: null, load1: null,
			hls: 0, night: 0, ircut: 0, nodeTime: 0, nodeBoot: 0,
		};
		const lines = text.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const ln = lines[i];
			if (!ln || ln.charCodeAt(0) === 35) continue;
			const sp = ln.lastIndexOf(' ');
			if (sp < 0) continue;
			const key = ln.slice(0, sp), val = +ln.slice(sp + 1);
			if (isNaN(val)) continue;
			if (key.charCodeAt(0) === 110) { // 'n' — node_*
				if (key.startsWith('node_cpu_seconds_total')) {
					m.cpuTotal += val;
					if (key.indexOf('mode="idle"') >= 0) m.cpuIdle += val;
				} else if (key.startsWith('node_network_receive_bytes_total')) {
					if (key.indexOf('device="lo"') < 0) m.rx += val;
				} else if (key.startsWith('node_network_transmit_bytes_total')) {
					if (key.indexOf('device="lo"') < 0) m.tx += val;
				} else if (key === 'node_memory_MemTotal_bytes') m.memTotal = val;
				else if (key === 'node_memory_MemAvailable_bytes') m.memAvail = val;
				else if (key === 'node_hwmon_temp_celsius') m.temp = val;
				else if (key === 'node_load1') m.load1 = val;
				else if (key === 'node_time_seconds') m.nodeTime = val;
				else if (key === 'node_boot_time_seconds') m.nodeBoot = val;
			} else if (key === 'hls_clients_total') m.hls = val;
			else if (key === 'night_enabled') m.night = val;
			else if (key === 'ircut_enabled') m.ircut = val;
		}
		return m;
	}

	function humanRate(bps) {
		const b = bps * 8;
		if (b >= 1e6) return (b / 1e6).toFixed(1) + ' Mbit/s';
		if (b >= 1e3) return (b / 1e3).toFixed(0) + ' kbit/s';
		return Math.max(0, b | 0) + ' bit/s';
	}
	function uptimeStr(s) {
		s = Math.max(0, s | 0);
		const d = (s / 86400) | 0, h = ((s % 86400) / 3600) | 0, m = ((s % 3600) / 60) | 0;
		return (d ? d + 'd ' : '') + (h || d ? h + 'h ' : '') + m + 'm';
	}
	function setBar(id, pct, warn, danger) {
		const el = $(id); if (!el) return;
		el.style.width = Math.max(0, Math.min(100, pct)) + '%';
		el.className = 'progress-bar' + (pct >= danger ? ' bg-danger' : pct >= warn ? ' bg-warning' : '');
	}

	function makeSpark(id, color, lo, hi) {
		const el = $(id);
		if (!el || !window.uPlot) return null;
		const data = [[], []];
		const u = new uPlot({
			width: el.clientWidth || 200, height: 38,
			cursor: { show: false }, legend: { show: false },
			scales: { x: { time: false }, y: { range: (s, dmin, dmax) => [lo != null ? lo : dmin, hi != null ? hi : dmax] } },
			axes: [{ show: false }, { show: false }],
			series: [{}, { stroke: color, width: 1.5, fill: color + '22', points: { show: false } }],
		}, data, el);
		return { u: u, data: data };
	}
	function pushSpark(s, y) {
		if (!s) return;
		const xs = s.data[0], ys = s.data[1];
		xs.push(xs.length); ys.push(y);
		if (xs.length > HISTORY) { xs.shift(); ys.shift(); for (let i = 0; i < xs.length; i++) xs[i] = i; }
		s.u.setData(s.data);
	}

	function badge(level, text) {
		const el = $('#st-badge'); if (!el) return;
		const cls = { ok: 'success', warn: 'warning', crit: 'danger', stale: 'secondary' }[level];
		el.className = 'badge rounded-pill text-bg-' + cls;
		el.textContent = text;
	}

	function tick() {
		fetch('/metrics', { credentials: 'same-origin' })
			.then(r => r.ok ? r.text() : Promise.reject(r.status))
			.then(text => {
				fails = 0;
				const m = parseMetrics(text), now = m.nodeTime || (Date.now() / 1000);
				let cpu = null;
				if (prev && m.cpuTotal > prev.cpuTotal) {
					const dt = m.cpuTotal - prev.cpuTotal, di = m.cpuIdle - prev.cpuIdle;
					cpu = Math.max(0, Math.min(100, (1 - di / dt) * 100));
				}
				const ram = m.memTotal ? (1 - m.memAvail / m.memTotal) * 100 : null;

				if (cpu != null) { $('#st-cpu').textContent = cpu.toFixed(0); setBar('#bar-cpu', cpu, 75, 90); pushSpark(sparks.cpu, cpu); }
				if (ram != null) {
					$('#st-ram').textContent = ram.toFixed(0); setBar('#bar-ram', ram, 75, 90); pushSpark(sparks.ram, ram);
					$('#st-ram-mb').textContent = (((m.memTotal - m.memAvail) / 1048576) | 0) + ' / ' + ((m.memTotal / 1048576) | 0) + ' MB';
				}
				if (m.temp != null) {
					$('#st-temp').textContent = m.temp.toFixed(0); setBar('#bar-temp', m.temp / 90 * 100, 72, 89); pushSpark(sparks.temp, m.temp);
				}
				if (m.load1 != null) $('#st-load').textContent = m.load1.toFixed(2);
				if (m.nodeBoot) $('#st-uptime').textContent = uptimeStr(now - m.nodeBoot);
				$('#st-hls').textContent = m.hls | 0;
				$('#st-daynight').textContent = (m.night ? '🌙 Night' : '☀️ Day') + ' · IR-cut ' + (m.ircut ? 'on' : 'off');

				if (prev) {
					const dt = now - prev.t;
					if (dt > 0) {
						$('#st-rx').textContent = humanRate((m.rx - prev.rx) / dt);
						$('#st-tx').textContent = humanRate((m.tx - prev.tx) / dt);
						pushSpark(sparks.net, Math.max(0, (m.tx - prev.tx) / dt * 8 / 1e6));
					}
				}
				prev = { t: now, cpuIdle: m.cpuIdle, cpuTotal: m.cpuTotal, rx: m.rx, tx: m.tx };

				const t = m.temp || 0;
				if (t >= 85 || (ram != null && ram >= 97)) badge('crit', 'Critical');
				else if (t >= 70 || (ram != null && ram >= 90) || (cpu != null && cpu >= 92)) badge('warn', 'Warning');
				else badge('ok', 'All systems OK');
			})
			.catch(() => { if (++fails >= 2) badge('stale', 'Updating…'); });
	}

	function renderStreams() {
		if (typeof mjConfig !== 'function') return;
		mjConfig().then(cfg => {
			const host = $('#streams'); if (!host) return;
			let html = '';
			['video0', 'video1'].forEach((s, i) => {
				if (mjGet(cfg, s + '.enabled') !== true) return;
				const codec = (mjGet(cfg, s + '.codec') || '?').toUpperCase();
				const size = mjGet(cfg, s + '.size') || '?';
				const fps = mjGet(cfg, s + '.fps');
				const br = mjGet(cfg, s + '.bitrate');
				html += '<div class="d-flex align-items-center">'
					+ '<span class="badge text-bg-primary me-2">' + (i ? 'Sub' : 'Main') + '</span>'
					+ '<span class="fw-semibold me-2">' + size + '</span>'
					+ '<span class="badge text-bg-light border me-2">' + codec + '</span>'
					+ '<span class="text-secondary small ms-auto">' + (fps ? fps + ' fps' : '') + (br ? ' · ' + br + ' kbit/s' : '') + '</span>'
					+ '</div>';
			});
			if (mjGet(cfg, 'jpeg.enabled') === true)
				html += '<div class="d-flex align-items-center"><span class="badge text-bg-secondary me-2">JPEG</span><span class="text-secondary small">snapshots enabled</span></div>';
			host.innerHTML = html || '<div class="text-secondary small">No streams enabled.</div>';
		});
	}

	function init() {
		sparks.cpu = makeSpark('#spark-cpu', '#4c60d8', 0, 100);
		sparks.ram = makeSpark('#spark-ram', '#4c60d8', 0, 100);
		sparks.temp = makeSpark('#spark-temp', '#d87f4c', null, null);
		sparks.net = makeSpark('#spark-net', '#4ca36a', 0, null);
		renderStreams();
		tick();
		setInterval(tick, POLL);
		window.addEventListener('resize', () => {
			for (const k in sparks) if (sparks[k]) {
				const el = sparks[k].u.root.parentNode;
				sparks[k].u.setSize({ width: (el && el.clientWidth) || 200, height: 38 });
			}
		});
	}

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
	else init();
})();
