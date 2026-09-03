// The recordings player's fill pump: does it keep asking for the clip?
//
// This is here for the reason every other file in tests/ is. The failure is
// silent and it cannot be reproduced on demand: MSE appends nothing, raises no
// error and reports no state anyone can see, so a dead pump looks exactly like
// a slow camera. Seeing the real thing needs a camera, a recording longer than
// the buffer the player runs ahead by, and the patience to watch it for a
// quarter of a minute — the bug does not appear at all on a short clip,
// because there the pump reaches the end of the file, calls endOfStream() and
// plays through.
//
// What it looked like on an hi3516av300, measured over CDP: the last append
// landed 12.15 s in front of the playhead, one twentieth of a second past the
// AHEAD gate; playback then ran for twelve more seconds, starved at 73.94 s of
// a 120 s clip and stayed there. Not one further byte of the recording was
// requested for the remaining minute and a half of the session.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const A = (f) => path.join(__dirname, '..', 'www', 'a', f);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- a recording, as majestic writes them ------------------------------
//
// The same shape mp4index.test.js builds against, cut down to the one case
// this needs: ftyp + moov, then a moof+mdat per second, every moof carrying a
// tfdt. Deliberately its own copy — a fixture shared between two tests is a
// fixture neither can change.

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
function ftyp() {
	const p = Buffer.alloc(28);
	p.write('isom', 0, 'latin1');
	p.writeUInt32BE(0x200, 4);
	p.write('isomiso2avc1iso6', 8, 'latin1');
	return box('ftyp', p);
}
function moov(timescale) {
	const mdhd = box('mdhd', Buffer.concat([u32(0, 0, 0, timescale, 0), u32(0)]));
	return box('moov', box('trak', box('mdia', mdhd)));
}
function tfdt(ticks) {
	const p = Buffer.alloc(12);
	p.writeUInt32BE(0x01000000, 0);            // version 1, flags 0
	p.writeBigUInt64BE(BigInt(ticks), 4);
	return box('tfdt', p);
}
function trun(durations) {
	const per = Buffer.alloc(durations.length * 8);
	durations.forEach((d, i) => {
		per.writeUInt32BE(d >>> 0, i * 8);
		per.writeUInt32BE(1000, i * 8 + 4);
	});
	return box('trun', Buffer.concat([u32(0x000305, durations.length, 0, 0x02000000), per]));
}
function moof(seq, ticks, durations) {
	const traf = Buffer.concat([box('tfhd', u32(0x020030, 1)), tfdt(ticks), trun(durations)]);
	return box('moof', Buffer.concat([box('mfhd', u32(0, seq)), traf]));
}
function mdat(len) { return box('mdat', Buffer.alloc(Math.max(0, len - 8), 0x41)); }

// `seconds` one-second fragments at timescale 1e6, 20 samples of 50000 ticks
// each. FRAG_BYTES is close to what an av300 writes for 1080p at 3 Mbit, which
// matters: it decides how many of them a 1 MiB read swallows.
const TIMESCALE = 1e6;
const FRAG_BYTES = 190000;
const FRAG_SECONDS = 1;
function clip(seconds) {
	const parts = [ftyp(), moov(TIMESCALE)];
	for (let i = 0; i < seconds; i++) {
		parts.push(moof(i, i * TIMESCALE, new Array(20).fill(50000)));
		parts.push(mdat(FRAG_BYTES));
	}
	return Buffer.concat(parts);
}

// The tfdt of an appended media segment, which is what tells the SourceBuffer
// stub below where the bytes belong on the timeline. Returns null for the init
// segment, which carries no fragment and buffers nothing.
function appendedAt(bytes) {
	const b = Buffer.from(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.length);
	const i = b.indexOf('tfdt', 0, 'latin1');
	return i < 0 ? null : Number(b.readBigUInt64BE(i + 8)) / TIMESCALE;
}

// ---- the browser, in as much as this needs one -------------------------

// Buffered ranges the way TimeRanges presents them: merged, in order, and only
// ever read through start()/end().
function makeRanges() {
	let r = [];
	return {
		add(from, to) {
			r.push([from, to]);
			r.sort((a, b) => a[0] - b[0]);
			const out = [];
			r.forEach((x) => {
				const last = out[out.length - 1];
				if (last && x[0] <= last[1] + 0.001) last[1] = Math.max(last[1], x[1]);
				else out.push(x.slice());
			});
			r = out;
		},
		drop(from, to) {
			r = r.map((x) => (x[0] >= from && x[1] <= to ? null : x))
				.filter(Boolean)
				.map((x) => (x[0] < to && x[1] > to ? [to, x[1]] : x));
		},
		clear() { r = []; },
		view: {
			get length() { return r.length; },
			start(i) { return r[i][0]; },
			end(i) { return r[i][1]; },
		},
		all() { return r.map((x) => [+x[0].toFixed(2), +x[1].toFixed(2)]); },
	};
}

