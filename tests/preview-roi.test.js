// When the camera is told to spend its bits somewhere, and how hard.
//
// Every branch of this is silent in the worst way. Engage too eagerly and a
// viewer who has barely zoomed re-tunes the recording for everybody; engage on
// every pointer move and a drag is thirty requests and thirty encoder
// re-programs, on a camera whose whole HTTP server is one thread; get the
// rectangle wrong and the bits go somewhere real, just not where anybody is
// looking. None of it reports anything. The stream keeps streaming, the
// counters keep counting, and the only symptom is that the thing you wanted to
// read is still mush.
//
// It cannot be reproduced on demand either: reaching any of it needs a camera
// whose encoder has ROI, a picture with enough detail for the effect to be
// visible at all, and a zoom gesture — and the whole effect is a few per cent.
//
// The numbers are the lab hi3516ev300's: a 2592x1520 main stream configured at
// 4096 kbps.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const SRC = path.join(__dirname, '..', 'www', 'a', 'preview-roi.js');
const FRAME = { w: 2592, h: 1520 };

// The module is one IIFE over a handful of globals from main.js. Everything
// here is a stand-in for one of them; nothing touches a DOM, because the file
// deliberately does not.
function boot(opts) {
	opts = opts || {};
	const pushes = [];
	let onView = null, listeners = {}, metrics = null;
	let visibility = 'visible';

	const cfg = Object.assign({
		video0: { roiRect: [], roiQp: '', enabled: true, bitrate: 4096 },
		video1: { roiRect: [], roiQp: '', enabled: false, bitrate: 1024 },
	}, opts.config || {});

	const sandbox = {
		// What main.js provides.
		mjConfig: () => Promise.resolve(cfg),
		mjGet: (c, dot) => dot.split('.').reduce(
			(o, k) => (o == null ? undefined : o[k]), c),
		mjMetricsSubscribe: (fn) => { metrics = fn; },
		apiFetch: (url, init) => {
			if (url === '/api/v1/osd') {
				return Promise.resolve(opts.osd === false
					? { ok: false, status: 404 }
					: { ok: true, json: () => Promise.resolve(opts.osd || {
						group: [FRAME.w, FRAME.h],
						streams: [{ stream: 0, frame: [FRAME.w, FRAME.h],
							view: [0, 0, FRAME.w, FRAME.h] }],
					}) });
			}
			pushes.push(JSON.parse(init.body));
			if (opts.reject || failOnce) {
				failOnce = false;
				return Promise.resolve({ ok: false, status: 500 });
			}
			if (opts.slow)
				return new Promise((r) => { held.push(
					() => r({ ok: true, json: () => Promise.resolve({ refused: 0 }) })); });
			return Promise.resolve({ ok: true,
				json: () => opts.badReply
					? Promise.reject(new Error('not json'))
					: Promise.resolve(opts.refuse
						? { refused: 1, keys: 'video0.roiRect' }
						: { refused: 0 }) });
		},
		setTimeout: (fn, ms) => { const t = { fn, ms }; pending.push(t); return t; },
		clearTimeout: (t) => { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); },
		document: {
			get visibilityState() { return visibility; },
			addEventListener: (ev, fn) => { listeners[ev] = fn; },
		},
	};
	const pending = [];
	const held = [];
	let failOnce = false;
	sandbox.window = sandbox;
	sandbox.MajesticRegion = { view: () => null };
	sandbox.MajesticZoom = { onView: (fn) => { onView = fn; }, view: () => null };
	sandbox.MajesticLiveStream = () => 0;
	sandbox.MajesticPreviewChip = () => {};
	sandbox.addEventListener = (ev, fn) => { listeners[ev] = fn; };
	sandbox.$ = () => null;

	vm.createContext(sandbox);
	vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'preview-roi.js' });

	// Drain the microtask queue rather than count `.then()` hops. The module
	// reads its configuration, then the crop map, then posts -- and how many
	// hops that is, is its business, not this test's. Counting them is how a
	// harness comes to assert against a state the code has not reached yet.
	const drain = () => new Promise((r) => setImmediate(r));

	// A view where `share` of the frame's AREA is on screen, anchored so the
	// rectangle is somewhere a viewer might plausibly have gone.
	const viewOf = (share, at) => {
		const k = Math.sqrt(share);
		const w = FRAME.w * k, h = FRAME.h * k;
		const x = (at || 0) * (FRAME.w - w);
		return { frame: FRAME, visible: { x, y: 0, w, h } };
	};

	// The config gate is a promise. `zoomFirst` delivers a view BEFORE it
	// settles, which is what a real page does: the zoom module publishes one
	// the moment it lays out, well before the configuration comes back.
	const ready = (async () => {
		if (opts.zoomFirst) {
			await drain();
			onView(viewOf(opts.zoomFirst, 0));
		}
		await drain();
	})();

	// Fire a view, then run the settle timer the module armed -- which is what
	// a viewer letting go of the picture does -- then let the push settle.
	const look = async (share, at) => {
		onView(viewOf(share, at));
		await drain();
		const t = pending.shift();
		if (t) t.fn();
		await drain();
	};

	const rate = (kbps) => metrics({
		ok: true, dt: 2, m: { v: { venc0_rcvd_bytes: kbps * 1000 * 2 / 8 } },
		prev: { v: { venc0_rcvd_bytes: 0 } },
	});

	const hide = (on) => {
		visibility = on ? 'hidden' : 'visible';
		listeners.visibilitychange();
	};

	// What the chip would say — the page's only disclosure that the camera is
	// being re-tuned, so a test of "does it claim" has to read exactly this.
	const claims = () => !!(sandbox.MajesticRoi && sandbox.MajesticRoi.note());

	// Run the settle timer without firing a view first — for the case where the
	// view was delivered before the module was ready to take it.
	const settle = async () => {
		await drain();
		const t = pending.shift();
		if (t) t.fn();
		await drain();
	};

	return { ready, look, rate, hide, pushes, claims, drain, settle,
		failNext: () => { failOnce = true; },
		release: () => { while (held.length) held.shift()(); },
		last: () => pushes[pushes.length - 1],
		armed: () => pending.length };
}

