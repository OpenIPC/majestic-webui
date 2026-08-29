// fw-reset.js's reboot watch, driven against stubs.
//
// One question, three ways in: does the page ever stop waiting? The factory
// reset erases the overlay and reboots, and the page has to notice and hand the
// user back. It has three triggers for that — sysupgrade announcing the reboot,
// the stream settling, and the stream going quiet — and the third is the only
// one that survives a hard reboot denying us the other two. "Unconditional
// reboot" is printed microseconds before the kernel goes, so it can still be in
// a socket buffer when the camera stops being on the other end; and a machine
// that has gone sends no FIN, so the read after it neither resolves nor rejects.
// Reported on a gk7205v300 with the transcript stopped on the last erase line:
// overlay wiped, camera rebooted, page waiting for ever (issue #154).
//
// Stubs and a hand-driven clock rather than a browser, because that is a fetch
// that hangs for ever fifteen seconds after the last byte. A real one cannot be
// arranged on demand; this one is the default case.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const SRC = path.join(__dirname, '..', 'www', 'a', 'fw-reset.js');

// The code under test is a chain of awaits behind a stubbed fetch, so an event
// only reaches its effect after several microtask turns. Real setImmediate,
// deliberately: the clock below is fake, and draining it with itself would just
// spin.
const flush = async (n) => { for (let i = 0; i < (n || 20); i++) await new Promise(r => setImmediate(r)); };

// --- a clock the test owns ------------------------------------------------
// setInterval/setTimeout register here instead of running; advance() moves time
// and fires whatever came due. Nothing waits on wall-clock, so the 15s quiet
// window costs nothing to cross.
function makeClock() {
	let now = 0, seq = 0;
	const jobs = new Map();
	return {
		now: () => now,
		setInterval(fn, ms) { const id = ++seq; jobs.set(id, { fn, ms, at: now + ms, repeat: true }); return id; },
		setTimeout(fn, ms) { const id = ++seq; jobs.set(id, { fn, ms: ms || 0, at: now + (ms || 0), repeat: false }); return id; },
		clear(id) { jobs.delete(id); },
		// Step in small slices so a repeating job fires once per period, not once.
		// flush() between slices because the code under test is a chain of awaits:
		// a fired timer only reaches its effect after several microtask turns, and
		// Promise.resolve() alone gives it one.
		async advance(ms) {
			const target = now + ms;
			while (now < target) {
				let next = target;
				for (const j of jobs.values()) if (j.at > now && j.at < next) next = j.at;
				now = next;
				for (const [id, j] of [...jobs]) {
					if (j.at > now) continue;
					if (j.repeat) j.at = now + j.ms; else jobs.delete(id);
					j.fn();
				}
				await flush();
			}
			await flush();
		},
	};
}

function makeEnv(o) {
	o = o || {};
	const clock = makeClock();
	const env = { clock, notes: [], status: { className: '', textContent: '' }, replaced: null, pings: 0 };

	// The run.cgi stream: chunks the test pushes, then a read that never settles
	// unless the test says otherwise.
	env.queue = [];
	let pendingRead = null;
	const reader = {
		read() {
			if (env.queue.length) return Promise.resolve({ value: env.queue.shift(), done: false });
			if (o.endStream) return Promise.resolve({ value: undefined, done: true });
			if (o.failStream) return Promise.reject(new Error('network'));
			return new Promise(r => { pendingRead = r; });   // the hang
		},
	};
	env.push = (s) => {
		const bytes = Buffer.from(s, 'utf8');
		if (pendingRead) { const r = pendingRead; pendingRead = null; r({ value: bytes, done: false }); }
		else env.queue.push(bytes);
		return flush();
	};

	const out = { dataset: { cmd: '/usr/sbin/sysupgrade -n --web' } };

	const ctx = {
		$: (sel) => (sel === '#output' ? out : sel === '#fw-reset-status' ? env.status : null),
		termWriter: () => ({
			write: (t) => t,                       // returns the raw chunk, as the real one does
			commit: () => {},
			note: (s) => env.notes.push(s),
		}),
		rawFetch: (url) => {
			if (String(url).indexOf('run.cgi') !== -1)
				return Promise.resolve({ ok: !o.notOk, status: o.notOk ? 401 : 200, body: { getReader: () => reader } });
			env.pings++;                           // the ping() in pollBack
			return o.cameraDown && env.pings <= (o.downFor || 0)
				? Promise.reject(new Error('down'))
				: Promise.resolve({ ok: true });
		},
		TextDecoder: function () { this.decode = (b) => Buffer.from(b).toString('utf8'); },
		btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
		performance: { now: clock.now },
		setInterval: clock.setInterval, clearInterval: clock.clear,
		setTimeout: clock.setTimeout, clearTimeout: clock.clear,
		AbortController: function () { this.signal = null; this.abort = () => {}; },
		location: { replace: (u) => { env.replaced = u; } },
		stopHeartbeat: () => { env.heartbeatStopped = true; },
		startHeartbeat: () => { env.heartbeatResumed = true; },
		Date: Date, Promise: Promise, Error: Error, console: console,
	};
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx);
	return env;
}

