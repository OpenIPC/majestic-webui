// The Clips card, on a day that does not fit in it.
//
// records.split is counted in minutes and 1 is a legal value, so a camera can
// close a file every minute and a full day is 1440 clips. This card used to
// draw all of them: on a lab hi3516av300 holding 745, about 49,000 px of
// column, which was then the height of the page itself. It draws a window now.
//
// Both things a window can be silently wrong about are pinned here, because
// neither reports itself. A row the window skips is a clip that is not on the
// page, and a page missing a row looks exactly like a page — the same failure
// tree.test.js exists for on the settings side. And a divider drawn between
// the wrong pair of rows says the camera stopped recording at a time it did
// not: it was doing exactly that before this landed, one row out, which nobody
// could see on a day with no hole in it and nobody could miss on a day with
// one.
//
// The third thing is the reason a window is bearable at all: picking a clip
// somewhere else in the day has to bring the list to it. Without that, the
// window is just a shorter list that no longer holds what is playing.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const A = (f) => path.join(__dirname, '..', 'www', 'a', f);

// ---- a recording, as majestic writes them ------------------------------
//
// Its own copy, for the reason recordings-pump.test.js gives for having one: a
// fixture shared between two tests is a fixture neither can change. Four
// seconds of nothing, indexable and then left alone — this file is about the
// list beside the player, not about the player.

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

// ---- the day this runs against -----------------------------------------
//
// One clip a minute, which is what records.split: 1 writes, and one hole in
// the middle of it — an hour the camera was not recording. The hole is what
// makes the divider assertion possible at all: on an unbroken day every
// placement of it looks right.

const SPLIT_MIN = 1;
const HOLE_AT = 100;                 // clips before the hole, counting from 00:00
const HOLE_MIN = 60;                 // and how long it lasts
const TOTAL = 300;

function dayClips() {
	const out = [];
	let min = 0;
	for (let i = 0; i < TOTAL; i++) {
		if (i === HOLE_AT) min += HOLE_MIN;
		const hh = String(Math.floor(min / 60)).padStart(2, '0');
		const mm = String(min % 60).padStart(2, '0');
		out.push({ name: hh + '-' + mm + '-00.mp4', size: CLIP.length, mtime: 0 });
		min += SPLIT_MIN;
	}
	return out;
}
const CLIPS = dayClips();
const startOf = (name) => {
	const m = /^(\d\d)-(\d\d)/.exec(name);
	return +m[1] * 3600 + +m[2] * 60;
};
// What the page prints in a row and in a divider. It is not asked for the
// camera's zone here: the stub answers +0000 and the fixture is written in it.
const hhmm = (sec) => String(Math.floor(sec / 3600)).padStart(2, '0') + ':' +
	String(Math.floor(sec / 60) % 60).padStart(2, '0');

// ---- the browser, in as much as this needs one -------------------------

