// The SD-card page redraws only as much as it has to.
//
// This page polls the camera every five seconds and the heartbeat every two,
// and for most of a camera's life the page it draws is identical to the one
// already on screen. It used to write that page into the DOM anyway. Nothing
// about that is visible in a screenshot: the markup is right, the numbers are
// right, and the only thing wrong is that the focus ring left the button you
// were about to press, the mountpoint you were half way through selecting went
// away, and the tooltip you were reading closed -- every five seconds, for
// ever. It is invisible in exactly the way a test is for.
//
// It cannot be reproduced on demand either. Everything here needs a camera
// answering two different endpoints on two different clocks, and the fault only
// shows if you happen to be touching the page at the moment a poll lands.
//
// So what is pinned is the rule: a poll that changed nothing writes nothing, a
// poll that changed a counter writes only that counter's block, and a poll that
// changed the page's shape rebuilds it. The third is not an optimisation to be
// clever about -- a rebuild when something really did change is correct, and a
// page that refuses to rebuild when a card is pulled is worse than one that
// rebuilds too often.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const A = (f) => path.join(__dirname, '..', 'www', 'a', f);

// The page's own container, with the two things this file is about made
// observable: how many times the whole page was written, and what was written
// into each live block instead.
function makeSd() {
	let html = '';
	const painted = {};
	const el = {
		writes: 0,
		painted: painted,
		get innerHTML() { return html; },
		set innerHTML(v) { html = v; el.writes++; },
		handlers: { click: [], change: [] },
		addEventListener(ev, fn) { (this.handlers[ev] || (this.handlers[ev] = [])).push(fn); },
		// Only the page's own live blocks are looked up this way, so the
		// selector is the key: what paint() writes lands where the assertions
		// can read it without this file having to parse markup.
		querySelector(sel) {
			const m = /^\[data-mj="([a-z]+)"\]$/.exec(sel);
			if (!m) return null;
			const k = m[1];
			return { set innerHTML(v) { painted[k] = v; }, get innerHTML() { return painted[k] || ''; } };
		},
		querySelectorAll: () => [],
	};
	return el;
}

function makeEl(id) {
	return {
		id: id, innerHTML: '', textContent: '', className: '', hidden: false,
		dataset: {}, style: {}, handlers: {},
		classList: { add() {}, remove() {}, contains: () => false },
		addEventListener(ev, fn) { (this.handlers[ev] || (this.handlers[ev] = [])).push(fn); },
		removeAttribute() {}, setAttribute() {},
		querySelector: () => null, querySelectorAll: () => [],
		closest: () => null, appendChild() {},
	};
}

function card(over) {
	return Object.assign({
		present: true, mounted: true, health: 'ok', mountpoint: '/mnt/sd',
		device: '/dev/mmcblk0', target: '/dev/mmcblk0p1', partitioned: true,
		model: 'SD16G', cardtype: 'SD', date: '06/2020', serial: '0x1',
		sizeBytes: 31331450880, fs: 'vfat',
		totalKb: 30582176, usedKb: 5000000, availKb: 25582176, recBytes: 0,
		canFsck: false, fsErrors: [], mkfs: ['vfat'],
		rating: { speedClass: 10, uhsGrade: 1, videoClass: 10, appClass: 0 },
	}, over || {});
}

function beat(over, prevBytes) {
	const v = Object.assign({
		records_state: 0,
		records_stood_down: 0,
		records_fragments_written_total: 1000,
		records_bytes_written_total: 0,
		records_fsync_us_max: 0,
		records_fragments_dropped_total: 0,
		records_dropped_ticks_total: 0,
		records_write_errors_total: 0,
		records_sync_errors_total: 0,
		records_queue_fragments: 0,
	}, over || {});
	return {
		ok: true, m: { v: v }, dt: 2,
		prev: prevBytes === undefined ? null
			: { v: { records_bytes_written_total: prevBytes } },
	};
}

