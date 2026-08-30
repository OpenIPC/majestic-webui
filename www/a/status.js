// Live dashboard. The 2s /metrics poll and its parser live in main.js (one
// heartbeat for every page); this file subscribes via mjMetricsSubscribe and
// only renders. Configured stream facts come from /api/v1/config.json.
//
// Layout contract (the "Signal Wall + Live" design): alerts render first and
// only while active; the KPI strip and every chart panel mount per what this
// camera actually reports; the snapshot tile is a polled /image.jpg — never a
// stream, so the dashboard costs no majestic session slot.
(function () {
	const HISTORY = 60;
	const sparks = {};
	const charts = [];
	let tempAbsent = false;
	let cfgFps0 = null;
	let encSetMbit = null;
	let mdEnabled = false;
	let ispEls = null;    // metric name → value <span>, built on the first good sample
	const ispSparks = {}; // metric name → sparkline in the same row
	let motionEl = null;
	let motionSpark = null;
	let lastV = null;
	let wifiSeen = false;

	// Theme-resolved series colors (--st-c* in bootstrap.override.css). The
	// theme is fixed at page load, so one read suffices.
	const css = getComputedStyle(document.documentElement);
	const C1 = (css.getPropertyValue('--st-c1') || '#4c60d8').trim();
	const C2 = (css.getPropertyValue('--st-c2') || '#0d9488').trim();
	const C4 = (css.getPropertyValue('--st-c4') || '#8a5cd8').trim();
	const GRID = (css.getPropertyValue('--st-grid') || '#e9ebf2').trim();

	function humanRate(bps) {
		const b = bps * 8;
		if (b >= 1e6) return (b / 1e6).toFixed(1) + ' Mbit/s';
		if (b >= 1e3) return (b / 1e3).toFixed(0) + ' kbit/s';
		return Math.max(0, b | 0) + ' bit/s';
	}

	// Lightweight inline-SVG sparkline: a single area+line path stretched to
	// the tile width via a fixed viewBox + preserveAspectRatio=none; the
	// 1.5px stroke stays crisp through vector-effect.
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

	// ── axis charts ─────────────────────────────────────────────────────────
	// Real pixel-space rendering (unlike the stretchy sparklines): text must
	// not distort, so each chart re-renders an SVG at the host's current
	// width on every push and on resize. The window is a fixed 60 samples
	// (~2 min at the 2s poll) anchored at "now" on the right edge; a freshly
	// opened page fills leftward like any live dashboard.
	function niceCeil(x) {
		if (x <= 0) return 1;
		const p = Math.pow(10, Math.floor(Math.log10(x)));
		const m = x / p;
		return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
	}
	function fmtNum(x) {
		return Math.abs(x) >= 100 || x === (x | 0) ? String(Math.round(x)) : x.toFixed(1);
	}

	// cfg: { h, lo, hi (null = auto), ref {v,label}|null, bands [{from,to,
	// color,label}], colors [..], fmt } — series count = colors.length.
	function makeChart(sel, cfg) {
		const host = $(sel);
		if (!host) return null;
		const ch = { host: host, cfg: cfg, data: cfg.colors.map(() => []) };
		charts.push(ch);
		return ch;
	}
	function pushChart(ch, vals) {
		if (!ch) return;
		for (let i = 0; i < ch.data.length; i++) {
			ch.data[i].push(vals[i]);
			if (ch.data[i].length > HISTORY) ch.data[i].shift();
		}
		renderChart(ch);
	}
	function renderChart(ch) {
		if (!ch) return;
		const W = ch.host.clientWidth;
		if (!W) return;
		const cfg = ch.cfg;
		const padL = 30, padR = 6, padT = 5, H = cfg.h, XB = 14;
		const plotW = W - padL - padR;
		const lo = cfg.lo;
		let hi = cfg.hi;
		if (hi == null) {
			let max = 0;
			ch.data.forEach(d => d.forEach(v => { if (v != null && v > max) max = v; }));
			hi = niceCeil(Math.max(max * 1.15, 1));
		}
		const fmt = cfg.fmt || fmtNum;
		const Y = v => {
			let y = padT + (1 - (v - lo) / (hi - lo)) * H;
			return y < padT ? padT : y > padT + H ? padT + H : y;
		};
		const X = (i, n) => padL + plotW - (n - 1 - i) * (plotW / (HISTORY - 1));
		let s = '';
		// threshold bands (Wi-Fi grades, luminance floor) sit under everything
		(cfg.bands || []).forEach(b => {
			const y1 = Y(b.to), y2 = Y(b.from);
			s += '<rect x="' + padL + '" y="' + y1.toFixed(1) + '" width="' + plotW +
				'" height="' + (y2 - y1).toFixed(1) + '" fill="' + b.color + '"/>';
			if (b.label) s += '<text x="' + (padL + plotW - 4) + '" y="' + (y1 + 10).toFixed(1) +
				'" text-anchor="end" opacity="0.8">' + b.label + '</text>';
		});
		// hairline grid at lo / mid / hi, labels on the left
		[lo, (lo + hi) / 2, hi].forEach(t => {
			const y = Y(t);
			s += '<line x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (padL + plotW) +
				'" y2="' + y.toFixed(1) + '" stroke="' + GRID + '" stroke-width="1"/>';
			s += '<text x="' + (padL - 5) + '" y="' + (y + 3.5).toFixed(1) + '" text-anchor="end">' + fmt(t) + '</text>';
		});
		if (cfg.ref && cfg.ref.v > lo && cfg.ref.v < hi) {
			const y = Y(cfg.ref.v);
			s += '<line x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (padL + plotW) +
				'" y2="' + y.toFixed(1) + '" stroke="' + C1 + '" stroke-width="1" opacity="0.45"/>';
			s += '<text x="' + (padL + plotW - 4) + '" y="' + (y - 4).toFixed(1) + '" text-anchor="end">' + cfg.ref.label + '</text>';
		}
		for (let si = 0; si < ch.data.length; si++) {
			const d = ch.data[si], n = d.length;
			let p = '', started = false;
			for (let i = 0; i < n; i++) {
				if (d[i] == null) { started = false; continue; }
				p += (started ? 'L' : 'M') + X(i, n).toFixed(1) + ' ' + Y(d[i]).toFixed(1);
				started = true;
			}
			if (!p) continue;
			if (ch.data.length === 1)
				s += '<path d="' + p + 'L' + X(n - 1, n).toFixed(1) + ' ' + (padT + H) +
					'L' + (p.slice(1).split(' ')[0]) + ' ' + (padT + H) + 'Z" fill="' + cfg.colors[0] + '1A"/>';
			s += '<path d="' + p + '" fill="none" stroke="' + cfg.colors[si] +
				'" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
		}
		s += '<text x="' + padL + '" y="' + (padT + H + XB - 2) + '">-2 min</text>';
		s += '<text x="' + (padL + plotW) + '" y="' + (padT + H + XB - 2) + '" text-anchor="end">now</text>';
		ch.host.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + (padT + H + XB) +
			'" width="' + W + '" height="' + (padT + H + XB) + '">' + s + '</svg>';
	}

	// ── alerts ──────────────────────────────────────────────────────────────
	function setAlert(id, on) {
		const el = $(id);
		if (el) el.hidden = !on;
		const box = $('#st-alerts');
		if (box) box.hidden = !['#st-alert-stale', '#st-alert-exp', '#st-alert-stall']
			.some(a => { const e = $(a); return e && !e.hidden; });
	}

	// The ISP panel shows what this SoC's ISP actually reports and nothing
	// else — the isp_* set is vendor-shaped (only again/dgain are universal)
	// and values are raw SDK units, deliberately not converted. Scene
	// luminance is charted separately (it feeds the exposure warning), so it
	// is not in the row set.
	const ISP_ROWS = [
		['isp_exptime', 'Exposure time'],
		['isp_exposure', 'Exposure'],
		['isp_again', 'Analog gain'],
		['isp_dgain', 'Digital gain'],
		['isp_ispdgain', 'ISP gain'],
		['isp_tgain', 'Total gain'],
		['isp_rgain', 'WB red gain'],
		['isp_bgain', 'WB blue gain'],
		['isp_histerror', 'Histogram error'],
		['isp_afmetrics', 'Focus metric'],
		['isp_fps', 'Sensor fps'],
	];

	// One row: label dt, then a dd holding the value beside a mini sparkline —
	// what makes a slow AE hunt or a gain creep visible at all.
	function sparkRow(host, label, sparks, key) {
		const dt = document.createElement('dt'); dt.textContent = label;
		const dd = document.createElement('dd');
		dd.className = 'd-flex align-items-center gap-2';
		const val = document.createElement('span'); val.textContent = '–';
		const sp = document.createElement('span'); sp.className = 'spark spark-row';
		dd.appendChild(val); dd.appendChild(sp);
		host.appendChild(dt); host.appendChild(dd);
		sparks[key] = makeSpark(sp, C4, null, null);
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
		const empty = $('#st-isp-empty');
		if (empty) {
			empty.hidden = !!host.children.length;
			if (!host.children.length)
				empty.textContent = 'This SoC reports no ISP metrics.';
		}
	}

	// ── Wi-Fi: a KPI tile, an RSSI chart with grade bands, and a fact line.
	// The grade line translates dBm into words for whoever has never seen one.
	let chRssi = null;
	function wifiGrade(v) {
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
		return grade;
	}
	function updateWifi(s, v) {
		const has = ['wifi_rssi_dbm', 'wifi_link_quality_ratio', 'wifi_bitrate_mbps',
			'wifi_retries_total', 'wifi_missed_beacons_total'].some(k => k in v);
		const tile = $('#st-wifi-tile'), panel = $('#st-wifi-panel');
		// The block is not frozen at first sight: a link arriving later must
		// mount it, and one leaving (interface down) must hide it again
		// rather than overwrite rows with "undefined dBm".
		if (tile) tile.hidden = !has;
		if (panel) panel.hidden = !has;
		if (!has) return;
		if (!wifiSeen) {
			wifiSeen = true;
			sparks.wifi = makeSpark('#spark-wifi', C1, null, null);
			chRssi = makeChart('#ch-rssi', {
				h: 110, lo: -90, hi: -30, colors: [C1], fmt: fmtNum,
				bands: [
					{ from: -60, to: -30, color: 'rgba(47,182,115,.07)', label: 'good' },
					{ from: -75, to: -60, color: 'rgba(255,193,7,.06)', label: 'fair' },
					{ from: -90, to: -75, color: 'rgba(224,84,78,.06)', label: 'weak' },
				],
			});
		}
		const dbm = $('#st-wifi-dbm'), gr = $('#st-wifi-grade');
		const r = ('wifi_rssi_dbm' in v) ? v.wifi_rssi_dbm : null;
		// A single gauge can go missing on its own — the RSSI does while the
		// link re-associates, since the collector refuses a non-negative one.
		if (dbm) dbm.textContent = r != null ? r : '–';
		const grade = wifiGrade(v);
		if (gr) {
			gr.textContent = '';
			if (grade) {
				const d = document.createElement('span');
				d.className = grade[1]; d.textContent = '● ';
				gr.appendChild(d);
				gr.appendChild(document.createTextNode(grade[0] +
					('wifi_bitrate_mbps' in v ? ' · ' + v.wifi_bitrate_mbps + ' Mb/s' : '')));
			}
		}
		if (r != null) { pushSpark(sparks.wifi, r); pushChart(chRssi, [r]); }
		const now = $('#st-rssi-now');
		if (now) now.textContent = r != null ? r + ' dBm' : '';
		// Gauges with units, counters as per-second rates — a retry *rate*
		// climbing with a sagging RSSI is the whole story.
		const parts = [];
		if ('wifi_link_quality_ratio' in v) parts.push('quality ' + v.wifi_link_quality_ratio + ' %');
		if ('wifi_snr_db' in v) parts.push('SNR ' + v.wifi_snr_db + ' dB');
		if (s.prev && s.dt > 0) {
			[['wifi_retries_total', 'retries'], ['wifi_missed_beacons_total', 'missed beacons']].forEach(k => {
				if (k[0] in v && k[0] in s.prev.v)
					parts.push(k[1] + ' ' + Math.max(0, (v[k[0]] - s.prev.v[k[0]]) / s.dt).toFixed(1) + '/s');
			});
		}
		const sub = $('#st-wifi-sub');
		if (sub) sub.textContent = parts.join(' · ');
	}

	// ── snapshot tile ───────────────────────────────────────────────────────
	// /image.jpg polled every 5s — decoded off-screen first so a slow or
	// failed fetch never blanks the tile, only leaves the last frame standing.
	function startPreview(cfg) {
		const img = $('#st-prev-img'), off = $('#st-prev-off'), note = $('#st-prev-note');
		if (!img || !off) return;
		// /image.jpg is the independent JPEG channel — jpeg.enabled is the
		// only gate. A camera streaming sub-only still has its snapshot.
		if (mjGet(cfg, 'jpeg.enabled') !== true) {
			off.textContent = 'Snapshots are disabled — open Live for video';
			return;
		}
		let busy = false;
		const tick = () => {
			if (busy || document.hidden) return;
			busy = true;
			const probe = new Image();
			probe.onload = () => {
				busy = false;
				img.src = probe.src;
				img.hidden = false;
				off.hidden = true;
				if (note) note.textContent = 'snapshot · updates every 5 s';
			};
			probe.onerror = () => {
				busy = false;
				if (img.hidden) off.textContent = 'Snapshot unavailable';
				else if (note) note.textContent = 'snapshot stalled — retrying';
			};
			probe.src = '/image.jpg?_=' + Date.now();
		};
		tick();
		setInterval(tick, 5000);
	}

	function onSample(s) {
		if (!s.ok) {
			setAlert('#st-alert-stale', s.fails >= 2);
			return;
		}
		setAlert('#st-alert-stale', false);
		const v = s.m.v;
		lastV = v;
		if (!ispEls) buildImaging(v);

		if (s.cpu != null) {
			$('#st-cpu').textContent = s.cpu.toFixed(0);
			pushSpark(sparks.cpu, s.cpu);
		}
		if (s.memPct != null) {
			$('#st-ram').textContent = s.memPct.toFixed(0);
			pushSpark(sparks.ram, s.memPct);
			$('#st-ram-mb').textContent = (((s.memTotal - s.memAvail) / 1048576) | 0) + ' / ' + ((s.memTotal / 1048576) | 0) + ' MB';
		}
		if (s.temp != null) {
			const el = $('#st-temp');
			el.textContent = s.temp.toFixed(0);
			el.className = s.temp >= 85 ? 'text-danger' : s.temp >= 70 ? 'text-warning' : '';
			pushSpark(sparks.temp, s.temp);
		} else if (!tempAbsent) {
			// Not every SoC can say — the Ingenic T31 exposes no temperature
			// at all — so state that once instead of showing "–" forever.
			tempAbsent = true;
			$('#st-temp').textContent = 'n/a';
			$('#st-temp-u').hidden = true;
			$('#spark-temp').hidden = true;
			$('#st-temp-note').textContent = 'no temperature sensor on this SoC';
		}
		if ('node_load1' in v) $('#st-load').textContent = v.node_load1.toFixed(2);
		if (s.sysUptimeS != null) $('#st-uptime').textContent = uptimeStr(s.sysUptimeS);
		$('#st-uptime-mj').textContent = s.mjUptimeS != null ? uptimeStr(s.mjUptimeS) : '–';
		$('#st-hls').textContent = v.hls_clients_total | 0;

		const dn = $('#st-daynight');
		if (dn) dn.textContent = (s.night ? '🌙 Night' : '☀️ Day') + ' · IR-cut ' + (s.ircut ? 'on' : 'off') +
			' · lamp ' + (s.light ? 'on' : 'off');
		// Only SigmaStar reports the empty-wakeup run; a sustained one means
		// the encoder has stopped producing frames while all else looks alive.
		setAlert('#st-alert-stall', v.venc_empty_frames_run > 25);
		setAlert('#st-alert-exp', v.isp_exposureismax > 0);
		const lum = $('#st-alert-exp-lum');
		if (lum) lum.textContent = ('isp_avelum' in v) ? ' Scene luminance ' + v.isp_avelum + ' of 255.' : '';

		if ('isp_avelum' in v) {
			const p = $('#st-luma-panel');
			if (p && p.hidden) {
				p.hidden = false;
				chLuma = makeChart('#ch-luma', {
					h: 110, lo: 0, hi: 255, colors: [C1],
					fmt: x => String(Math.round(x)),
					bands: [{ from: 0, to: 20, color: 'rgba(255,193,7,.10)' }],
				});
			}
			pushChart(chLuma, [v.isp_avelum]);
			const now = $('#st-luma-now');
			if (now) now.textContent = v.isp_avelum + ' / 255';
		}

		if (s.prev && s.dt > 0) {
			const rxMb = Math.max(0, (s.rx - s.prev.rx) / s.dt) * 8 / 1e6;
			const txMb = Math.max(0, (s.tx - s.prev.tx) / s.dt) * 8 / 1e6;
			pushChart(chNet, [txMb, rxMb]);

			// Measured encoder output. A counter still at 0 means this SoC's
			// byte accounting is absent, not a silent encoder — printing
			// "0.0" over a dead counter would read as an outage. Cleared, not
			// skipped or clamped, when no valid delta exists: a daemon
			// restart resets or removes the counter, and a reset counter that
			// has already climbed past zero yields a negative delta.
			const d0 = v.venc0_rcvd_bytes && ('venc0_rcvd_bytes' in s.prev.v)
				? v.venc0_rcvd_bytes - s.prev.v.venc0_rcvd_bytes : null;
			const encEl = $('#st-enc'), encNow = $('#st-enc-now');
			if (d0 != null && d0 >= 0) {
				const mb = d0 / s.dt * 8 / 1e6;
				if (encEl) encEl.textContent = mb.toFixed(1);
				if (encNow) encNow.textContent = mb.toFixed(1) + ' Mbit/s';
				pushSpark(sparks.enc, mb);
				pushChart(chEnc, [mb]);
			} else {
				if (encEl) encEl.textContent = '–';
				if (encNow) encNow.textContent = '';
			}
			const br1 = $('#st-br1');
			if (br1) {
				const d1 = v.venc1_rcvd_bytes && ('venc1_rcvd_bytes' in s.prev.v)
					? v.venc1_rcvd_bytes - s.prev.v.venc1_rcvd_bytes : null;
				br1.textContent = d1 != null && d1 >= 0 ? ' · measured ' + humanRate(d1 / s.dt) : '';
			}

			if (motionEl) {
				if ('md_rects_recv_total' in v && 'md_rects_recv_total' in s.prev.v) {
					const r = Math.max(0, (v.md_rects_recv_total - s.prev.v.md_rects_recv_total) / s.dt);
					const a = Math.max(0, ((v.md_rects_acc_total || 0) - (s.prev.v.md_rects_acc_total || 0)) / s.dt);
					motionEl.textContent = r.toFixed(1) + '/s · ' + a.toFixed(1) + ' in ROI';
					pushSpark(motionSpark, r);
				} else {
					motionEl.textContent = '–';
				}
			}
		}

		if (ispEls) Object.keys(ispEls).forEach(k => {
			ispEls[k].textContent = k === 'isp_fps' && cfgFps0
				? v[k] + ' (set ' + cfgFps0 + ')' : String(v[k]);
			pushSpark(ispSparks[k], v[k]);
		});

		updateWifi(s, v);
	}

	// One element per value, textContent throughout — these strings come from
	// the camera's config, and device-derived text must never reach innerHTML.
	function el(tag, cls, text) {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text != null) e.textContent = text;
		return e;
	}

	function renderStreams() {
		if (typeof mjConfig !== 'function') return;
		mjConfig().then(cfg => {
			// mjConfig resolves {} on a failed fetch. Empty is "unknown", not
			// "everything disabled" — keep the loading states and try again
			// rather than rendering a camera with no streams and no snapshot.
			if (!cfg || !Object.keys(cfg).length) {
				const off = $('#st-prev-off');
				if (off) off.textContent = 'waiting for camera config…';
				setTimeout(renderStreams, 10000);
				return;
			}
			cfgFps0 = mjGet(cfg, 'video0.fps') || null;
			mdEnabled = mjGet(cfg, 'motionDetect.enabled') === true;
			// The config may resolve after the first sample already built the
			// ISP panel without its Motion row — rebuild against the last
			// sample now that mdEnabled is known.
			if (lastV) buildImaging(lastV);

			const main = mjGet(cfg, 'video0.enabled') === true;
			const codec = String(mjGet(cfg, 'video0.codec') || '?').toUpperCase();
			const size = mjGet(cfg, 'video0.size') || '?';
			const br = mjGet(cfg, 'video0.bitrate');

			// Encoder tile + chart learn the configured target.
			if (main && br) {
				encSetMbit = br / 1000;
				$('#st-enc-sub').textContent = 'of ' + encSetMbit.toFixed(1) + ' set · ' + codec;
				if (chEnc) {
					chEnc.cfg.hi = Math.max(niceCeil(encSetMbit * 1.15), 2);
					chEnc.cfg.ref = { v: encSetMbit, label: 'set ' + encSetMbit.toFixed(1) };
				}
			}
			// Snapshot chip: what the picture is.
			const chip = $('#st-prev-chip');
			if (chip && main) {
				chip.textContent = codec + ' ' + size + (cfgFps0 ? ' · ' + cfgFps0 + ' fps' : '');
				chip.hidden = false;
			}
			startPreview(cfg);

			// Streams card, slim: the main stream's facts live on the picture
			// and the encoder chart, so only its target and the other outputs
			// are stated here.
			const host = $('#streams'); if (!host) return;
			host.textContent = '';
			host.appendChild(el('div', 'x-small text-secondary', main
				? 'Main stream is on the picture — set ' + br + ' kbit/s'
				: 'Main stream is disabled.'));
			if (mjGet(cfg, 'video1.enabled') === true) {
				const scodec = String(mjGet(cfg, 'video1.codec') || '?').toUpperCase();
				const sfps = mjGet(cfg, 'video1.fps');
				const sbr = mjGet(cfg, 'video1.bitrate');
				const row = el('div');
				row.appendChild(el('span', 'badge text-bg-primary me-2', 'Sub'));
				row.appendChild(el('span', 'fw-semibold me-1', mjGet(cfg, 'video1.size') || '?'));
				row.appendChild(el('span', 'badge text-bg-light border', scodec));
				const sub = el('div', 'x-small text-secondary mt-1',
					(sfps ? sfps + ' fps' : '') + (sbr ? ' · ' + sbr + ' kbit/s' : ''));
				const meas = el('span');
				meas.id = 'st-br1';
				sub.appendChild(meas);
				row.appendChild(sub);
				host.appendChild(row);
			} else {
				host.appendChild(el('div', 'x-small text-secondary', 'Sub stream disabled.'));
			}
			host.appendChild(el('div', 'x-small text-secondary',
				mjGet(cfg, 'jpeg.enabled') === true ? 'JPEG snapshots enabled.' : 'JPEG snapshots disabled.'));
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

	let chEnc = null, chNet = null, chLuma = null;

	function init() {
		renderOverlay();
		sparks.cpu = makeSpark('#spark-cpu', C1, 0, 100);
		sparks.ram = makeSpark('#spark-ram', C1, 0, 100);
		sparks.temp = makeSpark('#spark-temp', C1, null, null);
		sparks.enc = makeSpark('#spark-enc', C1, 0, null);
		chEnc = makeChart('#ch-enc', { h: 150, lo: 0, hi: null, colors: [C1] });
		chNet = makeChart('#ch-net', { h: 110, lo: 0, hi: null, colors: [C1, C2] });
		renderStreams();
		// main.js is loaded without defer, so the registry exists; the poll is
		// started by initAll on window load.
		mjMetricsSubscribe(onSample);
		// Axis charts render in pixel space, so a resize needs a redraw
		// (sparklines stretch on their own).
		let rt = null;
		addEventListener('resize', () => {
			clearTimeout(rt);
			rt = setTimeout(() => charts.forEach(renderChart), 150);
		});
	}

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
	else init();
})();
