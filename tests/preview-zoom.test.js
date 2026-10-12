// Two fingers on the Live picture (preview-zoom.js).
//
// A spread that lands one finger first -- which is every spread -- used to
// start a zoom rectangle under that finger in Fit, ignore the second, and on
// release jump the view to whatever box the first finger had traced. Nothing
// errors and the view does zoom, so on a phone it reads as a pinch that goes
// somewhere random; reproducing it takes a touch screen and two hands. This
// drives the module in a bare vm with a DOM just big enough for it and checks
// what each gesture did to the view and to the band.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const ok = (cond, label) => check(label, !!cond);
const SRC = fs.readFileSync(path.join(__dirname, '..', 'www', 'a', 'preview-zoom.js'), 'utf8');

// A 390x700 portrait phone stage at the page origin, and a 3840x2160 stream:
// Fit is ~10%, letterboxed top and bottom, exactly the reported case.
const SW = 390, SH = 700, FW = 3840, FH = 2160;

function makeEl(id) {
	const listeners = {};
	const set = new Set();
	const e = {
		id: id, hidden: false, checked: false, style: { setProperty() {} },
		classList: {
			toggle(c, on) { if (on === undefined) on = !set.has(c); if (on) set.add(c); else set.delete(c); return on; },
			add(c) { set.add(c); }, remove(c) { set.delete(c); }, contains(c) { return set.has(c); },
		},
		clientWidth: SW, clientHeight: SH, offsetHeight: 0,
		getBoundingClientRect: () => ({ left: 0, top: 0 }),
		setPointerCapture() {}, releasePointerCapture() {},
		querySelectorAll() { return []; },
		querySelector() { return null; },
		closest() { return null; },
		addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
		fire(type, ev) {
			(listeners[type] || []).forEach((fn) => fn(Object.assign({
				type: type, target: e, button: 0, preventDefault() {},
			}, ev)));
		},
	};
	return e;
}

function boot() {
	const els = {};
	['#mj-stage', '#mj-view-fit', '#mj-view-fill', '#mj-view-one', '#mj-view-ctl',
		'#mj-area-ctl', '#mj-area', '#mj-marquee'].forEach((s) => { els[s] = makeEl(s.slice(1)); });
	const band = els['#mj-marquee'];
	band.hidden = true;
	// Every moment the band was on screen, however brief: a band that
	// flickers up under the first finger of a pinch is the bug's own face.
	let hidden = true, shown = 0;
	Object.defineProperty(band, 'hidden', {
		get() { return hidden; },
		set(v) { hidden = !!v; if (!hidden) shown++; },
	});
	const docListeners = {};
	const sandbox = {
		$: (s) => els[s] || null,
		localStorage: { getItem: () => null, setItem() {} },
		document: { addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); } },
		addEventListener() {},
		getComputedStyle: () => ({ display: 'block' }),
		Map: Map, Math: Math, Event: function (t) { this.type = t; },
	};
	sandbox.window = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(SRC, sandbox);
	const Z = sandbox.MajesticZoom;
	Z.setFrame(FW, FH);
	const stage = els['#mj-stage'];

	function radio(name) {
		const el = els['#mj-view-' + name];
		el.checked = true;
		el.fire('change');
	}
	function area(on) {
		const el = els['#mj-area'];
		el.checked = on;
		el.fire('change');
	}
	const ev = (id, type, x, y) => ({ pointerId: id, pointerType: type, clientX: x, clientY: y });
	const down = (id, type, x, y) => stage.fire('pointerdown', ev(id, type, x, y));
	const move = (id, type, x, y) => stage.fire('pointermove', ev(id, type, x, y));
	const up = (id, type, x, y) => stage.fire('pointerup', ev(id, type, x, y));

	// The middle of the picture, where a symmetric spread is centred.
	const MX = SW / 2, MY = SH / 2;
	// Finger A lands alone, drifts a few pixels the way a real one does, then
	// B lands and the two move apart (or together) symmetrically about the
	// middle, A up-left and B down-right.
	function pinch(from, to, opts) {
		opts = opts || {};
		const A = (d) => [MX - d * 0.6, MY - d * 0.3], B = (d) => [MX + d * 0.6, MY + d * 0.3];
		if (!opts.aDown) {
			down(1, 'touch', ...A(from));
			move(1, 'touch', ...A(from + 6));
			from += 6;
		}
		down(opts.bId || 2, 'touch', ...B(from));
		for (let i = 1; i <= 12; i++) {
			const d = from + (to - from) * i / 12;
			move(1, 'touch', ...A(d));
			move(opts.bId || 2, 'touch', ...B(d));
		}
		if (!opts.keepA) up(1, 'touch', ...A(to));
		up(opts.bId || 2, 'touch', ...B(to));
		return to;
	}

	return {
		Z, stage, els, radio, area, pinch, down, move, up,
		shown: () => shown, resetShown: () => { shown = 0; },
		drawable: () => stage.classList.contains('mj-drawable'),
		centre: () => { const v = Z.view().visible; return { x: v.x + v.w / 2, y: v.y + v.h / 2 }; },
	};
}

