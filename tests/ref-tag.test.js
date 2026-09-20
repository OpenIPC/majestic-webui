// Every link the WebUI offers to openipc.org carries the ?ref word.
//
// The word is the only thing that makes a visit from a camera's own web
// interface countable. A browser following one of these links sends either no
// referrer or a private address, so on the far end the arrival is
// indistinguishable from someone typing the name in — and a channel that
// cannot be told apart from the background is a channel nobody can decide
// anything about (#549). The word itself is a constant: nothing about the
// camera, its owner or its firmware rides along with it.
//
// It earns a file because both ways of getting it wrong are silent, and stay
// silent for as long as it takes somebody to notice a number that was never
// going to arrive. A tag dropped by a tidy-up leaves a link that still opens
// the right page; a new link added without one looks exactly like the links
// beside it. Neither shows on screen, neither fails a lint, and the only
// witness is a dashboard in another project counting events that simply stop
// — which reads the same as nobody having clicked.
'use strict';

const fs = require('fs');
const path = require('path');
const { check, group, done } = require('./assert');

const ROOT = path.join(__dirname, '..');
const WWW = path.join(ROOT, 'www');
const TAG = 'ref=webui';

// The host, and only the host: wiki.openipc.org is a different site with its
// own counting, and the snapshot upload in sbin/openwall is a machine talking
// to an API rather than a person arriving somewhere.
const LINK = /href\s*=\s*(["'])(https?:\/\/(?:www\.)?openipc\.org(?:\/[^"']*)?)\1/g;

function walk(dir, out) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else if (/\.(cgi|html|js)$/.test(entry.name)) out.push(full);
	}
	return out;
}

const links = [];
for (const file of walk(WWW, [])) {
	const src = fs.readFileSync(file, 'utf8');
	let m;
	LINK.lastIndex = 0;
	while ((m = LINK.exec(src)) !== null) {
		links.push({ file: path.relative(ROOT, file), url: m[2] });
	}
}

group('every openipc.org link in www/ carries the tag');
{
	// A scan that finds nothing passes every assertion below it, so the count
	// is checked first: two links are what the tree has, and a rename or a
	// rewritten footer that takes one away has to be noticed rather than
	// quietly reducing this file to a no-op.
	check('the scan actually found links to tag', links.length >= 2,
		links.length + ' found');

	for (const link of links) {
		check(link.file + ' — ' + link.url, link.url.indexOf(TAG) !== -1,
			'no ' + TAG);
	}
}

group('the two links the footer and the Open Wall card put on screen');
{
	const byFile = (f) => links.filter((l) => l.file === f).map((l) => l.url);

	const footer = byFile('www/cgi-bin/p/footer.cgi');
	check('the footer, which every page with chrome renders, links to the site',
		footer.length === 1, footer.join(' '));
	check('and it is the front page, tagged', footer[0] === 'https://openipc.org/?ref=webui',
		footer[0]);

	const wall = byFile('www/cgi-bin/openwall.cgi');
	check('the Open Wall card links to the wall itself', wall.length === 1, wall.join(' '));
	check('and it is tagged too', wall[0] === 'https://openipc.org/open-wall?ref=webui',
		wall[0]);

	// The tag is a query parameter, not part of the path: a link that ends up
	// as /open-wall/ref=webui or //?ref=webui reaches a 404 the page gives no
	// sign of, since nothing here ever follows it.
	for (const link of links) {
		const q = link.url.indexOf('?');
		check(link.file + ' — the tag is in the query, after a single ?',
			q !== -1 && link.url.indexOf('?', q + 1) === -1 &&
				link.url.slice(q + 1).split('&').indexOf(TAG) !== -1,
			link.url);
	}
}

done();
