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
	records_state: 0,
	records_fragments_written_total: 400,
	records_fragments_dropped_total: 0,
	records_write_errors_total: 0,
	records_sync_errors_total: 0,
};
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
		// merely waiting would be the wrong sentence.
		const lost = H.keeping({
			v: { records_state: 0, records_fragments_written_total: 400, records_fragments_dropped_total: 2 },
		}, true);
		check('an actual loss outranks the queue', lost.level === 'bad' && /dropped/.test(lost.text), lost.text);
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

	done();
}

main();
