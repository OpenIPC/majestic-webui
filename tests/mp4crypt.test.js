// MajesticMp4Crypt — opening a recording the camera encrypted.
//
// Everything this module can get wrong is silent. A key that is not the right
// key decrypts to noise; a subsample walk that is off by one decrypts the right
// bytes at the wrong offsets; a keystream restarted between two runs of the
// same frame still decodes the first NAL, so a picture appears and only the
// detail is wrong. None of that raises anything. It reaches a person as "the
// camera records broken video", days later, with no way to reproduce it except
// a camera, a card and a clip that is already encrypted.
//
// So the fixtures here are built with node:crypto — pbkdf2Sync, createHmac,
// createCipheriv, publicEncrypt — and never with the module under test. The
// format is written out twice, independently, which is the only arrangement in
// which a swapped label or a mis-ordered HMAC input is detectable at all.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const FIX = path.join(__dirname, 'fixtures');

function load() {
	const ctx = {
		window: {},
		console: console,
		TextEncoder: TextEncoder,
		crypto: globalThis.crypto,
		Buffer: Buffer,
		apiFetch: function () { throw new Error('no network in tests'); },
	};
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'www', 'a', 'mjcrypto.js'), 'utf8'), ctx);
	vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'www', 'a', 'mp4index.js'), 'utf8'), ctx);
	vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'www', 'a', 'mp4crypt.js'), 'utf8'), ctx);
	return ctx.window;
}

const W = load();
const CRYPT = W.MajesticMp4Crypt;
const C = W.MajesticCrypto;
const u8 = (b) => new Uint8Array(b);
const hex = (b) => Buffer.from(b).toString('hex');

// ---- the format, written a second time ---------------------------------

const SYSTEM_ID = Buffer.from('9d2c417a6e384bd1a50f3c8e217bd462', 'hex');
const INTEGRITY_UUID = Buffer.from('5e7a93c411b24f089c63e02d761a58f9', 'hex');
const KID = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex');
const DEK = Buffer.from('2b7e151628aed2a6abf7158809cf4f3c', 'hex');
const KMAC = Buffer.from('4041424344454647' .repeat(4), 'hex');
const MATERIAL = Buffer.concat([DEK, KMAC]);
const PASSPHRASE = 'a long lab passphrase';
const ITERATIONS = 2048;   // the shape, not the cost — the camera writes 100 000

function box(type, ...parts) {
	const body = Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p)));
	const b = Buffer.alloc(8 + body.length);
	b.writeUInt32BE(b.length, 0);
	b.write(type, 4, 'ascii');
	body.copy(b, 8);
	return b;
}
function u32(...v) {
	const b = Buffer.alloc(4 * v.length);
	v.forEach((x, i) => b.writeUInt32BE(x >>> 0, i * 4));
	return b;
}
function u16(...v) {
	const b = Buffer.alloc(2 * v.length);
	v.forEach((x, i) => b.writeUInt16BE(x, i * 2));
	return b;
}

function hmac(key, ...parts) {
	const h = crypto.createHmac('sha256', key);
	parts.forEach(p => h.update(Buffer.isBuffer(p) ? p : Buffer.from(p)));
	return h.digest();
}

function hkdfExpand(prk, info, len) {
	let t = Buffer.alloc(0), out = Buffer.alloc(0);
	for (let i = 1; out.length < len; i++)
		out = Buffer.concat([out, (t = hmac(prk, t, Buffer.from(info), Buffer.from([i])))]);
	return out.subarray(0, len);
}

function kcvOf(kMac, kid) {
	return hmac(kMac, Buffer.from('majestic-records-v1 kcv'), kid).subarray(0, 16);
}

