// The nav bar's one item that ACTS instead of going somewhere.
//
// Every other entry in the bar is navigation: following it shows you a page,
// and following it by accident costs a click back. Restart camera is not that
// — following it reboots the camera, and the only thing between a slipped
// click and half a minute of dead video is the class main.js hangs confirm()
// off, plus the sentence that says what is about to happen.
//
// Which is why this is a file. Dropping the class is SILENT in every way that
// matters: the markup still parses, the item still renders, the menu still
// looks exactly right, the page lints and the suite goes green. Nothing
// reveals it until somebody clicks the item — and the way it reveals itself is
// by rebooting their camera without asking, which is precisely the outcome the
// class exists to prevent. It cannot be caught by running the page either:
// nobody clicks a reboot to check that it warns first.
//
// tests/notice.test.js holds the same rule for the links inside BANNERS, where
// restart.cgi is also offered. This holds it for the bar, which that scan does
// not read.
'use strict';

const fs = require('fs');
const path = require('path');
const { check, group, done } = require('./assert');

const HEADER = path.join(__dirname, '..', 'www', 'cgi-bin', 'p', 'header.cgi');
const src = fs.readFileSync(HEADER, 'utf8');

// Pages that DO something when opened, rather than showing you something.
// Kept as a list rather than inferred: a page that becomes an action is
// exactly the change nobody thinks to re-check the bar for.
const ACTS_ON_CAMERA = new Set(['restart.cgi', 'factory-reset.cgi']);
// The classes main.js attaches a confirm() to.
const ASKS = ['confirm', 'btn-danger', 'btn-warning'];

// Only the bar's own entries. header.cgi also links pages from its banners,
// and those are notice.test.js's to check.
const items = [];
const re = /<a\b([^>]*\bclass="(?:[^"]*\b)?(?:nav-link|dropdown-item)\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/g;
let m;
while ((m = re.exec(src))) {
	const attrs = m[1];
	const href = (/\bhref="([^"]*)"/.exec(attrs) || ['', ''])[1];
	const page = href.split(/[?#]/)[0].replace(/^.*\//, '');
	if (!page.endsWith('.cgi')) continue;
	items.push({
		page: page,
		cls: (/\bclass="([^"]*)"/.exec(attrs) || ['', ''])[1].split(/\s+/),
		ask: (/\bdata-confirm="([^"]*)"/.exec(attrs) || ['', ''])[1],
		raw: m[0].replace(/\s+/g, ' ').slice(0, 90),
	});
}

group('the bar was read at all');
// A scan that matches nothing passes every check below it, which is the one
// way this file could be green while saying nothing.
check('the nav bar yields entries', items.length >= 10,
	'matched ' + items.length + ' — the markup shape changed and this scan is blind');
check('the acting entry is among them',
	items.some((i) => ACTS_ON_CAMERA.has(i.page)),
	'no entry in the bar links a page that acts; if that is deliberate, this ' +
	'file has nothing left to guard and should go');

group('an entry that acts asks first, and one that navigates does not pretend to');
items.forEach((i) => {
	const asks = ASKS.some((c) => i.cls.indexOf(c) >= 0);
	const acts = ACTS_ON_CAMERA.has(i.page);
	check(i.page + (acts ? ' asks before it acts' : ' does not claim to act'),
		asks === acts,
		acts ? i.raw + '\n    reboots the camera with nothing to stop a slipped click'
			: i.raw + '\n    navigation wearing the class main.js hangs confirm() off');
	if (!acts) return;
	// The generic "Are you sure?" is what main.js falls back to, and it is the
	// wording issue #160 found people clicking through — two buttons a gap
	// apart asking the identical question, one a reboot and one a factory
	// wipe. An action in the bar has to say which one it is.
	check(i.page + ' says what it is about to do',
		i.ask.length > 0, i.raw + '\n    falls back to the generic "Are you sure?"');
	check(i.page + ' says the cost, not just the act',
		/half a minute|settings are kept/i.test(i.ask),
		'prompt: ' + i.ask);
});

done();
