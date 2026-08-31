// preview-stats.js — the Live View network-story panel's arithmetic, driven
// against stub DOM and stub charts.
//
// What must hold, in one sentence each: an absent camera key degrades its row
// to '-' or hides it rather than breaking the panel; the delay legs are
// differenced out of cumulative counters and the breakdown only renders
// complete; the two clocks never contaminate each other; and reset() forgets
// the dead session's baselines so the next session's first tick prints no
// nonsense rates.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

// group() only prints a heading; this runs the block under it.
const g = (name, fn) => { group(name); fn(); };



const SRC = path.join(__dirname, '..', 'www', 'a', 'preview-stats.js');

function makeEl(id) {
	let text = '';
	return {
		id: id || '', style: {}, hidden: false, className: '',
		_kids: [],
		appendChild(k) { this._kids.push(k); },
		// Like the real DOM: textContent stringifies whatever is assigned.
		set textContent(v) { text = String(v); },
		get textContent() { return text; },
		set innerHTML(_) { /* template paint; ids resolve via getElementById */ },
		get innerHTML() { return ''; },
	};
}

function boot(nowStart) {
	const els = Object.create(null);
	let nowMs = nowStart != null ? nowStart : 100000;
	const pushedSparks = [], pushedCharts = [];
	let metricsFn = null;
	const sandbox = {
		window: {},
		performance: { now: () => nowMs, timeOrigin: 0 },
		requestAnimationFrame: (f) => f(),
		document: {
			getElementById(id) { return els[id] || (els[id] = makeEl(id)); },
			createElement(tag) { return makeEl(''); },
		},
		mjMetricsSubscribe(fn) { metricsFn = fn; },
		console,
	};
	sandbox.window.MjCharts = {
		makeSpark: () => ({ spark: true }),
		pushSpark: (s, y) => pushedSparks.push(y),
		makeChart: () => ({ chart: true }),
		pushChart: (c, vals) => pushedCharts.push(vals),
		renderAll: () => {},
	};
	vm.createContext(sandbox);
	vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox);
	return {
		stats: sandbox.window.MajesticStats,
		el: (id) => els[id],
		tickClock: (ms) => { nowMs += ms; },
		metrics: (s) => metricsFn && metricsFn(s),
		mkEl: (id) => sandbox.document.getElementById(id),
		pushedSparks, pushedCharts,
	};
}

g('degradation: an old majestic and a young session claim nothing', () => {
	const env = boot();
	env.stats.tick({ cam: {} });
	check('no measurements yet leaves the headline unclaimed',
		env.el('mj-ns-lat').textContent === '–');
	check('the breakdown stays hidden', env.el('mj-ns-bar').hidden === true);
	check('an absent enc= renders as -', env.el('mj-ns-send').textContent === '-');
	check('no capacity estimate hides its row', env.el('mj-ns-r-cap').hidden === true);
});

g('the delay legs sum, and the caption says what the number is', () => {
	const env = boot();
	// First tick sets baselines; no deltas exist yet.
	env.stats.tick({ cam: { c2s: '~40ms' }, rttMs: 60,
		jbDelay: 10, jbEmitted: 100, decodeTime: 1, framesDecoded: 100 });
	check('camera + network alone already make a total',
		env.el('mj-ns-lat').textContent === '≈' + Math.round(40 + 30));
	check('an estimated camera share is captioned as a floor',
		env.el('mj-ns-lat-sub').textContent.indexOf('at least') >= 0);
	check('three legs of four keep the breakdown hidden',
		env.el('mj-ns-bar').hidden === true);
	// One second on: 50 frames through the buffer at 2 ms each, decoded at 1 ms.
	env.tickClock(1000);
	env.stats.tick({ cam: { c2s: '40ms' }, rttMs: 60,
		jbDelay: 10.1, jbEmitted: 150, decodeTime: 1.05, framesDecoded: 150 });
	check('a measured camera share drops the hedge',
		env.el('mj-ns-lat-sub').textContent === 'glass to glass');
	check('all four legs render the breakdown', env.el('mj-ns-bar').hidden === false);
	check('buffer leg is the per-frame average of the delta',
		env.el('mj-ns-l-buf').textContent === '2');
	check('decode leg likewise', env.el('mj-ns-l-dec').textContent === '1');
	check('total is the sum of the legs',
		env.el('mj-ns-lat').textContent === '≈' + Math.round(40 + 30 + 2 + 1));
});

