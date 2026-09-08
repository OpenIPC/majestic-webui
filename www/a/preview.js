// Low-latency H.264/H.265 MSE player over the majestic /ws/video WebSocket.
window.MajesticVideo = (function () {
	const MAX_QUEUE = 240;
	// Safari wedges its MSE SourceBuffer on high-frequency per-frame appendBuffer
	// calls for HEVC: /ws/video delivers one fMP4 fragment per frame (~20-30/s),
	// and appending each on its own froze Safari after a few seconds with NO
	// decode error — the silent stall DECODE_MAX below never catches, which the
	// rebuild then surfaces as the ~2s flash of majestic-webui#335. Coalescing a
	// few fragments into one append keeps its decoder fed. Proven on macOS 15
	// Safari 26.6.1 in OpenIPC/safari-hevc-qa: per-frame stalls at ~3s, batches of
	// five play the stream through. Only HEVC is batched — H.264 stays per-frame,
	// so its low-latency live path is unchanged — and the wait is bounded so a
	// slow or ending stream still flushes what it has.
	const APPEND_BATCH = 5;
	const APPEND_MAX_WAIT = 200;
	// Consecutive decode failures on one player before we stop rebuilding it
	// and fall through the chain. A browser whose decoder cannot take this
	// stream (a Safari that rejects a conformant HEVC, majestic-webui#335) fails
	// again on every rebuild, so retrying forever is the ~2s flash; two strikes
	// is enough to tell a permanent inability from a one-off glitch.
	const DECODE_MAX = 2;
	const DECODE_RESET_MS = 30000;
	// How far playback may fall behind where it was seen to run before the
	// player seeks it back to the live edge. A budget for DRIFT, not a
	// latency: see syncLive() for why the two are not the same thing.
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
		// HEVC append-coalescing state (see APPEND_BATCH above); pumpTimer bounds
		// the wait for a full batch. hevc is set from the mime on each (re)init.
		let pumpTimer = null, hevc = false;
		let skipInitBinary = false;
		// The running stream's dimensions. The fallback mime carries the codec
		// but not the resolution, so a re-init that changes only width/height
		// has to be told from a true re-announcement by these.
		let lastW = 0, lastH = 0;
		let closed = false, reconnectTimer = null, backoff = 1000;
		let gotSignal = false, signalTimer = null, failCount = 0;
		// Decode failures (MediaError code 3), and the codec to name when we give
		// up on the browser's own decoder and ask the page for the next rung.
		let decodeErrs = 0, lastDecodeAt = 0, lastCodec = '';
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
		// The live-edge rule's memory (syncLive): how far behind the newest
		// appended frame this pipeline runs when it is running, the playhead
		// at the last look (so that its advance can be told from its being
		// moved), whether the next advance is the first since a seek, and
		// whether play() has been refused since the pipeline was built.
		let lagFloor = 0, lagLearn = true, lastCt = null, playRefused = false;

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
			// H.264 keeps its per-frame append. HEVC coalesces: wait briefly for a
			// full batch (bounded by APPEND_MAX_WAIT so a slow/ending stream still
			// plays), then append the batch as one buffer.
			if (hevc && queue.length < APPEND_BATCH) {
				if (!pumpTimer) pumpTimer = setTimeout(function () {
					pumpTimer = null; flushAppend();
				}, APPEND_MAX_WAIT);
				return;
			}
			flushAppend();
		}
		function flushAppend() {
			if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = null; }
			if (!sb || sb.updating || !queue.length) return;
			const n = hevc ? Math.min(queue.length, APPEND_BATCH) : 1;
			let buf;
			if (n === 1) {
				buf = queue[0];
			} else {
				let total = 0, i;
				for (i = 0; i < n; i++) total += queue[i].byteLength;
				buf = new Uint8Array(total);
				for (i = 0, total = 0; i < n; i++) { buf.set(queue[i], total); total += queue[i].byteLength; }
			}
			// Consume only on a clean append: appendBuffer throws synchronously
			// only on quota or a bad SourceBuffer state, and trim() frees the quota
			// so the next pump retries the same fragments rather than dropping them.
			try { sb.appendBuffer(buf); queue.splice(0, n); }
			catch (e) { trim(); }
		}
		function trim() {
			try {
				if (sb && !sb.updating && sb.buffered.length) {
					const end = sb.buffered.end(sb.buffered.length - 1);
					// Behind the playhead, which sits lagFloor (plus up to a
					// budget of drift) back from the end: cutting under it would
					// force the seek that syncLive() exists not to make.
					const keep = Math.max(4, lagFloor + LIVE_EDGE + 1);
					if (end > keep + 4) sb.remove(0, end - keep);
				}
			} catch (e) {}
		}

		function teardownMse() {
			started = false; queue = [];
			if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = null; }
			// The lag floor describes the pipeline being torn down; the next
			// one learns its own.
			lagFloor = 0; lagLearn = true; lastCt = null; playRefused = false;
			// A redundant init may have armed this for a moov that never arrived
			// (the socket dropped first). Clear it, or the next connection's real
			// init segment would be dropped and playback could not start.
			skipInitBinary = false;
			try { if (sb && sb.updating) sb.abort(); } catch (e) {}
			try { if (sb && ms && ms.readyState === 'open') ms.removeSourceBuffer(sb); } catch (e) {}
			sb = null;
			try { if (ms && ms.readyState === 'open') ms.endOfStream(); } catch (e) {}
			ms = null;
			if (objUrl) { try { URL.revokeObjectURL(objUrl); } catch (e) {} objUrl = null; }
		}

		// Give up a socket, for good. Both halves of this matter, and for
		// different reasons.
		//
		// Closing it is what stops the camera serving it. An abandoned
		// /ws/video session is a live subscription: the camera goes on
		// encoding for it and sending to it for as long as the tab is open,
		// and counts it among the viewers it is serving. That is #298 — ten
		// sessions, one per blink, on a link that could not carry two, each
		// new one competing with the ones it was meant to replace.
		//
		// Dropping the handlers is what stops a socket speaking for the player
		// after it has been replaced. They close over `ws`, the slot, and not
		// over the socket they belong to, so a close event that lands after
		// the slot has moved on nulls the socket now carrying the picture and
		// starts a reconnect on top of it — orphaning that one in turn. On a
		// LAN the close lands well inside reopen()'s 300 ms gap and nothing
		// shows; add a second of latency and pressing Main/Sub leaks a session
		// every other press.
		function discard(sock) {
			if (!sock) return;
			sock.onopen = null;
			sock.onmessage = null;
			sock.onclose = null;
			sock.onerror = null;
			try { sock.close(); } catch (e) {}
		}

		function onVideoError(e) {
			if (closed || e.target !== video) return;
			// A decode error (MEDIA_ERR_DECODE) that keeps coming back is the
			// browser telling us its decoder cannot play this stream -- a Safari
			// that rejects a conformant HEVC (#335). Rebuilding the same decoder
			// only reproduces it (the ~2s flash), so after DECODE_MAX strikes stop
			// and hand the page an `undecodable` verdict, the same one onInit gives
			// for a mime MSE will not take: the chain then tries the software
			// decoder (which can play what the hardware one refused) or MJPEG.
			// Strikes far apart in time are a one-off, not an inability, so a gap
			// longer than DECODE_RESET_MS starts the count over.
			var code = video.error && video.error.code;
			if (code === 3) {
				var now = Date.now();
				if (now - lastDecodeAt > DECODE_RESET_MS) decodeErrs = 0;
				lastDecodeAt = now;
				if (++decodeErrs >= DECODE_MAX) {
					onState('mjpeg', 'undecodable ' + (lastCodec || 'h265'));
					stop();
					return;
				}
			}
			reconnect();
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
			lastCodec = info.codec;
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
			const newMime = info.mime || ('video/mp4; codecs="' + info.codecString + '"');
			if (!mseOk || !MediaSource.isTypeSupported(newMime)) {
				onState('mjpeg', 'undecodable ' + info.codec);
				stop();
				return;
			}
			// A re-sent init identical to the one already playing is a
			// re-announcement, not a reconfigure. Some encoders emit the parameter
			// sets on every keyframe, so the camera re-sends the init each time;
			// rebuilding MediaSource for it resets the decoder and blanks the
			// picture once per keyframe -- the Safari flash and the jerky H.265 of
			// OpenIPC/majestic-webui#269 / #335. Keep the running decoder and drop
			// the redundant init segment (this message and the binary moov that
			// follows it): the camera's fragment timeline is continuous across the
			// re-announcement, so the fragments after it keep appending to the
			// existing buffer.
			//
			// The identity has to include the resolution, not just the mime: the
			// fallback mime is built from codecString alone, so a channel resized
			// without a codec change (e.g. 1080p -> 720p at the same H.265 level)
			// keeps the same mime while genuinely needing a new decoder. Compare
			// width and height too, or that reconfigure would be swallowed here
			// and its fragments would reach a buffer set up for the old size. A
			// real reconfigure -- codec, resolution or audio -- takes the rebuild
			// path below.
			if (started && sb && ms && ms.readyState === 'open' &&
					newMime === mime && (info.width | 0) === lastW &&
					(info.height | 0) === lastH) {
				skipInitBinary = true;
				return;
			}
			mime = newMime;
			hevc = /hvc1|hev1/i.test(newMime);
			lastW = info.width | 0;
			lastH = info.height | 0;
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

		// Keep playback at the live edge -- by seeking it forward when it has
		// fallen behind, and ONLY then.
		//
		// This used to seek whenever the buffer ran more than LIVE_EDGE ahead
		// of the playhead, whether or not the playhead was moving. That reads
		// the gap as latency to be cut, and it is not always that: part of it
		// is what the browser's decoder needs before it will output anything.
		// Chrome's hardware H.264 path sizes its reorder window from the SPS,
		// and when the SPS carries no bitstream_restriction it takes the
		// level's whole DPB -- 16 frames for a level 5.1 1080p stream, which
		// is what an Ingenic T31 emits. At the ~9 fps that camera delivers,
		// 16 frames is 1.7 s: the decoder cannot produce a frame inside the
		// 1.0 s budget, so every seek flushed it before it had produced one,
		// the next fragment found the buffer 1.0 s ahead again and seeked
		// again, and nothing reached the screen except the four frames an IDR
		// flushes out of the DPB -- once per GOP, every 12.6 s. Measured in
		// Chrome with VA-API on the lab T31: 12 frames and 46 seeks in 46 s.
		// WebRTC on the same camera and browser plays from the first second,
		// because nothing there seeks. The HiSilicon next to it never
		// showed this because its level 5.0 at 2592x1520 gives a 7-frame
		// window, 0.35 s at 20 fps, under the budget -- the same rule, one
		// camera on each side of the cliff.
		//
		// So the seek is decided on DRIFT: how much further behind playback
		// has fallen than this pipeline was seen to run. Three parts.
		//
		//  1. Nothing is seeked while nothing is moving. A pipeline that has
		//     produced no frame since it was built or last seeked is not
		//     behind, it is starting; a seek now only starts it over. The
		//     playhead advancing (past where the last look, or the last
		//     seek, left it) is the one sign that means frames are on screen
		//     in every browser -- a decoded-frame count can rise for frames a
		//     seek then discards, so it is not used.
		//
		//  2. The lag the pipeline runs at is learned, not assumed. The first
		//     time the playhead is seen moving -- at the start, and again
		//     after every seek -- the gap to the buffer's end is what this
		//     decoder and renderer need: the floor, tightened by any smaller
		//     gap seen later. A seek is made when the gap exceeds the floor
		//     by LIVE_EDGE: after a stall, a tab in the background, a link
		//     that delivered a burst. The T31 above runs 2 s behind under a
		//     hardware decoder and is never seeked for it, because no seek
		//     can shorten it: measured, seeking it once at the start cost a
		//     1.3 s blackout right after the first picture and bought 0.2 s.
		//
		//  3. The one start whose lag is not the pipeline's is a start that
		//     autoplay refused: the buffer fills while play() waits for a
		//     click, and the seconds it fills with would be learned as if a
		//     decoder needed them. A refusal is remembered, and the first
		//     movement after one is judged against a floor of zero -- the
		//     absolute budget the rule always had -- so it is seeked to the
		//     edge, and the floor is learned from where playback resumes.
		//
		// Two corrections stay unconditional, because they are not about
		// latency: a playhead under the buffer's start (the buffer was
		// trimmed under it) or past its end can only be moved.
		function syncLive() {
			try {
				if (!video.buffered.length) return;
				const start = video.buffered.start(0);
				const end = video.buffered.end(video.buffered.length - 1);
				const ct = video.currentTime;
				if (ct < start || ct > end + 0.25) { seekLive(start, end); return; }
				const moving = lastCt !== null && ct > lastCt + 0.001;
				lastCt = ct;
				if (!moving) return;
				const lag = end - ct;
				if (lagLearn) { lagFloor = lag; lagLearn = false; }
				else if (lag < lagFloor) lagFloor = lag;
				if (playRefused) { playRefused = false; lagFloor = 0; }
				if (lag - lagFloor > LIVE_EDGE) seekLive(start, end);
			} catch (e) {}
		}
		function seekLive(start, end) {
			video.currentTime = Math.max(start, end - 0.1);
			// Read back rather than assumed: the browser may clamp it, and the
			// jump itself must not count as the playhead advancing.
			lastCt = video.currentTime;
			lagLearn = true;
		}

		function onBinary(buf) {
			// A redundant init (see onInit) is followed by its binary moov; drop
			// that one segment so it is not re-appended to the running buffer.
			if (skipInitBinary) { skipInitBinary = false; return; }
			rxBytes += buf.byteLength || 0;
			queue.push(new Uint8Array(buf));
			if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
			pump();
			syncLive();
			// A refusal is remembered for syncLive(): the seconds that pile up
			// in the buffer while autoplay waits for a click are not what the
			// pipeline needs, and must not be learned as if they were.
			if (video.paused) {
				video.play().catch(function () { playRefused = true; });
			}
		}

		function open() {
			if (closed) return;
			// One socket per player, held where the sockets are made rather
			// than trusted of every caller that leads here.
			discard(ws);
			freshVideo();
			const proto = location.protocol === 'https:' ? 'wss' : 'ws';
			onState('connecting');
			let url = proto + '://' + location.host + '/ws/video?stream=' + stream;
			if (wantAudio && audioPrefs) url += '&audio=' + audioPrefs;
			// Each handler is bound to its own socket, so an error late in a
			// session's life closes the session that raised it and not
			// whichever one happens to be in the slot by then.
			const sock = new WebSocket(url);
			ws = sock;
			sock.binaryType = 'arraybuffer';
			gotSignal = false;
			sock.onopen = function () { backoff = 1000; armSignalTimer(); };
			sock.onmessage = function (e) {
				if (typeof e.data === 'string') {
					let info; try { info = JSON.parse(e.data); } catch (_) { return; }
					if (info && info.type === 'init') onInit(info);
					return;
				}
				onBinary(e.data);
			};
			sock.onclose = function () { ws = null; if (!closed) reconnect(); };
			sock.onerror = function () { try { sock.close(); } catch (e) {} };
		}

		function reconnect() {
			// Before the backoff rather than after it: until this socket is
			// closed the camera is still encoding and sending for it, and the
			// reconnect is about to ask for a second one. The video element
			// raising an error is the path that used to skip this.
			discard(ws);
			ws = null;
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
			discard(ws);
			ws = null;
			teardownMse();
		}

		function requestIdr() {
			if (ws && ws.readyState === 1) ws.send(JSON.stringify({ request: 'idr' }));
		}

		function reopen() {
			backoff = 1000;
			failCount = 0;
			// A deliberate switch (Main/Sub, audio) is a fresh decode context:
			// the new stream must not inherit the old one's decode strikes, or a
			// single error on it within DECODE_RESET_MS of an earlier one would
			// route it straight to software/MJPEG (only reconnect(), the error
			// path, keeps the count).
			decodeErrs = 0; lastDecodeAt = 0;
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
