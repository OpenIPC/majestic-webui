// Sound beside a picture that cannot carry any (#760).
//
// Two rungs of the Live page's chain paint a picture and nothing else: the
// software decoder (preview-wasm.js), which reads the /ws/video bytes without
// their audio, and the MJPEG floor (preview-multipart.js). Both answer
// audioSupported() false, so the page took the sound control away -- which on
// an H.265 camera is every browser without a hardware HEVC decoder: Chrome on
// a Linux desktop, Firefox. The control appeared while WebRTC was trying and
// vanished the moment the software picture took the stage.
//
// What this does instead: wraps such a player in the same façade, and carries
// its sound on a sound-only WebRTC session of its own -- the mode
// preview-webrtc.js already has for a camera with no video channel, which
// offers one audio section and no video, so the codec that defeated the
// picture never enters the negotiation. On plain HTTP that is everything
// Listen needs: RTCPeerConnection and the ws:// signalling socket, neither of
// them a secure-context API. Talk rides on the same session where the page is
// HTTPS; on HTTP the browser has no microphone to give, here exactly as on
// every other transport, and micSupported() says so.
//
// What it refuses:
//
//  * A session nobody is listening to. The companion exists while Listen or
//    Talk is on and is destroyed when both are off -- a negotiated audio
//    section has the camera encode Opus, and that is not free on a camera.
//  * Opening before the picture has played. A staged trial is opened with the
//    viewer's Listen already on, while the player it is replacing is still on
//    stage and still sounding; opening at attach would play the two together.
//    'playing' is what promotes a trial, and the outgoing player goes then.
//  * Speaking for the picture. The companion's states never reach the page's
//    onState -- they would drive the fallback chain, and a sound session that
//    failed says nothing about a picture that is playing. A companion that
//    gives up ('fallback', 'busy') is reported as what it is: no audio, and
//    the microphone off.
//
// Not done: sound from the software picture's own socket. majestic muxes Opus
// into the same fragments (a second traf in each moof), so the decoder worker
// could split it out and the page play it against the canvas clock, one
// session and UDP-free. It would take a hevc-wasm release and an Opus player,
// and it could only ever listen; this can also talk.
//
// `window.MajesticWebRTC` is preview-webrtc.js, resolved at use so a test can
// install a stub.
window.MajesticSound = (function () {
	'use strict';

	const RTC = () => window.MajesticWebRTC;

	// open(opts) attaches the picture with the opts it is handed, so the
	// wrapper can see the picture's states before the page does. The rest of
	// opts is what the page gave the picture: stream, iceServers, audio,
	// volume and the handlers.
	function beside(open, opts) {
		opts = opts || {};
		const pageState = opts.onState || function () {};
		const onAudio = opts.onAudio || function () {};
		const onMic = opts.onMic || function () {};

		let stream = opts.stream | 0;
		let volume = opts.volume === undefined ? 1 : opts.volume;
		// What the viewer has asked for. Kept here rather than read off the
		// companion, because the companion comes and goes and these do not.
		let listen = !!opts.audio, talk = false;
		let played = false, dead = false;
		let el = null, sound = null;

		function close() {
			if (sound) { try { sound.destroy(); } catch (e) {} sound = null; }
			if (el) {
				try { el.srcObject = null; } catch (e) {}
				try { el.remove(); } catch (e) {}
				el = null;
			}
		}

		// The companion's own failure, kept off the page's onState. Only the
		// two states it never comes back from: 'error' and 'nosignal' are its
		// own reconnect ladder at work, and it says 'fallback' when that runs
		// out.
		function companionState(mine, state, why) {
			if (mine !== sound) return;
			if (state !== 'fallback' && state !== 'busy') return;
			const hadMic = talk;
			listen = false;
			talk = false;
			close();
			onAudio(null);
			if (hadMic) onMic('off', why || 'the camera stopped answering');
		}

		function ensure() {
			if (dead || sound || !played || !(listen || talk)) return;
			const R = RTC();
			if (!R || !R.available) return;
			el = document.createElement('audio');
			el.hidden = true;
			try { document.body.appendChild(el); } catch (e) {}
			let mine = null;
			mine = R.attach(el, {
				stream: stream,
				iceServers: opts.iceServers,
				audioOnly: true,
				audio: listen,
				volume: volume,
				onState: (s, why) => companionState(mine, s, why),
				onAudio: (codec) => { if (mine === sound) onAudio(codec); },
				onMic: (state, why) => {
					if (mine !== sound) return;
					// Accepted, so the camera's audio comes with it and the
					// page ticks Listen (preview-page.js's onMic). Follow it,
					// or Talk off would close a session the Listen control
					// still says is playing -- and unmute this element, which
					// a sound-only session opened for Talk alone left muted.
					if (state === 'on' && !listen) { listen = true; mine.setAudio(true); }
					if (state === 'off') {
						talk = false;
						onMic(state, why);
						if (!listen) close();
						return;
					}
					onMic(state, why);
				},
			});
			sound = mine;
			// Talk asked for before the picture had played: asked now.
			if (talk) mine.setMic(true);
		}

		const picture = open(Object.assign({}, opts, {
			onState: function (state) {
				if (state === 'playing' && !played) { played = true; ensure(); }
				return pageState.apply(this, arguments);
			},
			// Both pictures say "no audio" once, at attach, which is true of
			// them and false of this pair: passed on, it would untick a
			// Listen the companion is about to honour. The sound is the
			// companion's to report.
			onAudio: function () {},
		}));

		function micAvailable() {
			const R = RTC();
			return !!(R && R.available && R.micAvailable && R.micAvailable());
		}

		return Object.assign({}, picture, {
			setStream: function (n) {
				stream = n | 0;
				picture.setStream(n);
				if (sound) sound.setStream(stream);
			},
			setAudio: function (on) {
				listen = !!on;
				if (sound) {
					if (!listen && !talk) { close(); return; }
					sound.setAudio(listen);
					return;
				}
				ensure();
			},
			setVolume: function (v) {
				volume = Math.max(0, Math.min(1, +v || 0));
				if (sound) sound.setVolume(volume);
			},
			audioSupported: function () {
				const R = RTC();
				return !!(R && R.available);
			},
			setMic: function (on) {
				on = !!on;
				if (!micAvailable()) {
					if (on) onMic('off', window.isSecureContext
						? 'no microphone available'
						: 'a browser only grants microphone access over HTTPS');
					return;
				}
				if (on === talk) return;
				talk = on;
				// Before the picture has played there is no session to ask:
				// the request stands, and ensure() makes it when one opens.
				if (!sound) { ensure(); return; }
				if (!on && !listen) {
					// Nobody listening either: the session goes, and the
					// microphone with it (destroy releases it first). Said
					// here, because a destroyed player reports nothing.
					close();
					onMic('off', '');
					return;
				}
				sound.setMic(on);
			},
			micSupported: micAvailable,
			destroy: function () {
				if (dead) return;
				dead = true;
				// The microphone first, with the session that holds it.
				close();
				picture.destroy();
			},
		});
	}

	return { beside: beside };
})();