g('no camera share: the caption owns up instead of guessing', () => {
	const env = boot();
	env.stats.tick({ cam: {}, rttMs: 80 });
	check('network half still gives a number',
		env.el('mj-ns-lat').textContent === '≈40');
	check('and says the camera is not in it',
		env.el('mj-ns-lat-sub').textContent.indexOf('camera') >= 0);
});

g('capacity story and adaptation coloring', () => {
	const env = boot();
	env.stats.tick({ cam: { remb: '2500kbps', enc: '1800' },
		configuredKbps: 4096, kbps: 1700, availKbps: 2200, channel: 1 });
	check('link estimate takes the larger of the two ends',
		env.el('mj-ns-cap-est').textContent === '≈2.5 Mbit/s');
	check('adaptation reads as set → adapted on the set row',
		env.el('mj-ns-set').textContent === '4.1 Mbit/s → 1.8 Mbit/s — adapting');
	check('adapting alone caps the grade at good',
		env.el('mj-ns-grade').textContent === 'good');
	check('no measured encoder rate yet claims nothing',
		env.el('mj-ns-send').textContent === '-');
	// The 2 s heartbeat delivers the measured rate; the next tick shows it.
	env.metrics({ ok: true, dt: 2, tx: 0,
		m: { v: { venc1_rcvd_bytes: 500000 } },
		prev: { tx: 0, v: { venc1_rcvd_bytes: 250000 } } });
	env.tickClock(1000);
	env.stats.tick({ cam: { enc: '0' }, configuredKbps: 4096, kbps: 900, channel: 1 });
	check('camera sending is the measured rate, not the ceiling',
		env.el('mj-ns-send').textContent === '1.0 Mbit/s');
	check('enc=0 shows the configured target uncolored',
		env.el('mj-ns-set').textContent === '4.1 Mbit/s');
});

g('a crushed link grades struggling even with clean loss', () => {
	// The stream is testing the link (estimate under 2× delivered), and the
	// link carries under half the configured target: real congestion.
	const env = boot();
	env.stats.tick({ cam: { remb: '400kbps', enc: '512' },
		configuredKbps: 1024, kbps: 350, rttMs: 58, channel: 1 });
	check('capacity below half the configured target is struggling',
		env.el('mj-ns-grade').textContent === 'struggling');
	check('a tested estimate reads as approximately capacity',
		env.el('mj-ns-cap-est').textContent === '≈400 kbit/s');
});

g('a high idle browser estimate cannot mask a binding camera one', () => {
	// The camera's remb (400) is what adaptation acts on and it is genuinely
	// binding against 350 kbit/s delivered; the browser's idle 2500 must not
	// launder the grade back to excellent.
	const env = boot();
	env.stats.tick({ cam: { remb: '400kbps', enc: '512' },
		configuredKbps: 1024, kbps: 350, availKbps: 2500, rttMs: 20, channel: 1 });
	check('the binding camera estimate wins the grade',
		env.el('mj-ns-grade').textContent === 'struggling');
	check('while the display row honestly shows the larger figure as a floor',
		env.el('mj-ns-cap-est').textContent === '≥2.5 Mbit/s');
});

g('nothing delivered means nothing tested', () => {
	const env = boot();
	env.stats.tick({ cam: { remb: '2kbps', enc: '512' },
		configuredKbps: 1024, kbps: 0, rttMs: 5, channel: 1 });
	check('a stopped stream cannot grade struggling off a tiny estimate',
		env.el('mj-ns-grade').textContent === 'excellent');
	check('and its estimate renders as a floor',
		env.el('mj-ns-cap-est').textContent === '≥2 kbit/s');
});

