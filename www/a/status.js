// Live status dashboard. The 2s /metrics poll and its parser live in main.js
// (one heartbeat for every page); this file subscribes via mjMetricsSubscribe
// and only renders. Configured stream facts come from /api/v1/config.json.
(function () {
	const HISTORY = 60;
	const sparks = {};
	let tempAbsent = false;
	let cfgFps0 = null;
	let mdEnabled = false;
	let ispEls = null;    // metric name → value <span>, built on the first good sample
	const ispSparks = {}; // metric name → sparkline in the same row
	let motionEl = null;
	let motionSpark = null;
	let lastV = null;
	let wifiEls = null;   // like ispEls, for the Network card's Wi-Fi block
	const wifiSparks = {};

	function humanRate(bps) {
		const b = bps * 8;
		if (b >= 1e6) return (b / 1e6).toFixed(1) + ' Mbit/s';
		if (b >= 1e3) return (b / 1e3).toFixed(0) + ' kbit/s';
		return Math.max(0, b | 0) + ' bit/s';
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
		const el = typeof id === 'string' ? $(id) : id;
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

	// The Imaging card shows what this SoC's ISP actually reports and nothing
	// else — the isp_* set is vendor-shaped (only again/dgain are universal) and
	// the values are raw SDK units, deliberately not converted: they are not
	// comparable across vendors and any unit would be a guess. Rows are created
	// once, on the first good sample (the metric set is fixed per firmware
	// build); only values update after that.
	const ISP_ROWS = [
		['isp_exptime', 'Exposure time'],
		['isp_exposure', 'Exposure'],
		['isp_again', 'Analog gain'],
		['isp_dgain', 'Digital gain'],
		['isp_ispdgain', 'ISP gain'],
		['isp_tgain', 'Total gain'],
		['isp_rgain', 'WB red gain'],
		['isp_bgain', 'WB blue gain'],
		['isp_avelum', 'Scene luminance'],
		['isp_afmetrics', 'Focus metric'],
		['isp_fps', 'Sensor fps'],
	];

	// One row: label dt, then a dd holding the value beside a mini sparkline —
	// the same trace the health strip draws, sized to the row. The spark is what
	// makes a slow AE hunt, a gain creep or a sagging Wi-Fi link visible at
	// all: the instantaneous number looks the same every tick. Returns the
	// value span; the spark is registered under `key` in `sparks`.
	function sparkRow(host, label, sparks, key) {
		const dt = document.createElement('dt'); dt.textContent = label;
		const dd = document.createElement('dd');
		dd.className = 'd-flex align-items-center gap-2';
		const val = document.createElement('span'); val.textContent = '–';
		const sp = document.createElement('span'); sp.className = 'spark spark-row';
		dd.appendChild(val); dd.appendChild(sp);
		host.appendChild(dt); host.appendChild(dd);
		sparks[key] = makeSpark(sp, '#8a5cd8', null, null);
		return val;
	}

	function buildImaging(v) {
		const host = $('#st-isp'); if (!host) return;
		host.textContent = '';
		ispEls = {};
		motionEl = null;
		motionSpark = null;
		ISP_ROWS.forEach(row => {
			if (!(row[0] in v)) return;
			ispEls[row[0]] = sparkRow(host, row[1], ispSparks, row[0]);
		});
		if (mdEnabled && 'md_rects_recv_total' in v) {
			motionEl = sparkRow(host, 'Motion', ispSparks, 'md');
			motionSpark = ispSparks.md;
			motionEl.parentElement.title = 'Rectangles the motion detector reported per second, and how many fell inside the ROI';
		}
		if (!host.children.length)
			// A div, not a bare dd: a dl accepts div children, while a dd
			// without a dt is invalid structure (same for the server-rendered
			// "loading…" placeholder this replaces).
			host.appendChild(el('div', 'text-secondary', 'This SoC reports no ISP metrics.'));
	}

	// The Wi-Fi block in the Network card. Gauges are shown with their units;
	// the two counters are shown as per-second rates — a cumulative retry
	// total says nothing, a retry *rate* climbing with a sagging RSSI is the
	// whole "why is my connection bad" story. The grade line translates dBm
	// into words for the person who has never seen one.
	const WIFI_GAUGES = [
		['wifi_rssi_dbm', 'Signal', ' dBm'],
		['wifi_snr_db', 'SNR', ' dB'],
		['wifi_link_quality_ratio', 'Quality', ' %'],
		['wifi_bitrate_mbps', 'Bitrate', ' Mb/s'],
	];
	const WIFI_RATES = [
		['wifi_retries_total', 'Retries', '/s'],
		['wifi_missed_beacons_total', 'Missed beacons', '/s'],
	];

	function buildWifi(v) {
		const box = $('#st-wifi'), host = $('#st-wifi-rows');
		if (!box || !host) return;
		// Replace, never append: this reruns when a metric appears late, and
		// the previous row set (and its spark registrations) must go with it.
		host.textContent = '';
		wifiEls = {};
		const rows = WIFI_GAUGES.concat(WIFI_RATES).filter(r => r[0] in v);
		rows.forEach(r => { wifiEls[r[0]] = sparkRow(host, r[1], wifiSparks, r[0]); });
		box.hidden = !rows.length;
	}

	function wifiGrade(v) {
		const el = $('#st-wifi-grade'); if (!el) return;
		let grade = null;
		if ('wifi_rssi_dbm' in v) {
			const r = v.wifi_rssi_dbm;
			grade = r >= -60 ? ['good', 'text-success']
				: r >= -75 ? ['fair', 'text-warning']
				: ['weak — move the camera or the AP', 'text-danger'];
		} else if ('wifi_link_quality_ratio' in v) {
			const q = v.wifi_link_quality_ratio;
			grade = q >= 70 ? ['good', 'text-success']
				: q >= 40 ? ['fair', 'text-warning']
				: ['weak — move the camera or the AP', 'text-danger'];
		}
		el.textContent = grade ? grade[0] : '';
		el.className = grade ? grade[1] : '';
	}

	function updateWifi(s, v) {
		const has = WIFI_GAUGES.concat(WIFI_RATES).some(r => r[0] in v);
		if (!wifiEls) buildWifi(v);
		// The row set is not frozen at first sight: a camera on Ethernet builds
		// the block empty and a Wi-Fi link arriving later must fill it, and a
		// gauge missing from the first Wi-Fi sample (the RSSI, while the link
		// re-associates) needs its row created when it first reports. Rebuild
		// whenever a known metric is present but has no row yet.
		else if (has && WIFI_GAUGES.concat(WIFI_RATES).some(r => (r[0] in v) && !wifiEls[r[0]]))
			buildWifi(v);
		if (!wifiEls || !Object.keys(wifiEls).length) return;
		// ...and the reverse: a block that exists hides again when the metrics
		// vanish (interface down), instead of overwriting its rows with the
		// "undefined dBm" a missing key would format to.
		const box = $('#st-wifi');
		if (box) box.hidden = !has;
		if (!has) return;
		WIFI_GAUGES.forEach(r => {
			const rowEl = wifiEls[r[0]];
			if (!rowEl) return;
			if (r[0] in v) {
				rowEl.textContent = v[r[0]] + r[2];
				pushSpark(wifiSparks[r[0]], v[r[0]]);
			} else {
				// A single gauge can go missing on its own — the RSSI does
				// while the link re-associates, since the collector refuses a
				// non-negative reading.
				rowEl.textContent = '–';
			}
		});
		if (s.prev && s.dt > 0) WIFI_RATES.forEach(r => {
			const rowEl = wifiEls[r[0]];
			if (!rowEl) return;
			if (r[0] in v && r[0] in s.prev.v) {
				const rate = Math.max(0, (v[r[0]] - s.prev.v[r[0]]) / s.dt);
				rowEl.textContent = rate.toFixed(1) + r[2];
				pushSpark(wifiSparks[r[0]], rate);
			} else {
				rowEl.textContent = '–';
			}
		});
		wifiGrade(v);
	}

	function onSample(s) {
		if (!s.ok) {
			if (s.fails >= 2) badge('stale', 'Updating…');
			return;
		}
		const v = s.m.v;
		lastV = v;
		if (!ispEls) buildImaging(v);

		if (s.cpu != null) {
			$('#st-cpu').textContent = s.cpu.toFixed(0);
			setBar('#bar-cpu', s.cpu, 75, 90);
			pushSpark(sparks.cpu, s.cpu);
		}
		if (s.memPct != null) {
			$('#st-ram').textContent = s.memPct.toFixed(0);
			setBar('#bar-ram', s.memPct, 75, 90);
			pushSpark(sparks.ram, s.memPct);
			$('#st-ram-mb').textContent = (((s.memTotal - s.memAvail) / 1048576) | 0) + ' / ' + ((s.memTotal / 1048576) | 0) + ' MB';
		}
		if (s.temp != null) {
			$('#st-temp').textContent = s.temp.toFixed(0);
			setBar('#bar-temp', s.temp / 90 * 100, 72, 89);
			pushSpark(sparks.temp, s.temp);
		} else if (!tempAbsent) {
			// Not every SoC can say — the Ingenic T31 exposes no temperature at
			// all — so state that once instead of showing "–" forever.
			tempAbsent = true;
			$('#st-temp').textContent = 'n/a';
			$('#st-temp-u').hidden = true;
			$('#st-temp-meter').hidden = true;
			$('#spark-temp').hidden = true;
			$('#st-temp-note').textContent = 'no temperature sensor on this SoC';
		}
		if ('node_load1' in v) $('#st-load').textContent = v.node_load1.toFixed(2);
		if (s.sysUptimeS != null) $('#st-uptime').textContent = uptimeStr(s.sysUptimeS);
		$('#st-uptime-mj').textContent = s.mjUptimeS != null ? uptimeStr(s.mjUptimeS) : '–';
		$('#st-hls').textContent = v.hls_clients_total | 0;

		$('#st-daynight').textContent = (s.night ? '🌙 Night' : '☀️ Day') + ' · IR-cut ' + (s.ircut ? 'on' : 'off');
		$('#st-light').hidden = !s.light;
		// Only SigmaStar reports the empty-wakeup run; a sustained one means the
		// encoder has stopped producing frames while everything else looks alive.
		$('#st-stall').hidden = !(v.venc_empty_frames_run > 25);
		$('#st-isp-warn').hidden = !(v.isp_exposureismax > 0);

		if (s.prev && s.dt > 0) {
			$('#st-rx').textContent = humanRate(Math.max(0, (s.rx - s.prev.rx) / s.dt));
			$('#st-tx').textContent = humanRate(Math.max(0, (s.tx - s.prev.tx) / s.dt));
			pushSpark(sparks.net, Math.max(0, (s.tx - s.prev.tx) / s.dt * 8 / 1e6));

			// Measured encoder output next to the configured figure. venc0 is the
			// main stream on every vendor; venc1 renders as soon as a majestic
			// that exports it is installed. A counter still at 0 means this
			// SoC's byte accounting is absent, not a silent encoder — printing
			// "measured 0 bit/s" over a dead counter would read as an outage.
			for (let i = 0; i < 2; i++) {
				const brEl = $('#st-br' + i), key = 'venc' + i + '_rcvd_bytes';
				if (!brEl) continue;
				// Cleared, not skipped, when no valid delta exists: a daemon
				// restart resets or removes the counter, and a skipped update
				// would leave the last rate on screen indefinitely.
				brEl.textContent = v[key] && (key in s.prev.v)
					? ' · measured ' + humanRate(Math.max(0, (v[key] - s.prev.v[key]) / s.dt))
					: '';
			}

			if (motionEl && 'md_rects_recv_total' in s.prev.v) {
				const r = Math.max(0, (v.md_rects_recv_total - s.prev.v.md_rects_recv_total) / s.dt);
				const a = Math.max(0, ((v.md_rects_acc_total || 0) - (s.prev.v.md_rects_acc_total || 0)) / s.dt);
				motionEl.textContent = r.toFixed(1) + '/s · ' + a.toFixed(1) + ' in ROI';
				pushSpark(motionSpark, r);
			}
		}

		if (ispEls) Object.keys(ispEls).forEach(k => {
			ispEls[k].textContent = k === 'isp_fps' && cfgFps0
				? v[k] + ' (set ' + cfgFps0 + ')' : String(v[k]);
			pushSpark(ispSparks[k], v[k]);
		});

		updateWifi(s, v);

		const t = s.temp || 0;
		if (t >= 85 || (s.memPct != null && s.memPct >= 97)) badge('crit', 'Critical');
		else if (t >= 70 || (s.memPct != null && s.memPct >= 90) || (s.cpu != null && s.cpu >= 92)) badge('warn', 'Warning');
		else badge('ok', 'All systems OK');
	}

	// One element per value, textContent throughout — these strings come from
	// the camera's config, and device-derived text must never reach innerHTML:
	// a hand-edited majestic.yaml would otherwise inject markup into the page.
	function el(tag, cls, text) {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text != null) e.textContent = text;
		return e;
	}

	function renderStreams() {
		if (typeof mjConfig !== 'function') return;
		mjConfig().then(cfg => {
			cfgFps0 = mjGet(cfg, 'video0.fps') || null;
			mdEnabled = mjGet(cfg, 'motionDetect.enabled') === true;
			// The config may resolve after the first sample already built the
			// Imaging card without its Motion row — rebuild against the last
			// sample now that mdEnabled is known.
			if (lastV) buildImaging(lastV);
			const host = $('#streams'); if (!host) return;
			host.textContent = '';
			['video0', 'video1'].forEach((sname, i) => {
				if (mjGet(cfg, sname + '.enabled') !== true) return;
				const codec = String(mjGet(cfg, sname + '.codec') || '?').toUpperCase();
				const size = mjGet(cfg, sname + '.size') || '?';
				const fps = mjGet(cfg, sname + '.fps');
				const br = mjGet(cfg, sname + '.bitrate');
				const row = el('div');
				row.appendChild(el('span', 'badge text-bg-primary me-2', i ? 'Sub' : 'Main'));
				row.appendChild(el('span', 'fw-semibold me-1', size));
				row.appendChild(el('span', 'badge text-bg-light border', codec));
				const sub = el('div', 'x-small text-secondary mt-1',
					(fps ? fps + ' fps' : '') + (br ? ' · ' + br + ' kbit/s' : ''));
				const meas = el('span');
				meas.id = 'st-br' + i;
				sub.appendChild(meas);
				row.appendChild(sub);
				host.appendChild(row);
			});
			if (mjGet(cfg, 'jpeg.enabled') === true) {
				const row = el('div', 'd-flex align-items-center');
				row.appendChild(el('span', 'badge text-bg-secondary me-2', 'JPEG'));
				row.appendChild(el('span', 'text-secondary small', 'snapshots enabled'));
				host.appendChild(row);
			}
			if (!host.children.length)
				host.appendChild(el('div', 'text-secondary small', 'No streams enabled.'));
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
		// main.js is loaded without defer, so the registry exists; the poll is
		// started by initAll on window load.
		mjMetricsSubscribe(onSample);
		// SVG sparklines stretch to their container automatically — no resize redraw.
	}

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
	else init();
})();