function passphraseSlot(passphrase, material, kid, iterations) {
	const pbSalt = Buffer.alloc(16, 0xa1);
	const hkSalt = Buffer.alloc(16, 0xb2);
	const kek = crypto.pbkdf2Sync(Buffer.from(passphrase, 'utf8'), pbSalt, iterations, 32, 'sha256');
	const prk = hmac(hkSalt, kek);
	const pad = hkdfExpand(prk, 'majestic-records-v1 wrap', 48);
	const auth = hkdfExpand(prk, 'majestic-records-v1 auth', 32);
	const wrapped = Buffer.alloc(48);
	for (let i = 0; i < 48; i++) wrapped[i] = material[i] ^ pad[i];
	const head = Buffer.concat([Buffer.from([1]), u32(iterations), pbSalt, hkSalt, wrapped]);
	return Buffer.concat([head, hmac(auth, kid, head)]);
}

function pubkeySlot(material, pubPem) {
	const spki = crypto.createPublicKey(pubPem).export({ type: 'spki', format: 'der' });
	const fp = crypto.createHash('sha256').update(spki).digest().subarray(0, 8);
	const ct = crypto.publicEncrypt({
		key: pubPem,
		padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
		oaepHash: 'sha256',
	}, material);
	return Buffer.concat([u16(2048), fp, ct]);
}

function chipSlot() {
	// Its contents are the camera's business; what matters here is that a slot
	// this page cannot open is recognised as one and not mistaken for damage.
	return Buffer.concat([Buffer.from([1, 16]), Buffer.alloc(16, 0x5a), Buffer.alloc(32, 0x6b)]);
}

function keyBoxBody(kid, kMac, slots) {
	const parts = [Buffer.from([1, 0, 16, 32]), kid, kcvOf(kMac, kid), Buffer.from([slots.length])];
	slots.forEach(s => parts.push(Buffer.from([s.type, 0]), u16(s.body.length), s.body));
	return Buffer.concat(parts);
}

function pssh(kid, body) {
	return box('pssh', Buffer.from([1, 0, 0, 0]), SYSTEM_ID, u32(1), kid, u32(body.length), body);
}

// version+flags, two reserved bytes, is-protected, IV size, key id — the byte
// order the camera writes, transcribed from the format rather than from the
// reader in www/a/, so the two have to agree by being right and not by having
// been written by the same hand.
function tenc(kid, ivSize, isProtected) {
	return box('tenc',
		Buffer.from([0, 0, 0, 0, 0, 0, isProtected === undefined ? 1 : isProtected, ivSize]), kid);
}

function sinf(original, kid, opts) {
	const o = opts || {};
	return box('sinf',
		box('frma', Buffer.from(original, 'ascii')),
		box('schm', Buffer.from([0, 0, 0, 0]), Buffer.from(o.scheme || 'cenc', 'ascii'), u32(0x00010000)),
		box('schi', tenc(kid, o.ivSize === undefined ? 8 : o.ivSize, o.isProtected)));
}

// A visual sample entry: 78 bytes of fixed fields after the box header, then
// children. An audio one has 28.
function visualEntry(type, children) {
	return box(type, Buffer.alloc(78), Buffer.concat(children));
}
function audioEntry(type, children) {
	return box(type, Buffer.alloc(28), Buffer.concat(children));
}

function trak(id, entry, handler) {
	return box('trak',
		box('tkhd', Buffer.from([0, 0, 0, 7]), u32(0, 0, id, 0, 0)),
		box('mdia',
			box('mdhd', Buffer.from([0, 0, 0, 0]), u32(0, 0, 1000000, 0)),
			box('hdlr', Buffer.alloc(8), Buffer.from(handler, 'ascii'), Buffer.alloc(12)),
			box('minf',
				box('stbl',
					box('stsd', Buffer.from([0, 0, 0, 0]), u32(1), entry)))));
}

