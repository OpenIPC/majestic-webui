// Byte<->time for the fragmented MP4s majestic records to the SD card.
//
// Why this file exists at all: the clips are fragmented MP4 — ftyp, moov, then
// a moof+mdat pair per GOP — with no random-access index over the file as a
// whole. There is no `sidx` and no `mfra`/`mfro` trailer, so nothing says which
// byte a given second starts at; that has to be recovered from outside.
//
// Each fragment does state its own start, in tfdt, and everything here is built
// on that.
//
// DEPRECATED FALLBACK, REMOVE AFTER 2029-01: recordings written before majestic
// wrote tfdt have only mfhd.sequence_number to go on, which counts writes rather
// than fragments — it ran 71 ahead over 300 fragments on an av300 — so on those
// files a lookup can only be approximate, and says so through `approximate` on
// durationHint and `exact` on locate. Cameras write tfdt now, so this is only
// for clips already on cards when that shipped; once those have rotated away,
// drop the seq branches and let both simply require tfdt.
//
// Everything here is therefore about recovering that index from outside the
// file, over HTTP Range — which majestic does serve properly (206 with
// Content-Range, sendfile) for an authenticated request.
//
// WHAT IT COSTS decides which route the page takes. Measured against an
// hi3516av300: one range request is 32-50 ms whether it asks for 256 bytes or
// 256 KiB, and a bulk read runs at ~10 MiB/s. So the price of an answer is the
// number of REQUESTS, not the bytes. A 20-minute clip holds ~1100 fragments,
// which makes a full walk ~55 seconds — far too much to spend opening a clip.
// Hence four routes, and the page uses the cheapest that answers its question:
//
//   durationHint()  how long is this clip?          2 requests
//   locate()        which byte is second N at?      ~10 requests
//   spanFrom()      index just this selection       ~1 per second exported
//   buildIndex()    index the whole clip, exactly   ~1 per second of clip
//
// buildIndex is the reference the other three are measured against — the tests
// assert that spanFrom agrees with it byte-for-byte — but nothing on the page's
// hot path calls it.
//
// No dependencies: it is handed a `read(start, endInclusive) -> Promise<u8>`
// rather than calling fetch itself, so the whole module is exercised against a
// synthetic file in tests/mp4index.test.js without a network or a camera.
window.MajesticMp4Index = (function () {
	'use strict';

	// One walk step needs the whole moof plus the 8-byte mdat header behind it.
	// A video-only moof is 260 bytes (240 before tfdt was added), and a second
	// traf for audio roughly doubles it. 1 KiB covers both with room to spare,
	// and costs nothing worth counting: a range request is 32-50 ms whether it
	// asks for 256 bytes or 256 KiB, so the only thing to optimise is the
	// number of requests — one per fragment, never two. parseFragment() reports
	// a short read rather than guessing, so being wrong here is slow, not
	// incorrect.
	const STEP = 1024;
	// Widest fragment seen on an av300 at 4K/20fps is ~730 KB; a probe window
	// has to be wide enough that a moof is certain to fall inside it.
	const PROBE = 768 * 1024;

	function be32(u8, i) {
		return (u8[i] << 24 | u8[i + 1] << 16 | u8[i + 2] << 8 | u8[i + 3]) >>> 0;
	}
	function fourcc(u8, i) {
		return String.fromCharCode(u8[i], u8[i + 1], u8[i + 2], u8[i + 3]);
	}

	// Walk the box list at `from`, returning [offset, end] of the first child of
	// type `type`, or null. Bounded by `end` so a nested walk cannot run past its
	// parent into a sibling.
	function findBox(u8, from, end, type) {
		let off = from;
		while (off + 8 <= end) {
			const size = be32(u8, off);
			if (size < 8 || off + size > end) return null;
			if (fourcc(u8, off + 4) === type) return [off, off + size];
			off += size;
		}
		return null;
	}

	// Descend a path of box types from `from`, e.g. ['moov','trak','mdia','mdhd'].
	// Containers carry no fields of their own, so every step starts 8 bytes in.
	function descend(u8, from, end, path) {
		let a = from, b = end;
		for (let i = 0; i < path.length; i++) {
			const box = findBox(u8, a, b, path[i]);
			if (!box) return null;
			a = box[0] + 8;
			b = box[1];
		}
		return [a, b];
	}

	// ---- init segment ----------------------------------------------------

	// Everything before the first moof: ftyp + moov. That byte range IS the init
	// segment — prepend it to any run of fragments and the result is a playable
	// file, which is what makes clip export a byte concatenation rather than a
	// re-encode.
	//
	// timescale comes from the media header of the first track. Fragment
	// durations in trun are in those ticks, so without it a walk can count
	// fragments but not seconds.
	function parseInit(u8) {
		const moov = findBox(u8, 0, u8.length, 'moov');
		if (!moov) return null;

		// The first moof starts where moov ends — unless the file is truncated
		// mid-header, in which case there is nothing to index yet.
		const firstMoof = moov[1];
		let timescale = 0;
		const mdhd = descend(u8, moov[0] + 8, moov[1], ['trak', 'mdia', 'mdhd']);
		if (mdhd) {
			// mdhd: version(1) flags(3), then times. v0 has 32-bit creation and
			// modification before timescale, v1 has 64-bit.
			const v = u8[mdhd[0]];
			timescale = be32(u8, mdhd[0] + (v === 1 ? 20 : 12));
		}
		return {
			firstMoof: firstMoof,
			headerLength: firstMoof,
			timescale: timescale || 0,
		};
	}

	// ---- fragments -------------------------------------------------------

	// mfhd is required to be moof's first child, and its sequence_number sits at
	// a fixed offset. Verified rather than assumed: a file that puts something
	// else first reports null and the caller falls back to the exact walk.
	//
	// CAVEAT, and it is the reason locate() is only ever an approximation:
	// majestic's sequence_number is monotonic but NOT strictly increasing — a
	// walk over a real clip saw 0, 1, 2, 2, 3, 4 at consecutive moofs, where
	// ISO 14496-12 wants strictly increasing. Binary search tolerates a plateau
	// (it only needs monotonicity), but the value cannot be trusted as an exact
	// fragment ordinal, so exact times come from the walk instead.
	function moofSeq(u8, at) {
		if (at + 24 > u8.length) return null;
		if (fourcc(u8, at + 4) !== 'moof') return null;
		if (fourcc(u8, at + 12) !== 'mfhd') return null;
		return be32(u8, at + 20);
	}

	// baseMediaDecodeTime — where this fragment starts, in timescale ticks.
	//
	// This is the only field in the file that maps a fragment to a time
	// honestly, which makes it what every lookup here is built on. Recordings
	// written before majestic wrote the box have to fall back on
	// mfhd.sequence_number, and the difference is not subtle: seq counts
	// writes rather than fragments, running 71 ahead over 300 fragments on an
	// av300, so a seek aimed by it landed about six seconds out.
	function fragDecodeTicks(u8, moofAt, moofEnd) {
		const traf = findBox(u8, moofAt + 8, moofEnd, 'traf');
		if (!traf) return null;
		const tfdt = findBox(u8, traf[0] + 8, traf[1], 'tfdt');
		if (!tfdt) return null;
		const version = u8[tfdt[0] + 8];
		const at = tfdt[0] + 12;
		if (version === 1) {
			if (at + 8 > tfdt[1]) return null;
			// Safe as a Number: a microsecond timescale needs 2^53 ticks to
			// overflow, which is a few hundred years of recording.
			return be32(u8, at) * 4294967296 + be32(u8, at + 4);
		}
		if (at + 4 > tfdt[1]) return null;
		return be32(u8, at);
	}

	// Sum the sample durations of a fragment, in timescale ticks.
	//
	// trun carries them per sample when flag 0x100 is set, which is what
	// majestic writes; the fallback is tfhd's default_sample_duration (flag
	// 0x08) times the sample count, which is the other legal way to say it.
	function fragDurationTicks(u8, moofAt, moofEnd) {
		const traf = findBox(u8, moofAt + 8, moofEnd, 'traf');
		if (!traf) return null;

		let defDur = 0;
		const tfhd = findBox(u8, traf[0] + 8, traf[1], 'tfhd');
		if (tfhd) {
			const flags = be32(u8, tfhd[0] + 8) & 0xffffff;
			// track_ID(4), then the optional fields in flag order
			let p = tfhd[0] + 16;
			if (flags & 0x01) p += 8;   // base_data_offset
			if (flags & 0x02) p += 4;   // sample_description_index
			if (flags & 0x08) { defDur = be32(u8, p); }
		}

		const trun = findBox(u8, traf[0] + 8, traf[1], 'trun');
		if (!trun) return null;
		const tf = be32(u8, trun[0] + 8) & 0xffffff;
		const count = be32(u8, trun[0] + 12);
		let p = trun[0] + 16;
		if (tf & 0x001) p += 4;         // data_offset
		if (tf & 0x004) p += 4;         // first_sample_flags

		if (!(tf & 0x100)) return defDur ? defDur * count : null;

		// per-sample records, in flag order; we only want the duration field
		const stride = 4
			+ ((tf & 0x200) ? 4 : 0)
			+ ((tf & 0x400) ? 4 : 0)
			+ ((tf & 0x800) ? 4 : 0);
		let total = 0;
		for (let i = 0; i < count; i++) {
			const at = p + i * stride;
			if (at + 4 > trun[1]) return null;   // truncated: refuse to guess
			total += be32(u8, at);
		}
		return total;
	}

	// One step of the chain. `u8` must start exactly at a moof and hold enough
	// of it to reach the following mdat's size field.
	function parseFragment(u8) {
		if (u8.length < 16) return null;
		const moofSize = be32(u8, 0);
		if (moofSize < 16 || fourcc(u8, 4) !== 'moof') return null;
		// Not an error — just too small a read. The caller widens and retries.
		if (moofSize + 8 > u8.length) return { short: moofSize + 8 };

		const mdatSize = be32(u8, moofSize);
		if (mdatSize < 8 || fourcc(u8, moofSize + 4) !== 'mdat') return null;

		return {
			moofSize: moofSize,
			mdatSize: mdatSize,
			total: moofSize + mdatSize,
			seq: moofSeq(u8, 0),
			decodeTicks: fragDecodeTicks(u8, 0, Math.min(moofSize, u8.length)),
			durTicks: fragDurationTicks(u8, 0, Math.min(moofSize, u8.length)),
		};
	}

	// Offset of the next moof box header at or after `from`, or -1.
	//
	// Searches for the type field and checks the size in front of it, because
	// mdat payload spells 'moof' by chance often enough to matter — a plain
	// substring search lands in the middle of a picture several times a minute.
	function findMoof(u8, from) {
		for (let i = Math.max(4, from | 0); i + 24 <= u8.length; i++) {
			if (u8[i] !== 0x6d || u8[i + 1] !== 0x6f || u8[i + 2] !== 0x6f || u8[i + 3] !== 0x66) continue;
			const at = i - 4;
			const size = be32(u8, at);
			// a moof is small and its first child must be mfhd
			if (size < 16 || size > 65536) continue;
			if (fourcc(u8, at + 12) !== 'mfhd') continue;
			return at;
		}
		return -1;
	}

	// ---- the index -------------------------------------------------------

	// Walk the whole chain. Resolves { fragments, duration, timescale }, where
	// each fragment is { off, len, t, dur } with t/dur in seconds.
	//
	// onProgress(done, total) is called with bytes, so a caller can show real
	// progress without knowing the fragment count in advance.
	function buildIndex(read, size, init, onProgress, shouldStop) {
		const frags = [];
		let off = init.firstMoof;
		let ticks = 0;
		let stopped = false;
		const ts = init.timescale || 1;

		function step() {
			if (off + 16 > size) return finish();
			// Abandoned by the caller (they opened another clip). Distinct from
			// running out of fragments: an abandoned walk is not an index and
			// must not be cached as one.
			if (shouldStop && shouldStop()) { stopped = true; return finish(); }
			const want = Math.min(STEP, size - off);
			return read(off, off + want - 1).then(function (buf) {
				let f = parseFragment(buf);
				if (f && f.short) {
					// an unusually large moof; widen once and take what we get
					const w = Math.min(f.short, size - off);
					return read(off, off + w - 1).then(function (b2) {
						return advance(parseFragment(b2));
					});
				}
				return advance(f);
			});
		}

		function advance(f) {
			// A clip still being recorded ends in a partial fragment. That is
			// not corruption — stop cleanly and report what is complete, so the
			// timeline shows footage up to the last whole second on the card.
			if (!f || f.short || !f.total) return finish();
			// The headers of that partial fragment are usually already on disk
			// while its payload is not, so the sizes parse fine and the fragment
			// looks whole. Only its extent gives it away. Counting it would put
			// a fragment on the timeline that cannot be played or exported.
			if (off + f.total > size) return finish();
			frags.push({
				off: off,
				len: f.total,
				t: ticks / ts,
				dur: (f.durTicks || 0) / ts,
				seq: f.seq,
			});
			ticks += f.durTicks || 0;
			off += f.total;
			if (onProgress) onProgress(off, size);
			return step();
		}

		function finish() {
			return {
				fragments: frags,
				duration: ticks / ts,
				timescale: init.timescale,
				headerLength: init.headerLength,
				complete: off >= size,
				stopped: stopped,
				indexedBytes: off,
			};
		}

		return Promise.resolve().then(step);
	}

	// Binary-search the file for the fragment covering `targetSec`, without a
	// walk. Approximate by construction: it reads sequence_number, which is
	// monotonic but not a reliable ordinal (see moofSeq), and it assumes
	// fragments are of roughly equal duration. Good enough to start playback
	// somewhere sensible while buildIndex() catches up; not good enough to
	// label a timeline with.
	function locate(read, size, init, targetSec, secPerFrag) {
		const per = secPerFrag > 0 ? secPerFrag : 1;
		const ts = init.timescale || 1;
		const target = Math.max(0, targetSec);

		let lo = init.firstMoof, hi = size, best = null;

		// What a probe found: its byte offset and the time it starts at.
		// Exact from tfdt; on a pre-tfdt recording, estimated from the write
		// counter, which is the whole reason `exact` is reported back.
		function timeAt(buf, i) {
			const ticks = fragDecodeTicks(buf, i, buf.length);
			if (ticks !== null) return { sec: ticks / ts, exact: true };
			const seq = moofSeq(buf, i);
			if (seq === null) return null;
			return { sec: seq * per, exact: false };
		}

		function probeAt(pos) {
			const start = Math.max(init.firstMoof, Math.min(pos, size - 1));
			const want = Math.min(PROBE, size - start);
			return read(start, start + want - 1).then(function (buf) {
				const i = findMoof(buf, 0);
				if (i < 0) return null;
				const t = timeAt(buf, i);
				return t === null ? null : { off: start + i, sec: t.sec, exact: t.exact };
			});
		}

		function loop() {
			if (hi - lo <= PROBE) return refine();
			const mid = lo + Math.floor((hi - lo) / 2);
			return probeAt(mid).then(function (p) {
				if (!p) { hi = mid; return loop(); }
				if (p.sec > target) { hi = mid; } else { lo = p.off; best = p; }
				return loop();
			});
		}

		// The search narrows to a window, not to a fragment — a window is wide
		// enough to hold several — so finish by walking it. Without this the
		// answer is only ever as precise as PROBE is wide, which is a couple of
		// seconds on a real recording and much worse on small fragments.
		function refine() {
			const start = Math.max(init.firstMoof, Math.min(lo, size - 1));
			const want = Math.min(PROBE, size - start);
			return read(start, start + want - 1).then(function (buf) {
				let at = findMoof(buf, 0);
				while (at >= 0 && at + 16 <= buf.length) {
					const t = timeAt(buf, at);
					if (t === null || t.sec > target) break;
					best = { off: start + at, sec: t.sec, exact: t.exact };
					const f = parseFragment(buf.subarray(at));
					if (!f || f.short || !f.total) break;
					at += f.total;
				}
				return settle();
			}).catch(settle);
		}

		function settle() {
			// Land at or before the moment asked for, never after it: starting
			// late reads as the seek having been ignored, where starting a
			// fragment early is just a moment of lead-in.
			if (!best) return { off: init.firstMoof, approxSec: 0, exact: false };
			return { off: best.off, approxSec: best.sec, exact: best.exact };
		}

		return Promise.resolve().then(loop);
	}

	// ---- cheap answers, for when a full walk is too expensive -------------

	// Measured against a real camera: a range request costs 32-50 ms, so
	// walking a 20-minute clip's ~1100 fragments takes about 55 seconds and
	// 1100 requests. Far too much to spend on opening a clip. These two give
	// the page what it actually needs for a fraction of that.

	// How long the clip runs, in two reads.
	//
	// The last fragment in the file states where it begins (tfdt) and how long
	// it lasts (trun), so the two together are the clip's length exactly — no
	// walk, no assumption that fragments are of equal size.
	//
	// Without tfdt there is nothing exact to read, and the answer degrades to
	// (lastSeq + 1) x fragmentDuration: sequence_number is not a fragment
	// ordinal, so that runs wrong by whatever it has drifted, and it assumes
	// every fragment is as long as the first. Flagged `approximate` so a caller
	// can say so rather than present a guess as a measurement.
	function durationHint(read, size, init) {
		const tailFrom = Math.max(init.firstMoof, size - PROBE);
		return Promise.all([
			read(init.firstMoof, init.firstMoof + STEP - 1),
			read(tailFrom, size - 1),
		]).then(function (r) {
			const first = parseFragment(r[0]);
			if (!first || first.short || !first.durTicks || !init.timescale) return null;
			const per = first.durTicks / init.timescale;

			const tail = r[1];
			let last = -1, at = 0;
			for (;;) {
				const i = findMoof(tail, at);
				if (i < 0) break;
				last = i;
				// Past this box's type field. findMoof takes the offset to start
				// looking for the *type* at, and this box's type sits at i + 4 —
				// so anything less than i + 8 finds the same box forever.
				at = i + 8;
			}
			if (last < 0) return null;

			const ticks = fragDecodeTicks(tail, last, tail.length);
			if (ticks !== null) {
				const dur = fragDurationTicks(tail, last, tail.length);
				return {
					seconds: (ticks + (dur || 0)) / init.timescale,
					perFragment: per,
					approximate: false,
				};
			}

			const seq = moofSeq(tail, last);
			if (seq === null) return null;
			return { seconds: (seq + 1) * per, perFragment: per, approximate: true };
		}).catch(function () { return null; });
	}

	// Walk forward from a known fragment boundary until `seconds` of media has
	// been covered, and no further. This is what an export needs: the cost is
	// proportional to the length of the selection, not to the length of the
	// clip — a one-minute cut is ~60 reads, not 1100.
	function spanFrom(read, size, init, startOff, seconds, onProgress) {
		const frags = [];
		let off = startOff, ticks = 0;
		const ts = init.timescale || 1;
		const want = Math.max(0, seconds);

		function step() {
			if (off + 16 > size) return finish();
			if (ticks / ts >= want && frags.length) return finish();
			return read(off, Math.min(off + STEP, size) - 1).then(function (buf) {
				const f = parseFragment(buf);
				if (f && f.short) {
					const w = Math.min(f.short, size - off);
					return read(off, off + w - 1).then(function (b2) { return advance(parseFragment(b2)); });
				}
				return advance(f);
			});
		}
		function advance(f) {
			if (!f || f.short || !f.total || off + f.total > size) return finish();
			frags.push({ off: off, len: f.total, t: ticks / ts, dur: (f.durTicks || 0) / ts, seq: f.seq });
			ticks += f.durTicks || 0;
			off += f.total;
			if (onProgress) onProgress(ticks / ts, want);
			return step();
		}
		// Same shape buildIndex returns, so exportRanges reads either one.
		function finish() {
			return {
				fragments: frags,
				duration: ticks / ts,
				headerLength: init.headerLength,
				timescale: init.timescale,
				complete: off >= size,
				stopped: false,
			};
		}
		return Promise.resolve().then(step);
	}

	// ---- export ----------------------------------------------------------

	// The byte ranges that make up a clip covering [t0, t1).
	//
	// Fragments are self-contained, so a valid playable file is literally the
	// init segment followed by whole fragments — no transcoding, no remuxing,
	// and the camera only ever sendfiles the ranges. Boundaries snap outward to
	// whole fragments, because half a fragment is not decodable.
	function exportRanges(index, t0, t1) {
		const f = index.fragments;
		if (!f || !f.length) return null;
		const a = Math.min(t0, t1), b = Math.max(t0, t1);

		let i = 0;
		while (i < f.length - 1 && f[i].t + f[i].dur <= a) i++;
		let j = i;
		while (j < f.length - 1 && f[j].t + f[j].dur < b) j++;

		const start = f[i].off;
		const end = f[j].off + f[j].len;      // exclusive
		return {
			header: { start: 0, end: index.headerLength },   // exclusive
			body: { start: start, end: end },
			from: f[i].t,
			to: f[j].t + f[j].dur,
			fragments: j - i + 1,
			bytes: index.headerLength + (end - start),
		};
	}

	// The fragment covering `sec`, for a seek once the index exists.
	function fragmentAt(index, sec) {
		const f = index.fragments;
		if (!f || !f.length) return null;
		let lo = 0, hi = f.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (f[mid].t <= sec) lo = mid; else hi = mid - 1;
		}
		return f[lo];
	}

	// ---- transport -------------------------------------------------------

	// A `read` bound to one URL. Kept out of the functions above so they stay
	// testable; apiFetch (main.js) carries the session cookie and sends a lapsed
	// session to the login page rather than failing silently.
	function reader(url) {
		return function (start, end) {
			return apiFetch(url, {
				credentials: 'same-origin',
				cache: 'no-store',
				headers: { Range: 'bytes=' + start + '-' + end },
			}).then(function (r) {
				if (!r.ok) throw new Error('range ' + start + '-' + end + ' answered ' + r.status);
				return r.arrayBuffer();
			}).then(function (b) {
				// A server that ignores Range answers 200 with the whole file.
				// Trimming keeps every parser above honest about what it got.
				const u8 = new Uint8Array(b);
				return u8.length > (end - start + 1) ? u8.subarray(0, end - start + 1) : u8;
			});
		};
	}

	return {
		parseInit: parseInit,
		parseFragment: parseFragment,
		fragDurationTicks: fragDurationTicks,
		moofSeq: moofSeq,
		findMoof: findMoof,
		findBox: findBox,
		buildIndex: buildIndex,
		durationHint: durationHint,
		spanFrom: spanFrom,
		locate: locate,
		exportRanges: exportRanges,
		fragmentAt: fragmentAt,
		reader: reader,
		STEP: STEP,
	};
})();
