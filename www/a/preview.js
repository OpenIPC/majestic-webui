// Low-latency H.264/H.265 MSE player over the majestic /ws/video WebSocket.
window.MajesticVideo = (function () {
	const MAX_QUEUE = 240;
	const LIVE_EDGE = 1.0;

	// Audio is opt-in per connection: the camera only encodes it while someone
	// is listening, so unmuting reconnects with &audio=<what this browser can
	// decode>. The list is probed rather than sniffed from the user agent,
	// because the answer is a browser-version detail: Opus in MP4 plays in
	// Chrome and Firefox, Safari needs AAC. Order is only a hint — the camera
	// prefers whichever of these it is already encoding.
	const AUDIO_CODECS = ['opus', 'mp4a.40.2'];
	const audioPrefs = (function () {
		if (!('MediaSource' in window)) return '';
		return AUDIO_CODECS.filter(function (c) {
			return MediaSource.isTypeSupported('audio/mp4; codecs="' + c + '"');
		}).join(',');
	})();

	// Why a session ended, as a code rather than a sentence — the same
	// division the camera's `served` reply uses (#240): this file names the
	// cause, the page words it for the viewer, and a code it does not know
	// still gets an honest generic line. `undecodable` carries the codec
	// after a space, because "which codec" is the one actionable part of it.
	//
	//   undecodable <codec>  the browser will not take this stream's mime
	//   no-mse               no Media Source Extensions in this browser
	//   unreachable          /ws/video would not stay open
	//   mse-error            MediaSource refused a mime it said it supported
	//
	// The last one is deliberately vague, because so is the fact: it is only
	// reached AFTER isTypeSupported() returned true, so the throw is a source
	// buffer limit, a MediaSource that is no longer open, quota — anything but
	// the decoder. Reporting it as `undecodable` would have the page state
	// something false about the browser, which is the failure this whole
	// vocabulary exists to prevent.
	function attach(video, opts) {
		opts = opts || {};
		const onState = opts.onState || function () {};
		const onCodec = opts.onCodec || function () {};
		const onAudio = opts.onAudio || function () {};
		const onStats = opts.onStats || null;
		let stream = opts.stream | 0;
		let ws = null, ms = null, sb = null, objUrl = null;
		let queue = [], started = false, mime = null;
		let closed = false, reconnectTimer = null, backoff = 1000;
		let gotSignal = false, signalTimer = null, failCount = 0;
		// From the caller: this player is also staged as a replacement now, and
		// a session that proved itself must not be reopened just to turn on the
		// audio the outgoing one already had. See preview-swap.js.
		let wantAudio = !!opts.audio;
		let volume = opts.volume === undefined ? 1 : opts.volume;
		// Player-lifetime counters for the stats panel, deliberately NOT
		// reset on the internal reconnects: the panel differences them and
		// treats a regression as "the session was rebuilt".
		let statsTimer = null;
		let rxBytes = 0;
		let stallCount = 0;
		function onWaiting() { stallCount++; }

		const mseOk = ('MediaSource' in window);
		const NO_SIGNAL_MS = 4000;

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

		function onVideoError(e) {
			if (!closed && e.target === video) reconnect();
		}
		// The element is replaced on every (re)connect, so mute and volume have
		// to be re-applied — cloneNode does not carry them, and defaulting to
		// muted would silence the stream the user just asked to hear.
		function freshVideo() {
			const old = video;
			const nv = old.cloneNode(false);
			nv.removeAttribute('src');
			nv.muted = !wantAudio;
			nv.volume = volume;
			if (old.parentNode) old.parentNode.replaceChild(nv, old);
			old.removeEventListener('error', onVideoError);
			old.removeEventListener('waiting', onWaiting);
			try { old.removeAttribute('src'); old.load(); } catch (e) {}
			video = nv;
			video.addEventListener('error', onVideoError);
			// A stall is the shape TCP loss takes on this transport: the
			// picture waits for the retransmission WebRTC would have skipped.
			video.addEventListener('waiting', onWaiting);
		}

		function onInit(info) {
			markSignal();
			failCount = 0;
			onCodec(info.codec, info.codecString, info.width, info.height);
			// Null when we asked for audio and the camera has none to give —
			// a mic that is off or not producing. Report it either way so the
			// page can say so rather than leave a dead unmute button.
			onAudio(wantAudio ? (info.audioCodec || null) : null);
			// We asked for audio and got a video-only stream: stop wanting it, so
			// state stays consistent with the (now video-only) connection and a
			// later unmute actually flips wantAudio and reconnects rather than
			// no-opping. No reconnect here — this stream is already what a mute
			// would have produced.
			if (wantAudio && !info.audioCodec) { wantAudio = false; video.muted = true; }
			mime = info.mime || ('video/mp4; codecs="' + info.codecString + '"');
			if (!mseOk || !MediaSource.isTypeSupported(mime)) {
				onState('mjpeg', 'undecodable ' + info.codec);
				stop();
				return;
			}
			teardownMse();
			ms = new MediaSource();
			objUrl = URL.createObjectURL(ms);
			video.src = objUrl;
			ms.addEventListener('sourceopen', function () {
				try { sb = ms.addSourceBuffer(mime); }
				catch (e) { onState('mjpeg', 'mse-error'); stop(); return; }
				try { sb.mode = 'segments'; } catch (e) {}
				sb.addEventListener('updateend', pump);
				started = true;
				onState('playing', info.codec);
				pump();
			}, { once: true });
		}

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
			rxBytes += buf.byteLength || 0;
			queue.push(new Uint8Array(buf));
			if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
			pump();
			syncLive();
			if (video.paused) video.play().catch(function () {});
		}

		function open() {
			if (closed) return;
			freshVideo();
			const proto = location.protocol === 'https:' ? 'wss' : 'ws';
			onState('connecting');
			let url = proto + '://' + location.host + '/ws/video?stream=' + stream;
			if (wantAudio && audioPrefs) url += '&audio=' + audioPrefs;
			ws = new WebSocket(url);
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
			if (++failCount >= 6) { onState('mjpeg', 'unreachable'); stop(); return; }
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

		function reopen() {
			backoff = 1000;
			failCount = 0;
			stop();
			if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
			reconnectTimer = setTimeout(function () { reconnectTimer = null; open(); }, 300);
		}

		function setStream(n) {
			n = n | 0;
			if (n === stream) return;
			stream = n;
			reopen();
		}

		// Whether the stream carries an audio track is fixed when the socket
		// opens, so toggling it reconnects — the same brief cut as switching
		// Main/Sub. Muting is not just an element flag: it drops the
		// subscription so the camera stops encoding audio for nobody. Must be
		// called from a click, or autoplay policy blocks unmuted playback.
		function setAudio(on) {
			on = !!on && !!audioPrefs;
			if (on === wantAudio) return;
			wantAudio = on;
			video.muted = !on;
			reopen();
		}

		function setVolume(v) {
			volume = Math.max(0, Math.min(1, +v || 0));
			try { video.volume = volume; } catch (e) {}
		}

		function audioSupported() { return !!audioPrefs; }

		// What this transport can honestly measure about itself, once a
		// second: the bytes the socket delivered, how much decoded future the
		// element is sitting on (the number that separates it from WebRTC's
		// jitter buffer), the element's own dropped-frame accounting, and how
		// often playback had to wait. No RTT, no loss counter, no capacity
		// estimate — TCP hides all three, which is not a measurement gap but
		// the finding.
		function statsTick() {
			if (!started || closed) return;
			const s = { transport: 'mse', rxBytes: rxBytes, stalls: stallCount };
			try {
				const q = video.getVideoPlaybackQuality &&
					video.getVideoPlaybackQuality();
				if (q) {
					s.totalFrames = q.totalVideoFrames;
					s.droppedFrames = q.droppedVideoFrames;
				}
			} catch (e) {}
			try {
				if (video.buffered.length) {
					s.bufferedMs = Math.max(0,
						(video.buffered.end(video.buffered.length - 1) -
							video.currentTime) * 1000);
				}
			} catch (e) {}
			s.width = video.videoWidth || 0;
			s.height = video.videoHeight || 0;
			onStats(s);
		}

		function destroy() {
			closed = true;
			if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
			if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
			stop();
		}

		if (!mseOk) {
			onState('mjpeg', 'no-mse');
			return {
				setStream: function () {}, requestIdr: function () {},
				setAudio: function () {}, setVolume: function () {},
				audioSupported: function () { return false; },
				setMic: function () {}, micSupported: function () { return false; },
				destroy: function () {}, supported: false,
			};
		}

		open();
		if (onStats) statsTimer = setInterval(statsTick, 1000);
		return {
			setStream: setStream, requestIdr: requestIdr,
			setAudio: setAudio, setVolume: setVolume,
			audioSupported: audioSupported,
			// MSE carries one direction only: there is no way to send a
			// microphone up a media-source stream. The façade keeps the shape
			// so the page never asks which transport it attached.
			setMic: function () {}, micSupported: function () { return false; },
			destroy: destroy, supported: true,
		};
	}

	return { attach: attach };
})();