g('an idling estimate cannot call a LAN struggling', () => {
	// Quiet scene on a wired LAN: the stream sends a trickle, the estimator
	// idles at a small multiple of it, a transient bind drags enc down —
	// none of which is evidence about the link. Loss 0, rtt tiny:
	// excellent, whatever the estimator mumbles.
	const env = boot();
	env.stats.tick({ cam: { remb: '1250kbps', enc: '1250' },
		configuredKbps: 4096, kbps: 500, rttMs: 5, channel: 0 });
	check('grade stays excellent on a LAN with a quiet scene',
		env.el('mj-ns-grade').textContent === 'excellent');
	check('an idle estimate is shown as a floor, not capacity',
		env.el('mj-ns-cap-est').textContent === '≥1.3 Mbit/s');
});

g('grade words move on loss and round trip', () => {
	const env = boot();
	env.stats.tick({ cam: {}, rttMs: 20, packetsLost: 0, packetsReceived: 1000 });
	check('a clean link is excellent', env.el('mj-ns-grade').textContent === 'excellent');
	env.tickClock(1000);
	env.stats.tick({ cam: {}, rttMs: 600, packetsLost: 0, packetsReceived: 2000 });
	check('a half-second round trip is poor', env.el('mj-ns-grade').textContent === 'poor');
});

g('reset forgets the dead session', () => {
	const env = boot();
	env.stats.tick({ cam: {}, packetsLost: 0, packetsReceived: 1000, nack: 0 });
	env.tickClock(1000);
	env.stats.tick({ cam: {}, packetsLost: 100, packetsReceived: 1100, nack: 5, rttMs: 10 });
	check('loss registered before the switch',
		env.el('mj-ns-grade').textContent !== 'excellent');
	env.stats.reset();
	env.tickClock(1000);
	// New session, counters restarted from zero — without the reset this
	// would difference against the old session's totals.
	env.stats.tick({ cam: {}, packetsLost: 0, packetsReceived: 50, rttMs: 10 });
	env.tickClock(1000);
	env.stats.tick({ cam: {}, packetsLost: 0, packetsReceived: 100, rttMs: 10 });
	check('the new session starts clean',
		env.el('mj-ns-grade').textContent === 'excellent');
});

g('the camera leg carries sampling and readout once fps is known', () => {
	// 20 fps → 50 ms frame interval. Estimated pipeline (~2 ms) gains the
	// mean sampling wait (25) and a one-frame readout budget (50): 77. The
	// kernel-anchored grade measures from the frame-start IRQ, so only
	// sampling is added: 27.
	const env = boot();
	env.stats.tick({ cam: { c2s: '~2ms' }, rttMs: 60, fps: 20 });
	check('estimated mode adds sampling + readout',
		env.el('mj-ns-l-cam').textContent === '' ||
		env.el('mj-ns-lat').textContent === '≈' + Math.round(2 + 25 + 50 + 30));
	check('fine print decomposes the camera leg',
		env.el('mj-ns-fp').textContent.indexOf(
			'camera @20 fps: sampling ~25 ms (½ frame) + readout ~50 ms + pipeline 2 ms') >= 0);
	const env2 = boot();
	env2.stats.tick({ cam: { c2s: '2ms' }, rttMs: 60, fps: 20 });
	check('kernel-anchored mode adds sampling only',
		env2.el('mj-ns-lat').textContent === '≈' + Math.round(2 + 25 + 30));
	check('and its fine print shows no readout term',
		env2.el('mj-ns-fp').textContent.indexOf('readout') < 0 &&
		env2.el('mj-ns-fp').textContent.indexOf('sampling ~25 ms') >= 0);
	// Without any fps the model stays out rather than guessing.
	const env3 = boot();
	env3.stats.tick({ cam: { c2s: '~2ms' }, rttMs: 60 });
	check('no fps, no model — the bare pipeline stands',
		env3.el('mj-ns-lat').textContent === '≈' + Math.round(2 + 30));
});

