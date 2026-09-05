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
			let timer = null;
			const finish = function (v) {
				if (settled) return false;
				settled = true;
				if (timer !== null) clearTimeout(timer);
				resolve(v);
				return true;
			};
			let req;
			try {
				if (typeof indexedDB === 'undefined') return finish(null);
				req = indexedDB.open(DB_NAME, 1);
			} catch (e) {
				return finish(null);
			}
			timer = setTimeout(function () { finish(null); }, OPEN_TIMEOUT_MS);
			req.onupgradeneeded = function () {
				try { req.result.createObjectStore(STORE); } catch (e) { /* already there */ }
			};
			req.onsuccess = function () {
				// An open that arrives after the wait gave up still holds a
				// connection, and a connection nobody closes blocks the next
				// version change for the life of the tab — so a late answer is
				// closed rather than dropped on the floor.
				if (!finish(req.result)) req.result.close();
			};
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

	// The record says how much work its own unlock costs, which means the
	// record decides how long this page freezes. Browser storage is not a
	// trusted input — another tab, an extension, a profile carried between
	// machines, a record from a build that stored something else — and
	// stretching a passphrase two billion times cannot be interrupted once it
	// starts, so the shape is checked before any of it runs. The bound is a
	// maximum rather than the current figure: a key wrapped under a later,
	// costlier setting must still open here.
	const MAX_WRAP_ITERATIONS = 4000000;

	function usable(rec) {
		if (!rec || rec.v !== RECORD_VERSION) return false;
		if (typeof rec.iterations !== 'number' || !isFinite(rec.iterations) ||
			rec.iterations < 1 || rec.iterations > MAX_WRAP_ITERATIONS ||
			Math.floor(rec.iterations) !== rec.iterations) return false;
		const bytes = function (x, n) {
			return x instanceof Uint8Array && (n === undefined ? x.length > 0 : x.length === n);
		};
		return bytes(rec.salt, 16) && bytes(rec.iv, 16) && bytes(rec.mac, 32) && bytes(rec.ct);
	}

	// null for a wrong passphrase — an answer, not a failure. Anything else is
	// a record this build cannot read, which is a different sentence.
	function unwrap(rec, passphrase) {
		if (!usable(rec)) return null;
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
		usable: usable,
		MAX_WRAP_ITERATIONS: MAX_WRAP_ITERATIONS,
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

// ---------------------------------------------------------------------------
// The panel, and the one question the recordings page asks it.
//
// Kept in the same file as the store it drives, because everything here is
// about presenting that store's four states — no key, locked, unlocked, cannot
// store one — and a second file would only move the state machine away from
// the thing it describes.
window.MajesticRecKeys.ui = (function () {
	'use strict';

	const K = window.MajesticRecKeys;
	const C = window.MajesticCrypto;

	// Where the public half goes on the camera, and the setting that points at
	// it. One place, because the panel writes both and a disagreement between
	// them is a camera that seals recordings to a file it cannot read.
	const PUBLIC_PATH = '/etc/records-owner.pub';
	const PUBLIC_KEY_SETTING = 'records.publicKey';

	let record = null;          // what storage holds, or null
	let storable = null;        // whether this browser can store anything
	let pending = null;         // the question the lock panel is asking

	function $id(id) { return document.getElementById(id); }

	function esc(t) {
		return String(t == null ? '' : t)
			.replace(/&/g, '&amp;').replace(/</g, '&lt;')
			.replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	// A fingerprint people are meant to compare by eye, not read as a number.
	function fp(hex) {
		return String(hex || '').replace(/(..)(?=.)/g, '$1 ').toUpperCase();
	}

	function refresh() {
		return K.available().then(function (ok) {
			storable = ok;
			return ok ? K.load() : null;
		}).then(function (rec) {
			record = rec || null;
			render();
			return record;
		});
	}

	function state() {
		if (storable === false) return 'unstorable';
		if (!record) return 'none';
		return K.heldKey() ? 'unlocked' : 'locked';
	}

	function chip() {
		switch (state()) {
		case 'unlocked': return '<span class="badge text-bg-success">Key unlocked</span>';
		case 'locked': return '<span class="badge text-bg-secondary">Key locked</span>';
		case 'unstorable': return '<span class="badge text-bg-warning">This browser cannot store keys</span>';
		default: return '<span class="badge text-bg-secondary">No key on this device</span>';
		}
	}

	function render() {
		const body = $id('rec-keys-body');
		const head = $id('rec-keys-chip');
		if (head) head.innerHTML = chip();
		if (!body) return;

		let h = '';
		if (record) {
			h += '<div class="mb-3"><div class="fw-semibold">This device’s key</div>' +
				'<div class="font-monospace small">' + esc(fp(record.fingerprint)) + '</div>' +
				'<div class="x-small text-secondary">RSA-' + esc(record.bits) +
				(record.createdAt ? ', added ' + esc(String(record.createdAt).slice(0, 10)) : '') +
				'</div></div>';
			h += '<div class="d-flex flex-wrap gap-2 mb-3">' +
				(K.heldKey()
					? '<button class="btn btn-sm btn-outline-secondary" id="rec-keys-lock" type="button">Lock</button>'
					: '<button class="btn btn-sm btn-primary" id="rec-keys-unlock" type="button">Unlock</button>') +
				'<button class="btn btn-sm btn-outline-secondary" id="rec-keys-backup" type="button">Download a backup</button>' +
				'<button class="btn btn-sm btn-outline-secondary" id="rec-keys-publish" type="button">Save the public key to the camera</button>' +
				'<button class="btn btn-sm btn-outline-danger" id="rec-keys-forget" type="button">Remove</button>' +
				'</div>';
		} else {
			h += '<p class="small mb-3">No key on this device. A key is what opens recordings ' +
				'the camera sealed to its public half — the camera never holds the private one, ' +
				'which is why those recordings survive the camera being stolen.</p>';
		}

		if (!record || state() === 'none') {
			h += K.canGenerate()
				? '<div class="mb-3"><button class="btn btn-sm btn-primary" id="rec-keys-generate" type="button">Generate a key</button>' +
					'<div class="x-small text-secondary mt-1">Made in this browser. The private half never leaves it, ' +
					'and the backup you download is the only other copy.</div></div>'
				: '<div class="mb-3"><div class="small">This page is served over a connection the browser ' +
					'will not make keys on, so make one yourself and bring it here:</div>' +
					'<pre class="x-small mb-2">openssl genrsa -out owner.pem 2048\nopenssl rsa -in owner.pem -pubout -out owner.pub</pre></div>';
			h += '<div class="mb-2"><label class="form-label small" for="rec-keys-file">Or load a private key you already have</label>' +
				'<input class="form-control form-control-sm" type="file" id="rec-keys-file" accept=".pem,.key,text/plain"></div>';
		}

		if (storable === false)
			h += '<div class="x-small text-secondary">Nothing can be kept between visits here — a key you ' +
				'load will work until this page is closed. Private windows and blocked site data both do this.</div>';

		body.innerHTML = h;
		wire();
	}

	function ask(title, sentence, label, onGo) {
		pending = onGo;
		return '<div class="rec-lock-box"><div class="rec-lock-icon">🔒</div>' +
			'<p class="fw-semibold mb-1">' + esc(title) + '</p>' +
			'<p class="small">' + sentence + '</p>' +
			'<div class="input-group input-group-sm rec-lock-in">' +
			'<input type="password" class="form-control" id="rec-lock-pass" autocomplete="off">' +
			'<button class="btn btn-primary" id="rec-lock-go" type="button">' + esc(label) + '</button>' +
			'</div><div class="x-small text-secondary mt-2" id="rec-lock-why"></div></div>';
	}

	// The recordings page's one question: give me this clip's keys, or tell me
	// nothing here can. Resolves with the 48 bytes or with null, and null is an
	// answer — the panel has already said which of the several reasons it is.
	function needFor(box, opts) {
		const show = opts.show;
		const held = K.known(box.kidHex);
		if (held) return Promise.resolve(held);

		return refresh().then(function () {
			// A key already unlocked in this visit, and the clip sealed to it.
			const key = K.heldKey();
			const meta = K.heldMeta();
			if (key && box.pubkeyFp && meta && meta.fingerprint === box.pubkeyFp) {
				const got = window.MajesticMp4Crypt.openWithPrivateKey(box, key, meta.fingerprint);
				if (got.material) { K.remember(box.kidHex, got.material); show(''); return got.material; }
			}

			// Nothing in a browser opens a chip-bound recording: the key
			// unwraps inside the camera's own silicon and nowhere else. Said
			// plainly, with what to change so the next one can be opened.
			if (window.MajesticMp4Crypt.chipOnly(box))
				return refuse(show, 'Only the camera that recorded it can open this.',
					'This recording is bound to that camera’s hardware. Nothing in a browser can ' +
					'decode it, on this machine or any other. To be able to open future recordings ' +
					'here, add a recovery key or a passphrase in the recording settings.', opts);

			// Sealed to a key that is not this one. Naming the fingerprint is
			// what makes that sentence actionable rather than a dead end.
			if (box.pubkeyFp && record && record.fingerprint !== box.pubkeyFp && !hasPassphraseSlot(box))
				return refuse(show, 'This recording is locked to another key.',
					'It was sealed to the key ending ' + esc(fp(box.pubkeyFp.slice(-4))) +
					'; this device holds ' + esc(fp(record.fingerprint.slice(-4))) + '.', opts);

			if (box.pubkeyFp && record && record.fingerprint === box.pubkeyFp && !K.heldKey())
				return new Promise(function (resolve) {
					show(ask('This recording is sealed to your key.',
						'Unlock the key on this device to play it. The passphrase is the one you ' +
						'chose for this browser, not the camera’s.',
						'Unlock', function (pass, why) {
							const der = K.unwrap(record, pass);
							if (!der) return why('That passphrase does not unlock the key on this device.');
							const key2 = K.keyFromDer(der, record.form);
							K.holdKey(key2, { fingerprint: record.fingerprint });
							const got = window.MajesticMp4Crypt.openWithPrivateKey(box, key2, record.fingerprint);
							if (!got.material) return why(got.reason);
							K.remember(box.kidHex, got.material);
							show('');
							render();
							resolve(got.material);
						}));
				});

			if (hasPassphraseSlot(box))
				return new Promise(function (resolve) {
					show(ask('This recording is sealed.',
						'Enter the recording passphrase — the one set on the camera, in the ' +
						'recording settings. It opens every clip made while it was in force.',
						'Unlock', function (pass, why) {
							const got = window.MajesticMp4Crypt.openWithPassphrase(box, pass);
							if (!got.material) return why(got.reason);
							K.remember(box.kidHex, got.material);
							show('');
							resolve(got.material);
						}));
				});

			return refuse(show, 'Nothing on this device opens this recording.',
				'It carries no passphrase, and no key here matches the one it was sealed to.', opts);
		});
	}

	function hasPassphraseSlot(box) {
		return box.modes.indexOf('passphrase') >= 0;
	}

	function refuse(show, title, sentence, opts) {
		show('<div class="rec-lock-box"><div class="rec-lock-icon">🔒</div>' +
			'<p class="fw-semibold mb-1">' + esc(title) + '</p>' +
			'<p class="small">' + sentence + '</p>' +
			(opts && opts.download
				? '<a class="btn btn-sm btn-outline-secondary" download href="' + esc(opts.download) +
					'">Save the clip as recorded</a>'
				: '') +
			'</div>');
		return null;
	}

	// ---- the panel's own buttons -----------------------------------------

	function wire() {
		const on = function (id, fn) {
			const el = $id(id);
			if (el) el.addEventListener('click', fn);
		};
		on('rec-keys-unlock', function () { promptUnlock(); });
		on('rec-keys-lock', function () { K.forgetAll(); render(); });
		on('rec-keys-backup', function () { promptBackup(); });
		on('rec-keys-forget', function () { promptForget(); });
		on('rec-keys-generate', function () { promptGenerate(); });
		const file = $id('rec-keys-file');
		if (file) file.addEventListener('change', function () {
			const f = file.files && file.files[0];
			if (f) f.text().then(loadPem);
		});
	}

	function say(html, kind) {
		const el = $id('rec-keys-say');
		if (!el) return;
		el.className = html ? 'alert alert-' + (kind || 'secondary') + ' py-2 px-3 small mt-3' : 'd-none';
		el.innerHTML = html || '';
	}

	function promptUnlock() {
		const pass = window.prompt('Passphrase for the key on this device');
		if (pass === null) return;
		const der = K.unwrap(record, pass);
		if (!der) return say('That passphrase does not unlock the key on this device.', 'danger');
		K.holdKey(K.keyFromDer(der, record.form), { fingerprint: record.fingerprint });
		say('');
		render();
	}

	function promptBackup() {
		const pass = window.prompt('Passphrase for the key on this device');
		if (pass === null) return;
		const der = K.unwrap(record, pass);
		if (!der) return say('That passphrase does not unlock the key on this device.', 'danger');
		download('owner-' + record.fingerprint.slice(0, 8) + '.pem',
			C.pemWrap(record.form === 'pkcs1' ? 'RSA PRIVATE KEY' : 'PRIVATE KEY', der));
		say('Keep it somewhere you will still have it in three years. Lose every copy and every ' +
			'recording sealed to this key is gone — there is no way back into them.', 'warning');
	}

	function promptForget() {
		if (!window.confirm('Remove this key from this browser?\n\n' +
			'Recordings sealed to it stay sealed. Without a backup of the private key, nothing ' +
			'will ever open them again.')) return;
		K.forgetAll();
		K.remove().then(refresh).then(function () { say('The key is gone from this browser.', 'secondary'); });
	}

	function promptGenerate() {
		const pass = window.prompt('Choose a passphrase for this browser’s copy of the key');
		if (pass === null) return;
		if (!pass) return say('A key kept without a passphrase is a key anyone using this ' +
			'computer can read. Choose one.', 'warning');
		say('Making a key…');
		K.generate(pass).then(function (made) {
			download('owner-' + made.meta.fingerprint.slice(0, 8) + '.pem', made.privatePem);
			return keep(made.record, made.key, made.meta,
				'Made, and the private half has downloaded. <strong>That file is the only other ' +
				'copy</strong> — this browser’s is a convenience and goes when its storage does. ' +
				'Now save the public key to the camera so it starts sealing recordings to it.');
		}).catch(function (e) {
			say(esc(e.message || 'the key could not be made'), 'danger');
		});
	}

	// Storing can simply not happen — a private window, blocked site data, a
	// transaction that failed — and K.save() answers null when it did not. A
	// page that says "saved" anyway sends somebody away believing they have a
	// key here; the truthful answer is that it works for this visit and the
	// PEM is the only copy that outlives it. Either way the key is held in
	// memory, so the visit is usable rather than merely reported on.
	function keep(rec, key, meta, kept) {
		return K.save(rec).then(function (ok) {
			K.holdKey(key, meta);
			record = rec;
			return refresh().then(function () {
				say(storable === false || ok === null
					? 'Loaded, and usable until this page is closed — this browser will not keep it ' +
						'between visits, so the PEM file is the only copy. Private windows and blocked ' +
						'site data both do this.'
					: kept, storable === false || ok === null ? 'warning' : 'success');
			});
		});
	}

	function loadPem(text) {
		const pass = window.prompt('Choose a passphrase for this browser’s copy of the key');
		if (pass === null) return;
		// The same guard generation has. A key stored under no passphrase is
		// readable by anyone who reaches this browser profile, and an imported
		// key is exactly as worth protecting as a generated one.
		if (!pass) return say('A key kept without a passphrase is a key anyone using this ' +
			'computer can read. Choose one.', 'warning');
		let got;
		try {
			got = K.importPem(text, pass);
		} catch (e) {
			return say(esc(e.message || 'that file is not a private key'), 'danger');
		}
		keep(got.record, got.key, got.meta,
			'Loaded the key ending ' + esc(fp(got.meta.fingerprint.slice(-4))) + '.');
	}

	// Publishing is two writes and the second is not guessed at: the file goes
	// up, and the setting is written only if the camera's own schema declares
	// it. A camera whose firmware predates the setting still gets the file, and
	// is told that is all that happened — writing a key into a configuration
	// the daemon ignores and calling it done is the failure this avoids.
	function promptPublish() {
		if (!record) return;
		// The public half is derived from the unlocked private key, never read
		// out of the stored record. The record's authentication tag covers the
		// wrapped key and the parameters needed to unwrap it — not the public
		// metadata beside them — so a record edited in place could pair a
		// genuine private key with somebody else's public one, and the camera
		// would seal every future recording to a key this operator does not
		// hold. Deriving it means publishing proves possession, which is the
		// property that matters here.
		const key = K.heldKey();
		if (!key) {
			say('Unlock the key first: what gets sent to the camera is derived from the ' +
				'key itself, not from what this browser has written down beside it.', 'warning');
			return;
		}
		const meta = K.metaFor(key);
		if (meta.fingerprint !== record.fingerprint)
			say('The stored fingerprint did not match the key it sits beside; the key’s own ' +
				'is what was sent, and the record has been corrected.', 'warning');
		const pem = C.publicKeyPem(key);
		say('Saving the public key to the camera…');
		apiFetch('/upload', {
			method: 'POST',
			headers: { 'File-Location': PUBLIC_PATH },
			body: pem,
		}).then(function (r) {
			if (!r.ok) throw new Error('the camera answered ' + r.status);
			return apiFetch('/api/v1/config.schema.json').then(function (s) {
				// A schema that did not arrive is not a schema without the
				// setting in it. The two are reported apart below, because one
				// is a fact about this firmware and the other is a fact about
				// one HTTP request.
				if (!s.ok) return { failed: s.status };
				return s.json().then(function (j) { return { schema: j }; },
					function () { return { failed: 'unreadable' }; });
			});
		}).then(function (got) {
			if (got.failed)
				return say('The public key is on the camera at <code>' + esc(PUBLIC_PATH) + '</code>, ' +
					'but its settings could not be read just now (' + esc(got.failed) + '), so nothing ' +
					'else was changed. Point the recording settings at that file, or try again.',
					'warning');
			if (!settingExists(got.schema))
				return say('The public key is on the camera at <code>' + esc(PUBLIC_PATH) + '</code>. ' +
					'This firmware does not offer a setting to point at it, so nothing else was ' +
					'changed — a newer build will.', 'warning');
			return apiFetch('/api/v1/config', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ records: { publicKey: PUBLIC_PATH } }),
			}).then(function (r) {
				if (!r.ok) throw new Error('the camera refused the setting (' + r.status + ')');
				say('Saved. Recordings from now on carry a copy of their key sealed to this device’s ' +
					'key — earlier ones are unchanged.', 'success');
			});
		}).catch(function (e) {
			say(esc(e.message || 'the camera could not be reached'), 'danger');
		});
	}

	function settingExists(schema) {
		try {
			const p = PUBLIC_KEY_SETTING.split('.');
			let at = schema && schema.properties;
			for (let i = 0; i < p.length; i++) {
				if (!at || !at[p[i]]) return false;
				at = i === p.length - 1 ? at[p[i]] : at[p[i]].properties;
			}
			return true;
		} catch (e) {
			// A schema shaped in a way this walk did not expect. Reported the
			// same as one without the setting, which is the safe half of the
			// distinction: nothing is written. The other half — a schema that
			// never arrived — is decided before this is called.
			return false;
		}
	}

	function download(name, text) {
		const a = document.createElement('a');
		a.href = URL.createObjectURL(new Blob([text], { type: 'application/x-pem-file' }));
		a.download = name;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(function () { URL.revokeObjectURL(a.href); }, 30000);
	}

	function mount() {
		const panel = $id('rec-keys');
		if (!panel) return;
		refresh();
		const go = $id('rec-lock-go');
		document.addEventListener('click', function (ev) {
			if (ev.target && ev.target.id === 'rec-lock-go') submitLock();
			if (ev.target && ev.target.id === 'rec-keys-publish') promptPublish();
		});
		document.addEventListener('keydown', function (ev) {
			if (ev.key === 'Enter' && ev.target && ev.target.id === 'rec-lock-pass') submitLock();
		});
		if (go) go.addEventListener('click', submitLock);
	}

	function submitLock() {
		const input = $id('rec-lock-pass');
		const why = $id('rec-lock-why');
		if (!input || !pending) return;
		const fn = pending;
		if (why) why.textContent = 'Working…';
		// Stretching a passphrase holds this thread for a moment, and a button
		// that does nothing for half a second reads as a button that did not
		// work. The frame between the two is what puts "Working…" on screen.
		setTimeout(function () {
			fn(input.value, function (reason) {
				if (why) why.textContent = reason || 'That did not open it.';
			});
		}, 16);
	}

	return { mount: mount, needFor: needFor, refresh: refresh, state: state };
})();

// The recordings page talks to the panel, not to the store.
window.MajesticRecKeys.needFor = function (box, opts) {
	return window.MajesticRecKeys.ui.needFor(box, opts);
};