function makeEl(id) {
	return {
		id: id, innerHTML: '', textContent: '', value: '', hidden: false,
		className: '', style: {}, dataset: {}, disabled: false,
		classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
		handlers: {},
		addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); },
		removeEventListener(ev, fn) {
			this.handlers[ev] = (this.handlers[ev] || []).filter((f) => f !== fn);
		},
		listeners(ev) { return (this.handlers[ev] || []).length; },
		fire(ev, arg) { (this.handlers[ev] || []).slice().forEach((f) => f(arg || { target: this })); },
		appendChild() {}, removeChild() {}, remove() {}, setAttribute() {},
		removeAttribute() {}, getAttribute() { return null; },
		querySelector() { return null; }, querySelectorAll() { return []; },
		closest() { return null; }, insertAdjacentHTML() {},
		getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 60 }; },
		load() {}, play() { return Promise.resolve(); },
	};
}

const CLIP_SECONDS = 120;
const CLIP = clip(CLIP_SECONDS);

function load() {
	const env = { appends: [], ranges: makeRanges(), reads: [], eos: false };
	const els = {};
	const $ = (id) => (els[id] = els[id] || makeEl(id));

	const video = $('rec-video');
	video.currentTime = 0;
	video.readyState = 0;
	video.paused = false;
	video.buffered = { length: 0, start() { return 0; }, end() { return 0; } };
	video.canPlayType = () => 'probably';
	env.video = video;
	env.$ = $;

	const MediaSourceStub = function () {
		const ms = {
			readyState: 'open',
			listeners: {},
			addEventListener(ev, fn) {
				ms.listeners[ev] = fn;
				// The browser raises sourceopen once the object URL is
				// attached to the element, which is the step before this.
				if (ev === 'sourceopen') setTimeout(fn, 0);
			},
			addSourceBuffer() {
				const sb = {
					updating: false,
					buffered: env.ranges.view,
					handlers: {},
					addEventListener(ev, fn) { (sb.handlers[ev] = sb.handlers[ev] || []).push(fn); },
					fire(ev) { (sb.handlers[ev] || []).slice().forEach((f) => f()); },
					appendBuffer(bytes) {
						const at = appendedAt(bytes);
						env.appends.push({ at: at, bytes: bytes.length });
						if (at !== null) env.ranges.add(at, at + FRAG_SECONDS);
						sb.updating = true;
						// updateend lands on a later task, as it does in a
						// browser. Firing it inline would make fill() recurse
						// through every fragment in the clip on one stack.
						setTimeout(() => { sb.updating = false; sb.fire('updateend'); }, 0);
					},
					remove(from, to) {
						env.ranges.drop(from, to === Infinity ? 1e9 : to);
						sb.updating = true;
						setTimeout(() => { sb.updating = false; sb.fire('updateend'); }, 0);
					},
				};
				env.sb = sb;
				return sb;
			},
			removeSourceBuffer() {}, endOfStream() { env.eos = true; },
		};
		env.ms = ms;
		return ms;
	};
	MediaSourceStub.isTypeSupported = () => true;

	// The camera. Range reads come off the fixture; everything else is the
	// smallest answer the page will accept.
	const json = (o) => Promise.resolve({ ok: true, json: () => Promise.resolve(o) });
	function apiFetch(url, opts) {
		const range = opts && opts.headers && opts.headers.Range;
		if (range) {
			const m = /bytes=(\d+)-(\d+)/.exec(range);
			const a = +m[1], b = Math.min(+m[2], CLIP.length - 1);
			env.reads.push([a, b]);
			const slice = CLIP.subarray(a, b + 1);
			return Promise.resolve({
				ok: true,
				arrayBuffer: () => Promise.resolve(
					slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.length)),
			});
		}
		if (url.indexOf('/api/v1/config.json') === 0) {
			return json({ records: { enabled: true, path: '/rec/%F', split: 2 } });
		}
		if (url.indexOf('/cgi-bin/j/pulse.cgi') === 0) {
			return json({ utc_offset: '+0000', timezone: 'UTC', time_now: 0 });
		}
		if (url.indexOf('/cgi-bin/j/sdcard.cgi') === 0) {
			return json({ health: 'ok', total: 1e10, free: 5e9, used: 5e9, recBytes: 1e9 });
		}
		if (url.indexOf('/cgi-bin/j/recordings.cgi?days=1') === 0) {
			return json({ prefix: '/rec', days: [{ name: '2026-09-03', clips: 1, mtime: 0 }] });
		}
		if (url.indexOf('/cgi-bin/j/recordings.cgi?day=') === 0) {
			return json({
				path: '/rec/2026-09-03',
				clips: [{ name: '12-00.mp4', size: CLIP.length, mtime: 0 }],
			});
		}
		return Promise.reject(new Error('unstubbed ' + url));
	}

	// recordings.js asks `'MediaSource' in window` before it will use MSE at
	// all, so the constructor has to be reachable both ways.
	const win = { MediaSource: MediaSourceStub, console: console };
	const ctx = {
		window: win,
		document: {
			getElementById: (id) => $(id),
			createElement: () => makeEl('made'),
			querySelectorAll: () => [],
			addEventListener() {},
			body: makeEl('body'),
			hidden: false,
		},
		MediaSource: MediaSourceStub,
		URL: { createObjectURL: () => 'blob:stub', revokeObjectURL() {} },
		location: { search: '', pathname: '/cgi-bin/tool-recordings.cgi' },
		apiFetch: apiFetch,
		mjGet: (cfg, dot) => dot.split('.').reduce((o, k) => (o == null ? undefined : o[k]), cfg),
		parseTzOffsetMs: () => 0,
		ianaZone: () => null,
		console: console, JSON: JSON, Promise: Promise, Date: Date, Math: Math,
		Intl: Intl, isFinite: isFinite, parseInt: parseInt, parseFloat: parseFloat,
		Uint8Array: Uint8Array, encodeURIComponent: encodeURIComponent,
		decodeURIComponent: decodeURIComponent, String: String, Number: Number,
		Array: Array, Object: Object, Error: Error, RegExp: RegExp,
		setTimeout, clearTimeout, setInterval, clearInterval,
	};
	ctx.window.document = ctx.document;
	vm.createContext(ctx);
	for (const f of ['timeline.js', 'mp4index.js', 'recordings.js']) {
		vm.runInContext(fs.readFileSync(A(f), 'utf8'), ctx);
	}
	return env;
}

