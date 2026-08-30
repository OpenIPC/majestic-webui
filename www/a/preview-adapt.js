// The adaptation toast: says so, at the moment the shared encoder moves.
//
// The transport note discloses that WebRTC *may* adapt the stream's bitrate;
// this is the other half — that it just *did*, in which direction, and whose
// connection did it. The distinction matters because the encoder is shared:
// rate changes reach every viewer of the channel and whatever is recording
// it, so a drop on your screen is not necessarily your link, and a drop you
// caused is not only your problem. That attribution is the whole reason this
// exists; a plain bitrate readout already lives in the stats panel.
//
// Fed from the camera's own per-second stats line rather than inferred from
// received throughput: enc= is where the bitrate arbitration actually holds
// the encoder (0 = untouched, at the configured rate), remb= this session's
// own estimate. Measured receive rate breathes with scene complexity, so a
// toast built on it would cry wolf on every busy frame; enc= only moves when
// the camera really moved the encoder. On a majestic without the counter the
// tick never sees one and nothing here ever shows.
//
// Attribution is a comparison, not a message from the camera: the encoder
// follows the lowest live estimate, so if our own estimate sits at (or near)
// the new rate we are the floor — "your connection"; if ours is well above
// it, somebody else's is — "another viewer". Near, not equal, because the
// camera clamps and quantises what it applies.
window.MajesticAdapt = (function () {
	// How long a toast stands once shown. No confirmation phase, unlike a
	// buffered player's toast: WebRTC has no buffer to drain, so the rate on
	// screen is the new rate within a round trip of the decision.
	const SHOW_MS = 6000;

	let el = null, ratesEl = null, whyEl = null;
	// Last applied rate seen, in kbps, 0 = configured; null = no tick yet.
	// Kept per channel is not needed: reset() is called on a channel switch,
	// because the two channels' encoders move independently.
	let last = null;
	let hideTimer = null, pinned = false, wired = false;

	function fmt(kbps) {
		return kbps >= 1000
			? (kbps / 1000).toFixed(1).replace(/\.0$/, '') + ' Mbit/s'
			: kbps + ' kbit/s';
	}

	function wire() {
		if (wired || !el) return;
		wired = true;
		// Hover pins — someone reading it should not have it vanish mid-
		// sentence. Click dismisses; stopPropagation keeps the tap from also
		// toggling the control bar underneath (the stage owns that tap).
		el.addEventListener('mouseenter', function () {
			pinned = true;
			clearTimeout(hideTimer);
		});
		el.addEventListener('click', function (ev) {
			ev.stopPropagation();
			hide();
		});
	}

	function hide() {
		clearTimeout(hideTimer);
		pinned = false;
		if (el) el.hidden = true;
	}

	function show(fromK, toK, why, up) {
		if (!el || !ratesEl || !whyEl) return;
		ratesEl.innerHTML = '';
		ratesEl.appendChild(document.createTextNode(fmt(fromK) + ' '));
		const arrow = document.createElement('span');
		arrow.className = up ? 'mj-adapt-up' : 'mj-adapt-down';
		arrow.textContent = (up ? '↗ ' : '↘ ') + fmt(toK);
		ratesEl.appendChild(arrow);
		whyEl.textContent = why;
		// A new step replaces whatever was showing, pin included: the pin
		// held the old news, and this is news.
		pinned = false;
		el.hidden = false;
		clearTimeout(hideTimer);
		hideTimer = setTimeout(function () {
			if (!pinned) hide();
		}, SHOW_MS);
	}

	// One reading of the camera's stats line, once a second while WebRTC is
	// the live transport. All rates in kbps; enc 0 means "at the configured
	// rate", configured 0 means the config has not landed (or names no sane
	// rate), and a step whose either end is unknowable is skipped rather
	// than guessed at.
	function tick(t) {
		if (!el) {
			el = document.getElementById('mj-adapt');
			ratesEl = document.getElementById('mj-adapt-rates');
			whyEl = document.getElementById('mj-adapt-why');
			wire();
		}
		const cur = t.enc | 0;
		if (last === null) {
			// First reading of this session or channel: adopt, don't
			// announce. Joining a stream that is already adapted is a state,
			// not an event — the disclosure note covers states.
			last = cur;
			return;
		}
		if (cur === last) return;
		const from = last || (t.configured | 0);
		const to = cur || (t.configured | 0);
		last = cur;
		if (!from || !to || from === to) return;

		const up = to > from;
		let why;
		if (!up) {
			// The encoder follows the lowest estimate. Ours at or near the
			// new rate means the floor is us; well above it means another
			// viewer's link. The margin absorbs the camera's clamping.
			const ours = t.remb > 0 &&
				t.remb <= to + Math.max(100, to * 0.15);
			why = ours
				? 'Matched to your connection — every viewer of this ' +
					'stream now receives this rate.'
				: 'Another viewer’s connection can’t keep up — ' +
					'the stream follows the slowest link watching it.';
		} else {
			why = cur === 0
				? 'Back at the configured rate — no connection is ' +
					'holding it down.'
				: 'Raised — the slowest connection watching improved.';
		}
		show(from, to, why, up);
	}

	// The channel changed, or the transport did: whatever enc we knew was
	// the other encoder's, and the toast on screen is about it too.
	function reset() {
		last = null;
		hide();
	}

	return { tick: tick, reset: reset };
})();
