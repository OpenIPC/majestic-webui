// The Firmware page's own changelog, and the counts beside its Install button.
//
// This is the site-wide banner's information moved onto the page whose button
// summons it, so it fails the way that banner fails: silently. A card that
// never unhides looks exactly like a camera whose browser cannot reach the
// feed, which is a state this page is REQUIRED to render as nothing at all —
// so "nothing appeared" is both the bug and the correct answer, and only a test
// can tell them apart.
//
// The vendor filter is the other half and the worse one. Listing another
// vendor's repair here promises this owner something their camera will never
// do, and it reads perfectly: a sentence about cameras, on a page about a
// camera. fw-changes.js drops those notes and update-check.test.js pins that it
// does; what is pinned here is that this page's own grouping does not put one
// back, and that a note which DID arrive because it is this camera's is marked
// as such.
//
// Not pinned here: the phase strip during a flash. It fails in front of
// somebody who is watching it, with sysupgrade's own transcript underneath it
// saying what actually happened — visible, and corroborated, which is the
// opposite of everything else in this directory.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const A = (f) => path.join(__dirname, '..', 'www', 'a', f);

// A DOM that remembers what was put in it, which is the whole point: the
// assertions are about rendered text and about which elements came out of
// `hidden`.
function makeEl(id) {
	const el = {
		id: id, tagName: 'DIV', innerHTML: '', hidden: false, className: '',
		style: {}, dataset: {}, children: [], _text: '',
		get textContent() {
			return this._text + this.children.map((c) => c.textContent).join('');
		},
		set textContent(v) { this._text = String(v); this.children = []; },
		get firstChild() { return this.children[0] || null; },
		get firstElementChild() { return this.children[0] || null; },
		appendChild(c) { this.children.push(c); return c; },
		addEventListener() {}, removeEventListener() {},
		setAttribute() {}, getAttribute() { return null; },
		classList: { add() {}, remove() {}, contains() { return false; } },
	};
	return el;
}

// A synthetic build, in the shape p/common.cgi's mj_version and soc_vendor
// reach the page. Nothing here is a real revision or a real camera: the point
// is the parsing and the arithmetic, and a fixture that quoted a device would
// put its build identity in the public tree for no coverage at all.
const MINE = 'abcdef123';
const VER = 'Lite HiSilicon (socN), branch+' + MINE + ', 2026-09-06 17:29';

function entry(sha, counts, notes) {
	return {
		sha, date: '2026-09-08',
		counts: Object.assign({ feature: 0, fix: 0, security: 0, other: 0 }, counts),
		notes: notes || [],
	};
}

