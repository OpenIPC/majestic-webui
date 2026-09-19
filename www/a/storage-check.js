// "Nothing is being recorded", on every page, while it is true.
//
// A dead SD card is the one fault on this camera that costs something
// irreplaceable while looking like nothing at all: the picture is live, the
// counters are healthy, ONVIF answers, and the archive simply stops growing.
// Until this, the camera said so on exactly two pages — Recordings and SD card
// — so finding out required already suspecting it. Somebody watching the Live
// page, which is the page people leave open, was told nothing.
//
// The wording is not this file's. storage-verdict.js holds it, because the
// Recordings page says the same things at greater length and the two must not
// drift into describing one card in two vocabularies.
//
// Only when the camera is supposed to be recording. records.enabled off means
// the card is not the camera's job, and a banner on every page about storage
// nobody asked to use is noise that teaches people to ignore banners.
(function () {
	'use strict';

	const SLOT = 'storage-notice';
	const CARD = '/cgi-bin/j/sdcard.cgi';
	// The card half only. The recorder half rides the 2 s heartbeat that every
	// page already runs, so this is the only request this file adds — and it
	// adds none at all on a camera that is not recording.
	const CARD_MS = 30000;

	const V = window.MajesticStorageVerdict;

	// Both pages that already carry this verdict, at length and with the
	// controls that act on it. A second banner above them would say the same
	// thing twice on one screen, which reads as a bug rather than as emphasis.
	const SAYS_IT_ALREADY = { 'page-recordings': 1, 'page-sdcard': 1 };

	let where = '';          // the directory records.path puts clips in
	let card = null;         // last answer from the SD-card endpoint
	// Where the slot mounts, remembered across a reading that goes away. It is
	// a property of the camera rather than a claim about the card's health, and
	// it is what lets a row that has gone unknown be taken BACK to neutral --
	// without it there is no way to say which row the lost reading was about,
	// and the last green it was given stands.
	let mnt = '';
	let recorder = null;     // null | {absent:true} | {v:…}, as the verdict wants
	// Where the drop counter stood when this page opened, so the banner reports
	// footage lost while somebody has been here rather than everything since
	// the camera booted — a total from three days ago is not news, and a banner
	// that cannot be made to go away is one people learn to ignore.
	let droppedAt = null;
	// Consecutive samples with a fragment waiting. The banner's early warning
	// is a claim about a WINDOW, and this is the window: two heartbeats, which
	// is the shortest thing that is not one sample's noise, and it resets the
	// moment the queue drains so the banner can take itself down. The
	// SD-card page counts the same way against the same heartbeat.
	let queuedTicks = 0;
	// Consecutive heartbeats in which the recorder wrote nothing.
	//
	// The dropping verdict is a claim in the PRESENT tense — "the card cannot
	// keep up" — and it stops being true the moment the recorder stops asking
	// anything of the card. records.enabled is read once, at startup, so a
	// camera whose recording is switched off while this page is open would
	// otherwise go on showing a loss that is no longer happening, with nothing
	// able to clear it short of a reload.
	//
	// Several samples rather than one: a recorder between clips writes nothing
	// for a moment, and a banner that blinks off and back on is read as a bug
	// rather than as precision.
	let idleTicks = 0;
	const IDLE_TICKS = 8;   // ~16 s at the 2 s heartbeat
	let shown = '';          // what the slot is currently saying

	function slot() { return document.getElementById(SLOT); }

	// Seconds of footage dropped since this page loaded, from the counter of
	// presentation time lost — microseconds, as the Recordings page reads it.
	// The fragment count beside it is not seconds: fragment length is
	// configurable, so counting fragments and calling them seconds is right
	// only at the default.
	function droppedSeconds() {
		const v = recorder && recorder.v;
		if (!v || typeof v.records_dropped_ticks_total !== 'number') return 0;
		if (droppedAt === null) return 0;
		return Math.max(0, (v.records_dropped_ticks_total - droppedAt) / 1e6);
	}

	function render() {
		const el = slot();
		if (!el) return;
		// The dropped figure, which this banner has never passed. The verdict
		// has said "cannot keep up — footage is being lost" since it was
		// written, but only the Recordings page ever supplied the evidence for
		// it, so on every other page a card that was mounted, writable and
		// reporting itself healthy while silently discarding clips drew nothing
		// at all. That is the one storage fault with no other symptom
		// (OpenIPC/firmware#1747).
		// Suppressed, not forgotten: the counter keeps its baseline, so a
		// recorder that starts writing again reports what it loses from then
		// on rather than re-announcing what it lost before it paused.
		const lost = idleTicks >= IDLE_TICKS ? 0 : droppedSeconds();
		const v = V.of(card, recorder, lost > 0 ? V.duration(lost) : '', where, queuedTicks >= 2);
		// The Dashboard's SD badge is the other place a dead card was being
		// drawn green, and it is drawn from df, which cannot see any of this.
		badge(v);

		// The SD card page, not Recordings: this banner is read by somebody who
		// has just learnt their camera is not recording, and that is the page
		// that mounts, checks and formats the card. The label is the one the
		// Recordings page already uses for the same destination -- the same
		// reason the sentences are shared.
		const html = v ? window.mjNotice(v.level, '<b>' + v.short + '</b>', {
			acts: '<a class="btn btn-sm btn-primary" href="sdcard.cgi">Open the SD card page</a>',
		}) : '';
		// Compared before writing: this runs on every heartbeat, and replacing
		// identical markup twice a second restarts CSS transitions and drops
		// anything the reader is mid-way through selecting.
		if (html === shown) return;
		shown = html;
		el.innerHTML = html;
	}

	// The Dashboard draws its SD row from `df`, which reports a read-only card
	// with all of its old free space — a green badge over a card that stopped
	// recording hours ago. df is not wrong; it is answering a different
	// question, and this is the answer to the one being asked.
	//
	// FOUR states, not two. Green is a positive claim and needs positive
	// evidence from both halves, which is what writable() is; a verdict that
	// says footage is being lost is not green either; and before the endpoint
	// has answered, or when it could not be reached, nothing is established and
	// the badge must not say anything — the same rule the sentences follow.
	//
	// The row is found by its mount, not by an id: the Dashboard draws one row
	// per matching filesystem and this endpoint describes exactly one device,
	// so an id would colour whichever row came first.
	function badge(v) {
		const mp = (card && card.mountpoint) || mnt;
		const rows = document.querySelectorAll('.mj-sd-row');
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i];
			if (!mp || row.getAttribute('data-mnt') !== mp) continue;
			const b = row.querySelector('.mj-sd-badge');
			const why = row.querySelector('.mj-sd-why');
			let cls = 'text-bg-secondary';
			// A deliberate swap is not amber. Mapping anything that is not
			// danger to warning painted the Dashboard row the colour of a
			// fault while the operator was standing at the camera doing what
			// the page told them to.
			if (v && v.level === 'danger') cls = 'text-bg-danger';
			else if (v && v.level === 'info') cls = 'text-bg-secondary';
			else if (v) cls = 'text-bg-warning';
			else if (V.writable(card, recorder, where)) cls = 'text-bg-success';
			if (b) b.className = 'badge flex-shrink-0 mj-sd-badge ' + cls;
			if (why) why.textContent = v ? ' — ' + v.short : '';
		}
	}

	function pollCard() {
		return window.apiFetch(CARD, { credentials: 'same-origin' })
			.then(function (r) { return r.json(); })
			.then(function (d) { card = d; mnt = (d && d.mountpoint) || mnt; render(); })
			// An endpoint that could not be reached is not a healthy card and
			// not a broken one -- and it is not the card it was half a minute
			// ago either. Holding the last good answer is how a badge stays
			// green through an hour of failed polls, so the reading is dropped
			// and the page goes back to saying nothing about the card, which is
			// what recordings.js does with the same failure.
			.catch(function () { card = null; render(); });
	}

	// A configuration that could not be read is not a camera with recording
	// switched off. mjConfig() resolves {} on a failed fetch and deliberately
	// does not cache it so that a later call retries -- but nothing here made a
	// later call, so one refused request at page load turned every storage
	// alert off for the life of the page, silently. /api/v1/config.json reports
	// keys sitting at their defaults, so records.enabled is always a real
	// boolean when the config was read at all, and `undefined` means only that
	// it was not.
	const RETRY_MS = 15000;

	function start() {
		if (!V || !window.mjNotice || !window.apiFetch) return;
		if (SAYS_IT_ALREADY[document.body && document.body.id]) return;

		window.mjConfig().then(function (cfg) {
			const on = window.mjGet(cfg, 'records.enabled');
			if (on === undefined) { setTimeout(start, RETRY_MS); return; }
			if (!on) return;
			// Where the camera was actually pointed. The card endpoint only
			// ever describes the built-in slot, so a camera recording to a USB
			// stick or a network mount must not be told its SD card is the
			// reason nothing is being recorded.
			where = V.prefixOf(window.mjGet(cfg, 'records.path'));

			// The recorder's half for free: records_state and the drop counter
			// are in the top-level /metrics the heartbeat already fetches
			// twice a second, so nothing here polls for them.
			window.mjMetricsSubscribe(function (s) {
				// A failed poll is not a reading. The heartbeat says so, and
				// turning that into "the recorder is fine" is the one answer
				// that must never be invented.
				// A failed poll ends the run of consecutive samples, the same
				// rule the SD-card page follows against the same heartbeat: the
				// warning below is about a queue that has not drained over a
				// window, and a window with a hole in it is not that window.
				if (!s || !s.ok || !s.m) { recorder = null; queuedTicks = 0; render(); return; }
				const v = s.m.v;
				recorder = typeof v.records_state === 'number'
					? { v: v } : { absent: true };
				if (droppedAt === null &&
					typeof v.records_dropped_ticks_total === 'number')
					droppedAt = v.records_dropped_ticks_total;
				const qn = v.records_queue_fragments;
				queuedTicks = (typeof qn === 'number' && qn > 0) ? queuedTicks + 1 : 0;
				// Is the recorder still writing? Absent counters leave this
				// alone: a build that does not publish them is not a camera
				// reporting that nothing is being written.
				const pv = s.prev && s.prev.v;
				const b = v.records_bytes_written_total;
				const pb = pv && pv.records_bytes_written_total;
				if (typeof b === 'number' && typeof pb === 'number')
					idleTicks = b > pb ? 0 : idleTicks + 1;
				render();
			});

			pollCard();
			setInterval(pollCard, CARD_MS);
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', start);
	} else {
		start();
	}
}());
