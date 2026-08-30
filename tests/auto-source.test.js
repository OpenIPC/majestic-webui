// The Auto source rule: pick the stream closest to the size the player is
// drawn at, and follow the window without cutting the session every frame.
//
// Tested here rather than by eye because both halves are invisible when they
// go wrong: a rule that picks by width instead of area is right about half the
// time, and a rate limit that drops changes instead of deferring them leaves
// the wrong stream up until the window happens to move again.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const A = (f) => path.join(__dirname, '..', 'www', 'a', f);
const SRCS = [A('preview-swap.js'), A('preview-page.js')];

const IDS = [
	'live-mjpeg', 'live-video', 'live-video-b', 'mj-audio-ctl', 'mj-badge',
	'mj-lightmon', 'mj-mute', 'mj-mute-lbl', 'mj-note', 'mj-stats',
	'mj-stats-btn', 'mj-stats-ctl', 'mj-stream-0', 'mj-stream-1',
	'mj-stream-auto', 'mj-auto', 'mj-sub', 'mj-talk', 'mj-talk-ctl',
	'mj-talk-lbl', 'mj-transport-w', 'mj-transport-m', 'mj-transport-ctl',
	'mj-transport-lbl', 'mj-transport-note', 'mj-note-close', 'mj-vol',
	'mj-player', 'mj-stage', 'toggle-ircut', 'toggle-light', 'toggle-night',
];

function makeEl(id) {
	return {
		id: id, style: {}, hidden: false, checked: false, disabled: false,
		textContent: '', title: '', value: 100, src: '', srcObject: null,
		clientWidth: 640, clientHeight: 360, handlers: {},
		addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); },
		removeAttribute() { this.src = ''; },
		fire(ev) { (this.handlers[ev] || []).forEach((f) => f()); },
	};
}

// cfg: { box: [w,h], main: 'WxH', sub: 'WxH', subEnabled: bool, picked: choice }
function load(cfg) {
	const env = { made: [], els: {}, observed: [] };
	IDS.forEach((id) => { env.els['#' + id] = makeEl(id); });
	// As the markup ships them: the Sub and Auto labels start hidden and are
	// revealed only where a second stream exists.
	['mj-sub', 'mj-auto'].forEach((id) => { env.els['#' + id].hidden = true; });
	// And as the markup ships the inputs: unreachable until the configuration
	// says there is a second stream.
	['mj-stream-1', 'mj-stream-auto'].forEach((id) => {
		env.els['#' + id].disabled = true;
	});
	if (cfg.box) {
		// The stage is what Auto measures (the viewport clamp can leave it
		// narrower than #mj-player); the video elements are sized by the
		// stream, which is exactly why they are not the input.
		['mj-stage', 'mj-player', 'live-video', 'live-video-b'].forEach((id) => {
			env.els['#' + id].clientWidth = cfg.box[0];
			env.els['#' + id].clientHeight = cfg.box[1];
		});
	}

	function impl(kind) {
		return {
			attach(el, opts) {
				const p = {
					kind: kind, el: el, destroyed: false, opts: opts,
					streamSet: null,
					setStream(n) { this.streamSet = n; },
					setVolume() {}, setAudio() {}, setMic() {},
					audioSupported: () => true, micSupported: () => true,
					destroy() { this.destroyed = true; },
					say(s, d) { opts.onState(s, d); },
				};
				env.made.push(p);
				return p;
			},
			available: kind === 'webrtc',
		};
	}
	const impls = { mse: impl('mse'), webrtc: impl('webrtc') };

	// `|| default` would turn an intentionally empty size back into a set one,
	// which is exactly the case the unset-Main test exists for.
	const conf = {
		'video1.enabled': cfg.subEnabled !== false,
		'video0.size': cfg.main === undefined ? '1920x1080' : cfg.main,
		'video1.size': cfg.sub === undefined ? '640x360' : cfg.sub,
	};

	const win = {
		listeners: {},
		addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
		fire(ev) { (this.listeners[ev] || []).forEach((f) => f()); },
		MajesticVideo: impls.mse,
		MajesticWebRTC: impls.webrtc,
		MajesticTransport: {
			available: () => true, preferred: () => 'mse',
			choose() {}, demote() {},
			impl: (k) => (k === 'webrtc' ? impls.webrtc : impls.mse),
			iceServers: () => [],
			chosenStream: () => (cfg.picked === undefined ? null : cfg.picked),
			chooseStream(where, n) { env.stored = n; },
		},
	};

	const ctx = {
		window: win, console: console,
		// The page prefers this over the window event, so the stub has to
		// provide it or the tests would only ever cover the fallback.
		ResizeObserver: function (fn) {
			this.observe = function (el) { env.observed.push(el); win.roFire = fn; };
			this.disconnect = function () {};
		},
		MajesticVideo: impls.mse, MajesticWebRTC: impls.webrtc,
		MajesticTransport: win.MajesticTransport,
		$: (sel) => env.els[sel],
		// Delayed when a test needs to act in the window before the
		// configuration lands — which is where the "selected an invisible
		// control" case lives.
		mjConfig: () => (cfg.configDelay
			? new Promise((r) => setTimeout(() => r(conf), cfg.configDelay))
			: Promise.resolve(conf)),
		mjGet: (c, k) => c[k],
		apiFetch: () => Promise.reject(new Error('no network in tests')),
		setTimeout, clearTimeout, setInterval, clearInterval, Promise: Promise,
	};
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(SRCS[0], 'utf8'), ctx);
	ctx.MajesticSwap = win.MajesticSwap;
	vm.runInContext(fs.readFileSync(SRCS[1], 'utf8'), ctx);
	env.el = (id) => env.els['#' + id];
	env.win = win;
	return env;
}