function run(opts) {
	const els = {};
	const $ = (sel) => {
		const id = String(sel).replace(/^#/, '');
		if (!(id in els)) return null;
		return els[id];
	};
	for (const id of ['fw-output', 'fw-installed', 'fw-status', 'fw-controls',
		'fw-progress', 'fw-head', 'fw-counts', 'fw-news', 'fw-news-body',
		'fw-steps', 'fw-bar', 'fw-progress-hl', 'fw-install-github',
		'fw-install-upload']) {
		els[id] = makeEl(id);
	}
	els['fw-counts'].hidden = true;
	els['fw-news'].hidden = true;
	els['fw-head'].dataset = {
		mjVersion: ('version' in opts) ? opts.version : VER,
		socVendor: opts.vendor || 'hisilicon',
		fwState: opts.state || 'available',
		fwLatest: 'nightly-20260908-bc04f30',
	};

	let ready = null;
	const ctx = {
		console, JSON, Object, Set, Date, Math, isNaN, isFinite, String, Number,
		Array, Promise, RegExp, Error, TextDecoder, setTimeout, clearTimeout,
		setInterval, clearInterval, AbortController,
		window: {},
		performance: { now: () => 0 },
		location: { protocol: 'http:', host: 'cam' },
		WebSocket: function () {},
		DOMParser: function () {},
		document: {
			readyState: 'loading',
			addEventListener(ev, fn) { if (ev === 'DOMContentLoaded') ready = fn; },
			getElementById(id) { return els[id] || null; },
			createElement() { return makeEl('made'); },
		},
		$: $,
		termWriter: () => ({ write: (t) => t, note() {}, commit() {} }),
		rawFetch: () => Promise.reject(new Error('not used here')),
		fetch(url) {
			if (opts.netFails) return Promise.reject(new Error('offline'));
			if (opts.httpStatus) return Promise.resolve({ ok: false, status: opts.httpStatus });
			return Promise.resolve({ ok: true, json: () => Promise.resolve(opts.feed) });
		},
	};
	ctx.window.fetch = ctx.fetch;
	vm.createContext(ctx);
	// Load order is p/header.cgi's: fw-changes.js is deferred and update.js is
	// not, so the page's own script sees the shared counting only once the
	// document is parsed — which is exactly why loadChanges waits for
	// DOMContentLoaded rather than running at module scope.
	for (const f of ['fw-changes.js', 'update.js']) {
		vm.runInContext(fs.readFileSync(A(f), 'utf8'), ctx);
	}
	if (!ready) throw new Error('update.js registered no DOMContentLoaded handler');
	ready();
	return new Promise((r) => setTimeout(() => r({
		counts: els['fw-counts'],
		news: els['fw-news'],
		body: els['fw-news-body'],
	}), 10));
}

const pillText = (o) => o.counts.children.map((c) => c.textContent).join(' | ');

(async function () {
	group('what the update is worth, beside the button');

	let got = await run({
		feed: {
			cursor: 'a', builds: [
				entry('aaaaaaaaa', { feature: 2, fix: 5, security: 1 }),
				entry('bbbbbbbbb', { feature: 3, fix: 10, security: 1 }),
				entry(MINE, { fix: 99 }),
			],
		},
	});
	check('the counts are shown and stop at this build',
		!got.counts.hidden && /5 new features/.test(pillText(got)) &&
		/15 fixes/.test(pillText(got)), pillText(got));
	check('and lead with how far behind, which is what the banner said',
		got.counts.children[0] && /^2 builds behind$/.test(got.counts.children[0].textContent),
		got.counts.children[0] && got.counts.children[0].textContent);
	check('security is a count of its own, first after the build count',
		/2 security fixes/.test(pillText(got)) &&
		pillText(got).indexOf('security') < pillText(got).indexOf('new features'),
		pillText(got));

	got = await run({
		feed: { cursor: 'a', builds: [entry('aaaaaaaaa', { fix: 1 }), entry(MINE, {})] },
	});
	check('singular reads "1 build behind", "1 fix"',
		/1 build behind/.test(pillText(got)) && /\| 1 fix$/.test(pillText(got)), pillText(got));
	check('a category with nothing in it gets no pill',
		!/new feature|security/.test(pillText(got)), pillText(got));

	group('the changes, as the page’s own subject');

	const withNotes = (notes, vendor) => run({
		vendor: vendor,
		feed: {
			cursor: 'a', builds: [
				{ sha: 'aaaaaaaaa', date: '2026-09-08',
				  counts: { feature: 1, fix: 2, security: 1, other: 5 }, notes: notes },
				entry(MINE, {}),
			],
		},
	});

	let n = await withNotes([
		{ cat: 'fix', vendor: null, text: 'Recording no longer stops on its own.' },
		{ cat: 'security', vendor: null, text: 'Who may call the camera is now checked.' },
		{ cat: 'feature', vendor: null, text: 'Streaming can come from both channels.' },
	]);
	check('the card is shown once there is something to put in it', !n.news.hidden);
	check('grouped, security first',
		/Security/.test(n.body.textContent) &&
		n.body.textContent.indexOf('Who may call') <
		n.body.textContent.indexOf('Streaming can come'), n.body.textContent);
	check('features before fixes',
		n.body.textContent.indexOf('Streaming can come') <
		n.body.textContent.indexOf('Recording no longer stops'), n.body.textContent);

	// The disclosure gate withholds sentences it will not publish, so the list is
	// routinely shorter than the counts. A number on a group heading is how a
	// page would point at that gap without meaning to.
	n = await withNotes([{ cat: 'fix', vendor: null, text: 'One described change.' }]);
	check('a group heading carries no count to disagree with the pills',
		!/\b2\b/.test(n.body.textContent), n.body.textContent);
	check('and nothing says the list is short',
		!/not described|withheld|some changes|and \d+ more/i.test(n.body.textContent),
		n.body.textContent);

	n = await withNotes([]);
	check('no sentences at all: the card stays hidden, the counts still show',
		n.news.hidden && !n.counts.hidden, n.body.textContent);

	n = await withNotes([{ cat: 'fix', vendor: null, text: '<img src=x onerror=alert(1)>' }]);
	check('a sentence carrying markup is text, never markup',
		n.body.innerHTML === '' && /<img src=x/.test(n.body.textContent),
		n.body.innerHTML);

	group('a note belongs to the cameras it was written for');

	const mixed = (vendor) => withNotes([
		{ cat: 'fix', vendor: null, text: 'Everyone gets this one.' },
		{ cat: 'fix', vendor: 'hisilicon', text: 'A HiSilicon-only repair.' },
		{ cat: 'fix', vendor: 'sigmastar', text: 'A SigmaStar-only repair.' },
	], vendor);

	let m = await mixed('hisilicon');
	check('this camera sees the global note and its own vendor’s',
		/Everyone gets this one/.test(m.body.textContent) &&
		/HiSilicon-only repair/.test(m.body.textContent), m.body.textContent);
	check('and never another vendor’s',
		!/SigmaStar-only repair/.test(m.body.textContent), m.body.textContent);
	check('the one that is this camera’s is marked as such',
		/A HiSilicon-only repair\.This camera/.test(m.body.textContent), m.body.textContent);
	check('and the one that applies everywhere is not',
		!/Everyone gets this one\.This camera/.test(m.body.textContent), m.body.textContent);

	m = await mixed('sigmastar');
	check('the same feed marks the other vendor theirs instead',
		/A SigmaStar-only repair\.This camera/.test(m.body.textContent) &&
		!/HiSilicon-only/.test(m.body.textContent), m.body.textContent);

	group('every way it must say nothing');

	const silent = async (opts) => {
		const r = await run(opts);
		return r.counts.hidden && r.news.hidden;
	};
	const behind = {
		feed: { cursor: 'a', builds: [entry('aaaaaaaaa', { fix: 3 }), entry(MINE, {})] },
	};

	check('offline: no counts, no card', await silent(Object.assign({}, behind, { netFails: true })));
	check('feed missing (404): no counts, no card',
		await silent(Object.assign({}, behind, { httpStatus: 404 })));
	check('an unparseable version string: nothing',
		await silent(Object.assign({}, behind, { version: 'Lite HiSilicon, unknown' })));
	check('a build the ledger has never heard of: nothing',
		await silent({ feed: { cursor: 'a', builds: [entry('aaaaaaaaa', { fix: 9 })] },
			version: 'Lite HiSilicon (socN), branch+deadbeef1' }));
	check('an empty feed: nothing', await silent({ feed: { cursor: 'a', builds: [] } }));

	// A revision short enough to be a prefix of an unrelated one would stop the
	// walk at the wrong build and report a count with nothing behind it.
	for (const bad of ['f', 'abc', 'ABCDEF123', 'not-a-sha!', '']) {
		check('a feed revision of ' + JSON.stringify(bad) + ' counts nothing',
			await silent({ feed: { cursor: 'a', builds: [
				{ sha: bad, date: '2026-09-08',
				  counts: { feature: 0, fix: 3, security: 0, other: 0 }, notes: [] },
				entry(MINE, {}),
			] } }));
	}

	// The page states what it is offering, and the feed says what changed in the
	// software. On a camera with nothing to install the second without the first
	// is the contradiction j/fw-latest.cgi exists to prevent (#348) — arriving
	// here by a different road.
	check('up to date: the feed is not even asked',
		await silent(Object.assign({}, behind, { state: 'current' })));
	check('no connection: the feed is not even asked',
		await silent(Object.assign({}, behind, { state: 'offline' })));

	done();
})();