g('the sender-report cross-check: one clock, both ends', () => {
	// The camera's sr= anchor says RTP 900000 was captured at camera-clock
	// 5,000,000 ms. The frame on the glass is RTP 1,080,000 — 2000 ms of
	// 90 kHz later — so it was captured at 5,002,000. The camera's clock
	// read 5,002,000 at its last SR (browser epoch 100,000), and the frame
	// appeared at browser epoch 100,160 → camera-now 5,002,160. The frame
	// on the glass is 160 ms old; the leg sum (58+30) agrees within
	// tolerance, so the whole-path figure takes the headline.
	const env = boot();
	const v = env.mkEl('live-video');
	v.hidden = false;
	let vfc = null;
	v.requestVideoFrameCallback = (fn) => { vfc = fn; };
	env.stats.tick({ cam: { c2s: '58ms', sr: '900000:5000000' }, rttMs: 60,
		remoteTs: 5002000, remoteAt: 100000 });
	vfc(0, { expectedDisplayTime: 100160, presentationTime: 100150,
		rtpTimestamp: 1080000 });
	env.tickClock(500);
	env.stats.tick({ cam: { c2s: '58ms', sr: '900000:5000000' }, rttMs: 60,
		remoteTs: 5002000, remoteAt: 100000 });
	check('the SR figure takes the headline when the two agree',
		env.el('mj-ns-lat').textContent === '≈160');
	check('and the fine print names it as the headline source',
		env.el('mj-ns-fp').textContent.indexOf(
			'end-to-end via sender report 160 ms — headline') >= 0);

	// Divergent: a frame a full second old against a ~100 ms leg sum (58
	// camera + 30 network + the probe's own 10 ms screen wait) stays a
	// diagnostic and leaves the sum on the headline.
	const env2 = boot();
	const v2 = env2.mkEl('live-video');
	v2.hidden = false;
	let vfc2 = null;
	v2.requestVideoFrameCallback = (fn) => { vfc2 = fn; };
	env2.stats.tick({ cam: { c2s: '58ms', sr: '900000:5000000' }, rttMs: 60,
		remoteTs: 5002000, remoteAt: 100000 });
	vfc2(0, { expectedDisplayTime: 101000, presentationTime: 100990,
		rtpTimestamp: 1080000 });
	env2.tickClock(500);
	env2.stats.tick({ cam: { c2s: '58ms', sr: '900000:5000000' }, rttMs: 60,
		remoteTs: 5002000, remoteAt: 100000 });
	check('a divergent SR figure leaves the sum on the headline',
		env2.el('mj-ns-lat').textContent === '≈98');
	check('and is disclosed as diverging',
		env2.el('mj-ns-fp').textContent.indexOf('diverges from leg sum 98 ms') >= 0);

	// No sr= key — an estimated camera never emits one — no figure at all,
	// however many browser-side pieces exist.
	const env3 = boot();
	const v3 = env3.mkEl('live-video');
	v3.hidden = false;
	let vfc3 = null;
	v3.requestVideoFrameCallback = (fn) => { vfc3 = fn; };
	env3.stats.tick({ cam: { c2s: '~58ms' }, rttMs: 60,
		remoteTs: 5002000, remoteAt: 100000 });
	vfc3(0, { expectedDisplayTime: 100160, presentationTime: 100150,
		rtpTimestamp: 1080000 });
	env3.tickClock(500);
	env3.stats.tick({ cam: { c2s: '~58ms' }, rttMs: 60,
		remoteTs: 5002000, remoteAt: 100000 });
	check('no anchor key, no SR figure',
		env3.el('mj-ns-fp').textContent.indexOf('sender report') < 0);

	// Staleness: six seconds without a new sample forgets the figure — a
	// frozen stream must not wear a current measurement's label. (The
	// screen-wait sample ages out on its own 3 s window too, so the sum
	// left standing is camera 58 + network 30.)
	env.tickClock(6000);
	env.stats.tick({ cam: { c2s: '58ms', sr: '900000:5000000' }, rttMs: 60,
		remoteTs: 5002000, remoteAt: 100000 });
	check('a stale cross-check is forgotten, headline falls back to the sum',
		env.el('mj-ns-fp').textContent.indexOf('sender report') < 0 &&
		env.el('mj-ns-lat').textContent === '≈88');
});

