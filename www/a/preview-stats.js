// The Live View stats panel — the network story, told for someone who has
// never read a WebRTC stat. Three chapters on the black glass: how old the
// picture is (with the camera's half and the browser's half of the journey
// summed), what the connection can carry against what the camera sends, and
// what the camera's radio and other consumers are doing. The raw counters
// the old table showed keep a fine-print block at the bottom.
//
// Same contract as preview-adapt.js: a self-contained module, resolved
// lazily, fed one guarded tick() from preview-page.js — which runs under the
// vm-based tests and must never touch DOM this file owns. The camera line
// (tick's s.cam) is schema-free key=value text; every key is optional and an
// absent one renders '-' or hides its row, so an older majestic degrades
// row by row rather than breaking the panel.
//
// Two clocks feed it and they never mix in one graph: the 1 Hz WebRTC tick
// draws the delay and bandwidth series, the 2 s /metrics heartbeat
// (mjMetricsSubscribe) draws the radio and egress ones.
window.MajesticStats = (function () {
	'use strict';

	// Series ink, hardcoded: the glass is the same in both themes, so the
	// page theme must not decide it. These are the dark-theme --st-c* values
	// the dashboard uses, validated against the glass surface (#0d0f14) for
	// color-vision separation and contrast, so both pages draw with one set
	// of pencils.
	const C1 = '#5c70e8', C2 = '#0da893', C3 = '#d1793a', C4 = '#a06ee0';
	// Status ink — words always ride beside the color (never color alone).
	const OK = '#4ade80', WARN = '#fbbf24', BAD = '#f87171';
	const GRID = 'rgba(255,255,255,.14)';

	let els = null;
	let latSpark = null, bwChart = null, rssiSpark = null;
	let open = false;
	let prevT = null;      // previous tick's cumulative counters
	let lastTickAt = 0;
	let hold = { buf: null, dec: null }; // per-frame figures across empty deltas
	// The screen's share: how long a decoded frame waits for the compositor
	// and the next vsync. Measured per presented frame where the browser
	// offers requestVideoFrameCallback (expectedDisplayTime −
	// presentationTime); estimated as half a refresh interval otherwise.
	// What no web page can see — the panel's own hardware latency — is why
	// the headline keeps saying "at least".
	let dispEmaMs = null;
	let dispSeenAt = 0;
	// The frame on the glass, named the way the camera can name it too: its
	// RTP timestamp, plus the browser-epoch instant it became visible.
	let shownFrame = null;
	let refreshMs = null;
	const armed = [];
	let lossEma = null;
	let srG2gEma = null;
	let srSeenAt = 0;
	// Each transport's last settled headline, kept ACROSS transport switches
	// and resets: putting the other protocol's number next to this one's is
	// the comparison the whole panel exists for.
	const lastSeen = { webrtc: null, mse: null };
	let lastStallAt = 0;
	let wired = false;
	// Measured encoder output per channel, bytes/s, from the 2 s heartbeat —
	// what the "camera sending" row shows. The configured bitrate is a
	// ceiling, not a rate: a VBR encoder on a quiet scene spends a fraction
	// of it, and printing the ceiling next to "you receive" read as massive
	// loss when nothing was lost.
	let vencRate = [null, null];

	function fmtK(k) {
		if (k == null) return '-';
		return k >= 1000 ? (k / 1000).toFixed(1) + ' Mbit/s'
			: Math.round(k) + ' kbit/s';
	}
	// bytes/s → bits/s, humanized.
	function fmtBps(b) {
		return fmtK(b * 8 / 1000);
	}

	function seg(color) {
		return '<i style="background:' + color + '"></i>';
	}

	// The whole interior is built here rather than in the CGI: the panel is
	// meaningless without this script, and one file owning both structure
	// and updates is what lets the design iterate without touching haserl.
	const T =
		'<div class="mj-ns">' +
		'<section class="mj-ns-sec">' +
			'<div class="mj-ns-cap">Delay</div>' +
			'<div class="mj-ns-hero"><span class="mj-ns-num" id="mj-ns-lat">–</span>' +
				'<span class="mj-ns-unit">ms</span>' +
				'<span class="mj-ns-sub" id="mj-ns-lat-sub">measuring…</span></div>' +
			'<div class="mj-ns-note" id="mj-ns-vs" hidden></div>' +
			'<div class="mj-ns-bar" id="mj-ns-bar" hidden>' +
				'<span id="mj-ns-seg-cam" style="background:' + C1 + '"></span>' +
				'<span id="mj-ns-seg-net" style="background:' + C2 + '"></span>' +
				'<span id="mj-ns-seg-buf" style="background:' + C3 + '"></span>' +
				'<span id="mj-ns-seg-dec" style="background:' + C4 + '"></span></div>' +
			'<div class="mj-ns-legend" id="mj-ns-lat-legend" hidden>' +
				'<span>' + seg(C1) + 'camera <b id="mj-ns-l-cam">–</b></span>' +
				'<span>' + seg(C2) + 'network <b id="mj-ns-l-net">–</b></span>' +
				'<span>' + seg(C3) + 'buffer <b id="mj-ns-l-buf">–</b></span>' +
				'<span>' + seg(C4) + 'screen <b id="mj-ns-l-dec">–</b></span></div>' +
			'<div class="mj-ns-spark" id="mj-ns-lat-sp"></div>' +
		'</section>' +
		'<section class="mj-ns-sec">' +
			'<div class="mj-ns-cap">Your connection <span class="mj-ns-grade" id="mj-ns-grade"></span></div>' +
			'<div class="mj-ns-rows">' +
				'<div class="mj-ns-row" id="mj-ns-r-cap" hidden><span>link can carry</span><b id="mj-ns-cap-est">–</b></div>' +
				'<div class="mj-ns-row" id="mj-ns-r-set" hidden><span>camera set to</span><b id="mj-ns-set">–</b></div>' +
				'<div class="mj-ns-row"><span>camera sending</span><b id="mj-ns-send">–</b></div>' +
				'<div class="mj-ns-row"><span>you receive</span><b id="mj-ns-recv">–</b></div>' +
			'</div>' +
			'<div class="mj-ns-chart" id="mj-ns-bw"></div>' +
			'<div class="mj-ns-legend">' +
				'<span>' + seg(C1) + 'received</span>' +
				'<span id="mj-ns-leg-est">' + seg(C2) + 'link estimate</span></div>' +
			'<div class="mj-ns-note" id="mj-ns-repair"></div>' +
		'</section>' +
		'<section class="mj-ns-sec" id="mj-ns-radio" hidden>' +
			'<div class="mj-ns-cap">Camera radio</div>' +
			'<div class="mj-ns-rows">' +
				'<div class="mj-ns-row"><span>Wi-Fi signal</span><b id="mj-ns-wifi">–</b></div>' +
				'<div class="mj-ns-row" id="mj-ns-r-wrate" hidden><span>radio link speed</span><b id="mj-ns-wrate">–</b></div>' +
				'<div class="mj-ns-row" id="mj-ns-r-wretr" hidden><span>radio retries</span><b id="mj-ns-wretr">–</b></div>' +
			'</div>' +
			'<div class="mj-ns-spark" id="mj-ns-rssi-sp"></div>' +
		'</section>' +
		'<section class="mj-ns-sec" id="mj-ns-egress" hidden>' +
			'<div class="mj-ns-cap">Camera is serving</div>' +
			'<div class="mj-ns-rows" id="mj-ns-eg-rows"></div>' +
		'</section>' +
		'<section class="mj-ns-fine" id="mj-ns-fp"></section>' +
		'</div>';

	// Per presented frame, where the API exists: the gap between the frame
	// being handed to the compositor and the vsync it becomes visible on.
	function armDisplayProbe(v) {
		if (!v || typeof v.requestVideoFrameCallback !== 'function') return;
		if (armed.indexOf(v) >= 0) return;
		armed.push(v);
		const loop = (now, md) => {
			// The staging player also presents frames while a trial runs;
			// only the visible element describes what the person sees. The
			// swap machinery hides the spare with style.display, not the
			// hidden attribute, so both spellings are checked.
			if (!v.hidden && v.style.display !== 'none' && md &&
				md.expectedDisplayTime > 0 &&
				md.presentationTime > 0) {
				const d = md.expectedDisplayTime - md.presentationTime;
				if (d >= 0 && d < 1000) {
					dispEmaMs = dispEmaMs == null ? d : dispEmaMs + (d - dispEmaMs) / 8;
					dispSeenAt = performance.now();
				}
				if (typeof md.rtpTimestamp === 'number') {
					shownFrame = {
						rtp: md.rtpTimestamp,
						atEpoch: performance.timeOrigin + md.expectedDisplayTime,
						seenAt: performance.now(),
					};
				}
			}
			v.requestVideoFrameCallback(loop);
		};
		v.requestVideoFrameCallback(loop);
	}

	// The display's refresh rate, by the sliding-window frame count the
	// openipc.org high-resolution-timer tool uses — the fallback the screen
	// leg is estimated from (half a refresh interval, the mean wait to the
	// next vsync), and a fact for the fine print either way. One bounded
	// run; re-measured on fullscreen changes, when the output can move to a
	// different display.
	function measureRefresh() {
		if (typeof requestAnimationFrame !== 'function') return;
		const times = [];
		let frames = 0;
		const tick = () => {
			const now = performance.now();
			while (times.length > 0 && times[0] <= now - 1000) times.shift();
			times.push(now);
			const span = now - times[0];
			if (times.length > 30 && span >= 950) {
				refreshMs = span / (times.length - 1);
				return;
			}
			// The frame cap exists for the tests' frozen clock, which can
			// never satisfy the time exit. Sized so every real display
			// reaches 950 ms first (240 Hz needs ~230 frames) — and if some
			// future panel still outruns it, whatever real time WAS observed
			// beats reporting nothing.
			if (++frames >= 600) {
				if (times.length > 30 && span > 0) {
					refreshMs = span / (times.length - 1);
				}
				return;
			}
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	}

	function ensure() {
		if (els) return true;
		const box = document.getElementById('mj-stats');
		if (!box || !window.MjCharts) return false;
		box.innerHTML = T;
		const g = (id) => document.getElementById(id);
		els = {
			lat: g('mj-ns-lat'), latSub: g('mj-ns-lat-sub'),
			bar: g('mj-ns-bar'), legend: g('mj-ns-lat-legend'),
			segCam: g('mj-ns-seg-cam'), segNet: g('mj-ns-seg-net'),
			segBuf: g('mj-ns-seg-buf'), segDec: g('mj-ns-seg-dec'),
			lCam: g('mj-ns-l-cam'), lNet: g('mj-ns-l-net'),
			lBuf: g('mj-ns-l-buf'), lDec: g('mj-ns-l-dec'),
			grade: g('mj-ns-grade'), vs: g('mj-ns-vs'),
			legEst: g('mj-ns-leg-est'),
			rCap: g('mj-ns-r-cap'), capEst: g('mj-ns-cap-est'),
			rSet: g('mj-ns-r-set'), set: g('mj-ns-set'),
			send: g('mj-ns-send'), recv: g('mj-ns-recv'),
			repair: g('mj-ns-repair'),
			radio: g('mj-ns-radio'), wifi: g('mj-ns-wifi'),
			rWrate: g('mj-ns-r-wrate'), wrate: g('mj-ns-wrate'),
			rWretr: g('mj-ns-r-wretr'), wretr: g('mj-ns-wretr'),
			egress: g('mj-ns-egress'), egRows: g('mj-ns-eg-rows'),
			fp: g('mj-ns-fp'),
		};
		const MC = window.MjCharts;
		latSpark = MC.makeSpark(g('mj-ns-lat-sp'), C1, 0, null, 120);
		rssiSpark = MC.makeSpark(g('mj-ns-rssi-sp'), C1, -90, -30, 60);
		bwChart = MC.makeChart(g('mj-ns-bw'), {
			h: 56, lo: 0, hi: null, colors: [C1, C2], grid: GRID,
			fmt: (x) => x >= 10 ? String(Math.round(x)) : x.toFixed(1),
		});
		if (!wired && typeof mjMetricsSubscribe === 'function') {
			wired = true;
			mjMetricsSubscribe(onMetrics);
		}
		measureRefresh();
		if (typeof document.addEventListener === 'function') {
			document.addEventListener('fullscreenchange', measureRefresh);
		}
		return true;
	}

	// ── the 1 Hz WebRTC tick ────────────────────────────────────────────────

	// s.cam.c2s is "123ms" measured or "~123ms" estimated-lower-bound; the
	// distinction survives into the caption.
	function parseC2s(t) {
		const m = /^(~?)(\d+)/.exec(t || '');
		return m ? { ms: +m[2], approx: m[1] === '~' } : null;
	}

	// The browser's own numbers plus the camera's adaptation state: with the
	// encoder throttled, loss and round trip read clean precisely BECAUSE the
	// camera gave the link less to carry — a storm graded "excellent" on
	// those alone (seen in the lab, picture a blocky mess) is the adaptation
	// hiding its own evidence.
	//
	// But the estimate itself is only evidence when the stream is testing
	// the link: an idle REMB sits at a small multiple of whatever trickle
	// arrives, and taking it at face value graded a quiet scene on a wired
	// LAN "struggling" (called out from the field, rightly, as nonsense).
	// The same rule the camera's own vote follows (majestic's bwe policy):
	// an estimate below twice the delivered rate is a fact about the link,
	// one above it is the estimator idling — and an adaptation triggered by
	// an idling estimator is the same false positive one step removed.
	function gradeOf(lossPct, rtt, jitterMs, encK, cfgK, rembK, recvK) {
		// The grade reads the estimate ADAPTATION acts on — the camera-side
		// remb — not the larger of two estimates: a high idle browser figure
		// must not mask a binding camera one. And nothing is "tested" while
		// nothing was delivered: recvK 0 means the stream is not flowing,
		// which is its own story, not evidence about capacity.
		const meaningful = recvK > 0 && rembK > 0 && rembK < 2 * recvK;
		const adapting = encK > 0 && meaningful;
		const crushed = adapting && cfgK > 0 && rembK < cfgK / 2;
		if (lossPct > 5 || rtt > 500) return ['poor', BAD];
		if (lossPct > 1 || rtt > 250 || jitterMs > 100 || crushed)
			return ['struggling', WARN];
		if (lossPct > 0.2 || rtt > 100 || adapting) return ['good', OK];
		return ['excellent', OK];
	}

	function tick(s) {
		if (!ensure()) return;
		armDisplayProbe(document.getElementById('live-video'));
		armDisplayProbe(document.getElementById('live-video-b'));
		const cam = s.cam || {};
		const mse = s.transport === 'mse';
		const now = performance.now();
		const dt = lastTickAt ? (now - lastTickAt) / 1000 : 0;
		lastTickAt = now;
		let p = prevT;
		prevT = {
			jbDelay: s.jbDelay || 0, jbEmitted: s.jbEmitted || 0,
			decodeTime: s.decodeTime || 0, framesDecoded: s.framesDecoded || 0,
			packetsLost: s.packetsLost || 0, packetsReceived: s.packetsReceived || 0,
			nack: s.nack || 0, rtx: parseInt(cam.rtx, 10) || 0,
			rxBytes: s.rxBytes || 0, totalFrames: s.totalFrames || 0,
			droppedFrames: s.droppedFrames || 0, stalls: s.stalls || 0,
		};
		// A cumulative counter that went BACKWARDS means the peer connection
		// was rebuilt under us (preview-webrtc reconnects internally without
		// passing through the page's transport switch): the old baselines,
		// held per-frame figures and loss average all describe a connection
		// that no longer exists. Forget them now rather than letting them
		// decay through the new session's first seconds.
		if (p && (prevT.packetsReceived < p.packetsReceived ||
				prevT.jbEmitted < p.jbEmitted ||
				prevT.rxBytes < p.rxBytes)) {
			p = null;
			hold = { buf: null, dec: null };
			lossEma = null;
			srG2gEma = null;
		}
		const good = p && dt > 0.25 && dt < 5;

		// The four legs of the journey. Camera comes from the stats line;
		// network is half the measured round trip; buffer and decode are
		// per-frame averages differenced out of the browser's cumulative
		// counters, held at their last value across a tick that emitted no
		// frames rather than flapping to zero.
		const c2s = parseC2s(cam.c2s);
		const net = s.rttMs != null ? s.rttMs / 2 : null;
		if (good) {
			const dEm = prevT.jbEmitted - p.jbEmitted;
			if (dEm > 0) hold.buf = (prevT.jbDelay - p.jbDelay) / dEm * 1000;
			const dFr = prevT.framesDecoded - p.framesDecoded;
			if (dFr > 0) hold.dec = (prevT.decodeTime - p.decodeTime) / dFr * 1000;
		}
		// The screen's wait: measured per presented frame when the probe has
		// fired recently, else half a refresh interval, else unknown — and an
		// unknown share is left OUT of the sum rather than invented, which
		// the "at least" caption already covers.
		const nowMs = performance.now();
		const dispMeasured = dispEmaMs != null && nowMs - dispSeenAt < 3000;
		const disp = dispMeasured ? dispEmaMs
			: refreshMs != null ? refreshMs / 2
			: null;
		const screen = hold.dec != null || disp != null
			? (hold.dec || 0) + (disp || 0)
			: null;
		// The camera leg is the measured pipeline PLUS the parts the frame
		// rate makes knowable. The pipeline measurement cannot contain them:
		// sampling (a scene change waits up to a whole frame interval to be
		// captured at all — half on average, the blinking-LED convention) is
		// before any timestamp exists, and in estimated mode the windowed-min
		// subtraction removes every CONSTANT — sensor readout, the fastest
		// encode — leaving only the variable excess, which is why a bare
		// pipeline figure reads an absurd "camera 2". Readout is budgeted at
		// one frame interval (the feedback's rule of thumb); the
		// kernel-anchored grade measures from the frame-start IRQ, so
		// readout is already inside its number and only sampling is added.
		// The fastest frame's encode share stays invisible in estimated
		// mode — one more reason the headline says "at least".
		const fpsNow = s.fps > 1 ? s.fps : (s.configuredFps || 0);
		const frameT = fpsNow > 0 ? 1000 / fpsNow : null;
		let camMs = c2s ? c2s.ms : null;
		let camModel = null;
		if (camMs != null && frameT != null) {
			const sampling = frameT / 2;
			const readout = c2s.approx ? frameT : 0;
			camModel = { sampling: sampling, readout: readout, pipe: camMs,
				fps: fpsNow };
			camMs += sampling + readout;
		} else if (mse && frameT != null) {
			// Sampling and readout are the sensor's, not the transport's:
			// leaving them off the MSE floor made its headline read LOWER
			// than WebRTC's full-path figure — the comparison inverted.
			// Encode/send stays unmeasurable here, so the floor stays a
			// floor.
			camModel = { sampling: frameT / 2, readout: frameT, pipe: null,
				fps: fpsNow };
			camMs = frameT / 2 + frameT;
		}
		// On MSE the buffer leg is not a per-frame average but the DEPTH the
		// element is sitting on — decoded future waiting to play, the number
		// that separates this transport from WebRTC's jitter buffer. Camera
		// and network legs do not exist here: TCP tells us nothing about
		// either, which is the finding rather than a gap.
		const parts = mse
			? [camMs, null, s.bufferedMs != null ? s.bufferedMs : null, screen]
			: [camMs, net, hold.buf, screen];
		let total = null;
		parts.forEach((v) => { if (v != null) total = (total || 0) + v; });

		// The sender-report cross-check, all in the CAMERA's clock so browser
		// skew cancels. Three facts meet: the camera's sr= anchor pairs an
		// RTP timestamp with its capture wall time (kernel-measured, so the
		// key only exists on anchored cameras — self-gating); the display
		// probe names the frame on the glass by RTP timestamp and the
		// browser-epoch instant it appeared; and remote-outbound-rtp says
		// what time the camera's clock read at its last sender report,
		// against the browser-epoch arrival of that report. Then
		// capture(frame) = anchor_wall + (rtp delta)/90 and camera-now at
		// the display instant = remoteTs + elapsed — their difference is
		// capture→display of the exact frame shown, biased low by one-way
		// network delay (~rtt/2), which the ≈ owns. (The obvious spec route,
		// inbound-rtp.estimatedPlayoutTimestamp, is obsolete and absent from
		// current Chrome — measured, not assumed.)
		if (cam.sr && s.remoteTs != null && s.remoteAt != null &&
			shownFrame && performance.now() - shownFrame.seenAt < 2000) {
			const a = /^(\d+):(\d+)$/.exec(cam.sr);
			if (a) {
				// 32-bit wrap-safe RTP delta, then ticks → ms at 90 kHz.
				const dRtp = (shownFrame.rtp - (+a[1])) | 0;
				const captureCam = (+a[2]) + dRtp / 90;
				const camAtDisplay =
					s.remoteTs + (shownFrame.atEpoch - s.remoteAt);
				const g = camAtDisplay - captureCam;
				if (isFinite(g) && g > 0 && g < 10000) {
					srG2gEma = srG2gEma == null ? g
						: srG2gEma + (g - srG2gEma) / 4;
					srSeenAt = nowMs;
				}
			}
		}
		// A cross-check that stopped updating — the video froze, the anchor
		// or the SR went away — is not a current measurement and must not
		// keep wearing one's label. Forgotten, not merely hidden: an old
		// average blended into a resumed stream would describe neither.
		if (srG2gEma != null && nowMs - srSeenAt > 5000) {
			srG2gEma = null;
		}

		// Prefer the cross-check for the headline only while the two ways of
		// measuring agree — a sum that drifts from an independent whole-path
		// measurement is a diagnostic, not a reason to print the larger lie.
		// The legs keep their own numbers either way; they explain the
		// composition, the headline states the total.
		const srOk = srG2gEma != null && total != null &&
			Math.abs(srG2gEma - total) <= Math.max(150, total * 0.5);
		if (total != null && (net != null || c2s || mse)) {
			const shown = srOk ? srG2gEma : total;
			// '≥' on MSE, honestly: two of the four legs are unmeasurable
			// over TCP, so the real figure can only be larger than this.
			els.lat.textContent = (mse ? '≥' : '≈') + Math.round(shown);
			els.latSub.textContent = mse
				? 'at least — includes the player buffer WebRTC skips'
				: c2s
				? (c2s.approx ? 'glass to glass, at least' : 'glass to glass')
				: 'network + player; the camera’s share is not included';
			window.MjCharts.pushSpark(latSpark, shown);
			// The other transport's last figure, right under this one's:
			// the A/B a screenshot can carry.
			lastSeen[mse ? 'mse' : 'webrtc'] = { ms: shown, at: now };
			const other = lastSeen[mse ? 'webrtc' : 'mse'];
			if (other && now - other.at < 15 * 60 * 1000) {
				// The verdict in numbers, not left to inference: which
				// transport is faster on THIS connection, and by how much.
				const d = Math.round(shown - other.ms);
				const rel = d > 0 ? Math.abs(d) + ' ms lower'
					: d < 0 ? Math.abs(d) + ' ms higher' : 'the same';
				els.vs.hidden = false;
				els.vs.textContent = mse
					? 'WebRTC measured ≈' + Math.round(other.ms) +
						' ms on this connection — ' + rel
					: 'MSE held ≥' + Math.round(other.ms) + ' ms here — ' +
						(d < 0 ? Math.abs(d) + ' ms more than now' : 'buffer-bound');
			} else {
				els.vs.hidden = true;
			}
			// The breakdown renders only with all four legs: three segments
			// that sum to less than the number above them would read as a
			// mistake, not a measurement.
			const all = parts.every((v) => v != null);
			els.bar.hidden = !all;
			els.legend.hidden = !all;
			if (all) {
				els.segCam.style.width = (parts[0] / total * 100) + '%';
				els.segNet.style.width = (parts[1] / total * 100) + '%';
				els.segBuf.style.width = (parts[2] / total * 100) + '%';
				els.segDec.style.width = (parts[3] / total * 100) + '%';
				els.lCam.textContent = Math.round(parts[0]);
				els.lNet.textContent = Math.round(parts[1]);
				els.lBuf.textContent = Math.round(parts[2]);
				els.lDec.textContent = Math.round(parts[3]);
			}
		} else {
			els.lat.textContent = '–';
			els.latSub.textContent = 'measuring…';
			els.bar.hidden = true;
			els.legend.hidden = true;
			els.vs.hidden = true;
		}

		// Loss as a smoothed percentage of the last ticks, not the cumulative
		// count: "0.3% now" answers the grade's question, the total does not.
		if (good) {
			const dLost = Math.max(0, prevT.packetsLost - p.packetsLost);
			const dRecv = Math.max(0, prevT.packetsReceived - p.packetsReceived);
			if (dLost + dRecv > 0) {
				const pct = dLost / (dLost + dRecv) * 100;
				lossEma = lossEma == null ? pct : lossEma + (pct - lossEma) * 0.3;
			}
		}
		// The capacity story, one line per fact so the adaptation reads as a
		// sentence: what the link can carry, what the operator asked for
		// (and where adaptation moved that target), what the encoder
		// actually emits, what arrives.
		const remb = parseInt(cam.remb, 10) || 0;
		const capK = Math.max(s.availKbps || 0, remb);
		// MSE has no loss counter and no round trip — TCP converts both into
		// waiting. So the grade reads the two symptoms this transport CAN
		// show: playback having stalled recently, and the element dropping
		// frames to catch up.
		let gr;
		if (mse) {
			if (good && prevT.stalls > p.stalls) lastStallAt = now;
			const dropRate = good && prevT.totalFrames > p.totalFrames
				? (prevT.droppedFrames - p.droppedFrames) /
					(prevT.totalFrames - p.totalFrames) * 100
				: 0;
			// lastStallAt is 0 until a stall really happened: near page start
			// performance.now() itself is under ten seconds, and an
			// unqualified age test branded every fresh session with a stall
			// it never had. Heavy dropping is playback visibly failing, not
			// "good" — the ladder demotes twice, like the WebRTC grade does.
			const stalled = lastStallAt > 0 && now - lastStallAt < 10000;
			gr = stalled || dropRate > 10 ? ['struggling', WARN]
				: dropRate > 2 ? ['good', OK]
				: ['excellent', OK];
		} else {
			gr = gradeOf(lossEma || 0, s.rttMs || 0, s.jitterMs || 0,
				parseInt(cam.enc, 10) || 0, s.configuredKbps || 0, remb,
				s.kbps || 0);
		}
		els.grade.textContent = gr[0];
		els.grade.style.color = gr[1];
		els.rCap.hidden = !capK;
		if (capK) {
			// A saturated link's estimate approximates capacity; an idle
			// one only proves the link carries at least what arrived.
			const tested = (s.kbps || 0) > 0 && capK < 2 * (s.kbps || 0);
			els.capEst.textContent = (tested ? '≈' : '≥') + fmtK(capK);
		}
		const cfgK = s.configuredKbps;
		const enc = parseInt(cam.enc, 10) || 0;
		els.rSet.hidden = !cfgK && !enc;
		if (enc > 0) {
			// The whole adaptation story on one line: the operator's number
			// and where the camera moved it to fit this link.
			els.set.textContent =
				(cfgK ? fmtK(cfgK) + ' → ' : '') + fmtK(enc) + ' — adapting';
			els.set.style.color = WARN;
		} else if (cfgK) {
			els.set.textContent = fmtK(cfgK);
			els.set.style.color = '';
		}
		const vr = s.channel != null ? vencRate[s.channel] : null;
		els.send.textContent = vr != null ? fmtBps(vr) : '-';
		let recvK = s.kbps || 0;
		if (mse) {
			recvK = good && prevT.rxBytes >= p.rxBytes
				? Math.round((prevT.rxBytes - p.rxBytes) * 8 / 1000 / dt)
				: 0;
		}
		els.recv.textContent = fmtK(recvK) +
			(!mse && s.audioKbps ? ' + audio ' + fmtK(s.audioKbps) : '');
		// No estimate series on MSE: this transport HAS no feedback channel,
		// and an empty legend chip would imply one is merely quiet.
		if (els.legEst) els.legEst.hidden = mse;
		window.MjCharts.pushChart(bwChart, [
			recvK / 1000, !mse && capK ? capK / 1000 : null,
		]);

		// Repairs as rates: recovery working is the good news worth telling.
		// On MSE there is nothing to repair — TCP already repaired it, and
		// the price appears as buffering, which is what gets counted.
		if (good && mse) {
			els.repair.textContent = 're-buffered ' + (s.stalls || 0) +
				'\u00d7 \u00b7 frames dropped ' + (prevT.droppedFrames || 0);
		} else if (good) {
			const rep = [];
			rep.push('lost ' + (lossEma != null ? lossEma.toFixed(1) : '0.0') + '%');
			const dNack = Math.max(0, prevT.nack - p.nack);
			rep.push('re-asked ' + Math.round(dNack / dt) + '/s');
			if (cam.rtx !== undefined) {
				const dRtx = Math.max(0, prevT.rtx - p.rtx);
				rep.push('camera re-sent ' + Math.round(dRtx / dt) + '/s');
			}
			if (s.pli) rep.push('picture restarts ' + s.pli);
			els.repair.textContent = rep.join(' · ');
		}

		// Fine print: the counters the old table carried, for whoever is
		// triaging an issue rather than reading the story.
		const fp = [];
		if (mse) {
			fp.push('transport MSE — fMP4 over WebSocket/TCP · no feedback channel');
			fp.push('buffered ' + (s.bufferedMs != null ? Math.round(s.bufferedMs) : '-') +
				' ms · re-buffered ' + (s.stalls || 0) + '\u00d7 · dropped ' +
				(s.droppedFrames || 0) + ' of ' + (s.totalFrames || 0) + ' frames');
		} else {
			if (cam.ice) fp.push('ice ' + cam.ice + ' · dtls ' + cam.dtls + ' · media ' + cam.media);
			fp.push((cam.remb ? 'estimate ' + cam.remb : 'estimate -') +
				' · rtcp ' + (cam.rtcp || '-') + ' · keyframes ' + (cam.pli || '-'));
			fp.push('jitter ' + (s.jitterMs || 0) + ' ms · round trip ' +
				(s.rttMs != null ? s.rttMs + ' ms' : '-') +
				' · audio in ' + (cam['audio-in'] || '-'));
		}
		if (srG2gEma != null) {
			fp.push('end-to-end via sender report ' + Math.round(srG2gEma) +
				' ms' + (srOk ? ' — headline' : ' — diverges from leg sum ' +
				(total != null ? Math.round(total) : '-') + ' ms'));
		}
		if (camModel) {
			fp.push('camera @' + Math.round(camModel.fps) + ' fps: sampling ~' +
				Math.round(camModel.sampling) + ' ms (\u00bd frame)' +
				(camModel.readout ? ' + readout ~' + Math.round(camModel.readout) + ' ms' : '') +
				(camModel.pipe != null
					? ' + pipeline ' + camModel.pipe + ' ms'
					: ' + encode/send unmeasured over MSE'));
		}
		if (hold.dec != null || disp != null || refreshMs != null) {
			const parts2 = [];
			if (hold.dec != null) parts2.push('decode ' + hold.dec.toFixed(1) + ' ms');
			if (disp != null) parts2.push('screen wait ' +
				disp.toFixed(1) + ' ms' + (dispMeasured ? '' : ' (est.)'));
			if (refreshMs != null) parts2.push('display ' +
				Math.round(1000 / refreshMs) + ' Hz');
			fp.push(parts2.join(' · '));
		}
		fp.push(mse ? 'talkback unavailable — MSE carries one direction'
			: 'talkback ' + (s.micWanted
				? (s.micSending ? 'sending' : 'offered, not accepted') +
					' · ' + (s.micPackets || 0) + ' pkt'
				: 'off'));
		els.fp.textContent = fp.join('\n');
	}

	// ── the 2 s /metrics heartbeat ──────────────────────────────────────────

	function egRow(rows, label, val) {
		const r = document.createElement('div');
		r.className = 'mj-ns-row';
		const k = document.createElement('span'); k.textContent = label;
		const b = document.createElement('b'); b.textContent = val;
		r.appendChild(k); r.appendChild(b);
		rows.appendChild(r);
	}

	function onMetrics(s) {
		if (!els || !s.ok) return;
		const v = s.m.v;
		const pv = s.prev && s.dt > 0 ? s.prev.v : null;
		const rate = (k) => pv && k in v && k in pv && v[k] >= pv[k]
			? (v[k] - pv[k]) / s.dt : null;

		// What each encoder channel actually produced, for the tick side's
		// "camera sending" row — the measured rate, not the configured
		// ceiling.
		vencRate[0] = rate('venc0_rcvd_bytes');
		vencRate[1] = rate('venc1_rcvd_bytes');

		// Radio: words first, the dBm beside them. Rows vanish on a wired
		// camera rather than standing full of dashes. Presence is judged
		// across the whole wifi_* family and the grade falls back to the
		// driver's relative link quality when no real dBm is reported —
		// the same row-by-row degradation the dashboard's Network card
		// does, with its thresholds.
		const hasWifi = ['wifi_rssi_dbm', 'wifi_link_quality_ratio',
			'wifi_bitrate_mbps', 'wifi_retries_total',
			'wifi_missed_beacons_total'].some((k) => k in v);
		els.radio.hidden = !hasWifi;
		if (hasWifi) {
			const r = ('wifi_rssi_dbm' in v) ? v.wifi_rssi_dbm : null;
			const q = ('wifi_link_quality_ratio' in v)
				? v.wifi_link_quality_ratio : null;
			const g = r != null
				? (r >= -60 ? ['good', OK] : r >= -75 ? ['fair', WARN]
					: ['weak', BAD])
				: q != null
				? (q >= 70 ? ['good', OK] : q >= 40 ? ['fair', WARN]
					: ['weak', BAD])
				: null;
			els.wifi.textContent =
				(r != null ? r + ' dBm' : q != null ? 'quality ' + q + ' %' : '–') +
				(g ? ' · ' + g[0] : '');
			els.wifi.style.color = g ? g[1] : '';
			els.rWrate.hidden = !('wifi_bitrate_mbps' in v);
			if (!els.rWrate.hidden)
				els.wrate.textContent = v.wifi_bitrate_mbps + ' Mb/s';
			const retr = rate('wifi_retries_total');
			els.rWretr.hidden = retr == null;
			if (retr != null) els.wretr.textContent = retr.toFixed(1) + '/s';
			if (r != null) window.MjCharts.pushSpark(rssiSpark, r);
		}

		// Egress: who else is eating the uplink. Counts come from the new
		// consumer gauges; rates from their byte counters where they exist.
		// A consumer with nobody on it gets no row — the section lists who
		// IS being served, and a ladder of zeros said nothing — and an older
		// majestic has none of these keys, hiding the section outright.
		const rows = [];
		const consumer = (key, label, byteKey) => {
			if (!v[key]) return;
			const rt = byteKey ? rate(byteKey) : null;
			rows.push([label + ' × ' + v[key], rt != null ? fmtBps(rt) : '']);
		};
		consumer('webrtc_sessions_total', 'WebRTC', 'webrtc_tx_bytes');
		consumer('rtsp_clients_total', 'RTSP', 'rtsp_tx_bytes');
		consumer('outgoing_streams_total', 'Outgoing push', 'outgoing_tx_bytes');
		consumer('ws_video_clients_total', 'Browser (MSE)', null);
		consumer('hls_clients_total', 'HLS', null);
		els.egress.hidden = !rows.length;
		if (rows.length) {
			const dEnc = rate('venc0_rcvd_bytes');
			const dEnc1 = rate('venc1_rcvd_bytes');
			if (dEnc != null)
				rows.push(['encoder producing', fmtBps(dEnc + (dEnc1 || 0))]);
			if (pv && s.tx >= s.prev.tx)
				rows.push(['total leaving camera', fmtBps((s.tx - s.prev.tx) / s.dt)]);
			els.egRows.textContent = '';
			rows.forEach((r) => egRow(els.egRows, r[0], r[1]));
		}
	}

	// ── page wiring ─────────────────────────────────────────────────────────

	function reset() {
		prevT = null;
		lastTickAt = 0;
		hold = { buf: null, dec: null };
		lossEma = null;
		srG2gEma = null;
		// A stall belongs to the session that stalled; without this a real
		// stall bled through an MSE→WebRTC→MSE round trip and branded the
		// new session too. (lastSeen stays — the comparison line is the one
		// thing that is SUPPOSED to outlive a switch.)
		lastStallAt = 0;
	}

	function setOpen(o) {
		open = !!o;
		// Pixel-space charts skip rendering while [hidden] leaves them 0
		// wide; the first frame after opening is when they can measure.
		if (open && window.MjCharts)
			requestAnimationFrame(() => window.MjCharts.renderAll());
	}

	return { tick: tick, reset: reset, setOpen: setOpen };
})();
