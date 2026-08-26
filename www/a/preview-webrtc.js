// Low-latency H.264/H.265 WebRTC player over the majestic /ws/webrtc socket.
//
// A second body behind the same façade as preview.js, so preview-page.js and
// mj-settings.js do not know which transport they attached. attach() returns
// the identical shape — setStream, requestIdr, setAudio, setVolume,
// audioSupported, destroy, supported — and the caller picks a transport
// rather than a player.
//
// WHAT THIS BUYS OVER MSE. Sub-second latency, because there is no buffer to
// fill; two-way audio, which MSE cannot do at all; and a camera that responds
// to congestion, because the receiver's estimate reaches the encoder. That
// last one is worth knowing rather than discovering: a WebRTC viewer changes
// the camera's bitrate, where an MSE viewer never does.
//
// WHAT IT COSTS. Negotiation, which can fail where MSE cannot. Firefox's
// WebRTC stack offers only H.264 Baseline whatever its decoder can do, so a
// camera set to `profile: main` has nothing to give it on the main stream —
// the same browser that plays that stream over MSE refuses it here. Which is
// why failure reports 'fallback' rather than 'mjpeg': the caller should try
// MSE, which negotiates nothing, before giving up on video.
window.MajesticWebRTC = (function () {
	// How long to wait for media before saying so. Longer than MSE's 4 s: ICE
	// and DTLS happen first, and on a camera gathering a reflexive address
	// that is a round trip to a STUN server before anything can flow.
	const NO_SIGNAL_MS = 8000;

	// A browser without these cannot be helped by trying.
	const rtcOk = typeof window.RTCPeerConnection === 'function';

	function attach(video, opts) {
		opts = opts || {};
		const onState = opts.onState || function () {};
		const onCodec = opts.onCodec || function () {};
		const onAudio = opts.onAudio || function () {};
		let stream = opts.stream | 0;

		let pc = null, ws = null, statsTimer = null, signalTimer = null;
		let closed = false, reconnectTimer = null, backoff = 1000;
		let failCount = 0, gotMedia = false;
		let wantAudio = false, volume = 1;
		let lastCodec = '', lastW = 0, lastH = 0;

		function armSignalTimer() {
			clearTimeout(signalTimer);
			signalTimer = setTimeout(function () {
				if (!gotMedia && !closed) onState('nosignal');
			}, NO_SIGNAL_MS);
		}

		function send(req, data) {
			if (ws && ws.readyState === 1) {
				ws.send(JSON.stringify({ req: req, data: data }));
			}
		}

		// Resolution and codec come from getStats rather than from the SDP:
		// the answer names a codec but not a picture size, and the size is
		// what the badge is for. Polled because it is the only way — there is
		// no event for "the encoder changed resolution".
		function pollStats() {
			if (!pc) return;
			pc.getStats().then(function (report) {
				let codec = '', w = 0, h = 0, bytes = 0;
				const codecs = {};
				report.forEach(function (r) {
					if (r.type === 'codec') codecs[r.id] = r;
				});
				report.forEach(function (r) {
					if (r.type !== 'inbound-rtp' || r.kind !== 'video') return;
					bytes = r.bytesReceived || 0;
					w = r.frameWidth || 0;
					h = r.frameHeight || 0;
					const c = codecs[r.codecId];
					if (c && c.mimeType) {
						codec = c.mimeType.replace(/^video\//i, '').toLowerCase();
					}
				});
				if (bytes > 0 && !gotMedia) {
					gotMedia = true;
					clearTimeout(signalTimer);
					failCount = 0;
					onState('playing', codec);
				}
				if (w && h && (codec !== lastCodec || w !== lastW || h !== lastH)) {
					lastCodec = codec; lastW = w; lastH = h;
					onCodec(codec, codec, w, h);
				}
			}).catch(function () {});
		}

		function teardownPc() {
			clearInterval(statsTimer); statsTimer = null;
			if (pc) {
				try { pc.ontrack = null; pc.onicecandidate = null; } catch (e) {}
				try { pc.close(); } catch (e) {}
				pc = null;
			}
			try { video.srcObject = null; } catch (e) {}
			gotMedia = false;
			lastCodec = ''; lastW = 0; lastH = 0;
		}

		function open() {
			if (closed) return;
			onState('connecting');
			teardownPc();

			try {
				pc = new RTCPeerConnection({ iceServers: [] });
			} catch (e) {
				onState('fallback', 'RTCPeerConnection failed');
				return;
			}

			// recvonly for video always. Audio is a transceiver only when the
			// user asked for it, because negotiating a track nobody listens to
			// has the camera encode for nobody — the same reasoning as the MSE
			// path's opt-in, arrived at from the other end.
			try {
				pc.addTransceiver('video', { direction: 'recvonly' });
				if (wantAudio) {
					pc.addTransceiver('audio', { direction: 'recvonly' });
				}
			} catch (e) {
				onState('fallback', 'addTransceiver failed');
				return;
			}

			pc.ontrack = function (ev) {
				if (ev.streams && ev.streams[0]) video.srcObject = ev.streams[0];
				video.muted = !wantAudio;
				try { video.volume = volume; } catch (e) {}
				video.play().catch(function () {});
				if (ev.track && ev.track.kind === 'audio') onAudio('opus');
			};
			pc.onicecandidate = function (ev) {
				if (ev.candidate) send('candidate', ev.candidate.candidate);
			};
			pc.oniceconnectionstatechange = function () {
				if (!pc) return;
				const s = pc.iceConnectionState;
				if (s === 'failed' || s === 'closed') reconnect();
				else if (s === 'disconnected') onState('error');
			};

			const proto = location.protocol === 'https:' ? 'wss' : 'ws';
			ws = new WebSocket(
				proto + '://' + location.host + '/ws/webrtc?stream=' + stream);
			gotMedia = false;

			ws.onopen = function () {
				backoff = 1000;
				armSignalTimer();
				pc.createOffer()
					.then(function (offer) {
						return pc.setLocalDescription(offer).then(function () {
							send('offer', pc.localDescription.sdp);
						});
					})
					.catch(function () { onState('fallback', 'offer failed'); });
			};
			ws.onmessage = function (e) {
				let m; try { m = JSON.parse(e.data); } catch (_) { return; }
				if (!m) return;
				if (m.reply === 'answer') {
					pc.setRemoteDescription({ type: 'answer', sdp: m.data })
						.catch(function () {
							onState('fallback', 'answer rejected');
						});
				} else if (m.reply === 'candidate') {
					pc.addIceCandidate({ candidate: m.data, sdpMid: m.mid })
						.catch(function () {});
				} else if (m.reply === 'error') {
					// The camera could not answer. Much the commonest cause is
					// a profile this browser will not take — see
					// docs/webrtc-browser-interop.md — and MSE has no such
					// problem, so this is a reason to change transport rather
					// than to keep retrying.
					onState('fallback', m.data || 'the camera refused the offer');
					stop();
				}
			};
			ws.onclose = function () { ws = null; if (!closed) reconnect(); };
			ws.onerror = function () { try { ws.close(); } catch (e) {} };

			clearInterval(statsTimer);
			statsTimer = setInterval(pollStats, 1000);
		}

		function reconnect() {
			teardownPc();
			if (closed || reconnectTimer) return;
			// Fewer attempts than the MSE path allows itself. Its failures are
			// transient by nature — a socket dropped, a keyframe missed —
			// while a WebRTC session that will not establish usually will not
			// establish on the fourth try either, and every attempt costs a
			// full ICE and DTLS exchange.
			if (++failCount >= 3) {
				onState('fallback', 'WebRTC could not establish a session');
				stop();
				return;
			}
			reconnectTimer = setTimeout(function () {
				reconnectTimer = null;
				backoff = Math.min(backoff * 2, 8000);
				open();
			}, backoff);
		}

		function stop() {
			clearTimeout(signalTimer);
			clearInterval(statsTimer); statsTimer = null;
			if (ws) { try { ws.close(); } catch (e) {} ws = null; }
			teardownPc();
		}

		// The camera honours a PLI, and the session already asks for one when
		// a track starts — so this is for a viewer staring at a frozen frame
		// rather than part of normal operation.
		function requestIdr() { send('idr', ''); }

		function reopen() {
			backoff = 1000;
			failCount = 0;
			stop();
			if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
			reconnectTimer = setTimeout(function () {
				reconnectTimer = null; open();
			}, 300);
		}

		// Which encoder channel is settled when the session is negotiated —
		// the camera picks by what this browser can decode and takes ?stream
		// as a preference — so changing it means a new session, the same brief
		// cut the MSE path takes.
		function setStream(n) {
			n = n | 0;
			if (n === stream) return;
			stream = n;
			reopen();
		}

		// Audio is in the SDP, so switching it on means renegotiating. Doing
		// that by reconnecting rather than by an ICE-restart-style
		// renegotiation keeps this player to one code path; the cut is the
		// same one Main/Sub already takes.
		function setAudio(on) {
			on = !!on;
			if (on === wantAudio) return;
			wantAudio = on;
			video.muted = !on;
			reopen();
		}

		function setVolume(v) {
			volume = Math.max(0, Math.min(1, +v || 0));
			try { video.volume = volume; } catch (e) {}
		}

		// Every browser with WebRTC can decode Opus; there is no equivalent of
		// the MSE path's codec probe because the camera offers what this end
		// listed and nothing else.
		function audioSupported() { return rtcOk; }

		function destroy() {
			closed = true;
			if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
			stop();
		}

		if (!rtcOk) {
			onState('fallback', 'WebRTC unavailable');
			return {
				setStream: function () {}, requestIdr: function () {},
				setAudio: function () {}, setVolume: function () {},
				audioSupported: function () { return false; },
				destroy: function () {}, supported: false,
			};
		}

		open();
		return {
			setStream: setStream, requestIdr: requestIdr,
			setAudio: setAudio, setVolume: setVolume,
			audioSupported: audioSupported,
			destroy: destroy, supported: true,
		};
	}

	return { attach: attach, available: rtcOk };
})();
