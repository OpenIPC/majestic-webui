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

	// The two counters that have to have been READ before the card may be
	// called healthy. They are the same fault caught at different depths, which
	// is why they are summed into one sentence rather than listed apart.
	var ERR_KEYS = ['records_write_errors_total', 'records_sync_errors_total'];

	// ---------------------------------------------------------- keeping up ---
	//
	// The three-state gate every consumer of the heartbeat in this tree uses:
	//   { v: … }         a reading
	//   { absent: true } majestic answered and does not publish this
	//   null             not asked yet, or the ask failed
	//
	// The middle one is a fact about the BUILD and the last is a fact about
	// nothing, and neither may be worded as a fact about the card.
	function keeping(recorder, queued, dropping) {
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
		var on = num(v, 'records_enabled');
		var st = num(v, 'records_state');
		var written = num(v, 'records_fragments_written_total');

		// Recording switched off. The recorder's verdict below is written when
		// the writer changes its mind about the card and is not cleared when
		// recording stops -- it keeps whatever it last said -- so on a camera
		// nobody is recording with it describes a card nothing is writing to.
		// Confirmed on an hi3516av300: with recording switched off after a
		// failed attempt, the verdict still reads `offline` indefinitely.
		if (on === 0) {
			return {
				kind: 'off', level: 'none',
				text: 'Recording is switched off, so nothing here is watching this card.',
			};
		}

		// The verdict outranks the fragment count, and the order is the whole
		// of #544: a camera that cannot open its card has written nothing
		// BECAUSE it cannot open it, so an empty fragment count is the symptom
		// rather than grounds to stay quiet. Reading it the other way round
		// reported a dead card as one nobody had used yet.
		//
		// The exception is a build that does not publish the enabled gauge at
		// all. There a verdict may be stale for the reason above and nothing
		// can say otherwise, so an idle camera keeps the older, quieter
		// behaviour rather than being made to accuse its card on a reading
		// that could be hours old.
		if (on !== null || written !== 0) {
			if (st === 3) {
				return { kind: 'offline', level: 'bad', text: 'The camera cannot open the card — nothing is being recorded.' };
			}
			if (st === 2) {
				return { kind: 'failing', level: 'bad', text: 'Writes to the card are failing — nothing is being recorded.' };
			}
			if (st === 1) {
				return { kind: 'degraded', level: 'bad', text: 'Writes to the card are failing intermittently — footage is being lost.' };
			}
		}
		if (written === 0) {
			return {
				kind: 'idle', level: 'none',
				text: 'Nothing has been recorded to this card since the camera started, so there is ' +
					'nothing measured to show.',
			};
		}
		// One counter, two claims, and only the caller can tell them apart.
		// This total is cumulative for the life of the daemon, so read raw it
		// pins the whole block to `bad` until majestic restarts -- a flag
		// nothing clears, announcing a condition that has since ended. Seen on
		// an hi3516av300: a card recording normally, with an empty queue and no
		// write errors, went on reporting a fault for the rest of the daemon's
		// life because a maintenance remount had briefly cost it a few clips.
		// (#545)
		//
		// So `dropping` arrives already judged, exactly as `queued` does and
		// for the same reason -- whether the count is still moving is a claim
		// about a window, and only the caller knows what window it watches.
		// The loss itself is still said out loud: clips really are gone, and
		// the difference between the two sentences is an alarm and a note.
		var dropped = num(v, 'records_fragments_dropped_total');
		if (dropped && dropping) {
			return {
				kind: 'dropping', level: 'bad',
				text: 'The card is not keeping up: ' + dropped +
					(dropped === 1 ? ' clip has' : ' clips have') +
					' been dropped, and more are still being lost.',
			};
		}
		// `|| 0` here would have been the exact mistake this module is about.
		// Summing two counters with a zero fallback turns "this build does not
		// publish write errors" into "no write has failed", and the healthy
		// branch below then says the card is keeping up on the strength of a
		// reading nobody took. Absent and zero are collected separately, and
		// only a counter that actually arrived may be added up.
		var seen = 0, errs = 0, i;
		for (i = 0; i < ERR_KEYS.length; i++) {
			var n = num(v, ERR_KEYS[i]);
			if (n !== null) { seen++; errs += n; }
		}
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
			// "though none have been lost yet" is a claim, and it rests on a
			// counter. On a build that publishes the queue depth but not the
			// dropped count, saying it would be reassurance the camera never
			// offered -- so the clause is gated on the reading, not the warning.
			return {
				kind: 'marginal', level: 'warn',
				text: dropped === null
					? 'The card is falling behind — clips are waiting to be written. This camera does ' +
						'not report whether any have been lost.'
					: dropped
						// Never "none have been lost yet" once some have been.
						// The queue is the live condition and leads, but the
						// reassurance beside it has to stay true.
						? 'The card is falling behind — clips are waiting to be written, and ' + dropped +
							(dropped === 1 ? ' has' : ' have') + ' already been lost.'
						: 'The card is falling behind — clips are waiting to be written, though none have ' +
							'been lost yet.',
			};
		}
		// A loss that has stopped. Below the queue deliberately: both are
		// warnings, and if clips are backing up right now that is the one
		// worth leading with -- this one is a record of something that has
		// already finished happening.
		if (dropped) {
			return {
				kind: 'dropped', level: 'warn',
				text: 'The card has dropped ' + dropped +
					(dropped === 1 ? ' clip' : ' clips') +
					' since the camera started, but none while this page has been watching.',
			};
		}
		// Everything above is a reason to say something is WRONG, and each one
		// is silent when its counter is missing. Saying the card is fine is the
		// opposite kind of claim: it needs every one of those counters to have
		// been read and come back clean. A build that reports the recorder's
		// state but not its failures cannot support it, so it does not get it.
		if (seen < ERR_KEYS.length || dropped === null) {
			return {
				kind: 'partial', level: 'unknown',
				text: 'Nothing has gone wrong that this camera can report, but it does not publish ' +
					'everything needed to say the card is keeping up.',
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
		// Clips the recorder deleted to make room while this was running. Not
		// a fault, but they were not checked, so a clean result must not be
		// read as covering them.
		var gone = typeof scan.vanished === 'number' ? scan.vanished : 0;
		var skipped = gone
			? ' ' + gone + (gone === 1 ? ' clip was' : ' clips were') +
				' deleted by the recorder while reading and were not checked.'
			: '';
		if (bad) {
			return {
				kind: 'bad', level: 'bad',
				text: how + '. ' + bad + (bad === 1 ? ' piece' : ' pieces') + ' could not be read' +
					(scan.moreFindings ? ' (the first ' + (scan.findings || []).length + ' are listed)' : '') +
					'.' + skipped,
			};
		}
		// Deliberately not "the card is healthy". Everything that was there
		// came back; that is a statement about the bytes read, and a block
		// nothing has written to yet is not covered by it.
		return {
			kind: 'ok', level: scan.state === 'stopped' ? 'unknown' : 'ok',
			text: how + ', and all of it came back' +
				(scan.state === 'stopped' ? ' — but the rest was not looked at.' : '.') + skipped,
		};
	}

	// --------------------------------------------------------- provenance ---
	//
	// What the card says about itself, and whether any of it hangs together.
	//
	// This is NOT a verdict and must never become one. The reference case is a
	// card in this lab whose product name says 16 GB on a 32 GB device and
	// whose manufacturer id is one nobody recognises -- and which was then
	// proven genuine by writing a unique stamp to all 29,880 MiB and reading
	// every one back. So these are reasons to run the capacity check, which is
	// the thing that actually settles it, and the sentence points there.
	//
	// Structurally guaranteed rather than promised: provenance carries no
	// `level`, so it cannot be ranked by head() even if somebody later passes
	// it in. A test pins that head() is unchanged across every input here.

	// Manufacturer ids, and the OEM string each one is paired with on a real
	// card. Deliberately PARTIAL: the job is not to name every vendor but to
	// answer "is this a pairing we recognise", and an id that is missing yields
	// silence about the vendor rather than a guess.
	//
	// A name is printed only when the manufacturer id AND the ASCII OEM id both
	// match the same row. Two independent fields having to agree is what makes
	// a wrong row here fail safe -- it simply never fires -- rather than
	// printing somebody else's brand onto a card.
	var VENDORS = {
		0x03: { name: 'SanDisk', oem: 'SD' },
		0x02: { name: 'Toshiba', oem: 'TM' },
		0x1b: { name: 'Samsung', oem: 'SM' },
		0x1d: { name: 'ADATA', oem: 'AD' },
		0x27: { name: 'Phison', oem: 'PH' },
		0x28: { name: 'Lexar', oem: 'BE' },
		0x41: { name: 'Kingston', oem: '42' },
		0x74: { name: 'Transcend', oem: 'JE' },
	};

	function hexNum(v) {
		if (typeof v === 'number') return v;
		if (typeof v !== 'string' || !v) return null;
		var n = parseInt(v, 16);
		return isFinite(n) ? n : null;
	}

	// The OEM id is two ASCII characters packed into 16 bits -- "SD" for
	// SanDisk, "42" for Kingston. Rendered back so it can be compared with the
	// table and shown to a person.
	function oemAscii(card) {
		var n = hexNum(card && card.oemid);
		if (n === null) return '';
		var a = (n >> 8) & 0xff, b = n & 0xff;
		var pr = function (c) { return c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : ''; };
		return pr(a) + pr(b);
	}

	function vendorOf(card) {
		var id = hexNum(card && card.manfid);
		if (id === null) return null;
		var row = VENDORS[id];
		if (!row) return null;
		return row.oem === oemAscii(card) ? row.name : null;
	}

	// SD capacities are sold in decimal GB, and a product name that carries one
	// ("SD64G", "SC32G") is the card repeating the number on its label. The
	// device's own sector count is the fact to check it against.
	function namedGb(model) {
		var m = /(\d+)\s*G$/i.exec(String(model || '').trim());
		return m ? parseInt(m[1], 10) : null;
	}

	function provenance(card) {
		if (!card) return null;
		var tells = [];
		// Every clause below is gated on its reading having been TAKEN. The
		// endpoint omits an identity key the kernel does not export, so an
		// absent field is a fact about this kernel and an empty one is a fact
		// about the card -- and only the second is the card's to answer for.
		// Collapsing them would have this page tell an owner their card
		// reports no product name when nothing ever asked it.
		// Two different questions, and conflating them cost a case: `read` is
		// whether the kernel published the attribute at all, `has` whether it
		// also came back with something in it. A product name that WAS read and
		// is empty is the card's own answer and counts; one that was never
		// published is this kernel's business and does not.
		var read = function (k) { return typeof card[k] === 'string'; };
		var has = function (k) { return read(k) && card[k] !== ''; };
		var id = has('manfid') ? hexNum(card.manfid) : null;
		var oem = oemAscii(card);
		var model = read('model') ? String(card.model).replace(/[^\x20-\x7e]/g, '').trim() : null;
		var bytes_ = typeof card.sizeBytes === 'number' ? card.sizeBytes : null;

		if (has('manfid')) {
			if (id === null || !VENDORS[id]) {
				tells.push('its manufacturer id is not one this page recognises');
			} else if (has('oemid') && VENDORS[id].oem !== oem) {
				tells.push('its manufacturer and OEM ids name different makers');
			}
		}
		// A product name is five characters on the card. Two or fewer printable
		// ones means the field was left essentially empty, which a card from a
		// manufacturer who owns the name does not do.
		if (model === null) {
			// Nothing to say: the kernel did not publish a product name, which
			// is not the card declining to have one.
		} else if (model.length < 3) {
			tells.push('it reports no real product name');
		} else {
			var gb = namedGb(model);
			if (gb && bytes_) {
				var ratio = bytes_ / (gb * 1e9);
				// Generous on purpose: usable capacity is legitimately a few
				// percent under the number on the label, and the only thing
				// worth reporting is a name that is a different size entirely.
				if (ratio > 1.3 || ratio < 0.7) {
					// The size of the device is deliberately NOT repeated here.
					// It is already on the identity line two rows up, and the
					// page formats it in binary GB while the name on a card
					// means decimal ones -- so printing it again produced "a 16
					// GB card on a 31 GB device" directly under an identity
					// line reading "29.2 GB", which is the page disagreeing
					// with itself about one card. The comparison still uses the
					// decimal number, because that is what a label means; only
					// the second figure is dropped.
					tells.push('its product name says ' + gb +
						' GB, which is not the size of this device');
				}
			}
		}
		// Only a date that could not have happened. A merely old card is not
		// suspicious -- plenty of genuine ones are -- so this fires on capacity
		// the standard of the day could not express, or on a date in the future.
		var d = has('date') ? /^(\d{1,2})\/(\d{4})$/.exec(card.date) : null;
		if (d && bytes_) {
			var mon = parseInt(d[1], 10), year = parseInt(d[2], 10);
			// Compared as a whole month, not as a year. A card made next month
			// is as impossible as one made next decade, and `13/2020` is not a
			// date at all -- both slipped through a year-only comparison.
			var now = new Date();
			var ym = year * 12 + (mon - 1), nowYm = now.getFullYear() * 12 + now.getMonth();
			if (mon < 1 || mon > 12) {
				tells.push('its manufacture date reads ' + card.date + ', which is not a date');
			} else if (ym > nowYm) {
				tells.push('it is dated ' + card.date + ', which has not happened yet');
			} else if (bytes_ > 34e9 && year < 2009) {
				tells.push('it is dated ' + card.date + ', before cards this size existed');
			} else if (bytes_ > 2.2e9 && year < 2006) {
				tells.push('it is dated ' + card.date + ', before cards this size existed');
			}
		}
		if (!tells.length) return null;

		var list = tells.length === 1 ? tells[0]
			: tells.slice(0, -1).join(', ') + ' and ' + tells[tells.length - 1];
		return {
			kind: 'odd',
			tells: tells,
			text: 'This card does not describe itself consistently — ' + list +
				'. That is not proof of anything on its own; the check above is what settles it.',
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
		var k = keeping(s.recorder, s.queued, s.dropping);
		var st = stores(s.probe);
		var r = reads(s.scan);
		// head() is handed the three LINES and nothing else. Provenance is
		// deliberately not among them: it is a prompt to run a check, not a
		// finding, and the card it describes may be perfectly genuine.
		return {
			head: head(k, st, r), keeping: k, stores: st, reads: r,
			provenance: provenance(s.card), vendor: vendorOf(s.card),
		};
	}

	var api = {
		verdict: verdict, keeping: keeping, stores: stores, reads: reads,
		provenance: provenance, vendorOf: vendorOf, bytes: bytes,
	};
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticSdHealth = api;
}());
