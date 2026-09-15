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
		dataset: {}, style: {},
		classList: { add() {}, remove() {}, contains: () => false },
		addEventListener() {}, removeAttribute() {}, setAttribute() {},
		querySelector: () => null, querySelectorAll: () => [],
		closest: () => null, appendChild() {},
	};
	return el;
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
function load(cardJson, sample) {
	const SD = makeEl('sd');
	let subscriber = null;
	const env = { SD: SD };

	function json(o) { return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(o) }); }
	function apiFetch(url) {
		if (url.indexOf('/api/v1/config.json') === 0) {
			return json({ records: { enabled: true, path: '/mnt/sd/%F', split: 20, maxUsage: 95 } });
		}
		if (url.indexOf('/cgi-bin/j/sdcard.cgi') === 0) return json(cardJson);
		return Promise.reject(new Error('unstubbed ' + url));
	}

	const win = { console: console };
	const ctx = {
		window: win,
		document: {
			getElementById: () => SD, querySelector: () => SD,
			querySelectorAll: () => [], createElement: () => makeEl('made'),
			addEventListener() {}, body: makeEl('body'), hidden: false,
		},
		$: () => SD,
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
		setTimeout, clearTimeout, clearInterval, setInterval: () => 0,
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

	done();
}

main();
