// The self-contained first-boot page, checked for the two things about it that
// fail silently.
//
// The first is the logo. setup.html carries an inline copy of www/a/logo.svg
// because it has to: on an unclaimed camera majestic answers 401 to every
// /a/* path, so a <img src="/a/logo.svg"> renders a broken image on the one
// page in the tree that cannot recover from it. That copy is the cost of the
// page being self-contained, and the cost of a copy is drift — a rebrand lands
// in a/logo.svg, nobody re-reads the first-boot page, and the camera greets its
// new owner with the old mark. Nothing on the camera notices, and reproducing
// it needs a camera that has never been claimed. So it is pinned here.
//
// The second is the acceptance gate. The page may never tick the EULA checkbox
// on anyone's behalf, and that is a property of the source rather than of any
// run: a line that sets .checked would be invisible in review the moment it is
// spelled slightly differently, and its effect — acceptance recorded without a
// person — leaves exactly the same trace as a real one.
'use strict';

const fs = require('fs');
const path = require('path');
const { check, group, done } = require('./assert.js');

const root = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(root, 'www/setup.html'), 'utf8');
const logo = fs.readFileSync(path.join(root, 'www/a/logo.svg'), 'utf8');

group('every pre-auth page carries the real logo');
{
	// majestic's pre-auth whitelist is exactly /, /favicon.ico and these three
	// self-contained pages; /a/* answers 401 to a request without a session —
	// on an unclaimed camera AND on a claimed one being shown the sign-in page.
	// So each of them has to carry the artwork itself, and each copy can drift
	// away from a/logo.svg on its own. Nothing on the camera notices: the pages
	// still render, just with last year's mark, and the only way to see it is
	// to sign out or factory-reset.
	const PREAUTH = ['www/setup.html', 'www/login.html', 'www/cameras.html'];
	const paths = (s) => (s.match(/ d="[^"]+"/g) || []).map((d) => d.trim());
	const inFile = paths(logo);

	check('the logo file has path data to compare', inFile.length > 0,
		'www/a/logo.svg has no <path d="…">');

	for (const f of PREAUTH) {
		const src = fs.readFileSync(path.join(root, f), 'utf8');
		const mine = paths(src);
		check(`${f} carries every path of www/a/logo.svg`,
			inFile.length === mine.length && inFile.every((d, i) => d === mine[i]),
			`logo.svg has ${inFile.length} paths, ${f} has ${mine.length}` +
			(inFile.length === mine.length
				? '; the data differs — re-copy the <path> elements'
				: ''));
		check(`${f} inlines it rather than requesting /a/`,
			!/<img[^>]+\/a\/logo\.svg/.test(src) && !/href="\/a\/logo\.svg"/.test(src),
			'/a/* answers 401 without a session, so this would be a broken image');
		check(`${f} no longer shows the text wordmark`,
			!/Open<span>IPC<\/span>/.test(src),
			'the real mark exists; a hand-set one beside it is the bug being fixed');
	}
}

group('acceptance belongs to the person at the keyboard');
{
	// Any assignment to the checkbox's checked property, however it is reached.
	const setsChecked =
		/\.checked\s*=(?!=)/.test(page.replace(/pw\.type|cf\.type/g, ''));
	check('nothing in the page assigns .checked', !setsChecked,
		'ticking the box IS the acceptance; it may only come from a person');
	check('the checkbox is never pre-checked in the markup',
		!/<input[^>]*id="eula"[^>]*\bchecked\b/.test(page));
	check('the box is disabled until a document is on screen',
		/eula\.disabled\s*=\s*true/.test(page));
	check('the owner-only note is still on the page',
		/AI agents\s*\n?\s*and automation must not accept it/.test(page)
		|| /AI agents and automation must not accept it/.test(page));
}

group('the reading gate holds both controls, not just the box');
{
	// The trap this guards is that a DISABLED checkbox is barred from
	// constraint validation, so checkValidity() answers true for it. Gating
	// only the checkbox therefore makes the step MORE permissive than no gate
	// at all: Continue asks "is it ticked", gets "yes" from a box nobody could
	// tick, and walks an unread agreement through to the password. It looks
	// exactly like a working page while it happens, and reproducing it needs an
	// unclaimed camera and a browser.
	check('the scroll gate drives the Continue button too',
		/getElementById\('continue'\)\.disabled\s*=/.test(page),
		'a disabled checkbox passes checkValidity(); Continue must be held separately');
	check('Continue also refuses when the text is unread',
		/if\s*\(!gateOff\s*&&\s*!readToEnd\)\s*return;/.test(page));
	check('a document too short to scroll counts as read',
		/\w+\.height\s*<=\s*\w+\s*-\s*\w+\)\s*return true/.test(page),
		'without this a short agreement makes the form permanently unsubmittable');

	// Below 40rem the pane is released and the document becomes the page, so
	// the pane NEVER overflows. "Does not overflow" therefore stops meaning
	// "shorter than its box" and starts being true on every phone, at load —
	// and the answer above is "already read". Measured with the media query in
	// and this untouched: the checkbox came up enabled and the must-read line
	// hidden before a word had moved, i.e. the stylesheet quietly repealing the
	// gate. It is the exact shape of failure this file exists for: the page
	// looks right while it happens, and seeing it needs an unclaimed camera,
	// a phone, and an agreement nobody read.
	check('a released pane is not mistaken for a document that fits',
		/scrollHeight\s*-\s*\w+\.clientHeight\s*>\s*\w+\)\s*\{/.test(page)
		&& /getBoundingClientRect\(\)/.test(page),
		'the overflow test must SELECT the scroller, not answer the question');
	check('the page scroll drives the gate too, since on a phone it is the scroller',
		/window\.addEventListener\('scroll',\s*syncAccept/.test(page),
		'without it the gate never re-asks while the document is being read');
	check('a language switch clears it — the new text is unread',
		/readToEnd\s*=\s*false;/.test(page));
	check('and the gate is dropped where there is no pane to scroll',
		(page.match(/gateOff\s*=\s*true;/g) || []).length >= 2,
		'both degrade() and linksOnly() must turn it off');
}

group('the optional key is the server\'s to judge');
{
	// /setup stops existing the moment it works, so a key dropped during the
	// claim can never be installed through this flow again. This page's reading
	// of a key is a guess made to be helpful; it must not be what decides
	// whether the key is offered at all. A key the SERVER refuses costs a 400
	// on a camera that is still unclaimed — a form you can correct.
	check('the key is sent on there being one, not on this page approving it',
		/if \(sshbox\.style\.display === 'block' && typed\)/.test(page),
		'gating the send on the client verdict silently drops keys');
	check('a private key is the one thing held back',
		/if \(key && key\.fatal\) return fail/.test(page));

	// /setup is one-shot, so a second POST is never useful and, in flight, is a
	// race against the camera's own password write. sayAboutKey() runs on every
	// keystroke in the key box and on every language change.
	check('an in-flight or finished claim keeps the button down',
		/btn\.disabled = busy;/.test(page) && /busy = true;/.test(page),
		'sayAboutKey() must not hand the button back mid-request');
	check('and a refusal hands it back, since that camera is still unclaimed',
		(page.match(/busy = false;/g) || []).length >= 2);
}

group('the pre-auth pages stay self-contained');
{
	// Anything the browser must fetch to RENDER one of these is a request that
	// answers 401 without a session — which is every request these pages can
	// make, since they are what is shown when there is no session yet. Fetches
	// made by script (the agreement, the capability probe) degrade on their
	// own; markup cannot.
	for (const f of ['www/setup.html', 'www/login.html', 'www/cameras.html']) {
		const src = fs.readFileSync(path.join(root, f), 'utf8');
		const externals = (src.match(/<(?:link|script|img)\b[^>]*/g) || [])
			.filter((t) => /\b(?:src|href)="(?!#)/.test(t))
			.filter((t) => !/href="\/eula\./.test(t)); // the raw no-script links
		check(`${f} loads no stylesheet, script or image from the camera`,
			externals.length === 0, externals.join(' | '));
	}
}

group('both steps live in one form');
{
	// The no-script path posts this form directly and majestic answers 303. Two
	// <form>s, or a Continue that submits, would break that path silently — it
	// is only ever exercised by a browser with JavaScript switched off.
	check('exactly one form', (page.match(/<form\b/g) || []).length === 1);
	check('Continue is type=button, so it cannot submit',
		/<button type="button" id="continue"/.test(page));
	check('the form still posts to /setup without script',
		/<form[^>]*method="post"[^>]*action="\/setup"/.test(page));
	check('the password fields are inside that form',
		page.indexOf('id="password"') > page.indexOf('<form') &&
		page.indexOf('id="password"') < page.indexOf('</form>'));
}

done();