const centred = (c) => Math.abs(c.x - FW / 2) < FW * 0.02 && Math.abs(c.y - FH / 2) < FH * 0.02;

group('a spread from Fit is a pinch');
{
	const t = boot();
	t.radio('fit');
	const fit = t.Z.scalePct();
	ok(t.drawable() && fit === 10, 'Fit on a portrait phone is drawable, at 10%');
	t.pinch(40, 160);
	ok(t.shown() === 0, 'no band is drawn, not even for a moment');
	ok(t.Z.scalePct() > fit * 3, 'the picture zoomed by the spread (' + fit + '% to ' + t.Z.scalePct() + '%)');
	ok(centred(t.centre()), 'about the fingers\' midpoint, not a box the first finger traced');
	t.pinch(160, 20);
	ok(t.Z.scalePct() === fit && t.drawable(), 'squeezing back lands on Fit');
}

group('one finger in Fit still draws a rectangle');
{
	const t = boot();
	t.radio('fit');
	t.down(1, 'touch', 100, 300);
	for (let i = 1; i <= 8; i++) t.move(1, 'touch', 100 + 15 * i, 300 + 10 * i);
	t.up(1, 'touch', 220, 380);
	ok(t.shown() > 0, 'the band is shown once the drag is a rectangle');
	ok(t.Z.scalePct() > 10, 'and the view zooms to it');
	const c = t.centre();
	ok(c.x < FW / 2, 'to the part of the picture it was drawn over');
}

group('a few pixels of one finger show no band');
{
	const t = boot();
	t.radio('fit');
	t.down(1, 'touch', 150, 350);
	t.move(1, 'touch', 156, 353);
	ok(t.shown() === 0, 'a drift below the slip size draws nothing on touch');
	t.up(1, 'touch', 156, 353);
	ok(t.Z.scalePct() === 10, 'and zooms nothing');
}

group('a spread with Area armed pinches and leaves Area armed');
{
	const t = boot();
	t.radio('fit');
	t.area(true);
	ok(t.stage.classList.contains('mj-armed'), 'armed');
	t.pinch(40, 160);
	ok(t.shown() === 0, 'no band');
	ok(centred(t.centre()) && t.Z.scalePct() > 30, 'the pinch zoomed about the middle');
	ok(t.stage.classList.contains('mj-armed') && t.els['#mj-area'].checked, 'Area still armed and lit for the next drag');
}

group('a pinch squeezed to Fit resumes with a finger still resting');
{
	const t = boot();
	t.radio('fill');
	// Squeeze from Fill down past Fit, lifting only B.
	const to = t.pinch(200, 10, { keepA: true });
	ok(t.drawable(), 'the picture is back at Fit, drawable, under finger A');
	t.resetShown();
	// C lands while A rests, and the two spread.
	t.pinch(to, 160, { aDown: true, bId: 3 });
	ok(t.shown() === 0, 'the new finger joined A rather than starting a band');
	ok(t.Z.scalePct() > 30 && centred(t.centre()), 'and the two pinched');
}

group('a mouse beside a resting finger still draws, with Area armed');
{
	const t = boot();
	t.radio('fill');
	// A finger rests on a pannable picture.
	t.down(1, 'touch', 195, 350);
	t.area(true);
	t.down(9, 'mouse', 100, 300);
	for (let i = 1; i <= 8; i++) t.move(9, 'mouse', 100 + 10 * i, 300 + 10 * i);
	const before = t.Z.scalePct();
	t.up(9, 'mouse', 180, 380);
	ok(t.shown() > 0, 'the mouse drew a band');
	ok(t.Z.scalePct() > before, 'and zoomed to it');
	ok(!t.stage.classList.contains('mj-armed'), 'then Area disarmed, as after any rectangle');
	t.up(1, 'touch', 195, 350);
}

group('a pen rectangle is not taken over by a finger');
{
	const t = boot();
	t.radio('fit');
	t.down(1, 'pen', 100, 300);
	for (let i = 1; i <= 4; i++) t.move(1, 'pen', 100 + 20 * i, 300 + 15 * i);
	t.down(2, 'touch', 300, 400);
	t.move(2, 'touch', 320, 420);
	t.up(2, 'touch', 320, 420);
	t.up(1, 'pen', 180, 360);
	ok(t.shown() > 0 && t.Z.scalePct() > 10 && t.centre().x < FW / 2, 'the pen\'s rectangle is the one zoomed to');
}

done();
