// Every byte the WebUI fetches from a CDN is pinned.
//
// These pages run as the camera's root: the file editor writes any file, the
// console is a root shell. Code loaded into them from jsDelivr is trusted with
// all of that, so what arrives must be exactly what was reviewed. Two ways it
// stops being so, and neither shows on a page: a `gh/` URL that names a tag
// follows the tag wherever it is moved, and an `npm/` file loaded without an
// integrity hash runs whatever the CDN, or anything on the path to it, sends.
'use strict';

const fs = require('fs');
const path = require('path');
const { check, group, done } = require('./assert');

const WWW = path.join(__dirname, '..', 'www');

function walk(d, out) {
	for (const e of fs.readdirSync(d, { withFileTypes: true })) {
		const p = path.join(d, e.name);
		if (e.isDirectory()) walk(p, out);
		else if (/\.(js|cgi|html)$/.test(e.name) && !/\.min\./.test(e.name)) out.push(p);
	}
	return out;
}

const files = walk(WWW, []);
let seen = 0;

group('gh/ assets name a commit, not a tag');
for (const f of files) {
	const s = fs.readFileSync(f, 'utf8');
	for (const m of s.matchAll(/cdn\.jsdelivr\.net\/gh\/([^@'"\s]+)@([^/'"\s]+)/g)) {
		seen++;
		check(path.relative(WWW, f) + ': ' + m[1] + ' is pinned by commit', /^[0-9a-f]{40}$/.test(m[2]), m[2]);
	}
}

group('npm/ files are loaded with an integrity hash');
for (const f of files) {
	const s = fs.readFileSync(f, 'utf8');
	// A base constant ('.../npm/') is not a file; the files are built from it,
	// and each of those is checked where it is named.
	for (const m of s.matchAll(/(?:cdn\.jsdelivr\.net\/npm\/|CDN \+ ')([^'"\s]+\.(?:js|css))/g)) {
		seen++;
		const near = s.slice(Math.max(0, m.index - 300), m.index + 300);
		check(path.relative(WWW, f) + ': ' + m[1] + ' carries a sha384 hash', /sha384-[A-Za-z0-9+/=]{64}/.test(near));
	}
}

check('some CDN URLs were found (otherwise this tests nothing)', seen >= 5, String(seen));

done();
