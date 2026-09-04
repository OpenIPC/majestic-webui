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

done();
