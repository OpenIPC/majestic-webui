// Arming a camera for plates, and being able to take it back
// (www/a/raw-plates.js).
//
// This is the same danger `calibrate` has next door, with five keys instead of
// two, and it fails silently in the worst direction: every one of these
// settings survives a reboot, and a pinned short shutter with the gains held
// down makes a picture so dark that the view you would use to notice something
// is wrong is the thing that went wrong. A camera left armed looks like a
// camera with a broken sensor.
//
// It cannot be reproduced on demand either — it needs a camera serving raw, a
// plate in the frame, and nobody pressing the button that puts it back. So the
// restore path is held still here: what is remembered, what is sent back, what
// happens when the camera does not take it, and what stands the countdown down.
//
// Two of the groups below are transcriptions of incidents rather than
// hypotheses. Both were found on hardware, and both are named where they sit.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const SRC = fs.readFileSync(
	path.join(__dirname, '..', 'www', 'a', 'raw-plates.js'), 'utf8');
const ROI = require(path.join(__dirname, '..', 'www', 'a', 'mj-plate-roi.js'));

// A camera stub. `lacks` is a daemon that predates a key — it answers 404 for
// any leaf naming one, INCLUDING a null that means "remove it", which is what
// majestic really does. `ignoreNulls` is the older build that answers 202 and
// drops removals on the floor.
function makeCamera(opts) {
	opts = opts || {};
	const lacks = opts.lacks || [];
	const cam = {
		config: { isp: Object.assign({}, opts.isp) },
		posts: [], dngs: [], signals: [], inFlight: 0, maxInFlight: 0,
		dngStatus: opts.dngStatus || 200,
	};
	cam.apiFetch = function (url, init) {
		if (url === '/api/v1/config.schema.json') {
			if (opts.schemaFails) return Promise.resolve({ ok: false, status: 500 });
			const props = {};
			['meterRect', 'exposure', 'aGain', 'dGain', 'aeStrategy'].forEach(function (k) {
				if (lacks.indexOf(k) === -1) props[k] = { type: 'string' };
			});
			return Promise.resolve({
				ok: true, status: 200,
				json: () => Promise.resolve({ properties: { isp: { properties: props } } }),
			});
		}
		if (url === '/api/v1/config.json') {
			return Promise.resolve({
				ok: true, status: 200,
				json: () => Promise.resolve(JSON.parse(JSON.stringify(cam.config))),
			});
		}
		if (url === '/api/v1/config') {
			const body = JSON.parse(init.body);
			cam.posts.push(body);
			if (opts.rejectPost) return Promise.resolve({ ok: false, status: 400 });
			const unknown = Object.keys(body.isp).filter((k) => lacks.indexOf(k) !== -1);
			if (unknown.length) {
				// The leaves before the unknown one have already taken effect:
				// observed on an hi3516ev300, which is why the write was partial
				// AND the revert could not undo it.
				Object.keys(body.isp).forEach(function (k) {
					if (lacks.indexOf(k) !== -1) return;
					if (body.isp[k] !== null) cam.config.isp[k] = body.isp[k];
				});
				return Promise.resolve({ ok: false, status: 404 });
			}
			Object.keys(body.isp).forEach(function (k) {
				if (body.isp[k] === null) {
					if (!opts.ignoreNulls) delete cam.config.isp[k];
				} else {
					cam.config.isp[k] = body.isp[k];
				}
			});
			return Promise.resolve({ ok: true, status: 200 });
		}
		if (url.indexOf('/image.dng') === 0) {
			cam.dngs.push(url);
			cam.signals.push(init && init.signal ? 'yes' : 'no');
			cam.inFlight++;
			cam.maxInFlight = Math.max(cam.maxInFlight, cam.inFlight);
			// A build that knows ?frames= averages in the camera and says so in
			// the header; `oldDng` is one that has never heard of it and sends a
			// single frame with no header at all. `averagedCap` is the third
			// case: a build that honours the parameter but drops frames whose
			// geometry does not line up, so it averages fewer than it was asked.
			const m = /[?&]frames=(\d+)/.exec(url);
			const averaged = (m && !opts.oldDng)
				? String(Math.min(Number(m[1]), opts.averagedCap || 1e9)) : null;
			return new Promise(function (res) {
				setTimeout(function () {
					cam.inFlight--;
					if (cam.dngStatus !== 200) { res({ ok: false, status: cam.dngStatus }); return; }
					res({
						ok: true, status: 200,
						headers: { get: (h) => (/^x-frames-averaged$/i.test(h) ? averaged : null) },
						arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
					});
				}, 1);
			});
		}
		throw new Error('unexpected url ' + url);
	};
	return cam;
}

