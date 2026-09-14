// Take the analytics metadata track back out of a recording, for the player.
//
// The camera can write detection boxes into its recordings as an ISO/IEC
// 14496-12 timed metadata track, which is what lets a CV application or an
// offline tool read them straight out of the file. This page cannot simply
// hand such a file to MediaSource, because one browser refuses it:
//
//   Safari 26.6.1 (macOS 15) rejects a metadata track alongside H.264 with
//   MEDIA_ERR_DECODE at t=0, and accepts the identical track alongside
//   H.265. Safari on macOS 14 accepts both. Chrome accepts everything.
//
// That is measured, not inferred: every fixture was played in real Safari on
// both macOS versions, paired against the same recording WITHOUT the track, so
// each result has its own control. A synthetic H.265 clip from the same
// ffmpeg invocation as the H.264 one passes where the H.264 fails, which is
// what pins the fault to the codec rather than to the file's provenance.
// majestic records H.264 by default on most cameras, so this is not a corner.
//
// So the player removes the track on the way in. The file keeps it — that is
// the whole point of storing it — and the picture plays everywhere.
//
// WHY THIS IS CHEAP, and it is a property of how the camera lays the file
// out rather than a happy accident: the metadata traf is written LAST in the
// moof and its samples go at the TAIL of the mdat. So removing it is two
// truncations at the ends of two boxes, not surgery in the middle of either.
// No byte of video moves.
(function () {
	'use strict';

	// The camera's metadata track. Fixed rather than discovered: track_ID 3
	// is what majestic writes (video is 1, audio 2), and a player that went
	// looking for "whichever track has a meta handler" would also find the
	// MetaBox under udta, which is a different box that shares the spelling.
	const META_TRACK_ID = 3;

	function be32(u8, i) {
		return (u8[i] << 24 | u8[i + 1] << 16 | u8[i + 2] << 8 | u8[i + 3]) >>> 0;
	}
	function wr32(u8, i, v) {
		u8[i] = (v >>> 24) & 255; u8[i + 1] = (v >>> 16) & 255;
		u8[i + 2] = (v >>> 8) & 255; u8[i + 3] = v & 255;
	}
	function fourcc(u8, i) {
		return String.fromCharCode(u8[i], u8[i + 1], u8[i + 2], u8[i + 3]);
	}

	// Immediate children of a container as [type, start, end]. Returns null
	// rather than a partial list on a malformed size: a caller that acted on
	// half a walk would be editing a file it had not understood.
	function children(u8, from, end) {
		const out = [];
		let off = from;
		while (off + 8 <= end) {
			const size = be32(u8, off);
			if (size < 8 || off + size > end) return null;
			out.push([fourcc(u8, off + 4), off, off + size]);
			off += size;
		}
		return out;
	}

	function child(u8, from, end, type) {
		const kids = children(u8, from, end);
		if (!kids) return null;
		for (const k of kids) if (k[0] === type) return k;
		return null;
	}

	// The track_ID a traf is for, from its tfhd. Every tfhd carries it and it
	// is the first field after the FullBox header, so this needs no flags.
	function trafTrackId(u8, trafStart, trafEnd) {
		const tfhd = child(u8, trafStart + 8, trafEnd, 'tfhd');
		if (!tfhd || tfhd[1] + 16 > tfhd[2]) return null;
		return be32(u8, tfhd[1] + 12);
	}

	// ---- the init segment -------------------------------------------------

	// Drop the metadata track's trak and its trex. Returns the original array
	// untouched when there is nothing to drop, so a caller can use this
	// unconditionally and an ordinary recording pays one walk.
	function stripInit(u8) {
		const moov = child(u8, 0, u8.length, 'moov');
		if (!moov) return u8;

		const kids = children(u8, moov[1] + 8, moov[2]);
		if (!kids) return u8;

		let trak = null;
		for (const k of kids) {
			if (k[0] !== 'trak') continue;
			const tkhd = child(u8, k[1] + 8, k[2], 'tkhd');
			if (!tkhd || tkhd[1] + 13 > tkhd[2]) continue;
			// After the 8-byte box header and the 4-byte version/flags come
			// creation and modification times, 32 bits each in a version-0
			// tkhd and 64 in a version 1, and then the track id. majestic
			// writes version 0, but this reads whatever it is handed and
			// mp4crypt.js already carries both offsets — a stripper that
			// assumed version 0 would miss the trak on a version-1 header
			// while still finding its trex by track id, and hand MediaSource
			// an init segment declaring half a track.
			const v1 = u8[tkhd[1] + 8] === 1;
			const idAt = tkhd[1] + (v1 ? 28 : 20);
			if (idAt + 4 > tkhd[2]) continue;
			if (be32(u8, idAt) === META_TRACK_ID) { trak = k; break; }
		}

		const mvex = child(u8, moov[1] + 8, moov[2], 'mvex');
		let trex = null;
		if (mvex) {
			const tk = children(u8, mvex[1] + 8, mvex[2]) || [];
			for (const k of tk)
				if (k[0] === 'trex' && k[1] + 16 <= k[2] &&
					be32(u8, k[1] + 12) === META_TRACK_ID) { trex = k; break; }
		}

		if (!trak && !trex) return u8;

		// Copied around the two holes rather than memmoved in place: the
		// caller's buffer may be a view on a larger fetch, and editing it
		// would corrupt whatever else is looking at those bytes.
		const cut = [];
		if (trak) cut.push(trak);
		if (trex) cut.push(trex);
		cut.sort((a, b) => a[1] - b[1]);

		const dropped = cut.reduce((n, c) => n + (c[2] - c[1]), 0);
		const out = new Uint8Array(u8.length - dropped);
		let w = 0, r = 0;
		for (const c of cut) {
			out.set(u8.subarray(r, c[1]), w);
			w += c[1] - r;
			r = c[2];
		}
		out.set(u8.subarray(r), w);

		// Sizes patched from offsets worked out on the ORIGINAL, not by
		// walking the copy. Walking the copy cannot work: its size fields are
		// still the old ones until they are patched, so mvex claims more
		// bytes than remain and the walk that would find it refuses the box
		// as overrunning its parent — leaving the very field being looked for
		// unpatched, silently.
		//
		// Nothing precedes moov that was removed, so it has not moved. mvex
		// has moved by the trak ahead of it, if that is where the trak was.
		wr32(out, moov[1], (moov[2] - moov[1]) - dropped);
		if (mvex && trex) {
			const shift = (trak && trak[1] < mvex[1]) ? (trak[2] - trak[1]) : 0;
			wr32(out, mvex[1] - shift,
				(mvex[2] - mvex[1]) - (trex[2] - trex[1]));
		}
		return out;
	}

	// ---- one fragment -----------------------------------------------------

	// Drop the metadata traf and the bytes its trun points at.
	//
	// The traf is last in the moof and its samples are last in the mdat, so
	// both removals are truncations. data_offset is relative to the start of
	// the moof (tfhd's default-base-is-moof), so every surviving trun has to
	// come back by the length of the traf that went — the mdat moved towards
	// them by exactly that much.
	function stripFragment(u8) {
		const kids = children(u8, 0, u8.length);
		if (!kids) return u8;

		let moof = null, mdat = null;
		for (const k of kids) {
			if (k[0] === 'moof') moof = k;
			else if (k[0] === 'mdat') mdat = k;
		}
		if (!moof || !mdat || mdat[1] < moof[2]) return u8;

		const trafs = children(u8, moof[1] + 8, moof[2]);
		if (!trafs) return u8;

		let meta = null;
		for (const t of trafs)
			if (t[0] === 'traf' && trafTrackId(u8, t[1], t[2]) === META_TRACK_ID)
				meta = t;
		if (!meta) return u8;
		// Only ever the last box in the moof. Anything else is a file this
		// code did not write and must not guess at.
		if (meta[2] !== moof[2]) return u8;

		// How many bytes of mdat the metadata samples occupy: everything from
		// where its trun points to the end of the mdat.
		const trun = child(u8, meta[1] + 8, meta[2], 'trun');
		if (!trun || trun[1] + 20 > trun[2]) return u8;
		const trunFlags = be32(u8, trun[1] + 8) & 0xffffff;
		if (!(trunFlags & 0x000001)) return u8;   // no data offset: not ours
		const metaAt = moof[1] + (be32(u8, trun[1] + 16) | 0);
		if (metaAt < mdat[1] + 8 || metaAt > mdat[2]) return u8;

		const trafLen = meta[2] - meta[1];
		const sampleLen = mdat[2] - metaAt;

		const out = new Uint8Array(u8.length - trafLen - sampleLen);
		// [ .. moof without its last traf ][ mdat without its tail ][ rest ]
		out.set(u8.subarray(0, meta[1]), 0);
		let w = meta[1];
		out.set(u8.subarray(moof[2], metaAt), w);
		w += metaAt - moof[2];
		out.set(u8.subarray(mdat[2]), w);

		wr32(out, moof[1], (moof[2] - moof[1]) - trafLen);
		const mdatAt = mdat[1] - trafLen;
		wr32(out, mdatAt, (mdat[2] - mdat[1]) - sampleLen);

		// Every surviving trun's data_offset, less the traf that went.
		const left = children(out, moof[1] + 8, moof[2] - trafLen) || [];
		for (const t of left) {
			if (t[0] !== 'traf') continue;
			const tr = child(out, t[1] + 8, t[2], 'trun');
			if (!tr || tr[1] + 20 > tr[2]) continue;
			if (!((be32(out, tr[1] + 8) & 0xffffff) & 0x000001)) continue;
			wr32(out, tr[1] + 16, (be32(out, tr[1] + 16) | 0) - trafLen);
		}
		return out;
	}

	const api = { stripInit: stripInit, stripFragment: stripFragment,
		META_TRACK_ID: META_TRACK_ID };
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticMp4Meta = api;
})();
