// The Firmware page drawn before its answer, and the answer swapped in (#683).
//
// update.cgi renders the blocks that depend on the build check in a "checking"
// state and update.js fetches them again from update.cgi?part=offer. Every way
// this goes wrong is silent:
//
// - a swap that never lands leaves "Looking for new firmware…" up forever,
//   which reads exactly like a camera that is slow to answer;
// - an Install button bound while the page was checking is a node that is no
//   longer in the page, so the real one does nothing when pressed, with no
//   error anywhere;
// - a body that is not the offer (a login page after the session lapsed, an
//   error page) swaps nothing and leaves the page checking, again forever.
//
// None of it needs a camera to go wrong, and none of it can be seen going wrong
// without waiting on one. So update.js is run against a small DOM that can be
// replaced in parts, with a DOMParser whose documents are built the same way.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const A = (f) => path.join(__dirname, '..', 'www', 'a', f);

// An element just rich enough for update.js: ids, dataset, `hidden`, children,
// and the three queries it makes -- '#id', '[data-x]', '[data-fw-part="v"]'.
// outerHTML is a stable rendering of what the element carries, which is what
// the "drawn the same either way" comparison reads.
function el(tag, attrs, kids) {
	const e = {
		tagName: tag.toUpperCase(), id: '', dataset: {}, hidden: false, disabled: false,
		style: {}, children: [], parent: null, innerHTML: '', _text: '', files: null,
		get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
		set textContent(v) { this._text = String(v); this.children = []; },
		get outerHTML() {
			return '<' + tag + ' ' + JSON.stringify({ id: this.id, d: this.dataset, h: this.hidden }) + '>' +
				this._text + this.children.map((c) => c.outerHTML).join('') + '</' + tag + '>';
		},
		appendChild(c) { c.parent = this; this.children.push(c); return c; },
		replaceWith(n) {
			const i = this.parent.children.indexOf(this);
			n.parent = this.parent; this.parent.children[i] = n; this.parent = null;
		},
		closest(t) {
			for (let x = this; x; x = x.parent) if (x.tagName === t.toUpperCase()) return x;
			return null;
		},
		querySelector(sel) { return find(this, sel)[0] || null; },
		querySelectorAll(sel) { return find(this, sel); },
		addEventListener(type, fn) { (this._on = this._on || {})[type] = fn; },
		removeEventListener() {}, setAttribute() {}, getAttribute() { return null; },
		classList: { add() {}, remove() {}, contains() { return false; } },
	};
	for (const k of Object.keys(attrs || {})) {
		if (k === 'id') e.id = attrs[k];
		else if (k === 'hidden') e.hidden = !!attrs[k];
		else if (k === 'text') e._text = attrs[k];
		else e.dataset[k] = attrs[k];
	}
	for (const c of kids || []) e.appendChild(c);
	return e;
}

