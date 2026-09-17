// The other camera's picture, in place, on this page (preview-peer.js).
//
// Everything that can go quietly wrong here is a picture in the wrong place
// or a credential in the wrong hands, and none of it errors: an outline
// drawn from the wrong map sits confidently over the wrong street; a loupe
// whose crop arithmetic is off shows the neighbouring car; a page that kept
// asking the peer directly would need the peer's login. So this drives the
// module in a bare vm with a small DOM, a routing fetch, and a stand-in for
// the embeddable player that records what it was mounted with, and checks
// what was asked, of whom, with what, and where the answer was put.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

// check() takes the label first; these read better condition first.
const ok = (cond, label) => check(label, !!cond);
const near = (a, b, eps) => Math.abs(a - b) <= (eps || 0.51);

const SRC = path.join(__dirname, '..', 'www', 'a', 'preview-peer.js');

// ---- a DOM just big enough --------------------------------------------------

function makeEl(tag) {
	const listeners = {};
	const e = {
		tagName: String(tag).toUpperCase(), id: '', className: '', hidden: false,
		children: [], parent: null, attrs: {}, style: {}, textContent: '', value: '',
		checked: false, disabled: false, type: '', title: '', firstChild: null,
		readyState: 0, width: 0, height: 0,
		classList: {
			set: new Set(),
			toggle(c, on) { if (on === undefined) on = !this.set.has(c); if (on) this.set.add(c); else this.set.delete(c); return on; },
			add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); },
		},
		clientWidth: 1000, clientHeight: 600,
		getBoundingClientRect: () => ({ left: 100, top: 50 }),
		setPointerCapture() {}, releasePointerCapture() {}, focus() {},
		setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = String(v); if (k === 'id') this.id = String(v); },
		getAttribute(k) { return this.attrs[k]; },
		removeAttribute(k) { delete this.attrs[k]; if (k === 'src') delete this.src; },
		addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
		dispatchEvent(ev) { (listeners[ev.type] || []).forEach((fn) => fn(ev)); return true; },
		appendChild(c) { this.children.push(c); c.parent = this; this.firstChild = this.children[0]; return c; },
		removeChild(c) { this.children = this.children.filter((x) => x !== c); this.firstChild = this.children[0] || null; },
		// The selector forms the module and the test use: #id, .class,
		// [attr="v"], a bare tag, and a comma list of those.
		matches(sel) {
			return sel.split(',').map((s) => s.trim()).some((s) => {
				if (s[0] === '#') return this.id === s.slice(1);
				if (s[0] === '.') return this.classList.contains(s.slice(1)) || (' ' + this.className + ' ').indexOf(' ' + s.slice(1) + ' ') >= 0;
				const m = /^\[([\w-]+)="([^"]*)"\]$/.exec(s);
				if (m) return this.attrs[m[1]] === m[2];
				return this.tagName === s.toUpperCase();
			});
		},
		closest(sel) { let n = this; while (n) { if (n.matches && n.matches(sel)) return n; n = n.parent; } return null; },
		querySelectorAll(sel) {
			const out = [];
			(function walk(n) { n.children.forEach((c) => { if (c.matches && c.matches(sel)) out.push(c); if (c.children) walk(c); }); })(this);
			return out;
		},
		find(sel) { return this.querySelectorAll(sel)[0] || null; },
		fire(type, ev) { (listeners[type] || []).forEach((fn) => fn(Object.assign({ type: type, target: e, stopPropagation() {}, stopImmediatePropagation() {}, preventDefault() {} }, ev))); },
		text() { return this.children.map((c) => c.textContent || (c.text ? c.text() : '')).join(''); },
		getContext() { return e.ctx; },
	};
	e.ctx = { calls: [], drawImage() { this.calls.push('drawImage'); }, beginPath() {}, moveTo() {}, lineTo() {},
		closePath() {}, fill() {}, stroke() {}, setLineDash() {}, strokeRect() { this.calls.push('strokeRect'); } };
	return e;
}

