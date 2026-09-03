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
	'live-mjpeg', 'live-video', 'live-video-b', 'live-canvas', 'live-canvas-b',
	'mj-audio-ctl', 'mj-badge',
	'mj-lightmon', 'mj-mute', 'mj-mute-lbl', 'mj-mute-t', 'mj-note',
	'mj-note-why', 'mj-stats',
	'mj-stats-btn', 'mj-stats-ctl', 'mj-stream-0', 'mj-stream-1',
	'mj-stream-auto', 'mj-auto', 'mj-served', 'mj-served-why', 'mj-sub',
	'mj-talk', 'mj-talk-ctl',
	'mj-talk-lbl', 'mj-talk-t', 'mj-transport-w', 'mj-transport-m', 'mj-transport-ctl',
	'mj-transport-lbl', 'mj-vol',
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
	// revealed only where a second stream exists; the served-channel message
	// starts hidden until a mismatch is announced.
	['mj-sub', 'mj-auto', 'mj-served'].forEach((id) => {
		env.els['#' + id].hidden = true;
	});
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
			available: () => true, preferred: () => cfg.transport || 'mse',
			choose() {}, demote() {},
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
			softwareRungForCodec: (d, codec) => {
				const bits = String(d || '').split(' ');
				const w = win.MajesticWasm;
				return (bits[0] === 'unreachable' || bits[0] === 'mse-error') &&
					!!(w && w.available && w.handles && w.handles(codec));
			},
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

	group('Auto always names the channel it picked on the chip');
	{
		// Auto's radios never say which channel won, so the chip does — for
		// every frame, not only on a served-channel mismatch (#184).
		const env = load({
			box: [800, 450], main: '1280x720', sub: '704x576', picked: 'auto',
		});
		await tick();
		const live = env.made[0];
		live.say('playing');
		live.opts.onCodec('h264', 'h264', 1280, 720);
		check('the picked channel is named',
			/ · Main stream$/.test(env.el('mj-badge').textContent),
			env.el('mj-badge').textContent);
	}

	group('Auto claims nothing over WebRTC when sizes cannot distinguish');
	{
		// Identically-sized channels make a WebRTC fallback undetectable to
		// the size inference, so the label would be a guess — and a guess
		// about "which stream is this" is worse than silence. This is the
		// old-daemon path: a majestic with the `served` reply states the
		// channel outright (#240), covered by the groups below.
		const env = load({
			box: [800, 450], main: '1280x720', sub: '1280x720',
			picked: 'auto', transport: 'webrtc',
		});
		await tick();
		const live = env.made[0];
		live.say('playing');
		live.opts.onCodec('h264', 'h264', 1280, 720);
		check('no channel is claimed',
			env.el('mj-badge').textContent.indexOf('stream') === -1,
			env.el('mj-badge').textContent);
	}

	group('the chip names the channel WebRTC actually served');
	{
		// WebRTC takes ?stream= as a preference, and majestic#299 arrived as
		// "Main selected, Sub displayed" with nothing on the page admitting
		// it. With no remembered choice the page opens on Sub. Main's size is
		// deliberately non-canonical: the settings page accepts and persists
		// this form, and a size the preview refused to read would silence
		// the note exactly when it was needed.
		const env = load({
			main: '1920 X 1080', sub: '800x600', transport: 'webrtc',
		});
		await tick();
		const live = env.made[0];
		live.say('playing');
		// The camera serves the channel that was asked for: no note.
		live.opts.onCodec('h264', 'h264', 800, 600);
		check('the served channel is not named when it matches',
			env.el('mj-badge').textContent.indexOf('stream') === -1,
			env.el('mj-badge').textContent);
		// The camera serves Main against a Sub request: the chip says so.
		live.opts.onCodec('h264', 'h264', 1920, 1080);
		check('a mismatch names what arrived',
			/ · Main stream$/.test(env.el('mj-badge').textContent),
			env.el('mj-badge').textContent);
		// A frame matching neither configured size claims nothing.
		live.opts.onCodec('h264', 'h264', 1280, 720);
		check('an unrecognised size claims nothing',
			env.el('mj-badge').textContent.indexOf('stream') === -1,
			env.el('mj-badge').textContent);
	}

	group('the camera\'s own served answer beats indistinguishable sizes');
	{
		// The `served` signalling reply (#240): with both channels sized
		// alike the inference above stays silent, but the camera saying
		// "channel 0" outright is not a guess. This is Auto's case — the
		// chip always names Auto's channel when it truthfully can.
		const env = load({
			box: [800, 450], main: '1280x720', sub: '1280x720',
			picked: 'auto', transport: 'webrtc',
		});
		await tick();
		const live = env.made[0];
		live.say('playing');
		live.opts.onCodec('h264', 'h264', 1280, 720);
		live.opts.onServed({ channel: 0, requested: null, reason: '' });
		check('the chip names the channel the camera stated',
			/ · Main stream$/.test(env.el('mj-badge').textContent),
			env.el('mj-badge').textContent);
		check('no message without a betrayed request',
			env.el('mj-served').hidden === true);
	}

	group('a served mismatch moves the radio and explains itself');
	{
		// The viewer asked for Main; the camera answered with Sub and said
		// why. The controls follow reality — without re-entering the stream
		// switch or overwriting the remembered preference — and the message
		// carries the reason (#240).
		const env = load({
			main: '1920x1080', sub: '1920x1080', picked: 0,
			transport: 'webrtc',
		});
		await tick();
		const live = env.made[0];
		check('opens on the remembered Main', live.opts.stream === 0,
			'stream=' + live.opts.stream);
		live.say('playing');
		live.opts.onCodec('h264', 'h264', 1920, 1080);
		live.opts.onServed({ channel: 1, requested: 0, reason: 'undecodable' });
		check('the Sub radio is now the checked one',
			env.el('mj-stream-1').checked === true &&
			env.el('mj-stream-0').checked === false);
		check('the message is shown', env.el('mj-served').hidden === false);
		check('and names the cause',
			env.el('mj-served-why').textContent.indexOf('decode') !== -1,
			env.el('mj-served-why').textContent);
		check('the player was not re-cut', live.streamSet === null,
			'streamSet=' + live.streamSet);
		check('the remembered preference was not overwritten',
			env.stored === undefined, String(env.stored));
		// The radio now tells the truth, so the chip has no betrayal to
		// report.
		check('the chip carries no mismatch note',
			env.el('mj-badge').textContent.indexOf('stream') === -1,
			env.el('mj-badge').textContent);

		// A reopen inside the fallen-back session (audio toggle, network
		// reconnect) requests the ADOPTED channel and is answered with a
		// match — but the viewer's own ask is still unmet, so the standing
		// explanation must not vanish on an audio toggle.
		live.opts.onServed({ channel: 1, requested: 1, reason: '' });
		check('a reopen echo does not clear the explanation',
			env.el('mj-served').hidden === false);
		check('nor move the radios',
			env.el('mj-stream-1').checked === true);

		// Dismissed is dismissed: the same session re-stating the same
		// fallback (a reconnect, an audio renegotiation) must not resurrect
		// the message.
		env.el('mj-served').fire('click');
		check('a click dismisses it', env.el('mj-served').hidden === true);
		live.opts.onServed({ channel: 1, requested: 0, reason: 'undecodable' });
		check('the same answer does not re-show it',
			env.el('mj-served').hidden === true);
		live.opts.onServed({ channel: 1, requested: 1, reason: '' });
		check('and a reopen echo after dismissal stays dismissed',
			env.el('mj-served').hidden === true);

		// But a fresh user pick re-arms it: asking again deserves an answer
		// again.
		env.el('mj-stream-0').checked = true;
		env.el('mj-stream-0').fire('change');
		check('re-picking reaches the player', live.streamSet === 0,
			'streamSet=' + live.streamSet);
		live.opts.onServed({ channel: 1, requested: 0, reason: 'undecodable' });
		check('a repeated fallback after a re-pick is news again',
			env.el('mj-served').hidden === false);
	}

	group('in Auto a served mismatch keeps Auto checked and stays quiet');
	{
		// Auto delegated the choice, so nothing was betrayed: the radios stay
		// Auto's, no message shows, and the chip (which always names Auto's
		// channel) is the disclosure.
		const env = load({
			box: [320, 180], main: '1920x1080', sub: '640x360',
			picked: 'auto', transport: 'webrtc',
		});
		await tick();
		const live = env.made[0];
		check('Auto asked for Sub', live.opts.stream === 1,
			'stream=' + live.opts.stream);
		live.say('playing');
		live.opts.onCodec('h264', 'h264', 1920, 1080);
		live.opts.onServed({ channel: 0, requested: 1, reason: 'unavailable' });
		check('Auto stays checked',
			env.el('mj-stream-auto').checked === true);
		check('no message in Auto', env.el('mj-served').hidden === true);
		check('the chip names what is actually served',
			/ · Main stream$/.test(env.el('mj-badge').textContent),
			env.el('mj-badge').textContent);
	}

	done();
})();
