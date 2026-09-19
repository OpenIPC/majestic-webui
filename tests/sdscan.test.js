// Reading the card back, and the one thing that makes it worth doing.
//
// `dd` exits 0 on a read that delivered less than it was asked for. Measured on
// an hi3516av300: a read past the end of the device answered "0+0 records out"
// with status 0, and a short read inside a file answers "2+1 records out" and
// exits 0 too. A scan that judged chunks on $? would therefore walk a card
// whose files are half unreadable and report a clean pass, in a confident
// sentence, which is the failure every file in this directory is here to stop.
//
// It cannot be reproduced on demand -- it needs flash that has actually rotted
// -- so the card is simulated: a `dd` on PATH that truncates reads inside a
// nominated range, exactly as a card with unreadable blocks does, and the real
// shipped script is run against it.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { check, group, done } = require('./assert');

const SCAN = path.join(__dirname, '..', 'sbin', 'sdscan');
const src = fs.readFileSync(SCAN, 'utf8');

for (const must of ['read_chunk()', 'records out', 'take_lock()', 'scan_one()']) {
	if (src.indexOf(must) < 0) {
		throw new Error(must + ' is gone from sbin/sdscan; this test is testing nothing');
	}
}

const REAL_DD = execFileSync('sh', ['-c', 'command -v dd'], { encoding: 'utf8' }).trim();

// A dd that hands back less than it was asked for, over a nominated byte range
// of a nominated file, and exits 0 while doing it.
const SHIM = (realDd) => `#!/bin/sh
src=""
bs=1
skip=0
count=0
for a in "$@"; do
	case "$a" in
		if=*) src=\${a#if=};;
		bs=*) bs=\${a#bs=};;
		skip=*) skip=\${a#skip=};;
		count=*) count=\${a#count=};;
	esac
done
if [ -n "$MJ_GONE_FILE" ] && [ "$src" = "$MJ_GONE_FILE" ]; then
	off=$((skip * bs))
	if [ "$off" -ge "$MJ_GONE_AT" ]; then
		rm -f "$src"
		exit 1
	fi
fi
if [ -n "$MJ_ROT_FILE" ] && [ "$src" = "$MJ_ROT_FILE" ]; then
	off=$((skip * bs))
	if [ "$off" -ge "$MJ_ROT_FROM" ] && [ "$off" -lt "$MJ_ROT_TO" ]; then
		# One sector, delivered through a pipe so the final dd counts it as a
		# PARTIAL block and says "0+1 records out" -- short, and exiting 0,
		# which is the shape this is here to reproduce.
		#
		# Two earlier attempts did not reproduce anything, both because the
		# records line is counted in blocks: reading one block instead of
		# sixteen is not short when a chunk is one block, and reading a whole
		# smaller block still prints "1+0" whatever its size.
		${realDd} if="$src" bs=512 skip=$((off / 512)) count=1 2>/dev/null |
			${realDd} bs="$bs" count=1 of=/dev/null
		exit 0
	fi
fi
exec ${realDd} "$@"
`;

function stage(opts) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdscan-'));
	const mp = path.join(dir, 'mnt');
	const tmp = path.join(dir, 'tmp');
	fs.mkdirSync(path.join(dir, 'bin'));
	fs.mkdirSync(path.join(mp, '2026-09-18'), { recursive: true });
	fs.mkdirSync(tmp);
	fs.writeFileSync(path.join(dir, 'bin', 'dd'), SHIM(REAL_DD), { mode: 0o755 });

	// Two clips and a device image. Small, but several chunks each: the chunk
	// size is read out of the shipped script so a change to it cannot leave
	// this test silently covering one chunk per file.
	const BSZ = Number((src.match(/^BS=(\d+)$/m) || [])[1]);
	const CH = BSZ * (opts.blocks || Number((src.match(/^BLOCKS=(\d+)$/m) || [])[1]));
	if (!CH) throw new Error('the chunk size is gone from sbin/sdscan; this test is testing nothing');
	const clip = path.join(mp, '2026-09-18', '20-13.mp4');
	fs.writeFileSync(clip, Buffer.alloc(CH * (opts.clipChunks || 3) + 4096, 0x41));
	fs.writeFileSync(path.join(mp, '2026-09-18', '20-18.mp4'), Buffer.alloc(CH + 17, 0x42));
	const dev = path.join(dir, 'mmcblk0');
	fs.writeFileSync(dev, Buffer.alloc(opts.devBytes === undefined ? CH * 2 : opts.devBytes, 0x43));
	return { dir, mp, dev, tmp, clip, CH };
}

