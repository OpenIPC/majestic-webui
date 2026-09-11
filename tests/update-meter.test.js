// The Firmware page's progress meter — which pass the bar is measuring, and
// what number it is showing for it.
//
// The sibling file update-page.test.js says the phase strip is deliberately not
// pinned, because it fails in front of somebody who is watching it with the
// camera's own transcript underneath saying what happened. That is still true
// of the strip, and it is why a bar that simply never appears is not what this
// file is about: the reading it failed to show is one card down, on screen, in
// the log.
//
// What is pinned here is the other half, which fails the opposite way. An
// upgrade prints a percentage from zero seven times — a download, then an
// erase, a write and a read-back over each partition — and every one of those
// readings is a bare number that says nothing about what it is a percentage OF.
// The partition is carried across from a heading that scrolled past seconds
// ago. Get that carry wrong by one reading and the page says "Erasing kernel"
// while the rootfs is being erased: a sentence that reads perfectly, agrees
// with the bar, and is wrong. Nothing on the page contradicts it, and reaching
// the moment it happens needs a camera in the middle of a flash — which is the
// one thing a recorded exchange can hold still.
//
// So the cases below are the ones that produce a confident wrong answer rather
// than an absent one: a frame that carries the end of one partition's pass and
// the next partition's heading together, a frame the socket split through the
// middle of a word, a download number read after the phase that owns it has
// closed, and the two meter formats being told apart from each other and from
// an ordinary percentage in prose. Plus the two endings, because "the camera
// stopped talking" and "the camera finished" must not look alike.
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

// Load the page and start an upgrade through the button, so the run goes
// through the same params()/showProgress()/resetRunState() path a person does —
// the step strip's visibility depends on the switches, and so does whether the
// overlay pass has a row to light up.
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
	els['fw_reset'].checked = !!opts.reset;
	els['fw_force'].checked = false;
	els['fw-inflight'].dataset.active = '0';
	els['fw-head'].dataset = {
		fwState: 'available', fwLatest: 'nightly-00000000-0000000',
		mjVersion: '', socVendor: 'hisilicon',
	};

	let ws = null;
	function WebSocket() { ws = this; this.sent = []; }
	WebSocket.prototype.send = function (m) { this.sent.push(m); };

	const ctx = {
		console, JSON, Object, Set, Date, Math, isNaN, isFinite, String, Number,
		Array, Promise, RegExp, Error, TextDecoder, TextEncoder, Uint8Array,
		AbortController,
		// No-op timers: the run arms a quiet-watch interval this file never wants
		// to fire, and nothing here depends on a real event loop.
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
		// main.js's writer hands back the chunk with ANSI removed and nothing else
		// done to it, which is what the page matches against. The transcripts below
		// are written without escapes, so returning the chunk unchanged is exactly
		// that.
		termWriter: () => ({ write: (t) => t, note() {}, commit() {} }),
		rawFetch: () => Promise.reject(new Error('not used here')),
		fetch: () => Promise.reject(new Error('not used here')),
	};
	ctx.window.fetch = ctx.fetch;
	vm.createContext(ctx);
	for (const f of ['fw-changes.js', 'update.js']) {
		vm.runInContext(fs.readFileSync(A(f), 'utf8'), ctx);
	}
	els['fw-install-github']._on.click[0]({ preventDefault() {} });
	ws.onopen(ws);

	const r = { els: els, ws: ws };
	// One frame off the socket, exactly as majestic delivers it.
	r.feed = function (...chunks) {
		for (const c of chunks) {
			ws.onmessage({ data: new TextEncoder().encode(c) });
		}
		return r;
	};
	r.meter = function () {
		const box = els['fw-meter'];
		const bar = els['fw-bar'];
		return {
			hidden: !!box.hidden,
			what: els['fw-meter-what'].textContent,
			pct: els['fw-meter-pct'].textContent,
			width: bar.firstElementChild.style.width,
			aria: bar.getAttribute('aria-valuenow'),
			stale: box._cls.has('mj-meter-stale'),
		};
	};
	r.steps = function () {
		return els['fw-steps'].children
			.filter((li) => li.style.display !== 'none')
			.map((li) => li.dataset.step);
	};
	return r;
}

// The shape of a run, written out rather than captured: headings on lines of
// their own, meters redrawn with a bare \r, the prose the updater puts between
// them. Sizes are round numbers chosen to make the arithmetic readable.
const DOWNLOAD = '\nFirmware\nDownload from https://example.invalid/image.tgz\n';
const UNPACKED = '\nReceived and unpacked\n';
const PROTECTED = '\nProtected: flashing continues even if this terminal disconnects.\n';
const KERNEL = '\nKernel\nUpdate kernel from /tmp/uImage\n';
const ROOTFS = '\nRootFS\nUpdate rootfs from /tmp/rootfs.squashfs\n';
const OVERLAY = '\nOverlayFS\nErase overlay partition\n';
const REBOOT = '\nUnconditional reboot\n';
const erase = (n, t) => '\rErasing block: ' + n + '/' + t + ' (' +
	Math.floor(n * 100 / t) + '%) ';
const write = (n, t) => '\rWriting kb: ' + n + '/' + t + ' (' +
	Math.floor(n * 100 / t) + '%) ';
const verify = (n, t) => '\rVerifying kb: ' + n + '/' + t + ' (' +
	Math.floor(n * 100 / t) + '%) ';
const wipe = (pct) => '\rErasing 64 Kibyte @ 100000 - ' + pct + '% complete.';

