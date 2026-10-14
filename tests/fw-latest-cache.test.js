// How often the notice on every page makes the camera ask OpenIPC for a build.
//
// j/fw-latest.cgi answers the update notice, which every page fetches. The
// question behind it is a sysupgrade that takes three seconds with internet and
// its full 15 without, so the cache and the lock in front of it decide how many
// of those a camera runs. Getting that wrong is invisible: the notice says
// nothing either way, and the cost is a sysupgrade per page view, in the
// background, on a camera nobody is watching. An offline camera ran one for
// every page opened, and one reporting no revision of its own ran one with the
// internet up (#683).
//
// So the real script runs against a stub sysupgrade that counts how often it is
// asked, with its cache aged by hand.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { check, group, done } = require('./assert');

const CGI = path.join(__dirname, '..', 'www', 'cgi-bin', 'j', 'fw-latest.cgi');
const FW_SH = path.join(__dirname, '..', 'www', 'cgi-bin', 'p', 'firmware.sh');
const src = fs.readFileSync(CGI, 'utf8');

const SUBS = ['CACHE=/tmp/fw-latest.json', 'inst_ver=$(fw_installed_version)'];
for (const k of SUBS) {
	if (src.indexOf(k) < 0) throw new Error(k + ' is gone from j/fw-latest.cgi; this test is testing nothing');
}

const MINE = 'GITHUB_VERSION="master+aaaa111, 2026-10-01"\n';
const NO_REV = 'GITHUB_VERSION="local+build, 2026-10-01"\n';

// One camera: a directory laid out as the CGI expects to find p/firmware.sh,
// and a stub sysupgrade that records each ask. `builds` empty is the check that
// came back with nothing, which is what a camera with no internet gets.
function camera(osRelease) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-latest-cache-'));
	const bin = path.join(dir, 'bin');
	fs.mkdirSync(bin);
	fs.mkdirSync(path.join(dir, 'j'));
	fs.mkdirSync(path.join(dir, 'p'));
	fs.copyFileSync(FW_SH, path.join(dir, 'p', 'firmware.sh'));
	const cache = path.join(dir, 'fw-latest.json');
	const osr = path.join(dir, 'os-release');
	fs.writeFileSync(osr, osRelease);
	const script = path.join(dir, 'j', 'fw-latest.cgi');
	fs.writeFileSync(script, src
		.replace(SUBS[0], 'CACHE=' + cache)
		.replace(SUBS[1], 'inst_ver=$(fw_installed_version ' + osr + ')'), { mode: 0o755 });
	fs.writeFileSync(path.join(bin, 'ip'), '#!/bin/sh\necho "default via 192.0.2.1 dev eth0"\n', { mode: 0o755 });
	const asks = path.join(dir, 'asks');
	const list = path.join(dir, 'builds');
	fs.writeFileSync(path.join(bin, 'sysupgrade'),
		'#!/bin/sh\necho x >> "' + asks + '"\n[ -f "' + list + '" ] && cat "' + list + '"\nexit 0\n', { mode: 0o755 });
	const cam = {
		cache: cache, busy: cache + '.busy',
		builds(b) { fs.writeFileSync(list, b.map((x) => '    ' + x + '\n').join('')); },
		get asks() { return fs.existsSync(asks) ? fs.readFileSync(asks, 'utf8').split('\n').filter(Boolean).length : 0; },
		get() {
			const out = execFileSync('sh', [script], {
				env: Object.assign({}, process.env, { PATH: bin + ':' + process.env.PATH }), encoding: 'utf8' });
			return JSON.parse(out.slice(out.indexOf('\n\n') + 2));
		},
		age(file, secs) { const t = Date.now() / 1000 - secs; fs.utimesSync(file, t, t); },
	};
	cam.builds([]);
	return cam;
}

group('a check that came back with nothing');
{
	const c = camera(MINE);
	const a = c.get();
	check('cannot tell', a.newer === null && a.latest === '', JSON.stringify(a));
	c.get(); c.get();
	check('two more pages ask nothing', c.asks === 1, c.asks);
	c.age(c.cache, 299);
	c.get();
	check('still remembered just under five minutes on', c.asks === 1, c.asks);
	c.age(c.cache, 301);
	c.builds(['nightly-20261002-bbbb222']);
	const b = c.get();
	check('asked again after five, and the network coming back is noticed', c.asks === 2 && b.newer === true,
		c.asks + ' ' + JSON.stringify(b));
}

group('a camera that reports no revision of its own');
{
	const c = camera(NO_REV);
	c.builds(['nightly-20261002-bbbb222']);
	const a = c.get();
	check('cannot tell, with the build read', a.newer === null && a.latestSha === 'bbbb222', JSON.stringify(a));
	c.get();
	check('the next page asks nothing', c.asks === 1, c.asks);
	c.age(c.cache, 301);
	c.get();
	check('remembered no longer than an empty check', c.asks === 2, c.asks);
}

group('settled answers keep the times they had');
{
	const c = camera(MINE);
	c.builds(['nightly-20261001-aaaa111']);
	check('current: no', c.get().newer === false);
	c.age(c.cache, 3 * 3600);
	c.get();
	check('a no is held for hours', c.asks === 1, c.asks);
	c.age(c.cache, 6 * 3600 + 1);
	c.get();
	check('and asked again after six', c.asks === 2, c.asks);
}
{
	const c = camera(MINE);
	c.builds(['nightly-20261002-bbbb222']);
	check('newer: yes', c.get().newer === true);
	c.age(c.cache, 901);
	c.get();
	check('a yes is asked again after fifteen minutes', c.asks === 2, c.asks);
}

group('one check at a time');
{
	const c = camera(MINE);
	c.builds(['nightly-20261002-bbbb222']);
	fs.mkdirSync(c.busy);
	const a = c.get();
	check('a page arriving mid-check starts no second one', c.asks === 0, c.asks);
	check('and is told only that it cannot tell', a.newer === null, JSON.stringify(a));
	check('which is not remembered', !fs.existsSync(c.cache));
	fs.rmdirSync(c.busy);
	c.get();
	check('the check itself releases the lock', c.asks === 1 && !fs.existsSync(c.busy));
}
{
	const c = camera(MINE);
	c.builds(['nightly-20261002-bbbb222']);
	fs.mkdirSync(c.busy);
	c.age(c.busy, 120);
	const a = c.get();
	check('a lock left by a killed check is taken over', c.asks === 1 && a.newer === true, JSON.stringify(a));
	check('and released', !fs.existsSync(c.busy));
}

done();
