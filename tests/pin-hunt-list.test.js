// Which pad list the filter hunt is working from.
//
// The hunt reads the camera's list at mount and keeps a copy, while the map
// beside it changes that list. If the copy goes stale nothing looks wrong: the
// pad the owner has just allowed is simply never tried, and "nothing moved the
// picture" reads the same whether or not it was. A sweep takes its pairs when
// it starts, so the same fault can be reached through timing no browser
// session reproduces on demand (#711).
//
// The real pin-hunt.js and ircut-scan.js run here against a stub of the few
// DOM calls the cards make. Nothing here drives a pad: Start is never pressed.
'use strict';

const path = require('path');
const { check, group, done } = require('./assert');

const store = {};
global.localStorage = {
	getItem: (k) => (k in store ? store[k] : null),
	setItem: (k, v) => { store[k] = String(v); },
	removeItem: (k) => { delete store[k]; },
};
global.window = {};
const posts = [];
window.MajesticIrcutScan = require(path.join(__dirname, '..', 'www', 'a', 'ircut-scan.js'));
window.MajesticPinSweep = require(path.join(__dirname, '..', 'www', 'a', 'pin-sweep.js'));
const hunt = require(path.join(__dirname, '..', 'www', 'a', 'pin-hunt.js'));

const banks = () => [0, 1, 2].map((i) => ({ base: i * 8, n: 8 }));
const INFO = (avoid) => ({ banks: banks(), assigned: [], held: [], avoid: avoid || [] });
let camera = INFO();

window.fetch = (u, o) => {
	if (o && o.method === 'POST') posts.push(String(u));
	const m = /[?&]avoid=(\d+)/.exec(u);
	if (m) camera = INFO([{ pin: Number(m[1]), why: 'asked' }]);
	return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(camera) });
};

function element(html, attrs) {
	const on = {};
	return {
		appendChild() {}, insertBefore() {}, append() {},
		querySelector: () => element(), querySelectorAll: () => [],
		disabled: false, textContent: '', hidden: false, value: '',
		addEventListener: (t, f) => { on[t] = f; },
		click: () => on.click && on.click(),
		getAttribute: (a) => (attrs ? attrs[a] : null),
	};
}

global.document = { createElement: () => element(), createTextNode: () => element() };

// Enough of an element to hold a card: what was written, the ids in it, and
// the buttons a card wires up by attribute.
function hostStub() {
	let html = '';
	let els = {};
	return {
		hidden: false, className: '', textContent: '', appendChild() {}, insertBefore() {},
		get innerHTML() { return html; },
		set innerHTML(v) { html = v; els = {}; },
		querySelector(sel) {
			if (sel === '[data-resume]') return html.includes('data-resume') ? {} : null;
			const id = /^#([\w-]+)$/.exec(sel);
			if (!id || !html.includes('id="' + id[1] + '"')) return null;
			return els[sel] || (els[sel] = element());
		},
		querySelectorAll(sel) {
			if (sel !== 'button[data-do]') return [];
			return [...html.matchAll(/data-do="([\w-]+)"/g)]
				.map((m) => els[m[0]] || (els[m[0]] = element('', { 'data-do': m[1] })));
		},
	};
}

const count = (h) => h.querySelector('#mj-scan-n').textContent;
const number = (s) => parseInt(s, 10);
const tick = () => new Promise((r) => setTimeout(r, 0));

const mountOn = (host, info, extra) => hunt.mount(host, Object.assign({
	info: info, soc: '', only: 'filter', pins: { sweep() {}, select() {} },
}, extra));

group('a card waiting to start follows the list');
{
	const h = hostStub();
	const m = mountOn(h, INFO());
	m.open();
	const all = number(count(h));
	check('the sweep has pairs to offer', all > 0);
	m.reinfo(INFO([{ pin: 3, why: 'asked' }]));
	const fewer = number(count(h));
	check('excluding a pad takes its pairs off the card', fewer < all);
	m.reinfo(INFO());
	check('allowing it puts them back', number(count(h)) === all);
}

group('a card opened later uses the latest list');
{
	const h = hostStub();
	const m = mountOn(h, INFO([{ pin: 3, why: 'asked' }]));
	m.open();
	const excluded = number(count(h));
	h.innerHTML = '';
	m.reinfo(INFO());
	m.open();
	check('a pad allowed while no card was up is offered again',
		number(count(h)) > excluded);
}

group('a sweep under way keeps its list');
{
	const h = hostStub();
	const m = mountOn(h, INFO());
	m.open();
	h.innerHTML = '<p>running</p>';
	m.reinfo(INFO([{ pin: 3, why: 'asked' }]));
	check('the running card is not replaced', h.innerHTML === '<p>running</p>');
}

group('Start waits for the camera’s answer');
{
	const h = hostStub();
	const m = mountOn(h, INFO());
	m.open();
	const go = () => h.querySelector('#mj-scan-go');
	check('free to press at rest', go().disabled === false);
	m.hold(true);
	check('held while a change is in flight', go().disabled === true);
	m.reinfo(INFO([{ pin: 3, why: 'asked' }]));
	check('a redraw mid-change stays held', go().disabled === true);
	m.hold(true);
	m.hold(false);
	check('one of two overlapping presses finishing is not enough', go().disabled === true);
	m.hold(false);
	check('released once both have answered', go().disabled === false);
	m.hold(false);
	m.hold(true);
	check('a surplus release does not cancel the next hold', go().disabled === true);
	m.hold(false);

	h.innerHTML = '';
	m.hold(true);
	m.open();
	check('a card opened during a change opens held', go().disabled === true);

	const h2 = hostStub();
	const again = mountOn(h2, INFO());
	m.hold(true);
	again.open();
	check('a press from before the redraw does not hold the new mount',
		h2.querySelector('#mj-scan-go').disabled === false);
}

group('a resume card follows the list');
{
	const scan = window.MajesticIrcutScan;
	store['mj-ircut-scan'] = JSON.stringify({ sig: scan.stamp(INFO()), done: ['0:1'] });
	const h = hostStub();
	const m = mountOn(h, INFO());
	const before = h.innerHTML;
	check('the card is up', before.includes('pairs done'));
	m.reinfo(INFO([{ pin: 3, why: 'asked' }]));
	check('its total moves with the list', h.innerHTML !== before);
	delete store['mj-ircut-scan'];
}

// Last: the only group that has to wait for a promise.
(async () => {
	const scan = window.MajesticIrcutScan;
	camera = INFO();
	store['mj-ircut-scan'] = JSON.stringify({
		sig: scan.stamp(INFO()), done: [], inflight: '3:4',
	});
	const first = hostStub();
	let second = null;
	// What the Pins page does: hearing about a change replaces the section.
	const pinsLike = {
		sweep() {}, select() {},
		changed: () => {
			second = hostStub();
			mountOn(second, camera, { only: null, pins: pinsLike });
			return Promise.resolve();
		},
	};
	mountOn(first, INFO(), { pins: pinsLike });
	const avoid = first.querySelectorAll('button[data-do]')
		.filter((b) => b.getAttribute('data-do') === 'avoid')[0];
	check('the interrupted scan offers to rule its pads out', !!avoid);
	avoid.click();
	for (let i = 0; i < 10; i++) await tick();
	check('both pads reach the camera',
		posts.filter((u) => /avoid=[34]$/.test(u)).length === 2);
	check('the scan card lands in the section that replaced this one',
		!!second && !!second.querySelector('#mj-scan-go'));
	done();
})();
