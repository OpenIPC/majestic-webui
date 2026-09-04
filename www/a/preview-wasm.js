// Software H.265, for a browser whose decoder will not take it.
//
// This is NOT a third transport. It is the same /ws/video bytes the MSE player
// reads, decoded in WebAssembly instead of by the browser, so the picker keeps
// naming the transport exactly once and the viewer's remembered preference is
// untouched by what is a codec problem. The page reaches it as a rung of the
// fallback chain, on the `undecodable` reason code and only for a codec this
// decoder handles — see preview-page.js.
//
// It returns the same nine-member object every other player returns, so
// preview-swap.js needs to know nothing about it.
//
// WHAT IS DIFFERENT, and it is one thing: this player paints a <canvas>, not a
// <video>. WebCodecs and MediaStreamTrackGenerator would let a decoder feed a
// real video element, and both are secure-context-only — useless on a camera
// with no TLS certificate. OffscreenCanvas is not, which is what makes this
// possible at all. Everything that reaches into the live element expecting
// videoWidth/readyState/requestVideoFrameCallback has to be taught about that.
window.MajesticWasm = (function () {
	'use strict';

	// Where the decoder comes from. Same rule as xterm.js in console.cgi
	// and CodeMirror in files.js: too big to sit in a camera's flash, so it is
	// fetched, version-pinned, with an error path — and a camera with no route
	// to it simply does not get this rung. The chain carries on to MJPEG and
	// says why, which is what it was taught to do in #279.
	// Version-pinned, like @xterm/xterm@5.5.0 in console.cgi and
	// codemirror@5.65.16 in files.js. jsDelivr serves the tag straight from the
	// repository, so there is no npm step between a release and this URL — and
	// it serves the .wasm as application/wasm, which the camera cannot: its
	// static table knows no such type, so a camera-hosted copy would arrive as
	// application/octet-stream and streaming instantiation would reject it.
	//
	// MJ_WASM_BASE overrides it, for a development build or an operator who
	// would rather host it themselves.
	const BASE = (window.MJ_WASM_BASE ||
		'https://cdn.jsdelivr.net/gh/OpenIPC/hevc-wasm@v0.1.0/dist/');
	const LOAD_TIMEOUT_MS = 8000;

	// A Worker cannot be constructed from a cross-origin URL, so the worker
	// source is fetched as text and run from a blob. That also means the
	// module's own imports resolve against the blob's useless base URL, so the
	// base is injected rather than left to relative resolution.
	let workerBlob = null;
	// Remembered for the session once the module has failed to arrive. Without
	// it every fallback pays the same doomed round trip again, and on a camera
	// with no route out that is a timeout each time — the rung has to be cheap
	// to not have, because not having it is the common case.
	let loadFailed = false;
	function workerUrl() {
		if (loadFailed) return Promise.reject(new Error('unavailable'));
		if (workerBlob) return Promise.resolve(workerBlob);
		const ctl = new AbortController();
		const bail = setTimeout(() => ctl.abort(), LOAD_TIMEOUT_MS);
		return fetch(BASE + 'decoder-worker.js', { signal: ctl.signal })
			.then((r) => (r.ok ? r.text() : Promise.reject(new Error('http ' + r.status))))
			.then((src) => {
				clearTimeout(bail);
				const abs = new URL(BASE, location.href).href;
				const blob = new Blob([src.replace(/(['"])\.\.?\//g, '$1' + abs)],
					{ type: 'text/javascript' });
				workerBlob = URL.createObjectURL(blob);
				return workerBlob;
			})
			.catch((e) => { loadFailed = true; throw e; });
	}

	// Only what this decoder actually handles. The chain gates on this before
	// spending a network round trip: a browser refusing H.264 High 10 reports
	// the same `undecodable` code, and launching an H.265 decoder for it would
	// be a slower way to fail.
	function handles(codec) {
		return /^h?e?vc?$|^h265$|^hevc$/i.test(String(codec || ''));
	}

	function attach(el, opts) {
		opts = opts || {};
		const onState = opts.onState || function () {};
		const onCodec = opts.onCodec || function () {};
		const onAudio = opts.onAudio || function () {};
		const onStats = opts.onStats || null;
		let stream = opts.stream | 0;
		let worker = null, dead = false, statsTimer = null;
		let cum = { frames: 0, decodeMs: 0 };

		onState('connecting');
		// This transport carries no audio: the fragments are muxed and splitting
		// the audio track out to a separate MSE element, with our own A/V sync,
		// is a second project. Say so once rather than leave a dead control.
		onAudio(null);

		function die(reason) {
			if (dead) return;
			dead = true;
			if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
			if (worker) { try { worker.terminate(); } catch (e) {} worker = null; }
			// The worker is gone but its last frame stays on the canvas, and a
			// frozen frame is not a measurement of anything current. Withdraw
			// the claim rather than leave whatever is sampling it reading a
			// still picture as live evidence.
			try { el.__mjPainted = false; } catch (e) {}
			if (reason) onState('mjpeg', reason);
		}

		// transferControlToOffscreen() is one-way and permanent, and the
		// OffscreenCanvas it returns is DETACHED the moment it is posted in a
		// transfer list. So the handle cannot be cached and reused either --
		// caching it only moves the failure from the second transfer to the
		// second postMessage, where it is quieter.
		//
		// The element itself is replaced instead, which is what preview.js
		// already does to its <video> on every open (cloneNode + replaceChild,
		// keeping the id). It is safe here for the same reason it is safe
		// there: the swap resolves its elements through getters by id and
		// never holds a node. Done before the worker exists, so a session
		// never sees its canvas swapped underneath it.
		let off;
		try {
			const fresh = el.cloneNode(false);
			if (el.parentNode) el.parentNode.replaceChild(fresh, el);
			el = fresh;
			off = el.transferControlToOffscreen();
		} catch (e) {
			onState('mjpeg', 'no-offscreen');
			return facade();
		}

		workerUrl().then((url) => {
			if (dead) return;
			worker = new Worker(url, { type: 'module' });
			worker.onerror = () => die('decoder-unavailable');
			worker.onmessage = (e) => {
				const m = e.data;
				if (m.type === 'state') {
					if (m.state === 'mjpeg') die(m.detail || 'decoder-error');
					else {
						// Whoever paints a canvas is the only one who can say
						// it has been painted, and here that is a worker
						// holding an OffscreenCanvas: the main thread never
						// sees a frame land, and the placeholder element is
						// 300x150 and blank-looking from the moment it exists.
						// mj-luma.js reads this expando before it will measure
						// a canvas, and without it anything sampling the
						// software-decode rung silently measures nothing --
						// which for the black-picture check is the difference
						// between "no fault" and "never looked".
						//
						// 'playing' is the claim, because that is already what
						// this contract means by it: the swap puts the canvas
						// on screen on the strength of the same message.
						if (m.state === 'playing') el.__mjPainted = true;
						onState(m.state, m.detail);
					}
				} else if (m.type === 'codec') {
					onCodec('h265', '', m.width, m.height);
				} else if (m.type === 'stats' && onStats) {
					const s = m.stats;
					// fps and decode time are MEASURED here, unlike MSE which
					// measures nothing — that is the point of the rung, and the
					// chip is expected to show it.
					const dFrames = s.frames - cum.frames;
					const dMs = s.decodeMs - cum.decodeMs;
					cum = { frames: s.frames, decodeMs: s.decodeMs };
					onStats({
						transport: 'wasm',
						fps: dFrames,
						framesDecoded: s.frames,
						framesDropped: s.dropped,
						decodeTime: s.decodeMs / 1000,
						meanDecodeMs: dFrames ? dMs / dFrames : 0,
						queuedFrames: s.queuedFrames,
						// How far behind the camera this client is, measured
						// rather than assumed — the number the page warns on,
						// and the one a fps-versus-configured comparison gets
						// wrong when a VBR encoder legitimately sends fewer.
						queuedMs: s.queuedMs,
						sourceIntervalMs: s.sourceIntervalMs,
						gopDrops: s.gopDrops,
						idrRequests: s.idrRequests,
						rxBytes: s.bytes,
						width: s.width, height: s.height,
						codec: 'h265',
					});
				}
			};
			const proto = location.protocol === 'https:' ? 'wss' : 'ws';
			worker.postMessage({
				type: 'start',
				url: proto + '://' + location.host + '/ws/video?stream=' + stream,
				canvas: off,
			}, [off]);
			if (onStats) statsTimer = setInterval(() => {
				if (worker) worker.postMessage({ type: 'stats' });
			}, 1000);
		}).catch(() => die('decoder-unavailable'));

		function facade() {
			return {
				setStream: function (n) {
					n = n | 0;
					if (n === stream || dead) return;
					stream = n;
					// The worker owns the socket, so a channel change is its
					// business and the page never hears about it. Reporting a
					// state here instead -- which the first cut did, as
					// `mjpeg restart` -- was read by the chain as this rung
					// giving up, so picking Sub while software decoding dropped
					// a working picture to MJPEG.
					if (worker) worker.postMessage({ type: 'setStream', stream: n });
				},
				requestIdr: function () { if (worker) worker.postMessage({ type: 'idr' }); },
				setAudio: function () {},
				setVolume: function () {},
				audioSupported: function () { return false; },
				setMic: function () {},
				micSupported: function () { return false; },
				destroy: function () { die(null); },
				supported: true,
			};
		}
		return facade();
	}

	return {
		attach: attach,
		handles: handles,
		// Cheap and synchronous: whether this browser could run the rung at all.
		// Whether the module actually loads is a network question, answered by
		// attach() reporting 'mjpeg' with a reason the chain already understands.
		available: typeof Worker === 'function' &&
			typeof WebAssembly === 'object' &&
			typeof OffscreenCanvas === 'function' &&
			typeof HTMLCanvasElement !== 'undefined' &&
			typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function',
	};
})();
