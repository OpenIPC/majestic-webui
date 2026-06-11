// Low-latency H.264/H.265 live player over the majestic /ws/video WebSocket.
// majestic re-wraps the encoded stream as fragmented MP4; this feeds it to a
// <video> element via Media Source Extensions (MSE). MSE works over plain
// http:// on a camera (unlike WebCodecs, which is secure-context-only), so this
// is the path that actually plays on an IP camera with no TLS cert. Falls back
// to MJPEG when MSE or the codec isn't supported. No third-party library.
//
// Reusable: MajesticVideo.attach(videoEl, opts) returns a small handle so the
// Preview page (and later the motionDetect ROI editor) can share one player.
//   opts.stream  : 0 main (default) | 1 sub
//   opts.onState : (state, detail) => {}   // 'connecting'|'playing'|'mjpeg'|'error'
//   opts.onCodec : (codec, codecString, width, height) => {}
// handle: { setStream(n), requestIdr(), destroy(), supported }
//
// Wire format (see src/websrv/ws.c on_ws_video):
//   text   : {type:"init",codec,codecString,mime,width,height,stream}
//   binary : first frame = fMP4 init segment (ftyp+moov); then one moof+mdat
//            fragment per access unit.
window.MajesticVideo = (function () {
	const MAX_QUEUE = 240;     // drop oldest fragments if the tab stalls
	const LIVE_EDGE = 1.0;     // seconds of buffer ahead before we snap to live

	function attach(video, opts) {
		opts = opts || {};
		const onState = opts.onState || function () {};
		const onCodec = opts.onCodec || function () {};
		let stream = opts.stream | 0;
		let ws = null, ms = null, sb = null, objUrl = null;
		let queue = [], started = false, mime = null;
		let closed = false, reconnectTimer = null, backoff = 1000;
		let gotSignal = false, signalTimer = null, failCount = 0;

		const mseOk = ('MediaSource' in window);
		const NO_SIGNAL_MS = 4000;  // WS open but no stream this long => no signal

		function armSignalTimer() {
			clearTimeout(signalTimer);
			signalTimer = setTimeout(function () {
				if (!gotSignal && !closed) onState('nosignal');
			}, NO_SIGNAL_MS);
		}
		function markSignal() { gotSignal = true; clearTimeout(signalTimer); }

		function pump() {
			if (!sb || sb.updating || !queue.length) return;
			try { sb.appendBuffer(queue.shift()); }
			catch (e) { trim(); }
		}
		function trim() {
			try {
				if (sb && !sb.updating && sb.buffered.length) {
					const end = sb.buffered.end(sb.buffered.length - 1);
					if (end > 8) sb.remove(0, end - 4);
				}
			} catch (e) {}
		}

		function teardownMse() {
			started = false; queue = [];
			try { if (sb && sb.updating) sb.abort(); } catch (e) {}
			try { if (sb && ms && ms.readyState === 'open') ms.removeSourceBuffer(sb); } catch (e) {}
			sb = null;
			try { if (ms && ms.readyState === 'open') ms.endOfStream(); } catch (e) {}
			ms = null;
			if (objUrl) { try { URL.revokeObjectURL(objUrl); } catch (e) {} objUrl = null; }
		}

		// Chrome wedges a <video>'s decoder when a new MediaSource with a
		// different resolution/codec is bound to the SAME element (switching
		// streams) -> MEDIA_ERR_DECODE that survives until the element is
		// recreated. So hand each connection a brand-new element cloned from the
		// original (preserving id / classes / inline style / autoplay attrs).
		// The page re-queries #live-video for show/hide.
		function onVideoError(e) {
			if (!closed && e.target === video) reconnect();
		}
		function freshVideo() {
			const old = video;
			const nv = old.cloneNode(false);
			nv.removeAttribute('src'); // don't inherit the old (revoked) blob: URL
			nv.muted = true;
			if (old.parentNode) old.parentNode.replaceChild(nv, old);
			old.removeEventListener('error', onVideoError);
			try { old.removeAttribute('src'); old.load(); } catch (e) {}
			video = nv;
			video.addEventListener('error', onVideoError);
		}

		function onInit(info) {
			markSignal(); /* a stream description means the camera has signal */
			failCount = 0; /* a healthy connection resets the give-up counter */
			onCodec(info.codec, info.codecString, info.width, info.height);
			mime = info.mime || ('video/mp4; codecs="' + info.codecString + '"');
			if (!mseOk || !MediaSource.isTypeSupported(mime)) {
				onState('mjpeg', 'codec ' + info.codec + ' not playable here');
				stop();
				return;
			}
			teardownMse();
			ms = new MediaSource();
			objUrl = URL.createObjectURL(ms);
			video.src = objUrl;
			ms.addEventListener('sourceopen', function () {
				try { sb = ms.addSourceBuffer(mime); }
				catch (e) { onState('mjpeg', 'addSourceBuffer failed'); stop(); return; }
				try { sb.mode = 'segments'; } catch (e) {}
				sb.addEventListener('updateend', pump);
				started = true;
				onState('playing', info.codec);
				pump();
			}, { once: true });
		}

		// Keep playback inside the live buffered range. Critically this also
		// handles a stream switch: the new MediaSource's timeline starts near 0,
		// but the <video>'s currentTime is still in the OLD stream's frame (e.g.
		// 1s or 6s), so it lands outside the new buffer and stalls to black. Snap
		// in whenever currentTime is before the buffer, past it, or drifting.
		function syncLive() {
			try {
				if (!video.buffered.length) return;
				const start = video.buffered.start(0);
				const end = video.buffered.end(video.buffered.length - 1);
				const ct = video.currentTime;
				if (ct < start || ct > end + 0.25 || end - ct > LIVE_EDGE)
					video.currentTime = Math.max(start, end - 0.1);
			} catch (e) {}
		}

		function onBinary(buf) {
			queue.push(new Uint8Array(buf));
			if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
			pump();
			syncLive();
			if (video.paused) video.play().catch(function () {});
		}

		function open() {
			if (closed) return;
			freshVideo(); // clean decoder for every (re)connect / stream switch
			const proto = location.protocol === 'https:' ? 'wss' : 'ws';
			onState('connecting');
			ws = new WebSocket(proto + '://' + location.host + '/ws/video?stream=' + stream);
			ws.binaryType = 'arraybuffer';
			gotSignal = false;
			ws.onopen = function () { backoff = 1000; armSignalTimer(); };
			ws.onmessage = function (e) {
				if (typeof e.data === 'string') {
					let info; try { info = JSON.parse(e.data); } catch (_) { return; }
					if (info && info.type === 'init') onInit(info);
					return;
				}
				onBinary(e.data);
			};
			ws.onclose = function () { ws = null; if (!closed) reconnect(); };
			ws.onerror = function () { try { ws.close(); } catch (e) {} };
		}

		function reconnect() {
			teardownMse();
			if (closed || reconnectTimer) return;
			// Give up after a run of failures that never delivered a stream
			// (server busy / 503, or endpoint unavailable) and fall back to MJPEG
			// instead of storming the reconnect loop.
			if (++failCount >= 6) { onState('mjpeg', 'live stream unavailable'); stop(); return; }
			reconnectTimer = setTimeout(function () {
				reconnectTimer = null;
				backoff = Math.min(backoff * 2, 8000);
				open();
			}, backoff);
		}

		function stop() {
			clearTimeout(signalTimer);
			if (ws) { try { ws.close(); } catch (e) {} ws = null; }
			teardownMse();
		}

		function requestIdr() {
			if (ws && ws.readyState === 1) ws.send(JSON.stringify({ request: 'idr' }));
		}

		function setStream(n) {
			n = n | 0;
			if (n === stream) return;
			stream = n;
			backoff = 1000;
			failCount = 0;
			stop();
			// Let the old MediaSource/decoder fully release before binding a new
			// one — Chrome decode-errors if a new (different-resolution) decoder
			// spins up while the previous one is still being torn down.
			if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
			reconnectTimer = setTimeout(function () { reconnectTimer = null; open(); }, 300);
		}

		function destroy() {
			closed = true;
			if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
			stop();
		}

		if (!mseOk) {
			onState('mjpeg', 'MSE unavailable');
			return { setStream: function () {}, requestIdr: function () {}, destroy: function () {}, supported: false };
		}

		open();
		return { setStream: setStream, requestIdr: requestIdr, destroy: destroy, supported: true };
	}

	return { attach: attach };
})();