function bufferedEnd(env) {
	const r = env.ranges.all();
	return r.length ? r[r.length - 1][1] : 0;
}

// Nothing here is allowed to assert on a fixed delay. Every append travels
// through a deferred updateend and a promise-backed range read, so "wait 200 ms
// and look" is really "wait for the scheduler to be as quick as it was on the
// machine this was written on" — which a loaded CI runner is not, and the build
// that fails then has nothing wrong with it. Wait for the condition instead;
// the timeout only decides how long a genuine failure takes to report.
const PATIENCE = 10000;
async function waitFor(pred, ms) {
	const end = Date.now() + (ms || PATIENCE);
	while (Date.now() < end) {
		if (pred()) return true;
		await sleep(5);
	}
	return false;
}

// "The pump has gone quiet" is the one thing that cannot be waited FOR, only
// waited OUT — so wait until it has stopped appending and stayed stopped, and
// let a slow runner take as long as it needs to get there.
async function quiesce(env, quietMs) {
	const quiet = quietMs || 250;
	const end = Date.now() + PATIENCE;
	let seen = -1, since = Date.now();
	while (Date.now() < end) {
		if (env.appends.length !== seen) { seen = env.appends.length; since = Date.now(); }
		else if (Date.now() - since >= quiet) return true;
		await sleep(10);
	}
	return false;
}

// Playback, at the only granularity that matters here: the element reports the
// playhead through timeupdate roughly four times a second, and it cannot move
// past what is buffered — a browser that runs out says `waiting` and sits
// there. Returns where it actually got to, so a test can tell "played to the
// end" from "stopped early", which is the whole subject.
async function playTo(env, sec) {
	const STEP = 0.25;
	const ahead = () => env.video.currentTime + STEP <= bufferedEnd(env);
	while (env.video.currentTime + STEP <= sec) {
		if (!ahead()) {
			// Starved. A browser says so and sits there; so does this, for as
			// long as it takes the pump to reach us. Only a pump that never
			// does ends the run.
			env.video.fire('waiting');
			if (!await waitFor(ahead)) break;
			continue;
		}
		env.video.currentTime = +(env.video.currentTime + STEP).toFixed(2);
		env.video.fire('timeupdate');
		await sleep(0);
	}
	return env.video.currentTime;
}

