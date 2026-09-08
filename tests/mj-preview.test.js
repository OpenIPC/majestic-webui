// The MajesticPreview stage (www/a/mj-preview.js), mounted and driven.
//
// This is the component every settings section that wants a live picture
// embeds — the Live adjustments leaf, the Motion and Overlay editors, the crop
// view. Its twin, the Live View page's glue (preview-page.js), is driven end to
// end by staging.test.js and auto-source.test.js; this file is the equivalent
// net for the component. What it pins is the wiring that is THIS file's own and
// nobody else's: the shared swap (preview-swap.js), walk (preview-chain.js) and
// served rule (preview-served.js) are tested where they live, so here they are
// loaded FOR REAL and the checks are about how the component hangs them off its
// own stage — the picker radios, the alert, the frame contract, the retry
// ladder feeding, and teardown. Every one of those has been ported into this
// file by hand from a fix that landed on the page first (#274/#288/#342/#398/
// #400), with no test to catch a port that went wrong; a stage that silently
// shows nothing looks exactly like a camera that is off (#401).
//
// The one thing the repo does not already provide is a queryable DOM: the
// component mounts by assigning stage.innerHTML and then reading it back by CSS
// and attribute selector, and no existing test parses HTML. So this file ships
// a small shim — a tag/attr parser and a selector matcher covering exactly the
// forms the component issues (`.class`, `#id`, `[a="b"]`, chained, and
// `label[for="…"]`). It is deliberately not a general DOM; it accepts only the
// component's own controlled markup.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const A = (f) => path.join(__dirname, '..', 'www', 'a', f);

// ── the queryable DOM shim ───────────────────────────────────────────────────

const VOID = { input: 1, br: 1, img: 1, hr: 1, meta: 1, source: 1 };

// Parse the component's own markup into element nodes. Text is dropped: the
// component never reads a parsed node's text (it SETS textContent on the alert
// and the served line), and nothing is queried by text — so structure is all
// that matters and skipping text keeps the parser tiny.
function parseHTML(html) {
	const root = { children: [] };
	const stack = [root];
	const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>|([^<]+)/g;
	let m;
	while ((m = re.exec(html)) !== null) {
		if (m[5] !== undefined) continue;            // text node — dropped
		const tag = m[2].toLowerCase();
		if (m[1] === '/') {                          // closing tag
			for (let i = stack.length - 1; i > 0; i--) {
				if (stack[i].tagName === tag.toUpperCase()) { stack.length = i; break; }
			}
			continue;
		}
		const node = makeElement(tag);
		parseAttrs(m[3] || '', node);
		const parent = stack[stack.length - 1];
		parent.children.push(node);
		node.parentNode = parent === root ? null : parent;
		if (!(m[4] === '/' || VOID[tag])) stack.push(node);
	}
	return root.children;
}

function parseAttrs(str, node) {
	const re = /([\w-]+)(?:="([^"]*)")?/g;
	let m;
	while ((m = re.exec(str)) !== null) {
		if (!m[1]) continue;
		const name = m[1], val = m[2] === undefined ? '' : m[2];
		node.attributes[name] = val;
		if (name === 'class') node.className = val;
		else if (name === 'hidden') node.hidden = true;
		else if (name === 'style' && /display\s*:\s*none/.test(val)) node.style.display = 'none';
	}
}

function descendants(node, out) {
	out = out || [];
	for (const c of node.children) { out.push(c); descendants(c, out); }
	return out;
}

// One compound selector, no combinators or commas — the only shapes the
// component uses. `label[for="x"]`, `[data-slot="0"][data-kind="video"]`,
// `.mj-pv-bar`, `#id-s0`.
function matchesSelector(node, sel) {
	let s = sel.trim();
	const tagM = /^([a-zA-Z][\w-]*)/.exec(s);
	let tag = null;
	if (tagM) { tag = tagM[1].toUpperCase(); s = s.slice(tagM[0].length); }
	if (tag && node.tagName !== tag) return false;
	const tok = /#([\w-]+)|\.([\w-]+)|\[([\w-]+)="([^"]*)"\]/g;
	let m;
	while ((m = tok.exec(s)) !== null) {
		if (m[1] !== undefined) {
			if (node.attributes.id !== m[1]) return false;
		} else if (m[2] !== undefined) {
			if (!(node.className || '').split(/\s+/).includes(m[2])) return false;
		} else {
			if (node.attributes[m[3]] !== m[4]) return false;
		}
	}
	return true;
}

