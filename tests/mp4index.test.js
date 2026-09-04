// MajesticMp4Index — recovering byte<->time from a recording that carries no
// index of its own.
//
// This is exactly the kind of thing the suite in this repo is for: it is pure
// binary parsing whose failure mode is silent. A wrong offset does not throw,
// it seeks to the wrong moment; a mis-summed duration does not throw, it makes
// a timeline that lies. Neither is something a browser can be made to
// reproduce on demand, and neither is visible in a screenshot.
//
// The fixtures below are built to the shape majestic actually writes, measured
// off a real clip on an hi3516av300: ftyp(36) + moov, then moof+mdat pairs
// whose moof holds mfhd + traf{tfhd,trun}, with per-sample durations in trun
// and NO tfdt anywhere. The awkward cases are real too — the repeated
// sequence_number, and the half-written fragment at the end of a clip that is
// still recording.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const SRC = path.join(__dirname, '..', 'www', 'a', 'mp4index.js');

function load() {
	const ctx = {
		window: {},
		console: console,
		Promise: Promise,
		// referenced only inside reader(), which these tests never call
		apiFetch: function () { throw new Error('no network in tests'); },
	};
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx);
	return ctx.window.MajesticMp4Index;
}

const M = load();

// ---- fixture builders --------------------------------------------------

function box(type, payload) {
	const b = Buffer.alloc(8 + payload.length);
	b.writeUInt32BE(8 + payload.length, 0);
	b.write(type, 4, 'latin1');
	payload.copy(b, 8);
	return b;
}
function u32(...vals) {
	const b = Buffer.alloc(4 * vals.length);
	vals.forEach((v, i) => b.writeUInt32BE(v >>> 0, i * 4));
	return b;
}

// mdhd v0: version+flags, creation, modification, timescale, duration, lang+pre
function mdhd(timescale) {
	return box('mdhd', Buffer.concat([u32(0, 0, 0, timescale, 0), u32(0)]));
}
function moov(timescale) {
	return box('moov', box('trak', box('mdia', mdhd(timescale))));
}
function ftyp() {
	const p = Buffer.alloc(28);
	p.write('isom', 0, 'latin1');
	p.writeUInt32BE(0x200, 4);
	p.write('isomiso2avc1iso6', 8, 'latin1');
	return box('ftyp', p);
}

// trun with flags 0x000305: data-offset + first-sample-flags + per-sample
// duration + per-sample size. This is what majestic emits.
//
// first_sample_flags is 0x02000000 for a fragment opening on a keyframe and
// 0x01010000 for one that does not — bit 0x10000 being
// sample_is_non_sync_sample. majestic hardcoded the first of those until
// fragments stopped being whole GOPs, which is why a recording carrying no
// first_sample_flags at all has to be read as sync.
const FSF_SYNC = 0x02000000;
const FSF_DELTA = 0x01010000;

function trun(durations, sync) {
	const per = Buffer.alloc(durations.length * 8);
	durations.forEach((d, i) => {
		per.writeUInt32BE(d >>> 0, i * 8);
		per.writeUInt32BE(1000, i * 8 + 4);   // sample size, unused here
	});
	const fsf = sync === false ? FSF_DELTA : FSF_SYNC;
	return box('trun', Buffer.concat([u32(0x000305, durations.length, 0, fsf), per]));
}

// The shape written before first_sample_flags existed: flag 0x004 clear, so
// there is no such field in the box at all.
function trunNoFlags(durations) {
	const per = Buffer.alloc(durations.length * 8);
	durations.forEach((d, i) => {
		per.writeUInt32BE(d >>> 0, i * 8);
		per.writeUInt32BE(1000, i * 8 + 4);
	});
	return box('trun', Buffer.concat([u32(0x000301, durations.length, 0), per]));
}
function tfhdPlain() { return box('tfhd', u32(0x020030, 1)); }
function tfhdDefaultDuration(d) {
	// flags 0x08 = default_sample_duration_present
	return box('tfhd', u32(0x000008, 1, d));
}

