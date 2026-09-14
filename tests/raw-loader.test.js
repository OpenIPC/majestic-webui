// What the raw page is allowed to conclude about a camera, and what it must
// not.
//
// Three answers hide behind one config key, and two of them look alike from a
// distance: a build with no raw support at all, and a build that has it switched
// off. Collapsing those into "no" would tell an operator their camera cannot do
// something it can, and reading a config that never arrived as either would put
// that message on a camera that is perfectly fine.
//
// The load latch is here for the other half. A camera with no route out pays a
// timeout for every attempt unless the first failure is remembered, and that is
// the common case rather than the exception — most cameras on a closed network
// never reach a CDN.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const SRC = fs.readFileSync(
	path.join(__dirname, '..', 'www', 'a', 'raw-loader.js'), 'utf8');

// A sandbox with just enough of a browser for the loader to decide things in.
function load(opts) {
	opts = opts || {};
	const sandbox = {
		Worker: opts.noWorker ? undefined : function () {},
		WebAssembly: opts.noWasm ? undefined : {},
		Promise: Promise,
		Object: Object,
		setTimeout: setTimeout,
		clearTimeout: clearTimeout,
		mjConfig: () => Promise.resolve(opts.cfg === undefined ? {} : opts.cfg),
		mjGet: (cfg, dot) => dot.split('.').reduce(
			(o, k) => (o == null ? undefined : o[k]), cfg),
	};
	sandbox.window = sandbox;
	// import() cannot be intercepted inside vm, so the loader is given a stub
	// in its place. What is under test is when it is called and what happens
	// when it fails, not the module it would return.
	const src = SRC.replace(/import\(BASE \+ 'editor\.js'\)/,
		'(imports++, opts.importFails ? Promise.reject(new Error("boom")) : Promise.resolve({ mountEditor: function () { return "mounted"; } }))');
	const ctx = vm.createContext(sandbox);
	vm.runInContext(
		'(function (opts) { let imports = 0;\n' +
		src + '\n})', ctx, { filename: 'raw-loader.js' })(opts);
	return sandbox;
}

group('what the camera is allowed to say about itself');

(async () => {
	let s = load({ cfg: {} }).MajesticRaw;
	let r = await s.support();
	check('a build with no such setting serves no raw',
		r.serves === false && r.mode === null, JSON.stringify(r));

	s = load({ cfg: { isp: { rawMode: 'none' } } }).MajesticRaw;
	r = await s.support();
	check('switched off is not the same as absent',
		r.serves === false && r.mode === 'none', JSON.stringify(r));

	s = load({ cfg: { isp: { rawMode: 'slow' } } }).MajesticRaw;
	r = await s.support();
	check('on demand serves raw', r.serves === true && r.mode === 'slow', JSON.stringify(r));

	s = load({ cfg: { isp: { rawMode: 'fast' } } }).MajesticRaw;
	r = await s.support();
	check('always ready serves raw too', r.serves === true, JSON.stringify(r));

	group('a browser that cannot run it is not asked to fetch it');

	s = load({ noWorker: true }).MajesticRaw;
	check('no Worker means not available', s.available === false);
	let err = '';
	try { await s.load(); } catch (e) { err = e.message; }
	check('and load refuses without a round trip', err === 'unsupported-browser', err);

	s = load({ noWasm: true }).MajesticRaw;
	check('no WebAssembly means not available', s.available === false);

	group('a camera with no route out pays the timeout once');

	s = load({ importFails: true }).MajesticRaw;
	check('available when the browser can run it', s.available === true);
	err = '';
	try { await s.load(); } catch (e) { err = e.message; }
	check('the first attempt reports why it failed', err === 'boom', err);
	err = '';
	try { await s.load(); } catch (e) { err = e.message; }
	check('the second is refused from memory, not retried', err === 'unavailable', err);

	group('the pin');

	s = load({}).MajesticRaw;
	check('points at a version, never at a moving tag',
		/@v\d+\.\d+\.\d+\//.test(s.BASE), s.BASE);
	check('and at bytes this project publishes',
		s.BASE.indexOf('/gh/OpenIPC/') !== -1, s.BASE);

	done();
})();
