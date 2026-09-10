// Reattaching the Firmware page to an upgrade that is already running.
//
// The failure this pins is a field one: a browser reloaded mid-flash used to
// land on the ordinary Update card with no sign that sysupgrade was erasing the
// flash, because the camera keeps a single upgrade session and answered the
// second connection with 503. The user cut power. So the page must, on load,
// notice an upgrade in progress (update.cgi sets data-active on #fw-inflight
// from the camera's upgrade-in-progress marker) and ATTACH to the running
// socket — showing the progress view and streaming the transcript — WITHOUT
// sending a start frame, because sending one begins an upgrade and one is
// already under way.
//
// It fails silently the same way the changelog does: attach or not, the page
// renders something plausible, and only a test can tell "attached to the live
// flash" from "offered a fresh one on top of it".
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const A = (f) => path.join(__dirname, '..', 'www', 'a', f);

function makeEl(id) {
	return {
		id: id, tagName: 'DIV', innerHTML: '', hidden: false, className: '',
		style: {}, dataset: {}, children: [], _text: '',
		get textContent() {
			return this._text + this.children.map((c) => c.textContent).join('');
		},
		set textContent(v) { this._text = String(v); this.children = []; },
		get firstChild() { return this.children[0] || null; },
		get firstElementChild() { return this.children[0] || null; },
		appendChild(c) { this.children.push(c); return c; },
		addEventListener() {}, removeEventListener() {},
		setAttribute() {}, getAttribute() { return null; },
		classList: { add() {}, remove() {}, contains() { return false; } },
	};
}

// Load update.js against a DOM whose #fw-inflight carries data-active=`active`.
// Returns the captured WebSocket (or null if none was opened) and the elements,
// so a test can drive onopen/onmessage and read what the page did.
function load(active) {
	const els = {};
	for (const id of ['fw-output', 'fw-installed', 'fw-status', 'fw-controls',
		'fw-progress', 'fw-progress-hl', 'fw-steps', 'fw-bar', 'fw-inflight']) {
		els[id] = makeEl(id);
	}
	els['fw-inflight'].dataset.active = active;
	// A step list, so paintPhases has rows to walk.
	for (const step of ['download', 'verify', 'kernel', 'rootfs', 'reboot']) {
		const li = makeEl('li'); li.dataset.step = step; els['fw-steps'].children.push(li);
	}

	const $ = (sel) => {
		const id = String(sel).replace(/^#/, '');
		return (id in els) ? els[id] : null;
	};

	let ws = null;
	function WebSocket() { ws = this; this.sent = []; }
	WebSocket.prototype.send = function (m) { this.sent.push(m); };

	// What reaches the transcript. update.js keeps the writer privately, so a
	// closed-over array is the only way to read it back.
	const termWrites = [];

	const ctx = {
		console, JSON, Object, Set, Date, Math, isNaN, isFinite, String, Number,
		Array, Promise, RegExp, Error, TextDecoder, Uint8Array, AbortController,
		// No-op timers: the run arms a quiet-watch interval and a reattach grace
		// timeout, and a unit test wants neither a live event loop nor a real
		// reload. Nothing here depends on them firing.
		setTimeout: () => 0, clearTimeout: () => {},
		setInterval: () => 0, clearInterval: () => {},
		window: {},
		performance: { now: () => 0 },
		location: { protocol: 'http:', host: 'cam', reload() { ctx.reloaded = true; } },
		WebSocket: WebSocket,
		DOMParser: function () {},
		document: {
			readyState: 'complete',
			addEventListener() {},
			getElementById(id) { return els[id] || null; },
			createElement() { return makeEl('made'); },
		},
		$: $,
		// Return the chunk unchanged, the way main.js's writer hands back the
		// ANSI-stripped text, and record it into the closed-over array.
		termWriter: () => ({ write(t) { termWrites.push(t); return t; },
			note() {}, commit() {} }),
		rawFetch: () => Promise.reject(new Error('not used here')),
		fetch: () => Promise.reject(new Error('not used here')),
	};
	ctx.window.fetch = ctx.fetch;
	vm.createContext(ctx);
	for (const f of ['fw-changes.js', 'update.js']) {
		vm.runInContext(fs.readFileSync(A(f), 'utf8'), ctx);
	}
	return { ws: ws, els: els, ctx: ctx, termWrites: termWrites };
}

(function () {
	group('a page loaded mid-flash attaches to the running upgrade');

	let r = load('1');
	check('the socket to /ws/upgrade is opened at load', !!r.ws);
	check('the progress view replaces the controls',
		r.els['fw-controls'].style.display === 'none' &&
		r.els['fw-progress'].style.display === '', JSON.stringify({
			controls: r.els['fw-controls'].style.display,
			progress: r.els['fw-progress'].style.display }));
	check('the headline names no build it never saw',
		r.els['fw-progress-hl'].textContent === 'Firmware upgrade in progress',
		r.els['fw-progress-hl'].textContent);
	check('and the status warns not to power off',
		/do not power off/i.test(r.els['fw-status'].textContent),
		r.els['fw-status'].textContent);

	// The load itself does not open the socket; onopen does the rest. The one
	// thing an attach must never do is send a frame — that would start a second
	// upgrade on a camera already flashing.
	r.ws.onopen();
	check('opening the socket sends no start frame', r.ws.sent.length === 0,
		JSON.stringify(r.ws.sent));

	// majestic replays the transcript from the top, led by its banner. Whatever
	// it sends must reach the pane.
	const banner = '\r\n*** Attached to a firmware upgrade already in progress. ' +
		'Do not power off the camera until it reboots. ***\r\n';
	r.ws.onmessage({ data: new TextEncoder().encode(banner) });
	check('the streamed banner reaches the transcript',
		r.termWrites.join('').indexOf('Do not power off') !== -1,
		r.termWrites.join(''));

	group('an older firmware that refuses the second connection keeps the warning');

	// The marker said an upgrade is in progress, but the socket will not open —
	// what an older single-session firmware does, answering the second
	// connection with 503. The flash is still running, so the safety warning
	// must survive rather than be replaced with "could not start the upgrade".
	r = load('1');
	r.ws.onerror();
	check('a failed attach does not report "could not start"',
		!/could not start/i.test(r.els['fw-status'].textContent),
		r.els['fw-status'].textContent);
	check('and the do-not-power-off warning is kept',
		/do not power off/i.test(r.els['fw-status'].textContent),
		r.els['fw-status'].textContent);

	group('a page loaded when nothing is flashing does not attach');

	r = load('');
	check('no socket is opened when the flag is unset', r.ws === null);

	done();
})();
