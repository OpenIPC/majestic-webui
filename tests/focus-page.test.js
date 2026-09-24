// The focus page (www/a/focus.js).
//
// The page decides three things, and each fails quietly when it is wrong.
//
// Whether there is anything to read. A camera with no AF block still loads the
// editor perfectly well, so mounting without asking grows a Focus tab that can
// only apologise.
//
// Whether asking again could help. Only a 404 is the firmware saying it has no
// such endpoint; a 503 while the pipeline is down for an upgrade answers
// differently in a minute. Presenting the second as the first strands someone
// in front of a camera that was about to work.
//
// And what to do when the editor cannot be fetched. The numbers still come
// from the camera, and a rising number is what a lens is focused by -- so the
// page degrades to reading them out rather than apologising, which is also
// what the external-component gate requires of it.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const SRC = fs.readFileSync(
	path.join(__dirname, '..', 'www', 'a', 'focus.js'), 'utf8');

const IDS = ['focus-editor-host', 'focus-loading', 'focus-plain', 'focus-plain-why',
	'focus-plain-peak', 'focus-plain-where', 'focus-plain-counts',
	'focus-unsupported', 'focus-unsupported-txt', 'focus-unsupported-acts'];

// rows*cols = 6. Zone 4 is the sharpest, zone 3 is unlit, zone 0 is blown.
const GRID = {
	rows: 2, cols: 3, fields: ['h1', 'h2', 'v1', 'v2', 'y', 'hlcnt'],
	zones: [[0, 900, 0, 90, 1000, 40], [0, 100, 0, 10, 1000, 0],
		[0, 300, 0, 30, 1000, 0], [0, 50, 0, 5, 0, 0],
		[0, 1200, 0, 120, 1000, 0], [0, 200, 0, 20, 1000, 0]],
};

function load(opts) {
	opts = opts || {};
	const els = {};
	// Both notices and the plain panel carry `hidden` in focus.cgi. Starting
	// them visible here would let a page that never hides one still pass.
	IDS.forEach(function (id) {
		els[id] = { hidden: /plain$|unsupported$|acts$/.test(id), textContent: '' };
	});
	const state = { mounts: [], asked: 0, handlers: {}, timers: [] };

	const sandbox = {
		Promise: Promise, Object: Object, Error: Error, JSON: JSON,
		Array: Array, Date: Date, Math: Math, String: String,
		isFinite: isFinite, Uint8Array: Uint8Array,
		setTimeout: setTimeout, clearTimeout: clearTimeout,
		setInterval: function (fn, ms) { state.timers.push(fn); return state.timers.length; },
		clearInterval: function () {},
		location: { href: '' },
		document: {
			getElementById: (id) =>
				(Object.prototype.hasOwnProperty.call(els, id) ? els[id] : null),
			addEventListener: function (n, fn) {
				(state.handlers[n] = state.handlers[n] || []).push(fn);
			},
		},
		apiFetch: function (url) {
			if (url.indexOf('/api/v1/isp/af-zones.json') === 0) {
				state.asked++;
				if (opts.status && opts.status !== 200)
					return Promise.resolve({ ok: false, status: opts.status });
				if (opts.netFail) return Promise.reject(new TypeError('network'));
				return Promise.resolve({
					ok: true, status: 200,
					json: () => Promise.resolve(
						opts.grid !== undefined ? opts.grid : GRID),
				});
			}
			return Promise.resolve({
				ok: true, status: 200,
				arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
			});
		},
	};
	if (opts.editorMissing !== true) {
		sandbox.MajesticRaw = {
			available: opts.editorAvailable === false ? false : true,
			mount: function (host, o) {
				state.mounts.push(o);
				return opts.mountFails
					? Promise.reject(new Error('network'))
					: Promise.resolve({});
			},
		};
	}
	sandbox.window = sandbox;
	vm.runInContext(SRC, vm.createContext(sandbox), { filename: 'focus.js' });
	return { els: els, state: state, sandbox: sandbox };
}

async function run(opts) {
	const l = load(opts);
	(l.state.handlers['DOMContentLoaded'] || []).forEach((fn) => fn());
	for (let i = 0; i < 14; i++) await Promise.resolve();
	return l;
}