g('the screen leg: measured vsync wait joins decode', () => {
	const env = boot();
	// Give the video element a requestVideoFrameCallback the test can fire.
	let vfc = null;
	const v = env.mkEl('live-video');
	v.hidden = false;
	v.requestVideoFrameCallback = (fn) => { vfc = fn; };
	// Two ticks build the decode delta (1 ms/frame), then the probe reports
	// an 8 ms compositor+vsync wait. All four legs present so the breakdown
	// renders.
	env.stats.tick({ cam: { c2s: '40ms' }, rttMs: 60,
		jbDelay: 10, jbEmitted: 100, decodeTime: 1, framesDecoded: 100 });
	vfc(0, { expectedDisplayTime: 108, presentationTime: 100 });
	env.tickClock(1000);
	env.stats.tick({ cam: { c2s: '40ms' }, rttMs: 60,
		jbDelay: 10.1, jbEmitted: 150, decodeTime: 1.05, framesDecoded: 150 });
	check('screen leg is decode plus the measured wait',
		env.el('mj-ns-l-dec').textContent === '9');
	check('fine print splits decode from screen wait and is not an estimate',
		env.el('mj-ns-fp').textContent.indexOf('decode 1.0 ms') >= 0 &&
		env.el('mj-ns-fp').textContent.indexOf('screen wait 8.0 ms') >= 0 &&
		env.el('mj-ns-fp').textContent.indexOf('(est.)') < 0);
	// A hidden element (the swap's staging player) must not feed the probe.
	const env2 = boot();
	const v2 = env2.mkEl('live-video');
	let vfc2 = null;
	v2.hidden = true;
	v2.requestVideoFrameCallback = (fn) => { vfc2 = fn; };
	env2.stats.tick({ cam: {}, rttMs: 60 });
	vfc2(0, { expectedDisplayTime: 150, presentationTime: 100 });
	env2.tickClock(1000);
	env2.stats.tick({ cam: {}, rttMs: 60 });
	check('a hidden element\'s frames are ignored',
		env2.el('mj-ns-fp').textContent.indexOf('screen wait') < 0);
	// The swap machinery hides the spare with style.display, not [hidden].
	const env3 = boot();
	const v3 = env3.mkEl('live-video');
	let vfc3 = null;
	v3.hidden = false;
	v3.style.display = 'none';
	v3.requestVideoFrameCallback = (fn) => { vfc3 = fn; };
	env3.stats.tick({ cam: {}, rttMs: 60 });
	vfc3(0, { expectedDisplayTime: 150, presentationTime: 100 });
	env3.tickClock(1000);
	env3.stats.tick({ cam: {}, rttMs: 60 });
	check('a display-none element\'s frames are ignored too',
		env3.el('mj-ns-fp').textContent.indexOf('screen wait') < 0);
});

g('a rebuilt connection is noticed by its counters going backwards', () => {
	// preview-webrtc reconnects internally without the page's transport
	// switch, so no reset() arrives — the regression IS the signal.
	const env = boot();
	env.stats.tick({ cam: {}, rttMs: 10, packetsLost: 0, packetsReceived: 5000 });
	env.tickClock(1000);
	env.stats.tick({ cam: {}, rttMs: 10, packetsLost: 400, packetsReceived: 5400 });
	check('heavy loss registered on the old connection',
		env.el('mj-ns-grade').textContent === 'poor');
	env.tickClock(1000);
	// New connection: counters restarted near zero. Without the regression
	// check this tick would difference 50 against 5400.
	env.stats.tick({ cam: {}, rttMs: 10, packetsLost: 0, packetsReceived: 50 });
	env.tickClock(1000);
	env.stats.tick({ cam: {}, rttMs: 10, packetsLost: 0, packetsReceived: 100 });
	check('the rebuilt connection grades on its own history',
		env.el('mj-ns-grade').textContent === 'excellent');
});

g('radio degrades row by row like the dashboard', () => {
	const env = boot();
	env.stats.tick({ cam: {} });
	// Quality-only camera: the section mounts and the grade uses quality.
	env.metrics({ ok: true, dt: 2, tx: 0,
		m: { v: { wifi_link_quality_ratio: 93 } }, prev: { tx: 0, v: {} } });
	check('quality alone keeps the section and grades it',
		env.el('mj-ns-radio').hidden === false &&
		env.el('mj-ns-wifi').textContent === 'quality 93 % · good');
	// Bitrate-only camera: still worth a section.
	const env2 = boot();
	env2.stats.tick({ cam: {} });
	env2.metrics({ ok: true, dt: 2, tx: 0,
		m: { v: { wifi_bitrate_mbps: 72.2 } }, prev: { tx: 0, v: {} } });
	check('bitrate alone still mounts the radio section',
		env2.el('mj-ns-radio').hidden === false);
});