// The init segment, encrypted or not, with whatever slots are asked for.
function initSegment(opts) {
	const o = opts || {};
	const enc = o.encrypted !== false;
	const avcC = box('avcC', Buffer.from([1, 0x42, 0xc0, 0x1e, 0xff, 0xe1, 0, 4, 0x67, 0x42, 0xc0, 0x1e, 1, 0, 4, 0x68, 0xce, 0x38, 0x80]));
	const video = enc
		? visualEntry('encv', [avcC, sinf('avc1', KID, o)])
		: visualEntry('avc1', [avcC]);
	const esds = box('esds', Buffer.alloc(20));
	const audio = enc
		? audioEntry('enca', [esds, sinf('mp4a', KID, o)])
		: audioEntry('mp4a', [esds]);
	const kids = [
		box('mvhd', Buffer.from([0, 0, 0, 0]), u32(0, 0, 1000000, 0)),
		trak(1, video, 'vide'),
		trak(2, audio, 'soun'),
	];
	if (enc && o.slots !== null)
		kids.push(pssh(KID, keyBoxBody(KID, o.kMac || KMAC, o.slots || defaultSlots())));
	return Buffer.concat([
		box('ftyp', Buffer.from('isom', 'ascii'), u32(512), Buffer.from('isomiso2avc1mp41', 'ascii')),
		box('moov', ...kids),
	]);
}

function defaultSlots() {
	return [
		{ type: 1, body: passphraseSlot(PASSPHRASE, MATERIAL, KID, ITERATIONS) },
		{ type: 2, body: chipSlot() },
		{ type: 3, body: pubkeySlot(MATERIAL, fs.readFileSync(path.join(FIX, 'rsa-oaep.pub.pem'), 'utf8')) },
	];
}

// ---- a fragment, encrypted the way the camera encrypts one --------------

// A video sample: NALs, each a 4-byte length then a 1-byte header in the
// clear, the rest protected. Sizes are deliberately not multiples of 16 — a
// block boundary that falls inside a clear gap is what makes a per-run
// keystream wrong from the second NAL onward.
function videoSample(nalSizes, fill) {
	const parts = [];
	const subs = [];
	nalSizes.forEach((n, i) => {
		const nal = Buffer.alloc(n, fill + i);
		nal[0] = 0x41;                                // NAL header, stays clear
		parts.push(u32(n), nal);
		subs.push({ clear: 5, prot: n - 1 });
	});
	return { bytes: Buffer.concat(parts), subs: subs };
}

function encryptSample(plain, subs, iv) {
	// The camera gathers a sample's protected runs and encrypts them as ONE
	// stream. Node is asked for exactly that: one cipher per sample, fed the
	// runs in order.
	const ctr = crypto.createCipheriv('aes-128-ctr', DEK, Buffer.concat([iv, Buffer.alloc(8)]));
	const out = Buffer.from(plain);
	let at = 0;
	(subs || [{ clear: 0, prot: plain.length }]).forEach(s => {
		at += s.clear;
		if (s.prot) ctr.update(out.subarray(at, at + s.prot)).copy(out, at);
		at += s.prot;
	});
	return out;
}

function ivFor(n) {
	const b = Buffer.alloc(8);
	b.writeUInt32BE(0xabcd0001, 0);
	b.writeUInt32BE(n, 4);
	return b;
}

// One traf: tfhd (the camera's flags), trun with per-sample sizes, then senc.
function traf(trackId, samples, subsampled, baseOffset) {
	const sizes = samples.map(s => s.bytes.length);
	const tfhd = box('tfhd', u32(0x020030, trackId, sizes[0] || 0, 0));
	const trun = box('trun', u32(0x000201, samples.length, baseOffset), ...sizes.map(s => u32(s)));
	const recs = samples.map(s => {
		const parts = [s.iv];
		if (subsampled) {
			parts.push(u16(s.subs.length));
			s.subs.forEach(x => parts.push(u16(x.clear), u32(x.prot)));
		}
		return Buffer.concat(parts);
	});
	const senc = box('senc', u32(subsampled ? 0x000002 : 0, samples.length), ...recs);
	const saiz = box('saiz', u32(0), Buffer.from([0]), u32(samples.length));
	const saio = box('saio', u32(0, 1, 0));
	return box('traf', tfhd, box('tfdt', Buffer.from([1, 0, 0, 0]), u32(0, 0)), trun, senc, saiz, saio);
}

