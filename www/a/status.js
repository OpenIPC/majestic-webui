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

	// Lightweight inline-SVG sparkline (replaces uPlot — same look, ~50 KB less on
	// flash). A single area+line path stretched to the card width via a fixed
	// viewBox + preserveAspectRatio=none; the 1.5px stroke stays crisp through
	// vector-effect, so no per-resize redraw is needed.
	const SVG_NS = 'http://www.w3.org/2000/svg';
	function makeSpark(id, color, lo, hi) {
		const el = $(id);
		if (!el) return null;
		const svg = document.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('viewBox', '0 0 100 38');
		svg.setAttribute('preserveAspectRatio', 'none');
		const fill = document.createElementNS(SVG_NS, 'path');
		fill.setAttribute('fill', color + '22');
		const line = document.createElementNS(SVG_NS, 'path');
		line.setAttribute('fill', 'none');
		line.setAttribute('stroke', color);
		line.setAttribute('stroke-width', '1.5');
		line.setAttribute('stroke-linejoin', 'round');
		line.setAttribute('vector-effect', 'non-scaling-stroke');
		svg.appendChild(fill);
		svg.appendChild(line);
		el.textContent = '';
		el.appendChild(svg);
		return { fill: fill, line: line, lo: lo, hi: hi, ys: [] };
	}
	function pushSpark(s, y) {
		if (!s) return;
		const ys = s.ys;
		ys.push(y);
		if (ys.length > HISTORY) ys.shift();
		const n = ys.length, W = 100, H = 38;
		let lo = s.lo != null ? s.lo : Math.min.apply(null, ys);
		let hi = s.hi != null ? s.hi : Math.max.apply(null, ys);
		if (hi - lo < 1e-9) hi = lo + 1;
		const dx = n > 1 ? W / (n - 1) : 0;
		let d = '';
		for (let i = 0; i < n; i++) {
			let yy = H - ((ys[i] - lo) / (hi - lo)) * H;
			yy = yy < 0 ? 0 : yy > H ? H : yy;
			d += (i ? 'L' : 'M') + (i * dx).toFixed(2) + ' ' + yy.toFixed(2);
		}
		s.line.setAttribute('d', d);
		s.fill.setAttribute('d', n ? d + 'L' + ((n - 1) * dx).toFixed(2) + ' ' + H + 'L0 ' + H + 'Z' : '');
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
				html += '<div>'
					+ '<span class="badge text-bg-primary me-2">' + (i ? 'Sub' : 'Main') + '</span>'
					+ '<span class="fw-semibold me-1">' + size + '</span>'
					+ '<span class="badge text-bg-light border">' + codec + '</span>'
					+ '<div class="x-small text-secondary mt-1">' + (fps ? fps + ' fps' : '') + (br ? ' · ' + br + ' kbit/s' : '') + '</div>'
					+ '</div>';
			});
			if (mjGet(cfg, 'jpeg.enabled') === true)
				html += '<div class="d-flex align-items-center"><span class="badge text-bg-secondary me-2">JPEG</span><span class="text-secondary small">snapshots enabled</span></div>';
			host.innerHTML = html || '<div class="text-secondary small">No streams enabled.</div>';
		});
	}

	function humanKB(kb) {
		return kb >= 1024 ? (kb / 1024).toFixed(kb >= 10240 ? 0 : 1) + ' MB' : (kb | 0) + ' KB';
	}
	function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

	function renderOverlay() {
		const el = $('#overlay-data'); if (!el) return;
		let d; try { d = JSON.parse(el.textContent); } catch (e) { return; }
		const bar = $('#overlay-bar'), leg = $('#overlay-legend');
		if (!bar || !d.total) return;
		const palette = ['#e0544e', '#e08a3c', '#e8c84a', '#4ca36a', '#4c60d8', '#8a5cd8', '#3ca3a3'];
		let cats = (d.cats || []).filter(c => c.kb > 0).sort((a, b) => b.kb - a.kb);
		if (cats.length > 6) {
			const tail = cats.slice(6), sum = tail.reduce((s, c) => s + c.kb, 0);
			cats = cats.slice(0, 6);
			if (sum > 0) cats.push({ name: 'other', kb: sum });
		}
		// du reports uncompressed sizes; df.used is real (compressed) flash usage.
		// Use du only for the relative split, scaled onto the actual used space.
		const sumCats = cats.reduce((s, c) => s + c.kb, 0);
		const scale = sumCats > 0 ? d.used / sumCats : 0;
		const segs = cats.map((c, i) => ({ name: c.name, kb: c.kb * scale, color: palette[i % palette.length] }))
			.filter(s => s.kb >= 1);
		if (!segs.length && d.used > 0) segs.push({ name: 'used', kb: d.used, color: '#7a7a8c' });
		bar.innerHTML = segs.map(s =>
			'<div class="seg" style="width:' + (s.kb / d.total * 100).toFixed(2) + '%;background:' + s.color + '" title="' + cap(s.name) + ' ' + humanKB(s.kb) + '"></div>'
		).join('');
		const free = Math.max(0, d.total - d.used);
		leg.innerHTML = segs.map(s =>
			'<span><i class="dot" style="background:' + s.color + '"></i>' + cap(s.name) + ' <span class="text-secondary">' + humanKB(s.kb) + '</span></span>'
		).join('') + '<span><i class="dot dot-free"></i>Free <span class="text-secondary">' + humanKB(free) + '</span></span>';
	}

	function init() {
		renderOverlay();
		sparks.cpu = makeSpark('#spark-cpu', '#4c60d8', 0, 100);
		sparks.ram = makeSpark('#spark-ram', '#4c60d8', 0, 100);
		sparks.temp = makeSpark('#spark-temp', '#d87f4c', null, null);
		sparks.net = makeSpark('#spark-net', '#4ca36a', 0, null);
		renderStreams();
		tick();
		setInterval(tick, POLL);
		// SVG sparklines stretch to their container automatically — no resize redraw.
	}

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
	else init();
})();