const tick = (n) => new Promise((r) => setTimeout(r, n || 60));

(async () => {
	group('a stream narrower than the box loses, however its area compares');
	{
		// This is the case that used to oscillate. By rendered area the 704x576
		// substream looked like the better fit at 800px wide — and picking it
		// changed the element's height, which pointed back at Main, once a
		// second for ever. A stream narrower than the box is being upscaled,
		// which is the one thing worth avoiding, so it loses.
		const env = load({
			box: [800, 450], main: '1280x720', sub: '704x576', picked: 'auto',
		});
		await tick();
		check('took Main', env.made[0].opts.stream === 0,
			'stream=' + env.made[0].opts.stream);
	}

	group('area breaks a tie between equally wide streams');
	{
		// Where the reporter's point still applies: same width, different
		// picture, so one dimension cannot separate them and the smaller of the
		// two at or above the box wins.
		const env = load({
			box: [800, 450], main: '1280x720', sub: '1280x960', picked: 'auto',
		});
		await tick();
		check('took the smaller-area stream', env.made[0].opts.stream === 0,
			'stream=' + env.made[0].opts.stream);
	}

	group('a box larger than both takes the largest');
	{
		const env = load({
			box: [1920, 1080], main: '1280x720', sub: '640x360', picked: 'auto',
		});
		await tick();
		check('took Main', env.made[0].opts.stream === 0,
			'stream=' + env.made[0].opts.stream);
	}

	group('a box smaller than both takes the smallest');
	{
		const env = load({
			box: [320, 180], main: '1920x1080', sub: '640x360', picked: 'auto',
		});
		await tick();
		check('took Sub', env.made[0].opts.stream === 1,
			'stream=' + env.made[0].opts.stream);
	}

	group('Auto is not offered without a second stream');
	{
		// A keyboard can reach an input whose label is hidden, so the markup
		// ships both disabled and the page enables them once it knows. Here the
		// viewer manages it anyway — or arrives with it remembered — and the
		// configuration then says there is only one stream.
		const env = load({ subEnabled: false, picked: 'auto', configDelay: 40 });
		check('the input starts unreachable',
			env.el('mj-stream-auto').disabled === true);
		env.el('mj-stream-auto').checked = true;
		env.el('mj-stream-auto').fire('change');
		await tick(1700);
		check('the control stays hidden', env.el('mj-auto').hidden === true);
		check('and it is disabled', env.el('mj-stream-auto').disabled === true);
		// It was the remembered choice, so it also has to be cleared, or Auto
		// runs on behind a control nobody can see or unset.
		check('the stale Auto choice is cleared',
			env.el('mj-stream-auto').checked === false);
		check('and Main is shown as selected',
			env.el('mj-stream-0').checked === true);
		check('the player is on Main', env.made[0].opts.stream === 0,
			'stream=' + env.made[0].opts.stream);
	}

	group('following the window is rate limited, and nothing is dropped');
	{
		const env = load({
			box: [1920, 1080], main: '1920x1080', sub: '640x360', picked: 'auto',
		});
		await tick();
		const live = env.made[0];
		check('starts on Main', live.opts.stream === 0, 'stream=' + live.opts.stream);

		// Shrink the box so Sub is the better fit, twice in quick succession.
		[env.el('mj-stage'), env.el('mj-player'), env.el('live-video'), env.el('live-video-b')].forEach((e) => {
			e.clientWidth = 320; e.clientHeight = 180;
		});
		if (env.win.roFire) env.win.roFire(); else env.win.fire('resize');
		await tick(300);
		check('the first change goes through', live.streamSet === 1,
			'streamSet=' + live.streamSet);

		// Straight back up: inside the one-second window, so it must be held,
		// not thrown away.
		[env.el('mj-stage'), env.el('mj-player'), env.el('live-video'), env.el('live-video-b')].forEach((e) => {
			e.clientWidth = 1920; e.clientHeight = 1080;
		});
		if (env.win.roFire) env.win.roFire(); else env.win.fire('resize');
		await tick(300);
		check('a change inside the window is not applied yet',
			live.streamSet === 1, 'streamSet=' + live.streamSet);
		await tick(900);
		check('but it is applied once the window passes',
			live.streamSet === 0, 'streamSet=' + live.streamSet);
	}

	group('the player container is watched, not only the window');
	{
		const env = load({ box: [640, 360], picked: 'auto' });
		await tick();
		// The stage, not the video nodes: MSE replaces those on every
		// reconnect, so an observer on them would be watching detached
		// elements within a session. And the stage rather than #mj-player,
		// because the viewport clamp resizes the stage on height-only
		// viewport changes the parent never sees.
		check('the stage is what is observed',
			env.observed.length === 1 && env.observed[0].id === 'mj-stage',
			env.observed.map(e => e.id).join(',') || 'nothing');
	}

	group('an unset main size means sensor native, not "no such stream"');
	{
		// video0.size ships with no default at all: empty means whatever the
		// sensor gives, which is the largest picture the camera has. Excluding
		// it would leave Auto on the substream for ever.
		const env = load({
			box: [1600, 900], main: '', sub: '640x360', picked: 'auto',
		});
		await tick();
		check('Auto took Main for a box bigger than the substream',
			env.made[0].opts.stream === 0, 'stream=' + env.made[0].opts.stream);
	}

	group('and a small box still prefers the substream');
	{
		const env = load({
			box: [320, 180], main: '', sub: '640x360', picked: 'auto',
		});
		await tick();
		check('Auto took Sub', env.made[0].opts.stream === 1,
			'stream=' + env.made[0].opts.stream);
	}

	group('the aspect ratio of what is playing cannot flip the decision');
	{
		// The reported loop: at 800px wide, 1280x720 renders 800x450 and by
		// area points at a 704x576 substream, which renders 800x655 and points
		// back — once per rate-limit interval, for ever. The decision is taken
		// on the container's width, which does not move when the stream does.
		const env = load({
			box: [800, 450], main: '1280x720', sub: '704x576', picked: 'auto',
		});
		await tick();
		const live = env.made[0];
		const first = live.opts.stream;
		check('opens on Main, the only stream at least 800 wide', first === 0,
			'stream=' + first);

		// Let the video element take the aspect ratio of whatever is playing,
		// as the browser would, and keep poking it.
		for (let i = 0; i < 4; i++) {
			const playing = live.streamSet === null ? first : live.streamSet;
			const h = playing === 0 ? 450 : 655;
			[env.el('live-video'), env.el('live-video-b')].forEach((e) => {
				e.clientWidth = 800; e.clientHeight = h;
			});
			if (env.win.roFire) env.win.roFire();
			await tick(1100);
		}
		check('and never switches away from it',
			live.streamSet === null || live.streamSet === 0,
			'streamSet=' + live.streamSet);
	}

	group('choosing Auto is remembered as a choice of its own');
	{
		const env = load({ box: [640, 360] });
		await tick();
		env.el('mj-stream-auto').fire('click');
		check('stored as auto', env.stored === 'auto', String(env.stored));
	}

	done();
})();
