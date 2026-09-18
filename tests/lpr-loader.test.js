// Where the plate reader comes from, and that it comes from nowhere unless
// somebody said otherwise (www/a/lpr-loader.js).
//
// The opt-in is the whole point of this file and it fails SILENTLY in the
// expensive direction. The models are CC BY-NC 4.0 — attribution, and
// non-commercial use only — and majestic is a commercial product. A default
// base slipped in here would have every camera fetch them, which is a
// licensing decision made on behalf of everyone running one, and nothing about
// the page would look wrong afterwards: the tab would simply work.
//
// The rest is raw-loader.test.js's ground: a camera with no route out must pay
// the timeout once rather than once per press, and a browser that cannot run
// the model must be told without a round trip at all.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const SRC = fs.readFileSync(
	path.join(__dirname, '..', 'www', 'a', 'lpr-loader.js'), 'utf8');

function load(opts) {
	opts = opts || {};
	const state = { imports: 0, opens: 0 };
	const sandbox = {
		Worker: opts.noWorker ? undefined : function () {},
		WebAssembly: opts.noWasm ? undefined : {},
		Promise: Promise, Object: Object, Error: Error,
		setTimeout: setTimeout, clearTimeout: clearTimeout,
		MJ_LPR_BASE: opts.base,
	};
	sandbox.window = sandbox;
	// import() cannot be intercepted inside vm, so the loader is handed a stub
	// in its place. What is under test is whether and when it is called.
	const src = SRC.replace(/import\(BASE \+ 'lpr\.js'\)/,
		'(state.imports++, opts.importFails ? Promise.reject(new Error("boom")) ' +
		': Promise.resolve({ open: function () { state.opens++; ' +
		'return opts.openFails ? Promise.reject(new Error("model")) ' +
		': Promise.resolve({ detect: function () {}, read: function () {} }); } }))');
	const ctx = vm.createContext(sandbox);
	vm.runInContext('(function (opts, state) {\n' + src + '\n})', ctx,
		{ filename: 'lpr-loader.js' })(opts, state);
	return { m: sandbox.MajesticLpr, state: state };
}

const CDN = 'https://cdn.jsdelivr.net/gh/OpenIPC/lpr-wasm@v0.1.0/dist/';

(async () => {
	group('nothing is fetched until a camera has been configured for it');

	let { m, state } = load({});                 // no MJ_LPR_BASE
	check('no base means no reader', m.available === false);
	check('and no base is invented', m.BASE === null, String(m.BASE));
	let err = '';
	await m.load().catch((e) => { err = e.message; });
	check('load says it is not configured, not that it failed',
		err === 'not-configured', err);
	check('and nothing was fetched', state.imports === 0);
	err = '';
	await m.open().catch((e) => { err = e.message; });
	check('opening a session says the same', err === 'not-configured', err);
	check('still nothing fetched', state.imports === 0);

	group('a configured camera uses exactly what it was given');

	({ m, state } = load({ base: CDN }));
	check('the base is the one configured', m.BASE === CDN, m.BASE);
	check('and a reader is on offer', m.available === true);
	await m.open();
	check('which fetches the module once', state.imports === 1);

	// A private mirror is the whole reason this is a string and not a constant.
	({ m } = load({ base: 'http://192.168.1.5/lpr/' }));
	check('any base will do — a mirror, a private host',
		m.BASE === 'http://192.168.1.5/lpr/', m.BASE);

	group('a browser that cannot run it is not asked to fetch it');

	({ m, state } = load({ base: CDN, noWorker: true }));
	check('no Worker means no reader', m.available === false);
	err = '';
	await m.load().catch((e) => { err = e.message; });
	check('and it says which of the two is missing',
		err === 'unsupported-browser', err);
	check('without reaching for the network', state.imports === 0);

	({ m } = load({ base: CDN, noWasm: true }));
	check('no WebAssembly means no reader either', m.available === false);

	group('a camera with no route out pays the timeout once, not per press');

	({ m, state } = load({ base: CDN, importFails: true }));
	err = '';
	await m.load().catch((e) => { err = e.message; });
	check('the first attempt fails', err === 'boom', err);
	check('and it did try', state.imports === 1);
	err = '';
	await m.load().catch((e) => { err = e.message; });
	check('the second says unavailable', err === 'unavailable', err);
	check('without a second round trip', state.imports === 1, String(state.imports));

	group('the reader is built once and held');

	({ m, state } = load({ base: CDN }));
	const a = await m.open();
	const b = await m.open();
	check('opening twice returns the same session', a === b);
	check('and loads the module once', state.imports === 1, String(state.imports));
	check('and builds the session once', state.opens === 1, String(state.opens));

	group('a failed open is not remembered as a session');

	// Otherwise a model that failed to initialise once — out of memory on a tab
	// that had a 5 MP frame open — would be handed back for ever, and the page
	// would report a reader it does not have.
	({ m, state } = load({ base: CDN, openFails: true }));
	err = '';
	await m.open().catch((e) => { err = e.message; });
	check('the failure is reported', err === 'model', err);
	err = '';
	await m.open().catch((e) => { err = e.message; });
	check('and asking again tries again rather than replaying it',
		err === 'model' && state.opens === 2, err + ' opens=' + state.opens);

	done();
})();
