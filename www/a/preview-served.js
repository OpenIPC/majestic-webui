// The served-channel rule, shared by the Live View page and the settings
// preview so a fix lands in one place.
//
// WebRTC takes ?stream= as a preference, not an order: the camera can serve the
// other channel — a codec its negotiation can give this browser, or a fault
// that once had Main selected while Sub was on screen with nothing admitting
// it. A camera whose firmware states in the signalling which channel a
// session actually serves (#240/#249), and this decides what the picker should
// then say and do. The DECISION is pure; a small applier holds the state that
// remembers what has already been said and turns each reply into the caller's
// own effects — moving its radios, wording its message — because those differ
// between the two pages while the rule does not.
//
// A substitution is not always the answer to take. The camera can only answer
// for WebRTC: it serves the other channel because that is all it can give this
// peer over this transport, and it cannot know that /ws/video would carry the
// channel asked for to a browser that decodes it there, or to the software
// decoder. With the same codec on both channels it refuses instead, that refusal
// walks the fallback chain, and the viewer gets their channel; with different
// codecs it succeeds, nothing fails, and a channel this browser can play could
// not be reached by pressing it (#713). So a pick the viewer made is walked down
// the chain for that channel, and the substitute stays on screen until something
// replaces it — or for good, moved to and said as before, if nothing can.
window.MajesticServed = (function () {
	'use strict';

	// The rule, as a pure function of the reply and the current ask.
	//
	//   info      the reply: { channel, requested, reason }.
	//   wanted    the channel the viewer themselves asked for, or null. Distinct
	//             from what is playing: after a fallback the session adopts the
	//             served channel, so every internal reopen requests it and is
	//             answered with a match — but the viewer's own ask is still
	//             unmet, and the standing explanation must not vanish on it.
	//   shownKey  the say-once key of the message already on screen: a reconnect
	//             or audio renegotiation re-delivers the same reply, and the
	//             second telling would be noise.
	//
	// Returns { servedCh, wanted, key, adopt, message, hide }. Three verdicts:
	//   - a mismatch: adopt = the served channel to move the radios to, message
	//     = the reply to word (null once said), key = the new say-once key,
	//     wanted = the betrayed request;
	//   - a match that clears a stale message: hide = true, key = '';
	//   - a match to the adopted channel while the ask stands unmet, or an
	//     unknown/older-daemon reply: everything left as it was.
	function decide(info, wanted, shownKey) {
		var servedCh = (info.channel === 0 || info.channel === 1)
			? info.channel : null;
		// Older daemons never say; nothing to reflect, nothing to disturb.
		if (servedCh === null) {
			return { servedCh: null, wanted: wanted, key: shownKey,
				adopt: null, message: null, hide: false };
		}
		// The camera stated the channel but not the request (the signalling
		// parser maps an omitted `requested` to null): a mismatch cannot be told
		// and there is no "instead of X" to word, but the picture IS on servedCh,
		// so the radios follow it — silently. Any standing message and its key
		// are left as they are.
		if (info.requested === null) {
			return { servedCh: servedCh, wanted: wanted, key: shownKey,
				adopt: servedCh, message: null, hide: false };
		}
		var mismatch = info.channel !== info.requested;
		if (!mismatch) {
			// A match the viewer never asked for is not good news: a reopen
			// inside a fallen-back session requests the adopted channel and is
			// answered with it while the viewer's own ask stands unmet. Leave
			// the explanation exactly as it is.
			if (wanted !== null && servedCh !== wanted) {
				return { servedCh: servedCh, wanted: wanted, key: shownKey,
					adopt: null, message: null, hide: false };
			}
			// Served as asked (or nothing was asked): any standing message
			// describes a mismatch that no longer exists.
			return { servedCh: servedCh, wanted: wanted, key: '',
				adopt: null, message: null, hide: true };
		}
		// The betrayed ask, remembered past the adoption: the controls follow
		// the channel the session actually landed on, and the viewer's original
		// radio is now genuinely unchecked — which is what makes re-picking it a
		// real change and a real renegotiation.
		var key = info.requested + '>' + info.channel + ':' + info.reason;
		return { servedCh: servedCh, wanted: info.requested, key: key,
			adopt: servedCh, message: key !== shownKey ? info : null,
			hide: false };
	}

	// Whether a reply is one to walk rather than accept. Only `undecodable`: an
	// `unavailable` channel has nothing to carry over any transport. Only for a
	// viewer's own pick (`asked`): Auto, a default nobody chose and a caller
	// choosing channels by rule all got a picture they have no claim against,
	// and the camera's answer is better for them than a slower transport.
	function walks(info, asked) {
		return !!asked && info.reason === 'undecodable' &&
			(info.channel === 0 || info.channel === 1) &&
			(info.requested === 0 || info.requested === 1) &&
			info.channel !== info.requested;
	}

	// What the viewer is told once the buffered player carries the channel. The
	// software rung says its own piece, which is about the decoder.
	function walkSentence(info) {
		return 'This browser’s WebRTC can’t decode the ' +
			(info.requested === 0 ? 'Main' : 'Sub') +
			' stream’s format — playing it over MSE, with more delay.';
	}

	// The walk's state, which both pages wire to their own swap. opts:
	//   asked()         is the channel on screen the viewer's own pick?
	//   start(rung)     stage this rung as a trial; WebRTC stays on screen.
	//   next(kind, why) the chain's next(): a failed trial carries on down it.
	//   settle(info)    nothing could replace the substitute: take the reply as
	//                   if it had never been walked.
	//
	// The transport the viewer prefers is not touched, and neither is the record
	// of a demotion: WebRTC is working here, for the other channel, and leaving
	// this one goes back to it. leave() is how a caller finds that out.
	function walker(opts) {
		let held = null;      // the reply being walked, until the walk ends
		let carried = false;  // a rung the walk reached is on screen
		return {
			offer: function (info) {
				if (!walks(info, opts.asked())) return false;
				held = info;
				carried = false;
				opts.start('mse');
				return true;
			},
			// A trial dropped. With WebRTC still playing, the swap counts that as
			// the end of the matter, which would stop the walk at MSE on the
			// browsers the software rung exists for.
			failed: function (kind, why) {
				if (held === null) return false;
				opts.next(kind, why);
				return true;
			},
			exhausted: function () {
				if (held === null) return false;
				const info = held;
				held = null;
				opts.settle(info);
				return true;
			},
			// A rung took the stage. Returns the reply it answers, or null.
			promoted: function (kind) {
				const info = held;
				held = null;
				carried = info !== null && kind !== 'webrtc';
				return info;
			},
			// Forget the walk. True if there was one to forget, which is the
			// caller's cue that the transport on screen is not the preferred one.
			leave: function () {
				const was = held !== null || carried;
				held = null;
				carried = false;
				return was;
			},
		};
	}

	// A stateful applier: it owns servedCh / wanted / shownKey and turns a reply
	// into effects the caller wires to its own DOM. opts:
	//   adopt(ch)  move the picker to channel ch — by writing .checked, so no
	//              change event fires and the caller's stream-switch does not
	//              re-enter and cut the very session that reported this.
	//   show(info) word and show the message.
	//   hide()     hide any standing message.
	//   auto()     true when the picker is in Auto (the Live page only): a
	//              mismatch is then disclosed by the chip, not by moving the
	//              radios or showing a message — but a match still clears a stale
	//              one, and the betrayed ask is still remembered, exactly as the
	//              page did inline.
	function make(opts) {
		opts = opts || {};
		var servedCh = null, wanted = null, shownKey = '';
		function apply(info) {
			var auto = opts.auto && opts.auto();
			var d = decide(info, wanted, shownKey);
			servedCh = d.servedCh;
			wanted = d.wanted;
			if (d.adopt !== null) {          // a mismatch
				if (!auto) {
					shownKey = d.key;
					if (opts.adopt) opts.adopt(d.adopt);
					if (d.message && opts.show) opts.show(d.message);
				}
				// In Auto: the ask is remembered above, the chip discloses the
				// channel, and the radios and message are left untouched.
			} else if (d.hide) {             // a match: a stale message is stale
				shownKey = '';
				if (opts.hide) opts.hide();
			}
			// else a match to the adopted channel while the ask is unmet: leave
			// the standing message and its key exactly as they are.
		}
		// A deliberate channel change is a fresh ask; a non-WebRTC transport
		// serves the exact channel so a prior mismatch is moot. Either way the
		// state starts over, with the new channel (if any) as the ask the next
		// reply is judged against.
		function reset(newWanted) {
			servedCh = null;
			shownKey = '';
			wanted = newWanted === undefined ? null : newWanted;
			if (opts.hide) opts.hide();
		}
		return {
			apply: apply,
			reset: reset,
			// The channel the camera stated, or null — the Live page reads it to
			// decide which channel the picture belongs to (its chip and its
			// adaptation baseline), where the settings preview needs only the
			// radios apply() already moved.
			channel: function () { return servedCh; },
		};
	}

	// A holder around an applier, for a caller that stages sessions off-screen.
	// The settings preview attaches each transport as a hidden trial and promotes
	// it only once it proves a picture, so a served-channel reply can arrive for a
	// session that is not the one on screen — and may never be, if the trial
	// fails. The reply is kept against the attachment id that carried it and
	// applied only when that id is the one live; a trial that never goes live
	// never moves the radios. A page that applies replies directly (the Live View
	// page) does not need this and calls the applier itself.
	//
	//   applier   a make() handle (apply/reset/channel).
	// Returns { hold, flush, reset, held }:
	//   hold(id, info)  keep this reply against attachment id (replacing any).
	//   flush(isLive)   if the held reply's id is live now, apply it once and drop
	//                   it; isLive(id) is the caller's on-screen test.
	//   reset(n)        drop any held reply and reset the applier to ask n.
	//   held()          the held { id, info } or null (for tests and assertions).
	function holder(applier) {
		var held = null;
		return {
			hold: function (id, info) { held = { id: id, info: info }; },
			flush: function (isLive) {
				if (held && isLive(held.id)) {
					var info = held.info;
					held = null;
					applier.apply(info);
				}
			},
			reset: function (n) { held = null; applier.reset(n); },
			held: function () { return held; },
		};
	}

	return {
		decide: decide, make: make, holder: holder,
		walks: walks, walkSentence: walkSentence, walker: walker,
	};
})();
