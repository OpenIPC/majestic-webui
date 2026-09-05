// The notice component's markup, from BOTH of the places that emit it.
//
// It is emitted twice, and it has to be: the four banners the camera raises
// and every flash message are written by haserl (`notice` in p/common.cgi),
// while the SD-card health banner, the recordings-page banner and the settings
// page's fatal error are built in the browser (`mjNotice` in main.js). Two
// emitters of one component is exactly the arrangement that drifts.
//
// Every way it can go wrong is silent. A class the stylesheet does not know
// renders as an unstyled div — no console error, no failed request, nothing
// but a banner that has quietly stopped looking like a banner. A mark emitted
// under a different name on one of the two paths means the Dashboard and the
// header disagree about what a warning looks like, which is worse than having
// no mark at all. And the two call sites that would show it are a card gone
// read-only and a stopped daemon: states that need failing hardware to reach,
// so nobody sees either one by accident before a user does.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { check, group, done } = require('./assert');

const A = (f) => path.join(__dirname, '..', 'www', 'a', f);
const CGI = path.join(__dirname, '..', 'www', 'cgi-bin', 'p', 'common.cgi');

// ── the browser half ────────────────────────────────────────────────────────
// main.js compiled the way the other vm tests compile it, so what is checked
// is the function the page runs rather than a copy of it.
function mainGlobals() {
	const ctx = {
		console: console, JSON: JSON, Object: Object, isNaN: isNaN,
		document: { addEventListener() {}, getElementById: () => null,
			querySelector: () => null, querySelectorAll: () => [] },
		window: { addEventListener() {} },
		setTimeout, clearTimeout, setInterval, clearInterval,
		fetch: () => Promise.reject(new Error('no network')),
		location: { pathname: '/', search: '' },
		navigator: {}, localStorage: { getItem: () => null, setItem() {} },
	};
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(A('main.js'), 'utf8') +
		'\n;this.__n = { mjNotice, mjNoticeIcon };', ctx);
	return ctx.__n;
}

const { mjNotice, mjNoticeIcon } = mainGlobals();

