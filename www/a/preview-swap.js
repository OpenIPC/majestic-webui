// Changing transport without the viewer paying for the attempt.
//
// A player cannot be swapped in place. MSE drives a video element through
// `src` and WebRTC through `srcObject`, so the incoming one has to evict the
// outgoing one before anybody knows whether it will run — and a refusal then
// costs a blank frame, a visible reconnect and a trip back to what was already
// working. That was the flicker on OpenIPC/majestic-webui#184, and the rule the
// reporter stated for it is the one implemented here:
//
//     nothing on screen changes until the replacement is known to work.
//
// So: two elements, only ever one visible. A trial attaches to whichever is
// idle and the live player keeps going. The picture changes exactly once, when
// the trial reports that it is playing. A trial that fails is destroyed and the
// screen never learns it happened.
//
// WHY THIS IS SHARED, when the fall-back dance next to it deliberately is not.
// That dance is a dozen lines and the two pages want different things from it —
// one has a badge, an MJPEG fallback and a toggle to keep in step, the other a
// bare video element. This is not that. It is a state machine with invariants
// that are not obvious and are wrong in quiet ways: two players live at once,
// an id per attachment because "is this the current generation" cannot describe
// two current things, and a dead player that must be marked or its last frame
// sits on screen for ever. A second copy would drift, and the drift would look
// like a picture rather than an error.
//
// What stays with the caller is every decision: what to try next, what to put
// on the badge, what a failure means. This owns only the swap.
window.MajesticSwap = function (opts) {
	// opts.elements   [visible, spare] — two video elements, the second hidden
	// opts.open       (kind, el, id, onState) -> player
	// opts.onLive     (state, detail, kind) — from the player on screen
	// opts.onPromoted (kind) — a trial has taken over
	// opts.onFailed   (kind, detail, permanent) — trial dropped, screen intact
	// opts.onExhausted(kind, detail, permanent) — trial dropped, nothing left
	const els = opts.elements;
	let live = null;     // { id, p, el, kind, dead }
	let staging = null;  // { id, p, el, kind }
	let seq = 0;

	// Which callbacks a caller's own handlers should answer to. Everything but
	// the state feed belongs to the player on screen alone: a trial has no
	// badge, no audio control and no talkback button to report to.
	function isLive(id) { return live !== null && live.id === id; }
	function isStaging(id) { return staging !== null && staging.id === id; }

	function spare() {
		return live && live.el === els[0] ? els[1] : els[0];
	}

	function show(el, on) {
		try { el.style.display = on ? '' : 'none'; } catch (e) {}
	}

	function kill(entry) {
		if (entry && entry.p) { try { entry.p.destroy(); } catch (e) {} }
	}

	function promote() {
		const s = staging;
		staging = null;
		if (live) {
			kill(live);
			show(live.el, false);
		}
		live = s;
		show(s.el, true);
		opts.onPromoted(s.kind);
	}

	// The trial failed. Leave the screen exactly as it was — unless what is on
	// screen is already dead, in which case there is nothing left to protect
	// and the caller has to decide where to go instead.
	function drop(detail, permanent) {
		const s = staging;
		staging = null;
		kill(s);
		if (opts.onFailed) opts.onFailed(s.kind, detail, permanent);
		if (live && !live.dead) return;
		if (live) { kill(live); live = null; }
		if (opts.onExhausted) opts.onExhausted(s.kind, detail, permanent);
	}

	// Try `kind`. If something is playing it keeps playing until this works.
	function start(kind) {
		// One trial at a time: a second click while the first is being judged
		// would leave the first running with nothing tracking it.
		if (staging) { kill(staging); staging = null; }

		const id = ++seq;
		const el = live ? spare() : els[0];
		// The other transport may have used this element a moment ago, and an
		// element carrying both a MediaSource url and a srcObject is a
		// confusing thing to debug.
		try { el.removeAttribute('src'); el.srcObject = null; } catch (e) {}

		staging = { id: id, p: null, el: el, kind: kind };

		const onState = function (state, detail) {
			if (isStaging(id)) {
				// A trial owns nothing on screen, so only two things it can say
				// matter: it worked, or it did not. Everything in between —
				// connecting, no signal, reconnecting — is exactly what must
				// not reach the page, because the point is that trying costs
				// the viewer nothing until it succeeds.
				if (state === 'playing') promote();
				else if (state === 'fallback' || state === 'busy' ||
					state === 'mjpeg') {
					drop(detail, state === 'fallback');
				}
				return;
			}
			if (!isLive(id)) return;
			opts.onLive(state, detail, live.kind);
		};

		const p = opts.open(kind, el, id, onState);

		// open() can report a failure before returning — MajesticWebRTC does
		// exactly that when RTCPeerConnection or addTransceiver throws — so the
		// handler has already run and thrown this attempt away. Assigning now
		// would resurrect it.
		if (!staging || staging.id !== id) {
			try { p.destroy(); } catch (e) {}
			return;
		}
		staging.p = p;

		// Nothing on screen to protect: this is the first attach, so the trial
		// is the live player and the caller hears about it immediately.
		if (!live) promote();
	}

	// The player on screen has given up. Its picture is a frozen frame from
	// here on; say so, or a replacement that also fails would leave it there
	// with nothing left to move it.
	function retire() { if (live) live.dead = true; }

	function stop() {
		kill(staging); staging = null;
		kill(live); live = null;
	}

	return {
		start: start,
		retire: retire,
		stop: stop,
		isLive: isLive,
		player: function () { return live && live.p; },
		element: function () { return live && live.el; },
		kind: function () { return live && live.kind; },
	};
};
