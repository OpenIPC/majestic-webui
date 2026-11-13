// The password an XMEye/CMS client signs in to NETIP with, in the form the
// camera compares it.
//
// Those clients never send the password itself: they send the "Sofia" hash of
// it — MD5 of the UTF-8 text, then each of the eight byte pairs summed modulo
// 62 into a digit or letter. majestic stores that string and compares it
// verbatim with what a client sends, so the setting has to hold the hash. It
// used to be a bare text box titled "Hash of password", which left an owner to
// find out what algorithm that meant and run it somewhere else. The page runs
// it instead: the owner types the password, and the hash is what is saved.
//
// This is wire compatibility, not protection. Eight characters from 62 is
// easily searched, and holding the hash IS holding the login, which is why the
// field stays a secret one.
//
// MD5 is written out because nothing in the browser offers it: WebCrypto
// declines it on purpose. A wrong hash fails silently — the client is just
// refused, and the page has no way to know — so tests/netip-hash.test.js pins
// it against vectors from an independent implementation.
(function () {
	'use strict';

	const S = [
		7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
		5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
		4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
		6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
	];
	const K = [];
	for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;

	// RFC 1321 over a byte array; the sixteen digest bytes back.
	function md5(bytes) {
		const n = bytes.length;
		const total = (((n + 8) >>> 6) + 1) * 64;
		const m = new Uint8Array(total);
		m.set(bytes);
		m[n] = 0x80;
		// The length in bits, little-endian. Split so a length past 2^29 bytes
		// does not lose its top bits to a 32-bit shift.
		const bitsLo = (n << 3) >>> 0, bitsHi = Math.floor(n / 0x20000000);
		for (let i = 0; i < 4; i++) {
			m[total - 8 + i] = (bitsLo >>> (8 * i)) & 0xff;
			m[total - 4 + i] = (bitsHi >>> (8 * i)) & 0xff;
		}
		let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
		const X = new Array(16);
		for (let off = 0; off < total; off += 64) {
			for (let j = 0; j < 16; j++) {
				const o = off + j * 4;
				X[j] = m[o] | (m[o + 1] << 8) | (m[o + 2] << 16) | (m[o + 3] << 24);
			}
			let a = a0, b = b0, c = c0, d = d0;
			for (let i = 0; i < 64; i++) {
				let f, g;
				if (i < 16) { f = (b & c) | (~b & d); g = i; }
				else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
				else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
				else { f = c ^ (b | ~d); g = (7 * i) & 15; }
				const t = d;
				d = c;
				c = b;
				const x = (a + f + K[i] + X[g]) | 0;
				b = (b + ((x << S[i]) | (x >>> (32 - S[i])))) | 0;
				a = t;
			}
			a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
		}
		const out = new Uint8Array(16);
		[a0, b0, c0, d0].forEach(function (w, k) {
			for (let i = 0; i < 4; i++) out[k * 4 + i] = (w >>> (8 * i)) & 0xff;
		});
		return out;
	}

	const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

	// The Sofia hash of a password, as a client sends it.
	function hash(password) {
		const d = md5(new TextEncoder().encode(String(password)));
		let s = '';
		for (let i = 0; i < 16; i += 2) s += ALPHABET[(d[i] + d[i + 1]) % 62];
		return s;
	}

	const api = { md5: md5, hash: hash };
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.NetipHash = api;
})();