function uuidTag(tag) {
	return box('uuid', INTEGRITY_UUID, Buffer.from([1, 0, 0, 0]), tag || Buffer.alloc(32));
}

// A whole [moof][mdat] pair. Returns the encrypted bytes and the plaintext
// payload beside them, so a test can assert the round trip byte for byte.
function fragment(opts) {
	const o = opts || {};
	const video = (o.video || [[400, 90, 33], [250]]).map((nals, i) => {
		const s = videoSample(nals, 0x10 + i);
		return { plain: s.bytes, subs: s.subs, iv: ivFor(i + 1) };
	});
	const audio = (o.audio || [160, 160]).map((n, i) => ({
		plain: Buffer.alloc(n, 0x70 + i),
		subs: null,
		iv: ivFor(100 + i),
	}));

	// Build the moof first with a placeholder data offset, then again once its
	// size is known — the same two-pass shape the writer has, because the
	// offset is relative to the start of the moof.
	function build(videoBase, audioBase, tag) {
		return box('moof',
			box('mfhd', u32(0, o.seq === undefined ? 1 : o.seq)),
			traf(1, video.map(s => ({ bytes: s.plain, subs: s.subs, iv: s.iv })), true, videoBase),
			traf(2, audio.map(s => ({ bytes: s.plain, subs: s.subs, iv: s.iv })), false, audioBase),
			uuidTag(tag));
	}
	const probe = build(0, 0, null);
	const payloadStart = probe.length + 8;
	const videoBytes = video.reduce((a, s) => a + s.plain.length, 0);
	const moof = build(payloadStart, payloadStart + videoBytes, o.tag);

	const plain = Buffer.concat(video.concat(audio).map(s => s.plain));
	const cipher = Buffer.concat(video.concat(audio).map(s => encryptSample(s.plain, s.subs, s.iv)));
	return {
		bytes: Buffer.concat([moof, box('mdat', cipher)]),
		plainBytes: Buffer.concat([moof, box('mdat', plain)]),
		moofLen: moof.length,
		payloadAt: payloadStart,
	};
}

// ---- the key box --------------------------------------------------------

group('the key box');

const init = initSegment();
const box1 = CRYPT.keyBox(u8(init));

check('is found inside moov, under the camera\'s system id', box1 !== null);
check('and reports the key id the tracks are bound to', box1 && hex(box1.kid) === hex(KID));
check('and every slot it carries, in order',
	box1 && box1.modes.join(',') === 'passphrase,chip,pubkey');
check('and which key a recovery slot is sealed to',
	box1 && box1.pubkeyFp === hex(crypto.createHash('sha256')
		.update(crypto.createPublicKey(fs.readFileSync(path.join(FIX, 'rsa-oaep.pub.pem'), 'utf8'))
			.export({ type: 'spki', format: 'der' })).digest().subarray(0, 8)));

check('a clip with no pssh is not encrypted, and says so by returning nothing',
	CRYPT.keyBox(u8(initSegment({ encrypted: false }))) === null);

(function tamperedBox() {
	// The key id appears in the pssh header and again inside the box. They
	// have to agree: a slot lifted from another clip's box would otherwise
	// authenticate against a key id this clip never used.
	const bent = Buffer.from(init);
	const at = bent.indexOf(SYSTEM_ID) + 16 + 4 + 4 + 16;   // the box's own copy
	bent[at] ^= 0x80;
	check('a key id that disagrees with itself is refused', CRYPT.keyBox(u8(bent)) === null);
})();

// ---- opening it ---------------------------------------------------------

group('opening the key box');