// tfdt is a FullBox: version 1 then a 64-bit baseMediaDecodeTime, which is
// what majestic writes. Optional here so the same builder produces both a
// current recording and one written before the box existed.
function tfdt(ticks) {
	const p = Buffer.alloc(12);
	p.writeUInt32BE(0x01000000, 0);          // version 1, flags 0
	p.writeBigUInt64BE(BigInt(ticks), 4);
	return box('tfdt', p);
}

function moof(seq, tfhdBox, trunBox, decodeTicks) {
	const mfhd = box('mfhd', u32(0, seq));
	const traf = decodeTicks === null
		? [tfhdBox, trunBox]
		: [tfhdBox, tfdt(decodeTicks), trunBox];
	return box('moof', Buffer.concat([mfhd, box('traf', Buffer.concat(traf))]));
}
function mdat(len, fill) {
	const p = Buffer.alloc(Math.max(0, len - 8), fill === undefined ? 0x41 : fill);
	return box('mdat', p);
}

// A whole clip. `specs` is one entry per fragment:
//   { seq, durations:[ticks…], payload:bytes, defaultDur? }
// `withTfdt` false builds a pre-tfdt recording, the shape majestic wrote when
// records were enabled — still on plenty of cards, so both paths need cover.
function clip(timescale, specs, withTfdt) {
	const parts = [ftyp(), moov(timescale)];
	let ticks = 0;
	specs.forEach(s => {
		const tf = s.defaultDur ? tfhdDefaultDuration(s.defaultDur) : tfhdPlain();
		const tr = s.defaultDur
			? box('trun', u32(0x000005, s.count, 0, FSF_SYNC))   // no per-sample durations
			: (s.noFlags ? trunNoFlags(s.durations) : trun(s.durations, s.sync));
		parts.push(moof(s.seq, tf, tr, withTfdt === false ? null : ticks));
		parts.push(mdat(s.payload, s.fill));
		ticks += s.defaultDur
			? s.defaultDur * s.count
			: s.durations.reduce((a, b) => a + b, 0);
	});
	return Buffer.concat(parts);
}

// The default shape: 20 samples of 50000 ticks at timescale 1e6 = 1.000 s.
function evenSpecs(n, opts) {
	const o = opts || {};
	const out = [];
	for (let i = 0; i < n; i++) {
		out.push({
			seq: o.seqs ? o.seqs[i] : i,
			durations: new Array(20).fill(50000),
			payload: o.sizes ? o.sizes[i] : 40000,
		});
	}
	return out;
}

// read(start, endInclusive) over a Buffer, as majestic's Range serving behaves.
function readerFor(buf, log) {
	return function (start, end) {
		if (log) log.push([start, end]);
		return Promise.resolve(new Uint8Array(buf.subarray(start, Math.min(end + 1, buf.length))));
	};
}

const u8of = b => new Uint8Array(b);

// ---- init ---------------------------------------------------------------

group('the init segment — everything before the first moof');

{
	const buf = clip(1000000, evenSpecs(3));
	const init = M.parseInit(u8of(buf));
	const expectedHeader = ftyp().length + moov(1000000).length;

	check('timescale comes off mdhd', init.timescale === 1000000, 'got ' + init.timescale);
	check('firstMoof is where moov ends', init.firstMoof === expectedHeader,
		'got ' + init.firstMoof + ' want ' + expectedHeader);
	check('headerLength is the init segment to prepend on export',
		init.headerLength === expectedHeader);
	check('a file with no moov yields nothing to index',
		M.parseInit(u8of(ftyp())) === null);
}

// ---- fragment parsing ---------------------------------------------------

group('one step of the moof/mdat chain');

