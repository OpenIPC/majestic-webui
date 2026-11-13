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
const sp_a = src.indexOf('scan_pid() {');
const sp_b = sp_a >= 0 ? src.indexOf('\n}\n', sp_a) : -1;
if (sp_a < 0 || sp_b < 0) {
	throw new Error('scan_pid was not found in the CGI; this test is testing nothing');
}
const scanPid = src.slice(sp_a, sp_b + 3);
if (scanPid.indexOf('/stat') < 0) {
	throw new Error('the start-time check is gone from scan_pid; this test is testing nothing');
}

// Ask scan_pid whether a lock is held, with the lock written by hand.
function held(pid, start) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdpid-'));
	try {
		const lock = path.join(dir, 'lock');
		fs.mkdirSync(lock);
		if (pid !== null) fs.writeFileSync(path.join(lock, 'pid'), String(pid));
		if (start !== null) fs.writeFileSync(path.join(lock, 'start'), String(start));
		const script = 'SCAN_LOCK=' + JSON.stringify(lock) + '\n' + scanPid + '\nscan_pid\necho\n';
		return execFileSync('sh', ['-c', script], { encoding: 'utf8' }).trim();
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

const myStart = fs.readFileSync('/proc/' + process.pid + '/stat', 'utf8').split(' ')[21];

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

// The identity emitter, sliced out of the shipped CGI the same way.
const kvA = src.indexOf('sysf() {');
const kvB = src.indexOf('# Append one line to the op log');
if (kvA < 0 || kvB <= kvA) {
	throw new Error('sysf/sysf_kv were not found in the CGI; this test is testing nothing');
}
const kv = src.slice(kvA, kvB);
if (kv.indexOf('sysf_kv() {') < 0 || kv.indexOf('-e "$SYS/device/$1"') < 0) {
	throw new Error('the presence guard is gone from sysf_kv; this test is testing nothing');
}

// Ask sysf_kv for a field, with the attribute present / present-and-empty /
// not exported at all.
function kv_for(attr, contents) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkv-'));
	try {
		const sys = path.join(dir, 'sys');
		fs.mkdirSync(path.join(sys, 'device'), { recursive: true });
		if (contents !== null) fs.writeFileSync(path.join(sys, 'device', attr), contents);
		const script = 'SYS=' + JSON.stringify(sys) + '\n' +
			'json_str() { printf \'%s\' "$1"; }\n' + kv +
			'\nsysf_kv ' + attr + ' model\necho\n';
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

	group('the endpoint asks the same question of the lock as the worker does');
	{
		// This one test decides two things: whether the page says a scan is
		// running, and whether a stop request may be written. A pid alone
		// settles neither, because pids are recycled -- a scan killed at some
		// pid leaves a lock that an unrelated long-lived process inherits, and
		// every later scan is then refused for as long as that process lives,
		// while a stop can be aimed at a run nobody established ownership of.
		check('a live pid with its own start time is held',
			held(process.pid, myStart) === String(process.pid), held(process.pid, myStart));
		check('the same pid with somebody else\'s start time is not',
			held(process.pid, '1') === '', JSON.stringify(held(process.pid, '1')));
		check('a pid that is gone is not held', held(999999, myStart) === '');
		check('an empty lock is not held', held(null, null) === '');
		check('rubbish in the pid file is not held', held('nonsense', myStart) === '');
		// A lock written before this carries no start time. Trusting the pid
		// there is the conservative way to be wrong: it costs a refused scan
		// rather than two of them reading one card at once.
		check('a lock from before this still counts as held',
			held(process.pid, null) === String(process.pid), held(process.pid, null));
	}

	group('an attribute this kernel does not export is not an empty one');
	{
		// The page judges a card partly on what it says about itself. An
		// attribute that is missing and one that is present and blank are
		// different facts about different things -- the first is the kernel,
		// the second is the card -- and `cat` renders both as "". Collapsing
		// them had the page telling an owner their card reports no product
		// name when nothing had ever asked it.
		check('a readable attribute is emitted',
			kv_for('name', 'SD64G\n') === '"model":"SD64G",', kv_for('name', 'SD64G\n'));
		check('an attribute that is there and empty is still emitted',
			kv_for('name', '') === '"model":"",', JSON.stringify(kv_for('name', '')));
		check('an attribute this kernel does not export is omitted entirely',
			kv_for('name', null) === '', JSON.stringify(kv_for('name', null)));
	}

	done();
}

main();