(function passphrase() {
	const got = CRYPT.openWithPassphrase(box1, PASSPHRASE);
	check('the right passphrase yields the 48 bytes the camera sealed',
		got.material && hex(got.material) === hex(MATERIAL));

	const wrong = CRYPT.openWithPassphrase(box1, PASSPHRASE + '!');
	check('a wrong passphrase is an answer, not an error',
		!wrong.material && /does not open/.test(wrong.reason));

	// Every byte of the slot is covered by its tag. A flip anywhere has to be
	// refused, or a slot can be edited into one that opens with a key nobody
	// chose.
	let refused = 0, tries = 0;
	for (let at = 0; at < 117; at += 7) {
		const bent = initSegment({ slots: bendSlot(at) });
		const b = CRYPT.keyBox(u8(bent));
		tries++;
		if (!CRYPT.openWithPassphrase(b, PASSPHRASE).material) refused++;
	}
	check('and so is a flipped byte anywhere in the slot', refused === tries,
		refused + ' of ' + tries);

	function bendSlot(at) {
		const s = passphraseSlot(PASSPHRASE, MATERIAL, KID, ITERATIONS);
		s[at] ^= 1;
		return [{ type: 1, body: s }];
	}
})();

(function kcv() {
	// The one guard between a mistyped passphrase and a bug report about a
	// broken camera. Here the slot authenticates — it was built correctly —
	// but wraps material that does not belong to this box's key check value,
	// which is what a damaged or spliced file looks like. Without this the
	// page would hand a wrong key to the decrypter and show noise.
	const other = Buffer.concat([DEK, Buffer.alloc(32, 0x99)]);
	const bent = initSegment({
		slots: [{ type: 1, body: passphraseSlot(PASSPHRASE, other, KID, ITERATIONS) }],
	});
	const b = CRYPT.keyBox(u8(bent));
	const got = CRYPT.openWithPassphrase(b, PASSPHRASE);
	check('material that does not match the box\'s check value is refused',
		!got.material && /damaged/.test(got.reason));
})();

(function pubkey() {
	const key = C.parsePrivateKeyPem(fs.readFileSync(path.join(FIX, 'rsa-oaep.key.pem'), 'utf8'));
	const fp = C.hex(C.publicKeyFingerprint(key));
	const got = CRYPT.openWithPrivateKey(box1, key, fp);
	check('a recovery key opens the same 48 bytes',
		got.material && hex(got.material) === hex(MATERIAL));

	// "Sealed to a key you do not have" and "your key did not work" are
	// different sentences, and only the first is actionable.
	const elsewhere = CRYPT.openWithPrivateKey(box1, key, 'ff'.repeat(8));
	check('a clip sealed to another key says so, rather than reporting a failure',
		!elsewhere.material && /not on this device/.test(elsewhere.reason));

	const chipClip = initSegment({ slots: [{ type: 2, body: chipSlot() }] });
	const chipBox = CRYPT.keyBox(u8(chipClip));
	check('a chip-only clip is recognised as one', CRYPT.chipOnly(chipBox));
	check('and asking a key to open it says there is no recovery slot',
		/does not carry a recovery key/.test(CRYPT.openWithPrivateKey(chipBox, key, fp).reason));
	check('and so does asking for a passphrase',
		/does not carry a passphrase/.test(CRYPT.openWithPassphrase(chipBox, PASSPHRASE).reason));
})();

// ---- what the header says ----------------------------------------------

group('reading the header');

