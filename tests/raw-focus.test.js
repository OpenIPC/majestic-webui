// Live focus statistics for the editor's Focus tab (www/a/raw-focus.js).
//
// The editor grows a Focus tab only when it is handed this object, and the tab
// is created at mount and cannot be grown afterwards. So the one decision here
// -- is there anything to read -- has to be made before the editor is mounted,
// and made correctly: a camera whose part has no AF block loads the editor
// perfectly well, so handing the capability over regardless grows a tab that
// can only ever apologise.
//
// The other half is the grid itself. It goes over as the camera measured it,
// because the editor does the deciding about which zones are worth believing;
// what must not go over is a grid whose declared shape and contents disagree.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const SRC = fs.readFileSync(
	path.join(__dirname, '..', 'www', 'a', 'raw-focus.js'), 'utf8');

const GRID = {
	rows: 2, cols: 3, fields: ['h1', 'h2', 'v1', 'v2', 'y', 'hlcnt'],
	zones: [[0, 900, 0, 90, 1000, 40], [0, 100, 0, 10, 1000, 0],
		[0, 300, 0, 30, 1000, 0], [0, 50, 0, 5, 0, 0],
		[0, 1200, 0, 120, 1000, 0], [0, 200, 0, 20, 1000, 0]],
};

function load(opts) {
	opts = opts || {};
	const state = { asked: 0 };
	const sandbox = {
		Promise: Promise, Object: Object, Error: Error, Array: Array,
		Math: Math, isFinite: isFinite, JSON: JSON,
		setTimeout: setTimeout, clearTimeout: clearTimeout,
		apiFetch: function (url) {
			state.asked++;
			state.lastUrl = url;
			if (opts.netFail) return Promise.reject(new TypeError('network'));
			// A socket nobody ever answers: neither resolves nor rejects.
			if (opts.hang) return new Promise(function () {});
			if (opts.gridSeq) {
				const g = opts.gridSeq[Math.min(state.asked - 1, opts.gridSeq.length - 1)];
				return Promise.resolve({ ok: true, status: 200,
					json: () => Promise.resolve(g) });
			}
			if (opts.status && opts.status !== 200)
				return Promise.resolve({ ok: false, status: opts.status });
			return Promise.resolve({
				ok: true, status: 200,
				json: () => Promise.resolve(opts.grid !== undefined ? opts.grid : GRID),
			});
		},
	};
	sandbox.window = sandbox;
	vm.runInContext(SRC, vm.createContext(sandbox), { filename: 'raw-focus.js' });
	return { api: sandbox.MajesticFocus, state: state };
}

(async () => {
	group('a camera with statistics offers them, and the grid goes over whole');

	let { api, state } = load({});
	check('it asks the camera as soon as it is loaded', state.asked === 1);
	check('and asks the right endpoint',
		state.lastUrl === '/api/v1/isp/af-zones.json', state.lastUrl);
	check('the capability is ready', (await api.ready) === true);
	check('and carries a polling interval',
		typeof api.intervalMs === 'number' && api.intervalMs > 0);

	const g = await api.zones();
	check('the grid is handed over unreduced',
		g.rows === 2 && g.cols === 3 && g.zones.length === 6 &&
		g.zones[0].length === 6);

	group('a camera with nothing to report grows no tab at all');

	// Each of these loads the editor perfectly well. Handing the capability
	// over anyway would grow a Focus tab that could only apologise.
	for (const t of [{ status: 404 }, { status: 503 }, { status: 500 },
		{ status: 401 }, { netFail: true }]) {
		({ api } = load(t));
		check('no tab: ' + JSON.stringify(t), (await api.ready) === false);
	}

	group('a shape the page cannot trust grows no tab either');

	// Every one of these satisfies a truthiness check on rows and cols and an
	// Array.isArray on zones, and each divides a frame into cells that are
	// empty, lopsided or off-screen.
	const BAD = [
		{}, { rows: 2, cols: 3 },
		{ rows: 0, cols: 0, zones: [] },
		{ rows: 2, cols: 3, zones: 'nope' },
		{ rows: 2, cols: 3, zones: [] },
		{ rows: 2, cols: 3, zones: GRID.zones.slice(0, 5) },
		{ rows: 2, cols: 3, zones: GRID.zones.concat([[0, 0, 0, 0, 0, 0]]) },
		{ rows: -2, cols: -3, zones: GRID.zones },
		{ rows: 1.5, cols: 4, zones: GRID.zones },
		{ rows: 2, cols: 3, zones: GRID.zones.map(() => [1, 2, 3]) },
		{ rows: 2, cols: 3, zones: GRID.zones.map(() => [1, 2, 3, 4, 5, 'x']) },
	];
	for (const bad of BAD) {
		({ api } = load({ grid: bad }));
		check('refused: ' + JSON.stringify(bad).slice(0, 52),
			(await api.ready) === false);
	}

	group('a failed probe never throws at the editor');

	// ready is awaited on the path that mounts the editor. A rejection there
	// would take the whole raw page down with it, over a tab.
	for (const t of [{ netFail: true }, { status: 500 }, { grid: null }]) {
		({ api } = load(t));
		let threw = false;
		await api.ready.catch(() => { threw = true; });
		check('settles rather than rejects: ' + JSON.stringify(t), !threw);
	}

	group('an unanswered probe does not cost the page its editor');

	// `ready` is awaited before the editor mounts. A request that hangs neither
	// resolves nor rejects, so without a deadline the raw page would sit on its
	// loading line for good -- an optional tab holding up the main function.
	({ api } = load({ hang: true }));
	const raced = await Promise.race([
		api.ready,
		new Promise((r) => setTimeout(() => r('STILL-PENDING'), 6000)),
	]);
	check('it gives up and lets the editor mount without the tab', raced === false,
		String(raced));

	group('every poll is held to the shape, not just the probe');

	// The probe says this camera HAS a grid. It says nothing about the one
	// arriving two minutes later.
	({ api } = load({ gridSeq: [GRID, { rows: 2, cols: 3, zones: [] }] }));
	check('the probe still passes', (await api.ready) === true);
	let late = '';
	await api.zones().catch((e) => { late = e.message; });
	check('and a later malformed grid is refused rather than forwarded',
		/shape and contents disagree/.test(late), late || '(resolved)');

	group('the camera\'s own words never reach the operator raw');

	({ api } = load({ status: 503 }));
	let msg = '';
	await api.zones().catch((e) => { msg = e.message; });
	check('503 names both of the things it can mean',
		/no AF block/i.test(msg) && /pipeline is not running/i.test(msg), msg);
	({ api } = load({ status: 404 }));
	let msg404 = '';
	await api.zones().catch((e) => { msg404 = e.message; });
	check('and 404 says something different', msg404 !== msg && !!msg404, msg404);

	done();
})();