{
	const buf = clip(1000000, evenSpecs(2));
	const init = M.parseInit(u8of(buf));
	const f = M.parseFragment(u8of(buf.subarray(init.firstMoof, init.firstMoof + M.STEP)));

	check('reads the moof size', f.moofSize > 16);
	check('reads the mdat size', f.mdatSize === 40000, 'got ' + f.mdatSize);
	check('total is the stride to the next fragment', f.total === f.moofSize + 40000);
	check('picks sequence_number out of mfhd', f.seq === 0, 'got ' + f.seq);
	check('sums per-sample durations from trun', f.durTicks === 20 * 50000,
		'got ' + f.durTicks);
}

{
	// the other legal way to state duration: tfhd default x sample count
	const buf = clip(90000, [{ seq: 0, defaultDur: 3000, count: 30, payload: 1000 }]);
	const init = M.parseInit(u8of(buf));
	const f = M.parseFragment(u8of(buf.subarray(init.firstMoof, init.firstMoof + M.STEP)));
	check('falls back to tfhd default_sample_duration when trun omits durations',
		f.durTicks === 3000 * 30, 'got ' + f.durTicks);
}

{
	const buf = clip(1000000, evenSpecs(1));
	const init = M.parseInit(u8of(buf));
	// a read too short to reach the mdat header must say so, not guess
	const f = M.parseFragment(u8of(buf.subarray(init.firstMoof, init.firstMoof + 20)));
	check('a short read reports how much it needed', f && f.short > 20, JSON.stringify(f));
	check('garbage is rejected outright',
		M.parseFragment(new Uint8Array(32)) === null);
}

// ---- finding a moof in the middle of a file -----------------------------

group('finding a fragment boundary from an arbitrary offset');

{
	// mdat payload that literally spells "moof" — this happens by chance
	// several times a minute in real video, and a substring search lands in it
	const evil = Buffer.from('moof');
	const specs = evenSpecs(3);
	specs[1].payload = 4096;
	const buf = clip(1000000, specs);
	const init = M.parseInit(u8of(buf));
	const f0 = M.parseFragment(u8of(buf.subarray(init.firstMoof, init.firstMoof + M.STEP)));
	// plant it inside the first mdat
	evil.copy(buf, init.firstMoof + f0.moofSize + 64);

	// search from past the first fragment's own header, the way locate() scans
	// forward from a probe that landed mid-file
	const found = M.findMoof(u8of(buf), init.firstMoof + 8);
	const second = init.firstMoof + f0.total;
	check('skips a "moof" that is only mdat payload', found === second,
		'got ' + found + ' want ' + second);
	check('returns -1 when there is no fragment left',
		M.findMoof(u8of(Buffer.alloc(4096, 0x41)), 0) === -1);
}

// ---- the exact index ----------------------------------------------------

group('buildIndex — the exact walk');

{
	const buf = clip(1000000, evenSpecs(5));
	const init = M.parseInit(u8of(buf));
	const log = [];

	M.buildIndex(readerFor(buf, log), buf.length, init).then(idx => {
		check('finds every fragment', idx.fragments.length === 5,
			'got ' + idx.fragments.length);
		check('duration is the sum of the fragments', idx.duration === 5,
			'got ' + idx.duration);
		check('times are cumulative and exact',
			idx.fragments.map(f => f.t).join(',') === '0,1,2,3,4',
			idx.fragments.map(f => f.t).join(','));
		check('offsets step by the fragment length',
			idx.fragments[1].off === idx.fragments[0].off + idx.fragments[0].len);
		check('one read per fragment, not two',
			log.length === 5 || log.length === 6, 'reads: ' + log.length);
		check('reads are small — headers only, never payload',
			log.every(r => r[1] - r[0] < 1024), JSON.stringify(log[0]));
		check('a fully walked clip reports complete', idx.complete === true);

		// ---- still-recording clip: the tail is half written -------------
		const partial = buf.subarray(0, buf.length - 12000);
		return M.buildIndex(readerFor(partial), partial.length, init);
	}).then(idx => {
		check('a clip still being written indexes its complete fragments',
			idx.fragments.length === 4, 'got ' + idx.fragments.length);
		check('and reports the duration it can actually offer',
			idx.duration === 4, 'got ' + idx.duration);
		check('and does not claim to be complete', idx.complete === false);

		return runLocate();
	}).then(runExport).then(runSync).then(runSyncCheap).then(runCheap).then(() => done());
}

