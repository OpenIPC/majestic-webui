// What the Update page does once the updater has handed PID 1 to a RAM root.
//
// majestic is gone from that moment, and port 80 belongs to the updater's own
// log follower, which answers every path with a 200 text/plain stream that does
// not end. Taken for the rebooted camera it reads as a finished upgrade while
// the flash is running, and nothing on the page looks wrong. Reaching it takes a
// real flash, so what the page must conclude from each answer is pinned here.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const A = (f) => path.join(__dirname, '..', 'www', 'a', f);

function makeEl(id) {
	const el = {
		id, innerHTML: '', hidden: false, className: '', style: {}, dataset: {},
		children: [], _text: '', attrs: {}, _cls: new Set(), _on: {},
		get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
		set textContent(v) { this._text = String(v); this.children = []; },
		get firstElementChild() { return this.children[0] || null; },
		appendChild(c) { this.children.push(c); return c; },
		addEventListener(ev, fn) { (this._on[ev] = this._on[ev] || []).push(fn); },
		setAttribute(k, v) { this.attrs[k] = v; },
	};
	el.classList = {
		add(...c) { c.forEach((x) => el._cls.add(x)); },
		remove(...c) { c.forEach((x) => el._cls.delete(x)); },
		contains(x) { return el._cls.has(x); },
	};
	return el;
}

const flush = () => new Promise((r) => setImmediate(r));

// One open follower connection: bytes pushed in by the test, ended by an abort
// the way a real fetch's body is.
function makeStream(signal) {
	const queue = [];
	let waiting = null, failed = false;
	const fail = () => { failed = true; if (waiting) { waiting.reject(new Error('aborted')); waiting = null; } };
	signal.addEventListener('abort', fail);
	return {
		push(text) {
			const item = { done: false, value: new TextEncoder().encode(text) };
			if (waiting) { waiting.resolve(item); waiting = null; } else queue.push(item);
		},
		end() {
			const item = { done: true };
			if (waiting) { waiting.resolve(item); waiting = null; } else queue.push(item);
		},
		reader: {
			read() {
				if (queue.length) return Promise.resolve(queue.shift());
				if (failed) return Promise.reject(new Error('aborted'));
				return new Promise((resolve, reject) => { waiting = { resolve, reject }; });
			},
		},
	};
}