// ── the shell half ──────────────────────────────────────────────────────────
// p/common.cgi is a haserl template and cannot be sourced whole, so the two
// functions are cut out of it the way a shell would see them. Cutting rather
// than re-typing is the point: a change to either one has to show up here.
function shellNotice(args) {
	const src = fs.readFileSync(CGI, 'utf8');
	const grab = (name) => {
		const m = src.match(new RegExp('^' + name + '\\(\\) \\{[\\s\\S]*?^\\}', 'm'));
		if (!m) throw new Error('p/common.cgi no longer defines ' + name + '()');
		return m[0];
	};
	const script = grab('notice_icon') + '\n' + grab('notice') + '\nnotice ' +
		args.map((a) => "'" + String(a).replace(/'/g, "'\\''") + "'").join(' ');
	return execFileSync('sh', ['-c', script], { encoding: 'utf8' });
}

group('the two emitters agree, which is the whole reason there are two');

const SEVS = ['danger', 'warn', 'info', 'ok'];
SEVS.forEach((sev) => {
	const js = mjNotice(sev, 'x');
	const sh = shellNotice([sev, 'x']).trim();
	check('the ' + sev + ' notice is byte-identical from haserl and from main.js',
		js === sh, '\n    js: ' + js + '\n    sh: ' + sh);
});

check('a notice with an action matches too',
	mjNotice('warn', 'x', { acts: '<a href="#">Go</a>' }) ===
	shellNotice(['warn', 'x', '<a href="#">Go</a>']).trim(),
	shellNotice(['warn', 'x', '<a href="#">Go</a>']).trim());

check('and a dismissible one',
	mjNotice('ok', 'Saved.', { dismiss: true }) ===
	shellNotice(['ok', 'Saved.', '', '1']).trim(),
	shellNotice(['ok', 'Saved.', '', '1']).trim());

group('the classes the stylesheet actually paints');

const css = fs.readFileSync(A('bootstrap.override.css'), 'utf8');
['mj-notice', 'mj-notice-ico', 'mj-notice-txt', 'mj-notice-body', 'mj-notice-acts']
	.forEach((c) => check('.' + c + ' is styled', css.includes('.' + c), c));
SEVS.forEach((s) => check('.mj-notice-' + s + ' is styled',
	css.includes('.mj-notice-' + s + ' '), s));

// What puts the actions in a column down a stack of banners (#347): the close
// button is out of the flow, and every notice pays for its corner whether or
// not it has one. As a flex item it shifted the actions left by its own width
// on exactly the notices that could be dismissed, which is two right edges in
// one column. A string check rather than a rendered one, because this suite is
// plain node with no browser — but losing either half is silent.
check('every notice reserves the close button its corner',
	/--mj-notice-close:/.test(css) &&
	/padding:[^;]*var\(--mj-notice-close\)/.test(css),
	'the right inset no longer reserves the close slot');
check('and the close button is out of the flow to sit in it',
	/\.mj-notice > \.btn-close \{[^}]*position: absolute/.test(css),
	'a close button back in the flow pushes the actions left again');

// The mark, the actions and the close are one cluster: whatever alignment a
// notice's shape calls for, all three take it. The mark was left behind exactly
// once — it stayed on the first line when the other two were centred, and the
// reporter of #347 is who noticed, not us. So it is centred by default and both
// exceptions that put the others back on the first line have to name it too.
check('the mark is centred with the controls opposite it',
	/\.mj-notice-ico\s*\{[^}]*align-self:\s*center/.test(css),
	'the mark hangs at the top while the actions and the close are centred');
check('and follows them back to the first line in both exceptions',
	(css.match(/\.mj-notice-ico\s*\{[^}]*align-self:\s*flex-start/g) || []).length === 2,
	'a body row and a narrow screen each move all three, or none of them');

const full = mjNotice('warn', 'sentence', {
	body: 'body', acts: '<a href="#">Go</a>', dismiss: true,
});
check('the box carries both the component class and its severity',
	/^<div class="mj-notice mj-notice-warn" role="alert">/.test(full), full);
check('the mark is the first child, or it is not beside the first line',
	full.indexOf('<svg class="mj-notice-ico"') === full.indexOf('<svg'), full);
// The body row is INSIDE the text column, not a sibling of it: as a sibling it
// is a flex item on the same row and lands to the right of the sentence.
check('the body row sits inside the text column',
	full.includes('<div class="mj-notice-txt">sentence<div class="mj-notice-body">body</div></div>'),
	full);
// A direct child, because the stylesheet reaches it as `.mj-notice > .btn-close`
// and main.js closes the notice by walking up from it.
check('the close button is a direct child, and last',
	full.endsWith('<button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button></div>'),
	full);
check('divs balance', (full.match(/<div/g) || []).length === (full.match(/<\/div>/g) || []).length, full);

group('nothing empty is emitted');

const plain = mjNotice('danger', 'x');
check('no action group when there are no actions', !plain.includes('mj-notice-acts'), plain);
check('no close button unless asked for', !plain.includes('btn-close'), plain);
check('the shell agrees', !shellNotice(['danger', 'x']).includes('mj-notice-acts'),
	shellNotice(['danger', 'x']));

group('the marks');

const marks = SEVS.map(mjNoticeIcon);
check('four severities, four distinct marks', new Set(marks).size === 4,
	'got ' + new Set(marks).size);
// Distinguishable without colour: the four are a triangle and three circles,
// and the circles differ by what is inside them.
check('warning is the only triangle',
	marks.filter((m) => m.includes('21.2 19.4H2.8')).length === 1, marks.length);
check('an unrecognised severity still draws something',
	mjNoticeIcon('nonsense') === mjNoticeIcon('info'), mjNoticeIcon('nonsense'));
// currentColor, or the severity class cannot colour it — which is the defect
// this component was built to fix: .st-alert-ico hard-coded --bs-warning and
// painted every notice amber, including the informational one.
marks.forEach((m, i) => check(SEVS[i] + "'s mark takes its colour from the class",
	m.includes('stroke="currentColor"'), m.slice(0, 60)));

group('main.js can still close one');

const dismiss = fs.readFileSync(A('main.js'), 'utf8');
check('data-bs-dismiss reaches .mj-notice as well as .alert',
	/closest\('\.alert, \.mj-notice'\)/.test(dismiss),
	'a dismiss that only knows .alert is an inert x on every notice');


group('one vocabulary for the actions, wherever they are written');

// A notice is read the way a system dialog is, so the thing to press is shaped
// like one: every action is a button, and the colour says what pressing costs.
// btn-primary goes to the page that fixes the finding, btn-secondary is a
// second diagnostic destination beside it, and btn-danger is the press that
// acts on the camera rather than going anywhere — today one href, restart.cgi,
// which reboots on GET.
//
// btn-danger is the load-bearing one. main.js hangs its confirm() off
// .btn-danger and .btn-warning, so wearing that class is a promise that
// pressing does something worth asking about; the recordings banner wore it
// over a plain navigation and came within one initAll() timing accident of
// asking "Are you sure?" before letting somebody read a page.
//
// The rule is worth a test rather than a paragraph because it is written in
// three languages at once — a haserl argument, hand-written .mj-notice-acts
// markup, and an `acts:` literal in JS — and nothing compared them, so it
// drifted: two banners on one Dashboard offered the same thing in two shapes
// (#347). Every way this breaks renders perfectly. Right link, right
// destination, wrong shape.
const ACTS_ON_CAMERA = new Set(['restart.cgi']);

// Every action in the tree, named. Named rather than counted, because the
// failure this scan exists to catch is an action written in a spelling
// actionGroups() cannot read: it then escapes every check below and the run
// looks exactly like a passing one. A floor — "at least eight" — is green in
// precisely that case, so it protects nothing. Against this list an action
// that stops being recognised is a line that went missing.
//
// The cost is that adding a notice action edits this list, and that is the
// point: it is the review the vocabulary did not have.
const EXPECTED = [
	'a/recordings.js sdcard.cgi "Open the SD card page"',
	'a/update-check.js update.cgi "Firmware update"',
	'cgi-bin/camera.cgi logs.cgi "Open the log"',
	'cgi-bin/camera.cgi restart.cgi "Restart camera"',
	'cgi-bin/dashboard.cgi camera.cgi "Open Day / Night"',
	// The two on the no-video banner are empty here and filled by dashboard.js.
	'cgi-bin/dashboard.cgi camera.cgi ""',
	'cgi-bin/dashboard.cgi logs.cgi ""',
	'cgi-bin/dashboard.cgi live.cgi "Open Live"',
	'cgi-bin/p/header.cgi config.cgi "Configuration file"',
	'cgi-bin/p/header.cgi network.cgi "Network settings"',
	'cgi-bin/p/header.cgi network.cgi "Set the MAC address"',
	'cgi-bin/p/header.cgi restart.cgi "Restart camera"',
];

// The shell words of a `<% notice ... %>` call, quoted the way sh reads them.
// The sentences carry apostrophes and the actions carry double-quoted
// attributes, so both quote styles are in use and splitting on whitespace is
// not enough.
function shellWords(line) {
	const out = [];
	let cur = '', q = null, started = false;
	for (const ch of line) {
		if (q) {
			if (ch === q) q = null;
			else cur += ch;
			continue;
		}
		if (ch === "'" || ch === '"') { q = ch; started = true; continue; }
		if (/\s/.test(ch)) {
			if (started || cur) out.push(cur);
			cur = ''; started = false;
			continue;
		}
		cur += ch;
	}
	if (started || cur) out.push(cur);
	return out;
}

// common.cgi's notice() and main.js's mjNotice() BUILD the action span, so the
// hit inside each of them is the component itself rather than somewhere an
// action was written. Matched by the exact placeholder each one interpolates,
// so a real group can never be mistaken for one of these.
const EMITTERS = ['%s', "' + o.acts + '"];

// Every action group in the tree, in the three shapes one gets written in.
function actionGroups(file, src) {
	const out = [];
	const add = (html) => { if (html && html.trim()) out.push({ file, html }); };
	let m;

	const haserl = /<%\s*notice\s+([\s\S]*?)%>/g;
	while ((m = haserl.exec(src))) add(shellWords(m[1])[2]);

	const markup = /<span class="mj-notice-acts">([\s\S]*?)<\/span>/g;
	while ((m = markup.exec(src))) {
		if (EMITTERS.indexOf(m[1]) < 0) add(m[1]);
	}

	// Written as `acts: '<a …>'`. Anything else is not skipped quietly: a call
	// site this cannot read is a call site the rule stops covering.
	const key = /\bacts:\s*/g;
	while ((m = key.exec(src))) {
		// Not the ones in the two emitters' own usage notes: a comment emits
		// nothing. Three prefixes because the files scanned are written in two
		// languages -- // and * for JS, # for the haserl shell.
		const bol = src.lastIndexOf('\n', m.index) + 1;
		if (/^\s*(\/\/|\*|#)/.test(src.slice(bol, m.index))) continue;
		const lit = /^'((?:[^'\\]|\\.)*)'/.exec(src.slice(m.index + m[0].length));
		check('the acts: in ' + file + ' is a literal this test can read',
			!!lit, src.slice(m.index, m.index + 80));
		if (lit) add(lit[1]);
	}
	return out;
}

function walk(dir) {
	const out = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const f = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...walk(f));
		else if (/\.(cgi|js)$/.test(e.name)) out.push(f);
	}
	return out;
}

