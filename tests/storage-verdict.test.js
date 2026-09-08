// What the camera says when its SD card has stopped taking footage.
//
// This is the failure with no symptom. The picture stays live, every counter
// stays healthy, ONVIF goes on answering, and the archive simply stops
// growing — so the only thing standing between an owner and a week of missing
// recordings is a sentence in the interface. Two ways that sentence can be
// silently wrong, and both have already happened here:
//
//   - The verdict says nothing when something is wrong. A card mounted
//     read-only reports its old free space through df, which is why the
//     Dashboard drew a green badge over a card that had recorded nothing
//     since lunchtime.
//   - The verdict says nothing because it asked the wrong half. With no card
//     at all, majestic reports records_state 0 — "ok" — because the recorder
//     never started, so the state never moved off its initial value. Measured
//     on a lab hi3516av300 with the card physically removed. Anything reading
//     that alone is looking straight at a dead camera and seeing health.
//
// And one way it can be wrong out loud: the banner on every page and the
// Recordings page's own alert describing one card in two vocabularies. They
// share this module so that cannot happen, and the test walks every state to
// keep the sharing real rather than nominal.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const A = (f) => path.join(__dirname, '..', 'www', 'a', f);

function loadVerdict() {
	const ctx = { window: {}, console };
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(A('storage-verdict.js'), 'utf8'), ctx);
	return ctx.window.MajesticStorageVerdict;
}

const V = loadVerdict();

// A recorder that answered with a reading, one that answered without the
// endpoint, and one that could not be asked at all.
const rec = (n) => ({ v: { records_state: n } });
const OLD = { absent: true };          // majestic too old to have the endpoint
const UNASKED = null;                  // the request failed

const TROUBLE = ['readonly', 'unreadable', 'unformatted', 'unmounted', 'absent'];


// ---- the banner itself ---------------------------------------------------
//
// The verdict above can be perfect and still never reach anybody. This half
// runs storage-check.js against a stubbed page and pins the three ways it
// could go quiet without saying so: the wrong gate on records.enabled, a
// heartbeat sample it does not understand, and the suppression on the two
// pages that carry the verdict themselves.

function loadBanner(opts) {
	const o = opts || {};
	const els = {};
	const el = (id) => (els[id] = els[id] || { id, innerHTML: '', textContent: '', className: '' });
	const env = { els, el, asked: [], beats: [], timers: 0 };

	const ctx = {
		console,
		JSON, Promise, Object, Set, String, Number, Array, Error, RegExp, Math,
		setInterval: () => { env.timers++; return 0; },
		clearInterval() {},
		setTimeout,
		document: {
			readyState: 'complete',
			addEventListener() {},
			getElementById: (id) => (o.missing === id ? null : el(id)),
			body: { id: o.page || 'page-live' },
		},
	};
	ctx.window = ctx;
	ctx.apiFetch = (url) => {
		env.asked.push(url);
		return Promise.resolve({ json: () => Promise.resolve(o.card || { health: 'ok' }) });
	};
	ctx.mjConfig = () => Promise.resolve({ records: { enabled: o.recording !== false } });
	ctx.mjGet = (cfg, dot) => dot.split('.').reduce((a, k) => (a == null ? undefined : a[k]), cfg);
	// The real builder's shape, in miniature: the action belongs to the notice,
	// so a stub that dropped it would hide a banner with nowhere to go.
	ctx.mjNotice = (sev, html, opt) =>
		'<notice sev="' + sev + '">' + html + ((opt && opt.acts) || '') + '</notice>';
	ctx.mjMetricsSubscribe = (fn) => { env.beats.push(fn); };

	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(A('storage-verdict.js'), 'utf8'), ctx);
	vm.runInContext(fs.readFileSync(A('storage-check.js'), 'utf8'), ctx);
	env.beat = (v) => env.beats.forEach((fn) => fn(v === null
		? { ok: false } : { ok: true, m: { v } }));
	env.banner = () => el('storage-notice').innerHTML;
	return env;
}

const settle = () => new Promise((r) => setTimeout(r, 20));

async function banners() {
	group('the banner reaches the pages that were saying nothing');

	{
		const env = loadBanner({ card: { health: 'absent' } });
		await settle();
		env.beat({ records_state: 0 });
		check('a dead card is announced on an ordinary page',
			/no SD card/.test(env.banner()), env.banner().slice(0, 90));
		check('and it is a danger notice',
			/sev="danger"/.test(env.banner()), env.banner().slice(0, 40));
		check('pointing at the page that deals with the card',
			/sdcard\.cgi/.test(env.banner()));
	}

	{
		const env = loadBanner({ card: { health: 'ok' } });
		await settle();
		env.beat({ records_state: 0 });
		check('a healthy camera is not nagged', env.banner() === '', env.banner());
	}

	group('and stays quiet where it would be noise or a lie');

	{
		// The camera is not recording to a card at all. A banner about storage
		// nobody asked to use is what teaches people to ignore banners.
		const env = loadBanner({ recording: false, card: { health: 'absent' } });
		await settle();
		env.beat({ records_state: 0 });
		check('records.enabled off means no banner and no polling',
			env.banner() === '' && env.asked.length === 0,
			env.banner() + ' / ' + env.asked.length + ' requests');
	}

	['page-recordings', 'page-sdcard'].forEach(function (page) {
		const env = loadBanner({ page, card: { health: 'absent' } });
		check(page + ' is left to say it itself',
			env.banner() === '' && env.asked.length === 0);
	});

	{
		// A heartbeat that failed is not a recorder reporting health. The card
		// half still carries the verdict.
		const env = loadBanner({ card: { health: 'absent' } });
		await settle();
		env.beat(null);
		check('a failed heartbeat does not silence the card half',
			/no SD card/.test(env.banner()), env.banner().slice(0, 90));
	}

	{
		// An older majestic with no records_state at all: the card half is
		// still the whole answer, and it must not be lost.
		const env = loadBanner({ card: { health: 'readonly' } });
		await settle();
		env.beat({ isp_again: 1024 });
		check('a majestic with no recorder metrics still reports the card',
			/read-only/.test(env.banner()), env.banner().slice(0, 90));
	}

	done();
}

