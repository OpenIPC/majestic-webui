// The other camera's view of the part you drew, without a browser.
//
// Everything that can go quietly wrong here is a rectangle in the wrong
// place: a drag on the sub stream converted as though it were the main one, a
// letterbox counted as picture, a decoded frame smaller than the channel it
// came from. None of it errors; the peer just shows a different part of the
// scene, which still looks like an answer. So the conversion is pinned with
// numbers, and the control's appearance is pinned to what the camera actually
// said it can do.
//
// The module is one IIFE over a stage, a rubber band, a toggle and a note.
// The stand-ins below are the smallest things that answer the calls it makes.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

// check() takes the label first; these read better condition first.
const ok = (cond, label) => check(label, !!cond);

const SRC = path.join(__dirname, '..', 'www', 'a', 'preview-peer.js');

function el(id) {
	const listeners = {};
	const e = {
		id: id, hidden: true, checked: false, value: '', children: [],
		style: {}, firstChild: null,
		classList: { set: new Set(),
			toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); },
			contains(c) { return this.set.has(c); } },
		clientWidth: 1000, clientHeight: 600,
		getBoundingClientRect: () => ({ left: 100, top: 50 }),
		setPointerCapture() {}, releasePointerCapture() {},
		addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
		dispatchEvent(ev) { (listeners[ev.type] || []).forEach((fn) => fn(ev)); },
		appendChild(c) { this.children.push(c); this.firstChild = this.children[0]; return c; },
		removeChild(c) { this.children = this.children.filter((x) => x !== c); this.firstChild = this.children[0] || null; },
		fire(type, ev) { (listeners[type] || []).forEach((fn) => fn(Object.assign({ type: type }, ev))); },
		text() { return this.children.map((c) => c.textContent || '').join(''); },
		link() { return this.children.find((c) => c.tag === 'a') || null; },
	};
	return e;
}

function boot(opts) {
	opts = opts || {};
	const els = {};
	['#mj-stage', '#mj-marquee', '#mj-peer-ctl', '#mj-peer', '#mj-peer-pick', '#mj-peer-note', '#mj-area']
		.forEach((s) => { els[s] = el(s); });
	if (opts.noPick) delete els['#mj-peer-pick'];
	const asked = [];
	const docListeners = {};
	const winListeners = {};

	const view = opts.view || {
		frame: { w: 2592, h: 1944 }, visible: { x: 0, y: 0, w: 2592, h: 1944 },
		pic: { x: 0, y: 0, w: 1000, h: 750 }, scale: 1000 / 2592,
	};
	const osd = opts.osd || {
		group: [2592, 1944],
		streams: [
			{ stream: 0, frame: [2592, 1944], view: [0, 0, 2592, 1944] },
			{ stream: 1, frame: [1280, 720], view: [0, 0, 2592, 1944] },
		],
	};

	const sandbox = {
		document: {
			querySelector: (s) => els[s] || null,
			createElement: (tag) => ({ tag: tag, textContent: '', href: '', target: '', rel: '' }),
			createTextNode: (t) => ({ textContent: t }),
			addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
		},
		window: {
			MajesticZoom: { view: () => view },
			MajesticLiveStream: () => (opts.shown == null ? 0 : opts.shown),
			MajesticRegion: require('../www/a/mj-region.js'),
			addEventListener: (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn); },
		},
		Event: function (type) { this.type = type; },
		mjConfig: () => Promise.resolve(opts.config || { calibration: { peers: [{ peer: 'tele' }] } }),
		mjGet: (c, dot) => dot.split('.').reduce((o, k) => (o == null ? undefined : o[k]), c),
		apiFetch: (url) => {
			if (url === '/api/v1/calibration/map')
				return Promise.resolve({ status: opts.absent ? 404 : 400, ok: false });
			if (url === '/api/v1/osd')
				return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(osd) });
			if (url.indexOf('/api/v1/calibration/map?') === 0) {
				asked.push(url);
				const a = opts.answer || { ok: true, status: 200,
					body: { rect: '884x586x850x746', url: 'http://192.0.2.7:80/image.jpg?crop=884x586x850x746' } };
				return Promise.resolve({ ok: a.ok, status: a.status, json: () => Promise.resolve(a.body) });
			}
			return Promise.resolve({ ok: false, status: 404 });
		},
		Math: Math, Number: Number, Array: Array, Promise: Promise, Object: Object,
		encodeURIComponent: encodeURIComponent, setTimeout: setTimeout,
	};
	sandbox.window.MajesticRegion = sandbox.window.MajesticRegion;
	vm.createContext(sandbox);
	vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'preview-peer.js' });
	const tick = () => new Promise((r) => setTimeout(r, 5));
	return { els, asked, sandbox, docListeners, winListeners, tick };
}