// ---- the approximate seek ----------------------------------------------

function runLocate() {
	group('locate — binary search before the index exists');

	// 400 fragments, and the repeated sequence_number majestic really emits:
	// 0,1,2,2,3,4,... Monotonic but not an ordinal.
	const n = 400;
	const seqs = [];
	for (let i = 0, s = 0; i < n; i++) {
		seqs.push(s);
		if (i !== 2) s++;            // the plateau, exactly where it was observed
	}
	const sizes = [];
	for (let i = 0; i < n; i++) sizes.push(20000 + (i % 7) * 9000);   // variable, as real fragments are

	const buf = clip(1000000, evenSpecs(n, { seqs: seqs, sizes: sizes }));
	const init = M.parseInit(u8of(buf));
	const log = [];
	const read = readerFor(buf, log);

	return M.buildIndex(read, buf.length, init).then(idx => {
		log.length = 0;
		return M.locate(read, buf.length, init, 300, 1).then(hit => {
			const exact = M.fragmentAt(idx, 300);
			check('lands within a few fragments of the target',
				Math.abs(hit.approxSec - 300) <= 5,
				'approxSec ' + hit.approxSec);
			check('lands on a real fragment boundary',
				idx.fragments.some(f => f.off === hit.off),
				'off ' + hit.off);
			check('does not walk the file to get there', log.length < 20,
				'probes: ' + log.length);
			check('the exact index still knows better',
				exact.t === 300, 'exact ' + exact.t);
		});
	}).then(() => {
		const buf2 = clip(1000000, evenSpecs(20));
		const init2 = M.parseInit(u8of(buf2));
		return M.locate(readerFor(buf2), buf2.length, init2, 0, 1).then(hit => {
			check('seeking to zero returns the first fragment',
				hit.off === init2.firstMoof, 'got ' + hit.off);
		});
	});
}

// ---- export -------------------------------------------------------------

function runExport() {
	group('exportRanges — a clip is a byte concatenation, not a re-encode');

	const buf = clip(1000000, evenSpecs(10));
	const init = M.parseInit(u8of(buf));

	return M.buildIndex(readerFor(buf), buf.length, init).then(idx => {
		const r = M.exportRanges(idx, 3, 6);

		check('the header range is the init segment',
			r.header.start === 0 && r.header.end === init.headerLength);
		check('the body starts at the fragment holding t0',
			r.body.start === idx.fragments[3].off,
			r.body.start + ' vs ' + idx.fragments[3].off);
		check('boundaries snap outward to whole fragments — half a fragment does not decode',
			r.from === 3 && r.to === 6, r.from + '..' + r.to);
		check('the byte count is what the viewer is about to be handed',
			r.bytes === init.headerLength + (r.body.end - r.body.start),
			'got ' + r.bytes);
		check('fragment count matches the span', r.fragments === 3, 'got ' + r.fragments);

		const rev = M.exportRanges(idx, 6, 3);
		check('a backwards drag selects the same range',
			rev.body.start === r.body.start && rev.body.end === r.body.end);

		const past = M.exportRanges(idx, 9.5, 99);
		check('a selection running past the end clamps to the last fragment',
			past.body.end === idx.fragments[9].off + idx.fragments[9].len);

		check('fragmentAt finds the fragment covering a moment',
			M.fragmentAt(idx, 4.5).t === 4, 'got ' + M.fragmentAt(idx, 4.5).t);
		check('fragmentAt clamps below zero to the first fragment',
			M.fragmentAt(idx, -10).t === 0);
	});
}

// ---- where a decoder may be started -------------------------------------