(async () => {
	group('a camera that can answer gets the editor, and the grid whole');

	let l = await run({});
	check('it asks the camera before mounting anything', l.state.asked === 1);
	check('and then mounts', l.state.mounts.length === 1);
	const o = l.state.mounts[0];
	check('with somewhere to read statistics from',
		!!(o.focus && typeof o.focus.zones === 'function'));
	check('and a polling interval',
		typeof o.focus.intervalMs === 'number' && o.focus.intervalMs > 0);
	// Read-only: a measurement has nothing to take back, so passing the write
	// vocabulary would arm a countdown over something that never wrote.
	check('and nothing to write with, because nothing is written',
		o.calibrate === undefined && o.plates === undefined);
	const grid = await o.focus.zones();
	check('the grid reaches the editor unreduced',
		grid.rows === 2 && grid.cols === 3 && grid.zones.length === 6 &&
		grid.zones[0].length === 6);

	group('a shape the page cannot trust is refused, not forwarded');

	// Every one of these satisfies a truthiness check on rows and cols and an
	// Array.isArray on zones, and each divides a frame into cells that are
	// empty, lopsided or off-screen.
	const BAD = [
		{}, { rows: 2, cols: 3 },
		{ rows: 0, cols: 0, zones: [] },
		{ rows: 2, cols: 3, zones: 'nope' },
		{ rows: 2, cols: 3, zones: [] },                       // declared, absent
		{ rows: 2, cols: 3, zones: GRID.zones.slice(0, 5) },   // short
		{ rows: 2, cols: 3, zones: GRID.zones.concat([[0, 0, 0, 0, 0, 0]]) }, // long
		{ rows: -2, cols: -3, zones: GRID.zones },             // negative
		{ rows: 1.5, cols: 4, zones: GRID.zones },             // fractional
		{ rows: 2, cols: 3, zones: GRID.zones.map(() => [1, 2, 3]) }, // short zones
		{ rows: 2, cols: 3, zones: GRID.zones.map(() => [1, 2, 3, 4, 5, 'x']) },
	];
	for (const bad of BAD) {
		l = await run({ grid: bad });
		check('refused: ' + JSON.stringify(bad).slice(0, 52),
			l.state.mounts.length === 0 && l.els['focus-plain'].hidden === true);
	}

	group('only a firmware that has no such endpoint is a dead end');

	l = await run({ status: 404 });
	check('404 says so and offers no retry',
		l.els['focus-unsupported'].hidden === false &&
		l.els['focus-unsupported-acts'].hidden === true);
	check('and nothing is mounted', l.state.mounts.length === 0);

	// A 503 is the pipeline being down as often as it is a part with no AF, and
	// the status cannot separate them. A retry costs one click; withholding it
	// from a camera that was about to work costs the visit.
	for (const t of [{ status: 503 }, { status: 500 }, { netFail: true },
		{ grid: { rows: 0, cols: 0, zones: [] } }]) {
		l = await run(t);
		check('retryable: ' + JSON.stringify(t),
			l.els['focus-unsupported'].hidden === false &&
			l.els['focus-unsupported-acts'].hidden === false);
	}

	l = await run({ status: 503 });
	const txt = l.els['focus-unsupported-txt'].textContent;
	check('503 names both of the things it can mean',
		/no AF block/i.test(txt) && /pipeline is not running/i.test(txt), txt);
	check('and says the upgrade case resolves itself', /on its own/i.test(txt), txt);

	group('without the editor the page still reads the camera out');

	for (const t of [{ mountFails: true }, { editorAvailable: false },
		{ editorMissing: true }]) {
		l = await run(t);
		check('degraded, not broken: ' + JSON.stringify(t),
			l.els['focus-plain'].hidden === false &&
			l.els['focus-unsupported'].hidden === true);
		// blend() of the sharpest zone: (1200*54 + 120*10) / 64.
		check('  and the sharpest cell is read out',
			l.els['focus-plain-peak'].textContent ===
			String(Math.trunc((1200 * 54 + 120 * 10) / 64)),
			l.els['focus-plain-peak'].textContent);
		check('  with where it is',
			/Row 2, column 2 of 2 × 3/.test(l.els['focus-plain-where'].textContent),
			l.els['focus-plain-where'].textContent);
		check('  and it says which of its functions is missing',
			/picture and the heatmap/i.test(l.els['focus-plain-why'].textContent),
			l.els['focus-plain-why'].textContent);
		check('  and it keeps asking', l.state.timers.length === 1);
	}

	// The module is imported by the browser, from a CDN or from whatever
	// MJ_RAW_BASE names. Sending someone to check the camera's uplink points
	// at a link that was never in the path.
	l = await run({ mountFails: true });
	const why = l.els['focus-plain-why'].textContent;
	check('the route it names is the browser\'s, not the camera\'s',
		/this browser fetches it/i.test(why) && !/camera with no route/i.test(why),
		why);
	check('and it does not describe the camera as failing to measure',
		!/\bAF\b|statistic/i.test(why), why);

	group('the readout uses the bank that tracks focus');

	// h1 and v1 are a differently tuned pair that can read HIGHER as the
	// picture blurs. A readout built on them looks entirely plausible and
	// points the wrong way, so the blend has to be the editor's.
	l = await run({
		mountFails: true,
		grid: { rows: 1, cols: 2, zones: [[9999, 10, 9999, 1, 1000, 0],
			[0, 100, 0, 10, 1000, 0]] },
	});
	check('a huge h1/v1 does not outrank a larger h2/v2',
		l.els['focus-plain-peak'].textContent ===
		String(Math.trunc((100 * 54 + 10 * 10) / 64)),
		l.els['focus-plain-peak'].textContent);

	done();
})();
