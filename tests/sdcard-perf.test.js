// What the SD-card page says about whether the card is fast enough.
//
// This is the one storage fault with no other symptom. Every check the page
// already made asks whether the card is THERE — mounted, readable, writable,
// with room on it — and a card that answers yes to all four can still be
// discarding clips because it cannot take the video in time. The page was
// green for exactly that camera.
//
// Two halves say so now, and both fail silently if they are wrong. The card's
// own ratings are decoded from a hardware register, so a mis-decode prints a
// confident wrong rating and nothing anywhere disagrees with it. The live
// figures come from counters that may be absent, may be zero, and may be
// unknown — three states that look identical once they reach markup, and the
// one that must never be invented is the third.
//
// Reproducing any of this on demand needs four cameras: one with an A2 card,
// one with a card that reports no ratings, one running a majestic too old to
// publish the counters, and one with a card slow enough to drop footage.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const A = (f) => path.join(__dirname, '..', 'www', 'a', f);

function makeEl(id) {
	const el = {
		id: id, innerHTML: '', textContent: '', className: '', hidden: false,
		dataset: {}, style: {}, handlers: { click: [], change: [] },
		classList: { add() {}, remove() {}, contains: () => false },
		addEventListener(ev, fn) { (this.handlers[ev] || (this.handlers[ev] = [])).push(fn); },
		removeAttribute() {}, setAttribute() {},
		querySelector: () => null, querySelectorAll: () => [],
		closest: () => null, appendChild() {},
	};
	return el;
}

// Press a delegated control the way a browser would, so the page's own handler
// runs. Planting the result instead is not possible and would not be worth much
// if it were: the state this asserts on lives inside the module closure, and
// reaching past the handler would be testing a fixture rather than the code.
function press(el, sel) {
	const ev = { target: { closest: (s) => (s === sel ? { dataset: {}, disabled: false } : null) } };
	(el.handlers.click || []).forEach((fn) => fn(ev));
}

// The same, for a data-act control: the delegated handler reads dataset.act,
// so an event whose closest() answers with an empty dataset presses nothing.
function pressAct(el, act) {
	const ev = { target: { closest: (s) => (s === '[data-act]' ? { dataset: { act: act }, disabled: false } : null) } };
	(el.handlers.click || []).forEach((fn) => fn(ev));
}

function card(over) {
	return Object.assign({
		present: true, mounted: true, health: 'ok', mountpoint: '/mnt/sd',
		device: '/dev/mmcblk0', target: '/dev/mmcblk0p1', partitioned: true,
		model: 'SD16G', cardtype: 'SD', manfid: '0x0000f1', oemid: '0x3432',
		date: '06/2020', serial: '0x1', sizeBytes: 31331450880, fs: 'vfat',
		totalKb: 30582176, usedKb: 5000000, availKb: 25582176, recBytes: 0,
		canFsck: false, fsErrors: [], mkfs: ['vfat'],
	}, over || {});
}

// A heartbeat sample, in the shape main.js publishes: the current metric map
// in `m.v`, the previous poll's in `prev.v`, and the seconds between them.
// Consumers derive their own counter deltas against that snapshot, which is
// what the write rate here is.
function beat(over, prevBytes, dt) {
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
		ok: true, m: { v: v }, dt: dt === undefined ? 2 : dt,
		prev: prevBytes === undefined ? null
			: { v: { records_bytes_written_total: prevBytes } },
	};
}

