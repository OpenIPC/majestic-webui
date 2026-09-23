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
		profile: '[section]\nkey = "1"\n',
	};
	cam.apiFetch = function (url, init) {
		init = init || {};
		if (url === '/api/v1/config.json') {
			if (opts.failReadAfterClear && cam.configPosts.length)
				return Promise.resolve({ ok: false, status: 500 });
			return Promise.resolve({
				ok: true, status: 200,
				json: () => Promise.resolve(JSON.parse(JSON.stringify(cam.config))),
			});
		}
		if (url === '/api/v1/config') {
			const body = JSON.parse(init.body);
			cam.configPosts.push(body);
			if (opts.rejectConfig || cam.configDown) return Promise.resolve({ ok: false, status: 500 });
			Object.keys(body.isp).forEach(function (k) {
				if (body.isp[k] === null) { if (!opts.ignoreNulls) delete cam.config.isp[k]; }
				else cam.config.isp[k] = body.isp[k];
			});
			return Promise.resolve({ ok: true, status: 200 });
		}
		if (url.indexOf('/api/v1/isp/profile.ini') === 0) {
			const text = (t, status, disp) => Promise.resolve({
				ok: (status || 200) < 300, status: status || 200, text: () => Promise.resolve(t),
				headers: { get: (h) => (/^content-disposition$/i.test(h) ? disp || null : null) },
			});
			// The GET handler, which older firmware also answers a POST with:
			// the profile as a download.
			if (init.method !== 'POST' || opts.oldFirmware)
				return text(cam.profile, 200, 'attachment; filename="profile.ini"');
			cam.profilePosts.push({ url: url, body: init.body });
			if (/restore=1/.test(url)) {
				if (opts.restoreDown) return Promise.reject(new TypeError('network error'));
				if (opts.nothingToRestore || (opts.restoreOnce && cam.restored))
					return text('nothing to put back: no earlier copy\n', 409);
				cam.restored = true;
				return text('put back\n');
			}
			if (/keep=1/.test(url)) return text('kept\n');
			if (opts.lostReply) return Promise.reject(new TypeError('network error'));
			if (opts.refuse) return text('[section] would be refused\n', 400);
			// A save the camera takes but whose answer has not come back yet.
			if (opts.hold) return new Promise(function (res) {
				cam.release = function () { res(text('[section] written to the profile and applied\n')); };
			});
			return text('[section] written to the profile and applied\n');
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

const INI = '[section]\nkey = "2"\n';
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

	group('a page closing mid-save still puts the profile back');

	cam = makeCamera({ hold: true });
	L = load(cam); api = L.api;
	const pending = api.persist(INI);
	for (let i = 0; i < 20 && !cam.release; i++) await new Promise((r) => setImmediate(r));
	check('the save is on the wire and unanswered', typeof cam.release === 'function');
	(L.handlers.pagehide || []).forEach((fn) => fn());
	cam.release();
	await pending;
	check('the unload handler knew a profile was being written',
		cam.beacons.some((b) => /restore=1/.test(b.url)));

	group('a save whose manual matrix cannot be cleared puts the profile back');

	cam = makeCamera({ isp: { colorMatrix: 'm', dngColorMatrix: 'd' }, rejectConfig: true });
	({ api } = load(cam));
	err = '';
	try { await api.persist(INI); } catch (e) { err = e.message; }
	check('the save is reported as failed', err !== '', err);
	check('and the profile is put back at once',
		cam.profilePosts.some((p) => /restore=1/.test(p.url)));

	group('old firmware echoing a profile that says "written to" is still not a save');

	cam = makeCamera({ oldFirmware: true });
	cam.profile = '; [x] written to this file by hand\n[section] written to nothing\n';
	({ api } = load(cam));
	err = '';
	try { await api.persist(INI); } catch (e) { err = e.message; }
	check('the download is recognised for what it is', /cannot save/.test(err), err);

	group('a save whose reply is lost asks for the profile back; a refused one does not');

	cam = makeCamera({ lostReply: true });
	({ api } = load(cam));
	try { await api.persist(INI); } catch (e) { /* expected */ }
	check('a lost reply is followed by a restore',
		cam.profilePosts.some((p) => /restore=1/.test(p.url)));
	cam = makeCamera({ refuse: true });
	({ api } = load(cam));
	try { await api.persist(INI); } catch (e) { /* expected */ }
	check('a refusal is not', !cam.profilePosts.some((p) => /restore=1/.test(p.url)));

	group('when putting it back fails too, the way back stays armed');

	cam = makeCamera({ lostReply: true, restoreDown: true });
	L = load(cam); api = L.api;
	err = '';
	try { await api.persist(INI); } catch (e) { err = e.message; }
	check('the caller is told it could not be put back', /could not be put back yet/.test(err), err);
	(L.handlers.pagehide || []).forEach((fn) => fn());
	check('and leaving the page still tries', cam.beacons.some((b) => /restore=1/.test(b.url)));

	cam = makeCamera({ lostReply: true, nothingToRestore: true });
	L = load(cam); api = L.api;
	err = '';
	try { await api.persist(INI); } catch (e) { err = e.message; }
	check('a lost save that the camera says never landed is settled',
		!/could not be put back/.test(err), err);
	(L.handlers.pagehide || []).forEach((fn) => fn());
	check('and leaves nothing armed', cam.beacons.length === 0);

	group('a put-back that fails half way can be tried again');

	cam = makeCamera({ isp: { colorMatrix: 'm', dngColorMatrix: 'd' }, restoreOnce: true });
	({ api } = load(cam));
	await api.persist(INI);
	cam.configDown = true;
	err = '';
	try { await api.revert(); } catch (e) { err = e.message; }
	check('the first put-back fails on the matrix', err !== '' && !('colorMatrix' in cam.config.isp), err);
	cam.configDown = false;
	err = '';
	try { await api.revert(); } catch (e) { err = e.message; }
	check('and the retry, told the profile is already back, restores the matrix',
		err === '' && cam.config.isp.colorMatrix === 'm', err || JSON.stringify(cam.config.isp));

	group('a save that fails after the matrix went puts the matrix back too');

	cam = makeCamera({ isp: { colorMatrix: 'm', dngColorMatrix: 'd' }, failReadAfterClear: true });
	({ api } = load(cam));
	err = '';
	try { await api.persist(INI); } catch (e) { err = e.message; }
	check('the save is reported as failed', err !== '', err);
	check('the profile is put back', cam.profilePosts.some((p) => /restore=1/.test(p.url)));
	check('and so is the manual matrix', cam.config.isp.colorMatrix === 'm', JSON.stringify(cam.config.isp));

	group('a camera that ignores the request to clear the matrix does not get a false save');

	cam = makeCamera({ isp: { colorMatrix: 'm', dngColorMatrix: 'd' }, ignoreNulls: true });
	({ api } = load(cam));
	err = '';
	try { await api.persist(INI); } catch (e) { err = e.message; }
	check('the save is reported as failed', /kept its manual colour matrix/.test(err), err);
	check('and the profile is put back', cam.profilePosts.some((p) => /restore=1/.test(p.url)));

	group('one change waits at a time');

	cam = makeCamera({ isp: { colorMatrix: 'old', dngColorMatrix: 'd' } });
	({ api } = load(cam));
	await api.apply(SOLVED);
	err = '';
	try { await api.persist(INI); } catch (e) { err = e.message; }
	check('a profile save is refused while an applied matrix is unconfirmed',
		/still waiting/.test(err) && cam.profilePosts.length === 0, err);
	await api.keep();
	await api.persist(INI);
	err = '';
	try { await api.apply(SOLVED); } catch (e) { err = e.message; }
	check('and a matrix apply while a saved profile is unconfirmed', /still waiting/.test(err), err);

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
