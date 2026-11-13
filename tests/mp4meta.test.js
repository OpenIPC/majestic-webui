// Taking the analytics metadata track back out of a recording.
//
// The property under test is identity, not plausibility: a fragment built
// WITH the track, stripped, must equal byte for byte the same fragment built
// WITHOUT it. Anything less and the question becomes "does it look right",
// which for a container is a question nobody can answer by eye — the camera's
// own probe found a malformed duration that Chrome played happily and Safari
// refused outright.
//
// The fixtures are built here rather than carried as files. A binary in a
// repository of plain JS is a thing nobody can read or adjust, and the shapes
// that matter are small: an init segment with one or two tracks, and a
// fragment with one or two trafs.
'use strict';

const path = require('path');
const { check, group, done } = require('./assert');

const M = require(path.join(__dirname, '..', 'www', 'a', 'mp4meta.js'));

// ---- a tiny box builder -------------------------------------------------

const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const str = (s) => Array.from(s, (c) => c.charCodeAt(0));
const box = (kind, ...parts) => {
	const body = [].concat(...parts);
	return [...u32(body.length + 8), ...str(kind), ...body];
};
const zeros = (n) => new Array(n).fill(0);

// tkhd v0 far enough to carry the track_ID, then padding to a realistic size.
const tkhd = (id) => box('tkhd', zeros(4), zeros(4), zeros(4), u32(id), zeros(60));
const trak = (id, handler) => box('trak', tkhd(id),
	box('mdia', box('hdlr', zeros(8), str(handler), zeros(12)), box('minf', zeros(8))));
const trex = (id) => box('trex', zeros(4), u32(id), u32(1), zeros(12));

const init = (withMeta) => new Uint8Array([
	...box('ftyp', str('isom'), zeros(8)),
	...box('moov',
		box('mvhd', zeros(100)),
		trak(1, 'vide'),
		...(withMeta ? [trak(3, 'meta')] : []),
		box('mvex', trex(1), ...(withMeta ? [trex(3)] : []))),
]);

// tfhd carrying default-base-is-moof and the track_ID; trun with a data
// offset and one sample.
const tfhd = (id) => box('tfhd', [0, 0x02, 0x00, 0x00], u32(id));
const trun = (dataOffset, size) => box('trun',
	[0, 0x00, 0x02, 0x01],       // data-offset-present | sample-size-present
	u32(1), u32(dataOffset), u32(size));

function fragment(withMeta, videoBytes, metaBytes) {
	// Built twice: once to learn the moof's size, then again with the data
	// offsets that size implies. Exactly what a muxer has to do, and the
	// reason the stripper has to fix them on the way back out.
	const build = (moofLen) => {
		const trafs = [box('traf', tfhd(1), trun(moofLen + 8, videoBytes.length))];
		if (withMeta)
			trafs.push(box('traf', tfhd(3),
				trun(moofLen + 8 + videoBytes.length, metaBytes.length)));
		return box('moof', box('mfhd', zeros(8)), ...trafs);
	};
	const moof = build(build(0).length);
	const payload = withMeta ? [...videoBytes, ...metaBytes] : [...videoBytes];
	return new Uint8Array([...moof, ...box('mdat', payload)]);
}

const VIDEO = Array.from({ length: 120 }, (_, i) => (i * 7) & 255);
const META = str('{"s":0,"n":1,"r":[[10,20,30,40,0,0]]}');

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

group('an init segment with the track stripped is the one without it');
{
	const withMeta = init(true);
	const without = init(false);
	check('the two differ to begin with', !same(withMeta, without));
	check('and are identical after stripping',
		same(M.stripInit(withMeta), without));
}

group('a fragment with the track stripped is the one without it');
{
	// This is where data_offset lives, and where getting it wrong is
	// invisible: the video bytes are still there, still the right length, and
	// the player reads them from the wrong place.
	const withMeta = fragment(true, VIDEO, META);
	const without = fragment(false, VIDEO, META);
	check('the two differ to begin with', !same(withMeta, without));
	check('and are identical after stripping',
		same(M.stripFragment(withMeta), without));
}

group('next_track_ID is left alone, and that is deliberate');
{
	// It only has to EXCEED every track_ID in use, so a value left high after
	// a track is removed is legal. Lowering it would be the wrong kind of
	// tidy: majestic writes 4 whether or not the metadata track is present,
	// so a stripper that recomputed it would produce a file that differs from
	// one the camera wrote without the track — the opposite of the point.
	//
	// Verified against real recordings: with this left alone, an injected
	// fixture stripped back comes out byte-identical to the original in every
	// one of 541 fragments across two recordings, and in the init but for
	// this single field, which the older writers of those two files had set
	// to 2.
	const mv = (id) => box('mvhd', zeros(92), u32(id));
	const mk = (withMeta) => new Uint8Array([
		...box('ftyp', str('isom'), zeros(8)),
		...box('moov', mv(4), trak(1, 'vide'),
			...(withMeta ? [trak(3, 'meta')] : []),
			box('mvex', trex(1), ...(withMeta ? [trex(3)] : []))),
	]);
	const stripped = M.stripInit(mk(true));
	check('still says 4', same(stripped, mk(false)));
}

group('an ordinary recording is handed back untouched');
{
	// Every clip written before this feature existed, and every clip written
	// with it turned off. The player calls this unconditionally, so the
	// common case has to cost one walk and no copy.
	const plainInit = init(false);
	const plainFrag = fragment(false, VIDEO, META);
	check('init is the same object', M.stripInit(plainInit) === plainInit);
	check('fragment is the same object',
		M.stripFragment(plainFrag) === plainFrag);
}

group('nothing it does not recognise is edited');
{
	const truncated = fragment(true, VIDEO, META).subarray(0, 40);
	check('a fragment cut short is returned as-is',
		M.stripFragment(truncated) === truncated);

	const garbage = new Uint8Array([0, 0, 0, 4, 0, 0, 0, 0]);
	check('a box whose size cannot be right is left alone',
		M.stripFragment(garbage) === garbage);
	check('and so is an init like it', M.stripInit(garbage) === garbage);
}

group('a metadata traf anywhere but last is refused rather than guessed at');
{
	// The camera writes it last, and the stripper's cheapness depends on
	// that: both removals are truncations. A file that puts it elsewhere is
	// one this code did not write, and editing it on the assumption that it
	// did is how a player corrupts video it could have simply refused.
	const moofLen = 8 + 16 + 24 + 32;
	const odd = new Uint8Array([
		...box('moof', box('mfhd', zeros(8)),
			box('traf', tfhd(3), trun(moofLen + 8, META.length)),
			box('traf', tfhd(1), trun(moofLen + 8 + META.length, VIDEO.length))),
		...box('mdat', [...META, ...VIDEO]),
	]);
	check('left exactly as found', M.stripFragment(odd) === odd);
}

done();
