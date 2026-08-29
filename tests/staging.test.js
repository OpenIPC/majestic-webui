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

const SRC = path.join(__dirname, '..', 'www', 'a', 'preview-page.js');

const IDS = [
	'live-mjpeg', 'live-video', 'live-video-b', 'mj-audio-ctl', 'mj-badge',
	'mj-lightmon', 'mj-mute', 'mj-mute-lbl', 'mj-note', 'mj-stats',
	'mj-stats-btn', 'mj-stats-ctl', 'mj-stream-0', 'mj-stream-1', 'mj-sub',
	'mj-talk', 'mj-talk-ctl', 'mj-talk-lbl', 'mj-transport',
	'mj-transport-ctl', 'mj-transport-lbl', 'mj-transport-note', 'mj-vol',
	'toggle-ircut', 'toggle-light', 'toggle-night',
];

function makeEl(id) {
	return {
		id: id, style: {}, hidden: false, checked: false, disabled: false,
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
				const p = {
					kind: kind, el: el, destroyed: false, opts: opts,
					setStream() {}, setVolume() {}, setAudio() {}, setMic() {},
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
	const impls = makePlayers(env);

	const win = {
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
	vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx);
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

		// The user ticks WebRTC.
		env.el('mj-transport').checked = true;
		env.el('mj-transport').fire('change');

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
		env.el('mj-transport').checked = true;
		env.el('mj-transport').fire('change');
		const trial = env.made[1];

		trial.say('fallback', 'no usable H.264 in the offer');
		check('the trial was destroyed', trial.destroyed);
		check('the working player was NOT', !first.destroyed);
		check('the toggle came back off', env.el('mj-transport').checked === false);
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
		env.el('mj-transport').checked = true;
		env.el('mj-transport').fire('change');
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
		env.el('mj-transport').checked = true;
		env.el('mj-transport').fire('change');
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

	done();
})();