(function () {
	group('the bar says what its number is a percentage of');

	let r = start();
	check('nothing is measured before the download starts', r.meter().hidden);

	r.feed(DOWNLOAD, '###   12.0%');
	check('the download names itself', r.meter().what === 'Downloading',
		r.meter().what);
	check('and shows the number the downloader printed',
		r.meter().pct === '12%' && r.meter().width === '12%' &&
		r.meter().aria === '12', JSON.stringify(r.meter()));

	// The frame that carries the download's last redraw carries the line that
	// ends the download phase with it. Reading one and not the other is what
	// left the bar short of the end it had actually reached.
	r.feed('###########  100.0%' + UNPACKED);
	check('the download is read up to 100% in the frame that also closes it',
		r.meter().what === 'Downloading' && r.meter().pct === '100%',
		JSON.stringify(r.meter()));

	r.feed(PROTECTED, KERNEL, erase(8, 32));
	check('the first flash pass names the pass and the partition',
		r.meter().what === 'Erasing kernel', r.meter().what);
	check('and carries that partition into the next pass',
		r.feed(erase(32, 32), write(1000, 2000)).meter().what === 'Writing kernel',
		r.meter().what);
	check('and into the read-back after it',
		r.feed(verify(1500, 2000)).meter().what === 'Verifying kernel',
		r.meter().what);
	check('the read-back is the camera\'s own number, not the write\'s',
		r.meter().pct === '75%', JSON.stringify(r.meter()));

	group('a heading and the reading above it are not applied the other way round');

	// The end of one partition's last pass, the line that closes it, and the
	// next partition's heading all in one frame — which is how they arrive.
	// Labelling that last reading with the partition that has not started is the
	// wrong answer this whole ordering rule exists to stop.
	r.feed(verify(2000, 2000) + '\nKernel updated to 0\n' + ROOTFS);
	check('the closing reading keeps the partition it belongs to',
		r.meter().what === 'Verifying kernel' && r.meter().pct === '100%',
		JSON.stringify(r.meter()));
	check('and the next reading is the one that takes the new partition',
		r.feed(erase(4, 80)).meter().what === 'Erasing rootfs', r.meter().what);

	group('a line the socket split in two is rejoined');

	// Measured frames have cut a meter through the middle of a word. Matching
	// each frame alone drops the reading; matching the file's own 512-character
	// history instead would reach back far enough to find the previous
	// partition's numbers.
	r = start();
	r.feed(DOWNLOAD, '## 100.0%' + UNPACKED, PROTECTED, KERNEL);
	r.feed('\rVerif', 'ying kb: 16/32 (50%) ');
	check('the halves are read as one reading',
		r.meter().what === 'Verifying kernel' && r.meter().pct === '50%',
		JSON.stringify(r.meter()));

	group('the meter formats are told apart, and from prose');

	// A percentage in a sentence is not a meter. Before any partition is
	// announced it can only be the downloader's; after one, only a reading in a
	// recognised format may move the bar.
	r = start();
	r.feed(DOWNLOAD, '## 50.0%' + UNPACKED, PROTECTED, KERNEL, erase(16, 32));
	const before = r.meter();
	r.feed('\nSome line that happens to mention 99% of something\n');
	check('prose with a percentage in it does not move the bar',
		r.meter().what === before.what && r.meter().pct === before.pct,
		JSON.stringify(r.meter()));

	// The overlay wipe uses a different tool with a different line, and the
	// partition it belongs to is named in the page's own words.
	r = start({ reset: true });
	r.feed(DOWNLOAD, '## 100.0%' + UNPACKED, PROTECTED, KERNEL, erase(32, 32),
		write(2000, 2000), verify(2000, 2000) + '\nKernel updated to 0\n' + ROOTFS,
		erase(80, 80), write(5000, 5000), verify(5000, 5000) +
		'\nRootFS updated to 0\n' + OVERLAY);
	r.feed(wipe(61));
	check('the overlay wipe\'s own meter is read', r.meter().pct === '61%' &&
		r.meter().what === 'Erasing the overlay', JSON.stringify(r.meter()));
	check('and the run that asked for it has a step for it',
		r.steps().indexOf('overlay') !== -1, r.steps().join(' '));
	check('a run that did not ask has none',
		start().steps().indexOf('overlay') === -1, start().steps().join(' '));

	group('the two endings do not look alike');

	// Announced: every pass is behind us, so there is no measurement left to
	// show and the bar goes.
	r.feed(REBOOT);
	check('a reboot takes the meter down', r.meter().hidden,
		JSON.stringify(r.meter()));

	// Stopped: the camera is mid-write and has gone quiet. The last reading is
	// where the write actually got to, so it stays — but it stops presenting
	// itself as live, because a bar still sitting there looking current is the
	// original complaint.
	r = start();
	r.feed(DOWNLOAD, '## 100.0%' + UNPACKED, PROTECTED, KERNEL, erase(32, 32),
		write(2000, 2000), verify(2000, 2000) + '\nKernel updated to 0\n' + ROOTFS);
	r.feed(erase(50, 80));
	const last = r.meter();
	r.ws.onclose();
	check('a transcript that stops keeps the reading it stopped on',
		!r.meter().hidden && r.meter().pct === last.pct &&
		r.meter().width === last.width, JSON.stringify(r.meter()));
	check('and says it is no longer live',
		r.meter().stale && /no longer reporting/.test(r.meter().what),
		JSON.stringify(r.meter()));

	// Nothing was written and nothing is coming, so a bar stuck at the
	// downloader's last number would be the only thing on the card still
	// claiming an upgrade is under way.
	r = start();
	r.feed(DOWNLOAD, '## 30.0%');
	r.feed('\nCannot retrieve https://example.invalid/image.tgz Aborting.\n');
	check('an upgrade that gave up before flashing takes the meter down',
		r.meter().hidden, JSON.stringify(r.meter()));

	done();
})();
