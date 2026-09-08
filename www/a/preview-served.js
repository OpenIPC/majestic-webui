// The served-channel rule, shared by the Live View page and the settings
// preview so a fix lands in one place.
//
// WebRTC takes ?stream= as a preference, not an order: the camera can serve the
// other channel — a codec its negotiation can give this browser, or a daemon
// fault (majestic#299 arrived as "Main selected, Sub displayed" with nothing
// admitting it). A new majestic states in the signalling which channel a
// session actually serves (#240/#249), and this decides what the picker should
// then say and do. The DECISION is pure; a small applier holds the state that
// remembers what has already been said and turns each reply into the caller's
// own effects — moving its radios, wording its message — because those differ
// between the two pages while the rule does not.
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
		var mismatch = info.requested !== null &&
			info.channel !== info.requested;
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

	return { decide: decide, make: make };
})();
