// How the Firmware page's upgrade run ENDS, and what it is entitled to say
// about it.
//
// Every ending here fails silently, and each one fails by sounding certain. A
// socket that closes is not a camera that went anywhere, but the page wrote
// "--- connection to the camera ended here; it is rebooting ---" whatever had
// happened, and then waited out the reboot it had just announced — eight
// minutes — before allowing that nothing came. On the camera in issue #474 that
// note WAS the transcript: an upload line, a sentence claiming a reboot, and a
// camera that never moved. Nothing on the page contradicted it, and the one
// thing that could have — the camera's own "Upgrade did not complete. Video has
// been restarted; the camera is unchanged." — was arriving on a text frame the
// page rendered as zero bytes until #477.
//
// Reproducing any of it needs a camera that refuses an upgrade: a full /tmp, a
// missing updater, an image it will not take. Three states have to be told
// apart and all of them look like silence — the camera has said it is over, the
// camera is mid-flash and cannot talk because it is overwriting the program
// that was talking, and the socket simply died. The first is a fact, the second
// must never be interrupted, and the third is not evidence of anything.
//
// So what is pinned here is the line between what was observed and what was
// assumed. The note claims a reboot only with a flash marker or the
// announcement latched behind it; the camera's own endings stop the run at once
// and say why; a refusal it answers before the updater is spawned does the same,
// except on a reattached run, where being refused a second view of a flash is
// not news about the flash. And the case that must never regress: a socket that
// dies mid-flash still gets the full reboot watch and keeps "do not power off",
// because there the flash may genuinely be running and the cost of standing the
// reader down is a camera powered off mid-write.
//
// The clock-driven half of this machinery — how long the watch runs and what it
// concludes — is pinned against its sibling in reset-watch.test.js. What is here
// is the decision taken before any clock starts.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const A = (f) => path.join(__dirname, '..', 'www', 'a', f);

function makeEl(id) {
	const el = {
		id: id, tagName: 'DIV', innerHTML: '', hidden: false, className: '',
		style: {}, dataset: {}, children: [], _text: '', attrs: {},
		_cls: new Set(), _on: {},
		get textContent() {
			return this._text + this.children.map((c) => c.textContent).join('');
		},
		set textContent(v) { this._text = String(v); this.children = []; },
		get firstChild() { return this.children[0] || null; },
		get firstElementChild() { return this.children[0] || null; },
		appendChild(c) { this.children.push(c); return c; },
		addEventListener(ev, fn) { (this._on[ev] = this._on[ev] || []).push(fn); },
		removeEventListener() {},
		setAttribute(k, v) { this.attrs[k] = v; },
		getAttribute(k) { return (k in this.attrs) ? this.attrs[k] : null; },
	};
	el.classList = {
		add(...c) { c.forEach((x) => el._cls.add(x)); },
		remove(...c) { c.forEach((x) => el._cls.delete(x)); },
		contains(x) { return el._cls.has(x); },
	};
	return el;
}

