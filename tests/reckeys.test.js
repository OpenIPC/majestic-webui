// MajesticRecKeys — the private key this browser holds, and how it is wrapped.
//
// The half tested here is the half with no browser in it: turning a PEM into a
// stored record and back. Its failure is silent in a particular way. An unlock
// that ignored the authentication tag would hand a garbage key to the parser,
// and the parser's complaint says nothing about passphrases — so a typo
// arrives as "this browser is broken", and the advice that follows is to clear
// the site's storage, which destroys the key. The tag turning a wrong
// passphrase into an answer is what this file pins.
//
// The IndexedDB half is deliberately not tested. It fails loudly, with an
// exception a person can see, and a fake object store would only test the fake.
'use strict';

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
		setTimeout: setTimeout,
		indexedDB: undefined,
	};
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'www', 'a', 'mjcrypto.js'), 'utf8'), ctx);
	vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'www', 'a', 'reckeys.js'), 'utf8'), ctx);
	return ctx.window;
}

const W = load();
const K = W.MajesticRecKeys;
const C = W.MajesticCrypto;

const PEM = fs.readFileSync(path.join(FIX, 'rsa-oaep.key.pem'), 'utf8');
const PEM1 = fs.readFileSync(path.join(FIX, 'rsa-oaep.key.pkcs1.pem'), 'utf8');
const PUB = fs.readFileSync(path.join(FIX, 'rsa-oaep.pub.pem'), 'utf8');
const UNLOCK = 'this browser only';

group('wrapping the key this browser holds');

(function roundTrip() {
	const der = C.pemBody(PEM).bytes;
	const key = C.parsePrivateKeyPem(PEM);
	const rec = K.wrap(der, UNLOCK, K.metaFor(key), 'pkcs8');

	check('the record carries what is needed to unwrap it and nothing more',
		rec.v === 1 && rec.iterations === K.WRAP_ITERATIONS &&
		rec.salt.length === 16 && rec.iv.length === 16 &&
		rec.mac.length === 32 && rec.ct.length === der.length);

	check('the key itself is not in it',
		Buffer.from(rec.ct).indexOf(Buffer.from(der.subarray(0, 32))) < 0);

	check('the public half and its fingerprint are, so the panel can name the key without unlocking it',
		rec.fingerprint === C.hex(C.publicKeyFingerprint(key)) && rec.bits === 2048);

	const back = K.unwrap(rec, UNLOCK);
	check('the right passphrase gives the key back, byte for byte',
		back && C.hex(back) === C.hex(der));

	check('and it parses as the key it started as',
		C.hex(C.publicKeyFingerprint(K.keyFromDer(back, rec.form))) === rec.fingerprint);
})();

(function wrongPassphrase() {
	const der = C.pemBody(PEM).bytes;
	const rec = K.wrap(der, UNLOCK, K.metaFor(C.parsePrivateKeyPem(PEM)), 'pkcs8');

	check('a wrong passphrase is an answer, not an exception',
		K.unwrap(rec, UNLOCK + '!') === null);

	// Everything the unlock depends on is covered by the tag. A record whose
	// salt, iteration count or ciphertext was edited must not unwrap to
	// something that merely looks like a key — the parser would then decide
	// what to say, and it has no idea a passphrase was involved.
	const bends = [
		['salt', r => { r.salt[0] ^= 1; }],
		['the initialisation vector', r => { r.iv[3] ^= 1; }],
		['the iteration count', r => { r.iterations += 1; }],
		['the stored key form', r => { r.form = 'pkcs1'; }],
		['the ciphertext', r => { r.ct[10] ^= 1; }],
		['the tag itself', r => { r.mac[31] ^= 1; }],
	];
	bends.forEach(function (b) {
		const bent = Object.assign({}, rec, {
			salt: rec.salt.slice(), iv: rec.iv.slice(), ct: rec.ct.slice(), mac: rec.mac.slice(),
		});
		b[1](bent);
		check('a record with ' + b[0] + ' changed is refused', K.unwrap(bent, UNLOCK) === null);
	});

	check('and a record from a version this build does not know is refused',
		K.unwrap(Object.assign({}, rec, { v: 99 }), UNLOCK) === null);
})();

