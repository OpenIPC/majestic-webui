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
	function writable(card, recorder) {
		if (!card || card.health !== 'ok') return false;
		if (!known(recorder)) return false;
		const rs = state(recorder);
		return rs === null || rs === 0;
	}

	// What majestic says about its own recording, when it is new enough to say
	// anything. `dropped` is footage already known lost, formatted by the
	// caller — it is a claim about a window only the caller can define, so it
	// is passed in rather than computed here, and '' means "none, or nobody
	// measured".
	function fromRecorder(recorder, dropped) {
		const rs = state(recorder);
		if (rs === null) return null;

		switch (rs) {
		case 3:
			return {
				kind: 'offline', level: 'danger',
				short: 'The camera cannot open the SD card — nothing is being recorded.',
				detail: '<strong>The camera cannot open the SD card — nothing is being recorded.</strong> ' +
					'It has stopped trying and will look again every half minute, so recording resumes ' +
					'on its own if the card comes back.',
			};
		case 2:
			return {
				kind: 'failing', level: 'danger',
				short: 'Writes to the SD card are failing — nothing is being recorded.',
				detail: '<strong>Writes to the SD card are failing — nothing is being recorded.</strong> ' +
					'The camera gave up on the clip it was writing after repeated errors.',
			};
		case 1:
			return {
				kind: 'degraded', level: 'warn',
				short: 'Writes to the SD card are failing intermittently — footage is being lost.',
				detail: '<strong>Writes to the SD card are failing intermittently.</strong> ' +
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
				short: 'The SD card cannot keep up — footage is being lost.',
				detail: '<strong>The SD card cannot keep up — footage is being lost.</strong> ' +
					esc(dropped) + ' of video has been dropped while this ' +
					'page has been open, because the card could not take it in time. ' +
					'A faster card, or a lower bitrate, is the fix.',
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
	function of(card, recorder, dropped) {
		return fromRecorder(recorder, dropped) || fromCard(card);
	}

	window.MajesticStorageVerdict = {
		of: of, writable: writable, state: state, known: known,
	};
}());
