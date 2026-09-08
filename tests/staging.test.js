// preview-page.js's transport switch, driven against stub players.
//
// The rule under test is one sentence: nothing on screen changes until the
// replacement has a picture. Everything here is a way of checking that the
// page does not tear down a working player before it knows.
//
// It is worth the harness because this page has twice shipped the opposite
// bug — a fallback burying the player that was working — and both times the
// picture looked right while the handle was wrong, which is exactly what a
// human glance cannot catch.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const A = (f) => path.join(__dirname, '..', 'www', 'a', f);
// The swap machinery is a module of its own now; the page is what decides what
// its outcomes mean, and that division is part of what these check.
const SRCS = [A('preview-swap.js'), A('preview-served.js'), A('preview-chain.js'),
	A('preview-page.js')];

const IDS = [
	'live-mjpeg', 'live-mjpeg-b',
	'live-video', 'live-video-b', 'live-canvas', 'live-canvas-b',
	'mj-source', 'mj-note-act', 'mj-preview-boot',
	'mj-audio-ctl', 'mj-badge',
	'mj-lightmon', 'mj-mute', 'mj-mute-lbl', 'mj-mute-t', 'mj-note',
	'mj-note-why', 'mj-stats',
	'mj-stats-btn', 'mj-stats-ctl', 'mj-stream-0', 'mj-stream-1',
	'mj-stream-auto', 'mj-auto',
	'mj-served', 'mj-served-why', 'mj-sub',
	'mj-talk', 'mj-talk-ctl', 'mj-talk-lbl', 'mj-talk-t', 'mj-transport-w',
	'mj-transport-m', 'mj-transport-ctl', 'mj-transport-lbl',
	'mj-vol', 'mj-player', 'mj-stage',
	'toggle-ircut', 'toggle-light', 'toggle-night',
];

// Ask the page for a transport directly, bypassing the (now disabled) radio —
// the point being that the guard holds wherever the request comes from.
function attachAs(env, kind) {
	env.el('mj-transport-' + (kind === 'webrtc' ? 'w' : 'm')).checked = true;
	env.el('mj-transport-' + (kind === 'webrtc' ? 'w' : 'm')).fire('change');
}

// The user picks WebRTC on the segmented control. The stub elements are not a
// real radio group, so the sibling is unchecked by hand as a browser would.
function pickWebRTC(env) {
	env.el('mj-transport-w').checked = true;
	env.el('mj-transport-m').checked = false;
	env.el('mj-transport-w').fire('change');
}

function makeEl(id) {
	return {
		id: id, style: {}, hidden: false, checked: false, disabled: false,
		// Enough of a container for the source chooser, which is built in JS
		// because most cameras have one source and markup for a picker nobody
		// can use is markup that has to stay hidden correctly for ever.
		kids: [],
		appendChild(n) { this.kids.push(n); },
		clientWidth: 640, clientHeight: 360,
		textContent: '', title: '', value: 100, src: '', srcObject: null,
		handlers: {},
		addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); },
		removeAttribute() { this.src = ''; },
		fire(ev) { (this.handlers[ev] || []).forEach((f) => f()); },
	};
}

