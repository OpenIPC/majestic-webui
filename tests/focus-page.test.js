// The focus page (www/a/focus.js).
//
// The page's whole job is to decide whether there is anything to show and then
// get out of the way. Two of its decisions fail quietly if they are wrong.
//
// A camera with no AF block still loads the editor perfectly well, so mounting
// without asking first grows a Focus tab that can only apologise -- and the
// operator is left reloading a page that was never going to work. And the two
// ways this page can fail say opposite things about where the fault is: the
// editor not arriving is the browser's route to the internet, the camera not
// reporting statistics is the camera. Wording either as the other sends
// someone to check the wrong thing.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const SRC = fs.readFileSync(
	path.join(__dirname, '..', 'www', 'a', 'focus.js'), 'utf8');

const IDS = ['focus-editor-host', 'focus-loading', 'focus-fallback',
	'focus-fallback-txt', 'focus-unsupported', 'focus-unsupported-txt'];

function load(opts) {
	opts = opts || {};
	const els = {};
	// Both notices carry `hidden` in focus.cgi. Starting them visible here
	// would let a page that never hides one still pass.
	IDS.forEach(function (id) {
		els[id] = { hidden: /fallback$|unsupported$/.test(id), textContent: '' };
	});
	const state = { mounts: [], asked: 0, handlers: {} };

	const sandbox = {
		Promise: Promise, Object: Object, Error: Error, JSON: JSON,
		Array: Array, Date: Date, setTimeout: setTimeout,
		location: { href: '' },
		document: {
			getElementById: function (id) {
				return Object.prototype.hasOwnProperty.call(els, id) ? els[id] : null;
			},
			addEventListener: function (n, fn) {
				(state.handlers[n] = state.handlers[n] || []).push(fn);
			},
		},
		apiFetch: function (url) {
			if (url.indexOf('/api/v1/isp/af-zones.json') === 0) {
				state.asked++;
				if (opts.status && opts.status !== 200)
					return Promise.resolve({ ok: false, status: opts.status });
				return Promise.resolve({
					ok: true, status: 200,
					json: () => Promise.resolve(opts.grid !== undefined ? opts.grid : {
						rows: 2, cols: 3, fields: ['h1', 'h2', 'v1', 'v2', 'y', 'hlcnt'],
						zones: [[0, 900, 0, 90, 1000, 0], [0, 100, 0, 10, 1000, 0],
							[0, 300, 0, 30, 1000, 0], [0, 50, 0, 5, 1, 0],
							[0, 700, 0, 70, 1000, 0], [0, 200, 0, 20, 1000, 0]],
					}),
				});
			}
			return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });
		},
		MajesticRaw: {
			available: opts.editorAvailable === false ? false : true,
			mount: function (host, o) {
				state.mounts.push(o);
				return opts.mountFails
					? Promise.reject(new Error('network'))
					: Promise.resolve({});
			},
		},
	};
	sandbox.window = sandbox;
	sandbox.Uint8Array = Uint8Array;
	vm.runInContext(SRC, vm.createContext(sandbox), { filename: 'focus.js' });
	return { els: els, state: state, sandbox: sandbox };
}

// The page does its work on DOMContentLoaded; settle the promise chain it
// starts there before looking at what it decided.
async function run(opts) {
	const l = load(opts);
	(l.state.handlers['DOMContentLoaded'] || []).forEach(function (fn) { fn(); });
	for (let i = 0; i < 12; i++) await Promise.resolve();
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
	check('and a polling interval', typeof o.focus.intervalMs === 'number' && o.focus.intervalMs > 0);
	// Read-only: a measurement has nothing to take back, so passing the write
	// vocabulary would arm a countdown over something that never wrote.
	check('and nothing to write with, because nothing is written',
		o.calibrate === undefined && o.plates === undefined);

	const grid = await o.focus.zones();
	check('the grid reaches the editor unreduced',
		grid.rows === 2 && grid.cols === 3 && grid.zones.length === 6 &&
		grid.zones[0].length === 6,
		JSON.stringify(grid && grid.rows) + 'x' + JSON.stringify(grid && grid.cols));
	check('the loading placeholder is taken down once the editor is up',
		l.els['focus-loading'].hidden === true);

	group('a camera with no AF block is told so, and no dead tab is grown');

	for (const st of [404, 503]) {
		l = await run({ status: st });
		check(st + ': nothing is mounted', l.state.mounts.length === 0);
		check(st + ': the camera notice is shown, not the editor one',
			l.els['focus-unsupported'].hidden === false &&
			l.els['focus-fallback'].hidden === true);
	}

	l = await run({ status: 503 });
	const txt = l.els['focus-unsupported-txt'].textContent;
	// 503 has two causes and the status alone cannot separate them. Naming one
	// would send half the people who see it to check the wrong thing.
	check('503 names both of the things it can mean',
		/no AF block/i.test(txt) && /pipeline is not running/i.test(txt), txt);
	l = await run({ status: 404 });
	check('and 404 says something different',
		l.els['focus-unsupported-txt'].textContent !== txt);

	group('a grid the page cannot read is refused rather than drawn');

	for (const bad of [{}, { rows: 2, cols: 3 }, { rows: 0, cols: 0, zones: [] },
		{ rows: 2, cols: 3, zones: 'nope' }]) {
		l = await run({ grid: bad });
		check('refused: ' + JSON.stringify(bad), l.state.mounts.length === 0);
	}

	group('the editor failing to arrive is a different sentence from the camera failing');

	l = await run({ mountFails: true });
	check('the editor notice is shown', l.els['focus-fallback'].hidden === false);
	check('and not the camera one', l.els['focus-unsupported'].hidden === true);
	// It may well mention the camera -- "a camera with no route out" is the
	// actual cause. What it must not do is describe this as the camera failing
	// to report focus statistics, which is the other notice's sentence.
	check('it does not describe it as the camera failing to measure',
		!/AF|statistic/i.test(l.els['focus-fallback-txt'].textContent),
		l.els['focus-fallback-txt'].textContent);

	l = await run({ editorAvailable: false });
	check('a browser too old never reaches the camera at all', l.state.asked === 0);
	check('and is told what is missing',
		/browser/i.test(l.els['focus-fallback-txt'].textContent),
		l.els['focus-fallback-txt'].textContent);

	done();
})();