function find(root, sel) {
	let m;
	let test;
	if ((m = /^#(.+)$/.exec(sel))) test = (e) => e.id === m[1];
	else if ((m = /^\[data-([a-z-]+)="([^"]*)"\]$/.exec(sel))) {
		const k = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
		test = (e) => e.dataset[k] === m[2];
	} else if ((m = /^\[data-([a-z-]+)\]$/.exec(sel))) {
		const k = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
		test = (e) => k in e.dataset;
	} else throw new Error('selector the fake DOM does not know: ' + sel);
	const out = [];
	(function walk(e) { for (const c of e.children) { if (test(c)) out.push(c); walk(c); } })(root);
	return out;
}

// The blocks as update.cgi draws them in each state. Only what update.js reads.
const DRAW = {
	head(state) {
		const kids = [];
		if (state === 'checking') {
			kids.push(el('div', { fwAsking: '' }), el('div', { fwUnasked: '', hidden: true }));
			kids.push(el('button', { id: 'fw-recheck', hidden: true }));
		} else if (state === 'available') {
			kids.push(el('button', { id: 'fw-install-github' }));
		} else if (state === 'current') {
			const b = el('button', { id: 'fw-install-github', force: '1', confirm: 'Reinstall?' });
			kids.push(b);
		}
		return el('div', { id: 'fw-head', fwPart: 'head', fwState: state,
			mjVersion: 'master+abcdef1, 2026-10-01', socVendor: 'hisilicon' }, kids);
	},
	wide(state) {
		return state === 'offline'
			? el('div', { fwPart: 'wide' }, [el('input', { id: 'fw-file' }), el('button', { id: 'fw-install-upload' })])
			: el('div', { id: 'fw-news', fwPart: 'wide', hidden: true }, [el('div', { id: 'fw-news-body' })]);
	},
	ifback(state) {
		return state === 'available' ? el('div', { fwPart: 'ifback' }, [el('p', { text: 'two minutes' })])
			: el('div', { fwPart: 'ifback', hidden: true });
	},
	railfile(state) {
		return state === 'offline' ? el('div', { fwPart: 'railfile', hidden: true })
			: el('div', { fwPart: 'railfile' }, [el('input', { id: 'fw-file' }), el('button', { id: 'fw-install-upload' })]);
	},
};

// What update.cgi?part=offer returns, as a parsed document.
function offerDoc(state) {
	return el('body', {}, [DRAW.head(state), DRAW.wide(state), DRAW.ifback(state), DRAW.railfile(state)]);
}

// Loads update.js on a page drawn `checking`, with `answer` deciding what the
// offer request gets: a state name, a status number, 'reject', 'login' (a body
// with no offer in it), 'active' (a flash under way), 'hang' (never settles) or
// 'late' (settles when calls.release() is called).
function load(answer, opts) {
	opts = opts || {};
	const page = el('body', {}, [
		el('div', { id: 'fw-status' }),
		el('div', { id: 'fw-inflight' }),
		el('div', { id: 'fw-controls' }, [
			DRAW.head('checking'),
			el('div', {}, [DRAW.wide('checking'),
				el('div', {}, [el('input', { id: 'fw_kernel' }), el('input', { id: 'fw_rootfs' }),
					DRAW.ifback('checking'), DRAW.railfile('checking')])]),
		]),
		el('div', { id: 'fw-progress' }),
		el('div', { id: 'fw-output' }), el('div', { id: 'fw-installed' }),
		el('div', { id: 'fw-progress-hl' }), el('ol', { id: 'fw-steps' }),
		el('div', { id: 'fw-meter' }), el('div', { id: 'fw-meter-what' }),
		el('div', { id: 'fw-meter-pct' }), el('div', { id: 'fw-bar' }),
	]);
	page.querySelector('#fw_kernel').checked = true;
	page.querySelector('#fw_rootfs').checked = true;
	if (opts.chosen) page.querySelector('#fw-file').files = opts.chosen;

	const calls = { offer: [], feed: 0, confirm: [], timers: [], reloaded: 0 };
	let ws = null;
	function WebSocket() { ws = this; this.sent = []; }
	WebSocket.prototype.send = function (m) { this.sent.push(m); };

	const ctx = {
		console, JSON, Object, Set, Date, Math, isNaN, isFinite, String, Number,
		Array, Promise, RegExp, Error, TextDecoder, Uint8Array, AbortController,
		// Timers are held, not run: a test fires them when it wants the 25
		// seconds to have passed.
		setTimeout: (fn) => { calls.timers.push(fn); return calls.timers.length; },
		clearTimeout: () => {},
		setInterval: () => 0, clearInterval: () => {},
		performance: { now: () => 0 },
		location: { protocol: 'http:', host: 'cam', reload() { calls.reloaded++; } },
		WebSocket: WebSocket,
		confirm: (q) => { calls.confirm.push(q); return opts.confirm !== false; },
		window: {
			// Stands in for fw-changes.js. Only whether loadChanges reached the
			// feed is read; the counting has update-page.test.js.
			MajesticChanges: {
				parseBuild: () => ({ rev: 'abcdef1', date: '2026-10-01' }),
				load: () => { calls.feed++; return new Promise(() => {}); },
			},
		},
		DOMParser: function () {
			this.parseFromString = (html) => (html === 'LOGIN' ? el('body', {}, [el('form', {})]) : offerDoc(html));
		},
		document: {
			readyState: 'complete',
			addEventListener() {},
			getElementById: (id) => page.querySelector('#' + id),
			querySelector: (s) => page.querySelector(s),
			createElement: (t) => el(t),
			importNode: (n) => n,
		},
		$: (s) => page.querySelector(s),
		termWriter: () => ({ write(t) { return t; }, note() {}, commit() {} }),
		apiFetch: (url) => {
			calls.offer.push(url);
			if (answer === 'reject') return Promise.reject(new Error('aborted'));
			// Never settles: the browser without AbortController, whose request
			// the timer cannot cancel.
			if (answer === 'hang') return new Promise(() => {});
			// Settles when the test says so, carrying an offer.
			if (answer === 'late') {
				return new Promise((res) => { calls.release = () =>
					res({ ok: true, status: 200, text: () => Promise.resolve('available') }); });
			}
			if (typeof answer === 'number') return Promise.resolve({ ok: false, status: answer });
			const body = answer === 'login' ? 'LOGIN'
				: answer === 'active' ? '<div data-fw-active></div>' : answer;
			return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(body) });
		},
		rawFetch: () => Promise.reject(new Error('not used here')),
		fetch: () => Promise.reject(new Error('not used here')),
	};
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(A('update.js'), 'utf8'), ctx);
	return { page, calls, ctx, ws: () => ws,
		click(id) {
			const t = page.querySelector('#' + id);
			const controls = page.querySelector('#fw-controls');
			controls._on.click({ target: t, preventDefault() {} });
		} };
}