function makeElement(tag) {
	const node = {
		tagName: String(tag).toUpperCase(),
		className: '', style: {}, hidden: false, textContent: '',
		checked: false, disabled: false, type: '', title: '', value: '',
		readyState: 0, __mjPainted: false,
		attributes: {}, children: [], parentNode: null, _handlers: {}, _html: '',
		get innerHTML() { return this._html; },
		set innerHTML(html) {
			this._html = String(html);
			this.children = parseHTML(this._html);
			this.children.forEach((c) => { c.parentNode = this; });
		},
		appendChild(n) { n.parentNode = this; this.children.push(n); return n; },
		insertBefore(n, ref) {
			const i = this.children.indexOf(ref);
			if (i < 0) this.children.push(n); else this.children.splice(i, 0, n);
			n.parentNode = this; return n;
		},
		removeChild(n) {
			const i = this.children.indexOf(n);
			if (i >= 0) this.children.splice(i, 1);
			n.parentNode = null; return n;
		},
		addEventListener(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); },
		fire(ev, arg) { (this._handlers[ev] || []).slice().forEach((f) => f(arg || {})); },
		setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'class') this.className = String(v); },
		getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; },
		querySelector(sel) { return descendants(this).find((n) => matchesSelector(n, sel)) || null; },
		querySelectorAll(sel) { return descendants(this).filter((n) => matchesSelector(n, sel)); },
	};
	return node;
}

// ── players, transport, timers ───────────────────────────────────────────────

// Copied from staging.test.js: attach records the opts (so a test can fire
// onState/onCodec/onServed/onStats by hand) and pushes to env.made; say() is
// the state hook. No element cloneNode dance — the component resolves its slot
// nodes live through the swap, so a stub node need not be replaced.
function makePlayers(env) {
	function impl(kind) {
		return {
			attach(el, opts) {
				const p = {
					kind: kind, el: el, destroyed: false, opts: opts, streamSet: null,
					setStream(n) { this.streamSet = n; },
					setVolume() {}, setMic() {}, setAudio() {},
					audioSupported: () => true, micSupported: () => true,
					destroy() { this.destroyed = true; },
					say(state, detail) { opts.onState(state, detail); },
				};
				env.made.push(p);
				return p;
			},
			available: kind === 'webrtc',
		};
	}
	return { mse: impl('mse'), webrtc: impl('webrtc'), wasm: impl('wasm') };
}

