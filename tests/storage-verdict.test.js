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
// The card this endpoint describes, and where the camera is pointed. Every
// case above the last group records to the card, which is the ordinary
// configuration; the last group is what happens when it does not.
const MP = '/mnt/mmcblk0p1';
const ON = MP;                         // records.path's directory, on the card
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
	// The Dashboard's storage rows, one per filesystem df matched. Given as
	// mountpoints so a test can hand over more than one and check that the
	// verdict lands on the right of them.
	const rows = (o.rows || []).map(function (mnt) {
		const badge = { className: 'badge text-bg-secondary flex-shrink-0 mj-sd-badge' };
		const why = { textContent: '' };
		return {
			mnt: mnt, badge: badge, why: why,
			getAttribute: (k) => (k === 'data-mnt' ? mnt : null),
			querySelector: (sel) => (sel === '.mj-sd-badge' ? badge
				: sel === '.mj-sd-why' ? why : null),
		};
	});
	const env = { els, el, rows, asked: [], beats: [], retries: [], polls: [], cfgAsks: 0 };

	const ctx = {
		console,
		JSON, Promise, Object, Set, String, Number, Array, Error, RegExp, Math,
		// The card poll, captured so a test can make the next one happen.
		setInterval: (fn) => { env.polls.push(fn); return 0; },
		clearInterval() {},
		// The module's own retry is captured rather than waited out; anything
		// short is the harness settling and runs for real.
		setTimeout: (fn, ms) => (ms >= 1000 ? (env.retries.push(fn), 0) : setTimeout(fn, ms)),
		document: {
			readyState: 'complete',
			addEventListener() {},
			getElementById: (id) => (o.missing === id ? null : el(id)),
			querySelectorAll: (sel) => (sel === '.mj-sd-row' ? rows : []),
			body: { id: o.page || 'page-live' },
		},
	};
	ctx.window = ctx;
	ctx.apiFetch = (url) => {
		env.asked.push(url);
		if (o.cardFailsAfter !== undefined && env.asked.length > o.cardFailsAfter) {
			return Promise.reject(new Error('unreachable'));
		}
		return Promise.resolve({ json: () => Promise.resolve(o.card || { health: 'ok' }) });
	};
	// {} is what mjConfig() resolves when the fetch failed -- deliberately not
	// cached, so a later call retries. `cfgFails` makes the first N calls do
	// that, the way a camera under load does.
	ctx.mjConfig = () => {
		env.cfgAsks++;
		if (env.cfgAsks <= (o.cfgFails || 0)) return Promise.resolve({});
		return Promise.resolve({ records: {
			enabled: o.recording !== false,
			path: (o.path || '/mnt/mmcblk0p1') + '/%F',
		} });
	};
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
	env.badge = (mnt) => (rows.filter((r) => r.mnt === mnt)[0] || {}).badge;
	env.poll = () => { env.polls.forEach((fn) => fn()); return settle(); };
	return env;
}

const settle = () => new Promise((r) => setTimeout(r, 20));