// A drag from (x0,y0) to (x1,y1) in CLIENT coordinates on a stage whose box
// begins at (100,50).
function drag(env, x0, y0, x1, y1) {
	const st = env.els['#mj-stage'];
	const ev = (x, y) => ({ pointerId: 7, clientX: x, clientY: y, button: 0, stopImmediatePropagation() {} });
	st.fire('pointerdown', ev(x0, y0));
	st.fire('pointermove', ev(x1, y1));
	st.fire('pointerup', ev(x1, y1));
}

(async function () {
	group('the control appears only where the camera has the door and a peer');
	{
		let env = boot({ absent: true });
		await env.tick();
		ok(env.els['#mj-peer-ctl'].hidden === true, 'a camera without the endpoint keeps the control hidden');

		env = boot({ config: { calibration: { peers: [] } } });
		await env.tick();
		ok(env.els['#mj-peer-ctl'].hidden === true, 'no peer rows: nothing to offer');

		env = boot();
		await env.tick();
		ok(env.els['#mj-peer-ctl'].hidden === false, 'the door and a row: shown');
		ok(env.els['#mj-peer-pick'].hidden === true, 'one peer needs no picker');
		ok(env.sandbox.window.MajesticPeerCrop.peers().join() === 'tele', 'the peer as the camera spelt it');

		env = boot({ config: { calibration: { peers: [{ peer: 'tele' }, { peer: 'TELE', mag: '4.9' }, { peer: 'far' }] } } });
		await env.tick();
		ok(env.els['#mj-peer-pick'].hidden === false, 'two cameras: a picker');
		ok(env.els['#mj-peer-pick'].children.length === 2, 'names de-duplicated regardless of case');
	}

	group('a drag on the main stream becomes main-stream pixels');
	{
		const env = boot();
		await env.tick();
		env.els['#mj-peer'].checked = true;
		env.els['#mj-peer'].fire('change', {});
		ok(env.els['#mj-stage'].classList.contains('mj-armed'), 'armed by the toggle');
		// Stage 1000x750 shows the 2592x1944 frame at 1000/2592. A drag from
		// stage (200,150) to (400,300) is frame (518.4,388.8)-(1036.8,777.6):
		// floor/ceil to whole pixels.
		drag(env, 300, 200, 500, 350);
		await env.tick();
		ok(env.asked.length === 1, 'one question asked');
		ok(/peer=tele&rect=518x388x519x390$/.test(env.asked[0]), 'the rectangle in main-stream pixels: ' + env.asked[0]);
		ok(!env.els['#mj-stage'].classList.contains('mj-armed'), 'one drag, then it disarms itself');
		const note = env.els['#mj-peer-note'];
		ok(note.hidden === false, 'the answer is shown');
		ok(/lands at 884,586 850×746 on tele/.test(note.text()), 'where it lands, in the peer\'s pixels: ' + note.text());
		const a = note.link();
		ok(a && a.href === 'http://192.0.2.7:80/image.jpg?crop=884x586x850x746', 'the link is the peer\'s crop');
		ok(a && a.target === '_blank' && /noopener/.test(a.rel), 'opened in a new tab, on the peer\'s own origin');
	}

	group('a drag on the sub stream is mapped through the camera\'s own map');
	{
		// The sub stream is 1280x720 of the same scene; the decoder delivers it
		// at 640x360. A stage rectangle is first sub-stream pixels, then main.
		const env = boot({ shown: 1, view: {
			frame: { w: 640, h: 360 }, visible: { x: 0, y: 0, w: 640, h: 360 },
			pic: { x: 0, y: 0, w: 1000, h: 562.5 }, scale: 1000 / 640,
		} });
		await env.tick();
		env.els['#mj-peer'].checked = true;
		env.els['#mj-peer'].fire('change', {});
		// Stage (100,50)->(600,331.25) is decoded sub px (64,32)->(384,180).
		// The sub stream is 16:9 of the 4:3 main, so the two axes scale
		// differently: main->sub is 1280/2592 across and 720/1944 down, halved
		// again by the decoder. Back the other way that is main px
		// (259.2,172.8)->(1555.2,1144.8) -> 259x172 1297x973.
		drag(env, 200, 100, 700, 381.25);
		await env.tick();
		ok(env.asked.length === 1 && /rect=259x172x1297x973$/.test(env.asked[0]),
			'sub-stream pixels scaled to main through the map, per axis: ' + env.asked[0]);
	}

	group('what does not become a question');
	{
		let env = boot();
		await env.tick();
		env.els['#mj-peer'].checked = true;
		env.els['#mj-peer'].fire('change', {});
		drag(env, 300, 200, 310, 206);
		await env.tick();
		ok(env.asked.length === 0, 'a slip below the floor asks nothing');
		ok(!env.els['#mj-stage'].classList.contains('mj-armed'), 'but still disarms');

		env = boot();
		await env.tick();
		drag(env, 300, 200, 500, 350);
		await env.tick();
		ok(env.asked.length === 0, 'unarmed, the stage is preview-zoom\'s');

		env = boot({ shown: 1, osd: { group: [2592, 1944], streams: [{ stream: 0, frame: [2592, 1944], view: [0, 0, 2592, 1944] }] } });
		await env.tick();
		env.els['#mj-peer'].checked = true;
		env.els['#mj-peer'].fire('change', {});
		drag(env, 300, 200, 500, 350);
		await env.tick();
		ok(env.asked.length === 0, 'a stream the camera has not described converts nothing');
		ok(/has not said which stream/.test(env.els['#mj-peer-note'].text()), 'and says so: ' + env.els['#mj-peer-note'].text());
	}

	group('refusals are sentences, not links');
	{
		let env = boot({ answer: { ok: false, status: 404, body: null } });
		await env.tick();
		env.els['#mj-peer'].checked = true;
		env.els['#mj-peer'].fire('change', {});
		drag(env, 300, 200, 500, 350);
		await env.tick();
		ok(/not calibrated against tele/.test(env.els['#mj-peer-note'].text()), '404: no row for that camera');
		ok(env.els['#mj-peer-note'].link() === null, 'no link');

		env = boot({ answer: { ok: false, status: 400, body: null } });
		await env.tick();
		env.els['#mj-peer'].checked = true;
		env.els['#mj-peer'].fire('change', {});
		drag(env, 300, 200, 500, 350);
		await env.tick();
		ok(/lands nowhere/.test(env.els['#mj-peer-note'].text()), '400: off the peer\'s picture');

		env = boot({ answer: { ok: true, status: 200, body: { rect: '1x2x3x4' } } });
		await env.tick();
		env.els['#mj-peer'].checked = true;
		env.els['#mj-peer'].fire('change', {});
		drag(env, 300, 200, 500, 350);
		await env.tick();
		ok(/not on this link, so no address/.test(env.els['#mj-peer-note'].text()), 'a rectangle without an address says why');
		ok(env.els['#mj-peer-note'].link() === null, 'and offers no link');

		env = boot({ answer: { ok: true, status: 200, body: { rect: '1x2x3x4', url: 'javascript:alert(1)' } } });
		await env.tick();
		env.els['#mj-peer'].checked = true;
		env.els['#mj-peer'].fire('change', {});
		drag(env, 300, 200, 500, 350);
		await env.tick();
		ok(env.els['#mj-peer-note'].link() === null, 'only an http(s) address is a link');
	}

	group('arming this control disarms zoom-to-area');
	{
		const env = boot();
		await env.tick();
		const area = env.els['#mj-area'];
		let changed = 0;
		area.checked = true;
		area.addEventListener('change', () => { changed++; });
		env.els['#mj-peer'].checked = true;
		env.els['#mj-peer'].fire('change', {});
		ok(area.checked === false && changed === 1, 'the other rubber band is put away, and told');
	}

	done();
})();