function boot(opts) {
	opts = opts || {};
	const els = {};
	['#mj-stage', '#mj-marquee', '#mj-peer-ctl', '#mj-peer', '#mj-peer-pick', '#mj-peer-note', '#mj-area']
		.forEach((s) => { const e = makeEl('div'); e.id = s.slice(1); e.hidden = true; els[s] = e; });
	if (opts.noPick) delete els['#mj-peer-pick'];
	// The page's own live picture, for the swapped inset to paint from.
	const media = makeEl('video');
	media.className = 'mj-stage-media';
	media.readyState = 4;
	els['#mj-stage'].appendChild(media);

	const asked = [];      // every URL the module asked this camera for
	const posted = [];     // every POST body
	const mounts = [];     // what the player stand-in was mounted with
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
	const state = { paired: opts.paired !== false, sessions: 0 };
	const heldPeer = [];   /* peer-session replies parked by opts.slowPeer */

	const reply = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status: status, json: () => Promise.resolve(body) });

	const sandbox = {
		document: {
			querySelector: (s) => els[s] || null,
			createElement: (tag) => makeEl(tag),
			createElementNS: (ns, tag) => makeEl(tag),
			createTextNode: (t) => ({ textContent: t }),
			addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
			fullscreenElement: null,
		},
		window: {
			MajesticZoom: { view: () => view },
			MajesticLiveStream: opts.shownFn || (() => (opts.shown == null ? 0 : opts.shown)),
			MajesticRegion: require('../www/a/mj-region.js'),
			MajesticPreview: opts.noPlayer ? undefined : {
				mount: (host, o) => {
					const stage = makeEl('div');
					stage.className = 'mj-pv-stage';
					host.appendChild(stage);
					const video = makeEl('video');
					video.requestPictureInPicture = () => { mounts[mounts.length - 1].pip = true; return Promise.resolve(); };
					const h = { stage: stage, opts: o, destroyed: 0, stream: () => 0, setStream() {}, media: () => video,
						destroy() { this.destroyed++; } };
					mounts.push(h);
					return h;
				},
			},
			addEventListener: (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn); },
		},
		Event: function (type) { this.type = type; },
		mjConfig: () => Promise.resolve(opts.config || { calibration: { peers: [{ peer: 'tele' }] } }),
		mjGet: (c, dot) => dot.split('.').reduce((o, k) => (o == null ? undefined : o[k]), c),
		apiFetch: (url, init) => {
			if (url === '/api/v1/calibration/map') return reply(opts.absent ? 404 : 400, null);
			if (url === '/api/v1/calibration/peer') return reply(opts.noPeerDoor ? 404 : 400, null);
			if (url === '/api/v1/osd') return reply(200, osd);
			if (url.indexOf('/api/v1/calibration/coverage?') === 0) {
				asked.push(url);
				return opts.noCoverage ? reply(404, null)
					: reply(200, { peer: 'tele', quad: opts.quad || [[605, 560], [1255, 470], [1320, 1180], [655, 1265]] });
			}
			if (url.indexOf('/api/v1/calibration/map?') === 0) {
				asked.push(url);
				const a = opts.answer || { status: 200,
					body: { peer: 'tele', rect: '884x586x850x746', row: { size: '2592x1944' }, quad: [] } };
				return reply(a.status, a.body);
			}
			if (url.indexOf('/api/v1/calibration/peer?') === 0) {
				asked.push(url);
				if (!state.paired) return reply(409, { peer: 'tele', paired: false, reason: 'this camera is not paired with that one', url: 'http://192.0.2.7:80' });
				state.sessions++;
				const body = { peer: 'tele', paired: true, url: 'http://192.0.2.7:80', session: 's' + state.sessions, size: '2592x1944' };
				if (!opts.noExpires) body.expires = 900;
				if (opts.slowPeer) return new Promise((r) => { heldPeer.push(() => r({ ok: true, status: 200, json: () => Promise.resolve(body) })); });
				return reply(200, body);
			}
			if (url === '/api/v1/calibration/pair' && init && init.method === 'POST') {
				posted.push(JSON.parse(init.body));
				if (JSON.parse(init.body).password === 'right') { state.paired = true; return reply(200, { peer: 'tele', paired: true }); }
				return reply(403, { peer: 'tele', paired: false, reason: 'refused' });
			}
			return reply(404, null);
		},
		Math: Math, Number: Number, Array: Array, Promise: Promise, Object: Object, String: String,
		JSON: JSON, Date: Date, encodeURIComponent: encodeURIComponent,
		setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval, clearInterval: clearInterval,
	};
	vm.createContext(sandbox);
	vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'preview-peer.js' });
	const tick = () => new Promise((r) => setTimeout(r, 8));
	const stage = els['#mj-stage'];
	return {
		els, asked, posted, mounts, sandbox, docListeners, winListeners, tick, state, media, opts, heldPeer,
		outline: () => stage.find('#mj-peer-outline'),
		loupe: () => stage.find('#mj-peer-loupe'),
		api: () => sandbox.window.MajesticPeerCrop,
		esc: () => (docListeners.keydown || []).forEach((fn) => fn({ key: 'Escape', stopPropagation() {} })),
	};
}