function main() {
	group('every card state that means "not recording" says so');

	TROUBLE.forEach(function (h) {
		const v = V.of({ health: h, mountpoint: '/mnt/mmcblk0p1' }, rec(0), '');
		check(h + ' is a verdict, not silence', !!v);
		if (!v) return;
		check(h + ' is worded for a banner and for a page',
			!!v.short && !!v.detail, JSON.stringify(v.short));
		// The short form goes inside a <b> in a notice; anything that carried
		// markup of its own would either escape into the page or be shown raw.
		check(h + "'s short form is a plain sentence",
			v.short.indexOf('<') < 0, v.short);
		check(h + ' names the consequence, not just the state',
			/being recorded|being lost/.test(v.short), v.short);
	});

	{
		const v = V.of({ health: 'ok' }, rec(0), '');
		check('a healthy card and a happy recorder say nothing', v === null,
			JSON.stringify(v));
	}

	group('the trap: a missing card leaves the recorder reporting "ok"');

	{
		// Measured on the lab camera with the card removed: health "absent",
		// records_state 0, because the recorder never started. A check that
		// trusted the recorder alone would call this healthy.
		const v = V.of({ health: 'absent' }, rec(0), '');
		check('records_state 0 does not overrule an absent card',
			!!v && v.kind === 'absent', v && v.kind);
		check('and it is stated as danger, not a hint',
			!!v && v.level === 'danger', v && v.level);
	}

	{
		// The other half of the same trap, and the one that was drawing green
		// on the Dashboard: df reports a read-only card's old free space.
		const v = V.of({ health: 'readonly' }, rec(0), '');
		check('a read-only card is danger even with the recorder at 0',
			!!v && v.level === 'danger' && v.kind === 'readonly', v && v.kind);
	}

	group('the recorder is asked first, because it is the more specific answer');

	{
		// A card that went read-only under the recorder shows up in both, and
		// "the camera cannot write to the card" is what somebody looking at an
		// empty archive needs to read.
		const v = V.of({ health: 'readonly' }, rec(2), '');
		check('a failing recorder outranks the filesystem verdict',
			!!v && v.kind === 'failing', v && v.kind);
	}

	[[3, 'offline'], [2, 'failing'], [1, 'degraded']].forEach(function (p) {
		const v = V.of({ health: 'ok' }, rec(p[0]), '');
		check('records_state ' + p[0] + ' is reported on a healthy filesystem',
			!!v && v.kind === p[1], v && v.kind);
	});

	{
		const v = V.of({ health: 'ok' }, rec(0), '4 min');
		check('footage dropped by a card that cannot keep up is reported',
			!!v && v.kind === 'dropping', v && v.kind);
		check('and the page-measured amount reaches the long form only',
			!!v && v.detail.indexOf('4 min') >= 0 && v.short.indexOf('4 min') < 0,
			v && v.short);
	}

	group('an unknown card is never painted green');

	check('a card the endpoint could not answer for is not writable',
		V.writable(null, rec(0)) === false);
	check('a healthy card whose recorder could not be asked is not writable',
		V.writable({ health: 'ok' }, UNASKED) === false);
	check('a healthy card on a majestic too old to be asked still is',
		V.writable({ health: 'ok' }, OLD) === true);
	check('a healthy card with a happy recorder is',
		V.writable({ health: 'ok' }, rec(0)) === true);
	TROUBLE.forEach(function (h) {
		check(h + ' is not writable', V.writable({ health: h }, rec(0)) === false);
	});

	group('the banner and the Recordings page share one vocabulary');

	{
		// Not a spot check: every state this module can reach has to carry
		// both forms, because the drift being guarded against is one of them
		// being added later without the other.
		const all = TROUBLE.map(function (h) { return V.of({ health: h }, rec(0), ''); })
			.concat([1, 2, 3].map(function (n) { return V.of({ health: 'ok' }, rec(n), ''); }))
			.concat([V.of({ health: 'ok' }, rec(0), '10 s')]);
		check('every reachable verdict has both forms',
			all.every(function (v) { return v && v.short && v.detail && v.kind && v.level; }),
			String(all.length) + ' verdicts');
		const kinds = all.map(function (v) { return v.kind; });
		check('and each is a distinct kind', new Set(kinds).size === kinds.length,
			kinds.join(','));
	}

	banners();
}

main();
