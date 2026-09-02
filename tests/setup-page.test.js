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

group('setup.html carries the real logo');
{
	// Compared as path data rather than as bytes: the file is a standalone
	// document with its own width/height/style attributes, and the page's copy
	// is sized by CSS and labelled for assistive tech. What must not drift is
	// the artwork.
	const paths = (s) => (s.match(/ d="[^"]+"/g) || []).map((d) => d.trim());
	const inFile = paths(logo);
	const inPage = paths(page);

	check('the logo file has path data to compare', inFile.length > 0,
		'www/a/logo.svg has no <path d="…">');
	check('setup.html carries every path of www/a/logo.svg',
		inFile.length === inPage.length && inFile.every((d, i) => d === inPage[i]),
		`logo.svg has ${inFile.length} paths, setup.html has ${inPage.length}` +
		(inFile.length === inPage.length
			? '; the data differs — re-copy the <path> elements'
			: ''));
	check('the copy is inline, not a request to /a/',
		!/<img[^>]+\/a\/logo\.svg/.test(page),
		'an unclaimed camera answers 401 to /a/*, so this would be a broken image');
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
		/scrollHeight\s*-\s*\w+\.clientHeight\s*<=\s*\w+\)?\s*\)?\s*return true/.test(page),
		'without this a short agreement makes the form permanently unsubmittable');
	check('a language switch clears it — the new text is unread',
		/readToEnd\s*=\s*false;/.test(page));
	check('and the gate is dropped where there is no pane to scroll',
		(page.match(/gateOff\s*=\s*true;/g) || []).length >= 2,
		'both degrade() and linksOnly() must turn it off');
}

group('the page stays self-contained');
{
	// Anything the browser would have to fetch to render this page is a request
	// an unclaimed camera answers 401 to. The document and the capability probe
	// are fetched by script and degrade on their own; markup may not.
	const externals = (page.match(/<(?:link|script|img)\b[^>]*/g) || [])
		.filter((t) => /\b(?:src|href)="(?!#)/.test(t))
		.filter((t) => !/href="\/eula\./.test(t)); // the raw no-script links
	check('no stylesheet, script or image is loaded from the camera',
		externals.length === 0, externals.join(' | '));
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