(function inspecting() {
	const p = CRYPT.inspect(u8(init), init.length);
	check('an encrypted clip is reported as one', p.encrypted === true);
	check('with the real codec of each track, from behind the protection',
		p.tracks[1] && p.tracks[1].format === 'avc1' && p.tracks[2] && p.tracks[2].format === 'mp4a');
	check('and the size of the initialisation vectors it uses',
		p.tracks[1].ivSize === 8 && p.tracks[1].protected === true);
	check('and nothing it could not understand', p.reason === null);

	check('and says it could read the header at all', p.ok === true);

	const plain = CRYPT.inspect(u8(initSegment({ encrypted: false })));
	check('a clip in the clear needs no key',
		plain.ok === true && plain.encrypted === false && plain.reason === null);

	// A header that could not be read is a third answer. Reported as "not
	// encrypted" — which is what an absent moov used to produce — the page
	// goes on to hand whatever it has to a decoder, on the strength of never
	// having looked. The short read is the ordinary way to get here: the page
	// takes a window off the front of the clip, and a header can be wider.
	const short = CRYPT.inspect(u8(init.subarray(0, 40)));
	check('a header too short to hold a moov is unreadable, not unencrypted',
		short.ok === false && short.encrypted === false && /could not be read/.test(short.reason));
	const notMp4 = CRYPT.inspect(new Uint8Array(64));
	check('and so is something that is not an MP4 at all',
		notMp4.ok === false && !!notMp4.reason);

	// A moov whose tracks this walk cannot take apart — a header shaped in a
	// way this build has not seen — is a different case again. The bytes are
	// here, so the question can be asked directly rather than assumed either
	// way: no protection box anywhere inside them is a finding, and refusing
	// such a clip would refuse a recording that plays today.
	const bare = Buffer.concat([
		box('ftyp', Buffer.alloc(16)),
		box('moov', box('trak', box('mdia', box('mdhd', Buffer.alloc(24))))),
	]);
	const b = CRYPT.inspect(u8(bare), bare.length);
	check('a header this walk cannot take a track out of, holding no protection at all, is clear',
		b.ok === true && b.encrypted === false && b.reason === null);

	const bareSealed = Buffer.concat([
		box('ftyp', Buffer.alloc(16)),
		box('moov', box('trak', box('mdia', box('minf', sinf('avc1', KID, {}))))),
	]);
	const bs = CRYPT.inspect(u8(bareSealed), bareSealed.length);
	check('and the same header with protection in it is encrypted and unopenable, not clear',
		bs.ok === true && bs.encrypted === true && /does not know/.test(bs.reason || ''));

	// Signalled as protected and then declared not to be. It plays as it is,
	// and demanding a passphrase for it would refuse a working clip.
	const off = CRYPT.inspect(u8(initSegment({ isProtected: 0 })));
	check('a track marked not-protected is not treated as encrypted', off.encrypted === false);

	// A scheme this page cannot open must be its own outcome: neither "plays"
	// nor "wrong passphrase", both of which would be a lie.
	const cbcs = CRYPT.inspect(u8(initSegment({ scheme: 'cbcs' })));
	check('a protection scheme this page does not implement is named, not guessed',
		cbcs.encrypted === true && /cannot open/.test(cbcs.reason || ''));
})();

// ---- the init segment MediaSource is given -----------------------------

group('clearing the init segment');

(function clearing() {
	const out = CRYPT.clearInit(u8(init), init.length);
	check('it produces something', out !== null);
	const buf = Buffer.from(out);
	check('with no protection scheme left in it',
		buf.indexOf(Buffer.from('sinf', 'ascii')) < 0 && buf.indexOf(Buffer.from('tenc', 'ascii')) < 0);
	check('and no key box — an init segment carrying one asks the browser for a decryption module',
		buf.indexOf(Buffer.from('pssh', 'ascii')) < 0);
	check('and the sample entries called what they really are',
		buf.indexOf(Buffer.from('avc1', 'ascii')) > 0 && buf.indexOf(Buffer.from('mp4a', 'ascii')) > 0 &&
		buf.indexOf(Buffer.from('encv', 'ascii')) < 0 && buf.indexOf(Buffer.from('enca', 'ascii')) < 0);
	check('and the codec configuration untouched',
		buf.indexOf(Buffer.from('avcC', 'ascii')) > 0 && buf.indexOf(Buffer.from('esds', 'ascii')) > 0);

	// The sizes are the part that fails silently: a container that was not
	// shrunk still looks consistent from the top and misaligns the box after
	// it, which a SourceBuffer answers by buffering nothing at all. Walked
	// here by a checker that shares no code with the rewriter.
	const bad = [];
	walkSizes(buf, 0, buf.length, bad);
	check('and every container size equal to its contents', bad.length === 0, bad.join(', '));

	const clear = CRYPT.clearInit(u8(initSegment({ encrypted: false })));
	check('a clip that was never encrypted comes back unchanged',
		hex(clear) === hex(initSegment({ encrypted: false })));
})();

