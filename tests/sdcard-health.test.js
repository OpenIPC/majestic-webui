// The three lines of the Card health block, and the one rule they all obey.
//
// Every branch here produces a fluent, confident English sentence, and a wrong
// one reads exactly as well as a right one -- which is why it is tested and why
// the cases below are mostly about what is NOT said. The failure being guarded
// against is specific and has happened on this hardware: a card that
// acknowledges every write, returns no I/O error, logs nothing in dmesg and
// hands back different bytes on every read looks, to every counter the camera
// publishes, exactly like a healthy one. A page that renders "nothing wrong"
// over a card nobody has actually checked is telling somebody their footage is
// safe when nothing has established that.
//
// So: "never checked" must never come out as a pass, an unanswered heartbeat
// must never come out as a fact about the card, and a run that stopped
// part-way must never come out as a clean bill of health.
'use strict';

const { check, group, done } = require('./assert');
const H = require('../www/a/sdcard-health.js');

// A recorder that has published everything needed to call the card healthy.
// Saying "nothing is wrong" needs every counter that could say otherwise to
// have been READ, so the fixture carries them all and the cases below take
// them away one at a time.
const FULL = {
	records_enabled: 1,
	records_state: 0,
	records_fragments_written_total: 400,
	records_fragments_dropped_total: 0,
	records_write_errors_total: 0,
	records_sync_errors_total: 0,
};
// A recorder reading with the counters overridden, for the cases below that
// are about one gauge at a time.
const rec = (over) => ({ v: Object.assign({}, FULL, over) });
// The three cards this was written against. Two are real no-name cards from
// the lab and one is a genuine SanDisk; the second of them was PROVEN genuine
// by a whole-device write and verify, which is why nothing here may convict.
const CARD_SANDISK = { manfid: '0x000003', oemid: '0x5344', model: 'SD64G', sizeBytes: 124735488 * 512, date: '05/2021' };
const CARD_MISNAMED = { manfid: '0x0000f1', oemid: '0x3432', model: 'SD16G', sizeBytes: 61194240 * 512, date: '06/2020' };
const CARD_NAMELESS = { manfid: '0x000056', oemid: '0x3456', model: 'SD', sizeBytes: 122138624 * 512, date: '01/2012' };
const recording = { v: FULL };
const without = (k) => {
	const v = Object.assign({}, FULL);
	delete v[k];
	return { v: v };
};
const clean = { state: 'ok', kept: 17, seen: 17, total: 17, at: -1, from: -1 };
const readAll = { state: 'done', bytes: 60134761873, badChunks: 0, findings: [], phase: 2 };

const ask = (over) => H.verdict(Object.assign({ recorder: recording }, over));