const WWW = path.join(__dirname, '..', 'www');
const groups = walk(WWW).flatMap((f) =>
	actionGroups(path.relative(WWW, f), fs.readFileSync(f, 'utf8')));

const found = [];
groups.forEach((g) => {
	const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/g;
	let a;
	while ((a = re.exec(g.html))) {
		const attrs = a[1], text = a[2].trim();
		const cls = (/\bclass="([^"]*)"/.exec(attrs) || ['', ''])[1].split(/\s+/);
		const href = (/\bhref="([^"]*)"/.exec(attrs) || ['', ''])[1];
		const page = href.split(/[?#]/)[0].replace(/^.*\//, '');
		const where = g.file + ': ' + a[0];
		const has = (c) => cls.indexOf(c) >= 0;
		found.push(g.file + ' ' + page + ' "' + text + '"');

		check(page + ' in ' + g.file + ' is a button', has('btn'),
			where + '\n    a bare link among banners of buttons');

		// The confirm() class, spent only where pressing really does something.
		check(page + ' in ' + g.file + ' asks before it acts, or does not claim to',
			(has('btn-danger') || has('btn-warning')) === ACTS_ON_CAMERA.has(page),
			ACTS_ON_CAMERA.has(page)
				? where + '\n    acts on the camera without the class that asks first'
				: where + '\n    navigation wearing the class main.js hangs confirm() off');

		// An arrow said what the button shape already says. Dropped at the
		// reporter's request, and pinned so it cannot creep back one banner at
		// a time.
		check('"' + text + '" carries no arrow', !/(&rarr;|→)$/.test(text), where);
	}
});

const missing = EXPECTED.filter((e) => found.indexOf(e) < 0);
const extra = found.filter((f) => EXPECTED.indexOf(f) < 0);
check('every notice action the tree holds is one the scan can read',
	missing.length === 0,
	'no longer found, so no longer checked:\n    ' + missing.join('\n    '));
check('and the scan reads nothing this list has not been told about',
	extra.length === 0,
	'add it to EXPECTED once its shape is right:\n    ' + extra.join('\n    '));

// dashboard.js writes two of those labels at runtime, into anchors the markup
// has already given the right classes. It must not append an arrow to either.
const dash = fs.readFileSync(A('dashboard.js'), 'utf8');
check('the runtime-filled labels carry no arrow either',
	!/\.label \+ ' →'/.test(dash),
	'dashboard.js fills #st-alert-novideo-a and -h');

done();
