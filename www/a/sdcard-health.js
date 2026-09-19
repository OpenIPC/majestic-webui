// Is this card storing the footage, and can it be read back?
//
// Three lines, and each one is a different KIND of evidence with a different
// cost. The recorder's counters are free and continuous and are the only thing
// that speaks for the card while nobody is looking at it. The capacity probe is
// a fact measured about the card, cheap, and destructive, so it happens rarely.
// The read-back pass covers what is actually stored, takes minutes to hours,
// and happens when somebody asks for it.
//
// What binds them is the rule they all obey: a line with no evidence says so,
// and never a reassuring nothing. "Never checked" and "this card is fine" are
// different sentences, and the failure this whole feature exists to prevent is
// a page that renders the second when it means the first -- a card that
// acknowledges every write, returns no error, logs nothing, and hands back
// different bytes each time it is read will otherwise look exactly like a
// healthy one.
//
// Pure: no DOM, no fetch, no globals read. The caller owns the polling and owns
// any window a claim is made over -- `queued` is passed in already judged, the
// way MajesticStorageVerdict takes `dropped`, because it is a claim about a
// period of time only the caller can define.
(function () {
	'use strict';

	function bytes(n) {
		if (typeof n !== 'number' || !isFinite(n) || n < 0) return '';
		if (n >= 1073741824) return (n / 1073741824).toFixed(n >= 10737418240 ? 0 : 1) + ' GB';
		if (n >= 1048576) return (n / 1048576).toFixed(0) + ' MB';
		if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
		return n + ' bytes';
	}

	function num(v, k) { return (v && typeof v[k] === 'number') ? v[k] : null; }

	// ---------------------------------------------------------- keeping up ---
	//
	// The three-state gate every consumer of the heartbeat in this tree uses:
	//   { v: … }         a reading
	//   { absent: true } majestic answered and does not publish this
	//   null             not asked yet, or the ask failed
	//
	// The middle one is a fact about the BUILD and the last is a fact about
	// nothing, and neither may be worded as a fact about the card.
	function keeping(recorder, queued) {
		if (!recorder) {
			return { kind: 'asking', level: 'unknown', text: 'Checking what the recorder is doing…' };
		}
		if (recorder.absent) {
			return {
				kind: 'absent', level: 'unknown',
				text: 'This camera does not report what its recorder is doing, so nothing here can ' +
					'speak for the card between checks.',
			};
		}
		var v = recorder.v;
		var written = num(v, 'records_fragments_written_total');
		if (written === 0) {
			return {
				kind: 'idle', level: 'none',
				text: 'Nothing has been recorded to this card since the camera started, so there is ' +
					'nothing measured to show.',
			};
		}
		var st = num(v, 'records_state');
		if (st === 3) {
			return { kind: 'offline', level: 'bad', text: 'The camera cannot open the card — nothing is being recorded.' };
		}
		if (st === 2) {
			return { kind: 'failing', level: 'bad', text: 'Writes to the card are failing — nothing is being recorded.' };
		}
		if (st === 1) {
			return { kind: 'degraded', level: 'bad', text: 'Writes to the card are failing intermittently — footage is being lost.' };
		}
		var dropped = num(v, 'records_fragments_dropped_total');
		if (dropped) {
			return {
				kind: 'dropping', level: 'bad',
				text: 'The card has not kept up: ' + dropped +
					(dropped === 1 ? ' clip has' : ' clips have') +
					' been dropped since the camera started.',
			};
		}
		var errs = (num(v, 'records_write_errors_total') || 0) + (num(v, 'records_sync_errors_total') || 0);
		if (errs) {
			return {
				kind: 'errors', level: 'bad',
				text: errs + (errs === 1 ? ' write to the card has failed' : ' writes to the card have failed') +
					' since the camera started.',
			};
		}
		// The early warning, and the reason this line is worth having at all.
		// Everything above fires only once footage is already gone; a queue
		// that will not drain says the card is behind while there is still
		// time to do something about it.
		if (queued) {
			return {
				kind: 'marginal', level: 'warn',
				text: 'The card is falling behind — clips are waiting to be written, though none have ' +
					'been lost yet.',
			};
		}
		return { kind: 'ok', level: 'ok', text: 'The card is keeping up with the recorder.' };
	}

	// ------------------------------------------------------------- stores ---
	function stores(probe) {
		if (!probe || typeof probe.state !== 'string') {
			return { kind: 'never', level: 'none', text: 'Never checked.' };
		}
		var total = typeof probe.total === 'number' ? probe.total : 0;
		switch (probe.state) {
		case 'ok':
			return {
				kind: 'ok', level: 'ok',
				text: 'Checked at ' + total + ' places across the whole card, including the very end. ' +
					'Every one held what was written to it.',
			};
		case 'wrapped':
			// The finding that names the lie rather than merely reporting a
			// failure. An owner can take this to whoever sold them the card.
			return {
				kind: 'wrapped', level: 'bad',
				text: 'This card is not the size it reports. Something written at ' + bytes(probe.from) +
					' came back at ' + bytes(probe.at) + ', so its storage repeats: it holds a fraction ' +
					'of the space it claims and will overwrite the oldest recordings with the newest.',
			};
		case 'unstored':
			return {
				kind: 'unstored', level: 'bad',
				text: (typeof probe.kept === 'number' ? probe.kept + ' of ' + total : 'Not every one') +
					' of the places checked held what was written to them. The card is failing, and ' +
					'formatting cannot fix that.',
			};
		default:
			return {
				kind: 'unknown', level: 'unknown',
				text: 'The last check could not read enough of the card to say, so it said nothing.',
			};
		}
	}

	// -------------------------------------------------------------- reads ---
	function reads(scan) {
		if (!scan || typeof scan.state !== 'string') {
			return { kind: 'never', level: 'none', text: 'Never checked.' };
		}
		var bad = typeof scan.badChunks === 'number' ? scan.badChunks : 0;
		var read = typeof scan.bytes === 'number' ? scan.bytes : 0;
		var where = scan.phase === 2 ? 'the rest of the card' : 'the recordings';
		if (scan.state === 'running') {
			// No byte figure here. The caller draws a progress bar directly
			// under this line carrying the same number, and two formatters
			// rounding one value differently -- "14 GB" above "13.5 GB of
			// 56.0 GB" -- reads as a page that cannot agree with itself. One
			// place says how far it has got, and it is the one with the bar.
			return {
				kind: 'running', level: 'unknown',
				text: 'Reading ' + where + ' back now' +
					(bad ? ' — ' + bad + (bad === 1 ? ' piece' : ' pieces') +
						' could not be read so far' : '') + '.',
			};
		}
		if (scan.state === 'failed') {
			return {
				kind: 'failed', level: 'unknown',
				text: 'The last check stopped before it could say anything.',
			};
		}
		var how = scan.state === 'stopped'
			? 'Stopped part-way, after reading ' + bytes(read)
			: 'Read back ' + bytes(read);
		if (bad) {
			return {
				kind: 'bad', level: 'bad',
				text: how + '. ' + bad + (bad === 1 ? ' piece' : ' pieces') + ' could not be read' +
					(scan.moreFindings ? ' (the first ' + (scan.findings || []).length + ' are listed)' : '') + '.',
			};
		}
		// Deliberately not "the card is healthy". Everything that was there
		// came back; that is a statement about the bytes read, and a block
		// nothing has written to yet is not covered by it.
		return {
			kind: 'ok', level: scan.state === 'stopped' ? 'unknown' : 'ok',
			text: how + ', and all of it came back' +
				(scan.state === 'stopped' ? ' — but the rest was not looked at.' : '.'),
		};
	}

	var RANK = { bad: 4, warn: 3, unknown: 2, none: 1, ok: 0 };

	// The headline is the worst thing any line has to say, and it says which
	// line said it rather than inventing a fourth opinion. Where nothing has
	// been measured at all it says exactly that: an untested card is not a
	// healthy one, and this is the page where that difference is the point.
	function head(k, s, r) {
		var worst = [k, s, r].reduce(function (a, b) {
			return (RANK[b.level] || 0) > (RANK[a.level] || 0) ? b : a;
		});
		if (worst.level === 'bad') return { level: 'bad', text: 'This card has a problem.' };
		if (worst.level === 'warn') return { level: 'warn', text: 'This card is falling behind.' };
		if (k.level === 'ok' && s.kind === 'never' && r.kind === 'never') {
			return { level: 'none', text: 'Keeping up so far, but never checked.' };
		}
		if (worst.level === 'unknown' || worst.level === 'none') {
			return { level: 'unknown', text: 'Not everything about this card has been checked.' };
		}
		return { level: 'ok', text: 'Nothing wrong found with this card.' };
	}

	function verdict(s) {
		s = s || {};
		var k = keeping(s.recorder, s.queued);
		var st = stores(s.probe);
		var r = reads(s.scan);
		return { head: head(k, st, r), keeping: k, stores: st, reads: r };
	}

	var api = { verdict: verdict, keeping: keeping, stores: stores, reads: reads, bytes: bytes };
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticSdHealth = api;
}());
