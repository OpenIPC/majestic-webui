// Live dashboard. The 2s /metrics poll and its parser live in main.js (one
// heartbeat for every page); this file subscribes via mjMetricsSubscribe and
// only renders. Configured stream facts come from /api/v1/config.json.
//
// Layout contract (the "Signal Wall + Live" design): alerts render first and
// only while active; the KPI strip and every chart panel mount per what this
// camera actually reports; the snapshot tile is a polled /image.jpg — never a
// stream, so the dashboard costs no majestic session slot.
(function () {
	const sparks = {};
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

	// Chart primitives live in /a/charts.js, shared with the Live View stats
	// panel. The wrappers fold in this page's theme colors so every chart on
	// the dashboard keeps its grid and reference-line ink without repeating it
	// per call site.
	const MC = window.MjCharts;
	const makeSpark = MC.makeSpark, pushSpark = MC.pushSpark, pushChart = MC.pushChart;
	function makeChart(sel, cfg) {
		cfg.grid = GRID;
		cfg.refColor = C1;
		return MC.makeChart(sel, cfg);
	}

	// ── alerts ──────────────────────────────────────────────────────────────
	function setAlert(id, on) {
		const el = $(id);
		if (el) el.hidden = !on;
		const box = $('#st-alerts');
		if (box) box.hidden = !['#st-alert-stale', '#st-alert-exp', '#st-alert-novideo',
			'#st-alert-wasnovideo', '#st-alert-ircut']
			.some(a => { const e = $(a); return e && !e.hidden; });
	}

	// ── nothing to see ──────────────────────────────────────────────────────
	// The verdict is in /a/video-check.js; this only decides what the dashboard
	// says out loud, the same split as the IR-cut banner below. No picture is
	// measured here — the Dashboard has no decoded frame, only a snapshot in a
	// tile — so the finding rests on the camera's own exposure gauges alone,
	// and on a camera that does not publish them there is simply no finding.
	// That is the honest answer rather than a gap: it is the Live page, which
	// has the frame, that can still tell.
	const VC = window.MajesticVideoCheck;
	const vidTrack = VC ? VC.tracker() : null;
	let vidTrackNow = { blindS: 0, blind: null };
	// Set by the Live page's hand-off. Cleared the moment a finding renders —
	// the banner then IS the explanation and two of them would be one too many.
	let cameFromLive = false;
	try {
		cameFromLive = new URLSearchParams(location.search).has('novideo');
	} catch (e) {}
	// Its own copy rather than a read of nmCfg: that one is narrowed to
	// .nightMode, and diagnose() asks about the video channels. {} is the right
	// starting value — every test in there is `=== false`, so an unfetched
	// config declines to answer instead of reporting both channels off.
	let cfgNow = {};
	// When this page first heard from the camera, so the all-clear above can
	// tell "checked and found nothing" from "has not looked yet".
	let vidFirstS = null;
	if (VC && typeof mjConfig === 'function') {
		mjConfig().then(c => {
			if (c && Object.keys(c).length) cfgNow = c;
		}).catch(() => {});
	}

	function renderNoVideo(s) {
		if (!VC) return;
		const f = VC.diagnose(cfgNow, s, vidTrackNow, null);
		if (f) {
			cameFromLive = false;
			const t = $('#st-alert-novideo-t'), d = $('#st-alert-novideo-d');
			const a = $('#st-alert-novideo-a');
			if (t) t.textContent = f.title;
			if (d) d.textContent = f.detail;
			if (a) {
				a.textContent = f.act.label + ' →';
				a.href = f.act.href;
				// Assigned, not added: this anchor is rewritten on every
				// finding and addEventListener would stack a prompt per
				// repaint. main.js cannot help here — it wires `.confirm` once
				// at load and this link does not exist in its final form until
				// long after.
				a.onclick = f.act.confirm
					? (ev) => { if (!confirm(f.act.confirm)) ev.preventDefault(); }
					: null;
			}
			const h = $('#st-alert-novideo-h');
			if (h) {
				h.hidden = !f.help;
				if (f.help) { h.textContent = f.help.label + ' →'; h.href = f.help.href; }
			}
		}
		setAlert('#st-alert-novideo', !!f);
		// Only once the camera has actually been heard from. Saying anything
		// about the hand-off off an unanswered poll would be a claim made from
		// nothing.
		const heard = !!s && s.ok;
		if (heard && vidFirstS === null) vidFirstS = performance.now() / 1000;
		// The all-clear is earned, not assumed: this page's own blind run has
		// to have had time to fire and not fired. Before that the banner states
		// the hand-off and stops there.
		const settled = vidFirstS !== null &&
			performance.now() / 1000 - vidFirstS >= (VC ? VC.BLIND_S : 10);
		const ok = $('#st-alert-wasnovideo-ok');
		if (ok) ok.textContent = settled ? ' It looks fine now.' : '';
		setAlert('#st-alert-wasnovideo', cameFromLive && heard);
	}

	// ── IR-cut ──────────────────────────────────────────────────────────────
	// A misconfigured IR-cut filter is invisible everywhere else on this page:
	// the camera streams, records and reports healthy counters while sending a
	// magenta picture, and the day/night line below states the two values
	// without ever saying they contradict each other. The verdict itself is in
	// /a/ircut-check.js; this only decides what the dashboard says out loud.
	//
	// Faults only. `info` — a wired filter with the light monitor off — is a
	// true observation and belongs on the settings page next to the switch that
	// changes it, not in a banner someone cannot dismiss.
	const IC = window.MajesticIrcut;
	const ircutTrack = IC ? IC.tracker() : null;
	let nmCfg = null;
	if (IC) mjConfig().then(c => {
		// mjConfig() resolves {} when the fetch failed, and an empty config
		// would diagnose as "no IR-cut pins configured" — a fetch that did not
		// happen must never be reported as a camera that is wired wrong.
		if (c && Object.keys(c).length) nmCfg = c.nightMode || {};
		// The banner is gated on this having arrived, so it has to repaint the
		// moment it does; otherwise a camera whose heartbeat is down shows
		// nothing at all.
		paintIrcut();
	}).catch(() => {});

	// "This camera has no IR-cut filter", as recorded on the camera itself.
	// Nothing measurable separates a filter nobody wired from a camera that
	// has none, so the owner says which — once, for every browser that opens
	// the page, which is why it is not localStorage.
	//
	// Starts false: a fetch that did not happen must not silence a fault. The
	// cost of getting that wrong in this direction is a banner someone
	// dismisses again; the other way it is a magenta picture nobody is told
	// about.
	let noFilter = false;
	let noFilterCleared = false;
	apiFetch('/cgi-bin/j/ircut.cgi', { credentials: 'same-origin' })
		.then(r => r.json())
		.then(j => { noFilter = !!(j && j.noFilter); paintIrcut(); })
		.catch(() => {});

	// What the snapshot tile's frame looks like. Kept as the last observation
	// plus its run length, so the banner is driven by the picture the page is
	// actually showing rather than by one lucky frame.
	let ircutPic = null;
	let ircutSample = null;
	let ircutTrackNow = { flips: 0, conflictS: 0 };

	function readIrcutPicture(el) {
		if (!IC || !nmCfg) return;
		const l = IC.lookAt(el);
		ircutPic = { look: l, streak: ircutTrack.picture(l) };
		// The snapshot poll is 5s and the heartbeat 2s, so repaint here rather
		// than wait for the next sample — otherwise the picture's finding
		// always lags a frame behind the frame that produced it.
		paintIrcut();
	}

	// Advancing the tracker and painting are separate because they are driven
	// by different clocks: the heartbeat advances time (flips, how long a
	// disagreement has stood) and must be counted exactly once per sample,
	// while the snapshot poll only ever brings new evidence. Painting from
	// inside the push would make every repaint a second tick of the clock.
	function renderIrcut(s) {
		if (!IC || !nmCfg) return;
		ircutSample = s;
		ircutTrackNow = ircutTrack.push(s, performance.now() / 1000);
		paintIrcut();
	}

	function paintIrcut() {
		// Not before the config has loaded. diagnose() reads a null config as an
		// empty one and an empty one has no pins, so painting early accuses a
		// correctly wired camera of having nothing connected — and the accusation
		// stands until something else repaints, which on a camera whose heartbeat
		// is down is never. Every other caller already refused to paint here;
		// this refuses centrally so a new one cannot forget.
		if (!IC || !nmCfg) return;
		let f = IC.diagnose(nmCfg, ircutSample, ircutTrackNow, ircutPic)
			.filter(x => x.level !== 'info')[0];

		// Configuring a pin contradicts "there is no filter here", so the claim
		// is dropped the moment one appears. That is what keeps a dismissal
		// from outliving its own premise: someone who says no filter, then
		// wires one, then has it fail, is told — the promise the dismissal
		// made was to silence "you have not set this up", not "the one you set
		// up has stopped working".
		if (noFilter && !noFilterCleared && IC.wired && IC.wired(nmCfg)) {
			// Once per load, and the answer comes from the file rather than from
			// having asked: a delete the flash refused would otherwise leave the
			// page believing the claim was dropped while it survives on the
			// camera, ready to suppress the banner after the pin is taken away
			// again. Retried on the next load, which is when it can differ.
			noFilterCleared = true;
			apiFetch('/cgi-bin/j/ircut.cgi?clear=1', { credentials: 'same-origin' })
				.then(r => r.json())
				.then(j => { noFilter = !!(j && j.noFilter); paintIrcut(); })
				.catch(() => {});
		}

		// Only the missing-pin finding can be waved away. Every other one is
		// about a filter that IS configured, and a camera whose filter is
		// wired backwards is not a camera without one.
		const canDismiss = !!f && f.id === 'no-pins';
		if (canDismiss && noFilter) f = null;

		if (f) {
			$('#st-alert-ircut-t').textContent = f.title;
			$('#st-alert-ircut-d').textContent = f.detail;
		}
		const no = $('#st-alert-ircut-no');
		if (no) no.hidden = !(f && canDismiss);
		setAlert('#st-alert-ircut', !!f);
	}

	function wireIrcutDismiss() {
		const no = $('#st-alert-ircut-no');
		if (!no) return;
		no.addEventListener('click', () => {
			if (!confirm('Hide this warning for good?\n\nSay yes only if this ' +
				'camera has no IR-cut filter fitted. If it has one and it is ' +
				'simply not set up yet, the picture will go magenta in ' +
				'daylight and nothing will tell you why.')) return;
			no.disabled = true;
			apiFetch('/cgi-bin/j/ircut.cgi?dismiss=1', { credentials: 'same-origin' })
				.then(r => r.json())
				.then(j => { noFilter = !!(j && j.noFilter); paintIrcut(); })
				.catch(() => {})
				.then(() => { no.disabled = false; });
		});
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
				h: 110, lo: -90, hi: -30, colors: [C1],
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
		// `busy` is the in-flight probe's start time, not a boolean: a request
		// the browser never settles (half-dead link) would otherwise pin it
		// true and stop the poll for good. After 15s the probe is abandoned —
		// the token check makes its late events no-ops, so an old response
		// can never clobber a newer frame.
		//
		// The fetch goes through apiFetch, not Image.src: every same-origin
		// request that can be answered 401 must ride the shared pair (the
		// X-Requested-With declaration plus the login redirect), or an
		// expired session turns the 5s poll into the native auth prompt that
		// machinery exists to prevent. The blob is still decoded off-screen
		// before the visible swap, and the superseded frame's URL is revoked.
		let busy = 0, ctl = null;
		const fail = () => {
			if (img.hidden) off.textContent = 'Snapshot unavailable';
			else if (note) note.textContent = 'snapshot stalled — retrying';
		};
		const tick = () => {
			if (document.hidden) return;
			if (busy && Date.now() - busy < 15000) return;
			// Superseding a stuck probe also cancels it — abandoned fetches
			// must not pile up on the half-dead link that stranded them. The
			// token check keeps the aborted request's rejection a no-op.
			if (ctl) ctl.abort();
			ctl = new AbortController();
			busy = Date.now();
			const mine = busy;
			apiFetch('/image.jpg?_=' + Date.now(), { cache: 'no-store', signal: ctl.signal })
				.then(r => r.ok ? r.blob() : Promise.reject(r.status))
				.then(blob => {
					if (busy !== mine) return;
					const url = URL.createObjectURL(blob);
					const probe = new Image();
					probe.onload = () => {
						if (busy !== mine) { URL.revokeObjectURL(url); return; }
						busy = 0;
						// The frame is decoded and in hand, so the IR-cut look
						// costs one 160x90 drawImage and nothing else — no
						// fetch, no session slot, no camera-side work. Reading
						// it here rather than on a timer of its own is also
						// what keeps the streak counting real frames.
						readIrcutPicture(probe);
						const old = img.src;
						img.src = url;
						img.hidden = false;
						off.hidden = true;
						if (note) note.textContent = 'snapshot · updates every 5 s';
						if (old.startsWith('blob:')) URL.revokeObjectURL(old);
					};
					probe.onerror = () => {
						URL.revokeObjectURL(url);
						if (busy !== mine) return;
						busy = 0;
						fail();
					};
					probe.src = url;
				})
				.catch(() => {
					if (busy !== mine) return;
					busy = 0;
					fail();
				});
		};
		tick();
		setInterval(tick, 5000);
	}

	function onSample(s) {
		if (!s.ok) {
			// Tracking consumes EVERY sample, failures included, and is not
			// inside the two-failure gate below. The blind run is a duration
			// measured from when it started, so a poll that is merely skipped
			// leaves the clock running: one failed heartbeat in the middle of a
			// dark stretch would have had the next good sample bill the whole
			// outage as blindness nobody watched, and ten seconds of that is a
			// finding. An unreachable camera is not a camera reporting
			// darkness — the same reasoning as the IR-cut tracker's.
			if (vidTrack) vidTrackNow = vidTrack.push(s, performance.now() / 1000);
			// What is DISPLAYED still waits for the second failure, so a single
			// dropped poll does not flap a banner off and on again.
			//
			// With no current data there is no evidence the condition alerts
			// still hold — clear them rather than presenting the last good
			// sample's warnings as current next to "not responding".
			if (s.fails >= 2) {
				setAlert('#st-alert-exp', false);
				renderNoVideo(s);
				// Not cleared, narrowed: an unset irCutPin1 is still unset
				// while the camera is unreachable, but a day/night
				// disagreement is a claim about right now, and there is no
				// right now to read. Passing no sample drops exactly the
				// findings that needed one.
				renderIrcut(null);
			}
			setAlert('#st-alert-stale', s.fails >= 2);
			// No new sample, but time still passes: redraw so the traces age
			// toward the left edge instead of standing at "now" through an
			// outage they know nothing about.
			MC.renderAll();
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
		// A gauge this majestic does not publish reads as "not reported", never
		// as day with the filter closed.
		if (dn) dn.textContent = s.night == null ? 'Day / night not reported'
			: (s.night ? '🌙 Night' : '☀️ Day') +
				' · IR-cut ' + (s.ircut == null ? '?' : (s.ircut ? 'on' : 'off')) +
				' · lamp ' + (s.light == null ? '?' : (s.light ? 'on' : 'off'));
		renderIrcut(s);
		// Only SigmaStar reports the empty-wakeup run; a sustained one means
		// the encoder has stopped producing frames while all else looks alive.
		// The encoder tile and chart obey the same rule as Wi-Fi and
		// temperature: they mount only when this camera can actually measure.
		// A counter stuck at 0 means the SoC's byte accounting is absent, not
		// a silent encoder; once it has climbed past zero a genuine 0.0 rate
		// still shows, because the counter itself stays > 0.
		const encHas = ('venc0_rcvd_bytes' in v) && v.venc0_rcvd_bytes > 0;
		const encTile = $('#st-enc-tile'), encPanel = $('#st-enc-panel');
		if (encTile) encTile.hidden = !encHas;
		if (encPanel) encPanel.hidden = !encHas;

		if (vidTrack) vidTrackNow = vidTrack.push(s, performance.now() / 1000);
		renderNoVideo(s);
		// Kept alongside, and it is not the same statement. This one says the
		// scene is darker than the sensor can compensate for, which is a true
		// and ordinary thing at dusk; the banner above only speaks when the
		// metered luminance is zero as well, which no scene produces.
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
			// A negative delta is a counter reset or an interface bounce, not
			// zero traffic — null invalidates the interval so the chart breaks
			// the run instead of plotting a false outage (same treatment as
			// the venc byte counters below).
			const dRx = s.rx - s.prev.rx, dTx = s.tx - s.prev.tx;
			pushChart(chNet, [
				dTx >= 0 ? dTx / s.dt * 8 / 1e6 : null,
				dRx >= 0 ? dRx / s.dt * 8 / 1e6 : null,
			]);

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
					chEnc.cfg.hi = Math.max(MC.niceCeil(encSetMbit * 1.15), 2);
					chEnc.cfg.ref = { v: encSetMbit, label: 'set ' + encSetMbit.toFixed(1) };
				}
			}
			// The chip names the stream the play button opens — the picture
			// itself is the JPEG channel (the bar below it says "snapshot"),
			// so the chip says MAIN outright instead of letting the main
			// stream's codec and size read as facts about the shown image.
			const chip = $('#st-prev-chip');
			if (chip && main) {
				chip.textContent = 'MAIN · ' + codec + ' ' + size + (cfgFps0 ? ' · ' + cfgFps0 + ' fps' : '');
				chip.hidden = false;
			}
			startPreview(cfg);

			// Streams card, slim: the main stream's facts live on the picture
			// and the encoder chart, so only its target and the other outputs
			// are stated here.
			const host = $('#streams'); if (!host) return;
			host.textContent = '';
			host.appendChild(el('div', 'x-small text-secondary', main
				? 'Main stream is on the picture' + (br ? ' — set ' + br + ' kbit/s' : '')
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
		wireIrcutDismiss();
		// Resize redraws are charts.js's job — one debounced listener for
		// every chart on the page.
	}

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
	else init();
})();