function load(cam, lpr) {
	const handlers = {};
	const sandbox = {
		apiFetch: cam.apiFetch,
		fetch: function (url, init) { cam.posts.push(JSON.parse(init.body)); return Promise.resolve({ ok: true }); },
		setTimeout: setTimeout, clearTimeout: clearTimeout,
		Promise: Promise, Object: Object, Error: Error, JSON: JSON,
		Math: Math, Uint8Array: Uint8Array, ArrayBuffer: ArrayBuffer,
		MajesticPlateRoi: ROI,
		MajesticLpr: lpr,
		addEventListener: function (n, fn) { (handlers[n] = handlers[n] || []).push(fn); },
	};
	sandbox.window = sandbox;
	const ctx = vm.createContext(sandbox);
	vm.runInContext(SRC, ctx, { filename: 'raw-plates.js' });
	return { api: sandbox.MajesticPlates, handlers: handlers };
}

const FRAME_W = 2592, FRAME_H = 1944;
const PLATE = { left: 960, top: 1494, width: 50, height: 14 };
const ARM = { rect: PLATE, exposureMs: 1, aGain: 1024, dGain: 1024, aeStrategy: 'highlight' };

(async () => {
	group('what the camera will meter is answered before it is asked');

	let { api } = load(makeCamera({}));
	const p = api.exposure.plan(PLATE, FRAME_W, FRAME_H);
	check('the plan reports the grown rectangle, not the one drawn',
		p.rect.width === 256 && p.rect.height === 120);
	check('and says it was grown', p.grown === true);
	check('and by how much, so the operator can be told', Math.round(p.factor) === 44);
	check('a region with no area has no plan — that is whole-frame metering',
		api.exposure.plan({ left: 0, top: 0, width: 0, height: 0 }, FRAME_W, FRAME_H) === null);

	group('arming remembers what was there, including what was not set at all');

	let cam = makeCamera({ isp: { exposure: 12.5 } });
	let L = load(cam); api = L.api;
	await api.exposure.apply(Object.assign({ hold: false }, ARM));
	const armed = cam.posts[0].isp;
	check('the metering rectangle goes on the wire as an array of XxYxWxH',
		Array.isArray(armed.meterRect) && armed.meterRect[0] === '960x1494x50x14',
		JSON.stringify(armed.meterRect));
	check('the rectangle sent is the one drawn, not the grown one',
		armed.meterRect[0].indexOf('256') === -1);
	check('all five keys go in one batch', Object.keys(armed).length === 5);
	check('the camera is now armed', cam.config.isp.exposure === 1);

	await api.exposure.revert();
	check('revert puts the configured key back to its old value',
		cam.config.isp.exposure === 12.5, JSON.stringify(cam.config.isp));
	check('and REMOVES the keys that were never set, rather than leaving values',
		!('meterRect' in cam.config.isp) && !('aGain' in cam.config.isp) &&
		!('aeStrategy' in cam.config.isp), JSON.stringify(cam.config.isp));

	group('a revert that did not land is reported, not assumed');

	cam = makeCamera({ isp: { exposure: 12.5 }, ignoreNulls: true });
	L = load(cam); api = L.api;
	await api.exposure.apply(Object.assign({ hold: false }, ARM));
	let err = '';
	await api.exposure.revert().catch((e) => { err = e.message; });
	check('a firmware that ignores removals is caught by the re-read',
		/did not take the old settings back/.test(err), err || '(resolved)');

	group('a firmware without the keys is refused by name, before anything is written');

	cam = makeCamera({ lacks: ['meterRect', 'aeStrategy'] });
	L = load(cam); api = L.api;
	err = '';
	await api.exposure.apply(Object.assign({ hold: false }, ARM)).catch((e) => { err = e.message; });
	check('it names both missing keys', /isp\.meterRect or isp\.aeStrategy/.test(err), err || '(resolved)');
	check('and says why the rest were not applied either',
		/written\s+together or not at all/.test(err), err);
	check('nothing was written', cam.posts.length === 0, String(cam.posts.length));

	// The incident: `apply` used to send all five, nulls included, so the two
	// the daemon lacked 404'd the batch AFTER the other three had taken effect,
	// and `revert` then failed the same way — leaving the shutter pinned with no
	// way back from the page. A removal of an unknown key is still an unknown key.
	cam = makeCamera({ lacks: ['meterRect', 'aeStrategy'] });
	L = load(cam); api = L.api;
	await api.exposure.apply({ exposureMs: 0.5, aGain: 1024, dGain: 1024, hold: false });
	check('a request using only supported keys is allowed through',
		cam.posts.length === 1 && cam.config.isp.exposure === 0.5, JSON.stringify(cam.config.isp));
	check('the batch carries only the keys the daemon has',
		Object.keys(cam.posts[0].isp).join(',') === 'exposure,aGain,dGain',
		Object.keys(cam.posts[0].isp).join(','));
	check('so no removal is asked for a key that does not exist',
		!('meterRect' in cam.posts[0].isp) && !('aeStrategy' in cam.posts[0].isp));
	await api.exposure.revert();
	check('and the revert undoes it cleanly on that same camera',
		!('exposure' in cam.config.isp) && !('aGain' in cam.config.isp) &&
		!('dGain' in cam.config.isp), JSON.stringify(cam.config.isp));

	check('supports() reports what the daemon admits to',
		JSON.stringify(await api.exposure.supports()) ===
		JSON.stringify({ meterRect: false, exposure: true, aGain: true, dGain: true, aeStrategy: false }),
		JSON.stringify(await api.exposure.supports()));

	group('an arming nobody confirms undoes itself');

	// The other incident: three presses of an Arm button left a lab camera
	// pinned at 1 ms with the gains held down, twice for minutes, because the
	// harness never called revert. `holdSeconds` was declared on the object and
	// honoured by nobody. Putting the timer in the caller's UI means every
	// caller has to remember; putting it here means none of them has to.
	cam = makeCamera({ isp: {} });
	L = load(cam); api = L.api;
	let expired = 'not yet';
	await api.exposure.apply(Object.assign({}, ARM, {
		holdSeconds: 0.05, onExpire: (e) => { expired = e || 'ok'; },
	}));
	check('the camera is armed straight after apply', api.exposure.armed() === true);
	check('and the config really changed', cam.config.isp.exposure === 1);
	await new Promise((r) => setTimeout(r, 200));
	check('it reverted itself without anyone asking', expired === 'ok', String(expired));
	check('and nothing is left behind',
		!('exposure' in cam.config.isp) && !('meterRect' in cam.config.isp),
		JSON.stringify(cam.config.isp));
	check('the object agrees it is no longer armed', api.exposure.armed() === false);

	cam = makeCamera({ isp: {} });
	L = load(cam); api = L.api;
	await api.exposure.apply(Object.assign({}, ARM, { holdSeconds: 0.05 }));
	await api.exposure.keep();
	await new Promise((r) => setTimeout(r, 200));
	check('keep() stands the countdown down', cam.config.isp.exposure === 1,
		JSON.stringify(cam.config.isp));
	check('and the object no longer claims to be armed', api.exposure.armed() === false);

	cam = makeCamera({ isp: {} });
	L = load(cam); api = L.api;
	await api.exposure.apply(Object.assign({}, ARM, { holdSeconds: 0.05, hold: false }));
	await new Promise((r) => setTimeout(r, 200));
	check('hold:false leaves the duty with the caller', cam.config.isp.exposure === 1);
	await api.exposure.revert();

	// Re-arming is ordinary — nudge the shutter, pick a different plate — and it
	// must not move the restore target. `apply` used to snapshot on every call,
	// so a second one recorded the ARMED configuration as "what was there
	// before" and every way back then restored the camera to armed and called
	// it done: the countdown, the unload handler and an explicit revert alike.
	cam = makeCamera({ isp: { exposure: 12.5 } });
	L = load(cam); api = L.api;
	await api.exposure.apply(Object.assign({ hold: false }, ARM, { exposureMs: 1 }));
	await api.exposure.apply(Object.assign({ hold: false }, ARM, { exposureMs: 2 }));
	check('the second arming took effect', cam.config.isp.exposure === 2,
		JSON.stringify(cam.config.isp));
	await api.exposure.revert();
	check('and revert goes back to before the FIRST arming, not the second',
		cam.config.isp.exposure === 12.5, JSON.stringify(cam.config.isp));
	check('with the keys that were never set removed again',
		!('meterRect' in cam.config.isp) && !('aGain' in cam.config.isp),
		JSON.stringify(cam.config.isp));

	group('the unload handler is armed once, and keep() stands it down');

	cam = makeCamera({ isp: {} });
	L = load(cam); api = L.api;
	await api.exposure.apply(Object.assign({ hold: false }, ARM));
	await api.exposure.apply(Object.assign({ hold: false }, ARM, { exposureMs: 2 }));
	check('two armings register one pagehide handler, not two',
		(L.handlers.pagehide || []).length === 1, String((L.handlers.pagehide || []).length));
	let before = cam.posts.length;
	L.handlers.pagehide[0]();
	check('closing the tab while armed sends the old settings back',
		cam.posts.length === before + 1);
	await api.exposure.keep();
	before = cam.posts.length;
	L.handlers.pagehide[0]();
	check('after keep() the same handler sends nothing', cam.posts.length === before);

	group('a burst is averaged BY THE CAMERA unless the frames themselves are wanted');

	// The default path. One request and one capture, with the camera's raw dump
	// left running so the frames are consecutive -- 0.8 s of sensor time at 20
	// fps for sixteen, against the thirteen seconds sixteen separate captures
	// take. Getting this wrong is not a crash; it is a feature that takes an
	// order of magnitude longer than it needs to, and looks identical.
	cam = makeCamera({});
	L = load(cam); api = L.api;
	let got = await api.burst({
		rect: { left: 887, top: 1431, width: 223, height: 111 },
		frameW: FRAME_W, frameH: FRAME_H, frames: 8,
	});
	check('one request, not eight', cam.dngs.length === 1, String(cam.dngs.length));
	check('and it asked the camera to average them',
		cam.dngs[0] === '/image.dng?crop=886x1430x224x112&frames=8', cam.dngs[0]);
	check('what comes back is a single averaged frame', got.frames.length === 1);
	check('and it says how many went into it', got.averaged === 8, String(got.averaged));
	check('and that the camera did the averaging', got.inCamera === true);

	// Odd on every edge: the camera snaps outward, and the caller has to be
	// told, because every pixel of a misaligned rectangle changes colour.
	check('the snapped rectangle is reported back',
		got.rect.left === 886 && got.rect.width === 224);
	check('beside the one that was asked for', got.asked.left === 887);

	// Rejection and a before-and-after comparison both need the individuals,
	// and an average cannot be taken apart again.
	cam = makeCamera({});
	L = load(cam); api = L.api;
	got = await api.burst({
		rect: { left: 887, top: 1431, width: 223, height: 111 },
		frameW: FRAME_W, frameH: FRAME_H, frames: 5, separate: true,
	});
	check('separate:true fetches them one at a time', cam.dngs.length === 5);
	check('one frame in flight at a time', cam.maxInFlight === 1, String(cam.maxInFlight));
	check('and hands back every frame', got.frames.length === 5);
	check('none of those requests asked the camera to average',
		cam.dngs.every((u) => u.indexOf('frames=') === -1), cam.dngs[0]);
	check('and it says the averaging was not done for us', got.inCamera === false);

	// The camera's accumulator is four bytes a pixel for the duration, so the
	// daemon caps a burst at sixteen and answers 400 above it. Asking for more
	// would fail the whole request rather than get more frames.
	cam = makeCamera({});
	L = load(cam); api = L.api;
	got = await api.burst({ rect: { left: 886, top: 1430, width: 224, height: 112 },
		frameW: FRAME_W, frameH: FRAME_H, frames: 40 });
	check('a request over the camera\'s limit is clamped, not refused',
		cam.dngs[0].indexOf('frames=16') !== -1, cam.dngs[0]);

	// An older build answers 200 and sends one frame, with no header. Believing
	// it would silently give a "sixteen-frame stack" that is one frame.
	cam = makeCamera({ oldDng: true });
	L = load(cam); api = L.api;
	got = await api.burst({ rect: { left: 886, top: 1430, width: 224, height: 112 },
		frameW: FRAME_W, frameH: FRAME_H, frames: 4 });
	check('a camera too old for ?frames= is noticed rather than believed',
		got.averaged === 1 && got.inCamera === false,
		'averaged=' + got.averaged + ' inCamera=' + got.inCamera);
	check('and the rest are fetched one at a time instead', got.frames.length === 4);
	check('reusing the frame it already sent', cam.dngs.length === 4, String(cam.dngs.length));

	// The sixteen is the AVERAGING accumulator's limit, not a limit on how many
	// frames a caller may have. Asking one at a time uses no accumulator, and
	// collapsing the two numbers would quietly cut a forty-frame rejection down
	// to sixteen with nothing said.
	cam = makeCamera({});
	L = load(cam); api = L.api;
	got = await api.burst({ rect: { left: 886, top: 1430, width: 224, height: 112 },
		frameW: FRAME_W, frameH: FRAME_H, frames: 40, separate: true });
	check('forty separate frames are forty frames, not sixteen',
		got.frames.length === 40 && cam.dngs.length === 40, String(cam.dngs.length));

	// The camera drops a frame whose geometry does not match the first -- a
	// reload moves it -- so a burst of eight can honestly come back as five.
	// That is a smaller stack, not a failed one. Treating it as a single frame
	// and topping it up would put an average and ordinary captures in one array
	// and label every one of them unaveraged.
	cam = makeCamera({ averagedCap: 5 });
	L = load(cam); api = L.api;
	got = await api.burst({ rect: { left: 886, top: 1430, width: 224, height: 112 },
		frameW: FRAME_W, frameH: FRAME_H, frames: 8 });
	check('an average of fewer frames than asked is still the camera\'s average',
		got.inCamera === true && got.frames.length === 1,
		'inCamera=' + got.inCamera + ' frames=' + got.frames.length);
	check('and it reports the count the camera gave, not the one requested',
		got.averaged === 5, String(got.averaged));
	check('without a second request', cam.dngs.length === 1, String(cam.dngs.length));

	group('a burst can be called off, and says how far it has got');

	// The fast path used to ignore the signal outright: an already-cancelled
	// burst still took a picture, and cancelling mid-request could not stop it.
	cam = makeCamera({});
	L = load(cam); api = L.api;
	const aborted = { aborted: true };
	let bad = '';
	await api.burst({ rect: { left: 886, top: 1430, width: 224, height: 112 },
		frameW: FRAME_W, frameH: FRAME_H, frames: 8, signal: aborted })
		.catch(function (e) { bad = e.message; });
	check('a burst cancelled before it starts takes no picture',
		bad === 'cancelled' && cam.dngs.length === 0, bad + ' dngs=' + cam.dngs.length);

	cam = makeCamera({});
	L = load(cam); api = L.api;
	await api.burst({ rect: { left: 886, top: 1430, width: 224, height: 112 },
		frameW: FRAME_W, frameH: FRAME_H, frames: 4, signal: { aborted: false } });
	check('and the signal reaches the request, so one in flight can be stopped',
		cam.signals.length === 1 && cam.signals[0] === 'yes', cam.signals.join(','));

	// A progress line that starts at "0 of 1" and then jumps to "2 of 4" has
	// skipped a frame and changed its own denominator. On the fast path there
	// is one request, so there is nothing to count; the counter belongs to the
	// slow path and has to start where that path starts.
	cam = makeCamera({});
	L = load(cam); api = L.api;
	let seen = [];
	await api.burst({ rect: { left: 886, top: 1430, width: 224, height: 112 },
		frameW: FRAME_W, frameH: FRAME_H, frames: 4,
		onProgress: function (i, n) { seen.push(i + '/' + n); } });
	check('one camera-averaged request counts nothing', seen.length === 0, seen.join(' '));

	cam = makeCamera({ oldDng: true });
	L = load(cam); api = L.api;
	seen = [];
	await api.burst({ rect: { left: 886, top: 1430, width: 224, height: 112 },
		frameW: FRAME_W, frameH: FRAME_H, frames: 4,
		onProgress: function (i, n) { seen.push(i + '/' + n); } });
	check('a fallback counts every frame it has, first one included',
		seen.join(' ') === '1/4 2/4 3/4 4/4', seen.join(' '));

	let bad2 = '';
	await api.burst({ rect: { left: 0, top: 0, width: 0, height: 10 }, frameW: FRAME_W, frameH: FRAME_H })
		.catch((e) => { bad = e.message; });
	check('a region the camera cannot cut is refused before any request',
		/not one the camera can cut/.test(bad), bad || '(resolved)');

	group('the status codes a raw camera actually answers are explained');

	for (const [code, re] of [[501, /switched off/], [503, /already busy/], [404, /does not serve raw/]]) {
		cam = makeCamera({ dngStatus: code });
		L = load(cam); api = L.api;
		err = '';
		await api.frame().catch((e) => { err = e.message; });
		check(code + ' is explained rather than passed through', re.test(err), err);
	}

	group('no reader configured is a supported state, not an error');

	// This is what keeps the Plates tab off a camera nobody opted in on: raw.js
	// reads readerSupported and passes no capability at all when it is false.
	check('readerSupported is false when the loader reports no reader',
		load(makeCamera({}), { available: false }).api.readerSupported === false);
	check('and true when it reports one',
		load(makeCamera({}), { available: true }).api.readerSupported === true);
	check('false too when the loader was never loaded',
		load(makeCamera({}), undefined).api.readerSupported === false);
	err = '';
	await load(makeCamera({}), undefined).api.reader().catch((e) => { err = e.message; });
	check('and asking for one rejects rather than throwing', err === 'unavailable', err);

	done();
})();
