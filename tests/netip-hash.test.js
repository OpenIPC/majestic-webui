// The NETIP password hash, as netip-hash.js computes it.
//
// It fails silently: a wrong hash is saved without complaint, and the only
// symptom is an XMEye/CMS client refused at sign-in, with nothing on the page to
// say why. The vectors come from Python's hashlib run through the same Sofia
// reduction.
'use strict';

const path = require('path');
const { check, group, done } = require('./assert');

const H = require(path.join(__dirname, '..', 'www', 'a', 'netip-hash.js'));

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

group('MD5 itself');

check('the RFC 1321 empty vector', hex(H.md5(new Uint8Array(0))) === 'd41d8cd98f00b204e9800998ecf8427e');
check('the fox sentence',
	hex(H.md5(new TextEncoder().encode('The quick brown fox jumps over the lazy dog')))
	=== '9e107d9d372bb6826bd81d3542a419d6');

group('the Sofia hash a client sends');

const vectors = [
	// The page never sends this one — an empty box keeps what is stored —
	// but it is the shortest input MD5 has.
	['', 'tlJwpbo6'],
	['correct horse', 'sX6rDLaa'],
	['admin', '6QNMIQGe'],
	['pass word!', 'lGBAKEOJ'],
	// Not ASCII: the hash is of the UTF-8 bytes, not of UTF-16 code units.
	['пароль', 'iigYAvIp'],
	// The padding boundaries: 55 bytes fits one block, 56 needs a second,
	// 64 fills one exactly, 100 spans two.
	['x'.repeat(55), 'wc84voe9'],
	['y'.repeat(56), 'rfAxzP6b'],
	['z'.repeat(64), 'ICxjmd43'],
	['a'.repeat(100), 'bxkr5m3Z'],
];
vectors.forEach(([pw, want]) => {
	const got = H.hash(pw);
	check(JSON.stringify(pw.length > 12 ? pw.slice(0, 3) + '…×' + pw.length : pw) + ' → ' + want,
		got === want, 'got ' + got);
});

done();