// Until majestic bounded a fragment by time and bytes, every fragment began at
// an IDR and the writer said so with a hardcoded first_sample_flags. Now a
// fragment can open mid-GOP, and one that does is not a place a decoder can be
// started: it holds frames whose references were never appended, so a
// SourceBuffer given one produces a green or smeared picture rather than an
// error. A seek that landed there looked like a decode bug.
function runSync() {
	group('seeks and exports start where a decoder can actually start');

	// Keyframes every four fragments, which is what gopSize 4 x fragmentMs
	// 1000 looks like from here.
	const specs = [];
	for (let i = 0; i < 12; i++) {
		specs.push({
			seq: i,
			durations: new Array(20).fill(50000),
			payload: 40000,
			sync: i % 4 === 0,
		});
	}
	const buf = clip(1000000, specs);
	const init = M.parseInit(u8of(buf));

	return M.buildIndex(readerFor(buf), buf.length, init).then(idx => {
		const flags = idx.fragments.map(f => f.sync);
		check('the index records which fragments open on a keyframe',
			JSON.stringify(flags) ===
				JSON.stringify([true, false, false, false, true, false, false,
					false, true, false, false, false]),
			JSON.stringify(flags));

		check('a seek onto a mid-GOP fragment snaps back to the keyframe one',
			M.fragmentAt(idx, 6.5).t === 4, 'got ' + M.fragmentAt(idx, 6.5).t);
		check('a seek that already lands on one does not move',
			M.fragmentAt(idx, 8.2).t === 8, 'got ' + M.fragmentAt(idx, 8.2).t);
		check('and the fragment handed back is one a decoder can start at',
			M.fragmentAt(idx, 6.5).sync === true);

		// An export is a file someone opens in a player that has seen nothing
		// before it, so the same rule applies and costs at most one GOP at the
		// front.
		const r = M.exportRanges(idx, 6, 9);
		check('an export starts at a fragment a player can open',
			r.body.start === idx.fragments[4].off,
			r.body.start + ' vs ' + idx.fragments[4].off);
		check('and says so in the times it reports', r.from === 4, 'got ' + r.from);
		check('the end is unchanged — only the opening has to be decodable',
			r.to === 9, 'got ' + r.to);

		// Nothing to snap back TO is still an answer: the start of the clip is
		// the only place such a file can be started at all.
		const none = [];
		for (let i = 0; i < 5; i++)
			none.push({ seq: i, durations: new Array(20).fill(50000),
				payload: 40000, sync: false });
		const nbuf = clip(1000000, none);
		const ninit = M.parseInit(u8of(nbuf));
		return M.buildIndex(readerFor(nbuf), nbuf.length, ninit).then(nidx => {
			check('a clip with no keyframe anywhere falls back to its start',
				M.fragmentAt(nidx, 3.5) === nidx.fragments[0]);

			// An export from a span that itself begins mid-GOP has nothing
			// behind it to snap back to. Losing up to a GOP off the FRONT of
			// the selection beats handing somebody a file that opens black.
			const mixed = [];
			for (let i = 0; i < 8; i++)
				mixed.push({ seq: i, durations: new Array(20).fill(50000),
					payload: 40000, sync: i >= 3 });
			const mbuf = clip(1000000, mixed);
			const minit = M.parseInit(u8of(mbuf));
			return M.buildIndex(readerFor(mbuf), mbuf.length, minit).then(midx => {
				const r = M.exportRanges(midx, 0, 6);
				check('with no keyframe behind it, an export starts at the first one ahead',
					r.body.start === midx.fragments[3].off,
					r.body.start + ' vs ' + midx.fragments[3].off);
				check('and says so, rather than claiming footage it did not include',
					r.from === 3, 'got ' + r.from);
			});

			// A recording written before first_sample_flags was emitted at all
			// must not become unseekable: it has no such field, and every
			// fragment in it began at an IDR by construction.
			const old = [];
			for (let i = 0; i < 6; i++)
				old.push({ seq: i, durations: new Array(20).fill(50000),
					payload: 40000, noFlags: true });
			const obuf = clip(1000000, old);
			const oinit = M.parseInit(u8of(obuf));
			return M.buildIndex(readerFor(obuf), obuf.length, oinit).then(oidx => {
				check('an older recording carrying no flags reads as all-sync',
					oidx.fragments.every(f => f.sync === true));
				check('so a seek into it still lands where it is aimed',
					M.fragmentAt(oidx, 4.5).t === 4,
					'got ' + M.fragmentAt(oidx, 4.5).t);
			});
		});
	});
}