function makeEl(id) {
	return {
		id: id, innerHTML: '', textContent: '', value: '', hidden: false,
		className: '', style: {}, dataset: {}, disabled: false,
		// Real numbers rather than undefined: the list reads them to decide
		// whether a scroll has reached the end of the day, and NaN would take
		// that branch by accident rather than by test.
		scrollTop: 0, scrollHeight: 0, clientHeight: 0, offsetHeight: 0,
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

function load() {
	const els = {};
	const $ = (id) => (els[id] = els[id] || makeEl(id));
	const env = { $: $, asked: [], polls: [] };

	const video = $('rec-video');
	video.buffered = { length: 0, start() { return 0; }, end() { return 0; } };
	video.canPlayType = () => '';

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
			return Promise.resolve({ ok: true, text: () => Promise.resolve(
				'records_state 1\nrecords_fragments_written_total 42\n') });
		}
		if (url.indexOf('/api/v1/config.json') === 0) {
			return json({ records: { enabled: true, path: '/rec/%F', split: SPLIT_MIN,
				mode: 'continuous' } });
		}
		if (url.indexOf('/cgi-bin/j/pulse.cgi') === 0) {
			return json({ utc_offset: '+0000', timezone: 'UTC', time_now: 0 });
		}
		if (url.indexOf('/cgi-bin/j/sdcard.cgi') === 0) {
			return json({ health: 'ok', mountpoint: '/mnt/mmcblk0p1',
				totalKb: 1e7, usedKb: 5e6, availKb: 5e6, recBytes: 1e9, fsErrors: [] });
		}
		if (url.indexOf('/cgi-bin/j/recordings.cgi?days=1') === 0) {
			return json({ prefix: '/rec', days: [{ name: '2026-09-04', clips: CLIPS.length, mtime: 0 }] });
		}
		if (url.indexOf('/cgi-bin/j/recordings.cgi?day=') === 0) {
			return json({ path: '/rec/2026-09-04', clips: CLIPS.slice() });
		}
		return Promise.reject(new Error('unstubbed ' + url));
	}

	const win = { console: console };
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
		parseMetrics: parseMetrics,
		mjNotice: (cls, body) => '<div>' + body + '</div>',
		mjNoticeIcon: () => '',
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
	for (const f of ['timeline.js', 'mp4index.js', 'mjcrypto.js', 'mp4crypt.js',
		'reckeys.js', 'recordings.js']) {
		vm.runInContext(fs.readFileSync(A(f), 'utf8'), ctx);
	}
	return env;
}