// Load the page against one card and one heartbeat, and give back the markup
// it drew. `sample` of null is a heartbeat that never landed — which is not
// the same as one that landed empty, and is the distinction most of these
// cases turn on.
function load(cardJson, sample, speedAnswer) {
	const SD = makeEl('sd');
	let subscriber = null;
	const env = { SD: SD };

	function json(o) { return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(o) }); }
	function apiFetch(url) {
		if (url.indexOf('/api/v1/config.json') === 0) {
			return json({ records: { enabled: true, path: '/mnt/sd/%F', split: 20, maxUsage: 95 } });
		}
		if (url.indexOf('/cgi-bin/j/sdcard.cgi') === 0) {
			// The POST is the measurement; the GET is the card.
			const post = arguments[1] && arguments[1].method === 'POST';
			return json(post ? { ok: true, speed: speedAnswer } : cardJson);
		}
		return Promise.reject(new Error('unstubbed ' + url));
	}

	// One element per selector, not one element for the whole page. The swap
	// dialog assigns handlers to several of its controls in turn, so a harness
	// that answers every lookup with the same object silently lets the last
	// assignment overwrite all the others -- and then agrees with whatever the
	// code does.
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
		// The real notice builder, so this file asserts against the markup the
		// page actually emits rather than against a stub of its own.
		mjNotice: (lvl, msg) => '<div class="notice-' + lvl + '">' + msg + '</div>',
		mjGet: (cfg, dot) => dot.split('.').reduce((o, k) => (o == null ? undefined : o[k]), cfg),
		console: console, JSON: JSON, Promise: Promise, Date: Date, Math: Math,
		String: String, Number: Number, Array: Array, Object: Object, Error: Error,
		isNaN: isNaN, parseInt: parseInt, parseFloat: parseFloat,
		encodeURIComponent: encodeURIComponent,
		alert() {}, confirm: () => true,
		// The page opens its dialogs through the bootstrap shim in main.js,
		// which is not loaded here.
		bootstrap: { Modal: { getOrCreateInstance: () => ({ show() {}, hide() {} }) } },
		setTimeout, clearTimeout, clearInterval, setInterval: () => 0,
		URLSearchParams: URLSearchParams,
	};
	ctx.window.document = ctx.document;
	ctx.window.mjMetricsSubscribe = (fn) => { subscriber = fn; };
	vm.createContext(ctx);
	// storage-verdict.js first, as p/header.cgi loads it: sdcard.js reaches it
	// through window for the one vocabulary both pages share.
	for (const f of ['storage-verdict.js', 'sdcard.js']) {
		vm.runInContext(fs.readFileSync(A(f), 'utf8'), ctx);
	}
	if (sample && subscriber) subscriber(sample);
	env.press = (sel) => press(SD, sel);
	env.pressAct = (act) => pressAct(SD, act);
	env.ctx = ctx;
	env.el = pick;
	// Stand in for the engine and keep the swap running, so the page's own
	// cancellation can be exercised against a live one.
	env.armSwap = () => {
		let io = null;
		ctx.window.MajesticSdSwap = { run: (given) => { io = given; return new Promise(() => {}); } };
		return { io: () => io };
	};
	env.html = () => SD.innerHTML;
	return env;
}

const PATIENCE = 5000;
async function drawn(env) {
	const end = Date.now() + PATIENCE;
	while (Date.now() < end) {
		if (env.html().indexOf('Performance') >= 0) return env.html();
		await new Promise((r) => setTimeout(r, 5));
	}
	return env.html();
}

// Press Measure and wait for the run to finish, however it finished — used
// where the answer deliberately carries no figures to wait for.
async function pressed(env) {
	env.press('#sd-speed');
	const end = Date.now() + PATIENCE;
	while (Date.now() < end) {
		const h = env.html();
		if (h.indexOf('Measuring…') < 0 && h.indexOf('Measure this card') >= 0) return h;
		await new Promise((r) => setTimeout(r, 5));
	}
	return env.html();
}

// Press Measure and wait for the figures to reach the page.
async function measured(env) {
	env.press('#sd-speed');
	const end = Date.now() + PATIENCE;
	while (Date.now() < end) {
		if (env.html().indexOf('Sequential write') >= 0) return env.html();
		await new Promise((r) => setTimeout(r, 5));
	}
	return env.html();
}