(function hostileRecord() {
	const der = C.pemBody(PEM).bytes;
	const rec = K.wrap(der, UNLOCK, K.metaFor(C.parsePrivateKeyPem(PEM)), 'pkcs8');

	// The record states its own unlock cost, so the record decides how long
	// this page stops responding. Browser storage is not a trusted input —
	// another tab, an extension, a profile carried between machines — and
	// stretching a passphrase two billion times cannot be interrupted once it
	// has started. The shape is therefore checked before any work happens,
	// and the check has to be cheap: the assertion below is that it returns
	// rather than that it returns quickly, but a regression here is a browser
	// that never comes back.
	const t0 = Date.now();
	const absurd = K.unwrap(Object.assign({}, rec, { iterations: 2e9 }), UNLOCK);
	check('an unlock cost no one would choose is refused without doing it',
		absurd === null && Date.now() - t0 < 500);

	[['a fractional cost', { iterations: 1.5 }],
	 ['an infinite one', { iterations: Infinity }],
	 ['a cost that is not a number', { iterations: '200000' }],
	 ['a salt of the wrong size', { salt: new Uint8Array(4) }],
	 ['a salt that is not bytes', { salt: 'aaaa' }],
	 ['a tag of the wrong size', { mac: new Uint8Array(8) }],
	 ['no ciphertext at all', { ct: new Uint8Array(0) }],
	].forEach(function (b) {
		check(b[0] + ' is refused', K.unwrap(Object.assign({}, rec, b[1]), UNLOCK) === null);
	});

	// The bound is a maximum and not the figure this build writes: a key
	// wrapped by a later version under a costlier setting still has to open.
	const dearer = K.wrap(der, UNLOCK, K.metaFor(C.parsePrivateKeyPem(PEM)), 'pkcs8');
	dearer.iterations = K.MAX_WRAP_ITERATIONS;
	check('but a cost higher than today\'s, and still sane, is accepted as a shape',
		K.usable(dearer) === true);
})();

group('taking a key an operator brings');

(function imported() {
	const got = K.importPem(PEM, UNLOCK);
	check('a PKCS#8 PEM is accepted and named by its fingerprint',
		got.meta.fingerprint === C.hex(C.publicKeyFingerprint(C.parsePrivateKeyPem(PEM))));
	check('and unwraps again to a usable key',
		C.hex(C.publicKeyFingerprint(K.keyFromDer(K.unwrap(got.record, UNLOCK), got.record.form))) ===
		got.meta.fingerprint);

	// openssl writes PKCS#8 by default and PKCS#1 with -traditional, and
	// refusing the second would reject the file half the instructions on the
	// internet produce for a key that is perfectly good. They are the same key
	// in different clothes, and DER does
	// not say which it is wearing. Storing one and reading it back as the
	// other makes a good key look like a damaged record — so the record says,
	// and this walks the whole way round rather than stopping at the import.
	const old = K.importPem(PEM1, UNLOCK);
	check('so is the older PEM form, and it names the same key',
		old.meta.fingerprint === got.meta.fingerprint);
	check('and that one survives the round trip through storage too',
		C.hex(C.publicKeyFingerprint(K.keyFromDer(K.unwrap(old.record, UNLOCK), old.record.form))) ===
		got.meta.fingerprint);
	check('with the form recorded beside it', old.record.form === 'pkcs1' && got.record.form === 'pkcs8');

	check('and the public half it derives is the one openssl derives',
		C.publicKeyPem(C.parsePrivateKeyPem(PEM)).replace(/\s+/g, '') === PUB.replace(/\s+/g, ''));

	let refused = null;
	try { K.importPem(PUB, UNLOCK); } catch (e) { refused = e.message; }
	check('handing it a public key says so, rather than storing something useless',
		refused !== null && /public key|not a private key/i.test(refused), refused);

	let junk = null;
	try { K.importPem('hello', UNLOCK); } catch (e) { junk = e.message; }
	check('and so does handing it something that is not a PEM at all',
		junk !== null && /PEM/.test(junk));
})();

group('what the page holds while it is open');

(function ring() {
	K.forgetAll();
	check('nothing is known to start with', K.known('aa') === null && K.heldKey() === null);
	K.remember('aa', new Uint8Array([1, 2, 3]));
	check('a clip opened once is remembered by its key id', K.known('aa').length === 3);
	check('and another clip is not', K.known('bb') === null);
	K.forget('aa');
	check('forgetting one forgets only that one', K.known('aa') === null);

	K.remember('cc', new Uint8Array(1));
	K.holdKey({ size: 256 }, { fingerprint: 'ff' });
	K.forgetAll();
	check('and forgetting everything takes the private key with it',
		K.known('cc') === null && K.heldKey() === null && K.heldMeta() === null);
})();

group('generating one');

check('is refused outright where the browser will not make keys — which is every plain-http camera',
	K.canGenerate() === false);

done();
