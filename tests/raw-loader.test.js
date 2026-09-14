// What the loader may do before the module has arrived, and what it must not.
//
// A camera with no route out pays a timeout for every attempt unless the first
// failure is remembered. The way to ask again is a fresh page: the banner's
// "Try again" is a link back to the page, which builds a loader that has never
// tried. A browser that cannot run the module must be told so without a round
// trip at all.
//
// The loader no longer guesses whether a camera serves raw from its config.
// It did, and got the interesting part right — an absent key and a failed
// request are not the same answer — but the question is better put to
// /image.dng, which says 404 for a build without raw, 501 for one with it
// switched off and 503 for one that cannot spare the memory just now. Nothing
// is claimed about the camera until someone asks it for a frame.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const SRC = fs.readFileSync(
	path.join(__dirname, '..', 'www', 'a', 'raw-loader.js'), 'utf8');

// A sandbox with just enough of a browser for the loader to decide things in.
// The loader makes no requests of its own any more, so there is no fetch here:
// what it decides turns on the capabilities it is given and on whether the
// module import resolves.
function load(opts) {
	opts = opts || {};
	const sandbox = {
		Worker: opts.noWorker ? undefined : function () {},
		WebAssembly: opts.noWasm ? undefined : {},
		Promise: Promise, Object: Object, Error: Error,
		setTimeout: setTimeout, clearTimeout: clearTimeout,
	};
	sandbox.window = sandbox;
	// import() cannot be intercepted inside vm, so the loader is handed a stub
	// in its place. What is under test is when it is called and what happens
	// when it fails, not the module it would return.
	const src = SRC.replace(/import\(BASE \+ 'editor\.js'\)/,
		'(opts.importFails ? Promise.reject(new Error("boom")) ' +
		': Promise.resolve({ mountEditor: () => "mounted" }))');
	const ctx = vm.createContext(sandbox);
	vm.runInContext('(function (opts) {\n' + src + '\n})', ctx,
		{ filename: 'raw-loader.js' })(opts);
	return sandbox.MajesticRaw;
}

(async () => {
	group('a browser that cannot run it is not asked to fetch it');

	let m = load({ noWorker: true });
	check('no Worker means not available', m.available === false);
	let err = '';
	try { await m.load(); } catch (e) { err = e.message; }
	check('and load refuses without a round trip', err === 'unsupported-browser', err);
	check('no WebAssembly means not available', load({ noWasm: true }).available === false);

	group('a camera with no route out pays the timeout once');

	m = load({ importFails: true });
	err = '';
	try { await m.load(); } catch (e) { err = e.message; }
	check('the first attempt reports why it failed', err === 'boom', err);
	err = '';
	try { await m.load(); } catch (e) { err = e.message; }
	check('the second is refused from memory, not retried', err === 'unavailable', err);
	// The way back is a fresh page, not a method: a reload builds a new loader
	// with no memory of the attempt that failed, which is what the banner's
	// "Try again" link does.
	err = '';
	try { await load({ importFails: true }).load(); } catch (e) { err = e.message; }
	check('a fresh loader really tries again', err === 'boom', err);

	group('the pin');

	m = load({});
	check('points at a version, never at a moving tag',
		/@v\d+\.\d+\.\d+\//.test(m.BASE), m.BASE);
	check('and at bytes this project publishes',
		m.BASE.indexOf('/gh/OpenIPC/') !== -1, m.BASE);

	done();
})();