async function main() {
	group('what the card says it is');

	{
		const h = await drawn(load(card({
			rating: { speedClass: 10, uhsGrade: 1, videoClass: 10, appClass: 0 },
		}), beat()));
		check('the sequential classes are printed as the card reports them',
			h.indexOf('Class 10') >= 0 && h.indexOf('U1') >= 0 && h.indexOf('V10') >= 0, h.slice(0, 200));
		check('a card with no app-performance rating says so in those words',
			h.indexOf('no A1/A2 rating') >= 0, 'missing');
		// The whole point of the row. A card can carry every sequential mark
		// there is and still be the reason footage is being lost, and the
		// owner cannot act on that unless the page says which kind of rating
		// it is short of.
		check('and is marked as rated for sequential work only',
			h.indexOf('sequential only') >= 0, 'missing');
		check('with the reason spelled out rather than left implied',
			h.indexOf('A1 and A2 are the only ones') >= 0, 'missing');
	}

	{
		const h = await drawn(load(card({
			rating: { speedClass: 10, uhsGrade: 3, videoClass: 30, appClass: 2 },
		}), beat()));
		check('an A2 card is printed as A2', h.indexOf('A2') >= 0, h.slice(0, 200));
		check('and is not lectured about random I/O it is rated for',
			h.indexOf('sequential only') < 0 && h.indexOf('A1 and A2 are the only ones') < 0, 'lectured');
	}

	{
		// The attribute does not exist on this platform. The card is very
		// likely rated perfectly well and another camera would read it, so the
		// sentence must not be about the card — this is the case that made the
		// distinction necessary: measured on an Ingenic T31 (3.10 kernel) whose
		// slot held a 2021 SanDisk 64 GB, against a HiSilicon 4.9 that reads
		// the same register without trouble.
		const h = await drawn(load(card({ ratingWhy: 'platform' }), beat()));
		check('a platform that cannot read the register says so about itself',
			h.indexOf('this camera cannot read card speed ratings') >= 0, h.slice(0, 300));
		check('and does not blame the card for it',
			h.indexOf('this card’s speed ratings could not be read') < 0 &&
			h.indexOf('does not report its speed ratings') < 0, 'blamed the card');
		check('nor is the card marked as lacking an app rating it never claimed',
			h.indexOf('sequential only') < 0, 'convicted on no evidence');
	}

	{
		const h = await drawn(load(card({ ratingWhy: 'unreadable' }), beat()));
		check('a register that is there and will not decode blames neither',
			h.indexOf('speed ratings could not be read') >= 0, h.slice(0, 300));
		check('and still prints no rating of its own',
			h.indexOf('Class ') < 0, 'invented a rating');
	}

	{
		// An SD structure asked of something that is not an SD card. There is
		// no answer worth printing, so the row is not drawn at all.
		const h = await drawn(load(card({ ratingWhy: 'notsd' }), beat()));
		check('a slot holding no SD card is given no ratings row',
			h.indexOf('Rated') < 0, h.slice(0, 300));
		check('while the rest of the panel still draws',
			h.indexOf('Performance') >= 0, 'lost the panel');
	}

	group('what the card is actually doing');

	{
		// 2 MB in 2 s is 8 Mbit/s, derived against the heartbeat's own previous
		// snapshot rather than by bookkeeping of the page's own.
		const h = await drawn(load(card(), beat({
			records_bytes_written_total: 4194304,
		}, 2097152, 2)));
		check('the achieved write rate is derived from two samples',
			h.indexOf('8.4 Mbit/s') >= 0, h.slice(h.indexOf('Writing now'), h.indexOf('Writing now') + 120));
	}

	{
		const h = await drawn(load(card(), beat({
			records_fsync_us_max: 2032079,
			records_fragments_dropped_total: 12,
			records_dropped_ticks_total: 1950001,
		})));
		check('the longest flush is reported to the hundredth',
			h.indexOf('2.03 s') >= 0, h.slice(0, 400));
		check('dropped fragments are counted', h.indexOf('12 fragments') >= 0, 'missing');
		// 1.95 s over twelve fragments, which rounds to "2 s" of footage --
		// but a window that sits under a second must not round to "0 s" and
		// report a loss in the same breath as denying it.
		check('and the footage they carried is put in words', h.indexOf('2 s of video') >= 0, 'missing');
	}

	{
		const h = await drawn(load(card(), beat({
			records_fragments_dropped_total: 1,
			records_dropped_ticks_total: 160000,
		})));
		check('a sub-second loss is never rounded away to zero',
			h.indexOf('under a second') >= 0 && h.indexOf('0 s of video') < 0, h.slice(0, 400));
		check('and one fragment is not called fragments', h.indexOf('1 fragment ') >= 0 ||
			h.indexOf('1 fragment(') >= 0, 'plural');
	}

	group('three ways to have no figures, and they are three sentences');

	{
		// The heartbeat never landed. Nothing is established, so nothing is
		// claimed -- not "no drops", and not "nothing recorded yet" either.
		const h = await drawn(load(card({
			rating: { speedClass: 10, uhsGrade: 0, videoClass: 0, appClass: 1 },
		}), null));
		check('an unknown recorder produces no figures at all',
			h.indexOf('Longest pause') < 0 && h.indexOf('Footage dropped') < 0, h.slice(0, 300));
		check('and is not reported as a camera that has recorded nothing',
			h.indexOf('Nothing has been recorded') < 0, 'invented a fact');
		// The distinction the whole three-state shape exists for: a poll that
		// has not landed is not a majestic that HAS answered and has no such
		// counters. Collapsing the two prints a settled fact about the build
		// from the fact that nothing has been heard yet.
		check('nor as a build that answered and has no counters',
			h.indexOf('does not report what its recorder is doing') < 0, 'unknown sold as known');
		check('while the ratings, which came from elsewhere, still show',
			h.indexOf('A1') >= 0, 'lost the rating too');
	}

	{
		// majestic answered and has no such counters. That is a fact about the
		// build, not about the card, and the measurement still works.
		const h = await drawn(load(card(), { ok: true, m: { v: {} }, dt: 2, prev: null }));
		check('a majestic with no recording counters says so',
			h.indexOf('does not report what its recorder is doing') >= 0, h.slice(0, 400));
		check('and still offers the measurement', h.indexOf('Measure this card') >= 0, 'no way forward');
	}

	{
		// The counters exist and are empty because nothing has ever been asked
		// of this card. A row of reassuring noughts would answer "has this card
		// kept up?" for a camera that never made it try.
		const h = await drawn(load(card(), beat({ records_fragments_written_total: 0 })));
		check('a camera that has recorded nothing shows no zeroes',
			h.indexOf('Longest pause') < 0 && h.indexOf('Footage dropped') < 0, h.slice(0, 400));
		check('and is told why there is nothing to show',
			h.indexOf('Nothing has been recorded to this card') >= 0, 'silent');
	}

	group('a measurement under the card’s own rating blames nobody');

	{
		// Measured on a hi3518ev200: a Class 10 card at 4.7 MB/s, where a raw
		// read off the block device managed the same 4.7 against a CPU good for
		// 40 — the host was the ceiling, not the card. The page must not turn
		// that into an accusation, or somebody replaces a good card and
		// measures the same number again.
		const env = load(
			card({ rating: { speedClass: 10, uhsGrade: 0, videoClass: 0, appClass: 0 } }),
			beat(), { bytes: 33554432, writeMs: 6820, worstMs: 450, readMs: 3720, recording: false });
		await drawn(env);
		const h = await measured(env);
		check('a figure under the rating is pointed out',
			h.indexOf('below the 10 MB/s') >= 0, h.slice(-700));
		check('and the camera is named as a possible cause',
			h.indexOf('the slot itself is the slower half') >= 0, 'missing');
		check('without convicting the card',
			h.indexOf('does not on its own mean the card is at fault') >= 0, 'convicted the card');
	}

	{
		// Comfortably at its rating: nothing to say.
		const env = load(
			card({ rating: { speedClass: 10, uhsGrade: 1, videoClass: 10, appClass: 2 } }),
			beat(), { bytes: 33554432, writeMs: 2000, worstMs: 100, readMs: 900, recording: false });
		await drawn(env);
		const h = await measured(env);
		check('a card meeting its rating is not editorialised about',
			h.indexOf('below the') < 0, h.slice(-400));
	}

	{
		// No rating to fall short of.
		const env = load(card({ ratingWhy: 'platform' }), beat(),
			{ bytes: 33554432, writeMs: 9000, worstMs: 800, readMs: 4000, recording: false });
		await drawn(env);
		const h = await measured(env);
		check('a card with no known rating is measured against nothing',
			h.indexOf('below the') < 0, h.slice(-400));
	}

	group('a duration that was never read is not a speed');

	{
		// The endpoint refuses to time a write it could not time, but the page
		// may not assume that: a zero here divided into the byte count puts
		// "Infinity MB/s" on screen as a measurement, which is the shape of
		// every bug this file exists to catch.
		const env = load(card(), beat(),
			{ bytes: 33554432, writeMs: 0, worstMs: 450, readMs: 3720 });
		await drawn(env);
		const h = await pressed(env);
		check('a zero write duration yields no write figure at all',
			h.indexOf('Sequential write') < 0, h.slice(-500));
		check('and certainly not an infinite one',
			h.indexOf('Infinity') < 0 && h.indexOf('NaN') < 0, 'published a non-number');
		check('while a reading that IS good still shows',
			h.indexOf('Read back') >= 0, 'lost the read figure too');
	}

	{
		// -1 is how the endpoint says the read-back did not finish. A read that
		// failed half way, divided into the full byte count, would be published
		// as a throughput nothing achieved.
		const env = load(card(), beat(),
			{ bytes: 33554432, writeMs: 4000, worstMs: 300, readMs: -1 });
		await drawn(env);
		const h = await measured(env);
		check('a read that did not finish yields no read figure',
			h.indexOf('Read back') < 0, h.slice(-500));
		check('and does not suppress the write figure beside it',
			h.indexOf('Sequential write') >= 0, 'lost the write figure');
	}

	group('the recorder competing for the card is the page’s own answer');

	{
		// Derived in the browser from the config it already holds and the
		// heartbeat it already receives — the endpoint is not asked and does
		// not answer. Writing at ~8 Mbit/s to the mount the clips are
		// configured for.
		const env = load(card(), beat({ records_bytes_written_total: 4194304 }, 2097152, 2),
			{ bytes: 33554432, writeMs: 4000, worstMs: 300, readMs: 900 });
		await drawn(env);
		const h = await measured(env);
		check('a measurement taken beside a live recorder says so',
			h.indexOf('both were writing at once') >= 0, h.slice(-500));
	}

	{
		// Same card, same configuration, but nothing is being written.
		const env = load(card(), beat({ records_bytes_written_total: 4194304 }, 4194304, 2),
			{ bytes: 33554432, writeMs: 4000, worstMs: 300, readMs: 900 });
		await drawn(env);
		const h = await measured(env);
		check('an idle recorder does not get the caption',
			h.indexOf('both were writing at once') < 0, h.slice(-500));
	}

	group('the measurement itself');

	{
		const h = await drawn(load(card({ mounted: false, health: 'unmounted' }), beat()));
		check('an unmounted card cannot be measured',
			h.indexOf('id="sd-speed" disabled') >= 0 || h.indexOf('disabled>') >= 0, h.slice(-400));
	}

	{
		const h = await drawn(load(card({ health: 'readonly' }), beat()));
		check('nor can a read-only one',
			h.indexOf('disabled') >= 0, h.slice(-400));
	}

	group('a control this camera cannot honour is not offered as if it could');

	{
		// Everything the swap does is downstream of pausing the recorder, so
		// on a majestic too old to have the endpoint the wizard fails on its
		// first operation -- and tells the operator their camera is broken. It
		// is not broken, it is older, and the button should say so before it
		// is pressed rather than after.
		//
		// The capability is read from the gauge the same change added, not
		// guessed from a version string.
		const h = await drawn(load(card(), beat()));
		check('a camera that can pause its recorder offers the swap',
			h.indexOf('data-act="swap"') >= 0 && h.indexOf('data-act="swap" disabled') < 0,
			h.slice(-600));
	}

	{
		const old = beat();
		delete old.m.v.records_stood_down;
		const h = await drawn(load(card(), old));
		check('a camera that cannot is offered a disabled one',
			h.indexOf('data-act="swap" disabled') >= 0, h.slice(-600));
		check('and told why', h.indexOf('cannot pause') >= 0, h.slice(-600));
	}

	{
		// Before the first heartbeat nothing is known, and a disabled button
		// drawn then is a verdict on evidence that has not arrived. It appears
		// a moment later instead.
		const h = await drawn(load(card(), null));
		check('a camera that has not said yet is offered neither',
			h.indexOf('data-act="swap"') < 0, h.slice(-600));
	}

	group('closing the dialog stops the swap it was showing');

	{
		// Escape, the backdrop and the close button all fire the dialog's
		// `close` -- and none of them touch the footer Stop button. A swap
		// cancelled only from that button goes on polling for minutes behind
		// a dialog that is no longer on screen, with its status and its Stop
		// control gone, while the page is willing to start a second one.
		//
		// This drives the real handler and asks the engine's own `io`, not a
		// flag reached past it: the state lives in the module closure and a
		// fixture that reported it would be testing itself.
		const env = load(card(), beat());
		await drawn(env);
		const armed = env.armSwap();
		env.pressAct('swap');
		env.el('#sd-swap-go').onclick();
		const io = armed.io();
		check('the swap actually started', !!io, String(!!io));
		check('and is not stopped to begin with', io.stopped() === false, String(io.stopped()));

		const closers = env.el('#sd-swap').handlers.close || [];
		check('the dialog has a close handler at all', closers.length > 0, String(closers.length));
		closers.forEach((fn) => fn());
		check('closing the dialog cancels the running swap',
			io.stopped() === true, String(io.stopped()));
	}

	done();
}

main();
