// The nav bar's one item that ACTS instead of going somewhere.
//
// Every other entry in the bar is navigation: following it shows you a page,
// and following it by accident costs a click back. Restart camera is not that
// — following it reboots the camera, so it has to ask first, and it must not
// be reachable in any of the ways a menu item gets followed WITHOUT asking.
//
// Two things are held here, and the second is the one that is easy to get
// wrong. The first is the class main.js hangs confirm() off, plus a prompt
// that says what is about to happen. The second is that an acting entry is
// not an ANCHOR at all: main.js listens for `click`, a middle click fires
// `auxclick` and never `click`, and "Open link in new tab" fires nothing —
// both measured in a browser. As a link this entry would reboot the camera
// with no question asked for anybody who opened a menu item the way they open
// every other menu item, and it would do it from every page in the WebUI. A
// submitting button has no URL to middle-click, to prefetch, or to restore
// with a tab.
//
// Which is why this is a file. Every one of those failures is SILENT: the
// markup still parses, the item still renders, the menu still looks exactly
// right, the page lints and the suite goes green. Nothing reveals them until
// somebody clicks — and the way they reveal themselves is by rebooting a
// camera without asking, which is the outcome all of this exists to prevent.
// Nobody clicks a reboot to check that it warns first.
//
// tests/notice.test.js holds the confirm rule for the links inside BANNERS,
// where restart.cgi is also offered. This holds it for the bar, which that
// scan does not read.
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
//
// Both shapes are read: an <a> naming its page in href, and a <button> whose
// page is the action of the form around it. Reading only anchors would make
// this file blind to exactly the entry it exists for.
const items = [];
const re = /<(a|button)\b([^>]*\bclass="(?:[^"]*\b)?(?:nav-link|dropdown-item)\b[^"]*"[^>]*)>([\s\S]*?)<\/\1>/g;
let m;
while ((m = re.exec(src))) {
	const tag = m[1], attrs = m[2];
	let page;
	if (tag === 'a') {
		page = (/\bhref="([^"]*)"/.exec(attrs) || ['', ''])[1];
	} else {
		// The nearest enclosing form's action, which is where this button goes.
		const before = src.slice(0, m.index);
		const open = before.lastIndexOf('<form');
		page = open < 0 ? ''
			: (/\baction="([^"]*)"/.exec(src.slice(open, m.index)) || ['', ''])[1];
	}
	page = page.split(/[?#]/)[0].replace(/^.*\//, '');
	if (!page.endsWith('.cgi')) continue;
	items.push({
		tag: tag,
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
	// The half a confirm() cannot cover. main.js hears `click`; a middle click
	// delivers `auxclick` and an "Open in new tab" delivers nothing, so an
	// acting entry written as a link is one habitual gesture away from an
	// unannounced reboot — from every page in the WebUI, since this bar is on
	// all of them.
	check(i.page + ' is not a URL that can be opened without asking',
		i.tag === 'button',
		i.raw + '\n    an anchor: middle-click and open-in-new-tab reach it ' +
		'without the confirm');
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
