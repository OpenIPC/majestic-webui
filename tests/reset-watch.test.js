// factory-reset.js's reboot watch, driven against stubs.
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

const SRC = path.join(__dirname, '..', 'www', 'a', 'factory-reset.js');

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

// The status banner is a .mj-notice: factory-reset.js writes the drawn mark and
// a .mj-notice-txt child into it and puts the message in that child. The stub
// follows it there rather than being widened into a DOM, so every assertion
// below goes on reading one .textContent -- which is the right reading, since
// that child's text IS what the banner says.
function makeStatusEl() {
	const txt = { textContent: '' };
	return {
		className: '', innerHTML: '',
		querySelector: (sel) => (sel === '.mj-notice-txt' ? txt : null),
		get textContent() { return txt.textContent; },
		set textContent(v) { txt.textContent = v; },
	};
}

function makeEnv(o) {
	o = o || {};
	const clock = makeClock();
	const env = { clock, notes: [], status: makeStatusEl(), replaced: null, pings: 0, metricsReads: 0 };

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
		// A stub, deliberately: this file asserts on what the banner SAYS, and
		// nothing here reads the mark. recordings-health.test.js lifts the real
		// one out of main.js, which is where a change to it would be caught.
		mjNoticeIcon: () => '<svg class="mj-notice-ico"></svg>',
		termWriter: () => ({
			write: (t) => t,                       // returns the raw chunk, as the real one does
			commit: () => {},
			note: (s) => env.notes.push(s),
		}),
		rawFetch: (url) => {
			if (String(url).indexOf('run.cgi') !== -1)
				return Promise.resolve({ ok: !o.notOk, status: o.notOk ? 401 : 200, body: { getReader: () => reader } });
			// The uptime read, before the ping counter: it is not a ping, and
			// counting it would shift every downFor: n the cases below are pinned on.
			// Unavailable unless a case asks for it, so a camera that will not say
			// when it booted is the default and every pre-existing case still
			// describes the blind watch.
			if (String(url).indexOf('/metrics') !== -1) {
				env.metricsReads++;
				if (o.uptime === undefined) return Promise.resolve({ ok: false, status: 401 });
				const boot = 1700000000;
				return Promise.resolve({
					ok: true, status: 200,
					text: () => Promise.resolve(
						'node_boot_time_seconds ' + boot + '\n' +
						'node_time_seconds ' + (boot + o.uptime) + '\n'),
				});
			}
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
	check('navigated to the status page', env.replaced === '/cgi-bin/dashboard.cgi',
		'replaced=' + env.replaced);
}

// The reported bug's second half, and the one that survived the first fix: the
// watch opens fifteen seconds after the last byte, and the camera's whole
// absence is about as long, so every ping it ever makes finds the camera
// serving. Measured on an hi3516ev300 — gone at 8s, back at 23s, first ping at
// 19s answered 500 by a majestic that had just started — the page then waited
// another three minutes about a camera that was already back.
async function handsBackWhenTheRebootWasMissedEntirely() {
	group('a reboot that happened between two polls is still noticed');
	const env = makeEnv({ uptime: 6 });          // camera answering, six seconds old
	await env.push(PROTECTED);
	await env.push(ERASE);
	await env.clock.advance(21000);              // quiet window, then the first poll
	check('asked the camera when it booted', env.metricsReads > 0);
	check('navigated without waiting out the blind fallback',
		env.replaced === '/cgi-bin/dashboard.cgi', 'replaced=' + env.replaced);
	// The fallback needs sixty-one of these. Counting them is what separates
	// "it left" from "it left three minutes late", which is the whole bug.
	check('on the first poll, not the sixty-first', env.pings <= 2, 'pings=' + env.pings);
}

// The same question asked of a camera that has NOT rebooted must answer no, or
// the watch would navigate away from a reset still erasing.
async function anUptimeOlderThanTheRunProvesNothing() {
	group('a camera that has been up for a day is not read as freshly rebooted');
	const env = makeEnv({ uptime: 86400 });
	await env.push(PROTECTED);
	await env.push(ERASE);
	await env.clock.advance(60000);
	check('asked, and was told', env.metricsReads > 0);
	check('did not navigate', env.replaced === null, 'replaced=' + env.replaced);
	check('still watching', watching(env), 'status was ' + JSON.stringify(env.status.textContent));
}

// A majestic too old to export node_*, or one holding an unclaimed camera behind
// a 401, says nothing about when it booted. That must degrade to the blind watch
// this page has always had rather than to a page that never leaves.
async function noUptimeFallsBackToTheBlindWatch() {
	group('a camera that will not say when it booted still gets handed back');
	const env = makeEnv();                       // /metrics answers 401
	await env.push(PROTECTED);
	await env.push(ERASE);
	await env.clock.advance(78000);
	check('not navigated an inch early', env.replaced === null, 'replaced=' + env.replaced);
	await env.clock.advance(200000);
	check('but the fallback still fires', env.replaced === '/cgi-bin/dashboard.cgi',
		'replaced=' + env.replaced);
	// And it must fire on time. Each ask is awaited inside a poll, so one that
	// times out on every one of the sixty the fallback is allowed would push a
	// three-and-a-half-minute wait towards eight — the accelerator making the
	// degraded case worse than it was before it existed.
	check('and it stopped asking after three refusals', env.metricsReads <= 3,
		'metricsReads=' + env.metricsReads);
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
	await handsBackWhenTheRebootWasMissedEntirely();
	await anUptimeOlderThanTheRunProvesNothing();
	await noUptimeFallsBackToTheBlindWatch();
	await cleanEndAfterFlashStartsTheWatch();
	await cleanEndBeforeFlashReportsIt();
	await rebootMarkerStillWins();
	await quietBeforeFlashIsIgnored();
	await timerStopsOnceWatching();
	await handsBackOnceTheCameraReturns();
	done();
})();
