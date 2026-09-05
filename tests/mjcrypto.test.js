// MajesticCrypto — the primitives, against the vectors that define them.
//
// This file exists because the module it tests is a transcription. SHA-256,
// HMAC, HKDF, PBKDF2, AES-128-CTR and RSA-OAEP are all published, none of them
// is invented here, and every way of getting one wrong produces confident
// garbage rather than an error: a swapped rotate in the compression function,
// an HKDF label in the wrong order, a counter that increments the wrong end of
// the block. None of that throws. It decrypts a recording into noise, or
// derives a key that opens nothing, and the page says the passphrase was wrong.
//
// So every function is pinned to a vector from the document that defines it,
// and the RSA fixture was made once with openssl — an implementation with no
// shared ancestry with this one — and committed under tests/fixtures/.
//
// A failure here means this tree is wrong. It has never meant the vector was.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const SRC = path.join(__dirname, '..', 'www', 'a', 'mjcrypto.js');
const FIX = path.join(__dirname, 'fixtures');

function load() {
	const ctx = {
		window: {},
		console: console,
		TextEncoder: TextEncoder,
		crypto: globalThis.crypto,
		Buffer: Buffer,
		module: undefined,
	};
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx);
	return ctx.window.MajesticCrypto;
}

const C = load();
const hex = C.hex;
const fromHex = C.fromHex;

function ascii(s) {
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
	return out;
}

// ---- SHA-256, FIPS 180-4 ------------------------------------------------

group('sha256');

check('empty string',
	hex(C.sha256(new Uint8Array(0))) ===
	'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');

