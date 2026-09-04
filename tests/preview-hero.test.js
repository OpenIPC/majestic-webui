// preview-hero.js — how the control bar and the PTZ pad share the bottom of
// the Live stage.
//
// What must hold, in one sentence each: the bar's measured strip is published
// for the two pieces of chrome that have to keep off it; the pad rides above
// that strip where the stage is tall enough to stack them; where it is not and
// the stage is wider than tall the bar gives way sideways instead; and the
// answer is a function of the stage's size alone, never of the order it was
// resized in — which is the one that is easy to get wrong, because reserving
// the pad's column makes the bar taller and a naive second pass reads that
// back as even less room.
//
// It is here rather than left to the camera because reaching the fault needs a
// phone, a camera with a PTZ pad and a particular orientation, and it is
// silent when it happens: the pad simply draws over two of the bar's rows, the
// page reports nothing, and every control it covers is still in the DOM.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const SRC = path.join(__dirname, '..', 'www', 'a', 'preview-hero.js');

// A stand-in for the parts of an element this file measures. The bar's height
// is not a constant given to the test: it is derived from the lane it has,
// the way a wrapping flex row derives it, so reserving the pad's column really
// does cost rows here as it does in a browser.
function makeStage(opts) {
	const groups = opts.groups; // widths, in the bar's own order
	const gap = 8, padX = 24, padTop = 20, padBottom = 8, rowH = 52;
	const el = (id) => ({
		id,
		style: {
			_v: {},
			setProperty(k, v) { this._v[k] = v; },
			getPropertyValue(k) { return this._v[k] || ''; },
		},
		_cls: new Set(),
		classList: {
			add(c) { el._self._cls.add(c); },
			remove(c) { el._self._cls.delete(c); },
			contains(c) { return el._self._cls.has(c); },
			toggle(c, on) { on ? this.add(c) : this.remove(c); },
		},
		addEventListener() {},
	});
	const mk = (id) => { const o = el(id); o._self = o; o.classList = {
		add: (c) => o._cls.add(c), remove: (c) => o._cls.delete(c),
		contains: (c) => o._cls.has(c),
		toggle: (c, on) => (on ? o._cls.add(c) : o._cls.delete(c)),
	}; return o; };

	const stage = mk('mj-stage'), bar = mk('mj-bar'), ptz = mk('mj-ptz');
	stage.clientWidth = opts.w;
	stage.clientHeight = opts.h;
	ptz.offsetHeight = opts.padH;
	ptz.offsetWidth = opts.padW;
	// The bar wraps into whatever lane it is left, and .mj-ptz-beside is the
	// stylesheet reserving the pad's column out of that lane. Read off the
	// stage's CURRENT width, so a resize moves the rows as it would in a
	// browser — the first draft of this stub kept the width it was built with
	// and made every post-resize assertion meaningless.
	Object.defineProperty(bar, 'clientHeight', {
		get() {
			const lane = stage.clientWidth - padX -
				(stage._cls.has('mj-ptz-beside') ? ptz.offsetWidth + 16 : 0);
			let rows = 1, cur = 0;
			for (const g of groups) {
				const need = cur === 0 ? g : cur + gap + g;
				if (need > lane && cur > 0) { rows++; cur = g; } else { cur = need; }
			}
			return padTop + rows * rowH + (rows - 1) * gap + padBottom;
		},
	});
	return { stage, bar, ptz, padTop };
}

// Runs the module against one stage and hands back what it published, plus the
// ResizeObserver callback so a test can re-run a layout after a resize.
function boot(opts) {
	const { stage, bar, ptz, padTop } = makeStage(opts);
	const els = { '#mj-stage': stage, '#mj-bar': bar, '#mj-ptz': ptz };
	let onResize = null;
	const sandbox = {
		window: {},
		document: { addEventListener() {}, fullscreenEnabled: false },
		$: (sel) => (sel in els ? els[sel] : null),
		getComputedStyle: () => ({ paddingTop: padTop + 'px' }),
		ResizeObserver: function (fn) { onResize = fn; this.observe = () => {}; },
		setTimeout, clearTimeout, console,
		mjConfig: () => ({ then: () => {} }),
		mjGet: () => undefined,
		apiFetch: () => ({ then: () => ({ then: () => ({ catch: () => ({ finally: () => {} }) }) }) }),
	};
	vm.createContext(sandbox);
	vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'preview-hero.js' });
	const read = () => ({
		barH: stage.style._v['--mj-bar-h'],
		padHVar: stage.style._v['--mj-ptz-h'],
		padWVar: stage.style._v['--mj-ptz-w'],
		beside: stage._cls.has('mj-ptz-beside'),
		strip: bar.clientHeight - padTop,
	});
	return { stage, bar, ptz, read, resize: (w, h) => {
		stage.clientWidth = w; stage.clientHeight = h;
		if (onResize) onResize();
	} };
}