// The one main.js global the page leans on here, taken from the real file so a
// change to the metrics format is caught where it is parsed rather than being
// re-implemented differently in this one.
let mainCtx = null;
function parseMetrics(text) {
	if (!mainCtx) {
		mainCtx = {
			console: console, JSON: JSON, Object: Object, isNaN: isNaN,
			document: { addEventListener() {}, getElementById: () => null,
				querySelector: () => null, querySelectorAll: () => [] },
			window: { addEventListener() {} },
			setTimeout, clearTimeout, setInterval, clearInterval,
			fetch: () => Promise.reject(new Error('no network')),
			location: { pathname: '/', search: '' },
			navigator: {}, localStorage: { getItem: () => null, setItem() {} },
		};
		vm.createContext(mainCtx);
		vm.runInContext(fs.readFileSync(A('main.js'), 'utf8') +
			'\n;this.__lift = { parseMetrics };', mainCtx);
	}
	return mainCtx.__lift.parseMetrics(text);
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

// ---- reading the list back ---------------------------------------------
//
// The card is one HTML string, so what is drawn is read out of it in the order
// it is drawn: a row, a divider, a step-further control. Order is the whole
// point — the divider assertion is about which two rows one sits between.

function items(env) {
	const html = env.$('rec-clips').innerHTML || '';
	const re = /data-clip="([^"]*)"|class="rec-gap"><span>([^<]*)<|data-clips="([^"]*)"/g;
	const out = [];
	let m;
	while ((m = re.exec(html))) {
		if (m[1] !== undefined) out.push({ kind: 'clip', name: m[1] });
		else if (m[2] !== undefined) out.push({ kind: 'gap', text: m[2] });
		else out.push({ kind: 'more', where: m[3] });
	}
	return out;
}
const names = (env) => items(env).filter((x) => x.kind === 'clip').map((x) => x.name);

// A press on a row, or on the control under the last one. The page reaches
// both through one delegated listener on the card, and a clip is looked up by
// name in the day — which is also how the ribbon and the band open one, so
// naming a clip the window is not currently drawing is a faithful stand-in for
// picking it off the timeline rather than a shortcut around the page.
function press(env, attr, value) {
	const el = env.$('rec-clips');
	const btn = {
		dataset: attr === 'data-clip' ? { clip: value } : { clips: value },
		closest: (s) => (s === '[' + attr + ']' ? btn : null),
	};
	(el.handlers.click || []).forEach((fn) => fn.call(el, { target: btn }));
}

async function main() {
	group('a day of one-minute clips is a window, not the whole day');

	const env = load();
	await waitFor(() => (env.$('rec-clips').innerHTML || '').indexOf('data-clip') >= 0);
	await new Promise((r) => setTimeout(r, 50));

	{
		const drawn = names(env);
		check('the card draws a fraction of the day, not all ' + TOTAL + ' clips',
			drawn.length > 0 && drawn.length < TOTAL / 2, drawn.length + ' rows');
		check('and says how many are left rather than dropping them silently',
			items(env).some((x) => x.kind === 'more' && x.where === 'older'));
		check('newest first, which is the end of the day',
			drawn[0] === CLIPS[CLIPS.length - 1].name, drawn[0]);
	}

	{
		// Every name the day holds, newest first: what the list is a window on.
		const all = CLIPS.map((c) => c.name).reverse();
		let drawn = names(env);
		check('the window is the newest clips, in order and with none skipped',
			drawn.every((n, i) => n === all[i]), drawn.slice(0, 3).join(',') + '…');

		// Walk the whole day a step at a time. Each step must extend what is
		// drawn rather than replace or repeat any of it — a window that
		// restarts, overlaps or jumps loses clips without saying so.
		let steps = 0;
		while (items(env).some((x) => x.kind === 'more' && x.where === 'older') && steps < 50) {
			const before = names(env);
			press(env, 'data-clips', 'older');
			drawn = names(env);
			steps++;
			if (drawn.length <= before.length ||
				!before.every((n, i) => n === drawn[i])) {
				check('step ' + steps + ' extends the window', false,
					before.length + ' -> ' + drawn.length);
				break;
			}
		}
		check('the day can be walked to its end', drawn.length === TOTAL,
			drawn.length + ' of ' + TOTAL + ' after ' + steps + ' steps');
		check('and every clip is drawn exactly once',
			drawn.length === new Set(drawn).size && drawn.every((n, i) => n === all[i]));
	}

	group('a divider names the two rows it sits between');

	{
		// The hole is drawn once, and between the pair it describes: the clip
		// above it is the newer one, the clip below is the older, and the two
		// times it prints are the older one's end and the newer one's start.
		const seq = items(env).filter((x) => x.kind !== 'more');
		const gaps = seq.filter((x) => x.kind === 'gap');
		check('one hole in the day is one divider', gaps.length === 1,
			gaps.length + ': ' + gaps.map((g) => g.text).join(' | '));

		const i = seq.findIndex((x) => x.kind === 'gap');
		const newer = i > 0 ? seq[i - 1] : null;
		const older = seq[i + 1];
		check('it sits between two clips', !!(newer && newer.kind === 'clip' &&
			older && older.kind === 'clip'));
		if (newer && older) {
			const want = hhmm(startOf(older.name) + SPLIT_MIN * 60) + ' – ' +
				hhmm(startOf(newer.name));
			check('and prints exactly the hole between them',
				(gaps[0].text || '').indexOf(want) >= 0,
				JSON.stringify(gaps[0].text) + ' want ' + JSON.stringify(want));
		}
	}

	group('picking a clip elsewhere in the day brings the list to it');

	{
		const fresh = load();
		await waitFor(() => (fresh.$('rec-clips').innerHTML || '').indexOf('data-clip') >= 0);
		await new Promise((r) => setTimeout(r, 50));

		// The oldest clip on the card — the far end of the day from where the
		// page opens, and nowhere near the window it opened on.
		const want = CLIPS[0].name;
		check('is not drawn to begin with', names(fresh).indexOf(want) < 0);

		press(fresh, 'data-clip', want);
		await new Promise((r) => setTimeout(r, 50));

		const drawn = names(fresh);
		check('after picking it, it is the row the window starts at',
			drawn[0] === want, drawn.slice(0, 2).join(','));
		check('and the window moved rather than growing to reach it',
			drawn.length < TOTAL / 2, drawn.length + ' rows');
		check('with a count of what it moved past',
			items(fresh).some((x) => x.kind === 'more' && x.where === 'newer'));
		check('the row that is playing is the one marked active',
			(fresh.$('rec-clips').innerHTML || '')
				.indexOf('class="rec-clip active" data-clip="' + want + '"') >= 0);
	}

	done();
}

main();