// A drag on the stage, in client coordinates against the (100,50) box.
function drag(env, x0, y0, x1, y1) {
	const s = env.els['#mj-stage'];
	const ev = (x, y) => ({ pointerId: 7, clientX: x, clientY: y, button: 0, target: { closest: () => null } });
	s.fire('pointerdown', ev(x0, y0));
	s.fire('pointermove', ev(x1, y1));
	s.fire('pointerup', ev(x1, y1));
}

async function armAndDraw(env, x0, y0, x1, y1) {
	env.els['#mj-peer'].checked = true;
	env.els['#mj-peer'].fire('change');
	await env.tick();
	drag(env, x0, y0, x1, y1);
	await env.tick();
	await env.tick();
}

(async function () {
	group('the control shows only where the camera can answer');
	{
		const env = boot({ absent: true });
		await env.tick();
		ok(env.els['#mj-peer-ctl'].hidden, 'no map door: hidden');
	}
	{
		const env = boot({ config: { calibration: { peers: [] } } });
		await env.tick();
		ok(env.els['#mj-peer-ctl'].hidden, 'no calibrated peer: hidden');
	}
	{
		const env = boot();
		await env.tick();
		ok(!env.els['#mj-peer-ctl'].hidden, 'map door and a peer: shown');
		ok(env.els['#mj-peer-pick'].hidden, 'one peer: no picker');
	}

	group('switching Peer on draws where the other camera looks');
	{
		const env = boot();
		await env.tick();
		ok(!env.outline(), 'nothing drawn while off');
		env.els['#mj-peer'].checked = true;
		env.els['#mj-peer'].fire('change');
		await env.tick();
		ok(env.asked.some((u) => u === '/api/v1/calibration/coverage?peer=tele'), 'the coverage was asked, for the peer, with no magnification (the camera knows its lens)');
		const o = env.outline();
		ok(o && !o.hidden, 'the outline is on');
		const poly = o.find('polygon');
		const pts = poly.getAttribute('points').split(' ').map((p) => p.split(',').map(Number));
		// Main px -> stage px at 1000/2592 with the whole frame in view.
		ok(near(pts[0][0], 605 * 1000 / 2592) && near(pts[0][1], 560 * 1000 / 2592), 'the first corner is placed through the zoom map');
		ok(near(pts[2][0], 1320 * 1000 / 2592) && near(pts[2][1], 1180 * 1000 / 2592), 'and the third');
		ok(o.find('text').textContent === 'tele sees this', 'labelled with the peer');
		env.esc();
		await env.tick();
		ok(env.outline().hidden, 'Esc disarms and the outline goes');
	}
	{
		// A sub stream that is a crop of the top-left quarter of the sensor,
		// decoded at its declared 1280x720 and shown at 1000 wide.
		const cropOsd = { group: [2592, 1944], streams: [
			{ stream: 0, frame: [2592, 1944], view: [0, 0, 2592, 1944] },
			{ stream: 1, frame: [1280, 720], view: [0, 0, 1296, 972] } ] };
		const cropView = { frame: { w: 1280, h: 720 }, visible: { x: 0, y: 0, w: 1280, h: 720 },
			pic: { x: 0, y: 0, w: 1000, h: 562.5 }, scale: 1000 / 1280 };
		const env = boot({ shown: 1, osd: cropOsd, view: cropView });
		await env.tick();
		env.els['#mj-peer'].checked = true;
		env.els['#mj-peer'].fire('change');
		await env.tick();
		const pts = env.outline().find('polygon').getAttribute('points').split(' ').map((p) => p.split(',').map(Number));
		// Main px 605 is 605 * 1280/1296 sub-stream px, shown at 1000/1280.
		ok(near(pts[0][0], 605 * (1280 / 1296) * (1000 / 1280)), 'on the sub stream the outline goes through the stream map');
		ok(near(pts[0][1], 560 * (720 / 972) * (562.5 / 720)), 'vertically too');
		env.esc();
	}
	{
		const env = boot({ noCoverage: true });
		await env.tick();
		env.els['#mj-peer'].checked = true;
		env.els['#mj-peer'].fire('change');
		await env.tick();
		ok(!env.outline() || env.outline().hidden, 'a camera without coverage draws nothing, and the control still arms');
		env.esc();
	}

	group('a rectangle becomes the other camera, live, in place');
	{
		const env = boot();
		await env.tick();
		await armAndDraw(env, 570, 380, 870, 600);
		// Stage (470,330)-(770,550) at 2592/1000 per stage pixel, floored and
		// ceiled to whole main-channel pixels.
		ok(env.asked.some((u) => u === '/api/v1/calibration/map?peer=tele&rect=1218x855x778x571'),
			'the rectangle was asked in main-channel pixels');
		ok(env.asked.some((u) => u === '/api/v1/calibration/peer?peer=tele'), 'a session on the peer was brokered by this camera');
		const l = env.loupe();
		ok(l && !l.hidden, 'the loupe is open');
		ok(l.style.left === '470px' && l.style.top === '330px' && l.style.width === '300px' && l.style.height === '220px',
			'where you drew it');
		ok(env.mounts.length === 1, 'the embeddable player was mounted once');
		const m = env.mounts[0].opts;
		ok(m.origin() === 'http://192.0.2.7:80', 'pointed at the peer\'s origin');
		ok(m.session() === 's1', 'with the brokered session');
		ok(m.picker === false && m.snapshot === false && m.fullscreen === false && m.inline === true, 'no chrome of its own');
		ok(m.config().video1.enabled === false, 'no sub channel: the loupe is for detail');
		// The decoder reports the frame; the crop arithmetic follows.
		m.onFrame(2592, 1944, 'h265');
		m.onPlaying('webrtc');
		const st = env.mounts[0].stage.style;
		const k = Math.max(300 / 850, 220 / 746);
		ok(near(parseFloat(st.width), 2592 * k, 0.1) && near(parseFloat(st.height), 1944 * k, 0.1), 'the peer\'s frame is scaled so the rectangle covers the box');
		ok(near(parseFloat(st.left), -(884 * k) + (300 - 850 * k) / 2, 0.1), 'and offset so the rectangle is what shows');
		ok(near(parseFloat(st.top), -(586 * k) + (220 - 746 * k) / 2, 0.1), 'vertically too');
		ok(l.find('.mj-loupe-tag').textContent.indexOf('LIVE') === 0, 'the tag says live once a picture is up');
		ok(env.api().loupe().session.id === 's1', 'the session is held');
		ok(!env.outline().hidden, 'the outline stays while the loupe is open');

		// A press on the toolbar is the loupe's, stopped at the stage so the
		// page neither pans nor captures the pointer; it starts no grab.
		let stopped = 0;
		const btn = l.find('[data-act="swap"]');
		env.els['#mj-stage'].fire('pointerdown', { pointerId: 9, clientX: 580, clientY: 400, button: 0, target: btn, stopImmediatePropagation() { stopped++; } });
		ok(stopped === 1, 'a press on the toolbar is stopped at the stage');
		env.els['#mj-stage'].fire('pointerup', { pointerId: 9, clientX: 580, clientY: 400, button: 0, target: btn, stopImmediatePropagation() { stopped++; } });
		ok(stopped === 2, 'and so is its release');
		ok(l.style.left === '470px', 'and nothing moved');
		// A drag on the loupe's body moves it and asks the camera again.
		const body = l.find('.mj-loupe-host');
		const before = env.asked.length;
		env.els['#mj-stage'].fire('pointerdown', { pointerId: 9, clientX: 600, clientY: 450, button: 0, target: body, stopImmediatePropagation() {} });
		env.els['#mj-stage'].fire('pointermove', { pointerId: 9, clientX: 620, clientY: 460, target: body, stopImmediatePropagation() {} });
		env.els['#mj-stage'].fire('pointerup', { pointerId: 9, clientX: 620, clientY: 460, target: body, stopImmediatePropagation() {} });
		await env.tick();
		await env.tick();
		ok(l.style.left === '490px' && l.style.top === '340px', 'dragged by (20,10)');
		ok(env.asked.length > before && /rect=1270x881x778x571$/.test(env.asked[env.asked.length - 1]), 'and the moved rectangle was asked of the camera');

		// Whole: the entire peer picture fits the box.
		l.find('[data-act="whole"]').fire('click');
		const kw = Math.min(300 / 2592, 220 / 1944);
		ok(near(parseFloat(env.mounts[0].stage.style.width), 2592 * kw, 0.1), 'Whole fits the whole picture');
		l.find('[data-act="whole"]').fire('click');

		// Swap: the loupe fills the stage, the inset is painted from this page's picture.
		l.find('[data-act="swap"]').fire('click');
		ok(l.classList.contains('mj-loupe-swapped'), 'swapped');
		ok(env.api().loupe().swapped, 'the module says so');
		const inset = l.find('.mj-loupe-inset');
		ok(!inset.hidden, 'the inset is shown');
		ok(inset.ctx.calls.indexOf('drawImage') >= 0, 'painted from the live picture');
		ok(inset.ctx.calls.indexOf('strokeRect') >= 0, 'with the rectangle on it');
		env.esc();
		ok(!l.classList.contains('mj-loupe-swapped') && !l.hidden, 'Esc swaps back first');
		env.esc();
		ok(l.hidden, 'and closes second');
		ok(env.mounts[0].destroyed === 1, 'the player was destroyed');
		ok(env.api().loupe().session === null, 'the session was let go');
		ok(env.outline().hidden, 'the outline goes with it');
	}

	group('switching Peer on says what to do, and a click is a question too');
	{
		const env = boot();
		await env.tick();
		env.els['#mj-peer'].checked = true;
		env.els['#mj-peer'].fire('change');
		await env.tick();
		ok(!env.els['#mj-peer-note'].hidden && env.els['#mj-peer-note'].text().indexOf('draw a rectangle inside the outline') === 0,
			'the note says how');
		env.esc();
		ok(env.els['#mj-peer-note'].hidden, 'and goes with the arming');
		// A click (a drag below the floor) at stage (500,400) opens a 320x180
		// loupe centred there.
		await armAndDraw(env, 600, 450, 603, 452);
		const l = env.loupe();
		ok(l && !l.hidden, 'a click opens a loupe');
		ok(l.style.width === '320px' && l.style.height === '180px', 'of the set size');
		ok(l.style.left === '342px' && l.style.top === '311px', 'centred on the click');
		ok(env.els['#mj-peer-note'].hidden, 'and the hint is gone');
		env.esc();
	}

	group('a loupe needs room');
	{
		const env = boot();
		await env.tick();
		// A 40x30 drawing at (500,400): grown around its centre to 160x90.
		await armAndDraw(env, 600, 450, 640, 480);
		const l = env.loupe();
		ok(l && !l.hidden, 'a small drawing still opens a loupe');
		ok(l.style.width === '160px' && l.style.height === '90px', 'at the minimum size');
		ok(l.style.left === '440px' && l.style.top === '370px', 'centred on what was drawn');
		ok(env.asked.some((u) => u === '/api/v1/calibration/map?peer=tele&rect=1140x959x416x234'),
			'and the camera was asked for the grown rectangle, so the box shows what it says');
		ok(l.classList.contains('mj-loupe-cramped'), 'and it is cramped: the tag hides, the toolbar stays');
		env.esc();
	}

	group('a served stream that moved is learnt again, not refused');
	{
		let shown = 0;
		const env = boot({ shownFn: () => shown, osd: { group: [2592, 1944], streams: [
			{ stream: 0, frame: [2592, 1944], view: [0, 0, 2592, 1944] },
			{ stream: 1, frame: [1280, 720], view: [0, 0, 1296, 972] } ] },
			view: { frame: { w: 1280, h: 720 }, visible: { x: 0, y: 0, w: 1280, h: 720 },
				pic: { x: 0, y: 0, w: 1000, h: 562.5 }, scale: 1000 / 1280 } });
		await env.tick();
		// The camera served the sub stream after the map for the main one was
		// learnt; the page's picture is now the sub stream's.
		shown = 1;
		await armAndDraw(env, 570, 380, 870, 600);
		await env.tick();
		ok(env.loupe() && !env.loupe().hidden, 'the drag opened a loupe on the fresh map');
		// Stage (470,330)-(770,550) is sub-stream (601.6,422.4)-(985.6,704),
		// which through the quarter crop (1280/1296 across, 720/972 down) is
		// main (609,570)-(998,951).
		ok(env.asked.some((u) => u === '/api/v1/calibration/map?peer=tele&rect=609x570x389x381'),
			'converted through the sub stream\'s map');
		env.esc();
	}

	group('what belongs to one loupe stays with it');
	{
		// A session that answers after Esc lands on a loupe that is gone.
		const env = boot({ slowPeer: true });
		await env.tick();
		await armAndDraw(env, 570, 380, 870, 600);
		ok(!env.loupe() || env.loupe().hidden, 'no loupe while the session is on its way');
		env.esc();
		ok(env.heldPeer.length === 1, 'the session was asked for');
		env.heldPeer.shift()();
		await env.tick();
		await env.tick();
		ok(!env.loupe() || env.loupe().hidden, 'the late session did not reopen it');
		ok(env.mounts.length === 0, 'and no player was mounted');
		ok(env.api().loupe().session === null, 'and no session is held');
	}
	{
		// A move the camera cannot answer goes back to the last answered place.
		const env = boot();
		await env.tick();
		await armAndDraw(env, 570, 380, 870, 600);
		const l = env.loupe();
		const body = l.find('.mj-loupe-host');
		env.opts.answer = { status: 400, body: null };
		env.els['#mj-stage'].fire('pointerdown', { pointerId: 9, clientX: 600, clientY: 450, button: 0, target: body, stopImmediatePropagation() {} });
		env.els['#mj-stage'].fire('pointermove', { pointerId: 9, clientX: 700, clientY: 500, target: body, stopImmediatePropagation() {} });
		ok(l.style.left === '570px', 'the box follows the pointer');
		env.els['#mj-stage'].fire('pointerup', { pointerId: 9, clientX: 700, clientY: 500, target: body, stopImmediatePropagation() {} });
		await env.tick();
		await env.tick();
		ok(l.style.left === '470px' && l.style.top === '330px', 'and goes back where the camera last answered');
		ok(env.api().loupe().peerRect.x === 884, 'with the crop of that place');
		ok(env.els['#mj-peer-note'].text().indexOf('lands nowhere') >= 0, 'and the reason is said');
		env.esc();
	}
	{
		// The codec learnt from one peer is not the next one's.
		const env = boot();
		await env.tick();
		await armAndDraw(env, 570, 380, 870, 600);
		env.mounts[0].opts.onFrame(2592, 1944, 'h264');
		ok(env.mounts[0].opts.config().video0.codec === 'h264', 'the peer said h264');
		env.esc();
		await armAndDraw(env, 570, 380, 870, 600);
		ok(env.mounts.length === 2 && env.mounts[1].opts.config().video0.codec === 'h265', 'the next loupe assumes nothing');
		env.esc();
	}
	{
		// Picking another peer closes the loupe that was the first one's.
		const env = boot({ config: { calibration: { peers: [{ peer: 'tele' }, { peer: 'other' }] } } });
		await env.tick();
		ok(!env.els['#mj-peer-pick'].hidden, 'two peers: the picker shows');
		await armAndDraw(env, 570, 380, 870, 600);
		ok(env.loupe() && !env.loupe().hidden, 'a loupe on the first');
		env.els['#mj-peer-pick'].value = 'other';
		env.els['#mj-peer-pick'].fire('change');
		ok(env.loupe().hidden, 'picking the other closes it');
		ok(env.mounts[0].destroyed === 1, 'and its player');
	}
	{
		// This camera's ICE settings reach the peer player; an absent expiry stays absent.
		const env = boot({ noExpires: true, config: { calibration: { peers: [{ peer: 'tele' }] }, webrtc: { iceServers: 'stun:stun.example:3478' } } });
		await env.tick();
		await armAndDraw(env, 570, 380, 870, 600);
		ok(env.mounts[0].opts.config().webrtc.iceServers === 'stun:stun.example:3478', 'the LAN\'s ICE settings');
		ok(env.api().loupe().session.expires === null, 'an expiry the camera did not give is not zero');
		env.esc();
	}

	group('a rectangle that cannot be answered is a sentence, not a loupe');
	{
		const env = boot({ answer: { status: 400, body: null } });
		await env.tick();
		await armAndDraw(env, 570, 380, 870, 600);
		ok(!env.loupe() || env.loupe().hidden, 'no loupe');
		ok(env.els['#mj-peer-note'].text().indexOf('lands nowhere') >= 0, 'the note says so');
		ok(!env.asked.some((u) => u.indexOf('/api/v1/calibration/peer?') === 0), 'no session was brokered for nothing');
	}
	{
		const env = boot({ noPeerDoor: true });
		await env.tick();
		await armAndDraw(env, 570, 380, 870, 600);
		ok(!env.loupe() || env.loupe().hidden, 'a camera without the peer door opens no loupe');
		ok(env.els['#mj-peer-note'].text().indexOf('predates') >= 0, 'and says why');
	}

	group('pairing, once, in the note');
	{
		const env = boot({ paired: false });
		await env.tick();
		await armAndDraw(env, 570, 380, 870, 600);
		ok(!env.loupe() || env.loupe().hidden, 'not paired: no loupe yet');
		const form = env.els['#mj-peer-note'].find('.mj-peer-pair');
		ok(form, 'the pairing form is offered');
		ok(form.find('span').textContent.indexOf('sends to http://192.0.2.7:80') > 0, 'and says where the password goes');
		const input = form.find('input');
		ok(input.type === 'password', 'as a password field');
		input.value = 'wrong';
		form.fire('submit');
		await env.tick();
		ok(env.posted.length === 1 && env.posted[0].peer === 'tele' && env.posted[0].password === 'wrong', 'the password went to THIS camera, for the peer');
		ok(form.find('.mj-peer-pair-why').textContent.indexOf('refused') >= 0, 'a refusal is said');
		ok(input.value === '', 'and the field is cleared');
		input.value = 'right';
		form.fire('submit');
		await env.tick();
		await env.tick();
		await env.tick();
		ok(env.state.paired, 'paired');
		ok(env.loupe() && !env.loupe().hidden, 'and the loupe opened on its own');
		ok(env.mounts.length === 1 && env.mounts[0].opts.session() === 's1', 'with the session brokered after pairing');
		env.esc();
	}

	group('no player: the peer\'s snapshots, cropped, and honestly labelled');
	{
		const env = boot({ noPlayer: true });
		await env.tick();
		await armAndDraw(env, 570, 380, 870, 600);
		const l = env.loupe();
		ok(l && !l.hidden, 'the loupe opens anyway');
		const still = l.find('.mj-loupe-still');
		ok(!still.hidden, 'on stills');
		ok(String(still.src).indexOf('http://192.0.2.7:80/image.jpg?crop=884x586x850x746&session=s1') === 0, 'cropped, from the peer, with the session');
		ok(l.find('.mj-loupe-tag').textContent.indexOf('snapshots') === 0, 'the tag says snapshots, not live');
		env.esc();
		ok(still.hidden, 'closing stops the polling');
	}

	group('a stream change drops the map and the outline is laid out again');
	{
		let shown = 0;
		// The sub stream is a crop, so the same main-channel point lands
		// elsewhere on it and the difference is visible.
		const cropOsd = { group: [2592, 1944], streams: [
			{ stream: 0, frame: [2592, 1944], view: [0, 0, 2592, 1944] },
			{ stream: 1, frame: [1280, 720], view: [0, 0, 1296, 972] } ] };
		const env = boot({ shownFn: () => shown, osd: cropOsd });
		await env.tick();
		env.els['#mj-peer'].checked = true;
		env.els['#mj-peer'].fire('change');
		await env.tick();
		const before = env.outline().find('polygon').getAttribute('points');
		shown = 1;
		(env.winListeners['mj-stream-changed'] || []).forEach((fn) => fn());
		await env.tick();
		await env.tick();
		ok(env.outline().find('polygon').getAttribute('points') !== before, 'placed again from the new map');
		env.esc();
	}

	done();
})();