(async () => {
	group('the pump keeps going for as long as the clip does');
	{
		const env = load();

		// The page opens the newest clip sixty seconds before its end — that
		// is freshest(), and it is why this bug is the first thing anybody
		// meets on the page rather than something they scroll into.
		const opened = await waitFor(() => env.appends.length > 1 && bufferedEnd(env) > 60);
		check('it opened the clip and buffered around the landing point', opened,
			'appends=' + env.appends.length + ' buffered=' + JSON.stringify(env.ranges.all()));

		check('and then stops, once it is far enough ahead', await quiesce(env),
			'still appending after ' + PATIENCE + 'ms');
		const settled = bufferedEnd(env);
		check('about AHEAD seconds ahead of the playhead, not more',
			settled - env.video.currentTime < 20,
			(settled - env.video.currentTime) + 's ahead');

		// The regression. Play forward through what it buffered: every quarter
		// second the playhead moves is a quarter second the buffer is shorter,
		// and something has to notice.
		await playTo(env, settled - 2);
		check('playing forward makes it fetch more',
			bufferedEnd(env) > settled,
			'buffered ended at ' + bufferedEnd(env) + ', was ' + settled);
		check('and the playhead never overtakes the buffer',
			bufferedEnd(env) > env.video.currentTime,
			'playhead ' + env.video.currentTime + ' vs buffer ' + bufferedEnd(env));

		// All the way to the end of the clip, which is the thing that could
		// not happen before: the whole recording, not the first twelve
		// seconds of wherever it was opened.
		const got = await playTo(env, CLIP_SECONDS - 3);
		// The pump runs ahead of the playhead, so it reaches the end of the
		// file before playback does. endOfStream is how it says so, and it is
		// the only end-state worth waiting on: fill() raises it from the top of
		// a call the previous append's updateend made, so by the time it lands
		// every fragment in the clip is already in the buffer.
		const finished = await waitFor(() => env.eos === true);
		check('it followed playback to the end of the recording',
			got >= CLIP_SECONDS - 4 && bufferedEnd(env) >= CLIP_SECONDS - 1,
			'played to ' + got + ', buffered ' + bufferedEnd(env) + ' of ' + CLIP_SECONDS);
		check('and said so, so the element stops rather than running past it',
			finished);
	}

	group('a buffer that ran dry is picked back up');
	{
		const env = load();
		await waitFor(() => bufferedEnd(env) > 60);
		await quiesce(env);

		// Starvation is the case timeupdate cannot report: once the element
		// has nothing to play, currentTime stops moving and timeupdate stops
		// with it. `waiting` is the only thing left that fires.
		env.video.currentTime = bufferedEnd(env);
		env.ranges.clear();
		const before = env.appends.length;
		env.video.fire('waiting');
		check('waiting alone restarts it',
			await waitFor(() => env.appends.length > before),
			'appends ' + before + ' -> ' + env.appends.length);
	}

	group('the listeners belong to the player, not to the element');
	{
		const env = load();
		await waitFor(() => bufferedEnd(env) > 60);
		await quiesce(env);
		const v = env.video;
		// Two timeupdate listeners is the right answer, not one: wire() keeps
		// one of the page's own on this element to move the playhead along the
		// timeline. What matters is that the number does not grow.
		const timeupdates = v.listeners('timeupdate');
		const waits = v.listeners('waiting');
		check('the player added one of each on top of the page\'s own',
			timeupdates === 2 && waits === 1,
			'timeupdate ' + timeupdates + ' waiting ' + waits);

		// The element outlives every player attached to it. Clicking a clip in
		// the list runs the whole open path again — destroy() then attach() —
		// and a pair that attach() adds without destroy() taking it away shows
		// up here as two players driving one element, then three, then four.
		const button = { dataset: { clip: '12-00.mp4' } };
		button.closest = () => button;
		for (let i = 0; i < 3; i++) {
			const reads = env.reads.length;
			env.$('rec-clips').fire('click', { target: button });
			await waitFor(() => env.reads.length > reads);
			await quiesce(env);
		}
		check('and the same after reopening it three times',
			v.listeners('timeupdate') === timeupdates && v.listeners('waiting') === waits,
			'timeupdate ' + v.listeners('timeupdate') + ' waiting ' + v.listeners('waiting'));
		check('reopening really did run the open path again',
			env.appends.length > 0 && env.reads.length > 4,
			'reads=' + env.reads.length);
	}

	done();
})();
