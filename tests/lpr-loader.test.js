// Where the plate reader comes from (www/a/lpr-loader.js).
//
// A camera that was told nothing uses the pinned tag, the same as the raw
// editor next door. The interesting half is what a camera that WAS told
// something does: `webui_lpr_base` is set by an operator whose camera must not
// reach a public CDN, so a base this file refuses must leave no reader at all
// rather than falling back to the default. That failure would be silent and in
// the expensive direction — the tab would simply work, off the public CDN the
// mirror existed to avoid.
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
		// raw.cgi writes the base into a <meta>; opts.meta puts one there.
		document: opts.meta === undefined ? undefined : {
			querySelector: (sel) => (sel === 'meta[name="mj-lpr-base"]'
				? { content: opts.meta } : null),
		},
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
	group('a camera that was told nothing uses the pinned tag');

	let { m, state } = load({});                 // no MJ_LPR_BASE, no meta
	check('the default is the pinned tag', m.BASE === CDN, String(m.BASE));
	check('and a reader is on offer', m.available === true);
	let err = '';
	await m.open();
	check('which fetches the module once', state.imports === 1);

	group('a configured camera uses exactly what it was given');

	({ m, state } = load({ base: CDN }));
	check('the base is the one configured', m.BASE === CDN, m.BASE);
	check('and a reader is on offer', m.available === true);
	await m.open();
	check('which fetches the module once', state.imports === 1);

	// A mirror of one's own is the whole reason this is a string and not a
	// constant. The literal is a documentation host, not an address: a fixture
	// carrying somebody's real network is a fixture that leaks it.
	({ m } = load({ base: 'https://lpr.example/dist/' }));
	check('any base will do — a mirror, a host of one\'s own',
		m.BASE === 'https://lpr.example/dist/', m.BASE);

	group('the base is read from the document, where the escaping is right');

	// raw.cgi has only an HTML-attribute escaper, so the value travels in an
	// attribute and the DOM parser hands it back. A query string has to survive
	// that trip intact — in a JS string literal the same escaper turns & into
	// &amp; and the mirror silently becomes a different URL.
	({ m } = load({ meta: 'https://mirror.example/lpr/?v=1&x=2' }));
	check('a meta base is used when no override is set, ampersand intact',
		m.BASE === 'https://mirror.example/lpr/?v=1&x=2', m.BASE);

	({ m } = load({ base: 'https://override.example/', meta: 'https://meta.example/' }));
	check('an explicit override still wins, for a development build',
		m.BASE === 'https://override.example/', m.BASE);

	// A missing trailing slash is the likeliest way to mistype this, and
	// 'dist' + 'lpr.js' resolves somewhere else entirely.
	({ m } = load({ meta: 'https://mirror.example/lpr' }));
	check('a base without a trailing slash is completed rather than broken',
		m.BASE === 'https://mirror.example/lpr/', m.BASE);

	// The file is root-owned, so this is a typo guard rather than a hostile
	// input — but a base that is not http(s) would import from somewhere the
	// operator did not mean. It leaves no reader rather than falling back to
	// the pinned default: the mirror was named to keep this camera off a public
	// CDN, and a typo must not undo that quietly.
	for (const bad of ['javascript:alert(1)', 'data:text/javascript,0', 'file:///etc/', '/relative/']) {
		({ m } = load({ meta: bad }));
		check('a base that is not http(s) is no base at all: ' + bad.slice(0, 18),
			m.BASE === null && m.available === false, String(m.BASE));
		err = '';
		await m.load().catch((e) => { err = e.message; });
		check('and it says so rather than reporting a load failure',
			err === 'bad-base', err);
	}
	// raw.cgi writes no <meta> for an empty setting, so empty is unset, and
	// unset is the default.
	({ m } = load({ meta: '' }));
	check('an empty meta is simply unset', m.BASE === CDN && m.available === true,
		String(m.BASE));

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