// A player stub that records what was done to it and lets the test drive its
// state callbacks by hand — the states are the whole subject here.
function makePlayers(env) {
	function impl(kind) {
		return {
			attach(el, opts) {
				// The real MSE player replaces its element on every reconnect
				// (cloneNode plus replaceChild, keeping the id), so anything
				// holding the old node is holding a detached one. Model that.
				if (kind === 'mse') el = env.replaceNode(el.id);
				const p = {
					kind: kind, el: el, destroyed: false, opts: opts,
					streamSet: null, audioCalls: 0,
					setStream(n) { this.streamSet = n; },
					setVolume() {}, setMic() {},
					setAudio() { this.audioCalls++; },
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
	return {
		mse: impl('mse'), webrtc: impl('webrtc'), wasm: impl('wasm'),
		multipart: impl('multipart'),
	};
}

// `cfg` is a flat map of dotted keys, or omitted for the historic behaviour:
// a config that never lands. Most tests want that — a config arriving would
// re-attach underneath the players they are driving by hand — but the fallback
// reads jpeg.enabled and behaves differently on each answer, so it needs one.
// `cfgDelay` puts the answer past the page's CONFIG_WAIT_MS deadline, which is
// the case where jpegOn is false only because nothing is known yet.
// `srcs` is the /api/v1/sources answer, or omitted for one that never lands —
// which is most tests here, and is also a real camera on a slow link. The page
// has to be able to play without it: the on-board camera is what the config
// describes, and the chooser is the only thing that waits.
// `srcDelay` puts that answer after the chain has already run out, which is the
// case where the bottom rung could not have been known about in time.
// `store` is a browser's localStorage, shared when a test needs a second page
// load to inherit what the first one wrote — which is what "remembered" means.
function load(pickedTransport, cfg, cfgDelay, wasmOk, srcs, srcDelay, store) {
	const env = { made: [], els: {}, storage: store || {} };
	IDS.forEach((id) => { env.els['#' + id] = makeEl(id); });
	// Swap in a fresh node under the same id, as replaceChild does.
	env.replaceNode = (id) => {
		const fresh = makeEl(id);
		fresh.style = Object.assign({}, env.els['#' + id].style);
		env.els['#' + id] = fresh;
		return fresh;
	};
	const impls = makePlayers(env);

	const win = {
		// The page follows the window for its Auto source, so the stub needs a
		// listener registry and a size the elements can be measured against.
		listeners: {},
		addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
		fire(ev) { (this.listeners[ev] || []).forEach((f) => f()); },
		devicePixelRatio: 1,
		MajesticVideo: impls.mse,
		MajesticWebRTC: impls.webrtc,
		// Absent unless a test asks for it, which is also the real camera with
		// no route to the CDN: the rung is simply not there and the chain is
		// what it always was. Every group written for #279/#280 depends on
		// that, since they all reach MJPEG through `undecodable h265`.
		MajesticWasm: wasmOk ? Object.assign({}, impls.wasm, {
			available: true,
			handles: (c) => /^h265$|^hevc$/i.test(String(c || '')),
		}) : undefined,
		// The real decision module. A stub would let the page and the rules
		// disagree about what a source's streams are, which is the drift
		// mj-sources.js exists to prevent.
		MajesticSources: require(path.join(__dirname, '..', 'www', 'a', 'mj-sources.js')),
		MajesticTransport: {
			available: () => true,
			preferred: () => pickedTransport || 'mse',
			choose(k) { env.chosen = k; }, demote() { env.demoted = true; },
			durable: (s) => s === 'fallback',
			impl: (k) => (impls[k] || impls.mse),
			iceServers: () => [],
			// The real rule lives in preview-transport.js and is tested there;
			// this mirrors it so the page's chain can be driven here.
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
			chosenStream: () => null, chooseStream() {},
			// The bottom rung's gate. Off by default: these tests are about
			// what the page does when the chain runs out, and a camera with an
			// MJPEG stream has one more rung to try first. The tests that want
			// that rung set env.multipart.
			multipartRungFor: () => env.multipart === true,
		},
	};

	const ctx = {
		window: win,
		MajesticSwap: null,   // preview-swap.js assigns it onto window below
		console: console,
		MajesticVideo: impls.mse,
		MajesticWebRTC: impls.webrtc,
		MajesticWasm: win.MajesticWasm,
		MajesticTransport: win.MajesticTransport,
		$: (sel) => env.els[sel],
		// Never resolves unless a test asked for one: every test here drives
		// the players directly, and a config that landed would re-attach
		// underneath them. When one is supplied it wins the first attach's
		// race, so nothing re-attaches later either.
		mjConfig: () => (cfg
			? (cfgDelay
				? new Promise((r) => setTimeout(() => r(cfg), cfgDelay))
				: Promise.resolve(cfg))
			: new Promise(() => {})),
		mjGet: (c, k) => (cfg ? cfg[k] : undefined),
		mjSources: () => (srcs
			? (srcDelay
				? new Promise((r) => setTimeout(() => r(srcs), srcDelay))
				: Promise.resolve(srcs))
			: new Promise(() => {})),
		// Enough of one to build the chooser's radios in. The page appends
		// them to #mj-source, which is one of the stub elements above.
		document: {
			createElement: (tag) => Object.assign(makeEl(''), {
				tag: tag, dataset: {}, className: '', htmlFor: '',
				appendChild() {},
			}),
		},
		localStorage: {
			store: env.storage,
			getItem(k) { return k in this.store ? this.store[k] : null; },
			setItem(k, v) { this.store[k] = String(v); },
		},
		apiFetch: () => Promise.reject(new Error('no network in tests')),
		setTimeout, clearTimeout, setInterval, clearInterval,
		Promise: Promise,
	};
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(SRCS[0], 'utf8'), ctx);
	// The browser reaches window.MajesticSwap through the global scope; a vm
	// context has no such link, so hand it over explicitly.
	ctx.MajesticSwap = win.MajesticSwap;
	// Then the rest in order — preview-served.js and preview-chain.js
	// (window.MajesticServed / window.MajesticChain, which preview-page.js
	// reaches through window, no hand-over needed) and the page. The chain
	// reads MajesticTransport at call time, so the stub above is what it asks.
	for (let i = 1; i < SRCS.length; i++) {
		vm.runInContext(fs.readFileSync(SRCS[i], 'utf8'), ctx);
	}
	env.el = (id) => env.els['#' + id];
	return env;
}

// Longer than preview-page.js's CONFIG_WAIT_MS: the first attach waits for
// the config fetch or that deadline, whichever comes first, and here the fetch
// never lands on purpose.
const tick = () => new Promise((r) => setTimeout(r, 1700));

(async () => {
	// The first attach has nothing to protect, so it goes straight on screen.
	group('the first attach goes live immediately');
	{
		const env = load('mse');
		await tick();
		check('one player was made', env.made.length === 1, env.made.length + '');
		check('it took the visible element',
			env.made[0] && env.made[0].el.id === 'live-video');
	}

	group('switching transport does not disturb what is playing');
	{
		const env = load('mse');
		await tick();
		const first = env.made[0];
		first.say('playing');

		// The user picks WebRTC.
		pickWebRTC(env);

		check('a second player was made', env.made.length === 2);
		const trial = env.made[1];
		check('on the spare element, not the visible one',
			trial && trial.el.id === 'live-video-b', trial && trial.el.id);
		check('the working player is still alive', !first.destroyed);
		check('and still owns the visible element', first.el.id === 'live-video');

		// Everything short of success must stay invisible.
		trial.say('connecting');
		trial.say('nosignal');
		check('a trial connecting changes nothing', !first.destroyed);
		check('and does not touch the badge',
			env.el('mj-badge').textContent === '', env.el('mj-badge').textContent);
	}

	group('a trial that fails leaves the screen alone');
	{
		const env = load('mse');
		await tick();
		const first = env.made[0];
		first.say('playing');
		pickWebRTC(env);
		const trial = env.made[1];

		trial.say('fallback', 'no usable H.264 in the offer');
		check('the trial was destroyed', trial.destroyed);
		check('the working player was NOT', !first.destroyed);
		check('the picker came back to MSE',
			env.el('mj-transport-w').checked === false &&
			env.el('mj-transport-m').checked === true);
		check('and the reason is on the label',
			/no usable H.264/.test(env.el('mj-transport-lbl').title),
			env.el('mj-transport-lbl').title);
		check('a refusal is remembered', env.demoted === true);
	}

	group('a trial that works takes over, and only then');
	{
		const env = load('mse');
		await tick();
		const first = env.made[0];
		first.say('playing');
		pickWebRTC(env);
		const trial = env.made[1];

		check('nothing destroyed yet', !first.destroyed);
		trial.say('playing');
		check('now the old player goes', first.destroyed);
		check('the trial survives', !trial.destroyed);
		check('the old element is hidden',
			first.el.style.display === 'none', first.el.style.display);
		check('and the new one is shown',
			trial.el.style.display === '', trial.el.style.display);
	}

	group('a busy camera is not remembered as a refusal');
	{
		const env = load('mse');
		await tick();
		env.made[0].say('playing');
		pickWebRTC(env);
		env.made[1].say('busy', 'the camera is serving as many viewers as it can');
		check('the working player is untouched', !env.made[0].destroyed);
		check('and no demotion was recorded', env.demoted !== true);
	}

	group('a live WebRTC session that goes busy stages MSE without a demotion');
	{
		// The live-player mid-session path, distinct from the trial-drop above:
		// a live WebRTC player reports 'busy'. It stages MSE like a 'fallback'
		// does, but 'busy' is transient, so nothing is remembered (#402).
		const env = load('webrtc');
		await tick();
		env.made[0].say('playing');
		env.made[0].say('busy', 'the camera is serving as many viewers as it can');
		check('a replacement was staged', env.made.length === 2, env.made.length + '');
		check('and it is MSE', env.made[1].kind === 'mse', env.made[1].kind);
		check('but no demotion was recorded', env.demoted !== true);
		check('the MSE radio is lit meanwhile',
			env.el('mj-transport-m').checked === true &&
			env.el('mj-transport-w').checked === false);
	}

	group('when the live player dies and its replacement fails too');
	{
		const env = load('webrtc');
		await tick();
		const first = env.made[0];
		check('started on WebRTC', first.kind === 'webrtc', first.kind);
		first.say('playing');

		// The session dies mid-watch.
		first.say('fallback', 'media stopped arriving');
		check('a replacement was staged', env.made.length === 2);
		const second = env.made[1];
		check('the replacement is MSE', second.kind === 'mse', second.kind);
		check('the dead player still holds the screen for now', !first.destroyed);

		// And MSE cannot run either.
		second.say('mjpeg', 'undecodable h265');
		check('the dead player is finally released', first.destroyed);
		check('the failed replacement too', second.destroyed);
		// No JPEG channel on this camera, so there is no picture to fall
		// through to and the chip must not name a format nothing is sending.
		check('the chip says the stream is unavailable',
			env.el('mj-badge').textContent === 'unavailable',
			env.el('mj-badge').textContent);
		check('the note is showing', env.el('mj-note').style.display === '',
			env.el('mj-note').style.display);
		check('and it carries the reason, codec and all',
			/H265/.test(env.el('mj-note-why').textContent),
			env.el('mj-note-why').textContent);
		check('neither transport is lit any more',
			env.el('mj-transport-w').checked === false &&
			env.el('mj-transport-m').checked === false);
		// #269: what the page REMEMBERS about this browser, which nothing on
		// screen can correct. The MSE failure arrives after WebRTC has been
		// retired, and onFailed used to read that retired entry as "WebRTC is
		// still playing" — writing the permanent choice key from a failure
		// path and wiping the six-hour demotion recorded moments before. The
		// browser then re-ran the whole failing negotiation on every load, for
		// ever, because a stored choice outranks a demotion and demote() will
		// not overwrite one.
		check('the refusal is still what is remembered', env.demoted === true);
		check('and nothing was recorded as the viewer’s own choice',
			env.chosen === undefined, String(env.chosen));
	}

	// #274: the page reached the end of the chain and went on describing the
	// session it had lost — MJPEG on the chip, MSE still lit, no reason given
	// anywhere, and a press of Main repainting the chip with the codec of the
	// stream that had just failed.
	group('at the end of the chain, with an MJPEG stream to fall to');
	{
		const env = load('mse', { 'jpeg.enabled': true });
		// The camera has an MJPEG stream. That used to be read off
		// jpeg.enabled; it is now the daemon's own answer, because the stream
		// may belong to a camera other than the on-board one.
		env.multipart = true;
		await tick();
		const first = env.made[0];
		// The chip is filled the way the real MSE player fills it: the codec
		// arrives from the init message, and only then is the mime refused.
		first.opts.onCodec('h265', 'hvc1.1.6.L120.90', 3840, 2160);
		first.say('mjpeg', 'undecodable h265');

		// The MJPEG picture is a RUNG now — staged on an idle element and
		// promoted when it has a picture, like every other transport — rather
		// than an <img> src written from the fallback path outside the swap.
		check('the MJPEG rung was tried',
			env.made.length === 2 && env.made[1].kind === 'multipart',
			'made=' + env.made.map(p => p.kind).join(','));
		// Whichever img slot was idle — the failed MSE player still occupies
		// the other one until this is promoted.
		check('on an img element, not a video',
			/^live-mjpeg(-b)?$/.test(env.made[1].el.id), env.made[1].el.id);
		check('and asked for this camera',
			env.made[1].opts.camera === 0, String(env.made[1].opts.camera));

		env.made[1].opts.onCodec('mjpeg', 'mjpeg', 1280, 720);
		env.made[1].say('playing');
		check('the chip names it, with the geometry the image had',
			env.el('mj-badge').textContent === 'MJPEG 1280×720',
			env.el('mj-badge').textContent);
		check('the message says why, in words',
			env.el('mj-served').hidden === false &&
			/can.t decode/.test(env.el('mj-served-why').textContent),
			env.el('mj-served-why').textContent);
		check('and names the codec the browser refused',
			/H265/.test(env.el('mj-served-why').textContent),
			env.el('mj-served-why').textContent);
		check('the note stays down — there is a picture to look at',
			env.el('mj-note').style.display === 'none');
		// Reached rather than chosen, so it lights neither radio — which is
		// what makes a press of either one a real change event and a real retry.
		check('and neither transport is lit',
			env.el('mj-transport-w').checked === false &&
			env.el('mj-transport-m').checked === false);

		// The regression in the report: this repainted the chip from the
		// failed stream's codec, over the MJPEG label, while MJPEG played.
		const made = env.made.length;
		env.el('mj-stream-0').fire('change');
		check('picking a channel does not repaint the chip with a dead codec',
			env.el('mj-badge').textContent !== 'H265 3840×2160',
			env.el('mj-badge').textContent);
		check('it retries the chain instead of doing nothing',
			env.made.length === made + 1,
			'made=' + env.made.length);
		check('and the retried player is asked for that channel',
			env.made[made].opts.stream === 0,
			String(env.made[made].opts.stream));
		check('the dead player was not reopened',
			first.streamSet === null, 'streamSet=' + first.streamSet);
	}

	group('the transport the MJPEG rung replaced can be pressed again');
	{
		const env = load('mse', { 'jpeg.enabled': true });
		env.multipart = true;
		await tick();
		env.made[0].say('mjpeg', 'unreachable');
		env.made[1].say('playing');
		check('the MJPEG rung has the stage', env.made[1].kind === 'multipart');
		check('nothing is lit, so a press is a real change',
			env.el('mj-transport-m').checked === false);
		// What a browser does when the label is clicked.
		env.el('mj-transport-m').checked = true;
		env.el('mj-transport-m').fire('change');
		check('MSE was tried again', env.made.length === 3,
			'made=' + env.made.length);
		// The rung is a live player like any other now, so the swap's own rule
		// protects it: nothing on screen changes until the replacement works.
		check('and the picture is held while it is judged',
			env.made[1].destroyed === false);
		env.made[2].say('playing');
		check('and once it works the MJPEG player is dropped',
			env.made[1].destroyed === true);
		check('with the message withdrawn', env.el('mj-served').hidden === true);
		check('and the picker naming what is playing',
			env.el('mj-transport-m').checked === true);
	}

	// Radios fire no change event when the one already selected is pressed, so
	// a retry hung only off the change handler could be reached solely by
	// asking for a channel the viewer did not want.
	group('pressing the channel already selected is the retry');
	{
		const env = load('mse', { 'jpeg.enabled': true });
		await tick();
		env.made[0].say('mjpeg', 'undecodable h265');
		check('Main is still lit — it is what was asked for',
			env.el('mj-stream-0').checked === true);
		// A press of the lit radio: click only, no change, as a browser does.
		env.el('mj-stream-0').fire('click');
		check('the chain was started again', env.made.length === 2,
			'made=' + env.made.length);
		check('on the same channel', env.made[1].opts.stream === 0,
			String(env.made[1].opts.stream));
		check('and the picture is held for the attempt',
			env.el('mj-note').style.display === '');
		env.made[1].say('playing');
		check('handed over only once the replacement has one of its own',
			env.el('mj-note').style.display === 'none');
	}

	// showFallback() stops the swap, so there is no live entry left for it to
	// protect and the next attach is promoted the instant it is made. Without
	// this the retry traded a working picture for a black stage and a
	// negotiation that could still fail.
	// The rule the swap exists to enforce, applied to the rung that used to be
	// outside it: nothing on screen changes until the replacement works. When
	// the MJPEG picture was written from the fallback path, showFallback() had
	// stopped the swap — so there was no live entry to protect and the next
	// attach was promoted the instant it was made, trading a working picture
	// for a black stage and a negotiation that could still fail. As a rung it
	// is a live player and gets the protection for free.
	group('a retry does not cost the viewer the picture they had');
	{
		const env = load('mse', { 'jpeg.enabled': true });
		env.multipart = true;
		await tick();
		env.made[0].say('mjpeg', 'undecodable h265');
		const mjpeg = env.made[1];
		mjpeg.opts.onCodec('mjpeg', 'mjpeg', 1280, 720);
		mjpeg.say('playing');
		check('the MJPEG rung has the stage', mjpeg.kind === 'multipart');

		// The transport group is unlit, so this is what a press looks like.
		env.el('mj-transport-w').checked = true;
		env.el('mj-transport-w').fire('change');
		check('a player was made', env.made.length === 3);
		check('the MJPEG picture is still up', mjpeg.destroyed === false);
		check('and the chip still names it',
			env.el('mj-badge').textContent === 'MJPEG 1280×720',
			env.el('mj-badge').textContent);
		// Everything short of a picture must leave the stage alone.
		env.made[2].say('connecting');
		env.made[2].say('nosignal');
		check('a connecting attempt does not take the picture',
			mjpeg.destroyed === false);
		check('nor rewrite the chip out from under it',
			env.el('mj-badge').textContent === 'MJPEG 1280×720',
			env.el('mj-badge').textContent);
		// And when it fails, the picture simply carries on.
		env.made[2].say('fallback', 'no usable H.264 in the offer');
		check('the MSE attempt that follows is made', env.made.length === 4);
		env.made[3].say('mjpeg', 'undecodable h265');
		check('the picture was never interrupted', mjpeg.destroyed === false);
		check('and the chip is still naming it',
			env.el('mj-badge').textContent === 'MJPEG 1280×720',
			env.el('mj-badge').textContent);
	}

	// Two ways an unproven promotion used to let a session with no picture
	// speak for the stage: the chip and the served-channel answer.
	group('a retry says nothing until it has a picture');
	{
		const env = load('webrtc', { 'jpeg.enabled': true });
		env.multipart = true;
		await tick();
		// The real sequence to the floor, now that the chain is a walk rather
		// than a pair of tests: WebRTC gives up with `fallback` (it has no
		// concept of `mjpeg`), MSE is tried and refuses the codec, and with no
		// software rung available the MJPEG rung is what is left.
		env.made[0].say('fallback', 'no usable H.264 in the offer');
		env.made[1].say('mjpeg', 'undecodable h265');
		const mjpeg = env.made[2];
		mjpeg.opts.onCodec('mjpeg', 'mjpeg', 1280, 720);
		mjpeg.say('playing');
		env.el('mj-stream-0').fire('click');
		const retry = env.made[3];
		check('the retry is in flight', env.made.length === 4,
			'made=' + env.made.length);

		// The camera answers the offer before any media arrives, and says it
		// is serving the other channel.
		retry.opts.onServed({ channel: 1, requested: 0, reason: 'unavailable' });
		check('the radios have not moved for a session with no picture',
			env.el('mj-stream-0').checked === true &&
			env.el('mj-stream-1').checked === false);
		check('and the explanation for the MJPEG picture still stands',
			/can.t decode/.test(env.el('mj-served-why').textContent),
			env.el('mj-served-why').textContent);

		// MSE reports its codec once, from the init message, before playing.
		retry.opts.onCodec('h264', 'avc1.640028', 640, 360);
		check('the chip still describes the stage, not the attempt',
			env.el('mj-badge').textContent === 'MJPEG 1280×720',
			env.el('mj-badge').textContent);

		// And now it plays: everything held is adopted at once.
		retry.say('playing');
		check('the picture is handed over', mjpeg.destroyed === true);
		check('the chip names what is actually playing',
			/H264 640/.test(env.el('mj-badge').textContent),
			env.el('mj-badge').textContent);
		check('and the radios follow the camera now that there is a picture',
			env.el('mj-stream-1').checked === true);
	}

	// The served-channel answer belonged to the session that died. settle()
	// only clears it on a promotion to MSE, so a retry that landed back on
	// WebRTC used to inherit it.
	group('the camera\u2019s served answer does not outlive its session');
	{
		const env = load('webrtc', { 'jpeg.enabled': true });
		env.multipart = true;
		await tick();
		const live = env.made[0];
		live.say('playing');
		env.el('mj-served').hidden = true;
		live.opts.onServed({ channel: 1, requested: 0, reason: 'unavailable' });
		check('the mismatch message is up', env.el('mj-served').hidden === false);
		live.say('fallback', 'media stopped arriving');
		env.made[1].say('mjpeg', 'undecodable h265');
		env.made[2].say('playing');
		check('and it is replaced, not left standing over the MJPEG picture',
			env.el('mj-served').hidden === false &&
			/can.t decode/.test(env.el('mj-served-why').textContent),
			env.el('mj-served-why').textContent);
	}

	group('a channel that does move retries exactly once');
	{
		const env = load('mse', { 'jpeg.enabled': true });
		await tick();
		env.made[0].say('mjpeg', 'undecodable h265');
		// The browser order for a radio that moves: click, then change.
		env.el('mj-stream-1').fire('click');
		env.el('mj-stream-1').fire('change');
		check('one new player, not two', env.made.length === 2,
			'made=' + env.made.length);
		check('asked for Sub', env.made[1].opts.stream === 1,
			String(env.made[1].opts.stream));
		// The change handler still runs goToStream(), which reaches the new
		// player — but only ever for the channel it was just opened with, and
		// both players no-op setStream() for the channel they already have.
		check('and never for a channel it was not opened on',
			env.made[1].streamSet === null || env.made[1].streamSet === 1,
			'streamSet=' + env.made[1].streamSet);
	}

	group('Auto retries even when it picks the stream already set');
	{
		const env = load('mse', { 'jpeg.enabled': true });
		await tick();
		env.made[0].say('mjpeg', 'undecodable h265');
		// autoApply() returns before goToStream() when its pick equals the
		// current stream, so the change handler alone would do nothing.
		env.el('mj-stream-auto').fire('click');
		check('the chain was started again', env.made.length === 2,
			'made=' + env.made.length);
	}

	// The bottom rung is gated on the camera's own list of sources, and the
	// first attach does not wait for that fetch. Until it lands there is no way
	// to know an MJPEG stream exists to fall to — so a camera whose answer is
	// slow would sit on the note with a picture available, which is what the
	// re-decide is for. (It used to be gated on jpeg.enabled, which could not
	// speak for a stream belonging to a second camera.)
	group('a sources answer that lands after the chain ran out re-decides it');
	{
		const SRCS = [{
			camera: 0, kind: 'sensor', streams: [
				{ id: 2, subtype: 2, codec: 'mjpeg', present: true,
					configured: true, rtsp: false },
			],
		}];
		// The page's own gate, not the stub: this group is about the gate
		// changing its mind when the list arrives.
		const env = load('mse', { 'jpeg.enabled': true }, 0, false, SRCS, 2400);
		env.multipart = null;   // decided by the list below
		await tick();
		env.made[0].say('mjpeg', 'undecodable h265');
		check('with nothing known, it says unavailable and offers the remedy',
			env.el('mj-badge').textContent === 'unavailable' &&
			env.el('mj-note').style.display === '',
			env.el('mj-badge').textContent);

		env.multipart = true;
		await new Promise((r) => setTimeout(r, 1200));
		check('once the camera answers, the rung it could not know about is tried',
			env.made.length === 2 && env.made[1].kind === 'multipart',
			'made=' + env.made.map(p => p.kind).join(','));
		env.made[1].opts.onCodec('mjpeg', 'mjpeg', 1280, 720);
		env.made[1].say('playing');
		check('the chip names it',
			env.el('mj-badge').textContent === 'MJPEG 1280×720',
			env.el('mj-badge').textContent);
		check('and the note that offered a remedy it did not need is down',
			env.el('mj-note').style.display === 'none');
	}

	// The software-decode rung: WebRTC -> MSE -> wasm -> MJPEG, entered only
	// when the BROWSER refused the codec and only for a codec it can take.
	group('a browser that cannot decode the stream gets the software rung');
	{
		const env = load('mse', { 'jpeg.enabled': true }, 0, true);
		await tick();
		env.made[0].say('mjpeg', 'undecodable h265');
		check('a third player was made', env.made.length === 2,
			'made=' + env.made.length);
		check('and it is the software decoder',
			env.made[1] && env.made[1].kind === 'wasm', env.made[1] && env.made[1].kind);
		check('the fallback picture is not up yet',
			env.el('live-mjpeg').src === '', env.el('live-mjpeg').src);
		// It rides the MSE socket, so MSE is what is carrying the picture.
		env.made[1].say('playing');
		check('MSE stays lit, because that is the transport underneath',
			env.el('mj-transport-m').checked === true &&
			env.el('mj-transport-w').checked === false);
	}

	group('a non-codec failure on a natively-playable channel goes to MJPEG');
	{
		// The channel is H.264, which the browser plays natively, so none of
		// these — a socket that would not stay open, no MSE, a source-buffer
		// refusal — is worth handing to the H.265 software decoder.
		for (const reason of ['unreachable', 'no-mse', 'mse-error']) {
			const env = load('mse',
				{ 'jpeg.enabled': true, 'video0.codec': 'h264' }, 0, true);
			env.multipart = true;
			await tick();
			env.made[0].say('mjpeg', reason);
			check('`' + reason + '` on H.264 goes straight to MJPEG',
				env.made.length === 2 && env.made[1].kind === 'multipart',
				'made=' + env.made.map(p => p.kind).join(','));
		}
	}

	// The #288 hardening: MSE could not hold the socket long enough to read a
	// codec ('unreachable'), but the config says the channel is H.265 — a codec
	// the software decoder handles — so its own socket is worth a try before
	// MJPEG, rather than stranding a remote viewer on the worst option.
	group('an unreachable socket on a configured software codec tries the decoder');
	{
		const env = load('mse',
			{ 'jpeg.enabled': true, 'video0.codec': 'h265' }, 0, true);
		await tick();
		env.made[0].say('mjpeg', 'unreachable');
		check('the software decoder is tried, not MJPEG',
			env.made.length === 2 && env.made[1] && env.made[1].kind === 'wasm',
			'made=' + env.made.length + ' kind=' + (env.made[1] && env.made[1].kind));
		check('and no fallback picture went up', env.el('live-mjpeg').src === '');
		env.made[1].say('playing');
		check('when it plays, MSE stays lit as the transport underneath',
			env.el('mj-transport-m').checked === true);
	}

	// #288: the software rung has a reconnect ladder of its own now — a dropped
	// socket is retried, not read as "software decode is done" and dropped to
	// MJPEG. A working player was the whole point of the rung; one blip must not
	// end it. (The worker retries internally too, hevc-wasm@v0.1.1; this page
	// ladder backs an older pinned worker that gives up on the first drop.)
	group('a software socket drop retries the rung before MJPEG');
	{
		const env = load('mse',
			{ 'jpeg.enabled': true, 'video0.codec': 'h265' }, 0, true);
		await tick();
		env.made[0].say('mjpeg', 'unreachable');
		const wasm = env.made[1];
		check('the decoder was tried', wasm && wasm.kind === 'wasm');
		wasm.say('playing');           // it was working
		// Its socket drops mid-session. The old behaviour fell straight to MJPEG.
		wasm.say('mjpeg', 'unreachable');
		check('no MJPEG yet — the drop is being retried',
			env.el('live-mjpeg').src === '', env.el('live-mjpeg').src);
		await new Promise((r) => setTimeout(r, 1200));
		check('a fresh software player was made for the retry',
			env.made.length === 3 && env.made[2].kind === 'wasm',
			'made=' + env.made.length);
		// The retry catches: a picture is back, and the ladder resets so the
		// next drop gets the full budget again.
		env.made[2].say('playing');
		check('the recovered picture is on the stage, not MJPEG',
			env.el('live-mjpeg').src === '');
	}

	group('a software rung that keeps dropping falls to MJPEG, bounded');
	{
		const env = load('mse',
			{ 'jpeg.enabled': true, 'video0.codec': 'h265' }, 0, true);
		env.multipart = true;
		await tick();
		env.made[0].say('mjpeg', 'unreachable');   // -> wasm made[1]
		// Every retry also drops, before ever showing a picture. The ladder is
		// five deep (1s..5s) — long enough to outlast a daemon restart — so drive
		// that many drops and let each timer fire, then one more to spend it.
		let made = 2;
		for (let i = 1; i <= 5; i++) {
			env.made[env.made.length - 1].say('mjpeg', 'unreachable');
			await new Promise((r) => setTimeout(r, 1000 * i + 200));
			check('retry ' + i + ' made a fresh software player',
				env.made.length === made + 1 && env.made[made].kind === 'wasm',
				'made=' + env.made.length);
			made = env.made.length;
		}
		// The fourth drop is past the budget: now it gives up to MJPEG rather
		// than retry for ever.
		env.made[env.made.length - 1].say('mjpeg', 'unreachable');
		check('the ladder is spent, so the MJPEG rung takes the stage',
			env.made.length === made + 1 &&
			env.made[made].kind === 'multipart',
			'made=' + env.made.map(p => p.kind).join(','));
		check('and it stopped making software players',
			env.made.filter(p => p.kind === 'wasm').length === made - 1,
			'made=' + env.made.length);
	}

	// A retry scheduled from a superseded session must not fire a software
	// player over a newer one the viewer just chose (#288).
	group('a pending software retry does not override a transport change');
	{
		const env = load('mse',
			{ 'jpeg.enabled': true, 'video0.codec': 'h265' }, 0, true);
		await tick();
		env.made[0].say('mjpeg', 'unreachable');   // -> wasm made[1]
		env.made[1].say('playing');
		env.made[1].say('mjpeg', 'unreachable');  // schedules a wasm retry
		const before = env.made.length;
		// The viewer picks WebRTC while that retry is pending.
		pickWebRTC(env);
		const afterPick = env.made[env.made.length - 1];
		check('the transport choice attached its own player',
			afterPick && afterPick.kind === 'webrtc', afterPick && afterPick.kind);
		// Long enough that the stale retry timer would have fired.
		await new Promise((r) => setTimeout(r, 1400));
		check('the stale retry did not start another software player',
			env.made.length === before + 1 &&
			env.made[env.made.length - 1].kind === 'webrtc',
			'made=' + env.made.length + ' last=' + env.made[env.made.length - 1].kind);
	}

	group('the rescue needs the decoder to actually be present');
	{
		// Same unreachable H.265 channel, but no software decoder in the page
		// (an offline camera, the common case) — straight to MJPEG.
		const env = load('mse',
			{ 'jpeg.enabled': true, 'video0.codec': 'h265' }, 0, false);
		env.multipart = true;
		await tick();
		env.made[0].say('mjpeg', 'unreachable');
		check('with no decoder it goes to MJPEG',
			env.made.length === 2 && env.made[1].kind === 'multipart',
			'made=' + env.made.map(p => p.kind).join(','));
	}

	// The socket can give up before the config fetch lands — the same flaky
	// link slows both — so the rescue has to be reconsidered when the codec
	// finally becomes known, not only at the moment of failure.
	group('a late config that reveals a software codec takes the rescue');
	{
		const env = load('mse',
			{ 'jpeg.enabled': true, 'video0.codec': 'h265' }, 2600, true);
		await tick();
		env.made[0].say('mjpeg', 'unreachable');
		check('with no codec known yet, it falls to the picture',
			env.made.length === 1, 'made=' + env.made.length);
		await new Promise((r) => setTimeout(r, 1600));
		check('once the config reveals H.265, the decoder is tried',
			env.made.length === 2 && env.made[1] && env.made[1].kind === 'wasm',
			'made=' + env.made.length + ' kind=' + (env.made[1] && env.made[1].kind));
	}

	group('the rung is not taken for a codec it cannot decode');
	{
		const env = load('mse', { 'jpeg.enabled': true }, 0, true);
		env.multipart = true;
		await tick();
		// A browser refusing H.264 High 10 reports the same code. Sending that
		// to an H.265 decoder would be a slower way to fail.
		env.made[0].say('mjpeg', 'undecodable h264');
		check('h264 does not launch the H.265 decoder',
			env.made.every(p => p.kind !== 'wasm'),
			env.made.map(p => p.kind).join(','));
		check('and the MJPEG rung is what took the stage',
			env.made.length === 2 && env.made[1].kind === 'multipart',
			env.made.map(p => p.kind).join(','));
	}

	group('the software rung is never tried twice');
	{
		const env = load('mse', { 'jpeg.enabled': true }, 0, true);
		env.multipart = true;
		await tick();
		env.made[0].say('mjpeg', 'undecodable h265');
		const wasm = env.made[1];
		wasm.say('playing');
		// Its own failure has already been through both transports.
		wasm.say('mjpeg', 'undecodable h265');
		check('it falls to MJPEG rather than round again',
			env.made.length === 3 && env.made[2].kind === 'multipart',
			env.made.map(p => p.kind).join(','));
	}

	// The disclosure is latched so it is not raised twice in one session. That
	// latch has to die with the session, or the NEXT software session plays
	// with nothing saying so — which is the one thing this rung must not do.
	group('the software-decode disclosure returns after a fallback');
	{
		const env = load('mse', { 'jpeg.enabled': true }, 0, true);
		env.multipart = true;
		await tick();
		env.made[0].say('mjpeg', 'undecodable h265');
		const wasm = env.made[1];
		wasm.say('playing');
		wasm.opts.onStats({ transport: 'wasm', width: 1920, height: 1080,
			framesDecoded: 100, framesDropped: 0, queuedMs: 50 });
		check('it says software decoding is happening',
			/decoding it in software/.test(env.el('mj-served-why').textContent),
			env.el('mj-served-why').textContent);

		// The session dies and the chain runs out.
		wasm.say('mjpeg', 'decoder-error');
		check('the MJPEG rung took the stage',
			env.made[env.made.length - 1].kind === 'multipart',
			env.made.map(p => p.kind).join(','));
		env.made[env.made.length - 1].say('playing');

		// A retry gets back to software decode.
		env.el('mj-stream-0').fire('click');
		const again = env.made[env.made.length - 1];
		again.say('playing');
		again.opts.onStats({ transport: 'wasm', width: 1920, height: 1080,
			framesDecoded: 100, framesDropped: 0, queuedMs: 50 });
		check('and it says so again',
			/decoding it in software/.test(env.el('mj-served-why').textContent),
			env.el('mj-served-why').textContent);
	}

	// A channel change can change the codec, and the failure that put us on the
	// software rung was about the channel we just left. An H.264 substream
	// plays natively, so falling to MJPEG there would hand the viewer the worst
	// option available for a stream the browser decodes perfectly.
	group('a codec change asks the whole chain again, not the floor');
	{
		const env = load('mse', { 'jpeg.enabled': true }, 0, true);
		await tick();
		env.made[0].say('mjpeg', 'undecodable h265');
		const wasm = env.made[1];
		check('the software rung took it', wasm.kind === 'wasm', wasm.kind);
		wasm.say('playing');
		// The viewer picks a channel the camera encodes as H.264.
		wasm.say('mjpeg', 'codec-changed h264');
		const after = env.made[env.made.length - 1];
		check('a fresh attempt was made, not a fallback',
			env.made.length === 3 && env.el('live-mjpeg').src === '',
			'made=' + env.made.length + ' img=' + env.el('live-mjpeg').src);
		check('and it starts from a real transport, not the rung again',
			after.kind !== 'wasm', after.kind);
	}

	group('a cloned MSE element does not strand the swap');
	{
		const env = load('mse');
		await tick();
		const first = env.made[0];
		first.say('playing');
		// MSE has since replaced its node; the swap must not be holding the
		// detached one when it picks a spare.
		check('the live player is on the current node',
			first.el === env.el('live-video'), 'stale');

		pickWebRTC(env);
		const trial = env.made[1];
		check('the trial went to the spare, not the visible element',
			trial.el.id === 'live-video-b', trial.el.id);

		trial.say('playing');
		check('and the promoted one is visible',
			env.el('live-video-b').style.display === '',
			env.el('live-video-b').style.display);
		check('while the old node is hidden',
			env.el('live-video').style.display === 'none',
			env.el('live-video').style.display);
	}

	group('a trial is opened with the audio already wanted');
	{
		const env = load('mse');
		await tick();
		env.made[0].say('playing');
		// The viewer is listening.
		env.el('mj-mute').checked = true;
		env.el('mj-mute').fire('change');

		pickWebRTC(env);
		const trial = env.made[1];
		check('the trial negotiates audio from the start',
			trial.opts.audio === true, JSON.stringify(trial.opts.audio));
		trial.say('playing');
		// setAudio after promotion would renegotiate a session that just
		// proved itself, which is the flicker coming back by another route.
		check('and is not told to turn audio on afterwards',
			trial.audioCalls === undefined || trial.audioCalls === 0,
			String(trial.audioCalls));
	}

	group('a stream change reaches the trial as well');
	{
		const env = load('mse');
		await tick();
		env.made[0].say('playing');
		pickWebRTC(env);
		const trial = env.made[1];
		env.el('mj-stream-1').fire('change');
		check('the live player followed the viewer to Sub',
			env.made[0].streamSet === 1, 'live=' + env.made[0].streamSet);
		check('the trial followed the viewer to Sub',
			trial.streamSet === 1, 'trial=' + trial.streamSet);
	}

	group('a served mismatch moves the radios without cutting anything');
	{
		// The camera's `served` reply moves the radios by writing .checked,
		// which fires no change event. The regression this guards: a reflect
		// that re-entered goToStream() would setStream() the session that
		// just answered — cutting it — and could loop against the camera's
		// next fallback.
		const env = load('webrtc');
		await tick();
		const live = env.made[0];
		live.say('playing');
		const before = env.made.length;
		env.el('mj-stream-0').checked = true;
		// As the markup ships it, so "is up" below means it was shown here.
		env.el('mj-served').hidden = true;
		live.opts.onServed({ channel: 1, requested: 0, reason: 'unavailable' });
		check('the radios follow the camera',
			env.el('mj-stream-1').checked === true &&
			env.el('mj-stream-0').checked === false);
		check('the session was not re-cut', live.streamSet === null,
			'streamSet=' + live.streamSet);
		check('no new player was made', env.made.length === before,
			'made=' + env.made.length);
		check('the message is up', env.el('mj-served').hidden === false);
	}


	// --- more than one source ---
	//
	// A camera is not always one camera: majestic can carry a second sensor or
	// publish a USB webcam as a second camera, both addressed as
	// stream_id = 3*camera + subtype. The page showed one, because until
	// /api/v1/sources there was no way for it to learn about the other.
	// `subtype` as the wire spells it — a name, not an index. Written with
	// integers, these fixtures agreed with a module that was reading them the
	// same wrong way, and a camera whose every stream was healthy reported none
	// to watch.
	const SENSOR = {
		camera: 0, kind: 'sensor', streams: [
			{ id: 0, subtype: 'main', codec: 'h264', present: true, configured: true, rtsp: true },
			{ id: 1, subtype: 'sub', codec: 'h264', present: true, configured: true, rtsp: true },
			{ id: 2, subtype: 'mjpeg', codec: 'mjpeg', present: true, configured: true, rtsp: false },
		],
	};
	const USB = {
		camera: 1, kind: 'external', streams: [
			{ id: 5, subtype: 'mjpeg', codec: 'mjpeg', present: true, configured: true, rtsp: false },
		],
	};

	group('one source builds no chooser');
	{
		const env = load('mse', { 'jpeg.enabled': true }, 0, false, [SENSOR]);
		await tick();
		check('nothing was appended', env.el('mj-source').kids.length === 0);
		check('and the container stays out of the way',
			env.el('mj-source').hidden === true);
	}

	group('a second source is offered');
	{
		const env = load('mse', { 'jpeg.enabled': true }, 0, false, [SENSOR, USB]);
		env.multipart = true;
		await tick();
		const box = env.el('mj-source');
		check('a button per source', box.kids.filter(k => k.tag === 'input').length === 2,
			String(box.kids.length));
		check('and the chooser is shown', box.hidden === false);
		check('named from the camera\u2019s own locale file, with no ordinal ' +
			'where the kind is unique',
			box.kids.filter(k => k.tag === 'label')
				.map(k => k.textContent).join(',') === 'Sensor,USB camera',
			box.kids.filter(k => k.tag === 'label').map(k => k.textContent).join(','));
		check('the on-board one is what is playing', env.made[0].opts.stream === 0,
			String(env.made[0].opts.stream));
	}

	group('choosing the second source restarts the chain on it');
	{
		const env = load('mse', { 'jpeg.enabled': true }, 0, false, [SENSOR, USB]);
		env.multipart = true;
		await tick();
		const made = env.made.length;
		const inputs = env.el('mj-source').kids.filter(k => k.tag === 'input');
		inputs[1].checked = true;
		inputs[1].fire('change');

		// From the top of the chain, not by retargeting: a different source can
		// be a different codec, a different transport family, even a different
		// element — an MJPEG webcam is an <img> where an H.264 one is a <video>.
		check('a fresh player was attached', env.made.length === made + 1,
			'made=' + env.made.length);
		// And on the transport this source's codec implies. Starting at the top
		// asked the daemon for a stream_id WebRTC cannot serve, and it answered
		// with a channel of the on-board camera — so pressing "USB camera"
		// showed the sensor, over a toast about the sub stream.
		check('on the rung its codec implies, not the top of the ladder',
			env.made[made].kind === 'multipart', env.made[made].kind);
		// The webcam publishes only MJPEG, so its stream_id is 3*1 + 2.
		check('asked for that camera\u2019s stream',
			env.made[made].opts.stream === 5,
			String(env.made[made].opts.stream));

		// One stream and no channel to pick between, so the Main/Sub controls
		// go away rather than sit there doing nothing.
		check('the channel radios are unavailable',
			env.el('mj-stream-0').disabled === true &&
			env.el('mj-stream-1').disabled === true);
		check('and none of them claims to be playing',
			env.el('mj-stream-0').checked === false &&
			env.el('mj-stream-1').checked === false);
		check('Auto has nothing to decide either',
			env.el('mj-stream-auto').disabled === true &&
			env.el('mj-auto').hidden === true);
	}

	// A clamp is what one source can do, not a change of mind. The webcam
	// publishes only MJPEG, so selecting it forces subtype 2 — and writing that
	// back into the preference meant coming home to the SENSOR's subtype 2, its
	// 5 fps JPEG channel, on the MJPEG rung. The viewer had been on Main over
	// WebRTC a moment earlier and got that back instead.
	group('coming back from a source that forced a channel');
	{
		const env = load('webrtc', { 'jpeg.enabled': true, 'video1.enabled': true },
			0, false, [SENSOR, USB]);
		env.multipart = true;
		await tick();
		const first = env.made[env.made.length - 1];
		check('the sensor opens on a NAL transport', first.kind === 'webrtc',
			first.kind);

		const inputs = env.el('mj-source').kids.filter(k => k.tag === 'input');
		inputs[1].checked = true;
		inputs[1].fire('change');
		const onUsb = env.made[env.made.length - 1];
		check('the webcam opens on the MJPEG rung', onUsb.kind === 'multipart',
			onUsb.kind);
		check('on its own stream', onUsb.opts.stream === 5,
			String(onUsb.opts.stream));

		inputs[0].checked = true;
		inputs[0].fire('change');
		const back = env.made[env.made.length - 1];
		check('coming back does NOT land on the sensor\u2019s JPEG channel',
			back.opts.stream !== 2, String(back.opts.stream));
		check('it restores the channel the viewer had chosen',
			back.opts.stream === first.opts.stream,
			back.opts.stream + ' vs ' + first.opts.stream);
		check('and the transport its codec implies, not the floor',
			back.kind !== 'multipart', back.kind);
	}

	// Reported by a maintainer against the lab camera: with the built-in sensor
	// WebRTC and MSE work; selecting the webcam un-selects both; pressing MSE
	// does nothing; pressing WebRTC switches back to the built-in sensor. All
	// three are the picker not following the source — it named two transports
	// that cannot carry an MJPEG-only stream, so one was inert and the other
	// answered with a different CAMERA.
	group('the transport picker follows the source');
	{
		const env = load('webrtc', { 'jpeg.enabled': true, 'video1.enabled': true },
			0, false, [SENSOR, USB]);
		env.multipart = true;
		await tick();
		check('both transports are offered for the sensor',
			env.el('mj-transport-w').disabled === false &&
			env.el('mj-transport-m').disabled === false);

		const inputs = env.el('mj-source').kids.filter(k => k.tag === 'input');
		inputs[1].checked = true;
		inputs[1].fire('change');

		// Not merely unlit, which reads as broken. Unavailable, the same answer
		// the Main/Sub radios give for a source with one stream.
		check('neither is offered for an MJPEG-only source',
			env.el('mj-transport-w').disabled === true &&
			env.el('mj-transport-m').disabled === true);
		check('and the label says why',
			/MJPEG only/.test(env.el('mj-transport-lbl').title),
			env.el('mj-transport-lbl').title);

		// Belt and braces: whatever asks, a NAL transport is not sent at a
		// source that has no NAL stream. WebRTC would have been answered with
		// camera 0 — the viewer pressing a TRANSPORT and getting a different
		// CAMERA is the report.
		const made = env.made.length;
		attachAs(env, 'webrtc');
		check('asking for WebRTC anyway does not leave this source',
			env.made.length === made + 1 &&
			env.made[made].kind === 'multipart' &&
			env.made[made].opts.stream === 5,
			env.made[made] && (env.made[made].kind + '/' + env.made[made].opts.stream));

		inputs[0].checked = true;
		inputs[0].fire('change');
		check('and they come back with a source that has NAL streams',
			env.el('mj-transport-w').disabled === false &&
			env.el('mj-transport-m').disabled === false);
	}

	group('a remembered source comes back');
	{
		const env = load('mse', { 'jpeg.enabled': true }, 0, false, [SENSOR, USB]);
		env.multipart = true;
		await tick();
		const inputs = env.el('mj-source').kids.filter(k => k.tag === 'input');
		inputs[1].checked = true;
		inputs[1].fire('change');

		// A second page load on the same browser, inheriting what the first
		// one wrote.
		const again = load('mse', { 'jpeg.enabled': true }, 0, false,
			[SENSOR, USB], 0, env.storage);
		again.multipart = true;
		await tick();
		check('it opens on the webcam',
			again.made[again.made.length - 1].opts.stream === 5,
			String(again.made[again.made.length - 1].opts.stream));
	}

	group('a source that has been unplugged is not waited for');
	{
		// The choice was remembered while the webcam was there; it is not now.
		// Falling back to the on-board camera beats an error about a camera
		// that is gone — the viewer still has a picture either way.
		const env = load('mse', { 'jpeg.enabled': true }, 0, false, [SENSOR], 0,
			{ 'mj-preview-source': '1' });
		await tick();
		check('the on-board camera is what plays',
			env.made[env.made.length - 1].opts.stream === 0,
			String(env.made[env.made.length - 1].opts.stream));
		check('and no chooser is built for a set of one',
			env.el('mj-source').hidden === true);
	}

	done();
})();
