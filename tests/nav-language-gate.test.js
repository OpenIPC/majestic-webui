// The MAX entry in the Services menu, and who sees it.
//
// MAX is a Russian service whose bots only a Russian business can register,
// and its page is Russian throughout, so the entry is rendered `hidden` and
// main.js reveals it only to a browser that says its reader speaks Russian.
//
// It earns a file for the reason everything in tests/ does: both ways of being
// wrong are SILENT. A gate that never reveals leaves Russian readers unable to
// find a page that is installed and working, with nothing on screen to say so.
// A gate that always reveals puts an untranslated page in front of everyone
// else. The markup lints either way, the page renders either way, and the
// existing nav tests read the static bar, which is correct in both.
//
// The second half is the part a browser check found rather than a diff: the
// dropdown's keyboard handler collects `.dropdown-item` and focuses one, and a
// hidden item is still matched by that selector. Focusing something that is
// not rendered leaves focus where it was, so every ArrowDown re-targets the
// same first item and the Services menu stops walking for keyboard users --
// on precisely the browsers that do NOT see MAX, which is most of them.
'use strict';

const fs = require('fs');
const path = require('path');
const { check, group, done } = require('./assert');

const ROOT = path.join(__dirname, '..');
const header = fs.readFileSync(path.join(ROOT, 'www', 'cgi-bin', 'p', 'header.cgi'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'www', 'a', 'main.js'), 'utf8');

group('the entry is hidden in the markup, not rendered on a condition');
{
	const li = /<li id="nav-max"([^>]*)>/.exec(header);
	check('the Services menu carries a nav-max entry', !!li, 'no <li id="nav-max">');
	check('and it ships hidden, so a browser running no script shows it to nobody',
		!!li && /\bhidden\b/.test(li[1]), li && li[1]);

	// Order is a decision, not an accident: for a reader who sees it at all it
	// is the likeliest of the three.
	const notif = header.slice(header.indexOf('Notifications'));
	const first = /<li[^>]*>\s*<a class="dropdown-item" href="([a-z-]+\.cgi)"/.exec(notif);
	check('and it leads the group', /<li id="nav-max"/.test(notif.slice(0, notif.indexOf('dropdown-header', 10))),
		'first item was ' + (first && first[1]));
}

group('who the gate reveals it to');
{
	// The rule as main.js states it, exercised rather than re-implemented: the
	// test reads the predicate out of the file, so a change to the regex is a
	// change here too.
	const m = /const langs = navigator\.languages \|\| \[([^\]]*)\];[\s\S]*?some\.call\(langs, \(l\) => (\/[^/]+\/i)\.test\(l\)\)/.exec(main);
	check('the gate is where this test thinks it is', !!m,
		'the language check in main.js no longer matches');
	const re = m ? new RegExp(m[2].slice(1, -2), 'i') : null;
	const shows = (langs) => !!re && langs.some((l) => re.test(l));

	check('Russian first', shows(['ru-RU', 'ru']) === true, 'hidden');
	check('Russian after English, because a menu entry is not exclusive',
		shows(['en-US', 'ru']) === true, 'hidden');
	check('English only', shows(['en-GB', 'en']) === false, 'shown');
	check('Chinese only', shows(['zh-CN']) === false, 'shown');
	check('an empty list reveals nothing', shows([]) === false, 'shown');
	// `ru` must not be found inside an unrelated tag.
	check('a tag that merely contains the letters is not Russian',
		shows(['bru-BR']) === false, 'shown for bru-BR');

	// The documented fallback when the browser offers no list at all.
	check('there is a fallback for a browser with no languages array',
		/navigator\.languages \|\| \[navigator\.language/.test(main),
		'no navigator.language fallback');
}

group('the keyboard walk skips what is hidden');
{
	check('the dropdown item list filters out hidden ancestors',
		/querySelectorAll\('\.dropdown-item:not\(\.disabled\)'\)\)?\s*\n?\s*\.filter\(el => !el\.closest\('\[hidden\]'\)\)/.test(main),
		'main.js still collects hidden dropdown items, so ArrowDown can focus one');
}

done();