// The paths production actually takes. buildIndex() is not one of them — a
// full walk of a 20-minute clip is ~1100 range requests — so a snap that only
// works on a full index is a snap that never runs: positionAt() calls
// locate() and hands seekTo() the offset it gets back, and saveSelection()
// calls locate() then spanFrom() from that same offset. Both had to learn it.
function runSyncCheap() {
	group('the cheap paths land somewhere a decoder can start, too');

	const specs = [];
	for (let i = 0; i < 12; i++) {
		specs.push({
			seq: i,
			durations: new Array(20).fill(50000),
			payload: 40000,
			sync: i % 4 === 0,
		});
	}
	const buf = clip(1000000, specs);
	const init = M.parseInit(u8of(buf));

	return M.locate(readerFor(buf), buf.length, init, 6.5, 1).then(hit => {
		check('locate snaps back to the keyframe fragment',
			hit.off === offsetOfFragment(buf, init, 4),
			hit.off + ' vs ' + offsetOfFragment(buf, init, 4));
		check('and says it managed to', hit.atSync === true);
		check('reporting the time it will really start at', hit.approxSec === 4,
			'got ' + hit.approxSec);

		// spanFrom is what the export walks, so it has to carry the flag or
		// exportRanges cannot act on it.
		return M.spanFrom(readerFor(buf), buf.length, init, hit.off, 4);
	}).then(span => {
		check('spanFrom carries which fragments open on a keyframe',
			span.fragments.every(f => typeof f.sync === 'boolean'));
		check('and the span it hands back starts on one', span.fragments[0].sync === true);
	}).then(() => {
		// Nothing to snap to: locate says so rather than pretending.
		const none = [];
		for (let i = 0; i < 6; i++)
			none.push({ seq: i, durations: new Array(20).fill(50000),
				payload: 40000, sync: false });
		const nbuf = clip(1000000, none);
		const ninit = M.parseInit(u8of(nbuf));
		return M.locate(readerFor(nbuf), nbuf.length, ninit, 3.5, 1).then(hit => {
			check('a clip with no keyframe in reach reports that it could not snap',
				hit.atSync === false);
			check('and still lands at or before the moment asked for',
				hit.approxSec <= 3.5, 'got ' + hit.approxSec);
		});
	});
}

// Byte offset of the nth fragment, worked out the same way the fixture built
// it — so the assertions above compare against the file, not against the
// parser being tested.
function offsetOfFragment(buf, init, n) {
	let off = init.firstMoof;
	for (let i = 0; i < n; i++) {
		const moofSize = buf.readUInt32BE(off);
		off += moofSize + buf.readUInt32BE(off + moofSize);
	}
	return off;
}

// ---- the cheap paths ----------------------------------------------------

