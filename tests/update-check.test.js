// The update banner's arithmetic and its silences.
//
// Two halves matter here and only one of them is visible. The first is the
// counting: which builds are "since mine", and does the sentence read properly
// at one fix and at ninety. The second is every path that must render NOTHING —
// no feed, no network, a revision the ledger has never heard of, a build newer
// than the feed, a dismissal still standing. Those are the ones that fail
// silently in production: a banner that wrongly appears is embarrassing, and a
// banner that wrongly appears on a camera with no internet is a bug report.
//
// The real DOMContentLoaded handler is driven through a fake DOM rather than a
// copy of its logic, so the wiring — the slot's data attributes, the fetch, the
// dismissal key — is under test too.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const SRC = fs.readFileSync(
	path.join(__dirname, '..', 'www', 'a', 'update-check.js'), 'utf8');

const DAY = 86400000;
const iso = (daysAgo) =>
	new Date(Date.now() - daysAgo * DAY).toISOString().slice(0, 10);

// A feed newest-first, the way scripts/release-notes.py writes it.
function feedOf(entries, cursor) {
	return {
		as_of: iso(0), cursor: cursor || (entries[0] && entries[0].sha) || null,
		oldest: entries.length ? entries[entries.length - 1].sha : null,
		builds: entries,
	};
}
function entry(sha, counts, notes) {
	return {
		sha, date: iso(1),
		counts: Object.assign({ feature: 0, fix: 0, security: 0, other: 0 }, counts),
		notes: notes || [],
	};
}

// Returns what the banner rendered: {sev, html} or null for "said nothing".
function run(opts) {
	let handler = null;
	let stored = opts.seen || null;
	const slot = {
		innerHTML: '',
		dataset: { mjVersion: opts.version, socVendor: opts.vendor || '' },
		addEventListener() {},
	};
	let painted = null;

	const ctx = {
		console, JSON, Object, Set, Date, Math, isNaN, String, Number, Promise,
		setTimeout, clearTimeout,
		window: {},
		document: {
			addEventListener(ev, fn) { if (ev === 'DOMContentLoaded') handler = fn; },
			getElementById(id) { return id === 'update-notice' ? slot : null; },
		},
		localStorage: {
			getItem() { if (opts.storageThrows) throw new Error('denied'); return stored; },
			setItem(k, v) { if (opts.storageThrows) throw new Error('denied'); stored = v; },
		},
		mjNotice(sev, html) { painted = { sev, html }; return '<div>' + html + '</div>'; },
		fetch() {
			if (opts.netFails) return Promise.reject(new Error('offline'));
			if (opts.httpStatus) return Promise.resolve({ ok: false, status: opts.httpStatus });
			return Promise.resolve({ ok: true, json: () => Promise.resolve(opts.feed) });
		},
	};
	vm.createContext(ctx);
	vm.runInContext(SRC, ctx);
	if (!handler) throw new Error('update-check.js registered no DOMContentLoaded handler');
	handler();
	return new Promise((r) => setTimeout(() => r(painted), 10));
}

const MINE = 'f158e7007';
const VER = (rev, date) => 'Lite HiSilicon (hi3516ev300), HEAD+' + rev + ', ' + date + ' 07:14';

