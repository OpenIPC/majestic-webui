// What the Recordings page says about why there is no new footage.
//
// The page's own doctrine, written into cardWritable(): positive claims need
// positive evidence, and an unknown card must never be painted green. It was
// only ever asking the filesystem, though, and the filesystem cannot see the
// failure that matters most — a card mounted read-write with room on it, which
// majestic is writing nothing to. Every one of those states reads back as
// `health: "ok"` from the SD-card endpoint.
//
// So the page now asks majestic as well, through /metrics/records, and this
// pins what it does with the answer. The failure being guarded against is a
// green "Recording" badge over an archive that stopped growing an hour ago —
// silent by construction, and not reproducible without a failing SD card.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const A = (f) => path.join(__dirname, '..', 'www', 'a', f);

// ---- a recording, as majestic writes them ------------------------------
//
// Its own copy, for the reason recordings-pump.test.js gives for having one: a
// fixture shared between two tests is a fixture neither can change. Cut to the
// minimum this needs, which is a clip the page can index and then leave alone.

function box(type, payload) {
	const b = Buffer.alloc(8 + payload.length);
	b.writeUInt32BE(8 + payload.length, 0);
	b.write(type, 4, 'latin1');
	payload.copy(b, 8);
	return b;
}
function u32(...vals) {
	const b = Buffer.alloc(4 * vals.length);
	vals.forEach((v, i) => b.writeUInt32BE(v >>> 0, i * 4));
	return b;
}
function clip(seconds) {
	const p = Buffer.alloc(28);
	p.write('isom', 0, 'latin1');
	p.writeUInt32BE(0x200, 4);
	p.write('isomiso2avc1iso6', 8, 'latin1');
	const mdhd = box('mdhd', Buffer.concat([u32(0, 0, 0, 1000000, 0), u32(0)]));
	const parts = [box('ftyp', p), box('moov', box('trak', box('mdia', mdhd)))];
	for (let i = 0; i < seconds; i++) {
		const tfdt = Buffer.alloc(12);
		tfdt.writeUInt32BE(0x01000000, 0);
		tfdt.writeBigUInt64BE(BigInt(i * 1000000), 4);
		const per = Buffer.alloc(20 * 8);
		for (let k = 0; k < 20; k++) {
			per.writeUInt32BE(50000, k * 8);
			per.writeUInt32BE(1000, k * 8 + 4);
		}
		const traf = box('traf', Buffer.concat([
			box('tfhd', u32(0x020030, 1)),
			box('tfdt', tfdt),
			box('trun', Buffer.concat([u32(0x000305, 20, 0, 0x02000000), per])),
		]));
		parts.push(box('moof', Buffer.concat([box('mfhd', u32(0, i)), traf])));
		parts.push(box('mdat', Buffer.alloc(2000, 0x41)));
	}
	return Buffer.concat(parts);
}
const CLIP = clip(4);

// ---- the browser, in as much as this needs one -------------------------

function makeEl(id) {
	return {
		id: id, innerHTML: '', textContent: '', value: '', hidden: false,
		className: '', style: {}, dataset: {}, disabled: false,
		classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
		handlers: {},
		addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); },
		removeEventListener() {}, appendChild() {}, removeChild() {}, remove() {},
		setAttribute() {}, removeAttribute() {}, getAttribute() { return null; },
		querySelector() { return null; }, querySelectorAll() { return []; },
		closest() { return null; }, insertAdjacentHTML() {},
		getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 60 }; },
		load() {}, play() { return Promise.resolve(); },
	};
}