// Run the real script with its state directory redirected into the sandbox.
function run(st, opts) {
	opts = opts || {};
	let s = src;
	const subs = [
		['SCAN_DIR=/tmp/webui/sdscan', 'SCAN_DIR=' + st.tmp + '/sdscan'],
		['LOCK=/tmp/webui/sdscan.lock', 'LOCK=' + st.tmp + '/sdscan.lock'],
	];
	// A chunk is sixteen megabytes, so filling the findings cap honestly would
	// need a third of a gigabyte of test file. One block per chunk gets the
	// same number of chunks out of twenty-one megabytes, and it is the real
	// add_finding that is under test either way.
	if (opts.blocks) subs.push(['BLOCKS=16', 'BLOCKS=' + opts.blocks]);
	for (const [k, v] of subs) {
		if (s.indexOf(k) < 0) throw new Error(k + ' is gone from sbin/sdscan; this test is testing nothing');
		s = s.replace(k, v);
	}
	// The span comes from /sys on a camera; here it is the image's own length.
	const sysLine = s.match(/^span=\$\(cat "\/sys\/block\/.*$/m);
	if (!sysLine) throw new Error('the span lookup is gone from sbin/sdscan; this test is testing nothing');
	s = s.replace(sysLine[0], 'span=$(( $(stat -c %s "$DEV") / 512 ))');
	s = s.replace(/^mkdir -p \/tmp\/webui 2>\/dev\/null$/m, 'mkdir -p ' + st.tmp + ' 2>/dev/null');

	const script = path.join(st.dir, 'sdscan');
	fs.writeFileSync(script, s, { mode: 0o755 });

	const env = Object.assign({}, process.env, {
		PATH: path.join(st.dir, 'bin') + ':' + process.env.PATH,
	});
	if (opts.rot) {
		env.MJ_ROT_FILE = opts.rot.file;
		env.MJ_ROT_FROM = String(opts.rot.from);
		env.MJ_ROT_TO = String(opts.rot.to);
	}
	if (opts.gone) {
		env.MJ_GONE_FILE = opts.gone.file;
		env.MJ_GONE_AT = String(opts.gone.at);
	}
	execFileSync('sh', [script, st.mp, st.dev], { encoding: 'utf8', env, stdio: 'pipe' });
	return JSON.parse(fs.readFileSync(path.join(st.tmp, 'sdscan', 'state.json'), 'utf8'));
}

function main() {
	group('a healthy card reads back clean, and that is the control');
	{
		const st = stage({});
		try {
			const j = run(st);
			check('the run finished', j.state === 'done', JSON.stringify(j));
			check('both phases ran', j.phase === 2, JSON.stringify(j));
			check('nothing was found', j.badChunks === 0 && j.findings.length === 0, JSON.stringify(j));
			check('every byte planned was read', j.bytes === j.total, j.bytes + ' of ' + j.total);
			check('both files were walked', j.filesDone === 2, JSON.stringify(j));
			// The measurement that makes the buckets mean anything.
			check('it settled a median for this card', j.medianMs >= 0 && j.chunks > 0, JSON.stringify(j));
			const bs = j.buckets.reduce((a, b) => a + b, 0);
			check('every good chunk landed in a bucket', bs === j.chunks, bs + ' vs ' + j.chunks);
		} finally { fs.rmSync(st.dir, { recursive: true, force: true }); }
	}

	group('a short read that exits 0 is caught, and named');
	{
		const st = stage({});
		try {
			// The middle chunk of the first clip comes back one block short.
			const j = run(st, { rot: { file: st.clip, from: st.CH, to: st.CH * 2 } });
			check('the run still finished', j.state === 'done', JSON.stringify(j));
			check('the short chunk was counted against the card', j.badChunks === 1, JSON.stringify(j));
			check('exactly one finding was recorded', j.findings.length === 1, JSON.stringify(j.findings));
			const f = j.findings[0] || {};
			// A filename, not a sector: this is the half of the design an LBA
			// sweep cannot give, and the reason phase 1 walks files.
			check('it names the clip rather than an address',
				f.where === '2026-09-18/20-13.mp4', JSON.stringify(f));
			check('it says where in the clip', f.offset === st.CH, JSON.stringify(f));
			check('and why', f.why === 'short', JSON.stringify(f));
		} finally { fs.rmSync(st.dir, { recursive: true, force: true }); }
	}

	group('stopping keeps what was measured');
	{
		const st = stage({ devBytes: 0 });
		try {
			fs.mkdirSync(path.join(st.tmp, 'sdscan'), { recursive: true });
			// The script clears a stale stop flag at startup and only honours
			// one raised while it runs, so this proves the clearing rather than
			// the stopping -- a run that refused to start would report
			// `stopped` with nothing measured, which is the opposite outcome.
			fs.writeFileSync(path.join(st.tmp, 'sdscan', 'stop'), '');
			const j = run(st);
			check('a stop flag left behind by an earlier run does not stop this one',
				j.state === 'done', JSON.stringify(j));
			check('and it measured something', j.chunks > 0, JSON.stringify(j));
		} finally { fs.rmSync(st.dir, { recursive: true, force: true }); }
	}

	group('one scan at a time, and a dead one does not hold the lock for ever');
	{
		const st = stage({ devBytes: 0 });
		try {
			fs.mkdirSync(st.tmp, { recursive: true });
			const lock = path.join(st.tmp, 'sdscan.lock');
			fs.mkdirSync(lock);
			// A pid that is alive holds it: this process.
			fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
			let held = false;
			try { run(st); } catch (e) { held = true; }
			held = held || !fs.existsSync(path.join(st.tmp, 'sdscan', 'state.json'));
			check('a live holder keeps a second scan out', held, 'the second run wrote state anyway');

			// A pid that is gone does not. kill -0 is the proof; an age bound
			// could never be both short enough to recover from a kill -9 and
			// long enough to survive a six-hour scan.
			fs.writeFileSync(path.join(lock, 'pid'), '999999');
			const j = run(st);
			check('a holder that has died is stepped over', j.state === 'done', JSON.stringify(j));
		} finally { fs.rmSync(st.dir, { recursive: true, force: true }); }
	}

	group('a clip the recorder deleted mid-scan is not a fault of the card');
	{
		const st = stage({ devBytes: 0 });
		try {
			// majestic deletes the oldest clip whenever the card reaches
			// records.maxUsage. On a card at 91% that happens every few
			// minutes, to the very files at the front of the oldest-first list
			// this walks — and an unlinked file reads exactly like a bad
			// block, so without the guard a healthy full card reports
			// unreadable footage, and more of it the fuller it is.
			const j = run(st, { gone: { file: st.clip, at: st.CH } });
			check('the run finished', j.state === 'done', JSON.stringify(j));
			check('the card is not blamed', j.badChunks === 0, JSON.stringify(j));
			check('and nothing is listed against it', j.findings.length === 0, JSON.stringify(j.findings));
			// Counted rather than ignored: those bytes were not checked, so a
			// clean result must not be read as covering them.
			check('the clip is counted as skipped', j.vanished === 1, String(j.vanished));
			check('the other clip was still walked', j.filesDone === 2, JSON.stringify(j));
		} finally { fs.rmSync(st.dir, { recursive: true, force: true }); }
	}

	group('findings are capped, and the overflow is counted rather than dropped');
	{
		const cap = Number((src.match(/^MAX_FINDINGS=(\d+)$/m) || [])[1]);
		if (!cap) throw new Error('MAX_FINDINGS is gone from sbin/sdscan; this test is testing nothing');
		// Every chunk of the first clip comes back short. This document is
		// polled on every page by the site-wide storage banner, on a camera
		// with a few megabytes of RAM, so a card failing everywhere must not
		// be able to grow it without bound.
		const st = stage({ devBytes: 0, clipChunks: cap + 6, blocks: 1 });
		try {
			const j = run(st, { rot: { file: st.clip, from: 0, to: 1 << 30 }, blocks: 1 });
			check('the list stops at the cap', j.findings.length === cap,
				j.findings.length + ' of ' + cap);
			check('the rest are counted, not silently dropped', j.moreFindings > 0, String(j.moreFindings));
			check('and every one of them was still counted as bad',
				j.badChunks === j.findings.length + j.moreFindings,
				j.badChunks + ' vs ' + (j.findings.length + j.moreFindings));
		} finally { fs.rmSync(st.dir, { recursive: true, force: true }); }
	}

	group('a newline in a filename does not make a file disappear');
	{
		const st = stage({ devBytes: 0 });
		try {
			// A newline is legal in a filename, and a newline-delimited list
			// turns one such file into two paths that are not files. Both
			// halves then fail the existence test, so the file is never read
			// while the counts go on describing a walk that did not happen.
			const odd = path.join(st.mp, '2026-09-18', 'a\nb.mp4');
			fs.writeFileSync(odd, Buffer.alloc(st.CH + 32, 0x44));
			const j = run(st);
			check('the run finished', j.state === 'done', JSON.stringify(j));
			check('all three files were counted', j.files === 3, String(j.files));
			check('and all three were walked', j.filesDone === 3, String(j.filesDone));
			// The one that proves it was actually read rather than skipped as
			// missing: a file nobody read is not a file anybody vanished.
			check('none of them went missing', j.vanished === 0, String(j.vanished));
			check('nothing was blamed on the card', j.badChunks === 0, JSON.stringify(j.findings));
		} finally { fs.rmSync(st.dir, { recursive: true, force: true }); }
	}

	group('a lock is only held by the process that took it');
	{
		const st = stage({ devBytes: 0 });
		try {
			fs.mkdirSync(st.tmp, { recursive: true });
			const lock = path.join(st.tmp, 'sdscan.lock');
			fs.mkdirSync(lock);
			// A pid that is alive, with a start time that is not its own. This
			// is a recycled pid: `kill -0` answers for whatever holds the
			// number now, so without the start time a scan killed at some pid
			// stays locked out for as long as an unrelated long-lived process
			// happens to hold it -- which can be for ever.
			fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
			fs.writeFileSync(path.join(lock, 'start'), '1');
			const j = run(st);
			check('a live pid with the wrong start time does not hold it',
				j.state === 'done', JSON.stringify(j));

			// And the same pid with its real start time does hold it.
			const real = fs.readFileSync('/proc/' + process.pid + '/stat', 'utf8').split(' ')[21];
			fs.mkdirSync(lock, { recursive: true });
			fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
			fs.writeFileSync(path.join(lock, 'start'), real);
			fs.rmSync(path.join(st.tmp, 'sdscan'), { recursive: true, force: true });
			let kept = false;
			try { run(st); } catch (e) { kept = true; }
			kept = kept || !fs.existsSync(path.join(st.tmp, 'sdscan', 'state.json'));
			check('a live pid with its own start time keeps a scan out', kept,
				'the second run wrote state anyway');
		} finally { fs.rmSync(st.dir, { recursive: true, force: true }); }
	}

	group('the state file is always whole');
	{
		const st = stage({});
		try {
			const j = run(st);
			check('it parses as JSON', typeof j === 'object' && j !== null);
			for (const k of ['state', 'phase', 'bytes', 'total', 'chunks', 'badChunks',
				'medianMs', 'buckets', 'findings', 'direct', 'startedAt', 'vanished', 'card']) {
				check('it carries ' + k, Object.prototype.hasOwnProperty.call(j, k), Object.keys(j).join(','));
			}
			// Published rather than acted on quietly: without O_DIRECT the scan
			// evicts majestic's page cache for its whole length, and the page
			// has to be able to say so.
			check('it says whether the reads were uncached', typeof j.direct === 'boolean', String(j.direct));
		} finally { fs.rmSync(st.dir, { recursive: true, force: true }); }
	}

	done();
}

main();