// The six groups a camera without audio or talkback shows, measured on an
// hi3516ev300: View, Area, Stream, Transport, Stats, icons.
const SIX = [161, 108, 189, 146, 113, 98];
// The eight a camera with both shows, with the volume group and Talk.
const EIGHT = [161, 108, 189, 150, 110, 146, 113, 98];
const PELCO = { padH: 211, padW: 134 };

group('the strip the bar occupies is published, measured, not assumed');
{
	const b = boot({ w: 390, h: 785, groups: SIX, ...PELCO });
	const r = b.read();
	check('--mj-bar-h is the rows, without the gradient padding',
		r.barH === '180.00px', 'got ' + r.barH);
	check('the pad publishes its own size for the stylesheet clamp',
		r.padHVar === '211px' && r.padWVar === '134px',
		r.padHVar + ' / ' + r.padWVar);
}

group('a camera with no pad still publishes the strip');
{
	const b = boot({ w: 390, h: 785, groups: SIX, padH: 0, padW: 0 });
	const r = b.read();
	check('the stats panel gets its ceiling anyway', r.barH === '180.00px', 'got ' + r.barH);
	check('nothing claims an arrangement', r.beside === false);
	check('no pad size is invented', r.padHVar === undefined && r.padWVar === undefined);
}

group('which way the two give depends on which dimension has room');
{
	const portrait = boot({ w: 390, h: 785, groups: SIX, ...PELCO });
	check('a portrait phone stacks: the pad rides above the bar',
		portrait.read().beside === false);

	const landscape = boot({ w: 740, h: 301, groups: SIX, ...PELCO });
	check('a landscape phone cannot stack, and gives way sideways instead',
		landscape.read().beside === true);

	const desk = boot({ w: 1440, h: 841, groups: SIX, ...PELCO });
	check('a desktop window stacks', desk.read().beside === false);
}

group('a portrait stage too small for either arrangement keeps the stacking');
{
	// 320x568 with audio and talkback: reserving the column would leave a lane
	// narrower than one group, and the bar would answer with a row per group.
	const b = boot({ w: 320, h: 509, groups: EIGHT, ...PELCO });
	const r = b.read();
	check('the column is not reserved', r.beside === false);
	// Five rows and the bar's own bottom padding, against the eight rows the
	// reserved column would have forced.
	check('the bar is not driven to a row per group',
		r.strip <= 5 * 52 + 4 * 8 + 8, 'strip ' + r.strip);
}

group('the arrangement is a function of the size, not of the resize history');
{
	// Landscape short first (beside, so the bar is taller), then the same
	// stage as the portrait case above. Reading the bar back as the previous
	// answer left it is what used to keep .mj-ptz-beside alive.
	const b = boot({ w: 740, h: 301, groups: SIX, ...PELCO });
	check('starts beside', b.read().beside === true);
	b.resize(390, 785);
	const after = b.read();
	const fresh = boot({ w: 390, h: 785, groups: SIX, ...PELCO }).read();
	check('resized into a portrait stage, it stacks like a fresh one',
		after.beside === fresh.beside && after.barH === fresh.barH,
		after.beside + '/' + after.barH + ' vs ' + fresh.beside + '/' + fresh.barH);

	// The same in the one dimension that keeps the stage wider than tall: a
	// short landscape stage growing tall enough to stack.
	const c = boot({ w: 740, h: 301, groups: SIX, ...PELCO });
	check('starts beside', c.read().beside === true);
	c.resize(740, 600);
	const grown = c.read();
	const freshWide = boot({ w: 740, h: 600, groups: SIX, ...PELCO }).read();
	check('grown taller, it stops reserving the column',
		grown.beside === false && grown.barH === freshWide.barH,
		grown.beside + '/' + grown.barH + ' vs ' + freshWide.barH);
}

group('the published strip describes the arrangement in force');
{
	const b = boot({ w: 740, h: 301, groups: SIX, ...PELCO });
	const r = b.read();
	check('beside publishes the taller, column-reserving bar',
		r.barH === r.strip.toFixed(2) + 'px', r.barH + ' vs ' + r.strip);
}

done();