check('"abc"',
	hex(C.sha256('abc')) ===
	'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

// 448 bits: the case that exercises the two-block padding path.
check('56-byte message',
	hex(C.sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')) ===
	'248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');

// The length is written as a 64-bit count. A 32-bit one is right until a
// message passes 512 MB, which is exactly what the integrity check hashes.
check('a message that crosses a padding block boundary',
	hex(C.sha256(new Uint8Array(64))) ===
	'f5a5fd42d16a20302798ef6ed309979b43003d2320d9f0e8ea9831a92759fb4b');

(function longMessage() {
	const h = new C.Sha256();
	const chunk = new Uint8Array(1000).fill(0x61); // 'a'
	for (let i = 0; i < 1000; i++) h.update(chunk);
	check('one million "a", streamed in chunks',
		hex(h.digest()) ===
		'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
})();

// ---- HMAC-SHA256, RFC 4231 ----------------------------------------------

group('hmac-sha256');

check('RFC 4231 case 1',
	hex(C.hmacSha256(new Uint8Array(20).fill(0x0b), 'Hi There')) ===
	'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');

check('RFC 4231 case 2',
	hex(C.hmacSha256('Jefe', 'what do ya want for nothing?')) ===
	'5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');

check('RFC 4231 case 3',
	hex(C.hmacSha256(new Uint8Array(20).fill(0xaa), new Uint8Array(50).fill(0xdd))) ===
	'773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe');

// A key longer than the block, which is hashed first — the branch a short
// vector never reaches.
check('RFC 4231 case 6, key longer than the block',
	hex(C.hmacSha256(new Uint8Array(131).fill(0xaa),
		'Test Using Larger Than Block-Size Key - Hash Key First')) ===
	'60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54');

// ---- HKDF, RFC 5869 -----------------------------------------------------

group('hkdf-sha256');

(function rfc5869Case1() {
	const ikm = new Uint8Array(22).fill(0x0b);
	const salt = fromHex('000102030405060708090a0b0c');
	const info = fromHex('f0f1f2f3f4f5f6f7f8f9');
	const prk = C.hkdfExtract(salt, ikm);
	check('extract',
		hex(prk) === '077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5');
	check('expand, 42 bytes',
		hex(C.hkdfExpand(prk, info, 42)) ===
		'3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');
})();

(function rfc5869Case3() {
	// Zero-length salt and info: the case where a "helpful" default salt or a
	// skipped info would still produce plausible output.
	const prk = C.hkdfExtract(new Uint8Array(32), new Uint8Array(22).fill(0x0b));
	check('extract with a zero salt',
		hex(prk) === '19ef24a32c717b167f33a91d6f648bdf96596776afdb6377ac434c1c293ccb04');
	check('expand with empty info',
		hex(C.hkdfExpand(prk, new Uint8Array(0), 42)) ===
		'8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8');
})();

// ---- PBKDF2-HMAC-SHA256, RFC 7914 §11 -----------------------------------

group('pbkdf2-sha256');

check('one iteration',
	hex(C.pbkdf2Sha256('passwd', 'salt', 1, 64)) ===
	'55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc' +
	'49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783');

// The slow one, and the reason the module keys the HMAC once and replays the
// inner state: at 80 000 iterations a per-call key schedule is most of the run.
(function slow() {
	const t0 = Date.now();
	const out = C.pbkdf2Sha256('Password', 'NaCl', 80000, 64);
	const ms = Date.now() - t0;
	check('80 000 iterations',
		hex(out) ===
		'4ddcd8f60b98be21830cee5ef22701f9641a4418d04c0414aeff08876b34ab56' +
		'a1d425a1225833549adb841b51c9b3176a272bdebba1d078478f62b397f33c8d');
	// Not a threshold to fail on — a busy machine is not a broken one — but a
	// number the next reader needs, because this cost lands on the person
	// opening a recording.
	console.log('       (80 000 iterations took ' + ms + ' ms here; the camera asks for 100 000)');
})();

// ---- AES-128-CTR, NIST SP 800-38A F.5 -----------------------------------

group('aes-128-ctr');

(function nistF5() {
	const key = fromHex('2b7e151628aed2a6abf7158809cf4f3c');
	const ctr0 = fromHex('f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff');
	const plain = fromHex(
		'6bc1bee22e409f96e93d7e117393172a' +
		'ae2d8a571e03ac9c9eb76fac45af8e51' +
		'30c81c46a35ce411e5fbc1191a0a52ef' +
		'f69f2445df4f9b17ad2b417be66c3710');
	const want =
		'874d6191b620e3261bef6864990db6ce' +
		'9806f66b7970fdff8617187bb9fffdff' +
		'5ae4df3edbd5d35e5b4f09020db03eab' +
		'1e031dda2fbe03d1792170a0f3009cee';
	check('four blocks, encryption direction',
		hex(C.aes128CtrXor(key, ctr0, plain)) === want);
	check('and back again — CTR is its own inverse',
		hex(C.aes128CtrXor(key, ctr0, fromHex(want))) === hex(plain));
})();

(function carry() {
	// The counter is the whole sixteen-byte block. Starting one block below a
	// carry across every byte is where a 32-bit or 64-bit increment stops
	// agreeing with the camera, and nothing about the output would say so.
	const key = fromHex('2b7e151628aed2a6abf7158809cf4f3c');
	const at = fromHex('ffffffffffffffffffffffffffffffff');
	const two = C.aes128CtrXor(key, at, new Uint8Array(32));
	const second = C.aes128CtrXor(key, new Uint8Array(16), new Uint8Array(16));
	check('the counter carries past every byte and wraps to zero',
		hex(two.subarray(16)) === hex(second));
})();

(function longStream() {
	// A single block vector exercises one path through the tables and can pass
	// with an S-box entry wrong: most blocks never touch a given byte, and one
	// that touches a wrong entry only in the last round comes out with a
	// single byte wrong — inside a frame, that is a smear on one macroblock.
	// So a long stream is compared against an implementation with no shared
	// ancestry with this one. It is the same argument as the RSA fixture,
	// and it is what caught exactly that bug.
	const key = fromHex('603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4');
	const k128 = key.subarray(0, 16);
	const iv = fromHex('f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff');
	const zeros = new Uint8Array(4096);
	const mine = hex(C.aes128CtrXor(k128, iv, zeros));
	const theirs = require('crypto')
		.createCipheriv('aes-128-ctr', Buffer.from(k128), Buffer.from(iv))
		.update(Buffer.from(zeros)).toString('hex');
	check('4 KiB of keystream matches an independent implementation', mine === theirs);
})();

(function streaming() {
	// One sample's protected runs are handed over one after another and must
	// come out as one keystream. A run is a NAL minus a five-byte clear
	// prefix, so it is never a multiple of the block size — and a per-run
	// counter reset still decodes the first run correctly, which is what makes
	// this failure invisible without a vector like this one.
	const key = fromHex('2b7e151628aed2a6abf7158809cf4f3c');
	const iv = fromHex('cafebabefacedbad0000000000000000');
	const whole = new Uint8Array(100);
	for (let i = 0; i < whole.length; i++) whole[i] = i;
	const oneCall = C.aes128CtrXor(key, iv, whole);

	const piecewise = whole.slice();
	const s = C.ctr(key, iv);
	s.xor(piecewise, 0, 37);   // deliberately not a multiple of 16
	s.xor(piecewise, 37, 11);
	s.xor(piecewise, 48, 52);
	check('three unaligned runs equal one call over the same bytes',
		hex(piecewise) === hex(oneCall));

	const perRun = whole.slice();
	C.ctr(key, iv).xor(perRun, 0, 37);
	C.ctr(key, iv).xor(perRun, 37, 11);
	check('and a counter restarted per run does NOT — this is the trap',
		hex(perRun.subarray(37, 48)) !== hex(oneCall.subarray(37, 48)));
})();

// ---- RSA-OAEP, against openssl ------------------------------------------

group('rsa-oaep');

(function rsa() {
	const pkcs8 = fs.readFileSync(path.join(FIX, 'rsa-oaep.key.pem'), 'utf8');
	const pkcs1 = fs.readFileSync(path.join(FIX, 'rsa-oaep.key.pkcs1.pem'), 'utf8');
	const pub = fs.readFileSync(path.join(FIX, 'rsa-oaep.pub.pem'), 'utf8');
	const plain = fs.readFileSync(path.join(FIX, 'rsa-oaep.plain.txt'));
	const ct = fromHex(fs.readFileSync(path.join(FIX, 'rsa-oaep.ct.hex'), 'utf8')
		.split('\n').filter(l => l && l[0] !== '#').join(''));

	const key = C.parsePrivateKeyPem(pkcs8);
	check('a PKCS#8 key parses to a 2048-bit modulus', key.size === 256);
	check('openssl\'s OAEP ciphertext opens to the 48 bytes it sealed',
		hex(C.rsaOaepDecrypt(key, ct)) === hex(new Uint8Array(plain)));

	// openssl writes PKCS#8 by default and PKCS#1 with -traditional; a person
	// picking a file off their disk may hand over either.
	const key1 = C.parsePrivateKeyPem(pkcs1);
	check('the same key in PKCS#1 form opens the same ciphertext',
		hex(C.rsaOaepDecrypt(key1, ct)) === hex(new Uint8Array(plain)));

	// A wrong key must be refused rather than returning padding-shaped noise.
	let refused = false;
	try {
		const other = C.parsePrivateKeyPem(makeOtherKey());
		C.rsaOaepDecrypt(other, ct);
	} catch (e) { refused = true; }
	check('another key is refused, not answered with rubbish', refused);

	// Every ciphertext byte matters: a flip anywhere breaks the padding.
	const bent = ct.slice();
	bent[100] ^= 1;
	let bentRefused = false;
	try { C.rsaOaepDecrypt(key, bent); } catch (e) { bentRefused = true; }
	check('a flipped ciphertext byte is refused', bentRefused);

	// The public half this tree writes has to be the public half openssl
	// writes, byte for byte, or the camera seals to a key it names differently
	// from the one this page holds.
	check('the SPKI PEM matches openssl\'s',
		C.publicKeyPem(key).replace(/\s+/g, '') === pub.replace(/\s+/g, ''));

	const want = require('crypto')
		.createHash('sha256')
		.update(require('crypto').createPublicKey(pub).export({ type: 'spki', format: 'der' }))
		.digest('hex').slice(0, 16);
	check('the fingerprint is SHA-256 over that DER, truncated to eight bytes',
		hex(C.publicKeyFingerprint(key)) === want);
})();

function makeOtherKey() {
	const { generateKeyPairSync } = require('crypto');
	return generateKeyPairSync('rsa', {
		modulusLength: 2048,
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		publicKeyEncoding: { type: 'spki', format: 'pem' },
	}).privateKey;
}

// ---- the small things everything else leans on --------------------------

group('helpers');

check('constant-time compare agrees with a normal one',
	C.ctEqual(fromHex('00ff10'), fromHex('00ff10')) &&
	!C.ctEqual(fromHex('00ff10'), fromHex('00ff11')) &&
	!C.ctEqual(fromHex('00ff'), fromHex('00ff00')));

check('utf8 encodes beyond ASCII, so a passphrase with an accent in it derives the same key everywhere',
	hex(C.utf8('pässwörd')) === hex(Buffer.from('pässwörd', 'utf8')));

check('random bytes come from the platform and differ',
	hex(C.randomBytes(16)) !== hex(C.randomBytes(16)));

done();
