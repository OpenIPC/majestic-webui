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
	'mj-talk-lbl', 'mj-transport', 'mj-transport-ctl', 'mj-transport-lbl',
	'mj-transport-note', 'mj-vol', 'toggle-ircut', 'toggle-light',
	'toggle-night',
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
	if (cfg.box) {
		['live-video', 'live-video-b'].forEach((id) => {
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
		mjConfig: () => Promise.resolve(conf),
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
	group('Auto picks by area, not by one dimension');
	{
		// 704x576 is 405k pixels and 1280x720 is 921k. By width the substream
		// looks the smaller of the two; by area it is still smaller, but a box
		// of 800x450 (360k) is under both, so the nearest above wins.
		const env = load({
			box: [800, 450], main: '1280x720', sub: '704x576', picked: 'auto',
		});
		await tick();
		check('took the substream, the smaller of the two above the box',
			env.made[0].opts.stream === 1, 'stream=' + env.made[0].opts.stream);
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
		const env = load({ subEnabled: false, picked: 'auto' });
		await tick();
		check('the control stays hidden', env.el('mj-auto').hidden === true);
		check('and it is disabled', env.el('mj-stream-auto').disabled === true);
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
		[env.el('live-video'), env.el('live-video-b')].forEach((e) => {
			e.clientWidth = 320; e.clientHeight = 180;
		});
		if (env.win.roFire) env.win.roFire(); else env.win.fire('resize');
		await tick(300);
		check('the first change goes through', live.streamSet === 1,
			'streamSet=' + live.streamSet);

		// Straight back up: inside the one-second window, so it must be held,
		// not thrown away.
		[env.el('live-video'), env.el('live-video-b')].forEach((e) => {
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

	group('the player element is watched, not only the window');
	{
		const env = load({ box: [640, 360], picked: 'auto' });
		await tick();
		check('both video elements are observed', env.observed.length === 2,
			String(env.observed.length));
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

	group('choosing Auto is remembered as a choice of its own');
	{
		const env = load({ box: [640, 360] });
		await tick();
		env.el('mj-stream-auto').fire('click');
		check('stored as auto', env.stored === 'auto', String(env.stored));
	}

	done();
})();
