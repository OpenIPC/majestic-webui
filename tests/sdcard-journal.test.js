// A verdict belongs to the card that produced it.
//
// The scan journal and the capacity-probe record sit in /tmp and nothing is
// watching the slot, so neither is removed when a card is taken out. Without a
// check, the next card in that slot is handed the previous one's result: a
// fresh card inherits "every point held what was written to it", or a good one
// inherits a failure it never had. On a page whose whole premise is never
// claiming what has not been established, that is the worst thing it could say
// -- and it says it confidently, about a card nobody has tested.
//
// It cannot be reproduced without two cards and a pair of hands, so the shell
// that decides it is extracted and run against journals written for a card that
// is not the one in the slot.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { check, group, done } = require('./assert');

const CGI = path.join(__dirname, '..', 'www', 'cgi-bin', 'j', 'sdcard.cgi');
const src = fs.readFileSync(CGI, 'utf8');

// Sliced from card_id through the end of scan_frag, so a change inside either
// shows up here as changed behaviour rather than as a pattern that stopped
// matching.
const a = src.indexOf('card_id() {');
const e = src.indexOf('scan_frag() {');
const b = a >= 0 && e > a ? src.indexOf('\n}\n', e) : -1;
if (a < 0 || e < 0 || b < 0) {
	throw new Error('card_id/scan_frag were not found in the CGI; this test is testing nothing');
}
const frag = src.slice(a, b + 3);
if (frag.indexOf('"card"') < 0) {
	throw new Error('the card check is gone from scan_frag; this test is testing nothing');
}

// Run scan_frag against a journal, with the slot reporting a given card.
function frag_for(journal, cardInSlot) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdjournal-'));
	try {
		const jf = path.join(dir, 'state.json');
		if (journal !== null) fs.writeFileSync(jf, journal);
		const sys = path.join(dir, 'sys');
		fs.mkdirSync(path.join(sys, 'device'), { recursive: true });
		if (cardInSlot !== null) fs.writeFileSync(path.join(sys, 'device', 'cid'), cardInSlot);
		const script = 'SYS=' + JSON.stringify(sys) + '\n' + frag +
			'\nscan_frag ' + JSON.stringify(jf) + ' scan\necho\n';
		return execFileSync('sh', ['-c', script], { encoding: 'utf8' }).trim();
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

const CARD_A = '035344534333324780c1a2b3c400e900';
const CARD_B = '02544d53413034478f1122334400d500';
const done_for = (cid) =>
	'{"state":"done","badChunks":0,"bytes":123,"card":"' + cid + '"}';

function main() {
	group('a journal is served for the card that made it');
	{
		const out = frag_for(done_for(CARD_A), CARD_A);
		check('the same card gets its own result', out.indexOf('"scan":') === 0, out);
		check('and the result is carried through whole', out.indexOf('"badChunks":0') > 0, out);
	}

	group('and for no other card');
	{
		// The case this exists for: a completed scan, then somebody swaps the
		// card. The slot now holds something that has never been checked.
		const out = frag_for(done_for(CARD_A), CARD_B);
		check('a different card is told nothing', out === '', JSON.stringify(out));
	}

	group('a journal that does not say which card it describes is not used');
	{
		// What a release before this wrote. It cannot be matched, so it cannot
		// be vouched for -- and being silent is the only safe way to be wrong.
		const out = frag_for('{"state":"done","badChunks":0,"bytes":123}', CARD_A);
		check('an unstamped journal is dropped', out === '', JSON.stringify(out));
	}

	group('a slot that cannot say what is in it claims nothing');
	{
		// No CID from the kernel is not evidence that the card matches; it is
		// no evidence at all, and the same rule applies to it.
		const out = frag_for(done_for(CARD_A), null);
		check('an unreadable slot is not a match', out === '', JSON.stringify(out));
	}

	group('rubbish in the journal never reaches the page');
	{
		// This document is parsed by every page on the camera through the
		// site-wide storage banner, so a half-written journal must not be
		// spliced into it.
		check('a truncated journal is dropped', frag_for('{"state":"do', CARD_A) === '');
		check('an empty journal is dropped', frag_for('', CARD_A) === '');
		check('a missing journal is dropped', frag_for(null, CARD_A) === '');
	}

	done();
}

main();