g('the 2 s heartbeat: radio and egress rows', () => {
	const env = boot();
	env.stats.tick({ cam: {} }); // mounts the panel and wires the subscription
	env.metrics({ ok: true, dt: 2, tx: 3000, m: { v: {} }, prev: { tx: 1000, v: {} } });
	check('no wifi metrics hides the radio section',
		env.el('mj-ns-radio').hidden === true);
	check('no consumer metrics hides the egress section',
		env.el('mj-ns-egress').hidden === true);
	env.metrics({
		ok: true, dt: 2, tx: 3000,
		m: { v: { wifi_rssi_dbm: -48, wifi_bitrate_mbps: 72.2, wifi_retries_total: 10,
			webrtc_sessions_total: 1, webrtc_tx_bytes: 1000000,
			rtsp_clients_total: 2, rtsp_tx_bytes: 2000000,
			outgoing_streams_total: 0, hls_clients_total: 0,
			ws_video_clients_total: 0 } },
		prev: { tx: 1000, v: { wifi_retries_total: 6,
			webrtc_tx_bytes: 0, rtsp_tx_bytes: 0 } },
	});
	check('wifi row words the signal',
		env.el('mj-ns-wifi').textContent === '-48 dBm · good');
	check('retry rate is a per-second delta',
		env.el('mj-ns-wretr').textContent === '2.0/s');
	check('egress section mounts with consumer counts',
		env.el('mj-ns-egress').hidden === false);
	// Zero-count consumers get no row at all — the section lists who IS
	// being served.
	const rowsAll = env.el('mj-ns-eg-rows')._kids.map((k) => k._kids[0].textContent);
	check('a zero-count consumer gets no row',
		rowsAll.every((t) => t.indexOf('× 0') < 0));
	check('nonzero consumers each keep theirs',
		rowsAll.some((t) => t === 'WebRTC × 1') && rowsAll.some((t) => t === 'RTSP × 2'));
});

g('MSE tells its own story and remembers the other transport', () => {
	const env = boot();
	// A WebRTC session settles at ≈88 (58 camera + 30 network)…
	env.stats.tick({ cam: { c2s: '58ms' }, rttMs: 60, transport: 'webrtc' });
	check('webrtc headline first', env.el('mj-ns-lat').textContent === '≈88');
	check('no comparison line before the other transport ran',
		env.el('mj-ns-vs').hidden === true);
	// …the person switches transports (the page resets the module)…
	env.stats.reset();
	env.tickClock(2000);
	// …and MSE reports an 800 ms buffer.
	env.stats.tick({ transport: 'mse', bufferedMs: 800, rxBytes: 100000,
		totalFrames: 100, droppedFrames: 0, stalls: 0,
		configuredKbps: 1024, channel: 1 });
	check('MSE headline is a floor, buffer-led',
		env.el('mj-ns-lat').textContent === '≥800');
	check('and says what the floor means in plain speech',
		env.el('mj-ns-lat-sub').textContent ===
			'at least — includes the player buffer WebRTC skips');
	check('the comparison line carries the WebRTC figure',
		env.el('mj-ns-vs').hidden === false &&
		env.el('mj-ns-vs').textContent.indexOf('WebRTC measured ≈88 ms') >= 0);
	check('no capacity row without a feedback channel',
		env.el('mj-ns-r-cap').hidden === true);
	check('the estimate legend chip is gone too',
		env.el('mj-ns-leg-est').hidden === true);
	check('MSE fine print names the transport and the buffer',
		env.el('mj-ns-fp').textContent.indexOf('transport MSE') >= 0 &&
		env.el('mj-ns-fp').textContent.indexOf('buffered 800 ms') >= 0);
	check('talkback is honestly one-way',
		env.el('mj-ns-fp').textContent.indexOf('one direction') >= 0);

	// Rates and the stall grade need a second tick.
	env.tickClock(1000);
	env.stats.tick({ transport: 'mse', bufferedMs: 900, rxBytes: 228000,
		totalFrames: 120, droppedFrames: 0, stalls: 1,
		configuredKbps: 1024, channel: 1 });
	check('delivered rate is the socket byte delta',
		env.el('mj-ns-recv').textContent === '1.0 Mbit/s');
	check('a fresh stall grades struggling',
		env.el('mj-ns-grade').textContent === 'struggling');
	check('repairs count the re-buffering',
		env.el('mj-ns-repair').textContent.indexOf('re-buffered 1×') >= 0);

	// Heavy dropping is visible failure, not "good".
	env.tickClock(1000);
	env.stats.tick({ transport: 'mse', bufferedMs: 900, rxBytes: 300000,
		totalFrames: 160, droppedFrames: 20, stalls: 1,
		configuredKbps: 1024, channel: 1 });
	check('a heavy drop rate grades struggling',
		env.el('mj-ns-grade').textContent === 'struggling');

	// Back on WebRTC, the MSE figure becomes the comparison.
	env.stats.reset();
	env.tickClock(2000);
	env.stats.tick({ cam: { c2s: '58ms' }, rttMs: 60, transport: 'webrtc' });
	check('the WebRTC view remembers what MSE held',
		env.el('mj-ns-vs').hidden === false &&
		env.el('mj-ns-vs').textContent.indexOf('MSE held ≥900 ms') >= 0);

	// The stall stays with the session that stalled: after the round trip a
	// fresh MSE session is judged on its own record.
	env.stats.reset();
	env.tickClock(2000);
	env.stats.tick({ transport: 'mse', bufferedMs: 300, rxBytes: 400000,
		totalFrames: 200, droppedFrames: 20, stalls: 1,
		configuredKbps: 1024, channel: 1 });
	env.tickClock(1000);
	env.stats.tick({ transport: 'mse', bufferedMs: 300, rxBytes: 500000,
		totalFrames: 230, droppedFrames: 20, stalls: 1,
		configuredKbps: 1024, channel: 1 });
	check('a prior session\'s stall does not brand the new one',
		env.el('mj-ns-grade').textContent === 'excellent');
});