function load(cfg) {
	cfg = cfg || {};
	const env = { made: [], timers: [], demoted: false };
	const win = {};
	const impls = makePlayers(env);
	win.MajesticVideo = {};                           // truthy for available()
	win.MajesticWasm = cfg.wasmOk === false ? undefined
		: { available: true, handles: (c) => /^h265$|^hevc$/i.test(String(c || '')) };
	win.MajesticTransport = {
		available: () => true,
		preferred: () => cfg.preferred || 'mse',
		choose(k) { env.chosen = k; },
		demote() { env.demoted = true; },
		durable: (s) => s === 'fallback',
		impl: (k) => impls[k] || impls.mse,
		iceServers: () => [],
		chosenStream: () => (cfg.chosenStream === undefined ? null : cfg.chosenStream),
		chooseStream() {},
		softwareRungFor: (d) => {
			const bits = String(d || '').split(' ');
			const w = win.MajesticWasm;
			return bits[0] === 'undecodable' &&
				!!(w && w.available && w.handles && w.handles(bits[1]));
		},
		softwareRungForCodec: (d, codec) => {
			const bits = String(d || '').split(' ');
			const w = win.MajesticWasm;
			return (bits[0] === 'unreachable' || bits[0] === 'mse-error') &&
				!!(w && w.available && w.handles && w.handles(codec));
		},
	};
	const ctx = {
		window: win, console: console, Promise: Promise,
		document: { createElement: (tag) => makeElement(tag) },
		setTimeout: (fn, ms) => { const t = { fn: fn, ms: ms, fired: false, cleared: false }; env.timers.push(t); return t; },
		clearTimeout: (t) => { if (t) t.cleared = true; },
	};
	vm.createContext(ctx);
	// Real modules; each self-assigns to window and reaches the others through
	// window.*, so no bare-global hand-over (unlike the page harness). The
	// transport is a stub, so preview-transport.js is not loaded — the chain
	// reads window.MajesticTransport at call time and finds it.
	for (const f of ['preview-swap.js', 'preview-served.js', 'preview-chain.js', 'mj-preview.js']) {
		vm.runInContext(fs.readFileSync(A(f), 'utf8'), ctx);
	}
	env.win = win;
	env.MP = win.MajesticPreview;
	env.fire = () => {
		const live = env.timers.filter((t) => !t.fired && !t.cleared);
		if (live.length !== 1) throw new Error('expected one live timer, have ' + live.length);
		live[0].fired = true; live[0].fn(); return live[0].ms;
	};
	env.pendingMs = () => env.timers.filter((t) => !t.fired && !t.cleared).map((t) => t.ms);
	env.mount = (over) => {
		const host = makeElement('div');
		const rec = { host: host, playing: [], lost: [], frames: [] };
		rec.h = env.MP.mount(host, Object.assign({
			config: cfg.config || {},
			onPlaying: (k) => rec.playing.push(k),
			onLost: (d) => rec.lost.push(d),
			onFrame: (w, h, c) => rec.frames.push(w === null ? null : { w: w, h: h, codec: c }),
		}, over || {}));
		return rec;
	};
	return env;
}

// Handy: the stage's picker radios and the alert/served nodes, resolved the way
// the component does.
function ui(rec) {
	const stage = rec.h.stage;
	return {
		alert: stage.querySelector('.mj-pv-alert'),
		msg: stage.querySelector('.mj-pv-msg'),
		msgWhy: stage.querySelector('.mj-pv-msg-why'),
		s0: stage.querySelector('.mj-pv-bar').querySelector('.mj-seg-in'),
		radios: stage.querySelector('.mj-pv-bar').querySelectorAll('.mj-seg-in'),
	};
}

