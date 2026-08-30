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
	'live-mjpeg', 'live-video', 'live-video-b', 'mj-audio-ctl', 'mj-badge',
	'mj-lightmon', 'mj-mute', 'mj-mute-lbl', 'mj-mute-t', 'mj-note', 'mj-stats',
	'mj-stats-btn', 'mj-stats-ctl', 'mj-stream-0', 'mj-stream-1', 'mj-sub',
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
	return { mse: impl('mse'), webrtc: impl('webrtc') };
}

function load(pickedTransport) {
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
		MajesticTransport: {
			available: () => true,
			preferred: () => pickedTransport || 'mse',
			choose() {}, demote() { env.demoted = true; },
			impl: (k) => (k === 'webrtc' ? impls.webrtc : impls.mse),
			iceServers: () => [],
			chosenStream: () => null, chooseStream() {},
		},
	};

	const ctx = {
		window: win,
		MajesticSwap: null,   // preview-swap.js assigns it onto window below
		console: console,
		MajesticVideo: impls.mse,
		MajesticWebRTC: impls.webrtc,
		MajesticTransport: win.MajesticTransport,
		$: (sel) => env.els[sel],
		// Never resolves: every test here drives the players directly, and a
		// config that landed would re-attach underneath them.
		mjConfig: () => new Promise(() => {}),
		mjGet: () => undefined,
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
		second.say('mjpeg');
		check('the dead player is finally released', first.destroyed);
		check('the failed replacement too', second.destroyed);
		check('and the page falls through to MJPEG',
			env.el('mj-badge').textContent === 'MJPEG',
			env.el('mj-badge').textContent);
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

	done();
})();