(async function () {
	group('counting what is since my build');

	let got = await run({
		version: VER(MINE, iso(30)),
		feed: feedOf([
			entry('aaaaaaaaa', { feature: 2, fix: 5 }),
			entry('bbbbbbbbb', { fix: 3, other: 4 }),
			entry(MINE, { fix: 99 }),
		]),
	});
	check('sums every build above mine and stops at mine',
		got && /2 new features and 8 fixes/.test(got.html), got && got.html);
	check('counts builds, not commits',
		got && /is 2 builds behind/.test(got.html), got && got.html);
	check('a release with only internal work still counts as a build behind',
		got && /2 builds behind/.test(got.html), got && got.html);
	check('informational when nothing is urgent', got && got.sev === 'info', got && got.sev);

	got = await run({
		version: VER(MINE, iso(30)),
		feed: feedOf([entry('aaaaaaaaa', { fix: 1 }), entry(MINE, {})]),
	});
	check('singular reads "1 build behind", "1 fix"',
		got && /1 build behind/.test(got.html) && /1 fix\./.test(got.html), got && got.html);

	group('what escalates');

	got = await run({
		version: VER(MINE, iso(30)),
		feed: feedOf([entry('aaaaaaaaa', { fix: 2, security: 1 }), entry(MINE, {})]),
	});
	check('a security fix turns the banner amber', got && got.sev === 'warn', got && got.sev);
	check('and is named in the sentence',
		got && /1 security fix/.test(got.html), got && got.html);

	got = await run({
		version: VER(MINE, iso(200)),
		feed: feedOf([entry('aaaaaaaaa', { fix: 1 }), entry(MINE, {})]),
	});
	check('a build older than six months escalates on its own',
		got && got.sev === 'warn', got && got.sev);
	check('and says so', got && /not been updated in over six months/.test(got.html),
		got && got.html);

	got = await run({
		version: VER(MINE, iso(30)), vendor: 'sigmastar',
		feed: feedOf([
			entry('aaaaaaaaa', { fix: 2 }, [{ cat: 'fix', vendor: 'sigmastar', text: 'x' }]),
			entry(MINE, {}),
		]),
	});
	check('a fix for this camera\'s vendor is called out',
		got && /SigmaStar cameras like this one/.test(got.html), got && got.html);

	got = await run({
		version: VER(MINE, iso(30)), vendor: 'hisilicon',
		feed: feedOf([
			entry('aaaaaaaaa', { fix: 2 }, [{ cat: 'fix', vendor: 'sigmastar', text: 'x' }]),
			entry(MINE, {}),
		]),
	});
	check('another vendor\'s fix is not claimed as this camera\'s',
		got && !/like this one/.test(got.html), got && got.html);

	group('every way it must say nothing');

	check('offline: no banner',
		(await run({ version: VER(MINE, iso(30)), netFails: true })) === null);
	check('feed missing (404): no banner',
		(await run({ version: VER(MINE, iso(30)), httpStatus: 404 })) === null);
	check('up to date: no banner',
		(await run({
			version: VER(MINE, iso(1)),
			feed: feedOf([entry(MINE, { fix: 3 })]),
		})) === null);
	check('a revision the ledger has never heard of: no guess',
		(await run({
			version: VER('deadbeef1', iso(30)),
			feed: feedOf([entry('aaaaaaaaa', { fix: 9 }), entry('bbbbbbbbb', {})]),
		})) === null);
	check('a build newer than the feed: no banner',
		(await run({
			version: VER('99999999a', iso(0)),
			feed: feedOf([entry('aaaaaaaaa', { fix: 9 })]),
		})) === null);
	check('an unparseable version string: no banner',
		(await run({
			version: 'Lite HiSilicon, unknown',
			feed: feedOf([entry('aaaaaaaaa', { fix: 9 }), entry(MINE, {})]),
		})) === null);
	check('an empty feed: no banner',
		(await run({ version: VER(MINE, iso(30)), feed: feedOf([]) })) === null);

	group('dismissal is "not now", not "never"');

	const twoBuilds = feedOf(
		[entry('aaaaaaaaa', { fix: 1 }), entry(MINE, {})], 'aaaaaaaaa');
	check('a dismissal keyed to the current cursor stays dismissed',
		(await run({ version: VER(MINE, iso(30)), feed: twoBuilds, seen: 'aaaaaaaaa' })) === null);
	check('but a newer cursor brings the banner back',
		(await run({ version: VER(MINE, iso(30)), feed: twoBuilds, seen: 'older0000' })) !== null);
	check('localStorage throwing (private mode) does not suppress the banner',
		(await run({ version: VER(MINE, iso(30)), feed: twoBuilds, storageThrows: true })) !== null);

	group('the camera is never made to phone home');
	check('the feed URL carries no query string and no camera identity',
		/const FEED = 'https:\/\/[^']*majestic-changes\.json';/.test(SRC) &&
		!/FEED\s*\+/.test(SRC), 'the feed request must be identical for every camera');

	done();
})();
