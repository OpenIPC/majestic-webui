// The key this browser holds for encrypted recordings, and the panel for it.
//
// Public-key mode seals every clip to a key the camera cannot open — that is
// the whole point of it, and it is the only mode that survives somebody
// walking off with the camera. Which means the private half has to live
// somewhere, and the somewhere is here: wrapped under a passphrase, in this
// browser's own storage, for this camera's origin.
//
// WHAT THAT IS AND IS NOT. It is a convenience, so that opening a day of
// recordings costs one unlock rather than a file picker per clip. It is not a
// backup. Browser storage is cleared by the browser, by a profile that moves,
// by a camera that changes address; the PEM the operator downloads at
// generation is the copy that matters, and the panel says so at the moment it
// is generated rather than in a help page nobody reaches.
//
// GENERATION IS THE ONE THING THAT NEEDS MORE THAN THIS PAGE HAS. Making an
// RSA key means finding primes, and the only sound way to do that in a browser
// is crypto.subtle.generateKey — which exists only in a secure context, and a
// camera is http:// on a LAN. So generation is offered where the page happens
// to be served securely, and everywhere else the panel prints the two openssl
// commands and takes the PEM. Everything else — unlocking, opening a
// recording, publishing the public half to the camera — is this tree's own
// code and works on any camera as it ships.
window.MajesticRecKeys = (function () {
	'use strict';

	const C = window.MajesticCrypto;

	const DB_NAME = 'mj-rec-keys';
	const STORE = 'keys';
	const RECORD_ID = 'owner';
	const RECORD_VERSION = 1;

	// The cost of one unlock, paid on this machine rather than the camera. High
	// enough to be worth having in front of a key, low enough that a person
	// waits rather than wonders. Stored in the record, so a future figure does
	// not lock anybody out of a key wrapped under this one.
	const WRAP_ITERATIONS = 200000;

	// Opening the database can resolve, fail, be blocked — or do none of the
	// three, which is what a browser with storage disabled sometimes does. A
	// panel that waits for that answer for ever reads as "checking…" and never
	// moves, so the wait is bounded and the timeout is an answer: this browser
	// cannot store a key.
	const OPEN_TIMEOUT_MS = 3000;

	function idb() {
		return new Promise(function (resolve) {
			let settled = false;
			const finish = function (v) { if (!settled) { settled = true; resolve(v); } };
			let req;
			try {
				if (typeof indexedDB === 'undefined') return finish(null);
				req = indexedDB.open(DB_NAME, 1);
			} catch (e) {
				return finish(null);
			}
			setTimeout(function () { finish(null); }, OPEN_TIMEOUT_MS);
			req.onupgradeneeded = function () {
				try { req.result.createObjectStore(STORE); } catch (e) { /* already there */ }
			};
			req.onsuccess = function () { finish(req.result); };
			req.onerror = function () { finish(null); };
			req.onblocked = function () { finish(null); };
		});
	}

	function withStore(mode, fn) {
		return idb().then(function (db) {
			if (!db) return null;
			return new Promise(function (resolve) {
				let out = null;
				let tx;
				try {
					tx = db.transaction(STORE, mode);
				} catch (e) {
					db.close();
					return resolve(null);
				}
				const req = fn(tx.objectStore(STORE));
				if (req) req.onsuccess = function () { out = req.result; };
				tx.oncomplete = function () { db.close(); resolve(out === undefined ? null : out); };
				tx.onerror = function () { db.close(); resolve(null); };
				tx.onabort = function () { db.close(); resolve(null); };
			});
		});
	}

	// ---- wrapping, which is the part with no browser in it ----------------

	// PBKDF2 over the unlock passphrase, then encrypt-then-MAC: AES-128-CTR for
	// the key bytes and HMAC-SHA256 over everything that decides how to read
	// them. The MAC is what makes a wrong passphrase an answer — without it the
	// unlock would hand a garbage private key to the parser, whose complaint
	// says nothing about passphrases and sends someone to clear their browser
	// storage over a typo.
	function derive(passphrase, salt, iterations) {
		const k = C.pbkdf2Sha256(passphrase, salt, iterations, 48);
		return { enc: k.subarray(0, 16), mac: k.subarray(16) };
	}

	function macOver(macKey, rec, ct) {
		return C.hmacSha256(macKey, C.concat([
			C.utf8('mj-rec-key-v' + rec.v + ':' + rec.iterations + ':' + (rec.form || 'pkcs8')),
			rec.salt, rec.iv, ct,
		]));
	}

	function wrap(der, passphrase, meta, form) {
		const salt = C.randomBytes(16);
		const iv = C.randomBytes(16);
		const rec = {
			v: RECORD_VERSION,
			iterations: WRAP_ITERATIONS,
			form: form || 'pkcs8',
			salt: salt,
			iv: iv,
			spki: meta.spki,
			fingerprint: meta.fingerprint,
			bits: meta.bits,
			createdAt: new Date().toISOString(),
		};
		const k = derive(passphrase, salt, rec.iterations);
		rec.ct = C.aes128CtrXor(k.enc, iv, der);
		rec.mac = macOver(k.mac, rec, rec.ct);
		return rec;
	}

	// null for a wrong passphrase — an answer, not a failure. Anything else is
	// a record this build cannot read, which is a different sentence.
	function unwrap(rec, passphrase) {
		if (!rec || rec.v !== RECORD_VERSION) return null;
		const k = derive(passphrase, rec.salt, rec.iterations);
		if (!C.ctEqual(macOver(k.mac, rec, rec.ct), rec.mac)) return null;
		return C.aes128CtrXor(k.enc, rec.iv, rec.ct);
	}

	// A stored key is DER, and DER alone does not say which of the two shapes
	// openssl writes it is. The record carries that, and this puts the label
	// back before parsing: read as the wrong one, a perfectly good key looks
	// like a damaged record, and the panel would tell somebody their key is
	// broken when the only thing wrong is a missing word.
	function keyFromDer(der, form) {
		return C.parsePrivateKeyPem(
			C.pemWrap(form === 'pkcs1' ? 'RSA PRIVATE KEY' : 'PRIVATE KEY', der));
	}

	function metaFor(key) {
		return {
			spki: C.pemBody(C.publicKeyPem(key), 'PUBLIC KEY').bytes,
			fingerprint: C.hex(C.publicKeyFingerprint(key)),
			bits: key.size * 8,
		};
	}

	// A PEM the operator brings, from openssl or from another browser. Both
	// forms openssl writes are accepted; the passphrase is this browser's own,
	// not the camera's.
	function importPem(pem, passphrase) {
		const key = C.parsePrivateKeyPem(pem);       // throws on anything that is not one
		const body = C.pemBody(pem);
		const meta = metaFor(key);
		const form = body.label.indexOf('RSA PRIVATE KEY') >= 0 ? 'pkcs1' : 'pkcs8';
		return {
			record: wrap(body.bytes, passphrase, meta, form),
			key: key,
			meta: meta,
		};
	}

	// ---- generation, where the page is served securely enough for it -------

	function canGenerate() {
		return typeof crypto === 'object' && !!crypto.subtle &&
			typeof window === 'object' && window.isSecureContext === true;
	}

	function generate(passphrase) {
		if (!canGenerate())
			return Promise.reject(new Error('this page is not served over a connection the browser will make keys on'));
		return crypto.subtle.generateKey({
			name: 'RSA-OAEP',
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: 'SHA-256',
		}, true, ['encrypt', 'decrypt']).then(function (pair) {
			return crypto.subtle.exportKey('pkcs8', pair.privateKey);
		}).then(function (der) {
			const pkcs8 = new Uint8Array(der);
			const key = keyFromDer(pkcs8, 'pkcs8');
			const meta = metaFor(key);
			return {
				record: wrap(pkcs8, passphrase, meta, 'pkcs8'),
				privatePem: C.pemWrap('PRIVATE KEY', pkcs8),
				publicPem: C.publicKeyPem(key),
				key: key,
				meta: meta,
			};
		});
	}

	// ---- the ring: what this page can open, for as long as it is open -----

	// Keyed by the clip's own key id, because one camera writes one key id
	// across a day of recordings: the first clip's prompt covers the rest of
	// the day and every seek within them. Nothing here is written anywhere —
	// it dies with the tab, which is what the panel tells the operator.
	const ring = Object.create(null);
	let unlocked = null;          // the private key, for this page load only
	let unlockedMeta = null;

	function remember(kidHex, material) { ring[kidHex] = material; }
	function known(kidHex) { return ring[kidHex] || null; }
	function forget(kidHex) { delete ring[kidHex]; }
	function forgetAll() {
		for (const k in ring) delete ring[k];
		unlocked = null;
		unlockedMeta = null;
	}
	function holdKey(key, meta) { unlocked = key; unlockedMeta = meta; }
	function heldKey() { return unlocked; }
	function heldMeta() { return unlockedMeta; }

	const api = {
		DB_NAME: DB_NAME,
		WRAP_ITERATIONS: WRAP_ITERATIONS,
		wrap: wrap,
		unwrap: unwrap,
		keyFromDer: keyFromDer,
		metaFor: metaFor,
		importPem: importPem,
		canGenerate: canGenerate,
		generate: generate,
		load: function () { return withStore('readonly', function (s) { return s.get(RECORD_ID); }); },
		save: function (rec) { return withStore('readwrite', function (s) { return s.put(rec, RECORD_ID); }); },
		remove: function () { return withStore('readwrite', function (s) { return s.delete(RECORD_ID); }); },
		available: function () { return idb().then(function (db) { if (db) db.close(); return !!db; }); },
		remember: remember, known: known, forget: forget, forgetAll: forgetAll,
		holdKey: holdKey, heldKey: heldKey, heldMeta: heldMeta,
	};

	if (typeof module === 'object' && module.exports) module.exports = api;
	return api;
})();