const rectOf = (p) => p && p.video0 && p.video0.roiRect;
const qpOf = (p) => p && p.video0 && p.video0.roiQp;

(async function () {

group('a picture that is nearly all on screen is not a region');
{
	const b = boot();
	await b.ready;
	await b.look(0.90);
	check('no push at 90% of the frame visible', b.pushes.length === 0,
		'pushed ' + JSON.stringify(b.pushes));
	await b.look(0.60);
	check('nor at 60%, which is still above the engage threshold',
		b.pushes.length === 0, 'pushed ' + JSON.stringify(b.pushes));
}

group('what is zoomed into becomes the region, in the stream\'s own pixels');
{
	const b = boot();
	await b.ready;
	await b.look(0.25);
	// A quarter of the AREA is half of each edge: 1296x760 at the left.
	check('one push', b.pushes.length === 1, 'got ' + b.pushes.length);
	check('the rectangle is the visible part of the frame',
		rectOf(b.last()) === '0x0x1296x760', 'got ' + rectOf(b.last()));
}

group('a region is not re-sent for a movement nobody made');
{
	const b = boot();
	await b.ready;
	await b.look(0.25, 0);
	const first = b.pushes.length;
	// A pan of a fiftieth of the frame: a wobble, not a decision.
	await b.look(0.25, 0.02);
	check('a small pan costs no request', b.pushes.length === first,
		'got ' + b.pushes.length);
	// Half the frame away is unmistakably somewhere else.
	await b.look(0.25, 1);
	check('a real pan does', b.pushes.length === first + 1);
	check('and carries the new rectangle',
		rectOf(b.last()) === '1296x0x1296x760', 'got ' + rectOf(b.last()));
}

group('opening the view back out takes the region away');
{
	const b = boot();
	await b.ready;
	await b.look(0.25);
	await b.look(0.95);
	check('a second push', b.pushes.length === 2, 'got ' + b.pushes.length);
	// The EMPTY STRING, not a list of no rectangles: empty means "put back
	// what is configured", and an empty list would instead delete regions
	// somebody saved.
	check('it is the empty string, which is the undo',
		rectOf(b.last()) === '', 'got ' + JSON.stringify(rectOf(b.last())));
}

group('it holds through the gap between the two thresholds');
{
	const b = boot();
	await b.ready;
	await b.look(0.25);
	// Above ENGAGE and below RELEASE. One threshold here would release, and
	// the next frame of the same zoom would engage again — the encoder
	// re-programmed twice for a hand that never stopped moving. It does keep
	// FOLLOWING the view, which is the whole idea, so what says it did not
	// release is that the push is still a rectangle rather than the undo.
	await b.look(0.65);
	check('no release between engage and release',
		rectOf(b.last()) !== '', 'got ' + JSON.stringify(rectOf(b.last())));
	await b.look(0.80);
	check('and it lets go above the upper one',
		rectOf(b.last()) === '', 'got ' + JSON.stringify(rectOf(b.last())));
}

group('how hard it pushes follows how much bitrate is spare');
{
	// The gain is the same at any bitrate; what the headroom decides is what
	// the REST of the picture pays. So push hardest where it is nearly free.
	const at = async (kbps) => {
		const b = boot();
		await b.ready;
		if (kbps !== null) b.rate(kbps);
		await b.look(0.25);
		return qpOf(b.last());
	};
	check('1.2 of 4 Mbps — room to spare', await at(1200) === '-16',
		'got ' + await at(1200));
	check('3 of 4 Mbps — fairly busy', await at(3000) === '-12',
		'got ' + await at(3000));
	check('at the ceiling, gently', await at(4000) === '-8',
		'got ' + await at(4000));
	check('and before any rate is known, the middle step',
		await at(null) === '-12', 'got ' + await at(null));
}

group('a tab nobody is looking at is not worth the camera\'s bits');
{
	const b = boot();
	await b.ready;
	await b.look(0.25);
	b.hide(true);
	check('hiding gives the region back', rectOf(b.last()) === '',
		'got ' + JSON.stringify(rectOf(b.last())));
	const n = b.pushes.length;
	await b.look(0.25);
	check('and nothing is pushed while it stays hidden',
		b.pushes.length === n, 'got ' + b.pushes.length);
}

group('a camera that refuses is asked once, not on every pan');
{
	const b = boot({ refuse: true });
	await b.ready;
	await b.look(0.25);
	check('the first push is made', b.pushes.length === 1);
	await b.look(0.20);
	check('and no more after it was named as refused',
		b.pushes.length === 1, 'got ' + b.pushes.length);
}

group('a camera with no region keys never asks at all');
{
	const b = boot({ config: { video0: { enabled: true, bitrate: 4096 } } });
	await b.ready;
	await b.look(0.25);
	check('nothing pushed', b.pushes.length === 0,
		'pushed ' + JSON.stringify(b.pushes));
}

group('a reply that is not the contract is not a confirmation');
{
	// A 200 whose body will not parse used to become {}, whose missing
	// `refused` read as "applied" — so the page claimed the recording was
	// being re-tuned with nothing from the camera saying so.
	const b = boot({ badReply: true });
	await b.ready;
	await b.look(0.25);
	check('the push was made', b.pushes.length === 1);
	check('but nothing is claimed on an unparseable 200', !b.claims());
}

group('the region is not disowned until the camera has let go of it');
{
	// The page has no control on screen to check against, so saying "nothing
	// is in force" while the encoder still holds a region is the one thing it
	// must never get wrong.
	const b = boot({ reject: true });
	await b.ready;
	await b.look(0.25);
	check('a failed push claims nothing', !b.claims());
}
{
	const b = boot();
	await b.ready;
	await b.look(0.25);
	check('claimed while it is in force', b.claims());
	b.failNext();
	await b.look(0.95);
	check('a failed CLEAR keeps the claim standing', b.claims(),
		'the camera may still hold the region');
}

group('a push that lands after a clear does not put the region back');
{
	const b = boot({ slow: true });
	await b.ready;
	b.look(0.25);            // armed and fired, but the reply is held
	await b.drain();
	b.hide(true);            // the viewer goes away before it lands
	await b.drain();
	b.release();             // the held reply arrives now
	await b.drain();
	await b.drain();
	check('the stale completion is dropped', !b.claims(),
		'a region was restored against a picture nobody is watching');
}

group('a zoom that happened before the camera answered is not lost');
{
	const b = boot({ zoomFirst: 0.25 });
	await b.ready;
	await b.settle();
	check('the held view is replayed once the keys are known',
		b.pushes.length === 1, 'got ' + b.pushes.length);
}

group('a camera that does not describe its crops still marks every channel');
{
	const b = boot({ osd: false, config: {
		video0: { roiRect: [], roiQp: '', enabled: true, bitrate: 4096,
			size: '2592x1520' },
		video1: { roiRect: [], roiQp: '', enabled: true, bitrate: 1024,
			size: '704x576' },
	} });
	await b.ready;
	await b.look(0.25);
	const p = b.last();
	check('the shown channel is marked', !!(p && p.video0));
	check('and so is the other one, from its configured size',
		!!(p && p.video1), 'the recording got none of the promised detail');
}

done();
})();