// `cardHealth` is what the SD-card endpoint reports; `metrics` is the body
// /metrics/records answers with, or null for a majestic too old to have it.
function load(cardHealth, metrics, mode) {
	const els = {};
	const $ = (id) => (els[id] = els[id] || makeEl(id));
	// The card poll is a 30-second setInterval. Captured rather than waited on,
	// so a test can say "and now another poll happens" without the suite taking
	// half a minute per case — and so the poll's own early-return, which is
	// what decides whether a changed verdict ever reaches the screen, is
	// exercised at all.
	const env = { $: $, asked: [], polls: [] };

	const video = $('rec-video');
	video.buffered = { length: 0, start() { return 0; }, end() { return 0; } };
	video.canPlayType = () => '';       // no MSE, no playback: this is about the banner

	const json = (o) => Promise.resolve({ ok: true, json: () => Promise.resolve(o) });
	function apiFetch(url, opts) {
		env.asked.push(url);
		const range = opts && opts.headers && opts.headers.Range;
		if (range) {
			const m = /bytes=(\d+)-(\d+)/.exec(range);
			const a = +m[1], b = Math.min(+m[2], CLIP.length - 1);
			const slice = CLIP.subarray(a, b + 1);
			return Promise.resolve({
				ok: true,
				arrayBuffer: () => Promise.resolve(
					slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.length)),
			});
		}
		if (url.indexOf('/metrics/records') === 0) {
			// A camera running an older majestic answers 404 — a known
			// absence. A refused connection is an unknown, and the page has to
			// tell those two apart.
			if (metrics === null) return Promise.resolve({ ok: false, status: 404 });
			if (metrics === 'refused') return Promise.reject(new Error('refused'));
			const body = typeof metrics === 'function' ? metrics() : metrics;
			return Promise.resolve({ ok: true, text: () => Promise.resolve(body) });
		}
		if (url.indexOf('/api/v1/config.json') === 0) {
			return json({ records: { enabled: true, path: '/rec/%F', split: 2,
				mode: mode || 'continuous' } });
		}
		if (url.indexOf('/cgi-bin/j/pulse.cgi') === 0) {
			return json({ utc_offset: '+0000', timezone: 'UTC', time_now: 0 });
		}
		if (url.indexOf('/cgi-bin/j/sdcard.cgi') === 0) {
			return json({ health: cardHealth, mountpoint: '/mnt/mmcblk0p1',
				totalKb: 1e7, usedKb: 5e6, availKb: 5e6, recBytes: 1e9, fsErrors: [] });
		}
		if (url.indexOf('/cgi-bin/j/recordings.cgi?days=1') === 0) {
			return json({ prefix: '/rec', days: [{ name: '2026-09-04', clips: 1, mtime: 0 }] });
		}
		if (url.indexOf('/cgi-bin/j/recordings.cgi?day=') === 0) {
			return json({ path: '/rec/2026-09-04',
				clips: [{ name: '12-00.mp4', size: CLIP.length, mtime: 0 }] });
		}
		return Promise.reject(new Error('unstubbed ' + url));
	}

	const win = { console: console };   // no MediaSource: the page falls back
	const ctx = {
		window: win,
		document: {
			getElementById: (id) => $(id),
			createElement: () => makeEl('made'),
			querySelectorAll: () => [], addEventListener() {},
			body: makeEl('body'), hidden: false,
		},
		URL: { createObjectURL: () => 'blob:stub', revokeObjectURL() {} },
		location: { search: '', pathname: '/cgi-bin/recordings.cgi' },
		apiFetch: apiFetch,
		// The one main.js global this page now leans on for the recorder.
		parseMetrics: parseMetrics,
		mjGet: (cfg, dot) => dot.split('.').reduce((o, k) => (o == null ? undefined : o[k]), cfg),
		parseTzOffsetMs: () => 0,
		ianaZone: () => null,
		console: console, JSON: JSON, Promise: Promise, Date: Date, Math: Math,
		Intl: Intl, isFinite: isFinite, parseInt: parseInt, parseFloat: parseFloat,
		Uint8Array: Uint8Array, encodeURIComponent: encodeURIComponent,
		decodeURIComponent: decodeURIComponent, String: String, Number: Number,
		Array: Array, Object: Object, Error: Error, RegExp: RegExp,
		setTimeout, clearTimeout, clearInterval,
		setInterval: (fn) => { env.polls.push(fn); return 0; },
	};
	ctx.window.document = ctx.document;
	vm.createContext(ctx);
	for (const f of ['timeline.js', 'mp4index.js', 'recordings.js']) {
		vm.runInContext(fs.readFileSync(A(f), 'utf8'), ctx);
	}
	return env;
}

// The real parser, lifted out of main.js the same way metrics-parse.test.js
// reaches it — so a change to the format is caught there rather than being
// re-implemented differently here.
function parseMetrics(text) {
	const src = fs.readFileSync(A('main.js'), 'utf8');
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
	vm.runInContext(src + '\n;this.__parseMetrics = parseMetrics;', ctx);
	parseMetrics = ctx.__parseMetrics;    // compile once, then use the real one
	return parseMetrics(text);
}

const PATIENCE = 10000;
async function waitFor(pred, ms) {
	const end = Date.now() + (ms || PATIENCE);
	while (Date.now() < end) {
		if (pred()) return true;
		await new Promise((r) => setTimeout(r, 10));
	}
	return false;
}

function banner(env) { return env.$('rec-health').innerHTML || ''; }

// `lostSec` is footage dropped, in seconds. majestic reports it as
// records_dropped_ticks_total, in the media timescale — microseconds — beside
// a COUNT of fragments that is not the same thing, because records.fragmentMs
// is configurable.
const metricsWith = (state, lostSec) =>
	'# HELP records_state Recorder verdict\n' +
	'# TYPE records_state gauge\n' +
	'records_state ' + state + '\n' +
	'records_fragments_dropped_total ' + Math.round(lostSec || 0) + '\n' +
	'records_dropped_ticks_total ' + Math.round((lostSec || 0) * 1e6) + '\n' +
	'records_fragments_written_total 4200\n';