const PROTECTED = 'Protected: flashing continues even if this terminal disconnects.\n';
const ERASE = 'Erasing 64 Kibyte @ 8b0000 - 100% complete.Cleanmarker written at 8a0000.\n';
// Deliberately the "waiting for it to come back" half, not "rebooting": the
// message for a reset that did nothing says "without rebooting the camera", and
// a looser match calls that a reboot watch.
const watching = (env) => /waiting for it to come back/i.test(env.status.textContent);

// --- cases ----------------------------------------------------------------

// The reported bug: the last line never arrives and the socket never dies.
async function quietAfterFlashStartsTheWatch() {
	group('a stream that hangs after the erase still starts the reboot watch');
	const env = makeEnv();
	await env.push(PROTECTED);
	await env.push(ERASE);
	await env.clock.advance(9000);
	check('still waiting 9s in, before the window is up', !watching(env));
	await env.clock.advance(9000);
	check('watch started once the stream has been quiet 15s', watching(env),
		'status was ' + JSON.stringify(env.status.textContent));
	check('the gap is marked in the transcript', env.notes.some(n => /no output for 15s/.test(n)),
		JSON.stringify(env.notes));
}

// The trigger that already worked must keep working, and must not double-fire.
async function rebootMarkerStillWins() {
	group('the reboot announcement still starts the watch immediately');
	const env = makeEnv();
	await env.push(PROTECTED);
	await env.push('\nUnconditional reboot\n');
	await env.clock.advance(10);
	check('watch started on the marker, without waiting out the window', watching(env));
	await env.clock.advance(30000);
	check('no quiet note added on top of it', !env.notes.some(n => /no output/.test(n)),
		JSON.stringify(env.notes));
}

// Before the point of no return, silence means a slow camera, not a gone one.
// Navigating away here would abandon a reset that had not started.
async function quietBeforeFlashIsIgnored() {
	group('silence before the point of no return does not start the watch');
	const env = makeEnv();
	await env.push('Stopping crond: OK\n');
	await env.clock.advance(60000);
	check('still waiting after 60s of pre-flash quiet', !watching(env),
		'status was ' + JSON.stringify(env.status.textContent));
	check('nothing written to the transcript about a gap', env.notes.length === 0);
}

// Once the watch is running the timer has no more work; leaving it armed would
// tick for the life of the tab.
async function timerStopsOnceWatching() {
	group('the quiet timer stops once the watch is running');
	const env = makeEnv();
	await env.push(PROTECTED);
	await env.push('\nUnconditional reboot\n');
	await env.clock.advance(10);
	const before = env.pings;
	await env.clock.advance(3000);
	check('polling continues', env.pings > before);
	check('but no second quiet note ever appears', !env.notes.some(n => /no output/.test(n)));
}

// The camera goes, comes back, and the page hands the user over.
async function handsBackOnceTheCameraReturns() {
	group('the watch navigates once the camera has gone and returned');
	const env = makeEnv({ cameraDown: true, downFor: 2 });
	await env.push(PROTECTED);
	await env.push('\nUnconditional reboot\n');
	await env.clock.advance(20000);
	check('navigated to the status page', env.replaced === '/cgi-bin/status.cgi',
		'replaced=' + env.replaced);
}

// The other way the same stuck page is reached: the stream ends cleanly rather
// than hanging, which is what a majestic that closes the response as its CGI
// child dies would produce. How it ended says nothing about the reboot.
async function cleanEndAfterFlashStartsTheWatch() {
	group('a stream that ENDS cleanly after the erase also starts the watch');
	const env = makeEnv({ endStream: true });
	await env.push(PROTECTED);
	await env.push(ERASE);
	await env.clock.advance(10);
	check('watch started without waiting for the quiet window', watching(env),
		'status was ' + JSON.stringify(env.status.textContent));
	check('transcript closed off, since the stream really did end',
		env.notes.some(n => /connection to the camera ended/.test(n)), JSON.stringify(env.notes));
}

// ...but a clean end BEFORE the point of no return is a reset that did nothing,
// and must still say so rather than watching for a reboot that is not coming.
async function cleanEndBeforeFlashReportsIt() {
	group('a clean end before the point of no return is reported, not watched');
	const env = makeEnv({ endStream: true });
	await env.push('Stopping crond: OK\n');
	await env.clock.advance(10);
	check('no reboot watch started', !watching(env));
	check('says the reset finished without rebooting',
		/without rebooting/i.test(env.status.textContent),
		'status was ' + JSON.stringify(env.status.textContent));
}

(async () => {
	await quietAfterFlashStartsTheWatch();
	await cleanEndAfterFlashStartsTheWatch();
	await cleanEndBeforeFlashReportsIt();
	await rebootMarkerStillWins();
	await quietBeforeFlashIsIgnored();
	await timerStopsOnceWatching();
	await handsBackOnceTheCameraReturns();
	done();
})();