// The body is update-meter.test.js's harness — the only one that drives a REAL
// run from the Install button through params()/showProgress()/resetRunState(),
// which is what makes sawFlash, noop, reattached and over take their genuine
// values. Three things come from reset-watch.test.js instead: a termWriter that
// KEEPS the notes (update-meter's discards them, and the note is half the
// subject here), the heartbeat stubs, and a counting rawFetch — because "did
// the watch start?" is the other half, and pollBack's first ping goes out
// synchronously, so a counter read straight after the close is a deterministic
// answer.
function start(opts) {
	opts = opts || {};
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
	els['fw_reset'].checked = false;
	els['fw_force'].checked = false;
	els['fw-inflight'].dataset.active = opts.attach ? '1' : '0';
	els['fw-head'].dataset = {
		fwState: 'available', fwLatest: 'nightly-00000000-0000000',
		mjVersion: '', socVendor: 'hisilicon',
	};

	const env = { notes: [], pings: 0, heartbeatResumed: 0 };
	let ws = null;
	function WebSocket() { ws = this; this.sent = []; }
	WebSocket.prototype.send = function (m) { this.sent.push(m); };

	const ctx = {
		console, JSON, Object, Set, Date, Math, isNaN, isFinite, String, Number,
		Array, Promise, RegExp, Error, TextDecoder, TextEncoder, Uint8Array,
		AbortController,
		setTimeout: () => 0, clearTimeout: () => {},
		setInterval: () => 0, clearInterval: () => {},
		window: {},
		performance: { now: () => 0 },
		location: { protocol: 'http:', host: 'cam', reload() {} },
		WebSocket: WebSocket,
		DOMParser: function () {},
		document: {
			readyState: 'complete',
			addEventListener() {},
			getElementById(id) { return els[id] || null; },
			createElement() { return makeEl('made'); },
		},
		$: (sel) => {
			const id = String(sel).replace(/^#/, '');
			return (id in els) ? els[id] : null;
		},
		termWriter: () => ({
			write: (t) => t,
			commit() {},
			note: (s) => env.notes.push(s),
		}),
		// Every fetch this file can provoke is pollBack's. Counting them is how a
		// test says "the page decided to wait for a reboot" without a clock.
		rawFetch: (url) => {
			if (String(url).indexOf('/metrics') === -1) env.pings++;
			return Promise.reject(new Error('camera not answering in this test'));
		},
		fetch: () => Promise.reject(new Error('not used here')),
		stopHeartbeat: () => {},
		startHeartbeat: () => { env.heartbeatResumed++; },
	};
	ctx.window.fetch = ctx.fetch;
	vm.createContext(ctx);
	for (const f of ['fw-changes.js', 'update.js']) {
		vm.runInContext(fs.readFileSync(A(f), 'utf8'), ctx);
	}
	if (opts.attach) {
		// attachToRunning() already opened the socket at load; it sends no frame.
		ws.onopen(ws);
	} else {
		els['fw-install-github']._on.click[0]({ preventDefault() {} });
		ws.onopen(ws);
	}

	const r = { els: els, ws: ws, env: env };
	// A binary frame, which is how the transcript arrives.
	r.feed = function (...chunks) {
		for (const c of chunks) ws.onmessage({ data: new TextEncoder().encode(c) });
		return r;
	};
	// A TEXT frame, which is how the camera's own sentences arrive.
	r.say = function (...lines) {
		for (const s of lines) ws.onmessage({ data: s });
		return r;
	};
	r.close = function () { ws.onclose(); return r; };
	r.status = () => els['fw-status'].textContent;
	r.statusCls = () => els['fw-status'].className;
	r.note = () => env.notes.join('\n');
	return r;
}

const PROTECTED = '\nProtected: flashing continues even if this terminal disconnects.\n';
const REBOOT = '\nUnconditional reboot\n';
const INCOMPLETE = '\r\nUpgrade did not complete. Video has been restarted; the camera is unchanged.\r\n';
const VIDEO_LOST = '\r\nUpgrade did not complete, and video could not be restarted. Reboot the camera.\r\n';

group('a socket that closes says only that it closed');

// #474's transcript, in full: the WebUI's own upload line, and then nothing.
{
	const r = start().feed('Uploaded openipc.ssc337de-nor-lite.tgz (6970205 bytes)\n').close();
	check('no reboot is claimed when none was observed',
		!/rebooting/.test(r.note()), r.note());
	check('the note still marks where the stream ended',
		/connection to the camera ended here/.test(r.note()), r.note());
}

{
	const r = start().feed(PROTECTED).close();
	check('a flash marker earns "it is rebooting"',
		/it is rebooting/.test(r.note()), r.note());
}

{
	const r = start().feed(REBOOT).close();
	check('the reboot announcement earns it too',
		/it is rebooting/.test(r.note()), r.note());
}

// The latch. A live rebootMarker.test(recent) forgets this, because `recent` is
// a 512-character rolling window and the announcement has scrolled out of it.
{
	const r = start().feed(REBOOT, 'x'.repeat(600)).close();
	check('an announcement is not forgotten 600 characters later',
		/it is rebooting/.test(r.note()), r.note());
}

// The case that must never regress.
{
	const r = start().feed(PROTECTED, 'Erasing block: 12/64 (18%)\r').close();
	check('a socket that dies mid-flash still watches for the reboot',
		r.env.pings > 0, 'pings=' + r.env.pings);
	check('and keeps the warning',
		/do not power off/i.test(r.status()), r.status());
	check('and does not stand the reader down',
		r.env.heartbeatResumed === 0, 'resumed=' + r.env.heartbeatResumed);
}

// No evidence either way: the wait is NOT shortened, but it stops asserting.
{
	const r = start().feed('Downloading...\n').close();
	check('with no flash reported the wait still runs',
		r.env.pings > 0, 'pings=' + r.env.pings);
	check('the warning stays',
		/do not power off/i.test(r.status()), r.status());
	check('but a reboot is no longer asserted',
		!/waiting for the camera to reboot/i.test(r.status()), r.status());
}

group('the camera\'s own ending is the end of the run');

{
	const r = start().feed('Downloading...\n').say(INCOMPLETE);
	check('the run ends at once', r.env.pings === 0, 'pings=' + r.env.pings);
	check('the reader is told what happened',
		/did not complete/.test(r.status()), r.status());
	check('and that the camera is unhurt',
		/still on the firmware it started with/.test(r.status()), r.status());
	check('no "do not power off" over a camera that is running',
		!/power off/i.test(r.status()), r.status());
	check('the page is handed back', r.env.heartbeatResumed === 1,
		'resumed=' + r.env.heartbeatResumed);
	r.close();
	check('and nothing is written under the camera\'s last word',
		r.env.notes.length === 0, JSON.stringify(r.env.notes));
}

{
	const r = start().feed('Downloading...\n').say(VIDEO_LOST);
	check('a camera left without video says so',
		/could not restart its video/.test(r.status()), r.status());
	check('and is told what to do about it',
		/Reboot the camera/.test(r.status()), r.status());
}

// The gate: nothing the camera says is acted on once a write is known to have
// started. It can be wrong about a detached child; the flash cannot be undone.
{
	const r = start().feed(PROTECTED).say(INCOMPLETE);
	check('mid-flash, the camera\'s ending does not stand the reader down',
		/do not power off/i.test(r.status()), r.status());
	check('mid-flash, the heartbeat stays stopped',
		r.env.heartbeatResumed === 0, 'resumed=' + r.env.heartbeatResumed);
	r.close();
	check('mid-flash, the reboot watch still runs',
		r.env.pings > 0, 'pings=' + r.env.pings);
}

{
	const r = start().feed('  5.0%\r 40.0%\r').say(INCOMPLETE);
	check('the meter is taken down with the run', !!r.els['fw-meter'].hidden, 'still shown');
}

group('a refusal is the whole of the output');

for (const line of ['ERROR: invalid upgrade parameters\r\n',
	'ERROR: cannot start sysupgrade\r\n',
	'ERROR: cannot stream upgrade log\r\n',
	'ERROR: cannot watch the upgrade\r\n']) {
	const r = start().say(line);
	check('"' + line.trim() + '" ends the run',
		r.env.pings === 0 && r.env.heartbeatResumed === 1,
		'pings=' + r.env.pings + ' resumed=' + r.env.heartbeatResumed);
	check('  and names the camera as the one that refused',
		/camera could not start the upgrade/.test(r.status()), r.status());
}

// A closed list, not "any line beginning ERROR:". The transcript is other
// people's tool output.
{
	const r = start().say('ERROR: something else entirely\r\n');
	check('an unknown ERROR: line does not end a run',
		r.env.heartbeatResumed === 0, 'resumed=' + r.env.heartbeatResumed);
}

{
	const r = start().feed('sh: ERROR: cannot start sysupgrade\n');
	check('a refusal quoted mid-line does not end a run',
		r.env.heartbeatResumed === 0, 'resumed=' + r.env.heartbeatResumed);
}

// The carve-out. update.cgi found the upgrade-in-progress marker before this
// page was drawn, so a refusal means only that we were not given a second view
// of a flash that is still running.
{
	const r = start({ attach: true }).say('ERROR: cannot watch the upgrade\r\n');
	check('a refusal on a reattached run keeps the warning',
		!/could not start the upgrade/.test(r.status()), r.status());
	check('and does not stand the reader down',
		r.env.heartbeatResumed === 0, 'resumed=' + r.env.heartbeatResumed);
}

{
	const r = start({ attach: true }).say(INCOMPLETE);
	check('but the camera\'s own ending still ends a reattached run',
		/did not complete/.test(r.status()), r.status());
}

group('the ending that already worked still works');

{
	const r = start().feed('\nCannot retrieve https://example.invalid/i.tgz Aborting.\n');
	check('a pre-flash abort still ends the run at once',
		r.env.pings === 0 && r.env.heartbeatResumed === 1,
		'pings=' + r.env.pings + ' resumed=' + r.env.heartbeatResumed);
	check('with the sentence it always had',
		/The upgrade was aborted/.test(r.status()), r.status());
	r.close();
	check('and no note under it', r.env.notes.length === 0, JSON.stringify(r.env.notes));
}

done();