function walkSizes(b, from, to, bad) {
	const NESTED = { moov: 8, trak: 8, mdia: 8, minf: 8, stbl: 8, mvex: 8, stsd: 16 };
	let at = from;
	while (at + 8 <= to) {
		const size = b.readUInt32BE(at);
		const type = b.toString('ascii', at + 4, at + 8);
		if (size < 8 || at + size > to) { bad.push(type + ' size ' + size); return; }
		const skip = NESTED[type];
		if (skip !== undefined) {
			let sum = skip;
			let k = at + skip;
			while (k + 8 <= at + size) {
				const ks = b.readUInt32BE(k);
				if (ks < 8) break;
				sum += ks;
				k += ks;
			}
			if (sum !== size) bad.push(type + ' says ' + size + ', holds ' + sum);
			walkSizes(b, at + skip, at + size, bad);
		}
		at += size;
	}
}

// ---- the samples --------------------------------------------------------

group('decrypting a fragment');

(function roundTrip() {
	const p = CRYPT.inspect(u8(init), init.length);
	const f = fragment();
	const got = CRYPT.decryptFragment(u8(f.bytes), MATERIAL, p.tracks);
	check('a fragment decrypts to exactly what was recorded',
		hex(got) === hex(f.plainBytes));

	// The trap. A multi-NAL sample's protected runs are one keystream; the
	// clear five bytes between them do not advance it, and the runs are not
	// multiples of the block size. Decrypting each run from its own counter
	// gets the first one right — a picture, with the rest of the frame wrong.
	const first = f.video ? 0 : 0;
	check('including every NAL of a multi-NAL frame, not just the first',
		hex(Buffer.from(got).subarray(f.payloadAt, f.payloadAt + 600)) ===
		hex(f.plainBytes.subarray(f.payloadAt, f.payloadAt + 600)));

	// Audio has no subsample list: the whole sample is protected. Applying the
	// video rule to it would corrupt every audio sample and produce noise at
	// full volume rather than silence.
	const audioAt = f.bytes.length - 320;
	check('and the audio samples, which are protected whole',
		hex(Buffer.from(got).subarray(audioAt)) === hex(f.plainBytes.subarray(audioAt)));

	check('twice over is the original again — CTR is its own inverse',
		hex(CRYPT.decryptFragment(got, MATERIAL, p.tracks)) === hex(f.bytes));
})();

