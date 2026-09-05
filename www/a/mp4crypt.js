// Opening an encrypted recording: the key box, the init segment, the samples.
//
// The camera writes Common Encryption — AES-128-CTR over the samples, the real
// codec hidden behind an `encv`/`enca` sample entry, and per-fragment boxes
// saying which bytes are protected and under which initialisation vector. A
// player that is handed those bytes as they are does not fail: MediaSource
// takes the init segment, takes the fragments, and shows nothing at all. So
// everything here is about turning a clip on the card into something a browser
// will decode, and about refusing clearly when it cannot.
//
// EVERY FAILURE IN THIS FILE IS A REFUSAL, NEVER A REPAIR. A sample list that
// does not add up, a subsample run that ends past the payload, a key box a
// version too new — each one stops and says which, because the alternative is
// a picture that is subtly wrong. Decrypting most of a fragment produces
// exactly that: video that decodes, plays, and is not what the camera recorded.
// There is no error to notice afterwards, so the check has to happen here.
//
// The clip carries its own keys, wrapped, in a `pssh` at the end of `moov`.
// Three kinds of slot: a passphrase (stretched with PBKDF2, unwrapped with
// HKDF), the camera's own silicon (which nothing in a browser can open, by
// design), and the owner's public key (RSA-OAEP — the one a person can hold).
// Whatever opens it, the 48 bytes that come out are checked against the key
// check value in the box BEFORE anything is decrypted with them: a wrong key
// throws nothing, it just decrypts to noise, and noise is what gets reported
// as a broken camera.
window.MajesticMp4Crypt = (function () {
	'use strict';

	const C = window.MajesticCrypto;
	const IDX = window.MajesticMp4Index;

	// The camera's own identifiers. A `pssh` under a different system id
	// belongs to a scheme this page knows nothing about and is left alone.
	const SYSTEM_ID = '9d2c417a6e384bd1a50f3c8e217bd462';
	const INTEGRITY_UUID = '5e7a93c411b24f089c63e02d761a58f9';

	const WRAP_INFO = 'majestic-records-v1 wrap';
	const AUTH_INFO = 'majestic-records-v1 auth';
	const KCV_INFO = 'majestic-records-v1 kcv';
	const GENESIS_INFO = 'majestic-records-v1 genesis';

	const SLOT_PASSPHRASE = 1;
	const SLOT_CHIP = 2;
	const SLOT_PUBKEY = 3;

	const DEK_LEN = 16;
	const MAC_LEN = 32;
	const MATERIAL_LEN = DEK_LEN + MAC_LEN;

	// Every length below comes out of a file, and a file can say anything. A
	// clip claiming two billion PBKDF2 iterations would hold the tab for hours
	// behind a spinner, so the bounds are refusals rather than clamps: the
	// honest answer to a number this far outside what the camera writes is
	// that the recording cannot be opened here, not a smaller number nobody
	// chose.
	const MAX_ITERATIONS = 4000000;
	const MAX_SLOTS = 16;
	const MAX_SAMPLES = 100000;
	const MAX_SUBSAMPLES = 4096;

	function be32(b, i) {
		return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
	}
	function be16(b, i) { return (b[i] << 8) | b[i + 1]; }
	function fourcc(b, i) {
		return String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
	}
	function put32(b, i, v) {
		b[i] = (v >>> 24) & 255; b[i + 1] = (v >>> 16) & 255;
		b[i + 2] = (v >>> 8) & 255; b[i + 3] = v & 255;
	}

	// ---- the key box -------------------------------------------------------

	// The payload of the camera's pssh, or null. Everything about the search is
	// exact: the box has to be inside moov, the system id has to match, and the
	// version has to be one this build knows. A pssh belonging to some other
	// scheme is not an error and not ours.
	function keyBox(head) {
		const u8 = C.bytes(head);
		const moov = IDX.findBox(u8, 0, u8.length, 'moov');
		if (!moov) return null;
		let at = moov[0] + 8;
		while (at + 8 <= moov[1]) {
			const size = be32(u8, at);
			if (size < 8 || at + size > moov[1]) return null;
			if (fourcc(u8, at + 4) === 'pssh' && size >= 32) {
				const p = u8.subarray(at + 8, at + size);
				if (p[0] === 1 && C.hex(p.subarray(4, 20)) === SYSTEM_ID) {
					const parsed = parseKeyBox(p);
					if (parsed) return parsed;
				}
			}
			at += size;
		}
		return null;
	}

	function parseKeyBox(p) {
		// pssh version 1: version+flags, SystemID, KID count, KIDs, then the
		// data the scheme defines — which for this one is the box below.
		if (p.length < 44) return null;
		const kidCount = be32(p, 20);
		if (kidCount !== 1) return null;
		const kid = p.subarray(24, 40);
		const dataLen = be32(p, 40);
		if (44 + dataLen > p.length) return null;
		const body = p.subarray(44, 44 + dataLen);

		if (body.length < 37) return null;
		if (body[0] !== 1) return null;                    // a version this build does not know
		if (body[2] !== DEK_LEN || body[3] !== MAC_LEN) return null;
		const box = {
			kid: kid.slice(),
			kidHex: C.hex(kid),
			kcv: body.subarray(4 + 16, 4 + 32).slice(),
			slots: [],
			modes: [],
		};
		// The KID appears twice — in the pssh header and in the box — and they
		// have to agree, because everything downstream binds to one of them.
		if (!C.ctEqual(body.subarray(4, 20), kid)) return null;
		const count = body[36];
		if (count > MAX_SLOTS) return null;
		let at = 37;
		for (let i = 0; i < count; i++) {
			if (at + 4 > body.length) return null;
			const type = body[at];
			const len = be16(body, at + 2);
			if (at + 4 + len > body.length) return null;
			box.slots.push({ type: type, body: body.subarray(at + 4, at + 4 + len).slice() });
			at += 4 + len;
		}
		box.modes = box.slots.map(function (s) {
			return s.type === SLOT_PASSPHRASE ? 'passphrase'
				: s.type === SLOT_CHIP ? 'chip'
				: s.type === SLOT_PUBKEY ? 'pubkey' : 'unknown';
		});
		const pub = box.slots.filter(function (s) { return s.type === SLOT_PUBKEY; });
		box.pubkeyFp = pub.length && pub[0].body.length >= 10
			? C.hex(pub[0].body.subarray(2, 10)) : null;
		return box;
	}

	// The check that stands between a mistyped passphrase and a bug report
	// about a broken camera. A wrong key decrypts to noise in silence; this is
	// what turns that into a sentence.
	function materialMatches(box, material) {
		const kcv = C.hmacSha256(material.subarray(DEK_LEN),
			C.concat([C.utf8(KCV_INFO), box.kid])).subarray(0, 16);
		return C.ctEqual(kcv, box.kcv);
	}

	// Every opener answers in the same shape: material, or a reason a person
	// can act on. A wrong passphrase is an ANSWER, not an error — reporting it
	// as a failure sends someone to look at the card.
	function ok(material) { return { material: material }; }
	function no(reason) { return { reason: reason }; }

	function openWithPassphrase(box, passphrase) {
		let seen = false;
		for (const slot of box.slots) {
			if (slot.type !== SLOT_PASSPHRASE) continue;
			const b = slot.body;
			// 1 kdf id + 4 iterations + 16 + 16 salts + 48 wrapped + 32 tag.
			if (b.length !== 117 || b[0] !== 1) continue;
			seen = true;
			const iterations = be32(b, 1);
			if (!iterations || iterations > MAX_ITERATIONS)
				return no('this recording states an unreasonable amount of work to open it');
			const kek = C.pbkdf2Sha256(passphrase, b.subarray(5, 21), iterations, 32);
			const prk = C.hkdfExtract(b.subarray(21, 37), kek);
			const auth = C.hkdfExpand(prk, AUTH_INFO, 32);
			const want = C.hmacSha256(auth, C.concat([box.kid, b.subarray(0, 85)]));
			if (!C.ctEqual(want, b.subarray(85, 117))) continue;
			const pad = C.hkdfExpand(prk, WRAP_INFO, MATERIAL_LEN);
			const material = b.subarray(37, 85).slice();
			for (let i = 0; i < MATERIAL_LEN; i++) material[i] ^= pad[i];
			if (!materialMatches(box, material))
				return no('a passphrase opened this recording and the key inside did not match it — the file is damaged');
			return ok(material);
		}
		return no(seen
			? 'That passphrase does not open this recording.'
			: 'This recording does not carry a passphrase.');
	}

	// `key` is what MajesticCrypto.parsePrivateKeyPem() returned. The
	// fingerprint is checked first so that "sealed to another key" is a
	// different sentence from "that key did not work" — the first is
	// actionable, the second reads like a fault.
	function openWithPrivateKey(box, key, fingerprintHex) {
		let seen = false;
		let mine = false;
		for (const slot of box.slots) {
			if (slot.type !== SLOT_PUBKEY || slot.body.length < 10) continue;
			seen = true;
			const bits = be16(slot.body, 0);
			const fp = C.hex(slot.body.subarray(2, 10));
			if (fingerprintHex && fp !== fingerprintHex) continue;
			mine = true;
			const ct = slot.body.subarray(10);
			if (!bits || ct.length !== key.size) continue;
			let material;
			try {
				material = C.rsaOaepDecrypt(key, ct);
			} catch (e) {
				continue;
			}
			if (material.length !== MATERIAL_LEN) continue;
			if (!materialMatches(box, material))
				return no('that key opened this recording and the key inside did not match it — the file is damaged');
			return ok(material);
		}
		if (!seen) return no('This recording does not carry a recovery key.');
		if (!mine) return no('This recording is locked to a key that is not on this device.');
		return no('That key does not open this recording.');
	}

	function chipOnly(box) {
		return box.slots.length > 0 && box.slots.every(function (s) { return s.type === SLOT_CHIP; });
	}

	// ---- what the header says about protection ----------------------------

	// Three outcomes, and they must stay three: a clip in the clear, a clip
	// this build understands how to open, and a clip that is protected in a way
	// it does not know. Collapsing the third into either of the others is a
	// black frame or a demand for a passphrase that would not help.
	function inspect(head, headerLength) {
		const u8 = C.bytes(head);
		const end = Math.min(headerLength || u8.length, u8.length);
		const moov = IDX.findBox(u8, 0, end, 'moov');
		// No moov is not "this clip is in the clear" — it is "this is not a
		// header I could read", which happens with a short read, a file that
		// is not an MP4, and a clip whose header is bigger than the window the
		// caller took. Answering `encrypted: false` there hands protected
		// bytes to a decoder on the strength of never having looked.
		if (!moov) return unreadable('the clip header could not be read');

		const tracks = {};
		let encrypted = false;
		let wrapped = false;
		let reason = null;

		let at = moov[0] + 8;
		while (at + 8 <= moov[1]) {
			const size = be32(u8, at);
			if (size < 8 || at + size > moov[1]) break;
			if (fourcc(u8, at + 4) === 'trak') {
				const t = readTrack(u8, at + 8, at + size);
				if (t) {
					tracks[t.id] = t;
					if (t.protected) encrypted = true;
					if (t.wrapped) wrapped = true;
					if (t.reason && !reason) reason = t.reason;
				}
			}
			at += size;
		}
		// Two separate questions, and conflating them gets one of two clips
		// wrong. `wrapped` is whether the sample entries hide the real codec,
		// which decides whether the init segment has to be rewritten before a
		// browser will decode anything. `encrypted` is whether the samples are
		// actually protected, which decides whether a key is needed at all — a
		// track can be wrapped and declare itself unprotected, and demanding a
		// passphrase for that would refuse a clip that plays.
		if (!Object.keys(tracks).length)
			return unreadable('the clip header carries no tracks this page can read');
		return {
			ok: true,
			encrypted: encrypted,
			wrapped: wrapped,
			tracks: tracks,
			keyBox: wrapped ? keyBox(u8.subarray(0, end)) : null,
			reason: reason,
		};
	}

	// `ok` false is a third answer beside clear and encrypted, and callers have
	// to treat it as its own: not a reason to play, not a reason to ask for a
	// passphrase, a reason to say the header could not be read.
	function unreadable(reason) {
		return {
			ok: false, encrypted: false, wrapped: false,
			tracks: {}, keyBox: null, reason: reason,
		};
	}

	function readTrack(u8, from, to) {
		const tkhd = IDX.findBox(u8, from, to, 'tkhd');
		if (!tkhd) return null;
		// tkhd v0 has the id at +12 past the box header, v1 at +20: the
		// version decides how wide the two times before it are.
		const v = u8[tkhd[0] + 8];
		const id = be32(u8, tkhd[0] + (v === 1 ? 8 + 20 : 8 + 12));

		const stsd = IDX.descend(u8, from, to, ['mdia', 'minf', 'stbl', 'stsd']);
		if (!stsd) return null;
		// stsd is a FullBox with an entry count before its children.
		let at = stsd[0] + 8;
		const size = be32(u8, at);
		if (size < 8 || at + size > stsd[1]) return null;
		const kind = fourcc(u8, at + 4);
		const track = {
			id: id, kind: kind, format: kind,
			wrapped: false, protected: false, ivSize: 0, kid: null, reason: null,
		};
		if (kind !== 'encv' && kind !== 'enca') return track;
		track.wrapped = true;

		const entryEnd = at + size;
		const childAt = at + (kind === 'encv' ? 86 : 36);
		const sinf = childAt < entryEnd ? IDX.findBox(u8, childAt, entryEnd, 'sinf') : null;
		if (!sinf) {
			track.reason = 'this recording is protected in a way this page does not know';
			return track;
		}
		const frma = IDX.findBox(u8, sinf[0] + 8, sinf[1], 'frma');
		const schm = IDX.findBox(u8, sinf[0] + 8, sinf[1], 'schm');
		const tenc = IDX.descend(u8, sinf[0] + 8, sinf[1], ['schi', 'tenc']);
		if (!frma || !schm || !tenc) {
			track.reason = 'this recording is protected in a way this page does not know';
			return track;
		}
		if (fourcc(u8, schm[0] + 12) !== 'cenc') {
			// cbcs and the rest are real schemes; they are simply not what the
			// camera writes, and guessing at one produces noise. Still marked
			// protected: the clip IS encrypted, and a page that recorded only
			// "cannot open" would go on to offer it to a decoder.
			track.protected = true;
			track.reason = 'this recording uses a protection scheme this page cannot open';
			return track;
		}
		track.format = fourcc(u8, frma[0] + 8);
		// tenc v0, in the order the box defines: four bytes of version and
		// flags, TWO reserved bytes — the second is a pattern in v1 and
		// reserved here — then whether the track is protected, the size of
		// each sample's initialisation vector, and the key id. Reading it as
		// one reserved byte finds the IV size where the protection flag is,
		// which is a clip declared unencrypted and played as noise.
		const t = tenc[0];
		if (t + 24 > tenc[1]) {
			track.reason = 'this recording is protected in a way this page does not know';
			return track;
		}
		const isProtected = u8[t + 6];
		track.ivSize = u8[t + 7];
		track.kid = u8.subarray(t + 8, t + 24).slice();
		if (!isProtected) {
			// Signalled as protected and then declared not to be. It plays
			// as it is; demanding a key for it would refuse a clip that works.
			return track;
		}
		if (track.ivSize !== 8 && track.ivSize !== 16) {
			track.reason = 'this recording states an initialisation vector size this page cannot use';
			return track;
		}
		track.protected = true;
		return track;
	}

	// ---- the init segment MediaSource will accept -------------------------

	// Rebuilt, not patched. Every container from moov down shrinks when a sinf
	// leaves, so an in-place edit means either a size that lies or a padding
	// box inside a sample entry — and a parser that tolerates the first is a
	// parser that plays nothing while reporting no error.
	//
	// null, never a half-rewrite, when the layout is not one this can rewrite
	// exactly. The page then says the header could not be prepared, which is
	// true and checkable, instead of appending something that decodes to a
	// black frame.
	function clearInit(head, headerLength) {
		const u8 = C.bytes(head);
		const end = Math.min(headerLength || u8.length, u8.length);
		const parts = [];
		let at = 0;
		while (at + 8 <= end) {
			const size = be32(u8, at);
			if (size < 8 || at + size > end) return null;
			const type = fourcc(u8, at + 4);
			if (type === 'moov') {
				const moov = rewriteContainer(u8, at, at + size, 'moov');
				if (!moov) return null;
				parts.push(moov);
			} else {
				parts.push(u8.subarray(at, at + size));
			}
			at += size;
		}
		return parts.length ? C.concat(parts) : null;
	}

	// Containers whose children begin straight after the box header. Anything
	// not named here is copied whole, which is what keeps avcC, hvcC, esds and
	// every box this build has never heard of exactly as the camera wrote them.
	const CONTAINERS = { moov: 8, trak: 8, mdia: 8, minf: 8, stbl: 8, mvex: 8, edts: 8, dinf: 8, udta: 8 };

	function rewriteContainer(u8, from, to, type) {
		const headerLen = CONTAINERS[type];
		const kids = [];
		let at = from + headerLen;
		while (at + 8 <= to) {
			const size = be32(u8, at);
			if (size < 8 || at + size > to) return null;
			const child = fourcc(u8, at + 4);
			if (child === 'pssh') {
				// Read for its keys before this ran, and dropped here: an init
				// segment carrying one raises an `encrypted` event on the media
				// element, which is a prompt nobody in this page can answer.
				at += size;
				continue;
			}
			let out;
			if (CONTAINERS[child] !== undefined) {
				out = rewriteContainer(u8, at, at + size, child);
			} else if (child === 'stsd') {
				out = rewriteStsd(u8, at, at + size);
			} else {
				out = u8.subarray(at, at + size);
			}
			if (!out) return null;
			kids.push(out);
			at += size;
		}
		if (at !== to) return null;
		return withHeader(u8.subarray(from, from + headerLen), kids);
	}

	function rewriteStsd(u8, from, to) {
		// stsd is a FullBox: version, flags and an entry count sit between the
		// header and the first sample entry.
		const kids = [];
		let at = from + 16;
		while (at + 8 <= to) {
			const size = be32(u8, at);
			if (size < 8 || at + size > to) return null;
			const type = fourcc(u8, at + 4);
			const out = (type === 'encv' || type === 'enca')
				? unprotectEntry(u8, at, at + size, type)
				: u8.subarray(at, at + size);
			if (!out) return null;
			kids.push(out);
			at += size;
		}
		if (at !== to) return null;
		return withHeader(u8.subarray(from, from + 16), kids);
	}

	// A visual sample entry's children start 86 bytes in, an audio one's 36.
	// Those numbers are not trusted: the walk from there has to land exactly on
	// the entry's end, and anything else — a sound entry in one of QuickTime's
	// older shapes, a layout this build has not seen — is refused. Scanning for
	// the literal `sinf` instead would eventually match those four bytes inside
	// a codec configuration record and cut a hole in the middle of it.
	function unprotectEntry(u8, from, to, type) {
		const fixed = type === 'encv' ? 86 : 36;
		if (from + fixed > to) return null;
		const kids = [];
		let original = null;
		let at = from + fixed;
		while (at + 8 <= to) {
			const size = be32(u8, at);
			if (size < 8 || at + size > to) return null;
			const child = fourcc(u8, at + 4);
			if (child === 'sinf') {
				const frma = IDX.findBox(u8, at + 8, at + size, 'frma');
				if (!frma) return null;
				original = u8.subarray(frma[0] + 8, frma[0] + 12);
			} else {
				kids.push(u8.subarray(at, at + size));
			}
			at += size;
		}
		if (at !== to || !original) return null;
		const header = u8.subarray(from, from + fixed).slice();
		header.set(original, 4);
		return withHeader(header, kids);
	}

	function withHeader(header, kids) {
		let n = header.length;
		for (const k of kids) n += k.length;
		const out = new Uint8Array(n);
		out.set(header, 0);
		let at = header.length;
		for (const k of kids) { out.set(k, at); at += k.length; }
		put32(out, 0, n);
		return out;
	}

	// ---- one fragment -----------------------------------------------------

	function fail(code, detail) {
		const e = new Error(detail || code);
		e.code = code;
		return e;
	}

	// A copy of `bytes` — one moof and its mdat — with every protected sample
	// decrypted. `tracks` is what inspect() returned.
	//
	// The keystream runs continuously across one sample's protected runs, so a
	// sample's runs are decrypted as one stream and never restarted per run: a
	// per-run counter still decodes the first NAL of a frame, which means a
	// picture appears and only the detail is wrong.
	function decryptFragment(bytes, material, tracks) {
		const src = C.bytes(bytes);
		if (src.length < 16) throw fail('short-fragment');
		const moofSize = be32(src, 0);
		if (moofSize < 16 || fourcc(src, 4) !== 'moof') throw fail('not-a-fragment');
		if (moofSize + 8 > src.length) throw fail('short-fragment');
		const mdatSize = be32(src, moofSize);
		if (mdatSize < 8 || fourcc(src, moofSize + 4) !== 'mdat') throw fail('not-a-fragment');
		if (moofSize + mdatSize > src.length) throw fail('short-fragment');

		const out = src.slice();
		const key = new C.Aes128(material.subarray(0, DEK_LEN));

		let at = 8;
		while (at + 8 <= moofSize) {
			const size = be32(src, at);
			if (size < 8 || at + size > moofSize) throw fail('bad-moof');
			if (fourcc(src, at + 4) === 'traf')
				decryptTraf(src, out, at, at + size, moofSize, mdatSize, key, tracks);
			at += size;
		}
		return out;
	}

	function decryptTraf(src, out, from, to, moofSize, mdatSize, key, tracks) {
		const tfhd = IDX.findBox(src, from + 8, to, 'tfhd');
		const trun = IDX.findBox(src, from + 8, to, 'trun');
		const senc = IDX.findBox(src, from + 8, to, 'senc');
		if (!tfhd || !trun) throw fail('bad-traf');

		const tfhdFlags = be32(src, tfhd[0] + 8) & 0xffffff;
		const trackId = be32(src, tfhd[0] + 12);
		const track = tracks[trackId];
		if (!track || !track.protected) return;      // a clear track in a protected clip
		if (!senc) throw fail('no-senc');

		// tfhd's optional fields, in the order the box defines them.
		// Reading past the end of a Uint8Array yields undefined, and every
		// bitwise operation turns that into zero — so a box that stops early
		// does not throw here, it quietly describes samples of no length and
		// a fragment comes back looking decrypted with nothing decrypted in
		// it. Each field is therefore checked against its box's end before it
		// is read, and a box that cannot hold what its flags promise is a
		// refusal like any other.
		let p = tfhd[0] + 16;
		let baseDataOffset = null;
		if (tfhdFlags & 0x000001) { need(p + 8, tfhd[1], 'bad-tfhd'); baseDataOffset = readU64(src, p); p += 8; }
		if (tfhdFlags & 0x000002) p += 4;            // sample description index
		if (tfhdFlags & 0x000008) p += 4;            // default sample duration
		let defaultSize = 0;
		if (tfhdFlags & 0x000010) { need(p + 4, tfhd[1], 'bad-tfhd'); defaultSize = be32(src, p); p += 4; }
		if (tfhdFlags & 0x000020) p += 4;            // default sample flags
		need(p, tfhd[1], 'bad-tfhd');

		const trunFlags = be32(src, trun[0] + 8) & 0xffffff;
		const sampleCount = be32(src, trun[0] + 12);
		if (sampleCount > MAX_SAMPLES) throw fail('too-many-samples');
		let q = trun[0] + 16;
		let dataOffset = 0;
		if (trunFlags & 0x000001) { need(q + 4, trun[1], 'bad-trun'); dataOffset = be32(src, q) | 0; q += 4; }
		if (trunFlags & 0x000004) q += 4;            // first sample flags
		need(q, trun[1], 'bad-trun');

		// Where this track's samples begin. Each traf carries its own offset,
		// so a two-track fragment must not assume the front of the payload —
		// the audio samples are not there.
		let base;
		if (tfhdFlags & 0x000001) base = Number(baseDataOffset) + dataOffset;
		else base = dataOffset;                      // default-base-is-moof, and the writer's shape
		if (base < 0 || base > moofSize + mdatSize) throw fail('bad-data-offset');

		// Sample sizes: from the trun, or one default for all of them. There
		// is no third source, and inventing one walks the cursor into the next
		// track's samples.
		const perSample = (trunFlags & 0x000200) !== 0;
		if (!perSample && !defaultSize) throw fail('no-sample-sizes');
		const stride = ((trunFlags & 0x000100) ? 4 : 0) + ((trunFlags & 0x000200) ? 4 : 0) +
			((trunFlags & 0x000400) ? 4 : 0) + ((trunFlags & 0x000800) ? 4 : 0);
		const sizeAt = q + ((trunFlags & 0x000100) ? 4 : 0);
		// The whole sample table, not just its first row: a trun that lists a
		// thousand samples and holds ten is the case that reads as zeroes.
		need(q + sampleCount * stride, trun[1], 'bad-trun',
			'the fragment lists ' + sampleCount + ' samples and does not carry them');

		// senc: version+flags, then a count, then one record per sample.
		const sencFlags = be32(src, senc[0] + 8) & 0xffffff;
		const sencCount = be32(src, senc[0] + 12);
		if (sencCount !== sampleCount) throw fail('senc-mismatch',
			'the fragment lists ' + sampleCount + ' samples and ' + sencCount + ' initialisation vectors');
		const subsampled = (sencFlags & 0x2) !== 0;
		let s = senc[0] + 16;

		const iv = new Uint8Array(16);
		let cursor = base;
		for (let i = 0; i < sampleCount; i++) {
			const size = perSample ? be32(src, sizeAt + i * stride) : defaultSize;
			if (s + track.ivSize > senc[1]) throw fail('short-senc');
			iv.fill(0);
			iv.set(src.subarray(s, s + track.ivSize), 0);
			s += track.ivSize;

			const runs = [];
			if (subsampled) {
				if (s + 2 > senc[1]) throw fail('short-senc');
				const n = be16(src, s);
				s += 2;
				if (n > MAX_SUBSAMPLES) throw fail('too-many-subsamples');
				let covered = 0;
				for (let e = 0; e < n; e++) {
					if (s + 6 > senc[1]) throw fail('short-senc');
					const clear = be16(src, s);
					const prot = be32(src, s + 2);
					s += 6;
					covered += clear + prot;
					if (prot) runs.push([cursor + covered - prot, prot]);
				}
				// The runs have to describe the sample exactly. An off-by-one
				// here decrypts the wrong bytes at the wrong offsets and still
				// produces output, which is the whole reason this is checked
				// rather than trusted.
				if (covered !== size) throw fail('subsample-overrun',
					'a sample of ' + size + ' bytes is described as ' + covered);
			} else {
				if (size) runs.push([cursor, size]);
			}

			const stream = C.ctr(key, iv);
			for (const run of runs) {
				if (run[0] < 0 || run[0] + run[1] > moofSize + mdatSize) throw fail('short-mdat');
				stream.xor(out, run[0], run[1]);
			}
			cursor += size;
		}
		if (cursor > moofSize + mdatSize) throw fail('short-mdat');
	}

	function need(at, end, code, detail) {
		if (at > end) throw fail(code, detail);
	}

	function readU64(b, i) {
		// A base_data_offset past 2^53 is not a file this page will ever see,
		// and Number() keeps the arithmetic below in one type.
		return be32(b, i) * 4294967296 + be32(b, i + 4);
	}

	// ---- the integrity chain ----------------------------------------------

	// Each fragment's tag covers the one before it, so the chain can only be
	// walked forward from the start of the clip. That is why a seek does not
	// resume it: a chain restarted in the middle proves nothing about what came
	// before, and a page that implies otherwise is worse than one that says
	// nothing.
	function chain(material) {
		const kMac = material.subarray(DEK_LEN);
		let prev = null;
		let count = 0;
		return {
			genesis: function (initBytes) {
				prev = C.hmacSha256(kMac, C.concat([C.utf8(GENESIS_INFO), C.bytes(initBytes)]));
				count = 0;
				return prev;
			},
			// One [moof][mdat] pair exactly as it is on the card. Returns
			// {ok, index} — or {unknown} where the fragment carries no tag,
			// which is a clip from a build that did not write one, not a
			// clip that fails.
			step: function (bytes) {
				if (prev === null) throw fail('no-genesis');
				const b = C.bytes(bytes);
				const moofSize = be32(b, 0);
				if (moofSize < 16 || fourcc(b, 4) !== 'moof' || moofSize > b.length)
					throw fail('not-a-fragment');
				const tagAt = findTag(b, moofSize);
				if (tagAt < 0) return { unknown: true, index: count };

				// The tag covers the fragment with its own field zeroed, which
				// is the only way it can cover itself. Hashing it in place
				// makes every clip read as tampered; not comparing it at all
				// makes every clip read as intact. Both look like working code.
				const work = b.slice();
				work.fill(0, tagAt, tagAt + 32);
				const want = C.hmacSha256(kMac, C.concat([prev, work]));
				const got = b.subarray(tagAt, tagAt + 32);
				const good = C.ctEqual(want, got);
				if (good) { prev = got.slice(); count++; }
				return { ok: good, index: count - (good ? 1 : 0) };
			},
			fragments: function () { return count; },
		};
	}

	function findTag(b, moofSize) {
		let at = 8;
		while (at + 8 <= moofSize) {
			const size = be32(b, at);
			if (size < 8 || at + size > moofSize) return -1;
			if (fourcc(b, at + 4) === 'uuid' && size === 60 &&
				C.hex(b.subarray(at + 8, at + 24)) === INTEGRITY_UUID && b[at + 24] === 1)
				return at + 28;
			at += size;
		}
		return -1;
	}

	return {
		SYSTEM_ID: SYSTEM_ID,
		INTEGRITY_UUID: INTEGRITY_UUID,
		SLOT_PASSPHRASE: SLOT_PASSPHRASE,
		SLOT_CHIP: SLOT_CHIP,
		SLOT_PUBKEY: SLOT_PUBKEY,
		MATERIAL_LEN: MATERIAL_LEN,
		keyBox: keyBox,
		inspect: inspect,
		chipOnly: chipOnly,
		openWithPassphrase: openWithPassphrase,
		openWithPrivateKey: openWithPrivateKey,
		materialMatches: materialMatches,
		clearInit: clearInit,
		decryptFragment: decryptFragment,
		chain: chain,
	};
})();

if (typeof module === 'object' && module.exports) module.exports = window.MajesticMp4Crypt;
