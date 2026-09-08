// Why the camera is not recording, in one vocabulary.
//
// Two halves have to agree before anything may be called healthy, and neither
// can see what the other sees. `j/sdcard.cgi` reports the FILESYSTEM — mounted,
// readable, writable, there at all — and majestic's records_state reports the
// RECORDER, which is the half that catches a card mounted read-write with room
// on it that is taking nothing. Every state in that second half reads back from
// the first as `health: "ok"`.
//
// This file exists because the sentences below were written once, on the
// Recordings page, where somebody had to be standing to read them. The banner
// that now says the same thing on every page must not say it in different
// words: two vocabularies for one fault is how a camera comes to describe its
// card one way in a banner and another way on the page the banner points at.
// So the wording lives here and the callers choose a length, not a phrasing.
//
// No DOM and no fetch: the callers own their own polling, and this only judges.
(function () {
	'use strict';

	function esc(s) {
		return String(s).replace(/[&<>"]/g, function (c) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
		});
	}

	// Is the camera recording to the SD slot at all?
	//
	// j/sdcard.cgi describes one device and only one -- the built-in slot --
	// and never reads records.path. records.path is a free string: a USB stick,
	// a network mount, anywhere. Point it away from the slot and "there is no
	// SD card in the camera" becomes true and irrelevant, and "nothing is being
	// recorded" becomes false, which is the worse half. Measured on a lab
	// camera set to record to /tmp: it said exactly that, on every page.
	//
	// Unknown answers "yes", because that is the configuration this endpoint is
	// about and the alternative is silence about a card that really has died.
	function onCard(card, path) {
		const mp = card && card.mountpoint;
		if (!mp || !path) return true;
		if (path === mp) return true;
		return path.lastIndexOf(mp + '/', 0) === 0;
	}

	// records.path up to its first strftime field, which is the directory the
	// clips actually land in -- the same derivation j/recordings.cgi makes
	// server-side. Here so that both callers cannot make it differently.
	function prefixOf(path) {
		return String(path || '').split('%')[0].replace(/\/+$/, '');
	}

	// What the sentences call the place the footage is meant to go. The SD slot
	// is what this is nearly always about, and saying so is worth more than
	// being uniformly vague -- but a camera recording to a USB stick must not
	// be told its SD card is failing.
	function noun(on) { return on ? 'the SD card' : 'the recording storage'; }

	// The recorder's own verdict, or null when there is not one to have.
	//
	// Three answers, not two, and the difference decides what a badge may say.
	// A camera whose majestic ANSWERED and has no such endpoint is a camera
	// that cannot report this — a known absence. A request that FAILED is an
	// unknown, and an unknown may not be turned into a fact.
	//
	//   { v: … }         a reading
	//   { absent: true } answered, and does not have it
	//   null             not asked yet, or the ask failed
	function state(recorder) {
		return recorder && recorder.v ? recorder.v.records_state : null;
	}

	function known(recorder) {
		return !!recorder;
	}

	// Positive claims need positive evidence. A card is only known writable
	// when the endpoint said so; a request that failed, or an answer this
	// release does not understand, is an unknown card, and an unknown card
	// must not be painted green — that false reassurance is the whole thing
	// this vocabulary exists to stop telling.
	function writable(card, recorder, path) {
		// A camera recording somewhere else is not made unwritable by the state
		// of a slot it is not using; there the recorder's answer is the only
		// one there is.
		if (onCard(card, path) && (!card || card.health !== 'ok')) return false;
		if (!known(recorder)) return false;
		const rs = state(recorder);
		return rs === null || rs === 0;
	}

	// What majestic says about its own recording, when it is new enough to say
	// anything. `dropped` is footage already known lost, formatted by the
	// caller — it is a claim about a window only the caller can define, so it
	// is passed in rather than computed here, and '' means "none, or nobody
	// measured".
	function fromRecorder(recorder, dropped, on) {
		const it = noun(on);
		const It = it.charAt(0).toUpperCase() + it.slice(1);
		const rs = state(recorder);
		if (rs === null) return null;

		switch (rs) {
		case 3:
			return {
				kind: 'offline', level: 'danger',
				short: 'The camera cannot open ' + it + ' — nothing is being recorded.',
				detail: '<strong>The camera cannot open ' + it + ' — nothing is being recorded.</strong> ' +
					'It has stopped trying and will look again every half minute, so recording resumes ' +
					'on its own once it is back.',
			};
		case 2:
			return {
				kind: 'failing', level: 'danger',
				short: 'Writes to ' + it + ' are failing — nothing is being recorded.',
				detail: '<strong>Writes to ' + it + ' are failing — nothing is being recorded.</strong> ' +
					'The camera gave up on the clip it was writing after repeated errors.',
			};
		case 1:
			return {
				kind: 'degraded', level: 'warn',
				short: 'Writes to ' + it + ' are failing intermittently — footage is being lost.',
				detail: '<strong>Writes to ' + it + ' are failing intermittently.</strong> ' +
					'Recording is continuing for now, but footage is being lost.',
			};
		default:
			break;
		}

		// State 0 and still losing footage: the card is keeping up with
		// neither the bitrate nor its own garbage collection. Nothing about
		// the filesystem is wrong, which is exactly why this needs saying —
		// the page would otherwise be green.
		if (dropped) {
			return {
				kind: 'dropping', level: 'warn',
				short: It + ' cannot keep up — footage is being lost.',
				detail: '<strong>' + It + ' cannot keep up — footage is being lost.</strong> ' +
					esc(dropped) + ' of video has been dropped while this ' +
					'page has been open, because it could not take the video in time. ' +
					'Faster storage, or a lower bitrate, is the fix.',
			};
		}
		return null;
	}

	function fromCard(card) {
		if (!card) return null;
		switch (card.health) {
		case 'readonly':
			return {
				kind: 'readonly', level: 'danger',
				short: 'The SD card is mounted read-only — nothing is being recorded.',
				detail: '<strong>The SD card is mounted read-only — nothing is being recorded.</strong> ' +
					'It reports free space and its older clips still play, but the camera cannot write to it. ' +
					'The kernel drops a card to read-only as soon as its filesystem stops making sense, ' +
					'so expect a damaged filesystem rather than a full one.',
			};
		case 'unreadable':
			return {
				kind: 'unreadable', level: 'danger',
				short: 'The SD card has no readable filesystem — nothing is being recorded.',
				detail: '<strong>The SD card has no readable filesystem — nothing is being recorded.</strong> ' +
					'A partition is there but nothing on the camera can read it, so it is either damaged or was never formatted.',
			};
		case 'unformatted':
			return {
				kind: 'unformatted', level: 'danger',
				short: 'The SD card is not formatted — nothing is being recorded.',
				detail: '<strong>The SD card is not formatted — nothing is being recorded.</strong>',
			};
		case 'unmounted':
			return {
				kind: 'unmounted', level: 'danger',
				short: 'The SD card is not mounted — nothing is being recorded.',
				detail: '<strong>The SD card is not mounted — nothing is being recorded.</strong> ' +
					'The filesystem is intact; it just is not attached to <code>' +
					esc(card.mountpoint || '') + '</code>.',
			};
		case 'absent':
			return {
				kind: 'absent', level: 'danger',
				short: 'There is no SD card in the camera — nothing is being recorded.',
				detail: '<strong>There is no SD card in the camera — nothing is being recorded.</strong>',
			};
		default:
			return null;
		}
	}

	// The recorder is asked FIRST, because it is the more specific answer: a
	// card that has gone read-only under the recorder shows up in both, and
	// "the camera cannot write to the card" is what somebody looking at an
	// empty archive needs to read.
	//
	// Returns null while the card is fine — including while it is merely full,
	// which is normal operation: majestic deletes the oldest clips at
	// records.maxUsage and carries on.
	function of(card, recorder, dropped, path) {
		const on = onCard(card, path);
		// The card's own half is an answer about the SD slot, so it is only an
		// answer about recording when that is where the recording goes. The
		// recorder's half always is -- majestic is reporting on whatever it was
		// actually pointed at.
		return fromRecorder(recorder, dropped, on) || (on ? fromCard(card) : null);
	}

	window.MajesticStorageVerdict = {
		of: of, writable: writable, state: state, known: known,
		onCard: onCard, prefixOf: prefixOf,
	};
}());