(function refusals() {
	const p = CRYPT.inspect(u8(init), init.length);
	const f = fragment();

	function refuses(name, bend, code) {
		const bent = Buffer.from(f.bytes);
		bend(bent);
		let got = null;
		try { CRYPT.decryptFragment(u8(bent), MATERIAL, p.tracks); } catch (e) { got = e.code; }
		check(name, got === code, 'got ' + got);
	}

	// Each of these decrypts *something* if it is not caught: the wrong bytes,
	// at the wrong offsets, with no error and a picture to show for it.
	refuses('a fragment whose vector list is shorter than its sample list is refused',
		b => { b.writeUInt32BE(1, b.indexOf(Buffer.from('senc', 'ascii')) + 8); }, 'senc-mismatch');

	refuses('subsample lengths that do not add up to the sample are refused',
		b => {
			const at = b.indexOf(Buffer.from('senc', 'ascii')) + 12 + 4 + 8 + 2;
			b.writeUInt16BE(b.readUInt16BE(at) + 1, at);
		}, 'subsample-overrun');

	refuses('a payload shorter than the samples it claims is refused',
		b => { b.writeUInt32BE(0x7fffffff, b.indexOf(Buffer.from('trun', 'ascii')) + 20); },
		'subsample-overrun');

	// A box that stops early does not throw when it is read: past the end of a
	// Uint8Array every byte is undefined, and every bitwise operation turns
	// that into zero. So a sample table that lists a thousand samples and
	// carries ten reads as nine hundred and ninety samples of no length —
	// the walk completes, the fragment comes back, and nothing in it was
	// decrypted. That is the shape this refuses.
	(function truncatedTables() {
		const whole = fragment();
		const trunAt = whole.bytes.indexOf(Buffer.from('trun', 'ascii'));
		const bent = Buffer.from(whole.bytes);
		bent.writeUInt32BE(400, trunAt + 8);          // says 400 samples; carries two
		let code = null;
		try { CRYPT.decryptFragment(u8(bent), MATERIAL, p.tracks); } catch (e) { code = e.code; }
		check('a sample table that runs past its own box is refused', code === 'bad-trun',
			'got ' + code);

		const cut = Buffer.from(whole.bytes);
		const tfhdAt = cut.indexOf(Buffer.from('tfhd', 'ascii'));
		cut.writeUInt32BE(0x020031, tfhdAt + 4);      // claims a field it does not carry
		let code2 = null;
		try { CRYPT.decryptFragment(u8(cut), MATERIAL, p.tracks); } catch (e) { code2 = e.code; }
		check('and so is a header claiming a field it does not carry', code2 === 'bad-tfhd',
			'got ' + code2);
	})();

	let truncated = null;
	try {
		CRYPT.decryptFragment(u8(f.bytes.subarray(0, f.moofLen + 40)), MATERIAL, p.tracks);
	} catch (e) { truncated = e.code; }
	check('and a fragment whose payload is still being written is refused',
		truncated === 'short-fragment', 'got ' + truncated);
})();

// ---- the integrity chain ------------------------------------------------

group('the integrity chain');

(function chainWalk() {
	const initBytes = Buffer.from(init);
	const genesis = hmac(KMAC, Buffer.from('majestic-records-v1 genesis'), initBytes);

	// Two fragments, each tagged the way the camera tags one: over the
	// previous tag, this moof with its own tag field zeroed, and the mdat.
	function tagged(seq, prev) {
		const blank = fragment({ seq: seq });
		const tag = hmac(KMAC, prev, blank.bytes);
		return { f: fragment({ seq: seq, tag: tag }), tag: tag };
	}
	const one = tagged(1, genesis);
	const two = tagged(2, one.tag);

	const ch = CRYPT.chain(MATERIAL);
	check('the genesis tag is taken over the init segment as written',
		hex(ch.genesis(u8(initBytes))) === hex(genesis));
	const r1 = ch.step(u8(one.f.bytes));
	const r2 = ch.step(u8(two.f.bytes));
	check('and each fragment matches its own tag', r1.ok === true && r2.ok === true);
	check('and the count is what was walked', ch.fragments() === 2);

	// The two symmetrical mistakes, neither of which looks like a bug: hashing
	// the moof with its tag in place makes every clip read as tampered, and
	// never comparing makes every clip read as intact.
	const bent = Buffer.from(two.f.bytes);
	bent[bent.length - 5] ^= 1;
	const ch2 = CRYPT.chain(MATERIAL);
	ch2.genesis(u8(initBytes));
	ch2.step(u8(one.f.bytes));
	check('a flipped byte in the payload is caught at its own fragment',
		ch2.step(u8(bent)).ok === false);

	// A clip from a build that wrote no tag is not a clip that fails: it is a
	// clip nothing can say anything about, which is a third answer.
	const untagged = fragment({ seq: 3 });
	const stripped = Buffer.concat([
		untagged.bytes.subarray(0, untagged.bytes.indexOf(INTEGRITY_UUID) - 8),
		untagged.bytes.subarray(untagged.bytes.indexOf(INTEGRITY_UUID) - 8 + 60),
	]);
	stripped.writeUInt32BE(untagged.moofLen - 60, 0);
	const ch3 = CRYPT.chain(MATERIAL);
	ch3.genesis(u8(initBytes));
	check('a fragment carrying no tag is unknown, neither intact nor broken',
		ch3.step(u8(stripped)).unknown === true);
})();

done();
