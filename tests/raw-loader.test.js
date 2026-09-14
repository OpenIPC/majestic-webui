// What the raw page is allowed to conclude about a camera, and what it must
// not.
//
// Four states hide behind one config key and three of them look alike from a
// distance: a build with no raw support, a build with it switched off, and a
// request that never arrived. Collapsing the last into the first tells an
// operator their camera cannot do something it can, over one bad request on a
// slow link — which is the failure this file exists to prevent, and the one an
// earlier version of the loader had, because mjConfig() answers {} for a failed
// fetch and an absent key reads exactly the same way.
//
// The load latch is the other half. A camera with no route out pays a timeout
// for every attempt unless the first failure is remembered — and an operator
// pressing "try again" has to be able to clear it, or the button is a lie.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const SRC = fs.readFileSync(
	path.join(__dirname, '..', 'www', 'a', 'raw-loader.js'), 'utf8');

// A sandbox with just enough of a browser for the loader to decide things in.
// `fetch` is what the support check really turns on, so it is modelled exactly:
// a rejection, a non-ok status and a body that will not parse are all different
// from a body that parsed and had no key in it.
function load(opts) {
	opts = opts || {};
	const sandbox = {
		Worker: opts.noWorker ? undefined : function () {},
		WebAssembly: opts.noWasm ? undefined : {},
		Promise: Promise, Object: Object, Error: Error,
		setTimeout: setTimeout, clearTimeout: clearTimeout,
		apiFetch: function () {
			if (opts.fetchRejects) return Promise.reject(new Error('offline'));
			return Promise.resolve({
				ok: opts.status === undefined ? true : opts.status < 400,
				status: opts.status || 200,
				json: () => (opts.badJson
					? Promise.reject(new Error('not json'))
					: Promise.resolve(opts.cfg === undefined ? {} : opts.cfg)),
			});
		},
		mjGet: (cfg, dot) => dot.split('.').reduce(
			(o, k) => (o == null ? undefined : o[k]), cfg),
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
	group('a request that did not arrive is not a camera without raw');

	let r = await load({ fetchRejects: true }).support();
	check('a failed request answers unknown, never absent', r.state === 'unknown', r.state);
	r = await load({ status: 500 }).support();
	check('and so does a camera that answered 500', r.state === 'unknown', r.state);
	r = await load({ badJson: true }).support();
	check('and a body that will not parse', r.state === 'unknown', r.state);

	group('what the camera is allowed to say about itself');

	r = await load({ cfg: {} }).support();
	check('a build with no such setting is absent, not unknown',
		r.state === 'absent' && r.mode === null, JSON.stringify(r));
	r = await load({ cfg: { isp: { rawMode: 'none' } } }).support();
	check('switched off is not the same as absent',
		r.state === 'off' && r.mode === 'none', JSON.stringify(r));
	r = await load({ cfg: { isp: { rawMode: 'slow' } } }).support();
	check('on demand serves raw', r.state === 'on' && r.mode === 'slow', JSON.stringify(r));
	r = await load({ cfg: { isp: { rawMode: 'fast' } } }).support();
	check('always ready serves raw too', r.state === 'on', JSON.stringify(r));

	group('a browser that cannot run it is not asked to fetch it');

	let m = load({ noWorker: true });
	check('no Worker means not available', m.available === false);
	let err = '';
	try { await m.load(); } catch (e) { err = e.message; }
	check('and load refuses without a round trip', err === 'unsupported-browser', err);
	check('no WebAssembly means not available', load({ noWasm: true }).available === false);

	group('a camera with no route out pays the timeout once, and can try again');

	m = load({ importFails: true });
	err = '';
	try { await m.load(); } catch (e) { err = e.message; }
	check('the first attempt reports why it failed', err === 'boom', err);
	err = '';
	try { await m.load(); } catch (e) { err = e.message; }
	check('the second is refused from memory, not retried', err === 'unavailable', err);
	m.retry();
	err = '';
	try { await m.load(); } catch (e) { err = e.message; }
	check('until someone asks, and then it really tries again', err === 'boom', err);

	group('the pin');

	m = load({});
	check('points at a version, never at a moving tag',
		/@v\d+\.\d+\.\d+\//.test(m.BASE), m.BASE);
	check('and at bytes this project publishes',
		m.BASE.indexOf('/gh/OpenIPC/') !== -1, m.BASE);

	done();
})();