// These carry the real load. Measured against an av300 over HTTP, one range
// request costs 32-50 ms, so a full walk of a 20-minute clip is ~1100 requests
// and about 55 seconds. Far too much to spend opening a clip — so the page
// asks these two instead, and only pays for a walk over the span an export
// actually needs.
function runCheap() {
	group('durationHint — how long is this clip, in two reads');

	const n = 250;
	// The write counter drifts from the fragment ordinal on a real camera, so
	// the pre-tfdt fixture drifts too — otherwise the fallback would look far
	// better here than it is on hardware.
	const seqs = [];
	for (let i = 0, k = 0; i < n; i++) { seqs.push(k); k += (i % 4 === 0) ? 2 : 1; }

	const withT = clip(1000000, evenSpecs(n, { seqs: seqs }));
	const initT = M.parseInit(u8of(withT));
	const log = [];

	return M.durationHint(readerFor(withT, log), withT.length, initT).then(h => {
		check('costs exactly two reads, whatever the clip length',
			log.length === 2, 'reads: ' + log.length);
		check('reports how long one fragment lasts', h.perFragment === 1,
			'perFragment ' + h.perFragment);
		// tfdt says where the last fragment starts and trun how long it runs,
		// so the two together are the length — not an estimate of it.
		check('is exact when the fragments carry tfdt', h.seconds === n,
			'got ' + h.seconds + ' want ' + n);
		check('and does not claim to be approximate', h.approximate === false);

		const old = clip(1000000, evenSpecs(n, { seqs: seqs }), false);
		return M.durationHint(readerFor(old), old.length, M.parseInit(u8of(old)));
	}).then(h => {
		check('a pre-tfdt recording still gets an answer', h.seconds > 0);
		check('but says it is approximate', h.approximate === true);
		check('and it really is wrong, because the write counter drifts',
			h.seconds !== n, 'got ' + h.seconds + ' — suspiciously exact');
		return null;
	}).then(runLiveTail).then(runLocateExact).then(runBigFragments).then(runSpan);
}

// A clip still being recorded ends with a fragment whose moof is on the card
// and whose mdat is not. Counting it would put footage on the timeline that
// cannot be played or exported — and the cheap probe must not be more
// optimistic than the exact walk, which already refuses it.
function runLiveTail() {
	group('durationHint on a clip that is still being written');

	const whole = clip(1000000, evenSpecs(8));
	const init = M.parseInit(u8of(whole));
	// lop the payload off the last fragment, leaving its header behind
	const partial = whole.subarray(0, whole.length - 20000);

	return M.durationHint(readerFor(partial), partial.length, init).then(h => {
		check('stops at the last fragment that is completely on the card',
			h !== null && h.seconds === 7, 'got ' + (h && h.seconds) + ' want 7');
		check('and still reports that as exact — it is measured, just shorter',
			h.approximate === false);

		return M.buildIndex(readerFor(partial), partial.length, init);
	}).then(idx => {
		check('which is exactly what the full walk says too',
			idx.duration === 7, 'walk says ' + idx.duration);
	});
}

function runLocateExact() {
	group('locate — finding the byte for a moment');

	const n = 400;
	const sizes = [];
	for (let i = 0; i < n; i++) sizes.push(20000 + (i % 7) * 9000);
	const buf = clip(1000000, evenSpecs(n, { sizes: sizes }));
	const init = M.parseInit(u8of(buf));
	const log = [];
	const read = readerFor(buf, log);

	return M.buildIndex(read, buf.length, init).then(full => {
		log.length = 0;
		return M.locate(read, buf.length, init, 300, 1).then(hit => {
			const exact = M.fragmentAt(full, 300);
			check('lands on exactly the fragment holding that second',
				hit.off === exact.off, 'off ' + hit.off + ' want ' + exact.off);
			check('and reports that fragment\'s real start time',
				hit.approxSec === exact.t, hit.approxSec + ' vs ' + exact.t);
			check('and says the answer is exact', hit.exact === true);
			check('without walking the file', log.length < 20, 'reads: ' + log.length);
		}).then(() => M.locate(read, buf.length, init, 300.4, 1)).then(hit => {
			// never overshoot: starting after the moment asked for reads as the
			// seek having been ignored, where a moment early is just lead-in
			check('a moment mid-fragment lands on that fragment, not the next',
				hit.approxSec === 300, 'got ' + hit.approxSec);
		}).then(() => M.locate(read, buf.length, init, 0, 1)).then(hit => {
			check('seeking to zero returns the first fragment',
				hit.off === init.firstMoof, 'got ' + hit.off);
		});
	}).then(() => {
		const old = clip(1000000, evenSpecs(400, { sizes: sizes }), false);
		const oi = M.parseInit(u8of(old));
		return M.locate(readerFor(old), old.length, oi, 300, 1).then(hit => {
			check('a pre-tfdt recording still resolves to a fragment', hit.off > 0);
			check('but does not claim to be exact', hit.exact === false);
		});
	});
}

