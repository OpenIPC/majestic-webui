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
function trun(durations) {
	const per = Buffer.alloc(durations.length * 8);
	durations.forEach((d, i) => {
		per.writeUInt32BE(d >>> 0, i * 8);
		per.writeUInt32BE(1000, i * 8 + 4);   // sample size, unused here
	});
	return box('trun', Buffer.concat([u32(0x000305, durations.length, 0, 0x02000000), per]));
}
function tfhdPlain() { return box('tfhd', u32(0x020030, 1)); }
function tfhdDefaultDuration(d) {
	// flags 0x08 = default_sample_duration_present
	return box('tfhd', u32(0x000008, 1, d));
}

function moof(seq, tfhdBox, trunBox) {
	const mfhd = box('mfhd', u32(0, seq));
	return box('moof', Buffer.concat([mfhd, box('traf', Buffer.concat([tfhdBox, trunBox]))]));
}
function mdat(len, fill) {
	const p = Buffer.alloc(Math.max(0, len - 8), fill === undefined ? 0x41 : fill);
	return box('mdat', p);
}

// A whole clip. `specs` is one entry per fragment:
//   { seq, durations:[ticks…], payload:bytes, defaultDur? }
function clip(timescale, specs) {
	const parts = [ftyp(), moov(timescale)];
	specs.forEach(s => {
		const tf = s.defaultDur ? tfhdDefaultDuration(s.defaultDur) : tfhdPlain();
		const tr = s.defaultDur
			? box('trun', u32(0x000005, s.count, 0, 0x02000000))   // no per-sample durations
			: trun(s.durations);
		parts.push(moof(s.seq, tf, tr));
		parts.push(mdat(s.payload, s.fill));
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
	}).then(runExport).then(runCheap).then(() => done());
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

// ---- the cheap paths ----------------------------------------------------

// These carry the real load. Measured against an av300 over HTTP, one range
// request costs 32-50 ms, so a full walk of a 20-minute clip is ~1100 requests
// and about 55 seconds. Far too much to spend opening a clip — so the page
// asks these two instead, and only pays for a walk over the span an export
// actually needs.
function runCheap() {
	group('durationHint — how long is this clip, in two reads');

	const n = 250;
	const seqs = [];
	for (let i = 0, s = 0; i < n; i++) { seqs.push(s); if (i !== 5) s++; }
	const buf = clip(1000000, evenSpecs(n, { seqs: seqs }));
	const init = M.parseInit(u8of(buf));
	const log = [];
	const read = readerFor(buf, log);

	return M.durationHint(read, buf.length, init).then(h => {
		check('costs exactly two reads, whatever the clip length',
			log.length === 2, 'reads: ' + log.length);
		check('reports how long one fragment lasts', h.perFragment === 1,
			'perFragment ' + h.perFragment);
		// one plateau in the sequence numbers, so it reads one second short
		check('lands within a fragment of the true length',
			Math.abs(h.seconds - n) <= 2, 'got ' + h.seconds + ' want ~' + n);
		check('and says it is approximate', h.approximate === true);
		check('never over-reports — a hint that runs past the end would let the '
			+ 'timeline offer footage that is not there', h.seconds <= n);

		const tiny = clip(1000000, evenSpecs(1));
		return M.durationHint(readerFor(tiny), tiny.length, M.parseInit(u8of(tiny)));
	}).then(h => {
		check('a single-fragment clip is one fragment long', h.seconds === 1, 'got ' + h.seconds);

		group('spanFrom — index only what is being exported');

		const specs = evenSpecs(300);
		const b2 = clip(1000000, specs);
		const i2 = M.parseInit(u8of(b2));
		const l2 = [];
		const r2 = readerFor(b2, l2);

		// walk the whole thing once to learn where second 100 really starts
		return M.buildIndex(r2, b2.length, i2).then(full => {
			const at100 = M.fragmentAt(full, 100);
			l2.length = 0;
			return M.spanFrom(r2, b2.length, i2, at100.off, 10).then(span => {
				check('covers the seconds asked for', span.duration >= 10,
					'got ' + span.duration);
				check('and does not run far past them', span.duration <= 11,
					'got ' + span.duration);
				check('costs reads proportional to the span, not the clip',
					l2.length <= 12, 'reads: ' + l2.length + ' for 10 s of a 300 s clip');
				check('starts exactly where it was pointed',
					span.fragments[0].off === at100.off);
				check('carries the header length so exportRanges can use it',
					span.headerLength === i2.headerLength);

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
	});
}
