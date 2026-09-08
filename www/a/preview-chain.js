// The fallback chain, shared by the Live View page and the settings preview so
// a fix lands in one place.
//
// A picture reaches the browser by whichever of these works, tried in order:
//
//     WebRTC -> MSE -> [software decode] -> (the caller's floor)
//
// The middle step is load-bearing rather than tidy. WebRTC negotiates and can
// therefore fail where MSE cannot: Firefox's WebRTC stack offers only H.264
// Baseline whatever its decoder can do, so a camera on `profile: main` has
// nothing to give it — the same browser plays that stream over MSE without
// complaint. A player reporting a failure is asking for the next rung, not for
// the floor. The third rung is not a transport and gets no radio: it is the
// same /ws/video bytes the MSE player just failed on, decoded in WebAssembly
// instead of by the browser — so a transport picker goes on naming the
// transport exactly once, and a codec problem never touches a remembered
// preference.
//
// Two rungs down from MSE are decided by rules in preview-transport.js
// (softwareRungFor, softwareRungForCodec) and read through it here, never off
// the decoder module directly: the tests that drive the Live page switch those
// gates from a stub, and a walk that asked the decoder itself would answer a
// different question from the one the page was asked.
//
// The software rung carries a reconnect ladder of its own. A pinned worker
// older than hevc-wasm@v0.1.1 gives up on the FIRST dropped socket, and
// reading that one `unreachable` as "software decode is done" fell to the floor
// with no way back — the #288 dead-end, where a transient blip stranded a
// working H.265 preview until the tab was reloaded. So a wasm socket drop is
// retried a bounded few times, with a growing wait, before the caller's floor.
// It cannot loop: only a socket drop reports `unreachable`; a codec the decoder
// cannot take reports `codec-changed`, a missing decoder `decoder-unavailable`,
// and both terminate the walk instead. The budget is refilled by proof of
// sustained decode — frames actually decoded on a live software session — and
// never by the mere codec announcement, so a decoder that announces itself and
// immediately drops still exhausts rather than resetting on every attempt. It
// is not refilled by a channel or source change either (#288).
//
// A channel change can change the CODEC, and the failure that put the chain on
// a rung was about the channel just left. `codec-changed` is therefore not the
// chain running out but a different question, asked again from wherever the
// caller says the chain starts: an H.264 substream may well play natively, and
// falling to the floor there would hand the viewer the worst option available
// for a stream the browser decodes perfectly.
//
// Why one copy. Everything above used to be written twice, once per page, and
// the same faults — a socket that gave up on a software codec, and the retry
// ladder itself — were then fixed once in each file, where a fix applied to
// only one would have been a silent divergence between the Live page and every
// settings preview. The reconnect saga that produced them is #288; the
// duplication this pays down is #400. What each page DOES
// about the walk running out — an MJPEG rung and a note on one, an alert
// sentence on the other — stays with the page, through onExhausted.
window.MajesticChain = (function () {
	'use strict';

	// How many times a dropped software socket is retried before the floor,
	// and the wait before the n-th retry (1 s, 2 s … 5 s — long enough, in
	// total, to outlast a daemon restart).
	const MAX_RETRIES = 5;
	const RETRY_MS = 1000;
	// Frames a software session must decode before it counts as recovered
	// and the retry budget refills — ~1 s at 8 fps.
	const HEALTHY_FRAMES = 8;

	// Resolved at every call rather than captured: the Live page's tests run it
	// in a bare vm where the transport rules are a stub installed on `window`
	// after this file has loaded.
	const T = () => window.MajesticTransport;

	// The walk as a pure function of one failure. `kind` is the transport that
	// failed, `detail` the player's reason code (its first word decides),
	// `retries` how many software retries this session has spent, and `codec`
	// what the config says the channel on screen is encoded as — the rescue
	// for a socket that dropped before the browser could give a codec verdict.
	//
	// Returns exactly one of:
	//   { restart: true }      the codec changed under the chain: ask again
	//                          from the caller's starting rung
	//   { start: kind }        try this rung next ('mse' or 'wasm')
	//   { retry: ms }          the software socket dropped: retry it after ms
	//   { exhausted: true }    nothing above the caller's floor is left
	function decide(kind, detail, retries, codec) {
		const code = String(detail || '').split(' ')[0];
		if (code === 'codec-changed') return { restart: true };
		if (kind === 'webrtc') return { start: 'mse' };
		if (kind === 'mse' && (T().softwareRungFor(detail) ||
			T().softwareRungForCodec(detail, codec))) {
			return { start: 'wasm' };
		}
		if (kind === 'wasm' && code === 'unreachable' && retries < MAX_RETRIES) {
			return { retry: RETRY_MS * (retries + 1) };
		}
		return { exhausted: true };
	}

	// A stateful driver: it owns the retry budget and the pending timer, and
	// turns each decision into the caller's own attach. opts:
	//   start(token)             attach a transport. `token` is 'mse' or 'wasm'
	//                            from the walk, or whatever starting() returned,
	//                            passed through VERBATIM — the Live page's
	//                            startingRung() answers 'multipart' or a boolean
	//                            that its attachPlayer decodes, and this file
	//                            has no business reading it.
	//   starting()               the rung a codec change restarts from.
	//   codecFor()               the configured codec of the channel on screen.
	//   onExhausted(kind, detail) the walk ran out above the caller's floor.
	//
	// start() is the LAST thing done on every path, deliberately. Two players
	// report a failure synchronously from inside attach() — MajesticWasm says
	// 'no-offscreen' and MajesticVideo 'no-mse' — and the swap then calls
	// next() again before start() has returned. Nothing here is written after
	// the call, so the inner walk cannot be clobbered by the outer one.
	function make(opts) {
		let retries = 0;
		let timer = null;

		// The frame count the healthy rule is measured against — see healthy().
		// Reset whenever the budget is disturbed, which is what a channel or
		// transport change does through cancel().
		let baseFrames = null;
		// Any fresh start supersedes a pending retry: it belonged to a session
		// that is being replaced, and firing it would stage a software player
		// over the newer one and override the viewer's choice. The budget of
		// retries is deliberately left alone — a channel change is not a
		// recovery — but the frame baseline starts over, so a switch cannot be
		// read as sustained decode (below).
		function cancel() {
			if (timer) { clearTimeout(timer); timer = null; }
			baseFrames = null;
		}
		function go(token) {
			cancel();
			opts.start(token);
		}

		function next(kind, detail) {
			const d = decide(kind, detail, retries, opts.codecFor());
			if (d.restart) { go(opts.starting()); return; }
			if (d.start) { go(d.start); return; }
			if (d.retry) {
				retries++;
				// The caller has already retired the live player (or it was a
				// failed trial), so its last frame stays on the stage through
				// the wait rather than blanking it — the same picture-holding
				// rule as a transport switch.
				cancel();
				timer = setTimeout(function () {
					timer = null;
					go('wasm');
				}, d.retry);
				return;
			}
			opts.onExhausted(kind, detail);
		}

		// Fed the software player's stats for the session on screen. Sustained
		// decode refills the budget so the NEXT drop gets a fresh ladder —
		// gated on frames actually decoded, not the codec announcement, and on
		// the software transport alone: the MSE player decodes frames too, and
		// its doing so says nothing about the rung this budget belongs to.
		//
		// A DELTA, not the raw count. framesDecoded is CUMULATIVE across a
		// worker's life and survives an in-place channel change — the worker
		// owns the socket, so setStream keeps counting — so the raw total is
		// not "frames since this became worth trusting". The first stats tick
		// after a switch would otherwise carry thousands of pre-switch frames
		// and refill a budget the switch was meant to leave alone. So measure
		// from a baseline: cancel() (a switch) starts it over, and a count that
		// drops is a fresh worker after a retry starting from zero. Then
		// HEALTHY_FRAMES past the baseline is proof of sustained decode on the
		// session and channel actually on screen.
		function healthy(s) {
			if (!s || s.transport !== 'wasm') return;
			const f = s.framesDecoded | 0;
			if (baseFrames === null || f < baseFrames) baseFrames = f;
			if (f - baseFrames >= HEALTHY_FRAMES) retries = 0;
		}

		return {
			next: next,
			cancel: cancel,
			healthy: healthy,
			// For the tests, and for a caller that wants to say so.
			retries: function () { return retries; },
			pending: function () { return timer !== null; },
		};
	}

	return {
		decide: decide,
		make: make,
		MAX_RETRIES: MAX_RETRIES,
		RETRY_MS: RETRY_MS,
		HEALTHY_FRAMES: HEALTHY_FRAMES,
	};
})();
