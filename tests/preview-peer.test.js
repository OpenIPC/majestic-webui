// The other camera's picture, laid over this one where it belongs
// (preview-peer.js).
//
// Everything that can go quietly wrong here is a picture in the wrong place
// or a credential in the wrong hands, and none of it errors: an outline
// placed from the wrong map sits confidently over the wrong street; an
// overlay whose transform is off shows the neighbouring bay; a page that
// kept asking the peer directly would need the peer's login. So this drives
// the module in a bare vm with a small DOM, a routing fetch, and a stand-in
// for the embeddable player that records what it was mounted with, and
// checks what was asked, of whom, with what, and where the answer was put.
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
		classList: {
			set: new Set(),
			toggle(c, on) { if (on === undefined) on = !this.set.has(c); if (on) this.set.add(c); else this.set.delete(c); return on; },
			add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); },
		},
		clientWidth: 1000, clientHeight: 600,
		getBoundingClientRect: () => ({ left: 100, top: 50 }),
		focus() {},
		setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = String(v); if (k === 'id') this.id = String(v); },
		getAttribute(k) { return this.attrs[k]; },
		removeAttribute(k) { delete this.attrs[k]; if (k === 'src') delete this.src; },
		addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
		dispatchEvent(ev) { (listeners[ev.type] || []).forEach((fn) => fn(ev)); return true; },
		appendChild(c) { this.children.push(c); c.parent = this; this.firstChild = this.children[0]; return c; },
		removeChild(c) { this.children = this.children.filter((x) => x !== c); this.firstChild = this.children[0] || null; },
		// The selector forms the module and the test use: #id, .class, a
		// bare tag, and a comma list of those.
		matches(sel) {
			return sel.split(',').map((s) => s.trim()).some((s) => {
				if (s[0] === '#') return this.id === s.slice(1);
				if (s[0] === '.') return this.classList.contains(s.slice(1)) || (' ' + this.className + ' ').indexOf(' ' + s.slice(1) + ' ') >= 0;
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
	};
	return e;
}

// The camera's answer for the peer's outline: a 640x480 peer picture that
// this camera's (x, y) reaches through a doubling with a shift, so the
// peer's corners land at (-50,-25) (270,-25) (270,215) (-50,215) in main
// pixels -- the same numbers the camera-side test uses.
const QUAD = [[-50, -25], [270, -25], [270, 215], [-50, 215]];
// Where a click in the middle of that lands, in client coordinates against
// the (100,50) stage box at 1000/2592 per main pixel: main (110, 95).
const MID = { x: 100 + 110 * 1000 / 2592, y: 50 + 95 * 1000 / 2592 };

function boot(opts) {
	opts = opts || {};
	const els = {};
	['#mj-stage', '#mj-peer-ctl', '#mj-peer', '#mj-peer-pick', '#mj-peer-note', '#mj-area']
		.forEach((s) => { const e = makeEl('div'); e.id = s.slice(1); e.hidden = true; els[s] = e; });

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
					const h = { stage: stage, opts: o, destroyed: 0, stream: () => 0, setStream() {}, destroy() { this.destroyed++; } };
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
			if (url === '/api/v1/calibration/coverage') return reply(opts.absent ? 404 : 400, null);
			if (url === '/api/v1/calibration/peer') return reply(opts.noPeerDoor ? 404 : 400, null);
			if (url === '/api/v1/osd') return reply(200, osd);
			if (url.indexOf('/api/v1/calibration/coverage?') === 0) {
				asked.push(url);
				return opts.noCoverage ? reply(404, null)
					: reply(200, { peer: 'tele', quad: opts.quad || QUAD, row: { size: '640x480' } });
			}
			if (url.indexOf('/api/v1/calibration/peer?') === 0) {
				asked.push(url);
				if (!state.paired) return reply(409, { peer: 'tele', paired: false, reason: 'this camera is not paired with that one', url: 'http://192.0.2.7:80' });
				state.sessions++;
				const body = { peer: 'tele', paired: true, url: 'http://192.0.2.7:80', session: 's' + state.sessions, size: '640x480' };
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
		els, asked, posted, mounts, sandbox, docListeners, winListeners, tick, state, opts, heldPeer,
		outline: () => stage.find('#mj-peer-outline'),
		overlay: () => stage.find('#mj-peer-overlay'),
		api: () => sandbox.window.MajesticPeerCrop,
		esc: () => (docListeners.keydown || []).forEach((fn) => fn({ key: 'Escape', stopPropagation() {} })),
		arm: async () => { els['#mj-peer'].checked = true; els['#mj-peer'].fire('change'); await tick(); },
		click: async (x, y) => {
			// fire() merges the event into a fresh object, so the count lives
			// on a holder the handler reaches by closure, not by `this`.
			const d = { stopped: 0 };
			const mk = () => ({ pointerId: 7, clientX: x, clientY: y, button: 0, target: { closest: () => null }, stopImmediatePropagation() { d.stopped++; } });
			stage.fire('pointerdown', mk());
			stage.fire('pointerup', mk());
			await tick(); await tick(); await tick();
			return d;
		},
	};
}

// The coefficients of a matrix3d, applied to a picture point: where (X, Y)
// of the W x H picture lands on the stage. What the browser does.
function apply(matrix, X, Y) {
	const m = matrix.replace(/^matrix3d\(|\)$/g, '').split(',').map(Number);
	const x = m[0] * X + m[4] * Y + m[12], y = m[1] * X + m[5] * Y + m[13], w = m[3] * X + m[7] * Y + m[15];
	return { x: x / w, y: y / w };
}

(async function () {
	group('the control shows only where the camera can answer');
	{
		const env = boot({ absent: true });
		await env.tick();
		ok(env.els['#mj-peer-ctl'].hidden, 'no coverage door: hidden');
	}
	{
		const env = boot({ config: { calibration: { peers: [] } } });
		await env.tick();
		ok(env.els['#mj-peer-ctl'].hidden, 'no calibrated peer: hidden');
	}
	{
		const env = boot();
		await env.tick();
		ok(!env.els['#mj-peer-ctl'].hidden, 'coverage door and a peer: shown');
		ok(env.els['#mj-peer-pick'].hidden, 'one peer: no picker');
	}

	group('switching Peer on draws where the other camera looks');
	{
		const env = boot();
		await env.tick();
		ok(!env.outline(), 'nothing drawn while off');
		await env.arm();
		ok(env.asked.some((u) => u === '/api/v1/calibration/coverage?peer=tele'), 'the coverage was asked, for the peer, with no magnification (the camera knows its lens)');
		const o = env.outline();
		ok(o && !o.hidden, 'the outline is on');
		const pts = o.find('polygon').getAttribute('points').split(' ').map((p) => p.split(',').map(Number));
		ok(near(pts[1][0], 270 * 1000 / 2592) && near(pts[1][1], -25 * 1000 / 2592), 'a corner is placed through the zoom map');
		ok(o.find('text').textContent.indexOf('tele sees this') === 0 && /click inside/.test(o.find('text').textContent), 'labelled with the peer and what to do');
		ok(o.find('.mj-peer-dim') && /^M0,0H1000V600H0Z M/.test(o.find('.mj-peer-dim').getAttribute('d')), 'the rest of the picture is dimmed around it');
		ok(env.els['#mj-stage'].classList.contains('mj-peer-armed'), 'the stage knows it is armed');
		ok(env.api().inside(MID.x - 100, MID.y - 50), 'the middle is inside');
		ok(!env.api().inside(800, 500), 'the far side of the stage is not');
		env.esc();
		await env.tick();
		ok(env.outline().hidden, 'Esc disarms and the outline goes');
		ok(!env.els['#mj-stage'].classList.contains('mj-peer-armed'), 'and the stage knows');
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
		await env.arm();
		const pts = env.outline().find('polygon').getAttribute('points').split(' ').map((p) => p.split(',').map(Number));
		// Main px 270 is 270 * 1280/1296 sub-stream px, shown at 1000/1280.
		ok(near(pts[1][0], 270 * (1280 / 1296) * (1000 / 1280)), 'on the sub stream the outline goes through the stream map');
		ok(near(pts[2][1], 215 * (720 / 972) * (562.5 / 720)), 'vertically too');
		env.esc();
	}
	{
		const env = boot({ noCoverage: true });
		await env.tick();
		await env.arm();
		ok(!env.outline() || env.outline().hidden, 'a camera without coverage draws nothing, and the control still arms');
		env.esc();
	}

	group('a click inside the outline lays the other camera over it');
	{
		const env = boot();
		await env.tick();
		await env.arm();
		// Outside (stage (800,500), well past the outline): the page's press, not ours.
		const miss = await env.click(900, 550);
		ok(!miss.stopped, 'a press outside the outline is left to the page');
		ok(!env.asked.some((u) => u.indexOf('/api/v1/calibration/peer?') === 0), 'and asks for nothing');
		// Inside, but with the zoom-to-area tool armed: the page's drag.
		env.els['#mj-area'].checked = true;
		const zoom = await env.click(MID.x, MID.y);
		env.els['#mj-area'].checked = false;
		ok(!zoom.stopped && !env.api().overlay().on, 'with the area tool armed a press inside is the page\'s zoom rectangle');
		// Inside.
		const hit = await env.click(MID.x, MID.y);
		ok(hit.stopped === 2, 'a press inside, and its release, are stopped at the stage');
		ok(env.asked.some((u) => u === '/api/v1/calibration/peer?peer=tele'), 'a session on the peer was brokered by this camera');
		const ov = env.overlay();
		ok(ov && !ov.hidden, 'the overlay is on');
		ok(env.api().overlay().on && env.api().overlay().peer === 'tele', 'and the module says so');
		ok(env.mounts.length === 1, 'the embeddable player was mounted once');
		const m = env.mounts[0].opts;
		ok(m.origin() === 'http://192.0.2.7:80' && m.session() === 's1', 'pointed at the peer\'s origin with the brokered session');
		ok(m.picker === false && m.snapshot === false && m.fullscreen === false && m.inline === true, 'no chrome of its own');
		ok(m.config().video1.enabled === false, 'no sub channel: the point is detail');
		// The snapshot is there at once, warped like the video will be.
		const still = ov.find('.mj-peer-still');
		ok(!still.hidden && String(still.src).indexOf('http://192.0.2.7:80/image.jpg?session=s1') === 0, 'the peer\'s snapshot shows straight away');
		// The transform lands the peer's corners on the outline's.
		const mat = env.api().overlay().matrix;
		ok(/^matrix3d\(/.test(mat), 'one perspective transform');
		const c = env.api().corners();
		const f = env.api().overlay().frame;
		ok(f.w === 640 && f.h === 480, 'sized to the peer\'s declared picture until the decoder says');
		const p0 = apply(mat, 0, 0), p2 = apply(mat, 640, 480), p1 = apply(mat, 640, 0);
		ok(near(p0.x, c[0].x) && near(p0.y, c[0].y), 'its top-left lands on the first corner');
		ok(near(p1.x, c[1].x) && near(p1.y, c[1].y), 'its top-right on the second');
		ok(near(p2.x, c[2].x) && near(p2.y, c[2].y), 'its bottom-right on the third');
		ok(still.style.transform === mat && env.mounts[0].stage.style.transform === mat, 'applied to the snapshot and the player alike');
		ok(still.style.width === '640px' && env.mounts[0].stage.style.width === '640px', 'both sized to the picture');
		// The decoder reports a smaller frame: re-sized, same corners.
		m.onFrame(320, 240, 'h265');
		ok(env.mounts[0].stage.style.width === '320px', 'the player follows the decoded frame');
		const q2 = apply(env.api().overlay().matrix, 320, 240);
		ok(near(q2.x, c[2].x) && near(q2.y, c[2].y), 'and still lands on the third corner');
		m.onPlaying('webrtc');
		ok(still.hidden, 'the snapshot goes once the video plays');
		ok(/tele · LIVE/.test(env.outline().find('text').textContent), 'the label says live');
		ok(/mj-peer-dim-off/.test(env.outline().find('.mj-peer-dim').getAttribute('class')), 'the dimming lifts');
		// A second click takes it away; Esc would too.
		await env.click(MID.x, MID.y);
		ok(ov.hidden && !env.api().overlay().on, 'a click inside takes it away');
		ok(env.mounts[0].destroyed === 1, 'the player was destroyed');
		ok(env.api().overlay().session === null, 'the session was let go');
		ok(!env.outline().hidden && /click inside/.test(env.outline().find('text').textContent), 'the outline stays, and invites again');
		env.esc();
		ok(env.outline().hidden, 'Esc then disarms');
	}

	group('a perspective quadrilateral is a perspective transform');
	{
		const env = boot();
		const q = [{ x: 100, y: 100 }, { x: 400, y: 120 }, { x: 380, y: 300 }, { x: 60, y: 260 }];
		const mat = env.api().quadTransform(200, 150, q);
		ok(/^matrix3d\(/.test(mat), 'a matrix3d');
		const corners = [[0, 0], [200, 0], [200, 150], [0, 150]];
		ok(corners.every(([X, Y], i) => { const p = apply(mat, X, Y); return near(p.x, q[i].x, 0.01) && near(p.y, q[i].y, 0.01); }),
			'every corner of the picture lands on its corner of the quadrilateral');
		const mid = apply(mat, 100, 75);
		ok(mid.x > 60 && mid.x < 400 && mid.y > 100 && mid.y < 300, 'and the middle lands inside it');
		ok(env.api().quadTransform(200, 150, [q[0], q[0], q[0], q[0]]) === null, 'a collapsed quadrilateral is refused');
	}

	group('what belongs to one overlay stays with it');
	{
		// A session that answers after Esc lands on an overlay that is gone.
		const env = boot({ slowPeer: true });
		await env.tick();
		await env.arm();
		await env.click(MID.x, MID.y);
		ok(env.api().overlay().pending, 'the session is on its way');
		env.esc();
		ok(env.heldPeer.length === 1, 'the session was asked for');
		env.heldPeer.shift()();
		await env.tick();
		await env.tick();
		ok(!env.api().overlay().on, 'the late session did not switch it on');
		ok(env.mounts.length === 0, 'and no player was mounted');
		ok(env.api().overlay().session === null, 'and no session is held');
	}
	{
		// The codec learnt from one peer is not the next one's.
		const env = boot();
		await env.tick();
		await env.arm();
		await env.click(MID.x, MID.y);
		env.mounts[0].opts.onFrame(320, 240, 'h264');
		ok(env.mounts[0].opts.config().video0.codec === 'h264', 'the peer said h264');
		await env.click(MID.x, MID.y);
		await env.click(MID.x, MID.y);
		ok(env.mounts.length === 2 && env.mounts[1].opts.config().video0.codec === 'h265', 'the next overlay assumes nothing');
		env.esc();
	}
	{
		// Picking another peer closes the overlay that was the first one's.
		const env = boot({ config: { calibration: { peers: [{ peer: 'tele' }, { peer: 'other' }] } } });
		await env.tick();
		ok(!env.els['#mj-peer-pick'].hidden, 'two peers: the picker shows');
		await env.arm();
		await env.click(MID.x, MID.y);
		ok(env.api().overlay().on, 'an overlay on the first');
		env.els['#mj-peer-pick'].value = 'other';
		env.els['#mj-peer-pick'].fire('change');
		ok(!env.api().overlay().on && env.mounts[0].destroyed === 1, 'picking the other takes it away, player and all');
	}
	{
		// This camera's ICE settings reach the peer player; an absent expiry stays absent.
		const env = boot({ noExpires: true, config: { calibration: { peers: [{ peer: 'tele' }] }, webrtc: { iceServers: 'stun:stun.example:3478' } } });
		await env.tick();
		await env.arm();
		await env.click(MID.x, MID.y);
		ok(env.mounts[0].opts.config().webrtc.iceServers === 'stun:stun.example:3478', 'the LAN\'s ICE settings');
		ok(env.api().overlay().session.expires === null, 'an expiry the camera did not give is not zero');
		env.esc();
	}
	{
		// Switching Peer off takes the overlay with it: control and state agree.
		const env = boot();
		await env.tick();
		await env.arm();
		await env.click(MID.x, MID.y);
		env.els['#mj-peer'].checked = false;
		env.els['#mj-peer'].fire('change');
		ok(!env.api().overlay().on && env.outline().hidden, 'off is off: overlay and outline both gone');
	}

	group('a camera that cannot fetch the picture says so');
	{
		const env = boot({ noPeerDoor: true });
		await env.tick();
		await env.arm();
		await env.click(MID.x, MID.y);
		ok(!env.api().overlay().on, 'no overlay');
		ok(env.els['#mj-peer-note'].text().indexOf('predates') >= 0, 'and says why');
	}

	group('pairing, once, in the note');
	{
		const env = boot({ paired: false });
		await env.tick();
		await env.arm();
		await env.click(MID.x, MID.y);
		ok(!env.api().overlay().on, 'not paired: no overlay yet');
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
		ok(env.api().overlay().on, 'and the overlay came on by itself');
		ok(env.mounts.length === 1 && env.mounts[0].opts.session() === 's1', 'with the session brokered after pairing');
		env.esc();
	}

	group('no player: the peer\'s snapshots, warped, and honestly labelled');
	{
		const env = boot({ noPlayer: true });
		await env.tick();
		await env.arm();
		await env.click(MID.x, MID.y);
		ok(env.api().overlay().on, 'the overlay comes on anyway');
		const still = env.overlay().find('.mj-peer-still');
		ok(!still.hidden && String(still.src).indexOf('http://192.0.2.7:80/image.jpg?session=s1') === 0, 'on the peer\'s snapshots, with the session');
		ok(/tele · snapshots/.test(env.outline().find('text').textContent), 'the label says snapshots, not live');
		ok(/^matrix3d\(/.test(still.style.transform), 'warped onto the outline');
		env.esc();
		ok(still.hidden, 'taking it away stops the polling');
	}

	group('a stream change drops the map and the outline is laid out again');
	{
		let shown = 0;
		const env = boot({ shownFn: () => shown, osd: { group: [2592, 1944], streams: [
			{ stream: 0, frame: [2592, 1944], view: [0, 0, 2592, 1944] },
			{ stream: 1, frame: [1280, 720], view: [0, 0, 1296, 972] } ] } });
		await env.tick();
		await env.arm();
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