async function banners() {

	group('the badge is a claim, so it needs evidence for each of its colours');

	const MPT = '/mnt/mmcblk0p1';

	{
		const env = loadBanner({ rows: [MPT], card: { health: 'ok', mountpoint: MPT } });
		await settle();
		check('nothing established yet leaves it neutral',
			/text-bg-secondary/.test(env.badge(MPT).className), env.badge(MPT).className);
		env.beat({ records_state: 0 });
		check('both halves agreeing is what turns it green',
			/text-bg-success/.test(env.badge(MPT).className), env.badge(MPT).className);
	}

	{
		// Footage is being lost. Not danger, and certainly not green.
		const env = loadBanner({ rows: [MPT], card: { health: 'ok', mountpoint: MPT } });
		await settle();
		env.beat({ records_state: 1 });
		check('a warning is drawn as a warning',
			/text-bg-warning/.test(env.badge(MPT).className), env.badge(MPT).className);
	}

	{
		const env = loadBanner({ rows: [MPT], card: { health: 'readonly', mountpoint: MPT } });
		await settle();
		env.beat({ records_state: 0 });
		check('a dead card is drawn as danger',
			/text-bg-danger/.test(env.badge(MPT).className), env.badge(MPT).className);
		check('and the row says why', /read-only/.test(env.rows[0].why.textContent));
	}

	{
		// The heartbeat could not be read, so nothing about the recorder is
		// known and green is a claim nothing supports.
		const env = loadBanner({ rows: [MPT], card: { health: 'ok', mountpoint: MPT } });
		await settle();
		env.beat(null);
		check('a failed heartbeat is not evidence of health',
			/text-bg-secondary/.test(env.badge(MPT).className), env.badge(MPT).className);
	}

	{
		// One row per filesystem df matched, and this endpoint describes one
		// device. The verdict must land on that device's row and no other.
		const env = loadBanner({
			rows: ['/mnt/usbdrive', MPT],
			card: { health: 'absent', mountpoint: MPT },
		});
		await settle();
		env.beat({ records_state: 0 });
		check('a second filesystem is left alone',
			/text-bg-secondary/.test(env.badge('/mnt/usbdrive').className),
			env.badge('/mnt/usbdrive').className);
		check('and the card row is the one marked',
			/text-bg-danger/.test(env.badge(MPT).className), env.badge(MPT).className);
	}

	group('a reading that stopped arriving stops being an answer');

	{
		// The first poll answers, the next one cannot be made. Holding the last
		// good answer is how a badge stays green through an hour of failures.
		const env = loadBanner({
			rows: [MPT], card: { health: 'ok', mountpoint: MPT }, cardFailsAfter: 1,
		});
		await settle();
		env.beat({ records_state: 0 });
		check('the first answer is used', /text-bg-success/.test(env.badge(MPT).className));
		await env.poll();
		check('and a poll that failed takes the claim back, rather than keeping it',
			/text-bg-secondary/.test(env.badge(MPT).className), env.badge(MPT).className);
	}

	group('a configuration that could not be read is not recording switched off');

	{
		// mjConfig() resolves {} on a failed fetch and does not cache it, so a
		// later call retries -- but nothing retried, and one refused request at
		// page load turned every storage alert off for the life of the page.
		const env = loadBanner({
			cfgFails: 1, rows: [MPT],
			card: { health: 'absent', mountpoint: MPT },
		});
		await settle();
		check('a failed config asks for nothing yet', env.asked.length === 0);
		check('but it does arrange to ask again', env.retries.length === 1);
		env.retries[0]();
		await settle();
		env.beat({ records_state: 0 });
		check('and on the retry the camera is monitored after all',
			/no SD card/.test(env.banner()), env.banner().slice(0, 90));
	}

	{
		// Explicitly off is a fact, and facts are not retried.
		const env = loadBanner({ recording: false, rows: [MPT] });
		await settle();
		check('recording switched off is answered once and left',
			env.retries.length === 0 && env.asked.length === 0);
	}

	group('the banner reaches the pages that were saying nothing');

	{
		const env = loadBanner({ card: { health: 'absent', mountpoint: '/mnt/mmcblk0p1' } });
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
		const env = loadBanner({ card: { health: 'ok', mountpoint: '/mnt/mmcblk0p1' } });
		await settle();
		env.beat({ records_state: 0 });
		check('a healthy camera is not nagged', env.banner() === '', env.banner());
	}

	group('and stays quiet where it would be noise or a lie');

	{
		// The camera is not recording to a card at all. A banner about storage
		// nobody asked to use is what teaches people to ignore banners.
		const env = loadBanner({ recording: false, card: { health: 'absent', mountpoint: '/mnt/mmcblk0p1' } });
		await settle();
		env.beat({ records_state: 0 });
		check('records.enabled off means no banner and no polling',
			env.banner() === '' && env.asked.length === 0,
			env.banner() + ' / ' + env.asked.length + ' requests');
	}

	['page-recordings', 'page-sdcard'].forEach(function (page) {
		const env = loadBanner({ page, card: { health: 'absent', mountpoint: '/mnt/mmcblk0p1' } });
		check(page + ' is left to say it itself',
			env.banner() === '' && env.asked.length === 0);
	});

	{
		// The whole of the false positive, end to end: no card in the slot, and
		// a camera that was never recording to the slot.
		const env = loadBanner({
			path: '/mnt/usb',
			card: { health: 'absent', mountpoint: '/mnt/mmcblk0p1' },
		});
		await settle();
		env.beat({ records_state: 0 });
		check('a camera recording to a USB stick is not told its slot is empty',
			env.banner() === '', env.banner().slice(0, 90));
	}

	{
		// A heartbeat that failed is not a recorder reporting health. The card
		// half still carries the verdict.
		const env = loadBanner({ card: { health: 'absent', mountpoint: '/mnt/mmcblk0p1' } });
		await settle();
		env.beat(null);
		check('a failed heartbeat does not silence the card half',
			/no SD card/.test(env.banner()), env.banner().slice(0, 90));
	}

	{
		// An older majestic with no records_state at all: the card half is
		// still the whole answer, and it must not be lost.
		const env = loadBanner({ card: { health: 'readonly', mountpoint: '/mnt/mmcblk0p1' } });
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
		const v = V.of({ health: h, mountpoint: MP }, rec(0), '', ON);
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
		const v = V.of({ health: 'ok', mountpoint: MP }, rec(0), '', ON);
		check('a healthy card and a happy recorder say nothing', v === null,
			JSON.stringify(v));
	}

	group('the trap: a missing card leaves the recorder reporting "ok"');

	{
		// Measured on the lab camera with the card removed: health "absent",
		// records_state 0, because the recorder never started. A check that
		// trusted the recorder alone would call this healthy.
		const v = V.of({ health: 'absent', mountpoint: MP }, rec(0), '', ON);
		check('records_state 0 does not overrule an absent card',
			!!v && v.kind === 'absent', v && v.kind);
		check('and it is stated as danger, not a hint',
			!!v && v.level === 'danger', v && v.level);
	}

	{
		// The other half of the same trap, and the one that was drawing green
		// on the Dashboard: df reports a read-only card's old free space.
		const v = V.of({ health: 'readonly', mountpoint: MP }, rec(0), '', ON);
		check('a read-only card is danger even with the recorder at 0',
			!!v && v.level === 'danger' && v.kind === 'readonly', v && v.kind);
	}

	group('the recorder is asked first, because it is the more specific answer');

	{
		// A card that went read-only under the recorder shows up in both, and
		// "the camera cannot write to the card" is what somebody looking at an
		// empty archive needs to read.
		const v = V.of({ health: 'readonly', mountpoint: MP }, rec(2), '', ON);
		check('a failing recorder outranks the filesystem verdict',
			!!v && v.kind === 'failing', v && v.kind);
	}

	[[3, 'offline'], [2, 'failing'], [1, 'degraded']].forEach(function (p) {
		const v = V.of({ health: 'ok', mountpoint: MP }, rec(p[0]), '', ON);
		check('records_state ' + p[0] + ' is reported on a healthy filesystem',
			!!v && v.kind === p[1], v && v.kind);
	});

	{
		const v = V.of({ health: 'ok', mountpoint: MP }, rec(0), '4 min', ON);
		check('footage dropped by a card that cannot keep up is reported',
			!!v && v.kind === 'dropping', v && v.kind);
		check('and the page-measured amount reaches the long form only',
			!!v && v.detail.indexOf('4 min') >= 0 && v.short.indexOf('4 min') < 0,
			v && v.short);
	}

	group('an unknown card is never painted green');

	check('a card the endpoint could not answer for is not writable',
		V.writable(null, rec(0), ON) === false);
	check('a healthy card whose recorder could not be asked is not writable',
		V.writable({ health: 'ok', mountpoint: MP }, UNASKED, ON) === false);
	check('a healthy card on a majestic too old to be asked still is',
		V.writable({ health: 'ok', mountpoint: MP }, OLD, ON) === true);
	check('a healthy card with a happy recorder is',
		V.writable({ health: 'ok', mountpoint: MP }, rec(0), ON) === true);
	TROUBLE.forEach(function (h) {
		check(h + ' is not writable', V.writable({ health: h, mountpoint: MP }, rec(0), ON) === false);
	});


	group('a camera recording somewhere else is not told about the slot');

	{
		// j/sdcard.cgi describes the built-in slot and nothing else, and never
		// reads records.path. Measured on a lab camera pointed at /tmp: with no
		// card in the slot it was told, on every page, "There is no SD card in
		// the camera — nothing is being recorded." The first clause was true and
		// beside the point; the second was simply false.
		const usb = { health: 'absent', mountpoint: MP };
		check('an absent slot says nothing about a USB recording',
			V.of(usb, rec(0), '', '/mnt/usb') === null);
		check('nor about a network mount',
			V.of(usb, rec(0), '', '/mnt/nfs/cam1') === null);
		// A prefix match is not a path match: /mnt/mmcblk0p1x is a different
		// directory, and so is /mnt/mmc.
		check('and the match is on the directory, not on the letters',
			V.of(usb, rec(0), '', MP + 'x') === null);
		check('while the card itself, and anything under it, still counts',
			V.of(usb, rec(0), '', MP) !== null &&
			V.of(usb, rec(0), '', MP + '/clips') !== null);
	}

	{
		// The recorder half still speaks, because majestic is reporting on
		// whatever it was actually pointed at -- but it must not call it a card.
		const v = V.of({ health: 'absent', mountpoint: MP }, rec(2), '', '/mnt/usb');
		check('a failing recorder is reported wherever it is writing',
			!!v && v.kind === 'failing', v && v.kind);
		check('and is not described as an SD card',
			!!v && v.short.indexOf('SD card') < 0, v && v.short);
		check('a card-side failure IS, when that is where the footage goes',
			(V.of({ health: 'absent', mountpoint: MP }, rec(2), '', MP) || {})
				.short.indexOf('SD card') >= 0);
	}

	{
		// The dot on the clip list: a slot the camera is not using cannot make
		// its recording unwritable.
		check('a healthy recorder writing elsewhere is writable',
			V.writable({ health: 'absent', mountpoint: MP }, rec(0), '/mnt/usb') === true);
		check('and the same camera pointed at the dead slot is not',
			V.writable({ health: 'absent', mountpoint: MP }, rec(0), MP) === false);
	}

	{
		// records.path is a strftime template; the directory is what comes
		// before the first field.
		check('the prefix is the path up to its first strftime field',
			V.prefixOf('/mnt/mmcblk0p1/%F') === MP, V.prefixOf('/mnt/mmcblk0p1/%F'));
		check('and a trailing slash is not part of it',
			V.prefixOf('/mnt/usb///') === '/mnt/usb', V.prefixOf('/mnt/usb///'));
		check('an unset path leaves the slot as the assumption',
			V.onCard({ mountpoint: MP }, '') === true);
	}

	group('the banner and the Recordings page share one vocabulary');

	{
		// Not a spot check: every state this module can reach has to carry
		// both forms, because the drift being guarded against is one of them
		// being added later without the other.
		const all = TROUBLE.map(function (h) { return V.of({ health: h, mountpoint: MP }, rec(0), '', ON); })
			.concat([1, 2, 3].map(function (n) { return V.of({ health: 'ok', mountpoint: MP }, rec(n), '', ON); }))
			.concat([V.of({ health: 'ok', mountpoint: MP }, rec(0), '10 s', ON)]);
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