(function () {
	group('available(): a stage that cannot walk its chain does not mount');
	{
		const env = load();
		const rec = env.mount();
		check('with every module present it mounts', rec.h !== null);
		check('and appends its stage to the host', rec.host.children.length === 1);
		check('and the stage has a bar with two radios', ui(rec).radios.length === 2,
			ui(rec).radios.length + '');

		// #400 added MajesticChain to available(); without it the stage must not
		// mount rather than throw halfway through building.
		const saved = env.win.MajesticChain;
		env.win.MajesticChain = undefined;
		const host2 = makeElement('div');
		const h2 = env.MP.mount(host2, { config: {} });
		check('with no chain module, mount returns null', h2 === null);
		check('and nothing was appended', host2.children.length === 0);
		env.win.MajesticChain = saved;
	}

	group('the first attach is on screen at once, but announces only on a picture');
	{
		const env = load({ preferred: 'webrtc' });
		const rec = env.mount();
		check('one player was attached', env.made.length === 1, env.made.length + '');
		check('it is the preferred transport', env.made[0].kind === 'webrtc', env.made[0].kind);
		check('nothing has been announced yet', rec.playing.length === 0);
		env.made[0].say('playing');
		check('a picture announces once', rec.playing.join() === 'webrtc', rec.playing.join());
		env.made[0].say('playing');
		check('and not again for a second report', rec.playing.length === 1, rec.playing.length + '');
	}

	group('a live WebRTC session that falls back stages MSE and demotes');
	{
		const env = load({ preferred: 'webrtc' });
		const rec = env.mount();
		env.made[0].say('playing');
		env.made[0].say('fallback');
		check('the transport was demoted', env.demoted === true);
		check('an MSE trial was staged', env.made.length === 2 && env.made[1].kind === 'mse',
			env.made.map((p) => p.kind).join(','));
		check('the alert is not up — the old frame is held', ui(rec).alert.hidden === true);
		check('and nothing new announced while the trial is unproven',
			rec.playing.join() === 'webrtc', rec.playing.join());
		env.made[1].say('playing');
		check('the trial announces once it has a picture',
			rec.playing.join() === 'webrtc,mse', rec.playing.join());
	}

	group('a live WebRTC session that goes busy stages MSE but does not demote');
	{
		// 'busy' is transient: it stages MSE like 'fallback' but is never
		// remembered as a demotion (#402, the one rule in transport.durable).
		const env = load({ preferred: 'webrtc' });
		env.mount();
		env.made[0].say('playing');
		env.made[0].say('busy', 'the camera is serving as many viewers as it can');
		check('an MSE trial was staged', env.made.length === 2 && env.made[1].kind === 'mse',
			env.made.map((p) => p.kind).join(','));
		check('and no demotion was recorded', env.demoted !== true, env.demoted + '');
	}

	group('MSE giving up shows the alert, and the selected channel retries');
	{
		const env = load({ preferred: 'mse', config: { video0: { codec: 'h264' } } });
		const rec = env.mount();
		env.made[0].say('mjpeg', 'unreachable');           // h264, no software rung
		check('the alert is shown', ui(rec).alert.hidden === false);
		check('and the caller was told', rec.lost.join() === 'unreachable', rec.lost.join());
		const before = env.made.length;
		ui(rec).s0.fire('click');                          // the already-selected channel
		check('pressing it restarts the chain', env.made.length === before + 1,
			env.made.length + '');
		check('and the alert is cleared', ui(rec).alert.hidden === true);
	}

	group('the software ladder runs five deep through the component, then the alert');
	{
		const env = load({ preferred: 'mse', wasmOk: true, config: { video0: { codec: 'h265' } } });
		const rec = env.mount();
		env.made[0].say('mjpeg', 'unreachable');           // mse -> wasm
		check('the software decoder was tried', env.made[1] && env.made[1].kind === 'wasm',
			env.made.map((p) => p.kind).join(','));
		for (let n = 1; n <= 5; n++) {
			env.made[env.made.length - 1].say('mjpeg', 'unreachable');
			check('drop ' + n + ' schedules a retry after ' + n + ' s',
				env.pendingMs().join() === String(1000 * n), env.pendingMs().join());
			env.fire();
			check('drop ' + n + ' started another software player',
				env.made[env.made.length - 1].kind === 'wasm', env.made[env.made.length - 1].kind);
		}
		check('no alert while the ladder had budget', ui(rec).alert.hidden === true);
		env.made[env.made.length - 1].say('mjpeg', 'unreachable');   // the sixth
		check('the spent ladder reaches the alert', ui(rec).alert.hidden === false);
		check('and the caller was told', rec.lost[rec.lost.length - 1] === 'unreachable',
			rec.lost.join());
	}

	group('only the on-screen software attachment refills the retry budget');
	{
		// Reach a live wasm session that has already spent one retry.
		function toRetriedWasm() {
			const env = load({ preferred: 'mse', wasmOk: true, config: { video0: { codec: 'h265' } } });
			env.mount();
			env.made[0].say('mjpeg', 'unreachable');       // -> wasm (made[1])
			env.made[1].say('mjpeg', 'unreachable');       // schedules retry (budget 1)
			env.fire();                                    // -> wasm (made[2]), live
			return env;
		}
		const a = toRetriedWasm();
		const live = a.made[a.made.length - 1];
		live.opts.onStats({ transport: 'wasm', framesDecoded: 5000 });
		live.opts.onStats({ transport: 'wasm', framesDecoded: 5008 });   // +8 -> refill
		live.say('mjpeg', 'unreachable');
		check('after the on-screen session decoded enough, the ladder is fresh (1 s)',
			a.pendingMs().join() === '1000', a.pendingMs().join());

		const b = toRetriedWasm();
		const stale = b.made[1];                           // the superseded attachment
		stale.opts.onStats({ transport: 'wasm', framesDecoded: 99999 });
		b.made[b.made.length - 1].say('mjpeg', 'unreachable');
		check('a stale attachment\'s stats do not refill it (2 s)',
			b.pendingMs().join() === '2000', b.pendingMs().join());
	}

	group('a served-channel mismatch moves the picker and shows the toast');
	{
		const env = load({ preferred: 'webrtc' });
		const rec = env.mount();
		const u = ui(rec);
		check('the picker starts on Main', u.radios[0].checked === true && u.radios[1].checked === false);
		env.made[0].opts.onServed({ channel: 1, requested: 0, reason: 'undecodable' });
		check('the radios move to the served channel', u.radios[1].checked === true &&
			u.radios[0].checked === false);
		check('the toast is shown', u.msg.hidden === false);
		check('and it names the served channel', /Sub/.test(u.msgWhy.textContent), u.msgWhy.textContent);
		// A reopen answered with the ADOPTED channel while the viewer's own ask
		// (Main) is still unmet leaves the explanation standing.
		env.made[0].opts.onServed({ channel: 1, requested: 1, reason: '' });
		check('a match to the adopted channel leaves the toast up', u.msg.hidden === false);
		// The camera finally serves what the viewer asked for: now it clears.
		env.made[0].opts.onServed({ channel: 0, requested: 0, reason: '' });
		check('a match to the viewer\'s own ask hides the toast', u.msg.hidden === true);
	}

	group('the frame contract: adopt once live, forget on a channel change');
	{
		const env = load({ preferred: 'mse' });
		const rec = env.mount();
		env.made[0].opts.onCodec('h265', '', 1920, 1080);
		check('the frame is published once', rec.frames.length === 1 &&
			rec.frames[0].w === 1920 && rec.frames[0].codec === 'h265', JSON.stringify(rec.frames));
		check('and frame() reports it', rec.h.frame() && rec.h.frame().h === 1080);
		const gen = rec.h.generation();
		rec.h.setStream(1);                                // a real channel move
		check('the frame is forgotten', rec.h.frame() === null);
		check('the caller heard the null', rec.frames[rec.frames.length - 1] === null);
		check('and the generation advanced', rec.h.generation() > gen);
		// Internal state is not enough: the picture only moves if the live
		// player is told to resubscribe. A goToStream that updated the radios
		// but stopped forwarding would leave the transport on the old channel.
		check('the live player was resubscribed to the new channel',
			env.made[env.made.length - 1].streamSet === 1,
			env.made[env.made.length - 1].streamSet + '');
	}

	group('syncConfig follows the substream appearing and vanishing');
	{
		const cfg = { config: { video1: { enabled: true } }, preferred: 'mse', chosenStream: 1 };
		const env = load(cfg);
		const rec = env.mount();
		const u = ui(rec);
		check('the Sub radio is enabled while the substream exists', u.radios[1].disabled === false);
		check('and the picture is on Sub', rec.h.stream() === 1, rec.h.stream() + '');
		cfg.config.video1.enabled = false;
		rec.h.syncConfig();
		check('the Sub radio is disabled once it is gone', u.radios[1].disabled === true);
		check('and the picture moved to Main', rec.h.stream() === 0, rec.h.stream() + '');
		// And the live player was actually resubscribed, not just the radio —
		// a vanished substream that only updated the control would leave the
		// transport delivering nothing.
		check('the live player was moved to Main', env.made[env.made.length - 1].streamSet === 0,
			env.made[env.made.length - 1].streamSet + '');
	}

	group('destroy cancels a pending retry and tears the stage down');
	{
		const env = load({ preferred: 'mse', wasmOk: true, config: { video0: { codec: 'h265' } } });
		const rec = env.mount();
		env.made[0].say('mjpeg', 'unreachable');           // -> wasm
		env.made[1].say('mjpeg', 'unreachable');           // schedules a retry
		check('a retry is pending', env.pendingMs().length === 1, env.pendingMs().join());
		rec.h.destroy();
		check('destroy cancelled it', env.pendingMs().length === 0);
		check('and removed the stage from the host', rec.host.children.length === 0);

		// And with a live player: it is destroyed too.
		const env2 = load({ preferred: 'mse' });
		const rec2 = env2.mount();
		env2.made[0].say('playing');
		rec2.h.destroy();
		check('a live player is destroyed on teardown', env2.made[0].destroyed === true);
		check('the stage is gone', rec2.host.children.length === 0);
	}

	done();
})();