const settle = () => new Promise((r) => setImmediate(r));

(async function () {
	group('a page drawn while checking asks for the offer');
	{
		const r = load('available');
		check('one request, to update.cgi?part=offer', r.calls.offer.length === 1 &&
			r.calls.offer[0] === 'update.cgi?part=offer', JSON.stringify(r.calls.offer));
		await settle();
		const head = r.page.querySelector('#fw-head');
		check('the answer replaces the checking hero', head.dataset.fwState === 'available', head.dataset.fwState);
		check('and the card that only an image on offer has', !r.page.querySelector('[data-fw-part="ifback"]').hidden);
		check('the changelog is asked for once there is an image', r.calls.feed === 1, r.calls.feed);

		r.click('fw-install-github');
		check('Install on the swapped-in hero starts the upgrade', !!r.ws() &&
			r.page.querySelector('#fw-controls').style.display === 'none');
	}
	{
		const r = load('current', { confirm: false });
		await settle();
		r.click('fw-install-github');
		check('Reinstall asks first', r.calls.confirm.length === 1 && r.calls.confirm[0] === 'Reinstall?');
		check('and a no starts nothing', !r.ws());
	}
	{
		const r = load('current');
		await settle();
		r.click('fw-install-github');
		r.ws().onopen();
		const frame = JSON.parse(r.ws().sent[0] || '{}');
		check('a yes reinstalls with force, as the hero promised', frame.source === 'github' && frame.force === true,
			r.ws().sent[0]);
	}
	{
		const r = load('current');
		await settle();
		check('no changelog where there is nothing on offer', r.calls.feed === 0, r.calls.feed);
	}

	group('no answer is not an answer');
	for (const [what, answer] of [['a failed request', 'reject'], ['a 500', 500],
		['a body with no offer in it (a login page)', 'login']]) {
		const r = load(answer);
		await settle();
		const head = r.page.querySelector('#fw-head');
		check(what + ': the hero stops saying it is checking',
			head.querySelector('[data-fw-asking]').hidden && !head.querySelector('[data-fw-unasked]').hidden);
		check(what + ': and offers to try again', !r.page.querySelector('#fw-recheck').hidden);
	}
	{
		const r = load('reject');
		await settle();
		r.click('fw-recheck');
		check('Try again asks again', r.calls.offer.length === 2, r.calls.offer.length);
		check('and says it is checking while it does',
			!r.page.querySelector('[data-fw-asking]').hidden && r.page.querySelector('#fw-recheck').hidden);
	}

	group('the check that never comes back');
	{
		// The window here has no AbortController, as an older browser has none:
		// the timer is all there is.
		const r = load('hang');
		await settle();
		check('still checking before the time is up',
			!r.page.querySelector('[data-fw-asking]').hidden);
		r.calls.timers.forEach((fn) => fn());
		check('the timer alone ends it, without an abort to deliver',
			r.page.querySelector('[data-fw-asking]').hidden &&
			!r.page.querySelector('#fw-recheck').hidden);
	}
	{
		const r = load('late');
		await settle();
		r.calls.timers.forEach((fn) => fn());
		r.calls.release();
		await settle();
		check('an answer after the timeout does not paint over the fallback',
			r.page.querySelector('#fw-head').dataset.fwState === 'checking' &&
			!r.page.querySelector('#fw-recheck').hidden);
	}

	group('a flash this page did not start');
	{
		const r = load('active');
		await settle();
		check('the page is fetched again, to attach to it', r.calls.reloaded === 1, r.calls.reloaded);
		check('and no hero is drawn over it saying nothing has changed',
			r.page.querySelector('#fw-head').dataset.fwState === 'checking' &&
			r.page.querySelector('#fw-recheck').hidden);
	}

	group('the file route, open while the check runs');
	{
		const files = [{ name: 'fw.tgz' }];
		files.length = 1;
		const r = load('available', { chosen: files });
		const before = r.page.querySelector('#fw-file');
		await settle();
		check('a rail card drawn the same either way is left alone, chosen file and all',
			r.page.querySelector('#fw-file') === before && before.files === files);
	}
	{
		const files = [{ name: 'fw.tgz' }];
		const r = load('offline', { chosen: files });
		await settle();
		const now = r.page.querySelector('#fw-file');
		check('no image on offer moves the picker to the wide card', now.parent.dataset.fwPart === 'wide');
		check('and the chosen file moves with it', now.files === files);
	}

	done();
})();
