// preview-multipart.js — the MJPEG stream as a rung of the transport ladder.
//
// It was a bare `img.src = '/mjpeg'` written from preview-page.js's fallback
// path, outside the swap. It is a transport now because a USB webcam publishing
// MJPEG is a source and not a failure, and the same picture has to be reachable
// as a first choice, on the swap's own element, for a camera other than the
// on-board one.
//
// Two properties here are worth holding still and neither is visible on screen.
// The first is that destroy() closes the connection: an <img> left holding a
// multipart src is a live HTTP response the camera goes on encoding frames for,
// so a leaked one costs a session nobody can have back. The second is that the
// rung reports exactly one 'playing' however many frames arrive — a multipart
// <img> fires `load` per part in some engines and once in others, and a rung
// that promoted itself twice would swap the stage out from under itself.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const SRC = path.join(__dirname, '..', 'www', 'a', 'preview-multipart.js');

// An <img> with just enough of one: the handlers the rung registers, the src it
// writes, and naturalWidth/Height, which is where the geometry on the chip comes
// from — nothing negotiated it, so the image itself is the only source.
function makeImg() {
	return {
		src: '', naturalWidth: 1280, naturalHeight: 720,
		handlers: {},
		addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); },
		removeEventListener(ev, fn) {
			this.handlers[ev] = (this.handlers[ev] || []).filter(f => f !== fn);
		},
		removeAttribute(a) { if (a === 'src') this.src = ''; },
		fire(ev) { (this.handlers[ev] || []).slice().forEach(f => f()); },
	};
}

function load() {
	const timers = [];
	const ctx = {
		window: {},
		console: console,
		Date: Date,
		Math: Math,
		setTimeout: (fn, ms) => { timers.push(fn); return timers.length; },
		clearTimeout: (h) => { if (h) timers[h - 1] = null; },
	};
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx);
	return { M: ctx.window.MajesticMultipart, timers };
}

function attach(el, opts) {
	const { M, timers } = load();
	const states = [];
	const codecs = [];
	const audio = [];
	const p = M.attach(el, Object.assign({
		onState: (s, d) => states.push(d ? s + ' ' + d : s),
		onCodec: (codec, cs, w, h) => codecs.push({ codec, w, h }),
		onAudio: (a) => audio.push(a),
	}, opts || {}));
	return { p, states, codecs, audio, timers, M };
}

group('available everywhere');
{
	const { M } = load();
	check('no capability to check — an <img> and an HTTP response',
		M.available === true);
}

group('the URL names the camera, derived from the stream id');
{
	// Every transport here is attached with a stream_id — 3*camera + subtype —
	// so a caller does not have to know that this one speaks a different
	// language. /mjpeg takes a CAMERA, there being one MJPEG stream per camera,
	// so the subtype is divided out.
	const a = makeImg();
	attach(a, { stream: 2 });
	check('camera 0 is the bare path', /^\/mjpeg\?t=/.test(a.src), a.src);

	const b = makeImg();
	attach(b, { stream: 5 });
	check('camera 1 carries ?channel=', /^\/mjpeg\?channel=1&t=/.test(b.src), b.src);

	// A NAL stream id of the same camera names the same MJPEG stream: the
	// subtype is not part of this URL at all.
	const b2 = makeImg();
	attach(b2, { stream: 3 });
	check('and so does any other stream of that camera',
		/^\/mjpeg\?channel=1&t=/.test(b2.src), b2.src);

	// Not about caching: assigning an identical src is a no-op in some engines,
	// so a retry onto the same element would never reopen the connection.
	const c = makeImg();
	const first = (attach(c, { stream: 5 }), c.src);
	const d = makeImg();
	attach(d, { stream: 5 });
	check('two attaches do not produce the same URL', first !== d.src);
}

group('one picture, one promotion');
{
	const el = makeImg();
	const t = attach(el, { stream: 5 });
	check('says so before it has anything', t.states[0] === 'connecting');
	check('and disowns audio at attach rather than leaving a dead control',
		t.audio.length === 1 && t.audio[0] === null);

	el.fire('load');
	check('the first frame is a picture', t.states.indexOf('playing') > 0);
	check('and names the format from the image itself, in the four the other ' +
		'players report',
		t.codecs.length === 1 && t.codecs[0].codec === 'mjpeg' &&
		t.codecs[0].w === 1280 && t.codecs[0].h === 720);

	el.fire('load');
	el.fire('load');
	check('further frames promote nothing',
		t.states.filter(s => s === 'playing').length === 1);
	check('and name the format once', t.codecs.length === 1);
}

group('giving up');
{
	const el = makeImg();
	const t = attach(el, { stream: 5 });
	el.fire('error');
	check('a refused response is terminal, in the vocabulary the pages read',
		t.states[t.states.length - 1] === 'mjpeg unreachable');
	check('and lets go of the connection', el.src === '');

	// The camera answered but never sent a frame. Distinct reason, same
	// outcome: there is nothing below this rung.
	const el2 = makeImg();
	const t2 = attach(el2, { stream: 2 });
	t2.timers.filter(Boolean).forEach(fn => fn());
	check('so is a response that never becomes a frame',
		t2.states[t2.states.length - 1] === 'mjpeg no-frames');

	// And once it has a picture, the watchdog must not fire behind it.
	const el3 = makeImg();
	const t3 = attach(el3, { stream: 2 });
	el3.fire('load');
	t3.timers.filter(Boolean).forEach(fn => fn());
	check('a stream that arrived is not killed by its own timeout',
		t3.states.every(s => s.indexOf('mjpeg') !== 0));
}

group('destroy closes the connection');
{
	const el = makeImg();
	const t = attach(el, { stream: 5 });
	el.fire('load');
	check('there is a live response to close', el.src !== '');

	t.p.destroy();
	// The one that matters. Hiding the element does not end a multipart
	// response; only dropping the src does, and on a camera with a session
	// budget an abandoned one is a session nobody gets back.
	check('destroy drops the src', el.src === '');
	check('and stops listening',
		(el.handlers.load || []).length === 0 &&
		(el.handlers.error || []).length === 0);

	const before = t.states.length;
	el.fire('load');
	el.fire('error');
	check('a destroyed rung says nothing more', t.states.length === before);
}

group('switching stream');
{
	const el = makeImg();
	const t = attach(el, { stream: 2 });
	el.fire('load');

	t.p.setStream(5);
	check('a different camera is a different URL', /channel=1/.test(el.src));

	// The new camera has to earn its own promotion: the caller's swap is
	// watching for 'playing', and inheriting the last camera's would put the
	// stage on a picture that has not arrived.
	el.fire('load');
	check('and re-promotes on its own first frame',
		t.states.filter(s => s === 'playing').length === 2);

	// A channel change within the same camera. There is one MJPEG stream per
	// camera, so this correctly does nothing rather than tearing down a working
	// picture to fetch exactly the same one.
	const held = el.src;
	t.p.setStream(3);
	check('a channel change on the same camera is not a reconnect',
		el.src === held, el.src);
	t.p.setStream(5);
	check('and neither is asking for what is already playing', el.src === held);
}

group('the controls it does not have');
{
	const el = makeImg();
	const t = attach(el, { stream: 2 });
	check('no audio', t.p.audioSupported() === false);
	check('no talkback', t.p.micSupported() === false);
	// Every frame is a whole picture; there is no keyframe to ask for. It has
	// to be callable all the same — the pages call it without asking which
	// transport they are on.
	t.p.requestIdr();
	t.p.setAudio(true);
	t.p.setVolume(50);
	t.p.setMic(true);
	check('and the rest are callable no-ops', t.p.supported === true);
}

done();