g('MSE counts the sensor legs once fps is known', () => {
	// 20 fps → sampling 25 + readout 50 join the 800 ms buffer: the floor
	// measures a journey comparable to WebRTC's, and reads honestly worse.
	const env = boot();
	env.stats.tick({ transport: 'mse', bufferedMs: 800, rxBytes: 100000,
		totalFrames: 100, droppedFrames: 0, stalls: 0,
		configuredKbps: 1024, configuredFps: 20, channel: 1 });
	check('the floor carries sampling + readout + buffer',
		env.el('mj-ns-lat').textContent === '≥875');
	check('fine print admits what stays unmeasured',
		env.el('mj-ns-fp').textContent.indexOf('encode/send unmeasured over MSE') >= 0);
});

g('the comparison line states the delta outright', () => {
	const env = boot();
	env.stats.tick({ cam: { c2s: '58ms' }, rttMs: 60, transport: 'webrtc' });
	env.stats.reset();
	env.tickClock(2000);
	env.stats.tick({ transport: 'mse', bufferedMs: 800, rxBytes: 100000,
		totalFrames: 100, droppedFrames: 0, stalls: 0,
		configuredKbps: 1024, configuredFps: 20, channel: 1 });
	check('MSE quotes WebRTC with the difference in its favor',
		env.el('mj-ns-vs').textContent ===
			'WebRTC measured ≈88 ms on this connection — 787 ms lower');
});

g('a fresh page never invents a stall', () => {
	// performance.now() is under ten seconds for the page's first ten
	// seconds; a zero lastStallAt must not read as a recent stall.
	const env = boot(500);
	env.stats.tick({ transport: 'mse', bufferedMs: 300, rxBytes: 100000,
		totalFrames: 100, droppedFrames: 0, stalls: 0,
		configuredKbps: 1024, channel: 1 });
	env.tickClock(1000);
	env.stats.tick({ transport: 'mse', bufferedMs: 300, rxBytes: 200000,
		totalFrames: 130, droppedFrames: 0, stalls: 0,
		configuredKbps: 1024, channel: 1 });
	check('zero stalls near page start grade excellent',
		env.el('mj-ns-grade').textContent === 'excellent');
});

done('preview-stats');
