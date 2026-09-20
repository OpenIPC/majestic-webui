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
//
// The scan reads every href in the tree and lets URL decide which ones point
// at the site, rather than matching the host and the query with patterns of
// its own. Two ways such a pattern gets it wrong, and both fail open — the
// link goes out untagged and the suite stays green:
//
//   https://openipc.org?x=1          a query straight after the authority,
//                                    with no path between them, which a
//                                    pattern expecting `/` never collects
//   https://openipc.org/w#a?ref=…    a tag that looks like a query but sits
//                                    inside the fragment, which the browser
//                                    keeps to itself and never sends
//
// URL settles both without a special case: the first parses to this hostname
// like any other, and the second puts everything after the # in `hash`, where
// searchParams cannot see it.
'use strict';

const fs = require('fs');
const path = require('path');
const { check, group, done } = require('./assert');

const ROOT = path.join(__dirname, '..');
const WWW = path.join(ROOT, 'www');
const TAG = 'webui';

// The host, and only the host: wiki.openipc.org is a different site with its
// own counting, and the snapshot upload in sbin/openwall is a machine talking
// to an API rather than a person arriving somewhere.
const HOSTS = ['openipc.org', 'www.openipc.org'];

// Every href, not only the ones that look like they lead here. Resolving each
// against a base means a relative link parses as harmlessly as an absolute
// one, and a haserl expression in the attribute is just another path that
// belongs to no host we count.
const HREF = /href\s*=\s*(["'])([^"']*)\1/g;
const BASE = 'https://camera.invalid/cgi-bin/';

// null for a link that is none of our business; otherwise whether the browser
// would actually send the word. searchParams, so it counts only where it is
// sent: not in the fragment, not glued into the path, and not as the prefix of
// a longer value that happens to start the same way.
function classify(raw) {
	let url = null;
	try {
		url = new URL(raw, BASE);
	} catch (e) {
		// Unparseable is not "not ours". Anything naming the site has to reach
		// the assertions and fail there with its text on screen, rather than be
		// dropped by the reader that could not read it.
		return raw.indexOf('openipc.org') === -1 ? null : { url: null, tagged: false };
	}
	if (HOSTS.indexOf(url.hostname) === -1) return null;
	return { url: url, tagged: url.searchParams.get('ref') === TAG };
}

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
	const where = path.relative(ROOT, file);
	let m;
	HREF.lastIndex = 0;
	while ((m = HREF.exec(src)) !== null) {
		const verdict = classify(m[2]);
		if (verdict) links.push({ file: where, raw: m[2], verdict: verdict });
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
		const url = link.verdict.url;
		check(link.file + ' — ' + link.raw, link.verdict.tagged,
			url ? 'ref=' + url.searchParams.get('ref') : 'unparseable');
	}
}

group('the two links the footer and the Open Wall card put on screen');
{
	const byFile = (f) => links.filter((l) => l.file === f).map((l) => l.raw);

	const footer = byFile('www/cgi-bin/p/footer.cgi');
	check('the footer, which every page with chrome renders, links to the site',
		footer.length === 1, footer.join(' '));
	check('and it is the front page, tagged', footer[0] === 'https://openipc.org/?ref=webui',
		footer[0]);

	const wall = byFile('www/cgi-bin/openwall.cgi');
	check('the Open Wall card links to the wall itself', wall.length === 1, wall.join(' '));
	check('and it is tagged too', wall[0] === 'https://openipc.org/open-wall?ref=webui',
		wall[0]);
}

// classify() is the part of this file that can quietly stop working, so it is
// driven directly on shapes the tree does not contain: a link it waves through
// is a link nobody checks, and one it never collects is the same thing.
group('the scan reads a URL the way a browser will');
{
	const verdict = (raw) => {
		const v = classify(raw);
		return v === null ? 'not ours' : v.tagged;
	};

	check('a query straight after the host is still collected, and untagged fails',
		verdict('https://openipc.org?campaign=x') === false);
	check('a tag in the fragment is not a tag',
		verdict('https://openipc.org/open-wall#a?ref=webui') === false);
	check('nor is one glued onto the path',
		verdict('https://openipc.org/open-wall/ref=webui') === false);
	check('a longer value that merely starts with the word is not the word',
		verdict('https://openipc.org/?ref=webuix') === false);
	check('the tagged front page passes',
		verdict('https://openipc.org/?ref=webui') === true);
	check('so does a tag standing beside another parameter',
		verdict('https://openipc.org/open-wall?a=1&ref=webui') === true);

	check('the wiki is a different site and is not collected',
		verdict('https://wiki.openipc.org/') === 'not ours');
	check('so is a host that merely ends with the name',
		verdict('https://notopenipc.org/') === 'not ours');
	check('a relative link on the camera is not a visit anywhere',
		verdict('openwall.cgi') === 'not ours');
	check('nor is a haserl expression standing where a path goes',
		verdict('<%= $SCRIPT_NAME %>') === 'not ours');
}

done();
