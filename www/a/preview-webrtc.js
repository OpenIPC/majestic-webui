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
//
// 'busy' is the same instruction with a shorter shelf life — the camera is out
// of session slots rather than unable to serve this browser — so a caller that
// remembers 'fallback' should not remember this one.
window.MajesticWebRTC = (function () {
	// How long to wait for media before saying so. Longer than MSE's 4 s: ICE
	// and DTLS happen first, and on a camera gathering a reflexive address
	// that is a round trip to a STUN server before anything can flow.
	const NO_SIGNAL_MS = 8000;

	// How long media may stop arriving before the session counts as dead, and
	// how often to look.
	//
	// Needed here in a way it is not on the MSE path, where media rides the
	// signalling socket: if that camera stops sending, the socket closes or the
	// element errors, and either one reconnects. WebRTC's media is out-of-band,
	// so a stalled stream is invisible to signalling — ICE stays connected, the
	// socket stays open, and the viewer keeps a frozen frame for as long as the
	// tab is left alone. A camera disappearing under a SIGHUP reload does
	// exactly this.
	const STALL_MS = 8000;
	const STATS_MS = 1000;

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

		// Which connection attempt is current. Everything asynchronous here
		// outlives the attempt that started it — createOffer and getStats
		// settle after the peer connection is closed, and a WebSocket goes on
		// firing onclose after nothing is listening — so each attempt stamps
		// itself and its continuations check before touching shared state.
		//
		// Without it a socket from a dead attempt clears `ws` on its way out
		// and takes the live attempt's signalling with it: the offer goes
		// nowhere, no answer comes back, and the page just sits there.
		let attempt = 0;
		const current = (my) => !closed && my === attempt;

		// Progress, not totals: bytesReceived only ever climbs, so "greater
		// than zero" says a session once worked, not that it still does.
		let lastBytes = 0, stalledMs = 0, healthyMs = 0;

		// What to tell the page if the attempts run out. Which of the ways this
		// can fail it was is worth carrying: "no media arrived" and "could not
		// establish a session" send whoever reads the tooltip to different
		// halves of docs/webrtc-browser-interop.md. Phrased to follow the
		// page's own "WebRTC: " prefix rather than to repeat it.
		let lastFailure = 'could not establish a session';

		// Why this ends the attempt rather than just reporting it: a session can
		// negotiate perfectly and still never deliver a byte — a middlebox that
		// passes DTLS and drops SRTP, an encoder that never emits a keyframe —
		// and nothing else in here would ever notice. The socket is open, so no
		// onclose; ICE is connected, so no failure; the offer was answered. The
		// page would sit on the no-signal bars for as long as the tab stayed
		// open, when MSE might well have worked.
		//
		// So say so, then retire the attempt. The existing escalation does the
		// rest: three fruitless attempts and the page is told to change
		// transport.
		function armSignalTimer(my) {
			clearTimeout(signalTimer);
			signalTimer = setTimeout(function () {
				if (gotMedia || !current(my)) return;
				onState('nosignal');
				lastFailure = 'negotiated but no media arrived';
				reconnect();
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
			const my = attempt;
			pc.getStats().then(function (report) {
				if (!current(my)) return;
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
					onState('playing', codec);
				}
				if (gotMedia) {
					// The no-signal watchdog was disarmed when the first bytes
					// arrived and nothing else is watching, so this is what
					// notices a stream that stops. Retire the attempt on a
					// stall and let the usual escalation decide between another
					// try and another transport.
					if (bytes > lastBytes) {
						lastBytes = bytes;
						stalledMs = 0;
						// Forgive the earlier failures only once this session
						// has held up for as long as it would take to call it
						// stalled. Crediting the first byte instead lets a
						// session that starts and dies over and over reset the
						// count every time and retry for ever, which is the
						// one outcome the escalation exists to prevent.
						if ((healthyMs += STATS_MS) >= STALL_MS) {
							failCount = 0;
							lastFailure = 'could not establish a session';
						}
					} else if ((stalledMs += STATS_MS) >= STALL_MS) {
						lastFailure = 'media stopped arriving';
						reconnect();
					}
				}
				if (w && h && (codec !== lastCodec || w !== lastW || h !== lastH)) {
					lastCodec = codec; lastW = w; lastH = h;
					onCodec(codec, codec, w, h);
				}
			}).catch(function () {});
		}

		// Whether the answer actually carried the audio we asked to receive.
		// 'inactive' or an unset direction means the camera declined it — mic
		// off, or not producing.
		function negotiatedAudio() {
			if (!pc || !pc.getTransceivers) return false;
			return pc.getTransceivers().some(function (t) {
				return t.receiver && t.receiver.track &&
					t.receiver.track.kind === 'audio' &&
					t.currentDirection && t.currentDirection !== 'inactive';
			});
		}

		function teardownPc() {
			clearInterval(statsTimer); statsTimer = null;
			if (pc) {
				try {
					pc.ontrack = null;
					pc.onicecandidate = null;
					pc.oniceconnectionstatechange = null;
				} catch (e) {}
				try { pc.close(); } catch (e) {}
				pc = null;
			}
			try { video.srcObject = null; } catch (e) {}
			gotMedia = false;
			lastCodec = ''; lastW = 0; lastH = 0;
		}

		// Detach before closing. A socket closes asynchronously, and until it
		// does its handlers are still live on a connection nobody wants any
		// more — including the onclose that would call reconnect() a second
		// time and the one that would null out a socket the next attempt has
		// already opened.
		function dropSocket() {
			if (!ws) return;
			const dead = ws;
			ws = null;
			try { dead.onopen = dead.onmessage = dead.onclose = dead.onerror = null; } catch (e) {}
			try { dead.close(); } catch (e) {}
		}

		function open() {
			if (closed) return;
			const my = ++attempt;
			onState('connecting');
			teardownPc();
			dropSocket();
			lastBytes = 0; stalledMs = 0; healthyMs = 0;

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
				video.play().catch(function (err) {
					// Only one rejection means the sound is the problem.
					// NotAllowedError is autoplay policy refusing unmuted
					// playback, and leaving a paused video with no explanation
					// is the worst outcome available — so take the picture over
					// the sound and say which was lost.
					//
					// Every other rejection is ordinary. ontrack fires once per
					// track, so the audio track's call reassigns srcObject and
					// aborts the video track's play() with AbortError: treating
					// that as an autoplay refusal reports "no audio" over a
					// working Opus stream, which is exactly what it did.
					if (!current(my) || video.muted) return;
					if (!err || err.name !== 'NotAllowedError') return;
					onAudio(null);
					// Renegotiate rather than just muting. The audio
					// transceiver is only ever added when wantAudio is set,
					// precisely so the camera does not encode for nobody — and
					// a track the browser has refused to play is nobody.
					// Dropping the flag alone would leave the camera sending
					// Opus into a muted element until something else happened
					// to reconnect.
					//
					// wantAudio is necessarily true here: the element was
					// unmuted, which only happens when it is. So this is a real
					// transition and setAudio does the mute and the reopen.
					setAudio(false);
				});
				if (ev.track && ev.track.kind === 'audio') onAudio('opus');
			};
			pc.onicecandidate = function (ev) {
				if (ev.candidate) send('candidate', ev.candidate.candidate);
			};
			pc.oniceconnectionstatechange = function () {
				if (!pc || !current(my)) return;
				const s = pc.iceConnectionState;
				if (s === 'failed' || s === 'closed') reconnect();
				else if (s === 'disconnected') onState('error');
			};

			const proto = location.protocol === 'https:' ? 'wss' : 'ws';
			// Held in a local as well, so every handler below acts on the
			// socket it was installed on rather than on whatever `ws` happens
			// to point at by the time it fires.
			const sock = new WebSocket(
				proto + '://' + location.host + '/ws/webrtc?stream=' + stream);
			ws = sock;
			gotMedia = false;

			sock.onopen = function () {
				if (!current(my)) return;
				backoff = 1000;
				armSignalTimer(my);
				pc.createOffer()
					.then(function (offer) {
						if (!current(my)) return;
						return pc.setLocalDescription(offer).then(function () {
							if (!current(my)) return;
							send('offer', pc.localDescription.sdp);
						});
					})
					.catch(function () {
						// A closed peer connection rejects whatever was in
						// flight, so this fires on every ordinary teardown too.
						// Only a live attempt has actually failed to offer.
						if (current(my)) onState('fallback', 'offer failed');
					});
			};
			sock.onmessage = function (e) {
				if (!current(my)) return;
				let m; try { m = JSON.parse(e.data); } catch (_) { return; }
				if (!m) return;
				if (m.reply === 'answer') {
					pc.setRemoteDescription({ type: 'answer', sdp: m.data })
						.then(function () {
							if (!current(my)) return;
							// Did the camera take the audio we offered to
							// receive? Ask the transceivers rather than
							// watching for an ontrack that may not have fired
							// yet: the track events are queued tasks and this
							// promise is another, and assuming an order between
							// them reports "no audio" over a working Opus
							// stream. currentDirection is the negotiated answer
							// and is settled by the time we are here.
							if (wantAudio && !negotiatedAudio()) {
								// Mirror preview.js: stop wanting it, so the
								// element matches the video-only session it
								// actually has and a later unmute really does
								// flip and renegotiate rather than no-op.
								wantAudio = false;
								video.muted = true;
								onAudio(null);
							}
						})
						.catch(function () {
							if (current(my)) onState('fallback', 'answer rejected');
						});
				} else if (m.reply === 'candidate') {
					// Handed over without waiting for the answer to be applied,
					// which is safe rather than sloppy: addIceCandidate chains
					// onto the same operations queue as setRemoteDescription,
					// so one queued behind a pending answer runs after it.
					// Measured on this camera — it trickles three candidates and
					// one of them does arrive before the answer is installed;
					// all three reach ICE.
					pc.addIceCandidate({ candidate: m.data, sdpMid: m.mid })
						.catch(function () {});
				} else if (m.reply === 'busy') {
					// Full, not incapable — every slot is taken and this same
					// offer would be answered once one frees. Same move as a
					// refusal, MSE now rather than a frozen page, but reported
					// apart from one so the caller does not conclude anything
					// lasting about this browser. No retry either: hammering a
					// camera that just said it is out of room helps nobody.
					onState('busy', m.data || 'the camera is serving as many viewers as it can');
					stop();
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
			sock.onclose = function () {
				if (ws === sock) ws = null;
				if (current(my)) reconnect();
			};
			sock.onerror = function () { try { sock.close(); } catch (e) {} };

			clearInterval(statsTimer);
			statsTimer = setInterval(pollStats, STATS_MS);
		}

		function reconnect() {
			// Retire the attempt before dismantling it. Closing a peer
			// connection rejects whatever it had in flight, and a rejection
			// that arrives while its own attempt still looks current would be
			// reported as a genuine failure to offer.
			attempt++;
			clearTimeout(signalTimer);
			teardownPc();
			dropSocket();
			if (closed || reconnectTimer) return;
			// Fewer attempts than the MSE path allows itself. Its failures are
			// transient by nature — a socket dropped, a keyframe missed —
			// while a WebRTC session that will not establish usually will not
			// establish on the fourth try either, and every attempt costs a
			// full ICE and DTLS exchange.
			if (++failCount >= 3) {
				onState('fallback', lastFailure);
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
			// Past this point nothing in flight belongs to anyone: bumping the
			// attempt is what makes the continuations above return instead of
			// reporting a failure that no longer has a session to fail.
			attempt++;
			clearTimeout(signalTimer);
			clearInterval(statsTimer); statsTimer = null;
			dropSocket();
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
			onState('fallback', 'unavailable in this browser');
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
