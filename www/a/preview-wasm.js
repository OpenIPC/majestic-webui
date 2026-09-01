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

	// Where the decoder comes from. Same rule as xterm.js in tool-console.cgi
	// and CodeMirror in files.js: too big to sit in a camera's flash, so it is
	// fetched, version-pinned, with an error path — and a camera with no route
	// to it simply does not get this rung. The chain carries on to MJPEG and
	// says why, which is what it was taught to do in #279.
	const BASE = (window.MJ_WASM_BASE || '/a/hevc/');
	const LOAD_TIMEOUT_MS = 8000;

	// A Worker cannot be constructed from a cross-origin URL, so the worker
	// source is fetched as text and run from a blob. That also means the
	// module's own imports resolve against the blob's useless base URL, so the
	// base is injected rather than left to relative resolution.
	let workerBlob = null;
	function workerUrl() {
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
			});
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
			if (reason) onState('mjpeg', reason);
		}

		// transferControlToOffscreen is one-way and permanent: a second call on
		// the same element throws. The two canvas slots are reused across every
		// attach, so the handle is cached on the element itself.
		let off;
		try {
			off = el.__mjOffscreen ||
				(el.__mjOffscreen = el.transferControlToOffscreen());
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
					else onState(m.state, m.detail);
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
			// Once transferred the handle is spent; a later attach to this
			// element reuses the cached OffscreenCanvas rather than the element.
			el.__mjOffscreenSent = true;
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
					// A channel change is a new socket; the worker owns it, so
					// this is a restart rather than a message. The page stages
					// attaches through preview-swap, which will destroy this one.
					die(null);
					onState('mjpeg', 'restart');
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
