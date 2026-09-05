// The crypto primitives an encrypted recording needs, written out in JavaScript.
//
// WHY NOT crypto.subtle. It does not exist here. `SubtleCrypto` is exposed only
// in a secure context, and a camera is http:// on a LAN — the same wall
// preview-wasm.js hits with WebCodecs, and the microphone and the clipboard
// with theirs. So a page that wants to open a recording on the camera it came
// from has to bring its own AES and its own SHA-256.
//
// `crypto.getRandomValues()` is NOT gated that way and is where every salt and
// IV below comes from. Nothing here invents randomness, and nothing here is a
// new construction: it is SHA-256, HMAC, HKDF, PBKDF2, AES-128-CTR and RSA-OAEP
// as published, so the only thing that can go wrong is transcription — which is
// what the vectors in tests/mjcrypto.test.js are for. Read a failure there as
// "this file is wrong", never as "the vector is unusual".
//
// WHAT IT COSTS, because the page has to decide what to do on the main thread:
// PBKDF2 at 100 000 iterations is a fraction of a second and is paid once per
// passphrase; AES-CTR runs at tens of MB/s against the ~2 MB/s playback asks
// for; SHA-256 over a whole clip is seconds, which is why the integrity check
// is chunked and reports progress rather than running in one go.
//
// Deliberately not here: encryption. Nothing in this UI encrypts anything —
// every use is opening something the camera sealed — so the AES code is the
// forward direction only (CTR needs no inverse cipher), and there is no signing
// key anywhere. If that changes, the missing halves are a separate decision,
// not an oversight.
window.MajesticCrypto = (function () {
	'use strict';

	// ---- bytes -----------------------------------------------------------

	function u8(x) {
		if (x instanceof Uint8Array) return x;
		if (x instanceof ArrayBuffer) return new Uint8Array(x);
		if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
		if (typeof x === 'string') return utf8(x);
		throw new TypeError('not bytes');
	}

	function utf8(s) {
		// TextEncoder is not secure-context gated and is everywhere this UI
		// already runs; the manual path is for a Node context in the tests
		// where the global may not be installed.
		if (typeof TextEncoder === 'function') return new TextEncoder().encode(s);
		const out = [];
		for (let i = 0; i < s.length; i++) {
			let c = s.charCodeAt(i);
			if (c < 0x80) out.push(c);
			else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
			else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
				const lo = s.charCodeAt(++i);
				c = 0x10000 + ((c & 0x3ff) << 10) + (lo & 0x3ff);
				out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
			} else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
		}
		return new Uint8Array(out);
	}

	function concat(parts) {
		let n = 0;
		for (const p of parts) n += p.length;
		const out = new Uint8Array(n);
		let at = 0;
		for (const p of parts) { out.set(p, at); at += p.length; }
		return out;
	}

	function hex(b) {
		let s = '';
		for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
		return s;
	}

	function fromHex(s) {
		const out = new Uint8Array(s.length >> 1);
		for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
		return out;
	}

	// Comparison whose duration says nothing about where the first difference
	// is. Every tag check in this file goes through it.
	function ctEqual(a, b) {
		if (a.length !== b.length) return false;
		let d = 0;
		for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
		return d === 0;
	}

	function randomBytes(n) {
		const out = new Uint8Array(n);
		const c = typeof crypto === 'object' ? crypto : null;
		if (!c || typeof c.getRandomValues !== 'function')
			throw new Error('no random source in this browser');
		c.getRandomValues(out);
		return out;
	}

	// ---- SHA-256 (FIPS 180-4) --------------------------------------------

	const K = new Uint32Array([
		0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
		0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
		0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
		0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
		0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
		0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
		0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
		0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
	]);

	// A reusable hasher, because HMAC, HKDF and PBKDF2 all hash the same small
	// blocks over and over and allocating a state object per call is most of
	// what PBKDF2 would otherwise spend its time on.
	function Sha256() {
		this.h = new Uint32Array(8);
		this.w = new Uint32Array(64);
		this.buf = new Uint8Array(64);
		this.reset();
	}

	Sha256.prototype.reset = function () {
		this.h[0] = 0x6a09e667; this.h[1] = 0xbb67ae85; this.h[2] = 0x3c6ef372; this.h[3] = 0xa54ff53a;
		this.h[4] = 0x510e527f; this.h[5] = 0x9b05688c; this.h[6] = 0x1f83d9ab; this.h[7] = 0x5be0cd19;
		this.len = 0;
		this.n = 0;
		return this;
	};

	Sha256.prototype.block = function (p, off) {
		const w = this.w, h = this.h;
		for (let i = 0; i < 16; i++)
			w[i] = (p[off + i * 4] << 24) | (p[off + i * 4 + 1] << 16) | (p[off + i * 4 + 2] << 8) | p[off + i * 4 + 3];
		for (let i = 16; i < 64; i++) {
			const a = w[i - 15], b = w[i - 2];
			const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
			const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
			w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
		}
		let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
		for (let i = 0; i < 64; i++) {
			const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
			const ch = (e & f) ^ (~e & g);
			const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
			const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const t2 = (S0 + maj) | 0;
			hh = g; g = f; f = e; e = (d + t1) | 0;
			d = c; c = b; b = a; a = (t1 + t2) | 0;
		}
		h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
		h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
	};

	Sha256.prototype.update = function (data) {
		const p = u8(data);
		this.len += p.length;
		let i = 0;
		if (this.n) {
			const take = Math.min(64 - this.n, p.length);
			this.buf.set(p.subarray(0, take), this.n);
			this.n += take;
			i = take;
			if (this.n === 64) { this.block(this.buf, 0); this.n = 0; }
		}
		for (; i + 64 <= p.length; i += 64) this.block(p, i);
		if (i < p.length) { this.buf.set(p.subarray(i), this.n); this.n += p.length - i; }
		return this;
	};

	Sha256.prototype.digest = function (out) {
		const bits = this.len * 8;
		const pad = new Uint8Array(this.n < 56 ? 64 : 128);
		pad.set(this.buf.subarray(0, this.n));
		pad[this.n] = 0x80;
		// Lengths past 2^32 bits (512 MB) are real here — a clip is hashed in
		// one pass by the integrity check — so the high word is written from
		// the float rather than left at zero.
		const hi = Math.floor(bits / 4294967296);
		const lo = bits >>> 0;
		const at = pad.length - 8;
		pad[at] = (hi >>> 24) & 255; pad[at + 1] = (hi >>> 16) & 255;
		pad[at + 2] = (hi >>> 8) & 255; pad[at + 3] = hi & 255;
		pad[at + 4] = (lo >>> 24) & 255; pad[at + 5] = (lo >>> 16) & 255;
		pad[at + 6] = (lo >>> 8) & 255; pad[at + 7] = lo & 255;
		for (let i = 0; i < pad.length; i += 64) this.block(pad, i);
		const d = out || new Uint8Array(32);
		for (let i = 0; i < 8; i++) {
			d[i * 4] = (this.h[i] >>> 24) & 255;
			d[i * 4 + 1] = (this.h[i] >>> 16) & 255;
			d[i * 4 + 2] = (this.h[i] >>> 8) & 255;
			d[i * 4 + 3] = this.h[i] & 255;
		}
		return d;
	};

	function sha256(data) { return new Sha256().update(data).digest(); }

	// ---- HMAC-SHA256 (RFC 2104) ------------------------------------------

	// Keyed once, used many times: PBKDF2 runs the same key through two hashes
	// per iteration, so the key schedule is prepared once and only the inner
	// state is replayed.
	function Hmac(key) {
		const k = u8(key);
		this.ipad = new Uint8Array(64);
		this.opad = new Uint8Array(64);
		const base = k.length > 64 ? sha256(k) : k;
		this.ipad.set(base); this.opad.set(base);
		for (let i = 0; i < 64; i++) { this.ipad[i] ^= 0x36; this.opad[i] ^= 0x5c; }
		this.inner = new Sha256();
		this.outer = new Sha256();
		this.reset();
	}

	Hmac.prototype.reset = function () {
		this.inner.reset().update(this.ipad);
		return this;
	};

	Hmac.prototype.update = function (data) { this.inner.update(data); return this; };

	Hmac.prototype.digest = function (out) {
		const i = this.inner.digest();
		return this.outer.reset().update(this.opad).update(i).digest(out);
	};

	function hmacSha256(key, data) { return new Hmac(key).update(data).digest(); }

	// ---- HKDF (RFC 5869) --------------------------------------------------

	function hkdfExtract(salt, ikm) { return hmacSha256(salt, ikm); }

	function hkdfExpand(prk, info, len) {
		const inf = u8(info);
		const out = new Uint8Array(len);
		const h = new Hmac(prk);
		let t = new Uint8Array(0);
		for (let i = 1, at = 0; at < len; i++) {
			h.reset().update(t).update(inf).update(new Uint8Array([i]));
			t = h.digest();
			out.set(t.subarray(0, Math.min(32, len - at)), at);
			at += 32;
		}
		return out;
	}

	// ---- PBKDF2-HMAC-SHA256 (RFC 8018) ------------------------------------

	function pbkdf2Sha256(password, salt, iterations, len) {
		const s = u8(salt);
		const h = new Hmac(u8(password));
		const out = new Uint8Array(len);
		const block = new Uint8Array(s.length + 4);
		block.set(s);
		const t = new Uint8Array(32);
		for (let i = 1, at = 0; at < len; i++) {
			block[s.length] = (i >>> 24) & 255; block[s.length + 1] = (i >>> 16) & 255;
			block[s.length + 2] = (i >>> 8) & 255; block[s.length + 3] = i & 255;
			let u = h.reset().update(block).digest();
			t.set(u);
			for (let j = 1; j < iterations; j++) {
				u = h.reset().update(u).digest();
				for (let b = 0; b < 32; b++) t[b] ^= u[b];
			}
			out.set(t.subarray(0, Math.min(32, len - at)), at);
			at += 32;
		}
		return out;
	}

	// ---- AES-128, encryption direction only -------------------------------
	//
	// CTR needs the forward cipher for both directions, so there is no inverse
	// key schedule and no InvSubBytes table here. The S-box and the round
	// constants are the standard ones; the tables are built at load rather than
	// written out, which is a few hundred bytes of flash and a millisecond.

	const SBOX = new Uint8Array(256);
	const T = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
	const RCON = new Uint8Array([0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36]);

	(function buildTables() {
		// The multiplicative inverse walk that generates the S-box, so the
		// table is derived from the definition rather than pasted from one.
		const p = new Uint8Array(256), l = new Uint8Array(256);
		let x = 1;
		for (let i = 0; i < 255; i++) {
			p[i] = x;
			l[x] = i;
			x ^= (x << 1) ^ ((x & 0x80) ? 0x11b : 0);
			x &= 255;
		}
		SBOX[0] = 0x63;
		for (let i = 0; i < 255; i++) {
			const inv = p[255 - l[p[i]]];
			let s = inv ^ 0x63;
			for (let j = 1; j < 5; j++) s ^= ((inv << j) | (inv >>> (8 - j))) & 255;
			SBOX[p[i]] = s & 255;
		}
		function xt(a, b) {
			let r = 0;
			while (b) {
				if (b & 1) r ^= a;
				a = ((a << 1) ^ ((a & 0x80) ? 0x11b : 0)) & 255;
				b >>= 1;
			}
			return r;
		}
		for (let i = 0; i < 256; i++) {
			const s = SBOX[i];
			const t0 = (xt(s, 2) << 24) | (s << 16) | (s << 8) | xt(s, 3);
			T[0][i] = t0 >>> 0;
			T[1][i] = ((t0 >>> 8) | (t0 << 24)) >>> 0;
			T[2][i] = ((t0 >>> 16) | (t0 << 16)) >>> 0;
			T[3][i] = ((t0 >>> 24) | (t0 << 8)) >>> 0;
		}
	})();

	function Aes128(key) {
		const k = u8(key);
		if (k.length !== 16) throw new Error('AES-128 needs a 16-byte key');
		const w = new Uint32Array(44);
		for (let i = 0; i < 4; i++)
			w[i] = (k[i * 4] << 24) | (k[i * 4 + 1] << 16) | (k[i * 4 + 2] << 8) | k[i * 4 + 3];
		for (let i = 4; i < 44; i++) {
			let t = w[i - 1];
			if (i % 4 === 0) {
				t = ((t << 8) | (t >>> 24)) >>> 0;
				t = (SBOX[(t >>> 24) & 255] << 24) | (SBOX[(t >>> 16) & 255] << 16) |
					(SBOX[(t >>> 8) & 255] << 8) | SBOX[t & 255];
				t = (t ^ (RCON[i / 4 - 1] << 24)) >>> 0;
			}
			w[i] = (w[i - 4] ^ t) >>> 0;
		}
		this.w = w;
	}

	// One block, in place into `out`. The last round has no MixColumns, which
	// is why it is written out rather than folded into the loop.
	Aes128.prototype.encryptBlock = function (inp, out) {
		const w = this.w;
		let s0 = (((inp[0] << 24) | (inp[1] << 16) | (inp[2] << 8) | inp[3]) ^ w[0]) >>> 0;
		let s1 = (((inp[4] << 24) | (inp[5] << 16) | (inp[6] << 8) | inp[7]) ^ w[1]) >>> 0;
		let s2 = (((inp[8] << 24) | (inp[9] << 16) | (inp[10] << 8) | inp[11]) ^ w[2]) >>> 0;
		let s3 = (((inp[12] << 24) | (inp[13] << 16) | (inp[14] << 8) | inp[15]) ^ w[3]) >>> 0;
		for (let r = 1; r < 10; r++) {
			const t0 = (T[0][(s0 >>> 24) & 255] ^ T[1][(s1 >>> 16) & 255] ^ T[2][(s2 >>> 8) & 255] ^ T[3][s3 & 255] ^ w[r * 4]) >>> 0;
			const t1 = (T[0][(s1 >>> 24) & 255] ^ T[1][(s2 >>> 16) & 255] ^ T[2][(s3 >>> 8) & 255] ^ T[3][s0 & 255] ^ w[r * 4 + 1]) >>> 0;
			const t2 = (T[0][(s2 >>> 24) & 255] ^ T[1][(s3 >>> 16) & 255] ^ T[2][(s0 >>> 8) & 255] ^ T[3][s1 & 255] ^ w[r * 4 + 2]) >>> 0;
			const t3 = (T[0][(s3 >>> 24) & 255] ^ T[1][(s0 >>> 16) & 255] ^ T[2][(s1 >>> 8) & 255] ^ T[3][s2 & 255] ^ w[r * 4 + 3]) >>> 0;
			s0 = t0; s1 = t1; s2 = t2; s3 = t3;
		}
		const o0 = ((SBOX[(s0 >>> 24) & 255] << 24) | (SBOX[(s1 >>> 16) & 255] << 16) | (SBOX[(s2 >>> 8) & 255] << 8) | SBOX[s3 & 255]) ^ w[40];
		const o1 = ((SBOX[(s1 >>> 24) & 255] << 24) | (SBOX[(s2 >>> 16) & 255] << 16) | (SBOX[(s3 >>> 8) & 255] << 8) | SBOX[s0 & 255]) ^ w[41];
		const o2 = ((SBOX[(s2 >>> 24) & 255] << 24) | (SBOX[(s3 >>> 16) & 255] << 16) | (SBOX[(s0 >>> 8) & 255] << 8) | SBOX[s1 & 255]) ^ w[42];
		const o3 = ((SBOX[(s3 >>> 24) & 255] << 24) | (SBOX[(s0 >>> 16) & 255] << 16) | (SBOX[(s1 >>> 8) & 255] << 8) | SBOX[s2 & 255]) ^ w[43];
		out[0] = (o0 >>> 24) & 255; out[1] = (o0 >>> 16) & 255; out[2] = (o0 >>> 8) & 255; out[3] = o0 & 255;
		out[4] = (o1 >>> 24) & 255; out[5] = (o1 >>> 16) & 255; out[6] = (o1 >>> 8) & 255; out[7] = o1 & 255;
		out[8] = (o2 >>> 24) & 255; out[9] = (o2 >>> 16) & 255; out[10] = (o2 >>> 8) & 255; out[11] = o2 & 255;
		out[12] = (o3 >>> 24) & 255; out[13] = (o3 >>> 16) & 255; out[14] = (o3 >>> 8) & 255; out[15] = o3 & 255;
	};

	// AES-128-CTR over `data`, in place, from counter block `counter`.
	//
	// The counter is the WHOLE sixteen-byte block, incremented big-endian, and
	// it advances across the call: a caller decrypting one sample's protected
	// runs hands them over one after another and gets a continuous keystream,
	// which is what the recording was encrypted with. Resetting per run would
	// still decode the first NAL of every frame — a picture appears and only
	// the detail is wrong.
	function ctr(key, counter) {
		const aes = key instanceof Aes128 ? key : new Aes128(key);
		const c = new Uint8Array(16);
		c.set(u8(counter).subarray(0, 16));
		const ks = new Uint8Array(16);
		let used = 16;

		// The stored byte decides the carry, not the expression's value: on a
		// typed array `++c[i]` evaluates to 256 while storing 0, so testing it
		// directly breaks out of the loop exactly when the carry was owed. The
		// keystream then goes wrong from the second block of any counter that
		// ends in 0xff, which is one recording in 256 and no error anywhere.
		function bump() {
			for (let i = 15; i >= 0; i--) {
				c[i] = (c[i] + 1) & 255;
				if (c[i] !== 0) break;
			}
		}

		return {
			// XOR `n` bytes of `data` from `at`, in place, and return it.
			xor: function (data, at, n) {
				const d = u8(data);
				const end = (at || 0) + (n === undefined ? d.length - (at || 0) : n);
				for (let i = at || 0; i < end; i++) {
					if (used === 16) { aes.encryptBlock(c, ks); bump(); used = 0; }
					d[i] ^= ks[used++];
				}
				return d;
			},
			// Start again at a block boundary. Only the sample walk uses this,
			// and only between samples, where the recording's own counter also
			// restarts.
			reset: function (counter2) {
				c.set(u8(counter2).subarray(0, 16));
				used = 16;
			},
		};
	}

	// One-shot: a copy of `data`, XORed with the keystream from `counter`.
	function aes128CtrXor(key, counter, data) {
		const out = u8(data).slice();
		ctr(key, counter).xor(out, 0, out.length);
		return out;
	}

	// ---- RSA-OAEP decryption (RFC 8017), BigInt ---------------------------

	function beToBig(b) {
		let n = 0n;
		for (let i = 0; i < b.length; i++) n = (n << 8n) | BigInt(b[i]);
		return n;
	}

	function bigToBe(n, len) {
		const out = new Uint8Array(len);
		for (let i = len - 1; i >= 0; i--) { out[i] = Number(n & 255n); n >>= 8n; }
		return out;
	}

	function modPow(base, exp, mod) {
		let r = 1n, b = base % mod, e = exp;
		while (e > 0n) {
			if (e & 1n) r = (r * b) % mod;
			b = (b * b) % mod;
			e >>= 1n;
		}
		return r;
	}

	function mgf1(seed, len) {
		const out = new Uint8Array(len);
		const ctr4 = new Uint8Array(4);
		for (let i = 0, at = 0; at < len; i++, at += 32) {
			ctr4[0] = (i >>> 24) & 255; ctr4[1] = (i >>> 16) & 255;
			ctr4[2] = (i >>> 8) & 255; ctr4[3] = i & 255;
			const h = new Sha256().update(seed).update(ctr4).digest();
			out.set(h.subarray(0, Math.min(32, len - at)), at);
		}
		return out;
	}

	// `key` is what parsePkcs8() returned. CRT is used when the key carries the
	// parameters — four exponentiations on halves rather than one on the whole
	// modulus, which is roughly four times faster and is what makes this
	// unnoticeable on a slow machine.
	function rsaOaepDecrypt(key, ciphertext) {
		const c = u8(ciphertext);
		const k = key.size;
		if (c.length !== k) throw new Error('ciphertext is not one block');
		const cInt = beToBig(c);
		let mInt;
		if (key.p && key.q) {
			const m1 = modPow(cInt % key.p, key.dp, key.p);
			const m2 = modPow(cInt % key.q, key.dq, key.q);
			let h = ((m1 - m2) * key.qinv) % key.p;
			if (h < 0n) h += key.p;
			mInt = m2 + h * key.q;
		} else {
			mInt = modPow(cInt, key.d, key.n);
		}
		const em = bigToBe(mInt, k);

		// The padding check tells the caller only "this did not open", never
		// which half failed: the reasons are what a padding oracle is made of,
		// and the page has nothing to say with them anyway.
		const hLen = 32;
		const lHash = sha256(new Uint8Array(0));
		let bad = em[0] !== 0 ? 1 : 0;
		const maskedSeed = em.subarray(1, 1 + hLen);
		const maskedDb = em.subarray(1 + hLen);
		const seed = mgf1(maskedDb, hLen);
		for (let i = 0; i < hLen; i++) seed[i] ^= maskedSeed[i];
		const db = mgf1(seed, maskedDb.length);
		for (let i = 0; i < db.length; i++) db[i] ^= maskedDb[i];
		if (!ctEqual(db.subarray(0, hLen), lHash)) bad = 1;
		let at = hLen;
		while (at < db.length && db[at] === 0) at++;
		if (at >= db.length || db[at] !== 1) bad = 1;
		if (bad) throw new Error('this key does not open that');
		return db.slice(at + 1);
	}

	// ---- DER and PEM ------------------------------------------------------
	//
	// Enough ASN.1 to read a PKCS#8 or PKCS#1 RSA private key and to write an
	// SPKI public key. Not a general parser: it walks the exact shapes those
	// two structures have and refuses anything else, which is the right amount
	// of trust to place in a file a person picked off their disk.

	function der(bytes, at) {
		const b = u8(bytes);
		const tag = b[at++];
		let len = b[at++];
		if (len & 0x80) {
			const n = len & 0x7f;
			if (n === 0 || n > 4) throw new Error('unsupported DER length');
			len = 0;
			for (let i = 0; i < n; i++) len = (len << 8) | b[at++];
		}
		return { tag: tag, at: at, len: len, end: at + len };
	}

	function derInt(b, at) {
		const t = der(b, at);
		if (t.tag !== 0x02) throw new Error('expected an INTEGER');
		return { value: beToBig(u8(b).subarray(t.at, t.end)), next: t.end };
	}

	function b64decode(s) {
		const clean = String(s).replace(/[^A-Za-z0-9+/=]/g, '');
		if (typeof atob === 'function') {
			const bin = atob(clean);
			const out = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
			return out;
		}
		return new Uint8Array(Buffer.from(clean, 'base64'));
	}

	function b64encode(bytes) {
		const b = u8(bytes);
		if (typeof btoa === 'function') {
			let s = '';
			for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
			return btoa(s);
		}
		return Buffer.from(b).toString('base64');
	}

	function pemBody(text, want) {
		const m = String(text).match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
		if (!m) throw new Error('not a PEM file');
		if (want && m[1].indexOf(want) < 0) throw new Error('this is a ' + m[1].toLowerCase() + ', not a ' + want.toLowerCase());
		return { label: m[1], bytes: b64decode(m[2]) };
	}

	function pemWrap(label, bytes) {
		const b64 = b64encode(bytes);
		let body = '';
		for (let i = 0; i < b64.length; i += 64) body += b64.substr(i, 64) + '\n';
		return '-----BEGIN ' + label + '-----\n' + body + '-----END ' + label + '-----\n';
	}

	// PKCS#1 RSAPrivateKey, the inner structure of both forms.
	function parsePkcs1(bytes) {
		const seq = der(bytes, 0);
		if (seq.tag !== 0x30) throw new Error('not an RSA private key');
		let at = seq.at;
		const ver = derInt(bytes, at); at = ver.next;
		const n = derInt(bytes, at); at = n.next;
		const e = derInt(bytes, at); at = e.next;
		const d = derInt(bytes, at); at = d.next;
		const p = derInt(bytes, at); at = p.next;
		const q = derInt(bytes, at); at = q.next;
		const dp = derInt(bytes, at); at = dp.next;
		const dq = derInt(bytes, at); at = dq.next;
		const qinv = derInt(bytes, at);
		let size = 0;
		for (let v = n.value; v > 0n; v >>= 8n) size++;
		return {
			n: n.value, e: e.value, d: d.value, p: p.value, q: q.value,
			dp: dp.value, dq: dq.value, qinv: qinv.value, size: size,
		};
	}

	// Takes either PEM form openssl produces: "BEGIN PRIVATE KEY" (PKCS#8, the
	// default since 3.0) or "BEGIN RSA PRIVATE KEY" (PKCS#1, what older
	// scripts and `openssl genrsa -traditional` write).
	function parsePrivateKeyPem(text) {
		const p = pemBody(text);
		if (p.label.indexOf('RSA PRIVATE KEY') >= 0) return parsePkcs1(p.bytes);
		if (p.label.indexOf('PRIVATE KEY') < 0) throw new Error('this is a ' + p.label.toLowerCase() + ', not a private key');
		// PrivateKeyInfo: SEQUENCE { INTEGER 0, AlgorithmIdentifier, OCTET STRING }
		const seq = der(p.bytes, 0);
		if (seq.tag !== 0x30) throw new Error('not a private key');
		let at = seq.at;
		const ver = der(p.bytes, at); at = ver.end;
		const alg = der(p.bytes, at); at = alg.end;
		const oct = der(p.bytes, at);
		if (oct.tag !== 0x04) throw new Error('not a private key');
		return parsePkcs1(p.bytes.subarray(oct.at, oct.end));
	}

	// SubjectPublicKeyInfo for an RSA key, which is what the camera reads.
	function publicKeyPem(key) {
		function len(n) {
			if (n < 0x80) return [n];
			if (n < 0x100) return [0x81, n];
			return [0x82, (n >> 8) & 255, n & 255];
		}
		function int(v) {
			let b = [];
			let x = v;
			while (x > 0n) { b.unshift(Number(x & 255n)); x >>= 8n; }
			if (!b.length) b = [0];
			if (b[0] & 0x80) b.unshift(0);
			return [0x02].concat(len(b.length), b);
		}
		const rsa = int(key.n).concat(int(key.e));
		const inner = [0x30].concat(len(rsa.length), rsa);
		const bitstr = [0x03].concat(len(inner.length + 1), [0x00], inner);
		// rsaEncryption OID, with its NULL parameters.
		const algo = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
		const spkiBody = algo.concat(bitstr);
		const spki = [0x30].concat(len(spkiBody.length), spkiBody);
		return pemWrap('PUBLIC KEY', new Uint8Array(spki));
	}

	// The eight bytes a clip carries to say which key sealed it: SHA-256 over
	// the DER SubjectPublicKeyInfo, truncated. Computed from the same bytes the
	// PEM carries, so a key imported here and a key uploaded to the camera
	// cannot disagree about their own name.
	function publicKeyFingerprint(key) {
		const pem = publicKeyPem(key);
		return sha256(pemBody(pem, 'PUBLIC KEY').bytes).subarray(0, 8);
	}

	return {
		bytes: u8, utf8: utf8, concat: concat, hex: hex, fromHex: fromHex,
		ctEqual: ctEqual, randomBytes: randomBytes,
		sha256: sha256, Sha256: Sha256,
		hmacSha256: hmacSha256, Hmac: Hmac,
		hkdfExtract: hkdfExtract, hkdfExpand: hkdfExpand,
		pbkdf2Sha256: pbkdf2Sha256,
		Aes128: Aes128, ctr: ctr, aes128CtrXor: aes128CtrXor,
		rsaOaepDecrypt: rsaOaepDecrypt, mgf1: mgf1,
		parsePrivateKeyPem: parsePrivateKeyPem, publicKeyPem: publicKeyPem,
		publicKeyFingerprint: publicKeyFingerprint,
		pemBody: pemBody, pemWrap: pemWrap,
		b64encode: b64encode, b64decode: b64decode,
	};
})();

if (typeof module === 'object' && module.exports) module.exports = window.MajesticCrypto;