// The window a probe reads only answers if a moof falls inside it, and a
// fragment is not a fixed size: 730 KB on one clip from an av300, 1.1 MB on the
// next from the same camera at a higher bitrate. A window sized from a sample
// silently contains no boundary at all, and every lookup built on it returns
// nothing — which is exactly what happened before the window learned to widen.
function runBigFragments() {
	group('fragments wider than the probe window');

	// 1.2 MB of payload each, comfortably past the 768 KB starting window
	const specs = evenSpecs(6);
	specs.forEach(f => { f.payload = 1200000; });
	const buf = clip(1000000, specs);
	const init = M.parseInit(u8of(buf));
	const log = [];
	const read = readerFor(buf, log);

	return M.buildIndex(read, buf.length, init).then(full => {
		check('the fixture really is wider than the starting window',
			full.fragments[0].len > 768 * 1024, 'len ' + full.fragments[0].len);

		log.length = 0;
		return M.durationHint(read, buf.length, init).then(h => {
			check('durationHint still finds the last fragment',
				h !== null && h.seconds === 6, 'got ' + (h && h.seconds));
			check('and still reports it as exact', h && h.approximate === false);
			check('paying only a couple of extra reads to widen',
				log.length <= 5, 'reads: ' + log.length);
		});
	}).then(() => {
		return M.buildIndex(read, buf.length, init).then(full => {
			log.length = 0;
			return M.locate(read, buf.length, init, 3, 1).then(hit => {
				const exact = M.fragmentAt(full, 3);
				check('locate finds the fragment despite the narrow first window',
					hit.off === exact.off, 'off ' + hit.off + ' want ' + exact.off);
				check('and it is still exact', hit.exact === true);
			});
		});
	});
}

function runSpan() {
	group('spanFrom — index only what is being exported');

	const buf = clip(1000000, evenSpecs(300));
	const init = M.parseInit(u8of(buf));
	const log = [];
	const read = readerFor(buf, log);

	return M.buildIndex(read, buf.length, init).then(full => {
		const at100 = M.fragmentAt(full, 100);
		log.length = 0;
		return M.spanFrom(read, buf.length, init, at100.off, 10).then(span => {
			check('covers the seconds asked for', span.duration >= 10,
				'got ' + span.duration);
			check('and does not run far past them', span.duration <= 11,
				'got ' + span.duration);
			check('costs reads proportional to the span, not the clip',
				log.length <= 12, 'reads: ' + log.length + ' for 10 s of a 300 s clip');
			check('starts exactly where it was pointed',
				span.fragments[0].off === at100.off);
			check('carries the header length so exportRanges can use it',
				span.headerLength === init.headerLength);

			const r = M.exportRanges(span, 0, span.duration);
			check('the span exports as a whole from its own first fragment',
				r.body.start === at100.off);
			check('and ends on a fragment boundary',
				r.body.end === span.fragments[span.fragments.length - 1].off +
					span.fragments[span.fragments.length - 1].len);
			// byte-for-byte agreement with what a full index would have said
			const fullR = M.exportRanges(full, 100, 100 + span.duration);
			check('agrees byte-for-byte with a full-clip index',
				fullR.body.start === r.body.start && fullR.body.end === r.body.end,
				fullR.body.start + '..' + fullR.body.end + ' vs ' + r.body.start + '..' + r.body.end);
		});
	}).then(() => {
		// asking for more than is left must stop at the end, not spin
		const b3 = clip(1000000, evenSpecs(5));
		const i3 = M.parseInit(u8of(b3));
		return M.spanFrom(readerFor(b3), b3.length, i3, i3.firstMoof, 9999).then(span => {
			check('a span running past the end stops at the last whole fragment',
				span.fragments.length === 5 && span.duration === 5,
				span.fragments.length + '/' + span.duration);
		});
	});
}
