// ICE restart: a session whose network path died, mended on the same
// RTCPeerConnection (RFC 8445 §9, RTCPeerConnection.restartIce()).
//
// Both players that negotiate over /ws/webrtc use it: the media player
// (preview-webrtc.js) and the data-channel feed (preview-datachannel.js).
// Without it the only answer to a dead path was a whole new session — a new
// socket, a new offer, DTLS from the start, a decoder waiting on a keyframe —
// and a phone moving from Wi-Fi to mobile data paid that every time. A
// restart asks only for new candidates. The camera keeps the DTLS
// association, SRTP, the track and the decoder, and asks its encoder for a
// keyframe once the new path is up.
//
// The camera's half: a second offer on a session that already has an answer
// is a restart when it carries new ICE credentials, and is answered on the
// same socket, followed by the new generation's candidates. When its consent
// expires on an established session it stops sending and holds the session
// for 90 s, waiting for exactly this.
//
// What it is NOT: the fallback. Two attempts that do not bring ICE back hand
// the session to the caller's `lost`, which is the reconnect it would have
// run anyway — so a path that will not come back costs at most 32 s more
// than it did, and one that does costs no new session at all.
window.MajesticIce = (function () {
	'use strict';

	// 'disconnected' is often a moment, not a loss: a few consent checks
	// missed on a busy Wi-Fi and the browser goes back to 'connected' on its
	// own. Two seconds lets that happen without a renegotiation.
	const GRACE_MS = 2000;
	// Per attempt: a round trip for the offer, a STUN gather, and checks on
	// the new pairs, through a relay if that is where the path goes.
	const ATTEMPT_MS = 15000;
	const ATTEMPTS = 2;

	const up = (s) => s === 'connected' || s === 'completed';

	// One restarter per peer connection. The caller supplies:
	//   pc()        the peer connection, or null once it is retired
	//   sig()       the signalling handle (preview-signal.js), or null
	//   played()    whether this session has carried media at least once
	//   lost()      give up: the caller's own reconnect
	// and routes to it every ICE state change, every answer and every
	// candidate. answer() and candidate() return true for what they took.
	function restarter(o) {
		let grace = null, timer = null, tries = 0, dead = false;
		// Offers sent and answers seen since the first restart. The camera
		// answers every offer, in order, on an ordered socket, so the Nth
		// answer is the Nth offer's — which is how an answer to an offer a
		// later attempt superseded is told apart from the one that counts.
		let sent = 0, seen = 0;
		// Candidates that arrived while a restart offer was outstanding, or
		// while its answer was being applied; null while nothing is.
		let held = null;
		// Which attempt is current, and the offer work of the last one. An
		// attempt that outlives its 15 s (a createOffer or setLocalDescription
		// that is slow to settle) must not go on to set a description or send
		// an offer once a later attempt has started, or the Nth answer stops
		// being the Nth offer's. Each step checks the generation, and a new
		// attempt waits for the previous one's work before it starts its own.
		let gen = 0, work = Promise.resolve();

		function clear() {
			clearTimeout(grace); grace = null;
			clearTimeout(timer); timer = null;
		}

		function giveUp() {
			clear();
			held = null;
			dead = true;
			o.lost();
		}

		function attempt() {
			grace = null;
			clearTimeout(timer); timer = null;
			const pc = o.pc(), sig = o.sig();
			if (dead || !pc) return;
			// A socket that is gone cannot carry the offer. The caller's own
			// close handler normally gets there first; this is for a socket
			// caught closing.
			if (tries >= ATTEMPTS || !sig || !sig.live()) { giveUp(); return; }
			tries++;
			const my = ++gen;
			const live = function () { return !dead && my === gen && o.pc() === pc; };
			timer = setTimeout(expire, ATTEMPT_MS);
			work = work.then(function () {
				if (!live()) return;
				try { if (pc.restartIce) pc.restartIce(); } catch (e) {}
				return pc.createOffer({ iceRestart: true }).then(function (offer) {
					if (!live()) return;
					return pc.setLocalDescription(offer).then(function () {
						if (!live()) return;
						const s = o.sig();
						if (s && s.send('offer', pc.localDescription.sdp)) {
							sent++;
							if (!held) held = [];
						}
					});
				});
			})
				// Nothing to report: the attempt's timer is still running, and
				// it either tries again or gives up.
				.catch(function () {});
		}

		// The attempt's time is up. Chrome may fire no state change at all for
		// a restart of a path that never actually went down, so the state is
		// read here rather than waited for: connected means done.
		function expire() {
			timer = null;
			const pc = o.pc();
			if (dead || !pc) return;
			if (up(pc.iceConnectionState)) { tries = 0; return; }
			attempt();
		}

		function state(s) {
			if (dead) return;
			if (up(s)) { clear(); tries = 0; return; }
			// A session that never played has nothing to keep: its failure is
			// the caller's to handle as it always has.
			if (!o.played()) return;
			// One attempt at a time; its timer decides what comes next.
			if (timer) return;
			if (s === 'failed') {
				clearTimeout(grace);
				attempt();
			} else if (s === 'disconnected' && !grace) {
				grace = setTimeout(function () {
					grace = null;
					const pc = o.pc();
					if (pc && !up(pc.iceConnectionState)) attempt();
				}, GRACE_MS);
			}
		}

		function answer(sdp) {
			// Before any restart the answer is the session's first, and
			// belongs to whoever offered it.
			if (!sent) return false;
			const pc = o.pc();
			// Dropped, not an error: it answers an offer a later attempt
			// replaced, or arrived after the offer was already settled.
			if (++seen !== sent || !pc || pc.signalingState !== 'have-local-offer') return true;
			// The camera sends its answer before the new generation's
			// candidates, so whatever was held until now belongs to a
			// generation this answer replaces.
			held = [];
			pc.setRemoteDescription({ type: 'answer', sdp: sdp })
				.then(function () {
					if (dead || o.pc() !== pc) return;
					const h = held || [];
					held = null;
					h.forEach(function (c) {
						pc.addIceCandidate(c).catch(function () {});
					});
				})
				.catch(function () { held = null; });
			return true;
		}

		function candidate(line, mid) {
			if (!held) return false;
			held.push({ candidate: line, sdpMid: mid });
			return true;
		}

		// Whether recovery is the restart's right now: the caller's own
		// watchdogs stand down while ICE is anything but up.
		function recovering() {
			const pc = o.pc();
			return !dead && !!pc && !up(pc.iceConnectionState);
		}

		// Whether a restart offer is out and unanswered. The camera answers
		// an offer with an answer or an error, in order, so an error now is
		// its reply to the restart, not to the session's first offer.
		function restarting() {
			return !dead && sent > seen;
		}

		// The camera refused the restart (an error in reply to its offer).
		// That says nothing lasting about this browser or this camera — the
		// session it refused had been playing — so it ends as a lost path
		// does, through the caller's reconnect, and never as a refusal of the
		// session itself.
		function refused() {
			if (dead) return;
			seen++;
			giveUp();
		}

		function stop() {
			dead = true;
			clear();
			held = null;
		}

		return {
			state: state, answer: answer, candidate: candidate,
			recovering: recovering, restarting: restarting, refused: refused,
			stop: stop,
		};
	}

	return {
		restarter: restarter, up: up,
		GRACE_MS: GRACE_MS, ATTEMPT_MS: ATTEMPT_MS, ATTEMPTS: ATTEMPTS,
	};
})();