// Load the page against one card, and hand back the levers: the container, and
// the heartbeat the page subscribed to. Every later draw in these cases is
// driven through that heartbeat, because that is the two-second clock the
// regression was measured on.
function load(cardJson, opts) {
	const o = opts || {};
	const SD = makeSd();
	let subscriber = null;

	function json(o) { return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(o) }); }
	function apiFetch(url) {
		if (url.indexOf('/api/v1/config.json') === 0) {
			return json({ records: { enabled: true, path: '/mnt/sd/%F', split: 20, maxUsage: 95 } });
		}
		if (url.indexOf('/cgi-bin/j/sdcard.cgi') === 0) {
			return cardJson.now ? json(cardJson.now) : Promise.reject(new Error('camera unreachable'));
		}
		return Promise.reject(new Error('unstubbed ' + url));
	}
	// The page's own five-second poll, held rather than fired, so a case can
	// say when the next one lands.
	let poll = null;

	const els = { '#sd': SD };
	const pick = (sel) => els[sel] || (els[sel] = makeEl(sel));
	const win = { console: console };
	const ctx = {
		window: win,
		document: {
			getElementById: (id) => pick('#' + id), querySelector: pick,
			querySelectorAll: () => [], createElement: () => makeEl('made'),
			addEventListener() {}, body: makeEl('body'), hidden: false,
		},
		$: pick,
		apiFetch: apiFetch,
		mjNotice: (lvl, msg) => '<div class="notice-' + lvl + '">' + msg + '</div>',
		mjGet: (cfg, dot) => dot.split('.').reduce((o, k) => (o == null ? undefined : o[k]), cfg),
		console: console, JSON: JSON, Promise: Promise, Date: Date, Math: Math,
		String: String, Number: Number, Array: Array, Object: Object, Error: Error,
		isNaN: isNaN, parseInt: parseInt, parseFloat: parseFloat,
		encodeURIComponent: encodeURIComponent,
		alert() {}, confirm: () => true,
		bootstrap: { Modal: { getOrCreateInstance: () => ({ show() {}, hide() {} }) } },
		setTimeout, clearTimeout, clearInterval,
		setInterval: (fn) => { poll = fn; return 1; },
		URLSearchParams: URLSearchParams,
	};
	ctx.window.document = ctx.document;
	ctx.window.mjMetricsSubscribe = (fn) => { subscriber = fn; };
	vm.createContext(ctx);
	// Which modules the page finds. A build without sdcard-health.js is a real
	// camera -- the page must still say what the card IS on one.
	const mods = o.noHealth
		? ['storage-verdict.js', 'sdcard.js']
		: ['storage-verdict.js', 'sdcard-health.js', 'sdcard.js'];
	for (const f of mods) {
		vm.runInContext(fs.readFileSync(A(f), 'utf8'), ctx);
	}
	// Press a delegated control the way a browser would, so the page's own
	// handler runs against its own markup.
	function press(attr, val) {
		const ev = {
			target: {
				closest: (sel) => (sel === '[' + attr + ']'
					? { dataset: {}, disabled: false, getAttribute: () => val } : null),
			},
		};
		(SD.handlers.click || []).forEach((fn) => fn(ev));
	}
	return {
		SD: SD,
		beat: (s) => subscriber && subscriber(s),
		poll: () => poll && poll(),
		tab: (id) => press('data-tab', id),
	};
}