async function main() {
	group('the page asks majestic what it makes of the card, not only the kernel');

	{
		const env = load('ok', metricsWith(0, 0));
		await waitFor(() => env.asked.some((u) => u.indexOf('/cgi-bin/j/recordings.cgi?day=') === 0));
		await new Promise((r) => setTimeout(r, 50));
		check('a healthy card and a happy recorder say nothing',
			banner(env) === '', JSON.stringify(banner(env)).slice(0, 120));
		check('and the recorder really was asked',
			env.asked.some((u) => u.indexOf('/metrics/records') === 0));
	}

	// The whole point. Every one of these reads back from the SD-card endpoint
	// as a healthy filesystem with free space on it.
	const cases = [
		[3, 'cannot open', 'the camera has given up on the card'],
		[2, 'failing', 'writes are failing outright'],
		[1, 'intermittently', 'writes are failing now and then'],
	];
	for (const [st, needle, what] of cases) {
		const env = load('ok', metricsWith(st, 0));
		const ok = await waitFor(() => banner(env).indexOf(needle) >= 0);
		check('a card the filesystem calls healthy still warns when ' + what,
			ok, JSON.stringify(banner(env)).slice(0, 160));
	}

	{
		// The counter runs from boot. A card that dropped a second last Tuesday
		// and has been perfect since must not hold the banner red for ever —
		// "footage is being lost" is a claim about now.
		const env = load('ok', metricsWith(0, 37));
		await waitFor(() => env.polls.length > 0);
		await new Promise((r) => setTimeout(r, 50));
		check('drops that happened before this page opened are history, not news',
			banner(env) === '', JSON.stringify(banner(env)).slice(0, 160));
	}

	{
		// State 0 and losing footage NOW: nothing is wrong with the filesystem
		// and nothing is wrong with the writes — the card simply cannot take
		// the bitrate. The page would otherwise be green.
		let lost = 37;
		const env = load('ok', () => metricsWith(0, lost));
		await waitFor(() => env.polls.length > 0);
		await new Promise((r) => setTimeout(r, 50));
		check('nothing said while the counter is standing still', banner(env) === '');

		lost = 39.5;                       // two and a half more seconds gone
		env.polls[0]();
		const ok = await waitFor(() => banner(env).indexOf('cannot keep up') >= 0);
		check('but a card losing footage while you watch is not a healthy card',
			ok, JSON.stringify(banner(env)).slice(0, 200));
		check('and what it reports is the footage lost since, not since boot',
			banner(env).indexOf('37') < 0 && banner(env).indexOf('39') < 0,
			JSON.stringify(banner(env)).slice(0, 200));
	}

	group('a majestic too old to ask is not a majestic in trouble');

	for (const [m, how] of [[null, 'answers 404'], ['refused', 'cannot be reached']]) {
		const env = load('ok', m);
		await waitFor(() => env.asked.some((u) => u.indexOf('/cgi-bin/j/recordings.cgi?day=') === 0));
		await new Promise((r) => setTimeout(r, 50));
		check('nothing is claimed when /metrics/records ' + how,
			banner(env) === '', JSON.stringify(banner(env)).slice(0, 120));
	}

	// But the two are not the same, and the badge is where the difference
	// shows: a camera that answered and has no such endpoint is as known as it
	// can be, and gets the green it got before these metrics existed. A camera
	// that could not be asked is not known, and green is a claim.
	{
		const env = load('ok', null);
		await waitFor(() => env.$('rec-daynav').innerHTML.indexOf('badge') >= 0);
		check('an older majestic still gets its Recording badge',
			env.$('rec-daynav').innerHTML.indexOf('text-bg-success') >= 0,
			env.$('rec-daynav').innerHTML.slice(0, 200));
	}
	{
		const env = load('ok', 'refused');
		await waitFor(() => env.$('rec-daynav').innerHTML.indexOf('badge') >= 0);
		check('a camera that could not be asked does not',
			env.$('rec-daynav').innerHTML.indexOf('text-bg-success') < 0,
			env.$('rec-daynav').innerHTML.slice(0, 200));
	}

	group('a gap means different things in the two recording modes');

	// The page's whole job is explaining why footage is missing, so this is
	// not cosmetic. Recording continuously, a gap between clips is footage
	// that should be there and is not. Recording on motion it is the camera
	// doing exactly what was asked, and calling it "not recording" sends
	// somebody to look for a fault they do not have.
	{
		const env = load('ok', metricsWith(0, 0), 'continuous');
		const ok = await waitFor(() => env.$('rec-clips').innerHTML.indexOf('rec-clip') >= 0);
		check('recording continuously, the clip list is drawn', ok);
		check('and the motion lane says it has nothing to draw yet',
			env.$('rec-motion-note').textContent.indexOf('once the camera records') >= 0,
			env.$('rec-motion-note').textContent);
	}

	{
		const env = load('ok', metricsWith(0, 0), 'motion');
		await waitFor(() => env.$('rec-motion-note').textContent.indexOf('each clip') >= 0);
		check('recording on motion, the lane says the clips ARE the events',
			env.$('rec-motion-note').textContent.indexOf('each clip above is one event') >= 0,
			env.$('rec-motion-note').textContent);
	}

	group('the card still speaks for itself');

	{
		// A recorder that is perfectly happy does not overrule a card that is
		// plainly not: majestic reports state 0 until it next tries to write.
		const env = load('readonly', metricsWith(0, 0));
		const ok = await waitFor(() => banner(env).indexOf('read-only') >= 0);
		check('a read-only card is still reported through the filesystem', ok,
			JSON.stringify(banner(env)).slice(0, 160));
	}

	done();
}

main();
