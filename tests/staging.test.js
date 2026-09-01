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
const SRCS = [A('preview-swap.js'), A('preview-page.js')];

const IDS = [
	'live-mjpeg', 'live-video', 'live-video-b', 'live-canvas', 'live-canvas-b',
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
	return { mse: impl('mse'), webrtc: impl('webrtc'), wasm: impl('wasm') };
}

// `cfg` is a flat map of dotted keys, or omitted for the historic behaviour:
// a config that never lands. Most tests want that — a config arriving would
// re-attach underneath the players they are driving by hand — but the fallback
// reads jpeg.enabled and behaves differently on each answer, so it needs one.
// `cfgDelay` puts the answer past the page's CONFIG_WAIT_MS deadline, which is
// the case where jpegOn is false only because nothing is known yet.
function load(pickedTransport, cfg, cfgDelay, wasmOk) {
	const env = { made: [], els: {} };
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
		MajesticTransport: {
			available: () => true,
			preferred: () => pickedTransport || 'mse',
			choose(k) { env.chosen = k; }, demote() { env.demoted = true; },
			impl: (k) => (k === 'webrtc' ? impls.webrtc : impls.mse),
			iceServers: () => [],
			// The real rule lives in preview-transport.js and is tested there;
			// this mirrors it so the page's chain can be driven here.
			softwareRungFor: (d) => {
				const bits = String(d || '').split(' ');
				const w = win.MajesticWasm;
				return bits[0] === 'undecodable' &&
					!!(w && w.available && w.handles && w.handles(bits[1]));
			},
			chosenStream: () => null, chooseStream() {},
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
		apiFetch: () => Promise.reject(new Error('no network in tests')),
		setTimeout, clearTimeout, setInterval, clearInterval,
		Promise: Promise,
	};
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(SRCS[0], 'utf8'), ctx);
	// The browser reaches window.MajesticSwap through the global scope; a vm
	// context has no such link, so hand it over explicitly.
	ctx.MajesticSwap = win.MajesticSwap;
	vm.runInContext(fs.readFileSync(SRCS[1], 'utf8'), ctx);
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
	group('at the end of the chain, with an MJPEG channel to fall back to');
	{
		const env = load('mse', { 'jpeg.enabled': true });
		await tick();
		const first = env.made[0];
		// The chip is filled the way the real MSE player fills it: the codec
		// arrives from the init message, and only then is the mime refused.
		first.opts.onCodec('h265', 'hvc1.1.6.L120.90', 3840, 2160);
		first.say('mjpeg', 'undecodable h265');

		check('the fallback picture is up',
			env.el('live-mjpeg').src === '/mjpeg', env.el('live-mjpeg').src);
		check('the chip names it', env.el('mj-badge').textContent === 'MJPEG',
			env.el('mj-badge').textContent);
		check('the message says why, in words',
			env.el('mj-served').hidden === false &&
			/can.t decode/.test(env.el('mj-served-why').textContent),
			env.el('mj-served-why').textContent);
		check('and names the codec the browser refused',
			/H265/.test(env.el('mj-served-why').textContent),
			env.el('mj-served-why').textContent);
		check('the note stays down — the fallback is the explanation now',
			env.el('mj-note').style.display === 'none');

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

	group('the transport the fallback came through can be pressed again');
	{
		const env = load('mse', { 'jpeg.enabled': true });
		await tick();
		env.made[0].say('mjpeg', 'unreachable');
		check('nothing is lit, so a press is a real change',
			env.el('mj-transport-m').checked === false);
		// What a browser does when the label is clicked.
		env.el('mj-transport-m').checked = true;
		env.el('mj-transport-m').fire('change');
		check('MSE was tried again', env.made.length === 2,
			'made=' + env.made.length);
		check('and the picture is held while it is judged',
			env.el('live-mjpeg').src === '/mjpeg', env.el('live-mjpeg').src);
		env.made[1].say('playing');
		check('and once it works the fallback picture is gone',
			env.el('live-mjpeg').src === '', env.el('live-mjpeg').src);
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
			env.el('live-mjpeg').src === '/mjpeg', env.el('live-mjpeg').src);
		env.made[1].say('playing');
		check('handed over only once the replacement has one of its own',
			env.el('live-mjpeg').src === '', env.el('live-mjpeg').src);
	}

	// showFallback() stops the swap, so there is no live entry left for it to
	// protect and the next attach is promoted the instant it is made. Without
	// this the retry traded a working picture for a black stage and a
	// negotiation that could still fail.
	group('a retry does not cost the viewer the picture they had');
	{
		const env = load('mse', { 'jpeg.enabled': true });
		await tick();
		env.made[0].say('mjpeg', 'undecodable h265');
		// The transport group is unlit, so this is what a press looks like.
		env.el('mj-transport-w').checked = true;
		env.el('mj-transport-w').fire('change');
		check('a player was made', env.made.length === 2);
		check('the MJPEG picture is still up',
			env.el('live-mjpeg').style.display === '',
			env.el('live-mjpeg').style.display);
		check('and the chip says so, and that it is trying',
			env.el('mj-badge').textContent === 'MJPEG · retrying…',
			env.el('mj-badge').textContent);
		// Everything short of a picture must leave the stage alone.
		env.made[1].say('connecting');
		env.made[1].say('nosignal');
		check('a connecting attempt does not take the picture',
			env.el('live-mjpeg').style.display === '',
			env.el('live-mjpeg').style.display);
		check('nor rewrite the chip out from under it',
			env.el('mj-badge').textContent === 'MJPEG · retrying…',
			env.el('mj-badge').textContent);
		// And when it fails, the fallback simply carries on.
		env.made[1].say('fallback', 'no usable H.264 in the offer');
		check('the MSE attempt that follows is made', env.made.length === 3);
		env.made[2].say('mjpeg', 'undecodable h265');
		check('the picture was never interrupted',
			env.el('live-mjpeg').style.display === '',
			env.el('live-mjpeg').style.display);
		check('and the chip is back to naming it plainly',
			env.el('mj-badge').textContent === 'MJPEG',
			env.el('mj-badge').textContent);
	}

	// Two ways an unproven promotion used to let a session with no picture
	// speak for the stage: the chip and the served-channel answer.
	group('a retry says nothing until it has a picture');
	{
		const env = load('webrtc', { 'jpeg.enabled': true });
		await tick();
		// The real sequence to the floor, now that the chain is a walk rather
		// than a pair of tests: WebRTC gives up with `fallback` (it has no
		// concept of `mjpeg`), MSE is tried and refuses the codec, and with no
		// software rung available that is the end of it.
		env.made[0].say('fallback', 'no usable H.264 in the offer');
		env.made[1].say('mjpeg', 'undecodable h265');
		env.el('mj-stream-0').fire('click');
		const retry = env.made[2];
		check('the retry is in flight', env.made.length === 3,
			'made=' + env.made.length);

		// The camera answers the offer before any media arrives, and says it
		// is serving the other channel.
		retry.opts.onServed({ channel: 1, requested: 0, reason: 'unavailable' });
		check('the radios have not moved for a session with no picture',
			env.el('mj-stream-0').checked === true &&
			env.el('mj-stream-1').checked === false);
		check('and the fallback still owns the message',
			/can.t decode/.test(env.el('mj-served-why').textContent),
			env.el('mj-served-why').textContent);

		// MSE reports its codec once, from the init message, before playing.
		retry.opts.onCodec('h264', 'avc1.640028', 640, 360);
		check('the chip still describes the stage, not the attempt',
			env.el('mj-badge').textContent === 'MJPEG · retrying…',
			env.el('mj-badge').textContent);

		// And now it plays: everything held is adopted at once.
		retry.say('playing');
		check('the picture is handed over',
			env.el('live-mjpeg').src === '', env.el('live-mjpeg').src);
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
		await tick();
		const live = env.made[0];
		live.say('playing');
		env.el('mj-served').hidden = true;
		live.opts.onServed({ channel: 1, requested: 0, reason: 'unavailable' });
		check('the mismatch message is up', env.el('mj-served').hidden === false);
		live.say('fallback', 'media stopped arriving');
		env.made[1].say('mjpeg', 'undecodable h265');
		check('and it is replaced, not left standing over the fallback',
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

	// jpegOn is false before the config lands as well as when JPEG is off, and
	// the first attach does not wait for the config past CONFIG_WAIT_MS.
	group('a config that lands after the fallback re-decides it');
	{
		const env = load('mse', { 'jpeg.enabled': true }, 2600);
		await tick();
		env.made[0].say('mjpeg', 'undecodable h265');
		check('with nothing known, it says unavailable and offers the remedy',
			env.el('mj-badge').textContent === 'unavailable' &&
			env.el('mj-note').style.display === '',
			env.el('mj-badge').textContent);
		await new Promise((r) => setTimeout(r, 1600));
		check('once the camera answers, the picture it could show is shown',
			env.el('live-mjpeg').src === '/mjpeg', env.el('live-mjpeg').src);
		check('the chip names it', env.el('mj-badge').textContent === 'MJPEG',
			env.el('mj-badge').textContent);
		check('and the note that offered a remedy it did not need is down',
			env.el('mj-note').style.display === 'none');
		check('nothing was re-attached behind it', env.made.length === 1,
			'made=' + env.made.length);
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

	group('the rung is not taken for a failure that is not about the codec');
	{
		for (const reason of ['unreachable', 'no-mse', 'mse-error']) {
			const env = load('mse', { 'jpeg.enabled': true }, 0, true);
			await tick();
			env.made[0].say('mjpeg', reason);
			check('`' + reason + '` goes straight to MJPEG',
				env.made.length === 1 && env.el('live-mjpeg').src === '/mjpeg',
				'made=' + env.made.length);
		}
	}

	group('the rung is not taken for a codec it cannot decode');
	{
		const env = load('mse', { 'jpeg.enabled': true }, 0, true);
		await tick();
		// A browser refusing H.264 High 10 reports the same code. Sending that
		// to an H.265 decoder would be a slower way to fail.
		env.made[0].say('mjpeg', 'undecodable h264');
		check('h264 does not launch the H.265 decoder',
			env.made.length === 1, 'made=' + env.made.length);
		check('and the fallback is up', env.el('live-mjpeg').src === '/mjpeg');
	}

	group('the software rung is never tried twice');
	{
		const env = load('mse', { 'jpeg.enabled': true }, 0, true);
		await tick();
		env.made[0].say('mjpeg', 'undecodable h265');
		const wasm = env.made[1];
		wasm.say('playing');
		// Its own failure has already been through both transports.
		wasm.say('mjpeg', 'undecodable h265');
		check('it falls to MJPEG rather than round again',
			env.made.length === 2 && env.el('live-mjpeg').src === '/mjpeg',
			'made=' + env.made.length);
	}

	// The disclosure is latched so it is not raised twice in one session. That
	// latch has to die with the session, or the NEXT software session plays
	// with nothing saying so — which is the one thing this rung must not do.
	group('the software-decode disclosure returns after a fallback');
	{
		const env = load('mse', { 'jpeg.enabled': true }, 0, true);
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
		check('the fallback took the stage',
			env.el('live-mjpeg').src === '/mjpeg', env.el('live-mjpeg').src);

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

	done();
})();