const PATIENCE = 5000;
async function settled(env, want) {
	const end = Date.now() + PATIENCE;
	while (Date.now() < end) {
		if (env.SD.innerHTML.indexOf(want) >= 0) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error('never saw ' + JSON.stringify(want));
}

async function drawn(env) {
	const end = Date.now() + PATIENCE;
	while (Date.now() < end) {
		if (env.SD.innerHTML.indexOf('Performance') >= 0) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error('page never drew');
}

(async () => {
	group('a poll that changed nothing leaves the page alone');

	{
		const env = load({ now: card() });
		await drawn(env);
		check('the page was drawn once to begin with', env.SD.writes === 1, String(env.SD.writes));
		// The FIRST heartbeat is a real change and must redraw: the page was
		// built before any reading had landed, and that reading adds the
		// recorder's figures to it. What the rule is about is every heartbeat
		// after that one.
		env.beat(beat());
		check('the first reading to land is drawn', env.SD.writes === 2, String(env.SD.writes));
		const settled = env.SD.writes;
		env.beat(beat());
		env.beat(beat());
		env.beat(beat());
		check('three identical heartbeats after it rewrite nothing',
			env.SD.writes === settled, 'rewrote ' + (env.SD.writes - settled) + ' times');
	}

	group('a counter that moved is written on its own');

	{
		const env = load({ now: card() });
		await drawn(env);
		// Prime the rate from a first pair, then move the byte counter on.
		env.beat(beat({ records_bytes_written_total: 1000000 }, 0));
		const before = env.SD.writes;
		env.beat(beat({ records_bytes_written_total: 3000000 }, 1000000));
		check('the write rate moving does not rebuild the page',
			env.SD.writes === before, 'rebuilt');
		check('it is painted into the counters block instead',
			(env.SD.painted.perfrows || '').indexOf('Mbit/s') >= 0
			|| (env.SD.painted.perfrows || '').indexOf('kbit/s') >= 0,
			JSON.stringify(env.SD.painted.perfrows || '').slice(0, 200));
		// The point of painting rather than rebuilding: the page around the
		// block is the page that was already there.
		check('and the surrounding page is not touched',
			env.SD.innerHTML.indexOf('Performance') >= 0, 'lost the page');
	}

	group('a page whose shape changed is rebuilt, because it really is different');

	{
		const env = load({ now: card() });
		await drawn(env);
		env.beat(beat());
		const before = env.SD.writes;
		// majestic answering with no recorder counters at all is a different
		// page: the figures go, and a sentence appears saying why.
		env.beat({ ok: true, m: { v: {} }, dt: 2, prev: null });
		check('a build that stops reporting its recorder rebuilds the page',
			env.SD.writes === before + 1, 'writes ' + before + ' -> ' + env.SD.writes);
		check('and the page now says so',
			env.SD.innerHTML.indexOf('does not report what its recorder is doing') >= 0,
			'silent about it');
	}

	group('the counters that are absent are still absent after a paint');

	{
		// The rule the whole three-state shape exists for, asserted on the
		// painted block rather than on a fresh draw: a camera that has recorded
		// nothing has measured nothing, and painting must not invent a row of
		// reassuring noughts.
		const env = load({ now: card() });
		await drawn(env);
		env.beat(beat({ records_fragments_written_total: 0 }));
		const h = env.SD.innerHTML + (env.SD.painted.perfrows || '');
		check('no pause is reported for a card nothing was ever written to',
			h.indexOf('Longest pause') < 0, h.slice(0, 200));
		check('and no dropped-footage count either',
			h.indexOf('Footage dropped') < 0, h.slice(0, 200));
	}

	group('a poll that failed does not leave the page stuck on the failure');

	{
		// The shape cache is what decides whether the page is rebuilt, so
		// anything that writes to the page WITHOUT going through it leaves that
		// cache describing something nobody can see. The failure notice used to
		// be written exactly that way: the next poll to succeed found the shape
		// unchanged, painted into the blocks the notice had replaced, found
		// none of them, and left the camera reading as unreachable for good.
		const fixture = { now: card() };
		const env = load(fixture);
		await drawn(env);
		env.beat(beat());

		fixture.now = null;                       // the camera stops answering
		env.poll();
		await settled(env, 'Failed to read SD-card status');
		check('a failed poll says so', true, '');
		// A heartbeat arriving while it is down must not paint stale figures
		// over the notice, nor rewrite it.
		const atErr = env.SD.writes;
		env.beat(beat());
		check('a heartbeat during the outage neither repaints nor rewrites it',
			env.SD.writes === atErr
			&& env.SD.innerHTML.indexOf('Failed to read SD-card status') >= 0,
			'writes ' + atErr + ' -> ' + env.SD.writes);

		fixture.now = card();                     // and comes back
		env.poll();
		await settled(env, 'Performance');
		check('the page comes back when the camera does',
			env.SD.innerHTML.indexOf('Failed to read SD-card status') < 0, 'still stuck');
	}

	group('the page says what the card is, with or without the health module');

	{
		const env = load({ now: card() }, { noHealth: true });
		await drawn(env);
		const h = env.SD.innerHTML;
		// The verdict and its three lines need the module. What the card IS
		// does not, and must not go with it -- a build that has not shipped
		// sdcard-health.js is not a camera whose card has no model number.
		check('the card is still named', h.indexOf('SD16G') >= 0, h.slice(0, 200));
		check('its mount is still shown', h.indexOf('/mnt/sd') >= 0, 'lost the mount');
		check('its ratings are still shown', h.indexOf('Class 10') >= 0, 'lost the rating');
		check('the storage bar is still drawn', h.indexOf('storage-bar') >= 0, 'lost the bar');
		check('and the actions are still reachable',
			h.indexOf('data-act="format"') >= 0, 'lost the actions');
		check('but no verdict is claimed on evidence it cannot read',
			h.indexOf('mj-evidence') < 0, 'invented a verdict');
	}

	group('a card nothing records to is not told when its clips will go');

	{
		// records.maxUsage is one global threshold and the recorder sweeps one
		// path. A second card, mounted and healthy and pointed at by nothing,
		// would otherwise be told its oldest clips go at 95% when nothing will
		// ever touch them.
		const here = load({ now: card({ mountpoint: '/mnt/sd' }) });
		await drawn(here);
		check('the card being recorded to shows the deletion line',
			here.SD.innerHTML.indexOf('oldest clips deleted at 95%') >= 0, 'missing');

		const spare = load({ now: card({ mountpoint: '/mnt/other' }) });
		await drawn(spare);
		check('a card the recorder is not pointed at does not',
			spare.SD.innerHTML.indexOf('oldest clips deleted at') < 0, 'promised a sweep');
		check('and its storage bar is still drawn',
			spare.SD.innerHTML.indexOf('storage-bar') >= 0, 'lost the bar');
	}

	group('a chart with no counter behind it is not drawn at all');

	{
		const env = load({ now: card() });
		await drawn(env);
		// A build that reports its recorder's state but not the byte total, nor
		// the queue gauge. A labelled panel that never draws a line is the same
		// mistake as printing a zero for a reading nobody took, in a bigger box.
		env.beat({
			ok: true, dt: 2, prev: null,
			m: { v: { records_state: 0, records_fragments_written_total: 1000 } },
		});
		const h = env.SD.innerHTML;
		check('no write-rate chart without the byte counter',
			h.indexOf('sd-ch-rate') < 0, 'drew an empty chart');
		check('no queue chart without the queue gauge',
			h.indexOf('sd-ch-queue') < 0, 'drew an empty chart');

		const full = load({ now: card() });
		await drawn(full);
		full.beat(beat());
		check('both are drawn where both counters are published',
			full.SD.innerHTML.indexOf('sd-ch-rate') >= 0
			&& full.SD.innerHTML.indexOf('sd-ch-queue') >= 0, 'lost the charts');
	}

	group('switching tabs costs nothing, because nothing is rebuilt');

	{
		const env = load({ now: card() });
		await drawn(env);
		env.beat(beat());
		const h = env.SD.innerHTML;
		// All three panels are in the page at once. That is what makes a
		// switch a `hidden` toggle rather than a redraw -- and it keeps every
		// word on the page findable with the browser's own find.
		check('every panel is in the markup',
			h.indexOf('data-panel="perf"') >= 0 && h.indexOf('data-panel="rec"') >= 0
			&& h.indexOf('data-panel="card"') >= 0, 'a panel is missing');
		const settled = env.SD.writes;
		env.tab('card');
		check('pressing a tab rewrites nothing', env.SD.writes === settled,
			'writes ' + settled + ' -> ' + env.SD.writes);
		// The real property: which tab is open is not part of the page's
		// shape, so the heartbeat two seconds later does not rebuild the page
		// and take the focus off the tab just pressed.
		env.beat(beat());
		env.beat(beat());
		check('and the heartbeat after it does not either', env.SD.writes === settled,
			'writes ' + settled + ' -> ' + env.SD.writes);
	}

	group('an alarm needs two samples that were actually consecutive');
	{
		// `s.prev` belongs to the heartbeat and SURVIVES a failed poll, so on
		// the first success after a gap it is the reading from BEFORE the gap.
		// A dropped count that moved somewhere in that unobserved interval
		// would otherwise be read as "clips are being lost right now" and raise
		// a fault on two samples that were never consecutive.
		const drop = (n, prevN) => ({
			ok: true, dt: 2,
			m: { v: Object.assign({}, beat().m.v, { records_fragments_dropped_total: n }) },
			prev: prevN === undefined ? null
				: { v: { records_fragments_dropped_total: prevN } },
		});
		const env = await load({ now: card() });
		await drawn(env);

		env.beat(drop(0, 0));
		env.beat({ ok: false });                 // the hole
		env.beat(drop(5, 0));                    // first success after it
		check('a jump across a failed poll is not an active loss',
			env.SD.innerHTML.indexOf('still being lost') < 0,
			'claimed an active loss on a delta that spans a gap');
		check('and the loss is still reported, as a standing total',
			env.SD.innerHTML.indexOf('but none while this page has been watching') >= 0,
			'the standing loss went unmentioned');

		// Two genuinely consecutive samples that move DO raise it.
		env.beat(drop(6, 5));
		check('two consecutive samples that move do raise it',
			env.SD.innerHTML.indexOf('still being lost') >= 0,
			'an active loss was not reported');
	}

	done();
})();