// `answer` decides what port 80 says to each ping: 'down', 'camera', 'follower'.
function start(answer) {
	const els = {};
	for (const id of ['fw-output', 'fw-installed', 'fw-status', 'fw-controls',
		'fw-progress', 'fw-progress-hl', 'fw-steps', 'fw-meter', 'fw-meter-what',
		'fw-meter-pct', 'fw-bar', 'fw-inflight', 'fw-head', 'fw-install-github',
		'fw-install-upload', 'fw_kernel', 'fw_rootfs', 'fw_reset', 'fw_force']) {
		els[id] = makeEl(id);
	}
	els['fw-meter'].hidden = true;
	els['fw-bar'].appendChild(makeEl('inner'));
	for (const step of ['download', 'verify', 'kernel', 'rootfs', 'overlay', 'reboot']) {
		const li = makeEl('li');
		li.dataset.step = step;
		els['fw-steps'].children.push(li);
	}
	els['fw_kernel'].checked = true;
	els['fw_rootfs'].checked = true;
	els['fw-inflight'].dataset.active = '0';
	els['fw-head'].dataset = { fwState: 'available', fwLatest: 'nightly-1', mjVersion: '', socVendor: 'hisilicon' };
	els['fw-installed'].textContent = 'old';

	let now = 0, seq = 0;
	const timers = new Map();
	const env = { pings: [], versionReads: 0, readers: 0, streams: [], written: '', notes: [], location: {} };
	let ws = null;
	function WebSocket() { ws = this; this.sent = []; }
	WebSocket.prototype.send = function (m) { this.sent.push(m); };

	const ctx = {
		console, JSON, Object, Set, Date, Math, isNaN, isFinite, String, Number,
		Array, Promise, RegExp, Error, TextDecoder, TextEncoder, Uint8Array, AbortController,
		setTimeout: (fn, ms) => { timers.set(++seq, { fn, due: now + (ms || 0) }); return seq; },
		clearTimeout: (id) => { timers.delete(id); },
		setInterval: () => 0, clearInterval: () => {},
		window: {},
		performance: { now: () => now },
		location: env.location,
		WebSocket,
		DOMParser: function () {},
		document: {
			readyState: 'complete', addEventListener() {},
			getElementById: (id) => els[id] || null,
			createElement: () => makeEl('made'),
		},
		$: (sel) => els[String(sel).replace(/^#/, '')] || null,
		termWriter: () => ({
			write: (t) => { env.written += t; return t; },
			commit() {},
			note: (s) => env.notes.push(s),
		}),
		rawFetch: (url, init) => {
			const u = String(url);
			if (u.indexOf('/metrics') !== -1) return Promise.reject(new Error('no metrics here'));
			if (u.indexOf('update.cgi') !== -1) {
				env.versionReads++;
				return Promise.resolve({ ok: false, status: 401 });
			}
			const ping = { signal: init.signal, what: answer(env.pings.length) };
			env.pings.push(ping);
			if (ping.what === 'down') return Promise.reject(new Error('refused'));
			if (ping.what === 'camera') {
				return Promise.resolve({ ok: false, status: 401, headers: { get: () => 'text/html; charset=UTF-8' } });
			}
			const stream = makeStream(init.signal);
			env.streams.push(stream);
			return Promise.resolve({
				ok: true, status: 200,
				headers: { get: () => 'text/plain; charset=utf-8' },
				body: { getReader: () => { env.readers++; return stream.reader; } },
			});
		},
		stopHeartbeat() {}, startHeartbeat() {},
	};
	ctx.window.fetch = () => Promise.reject(new Error('not used'));
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(A('fw-changes.js'), 'utf8'), ctx);
	vm.runInContext(fs.readFileSync(A('update.js'), 'utf8'), ctx);
	els['fw-controls']._on.click[0]({ target: { closest: () => els['fw-install-github'] }, preventDefault() {} });
	ws.onopen(ws);

	const r = {
		els, env,
		feed(...c) { for (const x of c) ws.onmessage({ data: new TextEncoder().encode(x) }); return r; },
		close() { ws.onclose(); return r; },
		status: () => els['fw-status'].textContent,
		cls: () => els['fw-status'].className,
		step(name) {
			const li = els['fw-steps'].children.find((x) => x.dataset.step === name);
			return li.classList.contains('mj-step-done') ? 'done' : li.classList.contains('mj-step-now') ? 'now' : '';
		},
		async settle() { for (let i = 0; i < 8; i++) await flush(); return r; },
		// Runs whatever falls due, in order, letting promises settle between.
		async advance(ms) {
			const end = now + ms;
			for (;;) {
				await r.settle();
				const next = [...timers.entries()].filter(([, t]) => t.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
				if (!next) break;
				timers.delete(next[0]);
				now = Math.max(now, next[1].due);
				next[1].fn();
			}
			now = end;
			await r.settle();
			return r;
		},
		async push(text, n = 0) { env.streams[n].push(text); await r.settle(); return r; },
		async end(n = 0) { env.streams[n].end(); await r.settle(); return r; },
	};
	return r;
}

const HANDOFF = '\nProtected: flashing continues even if this terminal disconnects.\n' +
	'\nHanding PID 1 over to the RAM root.\nSSH, the WebUI and every other login end here\n';
const LOG_LOST = '\nShort of memory by 1831 KB\nThis page loses the log here. If the upgrade goes ahead\n';
const FLASH = 'sysupgrade 1.0 on cam: flashing from RAM\nFlashing from RAM (pid 1)\n';

const camera = (n) => (i) => (i < n ? 'follower' : 'camera');

(async () => {
	group('the follower is not the camera');
	{
		const r = start(camera(99)).feed(HANDOFF).close();
		await r.settle();
		check('its first answer is read as a stream', r.env.readers === 1);
		check('and is reported as the flash, not the camera',
			/Writing the flash from RAM/.test(r.status()) && !/Camera is back/.test(r.status()), r.status());
		check('nothing asked the follower for a version', r.env.versionReads === 0);
		await r.advance(12000);
		check('one connection while it streams, not one per tick', r.env.pings.length === 1, 'pings=' + r.env.pings.length);
		check('that connection is left open', !r.env.pings[0].signal.aborted);
	}

	group('the log it carries drives the page');
	{
		const r = start(camera(99)).feed(LOG_LOST).close();
		await r.settle();
		await r.push(FLASH + 'Kernel\nErasing block: 1/4 (25%)\nErasing block: 2/4 (50%)\nKernel updated to x\n');
		check('a run that never saw the download end shows it done', r.step('download') === 'done', r.step('download'));
		check('the image check is done', r.step('verify') === 'done', r.step('verify'));
		check('the kernel is done', r.step('kernel') === 'done', r.step('kernel'));
		check('the rootfs is what is current', r.step('rootfs') === 'now', r.step('rootfs'));
		check('the meter names the partition',
			r.els['fw-meter-what'].textContent === 'Erasing kernel', r.els['fw-meter-what'].textContent);
		check('and shows the last reading', r.els['fw-meter-pct'].textContent === '50%', r.els['fw-meter-pct'].textContent);
	}

	group('meter redraws stay on one line');
	{
		const r = start(camera(99)).feed(HANDOFF).close();
		await r.settle();
		r.env.written = '';
		await r.push('Erasing blo');
		await r.push('ck: 1/4 (25%)\nErasing block: 2/4 (50%)\nWriting kb: 1/8 (12%)\nKernel updated\n');
		check('a redraw returns the cursor, even split across frames',
			r.env.written === '\rErasing block: 1/4 (25%)\rErasing block: 2/4 (50%)\nWriting kb: 1/8 (12%)\nKernel updated\n',
			JSON.stringify(r.env.written));
	}

	group('ending the stream');
	{
		const r = start(camera(1)).feed(HANDOFF).close();
		await r.settle();
		await r.push(FLASH + '\nUnconditional reboot\n');
		check('the reboot announcement closes the connection', r.env.pings[0].signal.aborted);
		check('and says so', /Camera is rebooting/.test(r.status()), r.status());
		await r.advance(4000);
		check('the real camera is what ends the watch', r.env.versionReads === 1, 'reads=' + r.env.versionReads);
	}
	{
		// The split NOR layout writes its whole image in silence for minutes.
		const r = start(camera(99)).feed(HANDOFF).close();
		await r.settle();
		await r.advance(150000);
		check('a silent write leaves the stream open', !r.env.pings[0].signal.aborted);
		check('and is still reported as the flash', /Writing the flash from RAM/.test(r.status()), r.status());
		check('it is asked about, but not every tick',
			r.env.pings.length > 2 && r.env.pings.length < 15, 'pings=' + r.env.pings.length);
		check('each such question is closed', r.env.pings.slice(1).every((p) => p.signal.aborted));
		check('with no second stream', r.env.readers === 1, 'readers=' + r.env.readers);
		check('and no talk of the camera being back', r.env.versionReads === 0, 'reads=' + r.env.versionReads);
		await r.push('Settings staged at 0xc00000 for the first boot\nFirmware updated\n');
		check('so the end of the log still arrives', r.step('kernel') === 'done' && r.step('rootfs') === 'done',
			r.step('kernel') + '/' + r.step('rootfs'));
	}
	{
		// A reboot that was never announced: no FIN, so only port 80 can say.
		const r = start((i) => (i === 0 ? 'follower' : i === 1 ? 'down' : 'camera')).feed(HANDOFF).close();
		await r.settle();
		await r.advance(16000);
		check('the follower gone closes the stream', r.env.pings[0].signal.aborted);
		check('without claiming a reboot it did not see',
			/flash log stopped/.test(r.status()) && /Do not power off/.test(r.status()), r.status());
		await r.advance(4000);
		check('and the camera answering ends the watch', r.env.versionReads === 1, 'reads=' + r.env.versionReads);
	}

	group('a stream that stops mid-line');
	{
		const r = start(camera(99)).feed(HANDOFF).close();
		await r.settle();
		await r.push('Firmware updated\n\nUnconditional reboot');
		await r.end();
		check('its last words still count', /Camera is rebooting/.test(r.status()), r.status());
		check('and are in the log', /Unconditional reboot/.test(r.env.written), JSON.stringify(r.env.written));
	}

	group('a connection lost while the follower is still there');
	{
		const r = start(camera(99)).feed(HANDOFF).close();
		await r.settle();
		r.env.written = '';
		await r.push('one\ntwo\nhalf');
		await r.end();
		await r.advance(3000);
		check('the log is opened again', r.env.readers === 2, 'readers=' + r.env.readers);
		await r.push('one\n', 1);
		await r.push('two\nhalf and the rest\nFirmware updated\n', 1);
		check('and carries on where it stopped, with nothing repeated',
			r.env.written === 'one\ntwo\nhalf and the rest\nFirmware updated\n', JSON.stringify(r.env.written));
		check('while the first connection is closed', r.env.pings[0].signal.aborted);
	}
	{
		// Every connection ending at once must not keep the watch alive forever.
		const r = start(camera(9999)).feed(HANDOFF).close();
		await r.settle();
		for (let i = 0; i < 210 && !/has not returned/.test(r.status()); i++) {
			await r.end(r.env.streams.length - 1);
			await r.advance(3000);
		}
		check('a connection that keeps dropping still ends the watch',
			/has not returned/.test(r.status()), r.status());
	}

	group('the watch ending while the log is open');
	{
		const r = start(camera(9999)).feed(HANDOFF).close();
		await r.settle();
		await r.advance(3200000);
		check('giving up says so', /has not returned/.test(r.status()), r.status());
		check('and is not overwritten by the stream closing', /alert-danger/.test(r.cls()), r.cls());
		check('and leaves no connection open', r.env.pings.every((p) => p.signal.aborted));
	}

	group('the meter under a flash it did not measure');
	{
		const r = start(camera(99)).feed('12%\n', HANDOFF);
		check('the download reading is up before the hand-off', !r.els['fw-meter'].hidden);
		r.close();
		await r.settle();
		check('and gone once the log is the flash', r.els['fw-meter'].hidden);
	}

	group('every ping is closed once it has answered');
	{
		const r = start((i) => (i === 0 ? 'down' : 'camera')).feed(HANDOFF).close();
		await r.advance(4000);
		check('the camera answering leaves no connection open', r.env.pings[1].signal.aborted);
		check('and that is what ends the watch', r.env.versionReads === 1, 'reads=' + r.env.versionReads);
	}

	group('what the page says with no log to read');
	{
		const r = start(() => 'down').feed(LOG_LOST).close();
		await r.advance(4000);
		check('majestic stopped for memory: says why the log ended',
			/free memory/.test(r.status()) && /do not power off/.test(r.status()), r.status());
		check('and does not claim a reboot yet', !/rebooting/i.test(r.status()), r.status());
		check('the step stays on the download', r.step('download') === 'now', r.step('download'));
	}
	{
		const r = start(() => 'down').feed(HANDOFF).close();
		await r.advance(4000);
		check('no follower in reach: says progress cannot be seen from here',
			/cannot report progress/.test(r.status()) && /do not power off/.test(r.status()), r.status());
	}
	{
		// Measured: the kill can reach majestic before "Handing PID 1" reaches here.
		const r = start(() => 'down').feed('\nMoving the flash phase into RAM\n').close();
		await r.advance(4000);
		check('the move into RAM is enough to say so',
			/cannot report progress/.test(r.status()), r.status());
	}
	{
		// A run that pivots without handing off keeps its socket to the end.
		const r = start(() => 'down').feed('\nMoving the flash phase into RAM\n', 'Kernel updated\n\nUnconditional reboot\n').close();
		await r.advance(4000);
		check('and an announced reboot still reads as one',
			/Camera is rebooting/.test(r.status()), r.status());
	}
	{
		const r = start(() => 'down').feed('\nProtected: flashing continues even if this terminal disconnects.\n').close();
		await r.advance(4000);
		check('a socket that dies mid-flash with no hand-off keeps the warning',
			/rebooting/i.test(r.status()), r.status());
		check('as a warning', /alert-warning/.test(r.cls()), r.cls());
	}

	group('PID 1 did not take the hand-off');
	{
		const r = start((i) => (i < 1 ? 'down' : 'camera')).feed(HANDOFF,
			'PID 1 did not hand over; rebooting (nothing was flashed)\n');
		await r.settle();
		check('says nothing was written, before the reboot',
			/Nothing was written/.test(r.status()), r.status());
		check('and does not mark the writes done', r.step('kernel') !== 'done', r.step('kernel'));
		r.close();
		await r.advance(4000);
		check('reports it as a failure', /alert-danger/.test(r.cls()), r.cls());
		check('in the updater\'s terms', /could not hand over/.test(r.status()) && /nothing was written/.test(r.status()), r.status());
		check('without going to the version check that needs a sign-in', r.env.versionReads === 0);
		check('leaving the page on the log', r.env.location.href === undefined, r.env.location.href);
		check('and the transcript does not say the flash went on',
			!r.env.notes.some((n) => /carries on/.test(n)), JSON.stringify(r.env.notes));
	}

	done();
})();
