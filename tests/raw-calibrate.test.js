// Writing a colour calibration to the camera, and taking it back
// (www/a/raw-calibrate.js).
//
// Two things can be written: one matrix onto the live picture, or a whole
// calibration into the camera's image profile. Both survive a reboot and both
// can ruin the picture you would use to notice, so what matters is the way
// back -- and that revert() and keep() answer for whichever was written last.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const SRC = fs.readFileSync(
	path.join(__dirname, '..', 'www', 'a', 'raw-calibrate.js'), 'utf8');

// `oldFirmware` is a daemon from before profile writes: its handler for this
// route answers every method with the profile, 200 -- which must not be taken
// for a save.
function makeCamera(opts) {
	opts = opts || {};
	const cam = {
		config: { isp: Object.assign({}, opts.isp) },
		configPosts: [], profilePosts: [], beacons: [],
		profile: '[static_awb]\nAutoStaticWb = "483, 256, 256, 465"\n',
	};
	cam.apiFetch = function (url, init) {
		init = init || {};
		if (url === '/api/v1/config.json')
			return Promise.resolve({
				ok: true, status: 200,
				json: () => Promise.resolve(JSON.parse(JSON.stringify(cam.config))),
			});
		if (url === '/api/v1/config') {
			const body = JSON.parse(init.body);
			cam.configPosts.push(body);
			Object.keys(body.isp).forEach(function (k) {
				if (body.isp[k] === null) delete cam.config.isp[k];
				else cam.config.isp[k] = body.isp[k];
			});
			return Promise.resolve({ ok: true, status: 200 });
		}
		if (url.indexOf('/api/v1/isp/profile.ini') === 0) {
			const text = (t, status) => Promise.resolve({
				ok: (status || 200) < 300, status: status || 200, text: () => Promise.resolve(t),
			});
			if (init.method !== 'POST' || opts.oldFirmware) return text(cam.profile);
			cam.profilePosts.push({ url: url, body: init.body });
			if (/restore=1/.test(url)) return text('put back\n');
			if (/keep=1/.test(url)) return text('kept\n');
			if (opts.refuse) return text('[static_ccm] would be refused (present but unreadable)\n', 400);
			return text('[static_awb] written to /etc/sensors/iq/imx335.ini and applied\n');
		}
		throw new Error('unexpected url ' + url);
	};
	return cam;
}

function load(cam) {
	const handlers = {};
	const sandbox = {
		apiFetch: cam.apiFetch,
		fetch: function (url, init) { cam.beacons.push({ url: url, body: init && init.body }); return Promise.resolve({ ok: true }); },
		setTimeout: setTimeout, clearTimeout: clearTimeout,
		Promise: Promise, Object: Object, Error: Error, JSON: JSON, Array: Array,
		addEventListener: function (n, fn) { (handlers[n] = handlers[n] || []).push(fn); },
	};
	sandbox.window = sandbox;
	vm.runInContext(SRC, vm.createContext(sandbox), { filename: 'raw-calibrate.js' });
	return { api: sandbox.MajesticCalibrate, handlers: handlers };
}

const INI = '[static_awb]\nAutoStaticWb = "470, 256, 256, 455"\n';
const SOLVED = { ccm: [1, 0, 0, 0, 1, 0, 0, 0, 1], colorMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1], neutral: [0.5, 1, 0.5] };

(async () => {
	group('the camera\'s own profile is the baseline');

	let cam = makeCamera();
	let { api } = load(cam);
	check('baseline() answers the profile text', (await api.baseline()) === cam.profile);

	group('saving a calibration writes it into the profile, and putting it back asks the camera to');

	cam = makeCamera();
	({ api } = load(cam));
	await api.persist(INI);
	check('the calibration goes to the camera as it was built',
		cam.profilePosts.length === 1 && cam.profilePosts[0].body === INI);
	check('nothing in the configuration was touched, because nothing needed to be',
		cam.configPosts.length === 0);
	await api.revert();
	check('putting it back asks the camera for its previous profile',
		cam.profilePosts.length === 2 && /restore=1/.test(cam.profilePosts[1].url));

	group('a manual colour matrix is cleared, or the saved calibration would never be seen');

	cam = makeCamera({ isp: { colorMatrix: '1 0 0 0 1 0 0 0 1', dngColorMatrix: 'x' } });
	({ api } = load(cam));
	await api.persist(INI);
	check('isp.colorMatrix is removed after the save',
		!('colorMatrix' in cam.config.isp) && cam.config.isp.dngColorMatrix === 'x');
	await api.revert();
	check('and put back with the profile', cam.config.isp.colorMatrix === '1 0 0 0 1 0 0 0 1');

	group('confirming tells the camera, and stands the way back down');

	cam = makeCamera();
	let L = load(cam); api = L.api;
	await api.persist(INI);
	await api.keep();
	check('keep() confirms on the camera', /keep=1/.test(cam.profilePosts[1].url));
	(L.handlers.pagehide || []).forEach((fn) => fn());
	check('and leaving the page afterwards puts nothing back', cam.beacons.length === 0);

	group('leaving mid-countdown puts the profile back, as best it can');

	cam = makeCamera({ isp: { colorMatrix: 'm', dngColorMatrix: 'd' } });
	L = load(cam); api = L.api;
	await api.persist(INI);
	(L.handlers.pagehide || []).forEach((fn) => fn());
	check('a restore is sent as the page goes',
		cam.beacons.some((b) => /isp\/profile\.ini\?restore=1/.test(b.url)));
	check('and the cleared manual matrix with it',
		cam.beacons.some((b) => b.url === '/api/v1/config' && JSON.parse(b.body).isp.colorMatrix === 'm'));

	group('firmware that cannot save is told apart from firmware that did');

	cam = makeCamera({ oldFirmware: true });
	({ api } = load(cam));
	let err = '';
	try { await api.persist(INI); } catch (e) { err = e.message; }
	check('a 200 carrying the profile back is not a save', /cannot save/.test(err), err);

	cam = makeCamera({ refuse: true });
	({ api } = load(cam));
	err = '';
	try { await api.persist(INI); } catch (e) { err = e.message; }
	check('and a refusal says what the camera said', /would be refused/.test(err), err);

	group('the live matrix still works, and still reverts on its own');

	cam = makeCamera({ isp: {} });
	({ api } = load(cam));
	await api.apply(SOLVED);
	check('apply() writes both keys', 'colorMatrix' in cam.config.isp && 'dngColorMatrix' in cam.config.isp);
	await api.revert();
	check('revert() removes what was not there before',
		!('colorMatrix' in cam.config.isp) && cam.profilePosts.length === 0);

	done();
})();