function main() {
	group('the module is reachable without a page');
	check('verdict() is exported', typeof H.verdict === 'function');

	group('an unanswered heartbeat is not a statement about the card');
	{
		const asking = H.keeping(null);
		const absent = H.keeping({ absent: true });
		const live = H.keeping(recording);
		check('all three say different things',
			asking.text !== absent.text && absent.text !== live.text && asking.text !== live.text,
			[asking.text, absent.text, live.text].join(' | '));
		// The one that matters: a build that publishes no recorder counters is
		// a fact about the build, and the sentence must blame the camera's
		// reporting rather than the card.
		check('an absent counter set blames the reporting, not the card',
			/does not report/.test(absent.text) && !/card is/.test(absent.text), absent.text);
		check('a heartbeat that has not landed claims nothing at all',
			asking.level === 'unknown' && !/card/.test(asking.text), asking.text);
		check('only the reading is allowed to be ok', live.level === 'ok' && asking.level !== 'ok' && absent.level !== 'ok');
	}

	group('a counter that was never published is not a counter that read zero');
	{
		// The mistake this guards is one line of arithmetic: summing the two
		// error counters with a `|| 0` fallback turns "this build does not
		// report write errors" into "no write has failed", and the healthy
		// branch then calls the card fine on the strength of a reading nobody
		// took. Every clause above the healthy one is silent when its counter
		// is missing, which is right — but silence from all of them is not
		// evidence of health.
		for (const k of ['records_write_errors_total', 'records_sync_errors_total',
			'records_fragments_dropped_total']) {
			const partial = H.keeping(without(k));
			check('without ' + k.replace('records_', '') + ' the card is not called healthy',
				partial.level !== 'ok', JSON.stringify(partial));
			check('and it says the camera does not publish enough',
				/does not publish/.test(partial.text), partial.text);
		}
		// Zeroes that were actually read are a different thing entirely, and
		// must still be allowed to mean what they say.
		check('but counters that read zero do say the card is keeping up',
			H.keeping(recording).level === 'ok', JSON.stringify(H.keeping(recording)));
		// A real failure still outranks the missing-counter branch: the point
		// is not to go quiet, it is not to reassure.
		const bad = without('records_sync_errors_total');
		bad.v.records_write_errors_total = 3;
		check('a failure that WAS reported is still reported',
			H.keeping(bad).level === 'bad' && /3 writes/.test(H.keeping(bad).text),
			JSON.stringify(H.keeping(bad)));
	}

	group('a card nothing has been recorded to has measured nothing');
	{
		const idle = H.keeping({ v: { records_state: 0, records_fragments_written_total: 0 } });
		// A row of reassuring noughts about a card the camera has never asked
		// for anything is the same lie in smaller print.
		check('it says so rather than reporting a clean run',
			idle.level !== 'ok' && /Nothing has been recorded/.test(idle.text), idle.text);
	}

	group('never checked is not a pass');
	{
		const v = ask({});
		check('the capacity line says never checked', v.stores.kind === 'never', v.stores.text);
		check('the read-back line says never checked', v.reads.kind === 'never', v.reads.text);
		// The headline is the point of the whole block: the recorder is happy,
		// and that is not the same as the card being sound.
		check('the headline does not call the card sound',
			v.head.level !== 'ok' && !/Nothing wrong/.test(v.head.text), JSON.stringify(v.head));
		check('and it says what it means', /never checked/i.test(v.head.text), v.head.text);
	}

	group('a card that has passed everything may say so');
	{
		const v = ask({ probe: clean, scan: readAll });
		check('all three lines are ok',
			v.keeping.level === 'ok' && v.stores.level === 'ok' && v.reads.level === 'ok',
			JSON.stringify(v));
		check('and so is the headline', v.head.level === 'ok', v.head.text);
		// Still not "this card is healthy": what was read came back, and a
		// block nothing has written to yet is not covered by that.
		check('the read-back line claims only what it read',
			/came back/.test(v.reads.text) && !/healthy/i.test(v.reads.text), v.reads.text);
	}

	group('a counterfeit card is named, not merely failed');
	{
		const v = ask({ probe: { state: 'wrapped', from: 17179869184, at: 0, total: 17, kept: 15 } });
		check('the headline goes bad', v.head.level === 'bad', v.head.text);
		// Both addresses, because that pair is the whole finding: it is what
		// turns "this card is broken" into "this card is not what it was sold
		// as", which is a thing the owner can act on.
		check('it names where the marker was written', /16 GB/.test(v.stores.text), v.stores.text);
		check('and where it came back', /0 bytes/.test(v.stores.text), v.stores.text);
		check('and says what it costs', /overwrite the oldest/.test(v.stores.text), v.stores.text);
	}

	group('a probe that could not look is not a probe that passed');
	{
		const v = ask({ probe: { state: 'unknown', kept: 3, seen: 3, total: 17 } });
		check('it is not ok', v.stores.level !== 'ok', JSON.stringify(v.stores));
		check('and it says it could not say', /could not/.test(v.stores.text), v.stores.text);
	}

	group('a scan that stopped part-way is not a clean bill of health');
	{
		const v = ask({ probe: clean, scan: { state: 'stopped', bytes: 1073741824, badChunks: 0, findings: [], phase: 1 } });
		check('the read-back line is not ok', v.reads.level !== 'ok', JSON.stringify(v.reads));
		check('it says the rest was not looked at', /not looked at/.test(v.reads.text), v.reads.text);
		check('and the headline does not call the card sound', v.head.level !== 'ok', v.head.text);
	}

	group('unreadable pieces are counted and the headline follows');
	{
		const v = ask({ probe: clean, scan: { state: 'done', bytes: 60134761873, badChunks: 3, findings: [{}, {}, {}], phase: 2 } });
		check('the read-back line goes bad', v.reads.level === 'bad', v.reads.text);
		check('it counts them', /3 pieces/.test(v.reads.text), v.reads.text);
		check('the headline follows the worst line', v.head.level === 'bad', v.head.text);
	}

	group('the queue is the early warning, and it fires before anything is lost');
	{
		const behind = ask({ queued: true, probe: clean, scan: readAll });
		check('it warns', behind.keeping.level === 'warn', JSON.stringify(behind.keeping));
		check('and says nothing has been lost yet',
			/none have been lost/.test(behind.keeping.text), behind.keeping.text);
		check('the headline warns too', behind.head.level === 'warn', behind.head.text);
		// Losing footage outranks queuing: once clips are gone, saying they are
		// merely waiting would be the wrong sentence. A loss still HAPPENING
		// outranks it outright; a loss that has stopped does not take the lead
		// from a queue backing up right now, but it must still take away the
		// reassurance, because "none have been lost yet" would be false.
		const losing = H.keeping({
			v: { records_state: 0, records_fragments_written_total: 400, records_fragments_dropped_total: 2 },
		}, true, true);
		check('a loss still happening outranks the queue',
			losing.level === 'bad' && /still being lost/.test(losing.text), losing.text);
		const settledLoss = H.keeping({
			v: { records_state: 0, records_fragments_written_total: 400, records_fragments_dropped_total: 2 },
		}, true, false);
		check('a stopped loss leaves the live queue leading',
			settledLoss.kind === 'marginal', settledLoss.kind + ' ' + settledLoss.text);
		check('but never claims nothing has been lost',
			!/none have been lost/.test(settledLoss.text) && /2 have already been lost/.test(settledLoss.text),
			settledLoss.text);
	}

	group('a running scan does not quote a figure the progress bar also quotes');
	{
		const v = ask({ scan: { state: 'running', bytes: 14500000000, badChunks: 0, findings: [], phase: 1 } });
		// Two formatters rounding one value differently, one line apart, reads
		// as a page arguing with itself -- measured on the camera as "14 GB"
		// sitting directly above "13.5 GB of 56.0 GB".
		check('the sentence carries no byte count', !/\d+(\.\d+)? ?(GB|MB|KB|bytes)/.test(v.reads.text), v.reads.text);
		check('but it says what is being read', /recordings/.test(v.reads.text), v.reads.text);
		const v2 = ask({ scan: { state: 'running', bytes: 1, badChunks: 2, findings: [{}, {}], phase: 2 } });
		check('a fault found mid-run is still reported at once', /2 pieces/.test(v2.reads.text), v2.reads.text);
	}

	group('the queue warning does not promise what the camera never reported');
	{
		// "though none have been lost yet" is a claim, and it rests on the
		// dropped counter. On a build that publishes the queue depth but not
		// that counter, saying it is reassurance nobody offered -- and it is
		// reassurance attached to a warning, which is where it is least likely
		// to be questioned.
		const noDropped = without('records_fragments_dropped_total');
		const warned = H.keeping(noDropped, true);
		check('it still warns about the queue', warned.level === 'warn', JSON.stringify(warned));
		check('but it does not say nothing has been lost',
			!/none have been lost/.test(warned.text), warned.text);
		check('it says the camera cannot tell',
			/does not report whether any have been lost/.test(warned.text), warned.text);
		// With the counter present and zero, the reassurance is earned.
		const full = H.keeping(recording, true);
		check('a camera that does report it keeps the reassurance',
			/none have been lost/.test(full.text), full.text);
	}

	group('the headline takes the worst line, never an average');
	{
		const v = ask({
			probe: clean,
			scan: { state: 'done', bytes: 1, badChunks: 1, findings: [{}], phase: 2 },
		});
		check('two good lines do not outvote one bad one', v.head.level === 'bad', JSON.stringify(v));
	}

	group('a card the camera cannot open is not a card nobody has used (#544)');
	{
		// Each of these is a recorder that has written NOTHING -- because it
		// cannot write. Read in the other order the fragment count silences
		// the verdict, and the page reports a dead card as an idle one.
		const cases = [
			[3, /cannot open the card/],
			[2, /failing/],
			[1, /intermittently/],
		];
		cases.forEach(([st, wants]) => {
			const k = H.keeping(rec({ records_state: st, records_fragments_written_total: 0 }));
			check('verdict ' + st + ' with nothing written is bad', k.level === 'bad', k.level + ' ' + k.text);
			check('verdict ' + st + ' keeps its own sentence', wants.test(k.text), k.text);
		});
		const v = H.verdict({ recorder: rec({ records_state: 3, records_fragments_written_total: 0 }) });
		check('and the headline says so', v.head.text === 'This card has a problem.', v.head.text);
	}

	group('but an idle camera does not accuse its card (#544)');
	{
		// The verdict gauge is not cleared when recording is switched off; it
		// keeps whatever it last said, so on an idle camera it can still read
		// `offline` from a failed attempt long ago. A plain reorder would have
		// made that camera report a broken card.
		const off = H.keeping(rec({ records_enabled: 0, records_state: 3, records_fragments_written_total: 0 }));
		check('recording switched off is not bad', off.level !== 'bad', off.level + ' ' + off.text);
		check('and it says why it has nothing to report', /switched off/.test(off.text), off.text);

		// A build that does not publish the gauge cannot tell a live verdict
		// from a stale one, so an idle camera keeps the older, quieter answer.
		const old = H.keeping({ v: (() => {
			const o = Object.assign({}, FULL, { records_state: 3, records_fragments_written_total: 0 });
			delete o.records_enabled;
			return o;
		})() });
		check('an unpublished gauge keeps the quiet answer', old.kind === 'idle', old.kind + ' ' + old.text);
	}

	group('a loss that has stopped is a note, not an alarm (#545)');
	{
		// The case this exists for: a card recording normally, with an empty
		// queue and no errors, reporting a fault for the rest of the daemon's
		// life because a maintenance remount briefly cost it a few clips.
		const settled = H.keeping(rec({ records_fragments_dropped_total: 33 }), false, false);
		check('a standing total is a warning, not a fault', settled.level === 'warn', settled.level + ' ' + settled.text);
		check('and it still says clips were lost', /33 clips/.test(settled.text), settled.text);
		check('and says the loss has stopped', /none while this page/.test(settled.text), settled.text);

		const active = H.keeping(rec({ records_fragments_dropped_total: 33 }), false, true);
		check('a count still moving is a fault', active.level === 'bad', active.level + ' ' + active.text);
		check('and says it is still happening', /still being lost/.test(active.text), active.text);

		// The caller owns the window, so with no judgement offered the page
		// must not invent one and must not raise the alarm.
		const unjudged = H.keeping(rec({ records_fragments_dropped_total: 33 }));
		check('no window judgement means no alarm', unjudged.level === 'warn', unjudged.level);
	}

	group('the card is named only when it names itself twice over (#546)');
	{
		check('matching ids give the maker', H.vendorOf(CARD_SANDISK) === 'SanDisk', String(H.vendorOf(CARD_SANDISK)));
		check('an unknown id gives no name', H.vendorOf(CARD_MISNAMED) === null, String(H.vendorOf(CARD_MISNAMED)));
		// A wrong row in the table must fail silent rather than print somebody
		// else's brand: the OEM string has to agree with the id.
		const mismatched = Object.assign({}, CARD_SANDISK, { oemid: '0x3432' });
		check('a disagreeing OEM id gives no name', H.vendorOf(mismatched) === null, String(H.vendorOf(mismatched)));
		check('no card at all is not a crash', H.vendorOf(null) === null && H.vendorOf({}) === null);
	}

	group('provenance prompts a check and never delivers a verdict (#546)');
	{
		check('a coherent card says nothing', H.provenance(CARD_SANDISK) === null, JSON.stringify(H.provenance(CARD_SANDISK)));

		const mis = H.provenance(CARD_MISNAMED);
		check('a name that disagrees with the device is noticed',
			mis && /product name says 16 GB/.test(mis.text), mis && mis.text);
		// The device's size is on the identity line already, and this module
		// formats bytes differently from the page. Quoting it again is how a
		// page ends up printing two different sizes for one card.
		check('and it does not quote a second size for the same card',
			mis && !/\d+(\.\d+)? GB device/.test(mis.text), mis && mis.text);
		const nam = H.provenance(CARD_NAMELESS);
		check('an empty product name is noticed',
			nam && /no real product name/.test(nam.text), nam && nam.text);

		// The invariant this whole feature turns on. CARD_MISNAMED was proven
		// genuine by a whole-device write and verify, so nothing here may be
		// ranked, coloured or counted as a finding.
		[mis, nam].forEach((p) => {
			check('it carries no level to be ranked by', p.level === undefined, JSON.stringify(p));
		});
		const base = H.verdict({ recorder: recording, probe: clean, scan: readAll });
		[CARD_SANDISK, CARD_MISNAMED, CARD_NAMELESS].forEach((c) => {
			const v = H.verdict({ recorder: recording, probe: clean, scan: readAll, card: c });
			check('the headline is untouched by provenance',
				JSON.stringify(v.head) === JSON.stringify(base.head), JSON.stringify(v.head));
		});
		check('and it points at the check that settles it',
			/the check above is what settles it/.test(mis.text), mis.text);

		// A merely old card is not a suspicious one; plenty of genuine cards
		// are old. Only a date that could not have happened counts.
		check('an old but possible date is not a tell',
			!/dated/.test(nam.text), nam.text);
		const future = H.provenance(Object.assign({}, CARD_SANDISK, { date: '01/' + (new Date().getFullYear() + 5) }));
		check('a date in the future is', future && /has not happened yet/.test(future.text), future && future.text);
	}

	group('a reading nobody took is not a fact about the card (#567 review)');
	{
		// The endpoint omits an identity key the kernel does not export. An
		// absent field is a fact about that kernel; an empty one is a fact
		// about the card. Only the second is the card's to answer for.
		check('no identity readings at all says nothing',
			H.provenance({ sizeBytes: 32e9 }) === null,
			JSON.stringify(H.provenance({ sizeBytes: 32e9 })));
		check('an unpublished product name is not a missing one',
			H.provenance({ manfid: '0x000003', oemid: '0x5344', sizeBytes: 64e9, date: '05/2021' }) === null,
			JSON.stringify(H.provenance({ manfid: '0x000003', oemid: '0x5344', sizeBytes: 64e9, date: '05/2021' })));
		// But a name that WAS read and came back empty still counts.
		const empty = H.provenance(Object.assign({}, CARD_SANDISK, { model: '' }));
		check('a name read back empty is still a tell',
			empty && /no real product name/.test(empty.text), empty && empty.text);
		check('an unpublished manufacturer id is not an unrecognised one',
			H.provenance({ model: 'SD64G', sizeBytes: 64e9 }) === null,
			JSON.stringify(H.provenance({ model: 'SD64G', sizeBytes: 64e9 })));
	}

	group('a manufacture date is compared as a whole month (#567 review)');
	{
		const now = new Date();
		const ym = (y, m) => ('0' + m).slice(-2) + '/' + y;
		const withDate = (d) => H.provenance(Object.assign({}, CARD_SANDISK, { date: d }));

		// A year-only comparison let every one of these through.
		const notADate = withDate('13/2020');
		check('an impossible month is caught', notADate && /is not a date/.test(notADate.text), notADate && notADate.text);

		const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
		const soon = withDate(ym(nextMonth.getFullYear(), nextMonth.getMonth() + 1));
		check('next month has not happened yet', soon && /has not happened yet/.test(soon.text), soon && soon.text);

		const nextYear = withDate(ym(now.getFullYear() + 1, 6));
		check('next year has not happened yet', nextYear && /has not happened yet/.test(nextYear.text), nextYear && nextYear.text);

		// This month is fine, and so is any past month.
		check('this month is not a tell', withDate(ym(now.getFullYear(), now.getMonth() + 1)) === null);
		check('a past month is not a tell', withDate('01/2015') === null);
	}

	group('how much this camera has written to this card');
	{
		// The fourth line. Not a finding, so it must never reach the headline
		// and must never turn into a percentage: there is no endurance figure
		// in any register on an SD card to divide by.
		const w = (over) => H.written(rec(over));

		check('a build that does not publish the durable total gets no line',
			H.written(rec({})) === null);
		check('an unanswered heartbeat gets no line', H.written(null) === null);
		check('a build with no recorder counters at all gets no line',
			H.written({ absent: true }) === null);

		const fresh = w({ records_card_bytes_written_total: 0, records_card_start_time_seconds: 0 });
		check('a card nothing has been written to says so',
			/has not written anything/.test(fresh.text), fresh.text);

		const tb = w({
			records_card_bytes_written_total: 3743551254528,
			records_card_start_time_seconds: 1762041600,
		});
		check('terabytes are rendered as terabytes, not as four-figure GB',
			/3\.4 TB/.test(tb.text), tb.text);
		check('the sentence says who wrote it, because a card can arrive used',
			/This camera has written/.test(tb.text), tb.text);
		check('and when the count started', / since /.test(tb.text), tb.text);

		// The whole point of the caveats: this is host bytes from one camera,
		// so it is a lower bound on the card's wear and cannot be a life
		// estimate. Anything resembling one is a defect.
		check('no percentage, no remaining life, no "healthy"',
			!/%|remaining|life|wear|healthy/i.test(tb.text), tb.text);
		check('and it is not a verdict about the card', tb.level === 'none');

		// Most of these boards have no battery-backed RTC. 0 is the camera
		// saying it has never had a clock worth believing, and rendering it as
		// 1 January 1970 would be the page inventing a date.
		const noclock = w({
			records_card_bytes_written_total: 41802354,
			records_card_start_time_seconds: 0,
		});
		check('a camera with no clock still reports the total',
			/has written/.test(noclock.text), noclock.text);
		check('but claims no date for it',
			!/since/.test(noclock.text) && !/1970/.test(noclock.text), noclock.text);

		// It rides on verdict() but must not colour it.
		const v = H.verdict({
			recorder: rec({
				records_card_bytes_written_total: 3743551254528,
				records_card_start_time_seconds: 1762041600,
			}),
			probe: clean, scan: readAll,
		});
		check('verdict() carries the line', v.written && /3\.4 TB/.test(v.written.text));
		check('and the headline is still decided by the three findings alone',
			v.head.level === 'ok', v.head.level + ': ' + v.head.text);
	}

	done();
}

main();
