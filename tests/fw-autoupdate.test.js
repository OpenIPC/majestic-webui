// The scheduled firmware install, and the one decision it must get right.
//
// sysupgrade stops majestic and reboots the camera whatever it then finds, so
// the job must call it only on a definite "there is a newer build" -- and get
// nothing else wrong when it does: not unattended self-update, not a wipe, not
// a different build from the one it compared. A wrong answer here fails
// silently, at night, on a camera nobody is watching: either it reboots every
// night for nothing, or it never updates and says nothing. Neither can be
// reproduced on demand, so the real shipped script is run against a stub
// sysupgrade that records how it was called.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { check, group, done } = require('./assert');

const JOB = path.join(__dirname, '..', 'sbin', 'fw-autoupdate');
const FW_SH = path.join(__dirname, '..', 'www', 'cgi-bin', 'p', 'firmware.sh');
const src = fs.readFileSync(JOB, 'utf8');

const SUBS = [
	'FW_SH=/var/www/cgi-bin/p/firmware.sh',
	'OS_RELEASE=/etc/os-release',
	'LAST=/etc/webui/fw-autoupdate.last',
	'LOG=/tmp/fw-autoupdate.log',
	'SYSUPGRADE_LOCK=/tmp/sysupgrade.lock',
	'MJ_OWNER=/tmp/majestic-upgrade-owner',
	'SELF_LOCK=/tmp/fw-autoupdate.lock',
];
for (const k of SUBS) {
	if (src.indexOf(k) < 0) throw new Error(k + ' is gone from sbin/fw-autoupdate; this test is testing nothing');
}

const LIST = (builds, here) => '#!/bin/sh\n' +
	'case "$*" in\n' +
	'*--list-builds*)\n' +
	'\t[ -n "$MJ_RACE" ] && : > "$MJ_RACE"\n' +
	'\techo "Available builds for hi3516av300_lite (newest first):"\n' +
	builds.map((b) => `\techo "  ${b === here ? '*' : ' '} ${b}"\n`).join('') +
	'\texit 0 ;;\n' +
	'esac\n' +
	'echo "$*" >> "$MJ_CALLS"\n' +
	'exit "${MJ_RC:-0}"\n';

function run(opts) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-autoupdate-'));
	const bin = path.join(dir, 'bin');
	fs.mkdirSync(bin);
	const calls = path.join(dir, 'calls');
	const last = path.join(dir, 'etc', 'fw-autoupdate.last');

	fs.writeFileSync(path.join(bin, 'sysupgrade'), LIST(opts.builds || [], opts.here), { mode: 0o755 });
	fs.writeFileSync(path.join(bin, 'ip'),
		'#!/bin/sh\n' + (opts.noRoute ? '' : 'echo "default via 192.0.2.1 dev eth0"\n'), { mode: 0o755 });
	fs.writeFileSync(path.join(bin, 'logger'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
	fs.writeFileSync(path.join(bin, 'sync'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

	const osr = path.join(dir, 'os-release');
	fs.writeFileSync(osr, opts.osRelease !== undefined ? opts.osRelease
		: 'OPENIPC_VERSION=2.6.10.01\nGITHUB_VERSION="master+aaaa111, 2026-10-01"\n');

	const lock = path.join(dir, 'sysupgrade.lock');
	const owner = path.join(dir, 'majestic-upgrade-owner');
	const self = path.join(dir, 'fw-autoupdate.lock');
	if (opts.lock) fs.writeFileSync(lock, '');
	if (opts.owner) fs.writeFileSync(owner, '');
	if (opts.self) fs.mkdirSync(self);
	if (opts.readOnlyRecord) {
		fs.mkdirSync(path.dirname(last));
		fs.chmodSync(path.dirname(last), 0o555);
	}

	let s = src;
	const to = {
		FW_SH: FW_SH, OS_RELEASE: osr, LAST: last, LOG: path.join(dir, 'log'),
		SYSUPGRADE_LOCK: lock, MJ_OWNER: owner, SELF_LOCK: self,
	};
	for (const k of SUBS) {
		const name = k.split('=')[0];
		s = s.replace(k, name + '=' + to[name]);
	}
	const script = path.join(dir, 'fw-autoupdate');
	fs.writeFileSync(script, s, { mode: 0o755 });

	const env = Object.assign({}, process.env, {
		PATH: bin + ':' + process.env.PATH,
		MJ_CALLS: calls,
		MJ_RC: String(opts.rc || 0),
		MJ_RACE: opts.race ? owner : '',
	});
	let status = 0;
	try {
		execFileSync('sh', [script], { env, stdio: 'pipe' });
	} catch (e) {
		status = e.status;
	}
	const flashed = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [];
	const rec = fs.existsSync(last) ? fs.readFileSync(last, 'utf8') : '';
	const field = (k) => (rec.match(new RegExp('^' + k + '="(.*)"$', 'm')) || [])[1];
	return { status, flashed, result: field('au_result'), target: field('au_target'), from: field('au_from'),
		selfLockLeft: fs.existsSync(self) && !opts.self };
}

group('nothing newer: sysupgrade is never asked to flash');
{
	const r = run({ builds: ['nightly-20261001-aaaa111', 'nightly-20260930-cccc333'], here: 'nightly-20261001-aaaa111' });
	check('no flash call', r.flashed.length === 0);
	check('recorded as current', r.result === 'current');
	check('exits 0', r.status === 0);
}
{
	// The two revisions are abbreviated independently.
	const r = run({ builds: ['nightly-20261001-aaaa111bbb'],
		osRelease: 'GITHUB_VERSION="master+aaaa111, 2026-10-01"\n' });
	check('a longer spelling of the same revision is not newer', r.flashed.length === 0 && r.result === 'current');
}

group('cannot tell: not a yes');
{
	const r = run({ builds: ['nightly-20261002-bbbb222'], noRoute: true });
	check('no route: no flash call', r.flashed.length === 0);
	check('no route: recorded as nocheck', r.result === 'nocheck');
}
{
	const r = run({ builds: [] });
	check('empty build list: no flash call', r.flashed.length === 0 && r.result === 'nocheck');
}
{
	const r = run({ builds: ['nightly-20261002-bbbb222'], osRelease: 'OPENIPC_VERSION=2.6.10.01\n' });
	check('a camera with no revision of its own: no flash call', r.flashed.length === 0 && r.result === 'nocheck');
}

group('another upgrade is running: left alone');
for (const which of ['lock', 'owner']) {
	const r = run({ builds: ['nightly-20261002-bbbb222'], [which]: true });
	check(which + ': no flash call', r.flashed.length === 0);
	check(which + ': recorded as busy', r.result === 'busy');
}

group('newer: flashed, and flashed the cautious way');
{
	const r = run({ builds: ['nightly-20261002-bbbb222', 'nightly-20261001-aaaa111'], here: 'nightly-20261001-aaaa111', rc: 1 });
	check('exactly one flash call', r.flashed.length === 1);
	const a = (r.flashed[0] || '').split(' ');
	check('kernel and rootfs', a.includes('-k') && a.includes('-r'));
	check('no self-update', a.includes('-z'));
	check('pinned to the build it compared', a.includes('--build=nightly-20261002-bbbb222'));
	check('never wipes', !a.includes('-n') && !a.some((x) => x.startsWith('--wipe')));
	check('never forces', !a.includes('-f') && !a.some((x) => x.startsWith('--force')));
	// The stub returned, which a real flash never does: the record must say it
	// stopped, not that it started.
	check('a sysupgrade that returns is recorded as failed', r.result === 'failed');
	check('with the target', r.target === 'nightly-20261002-bbbb222');
	check('and the build it started from', r.from === 'aaaa111');
	check('and a non-zero exit', r.status !== 0);
}

group('different is not newer: never flashed backwards');
{
	// A camera on a build later than anything published -- a branch build, a
	// local one -- must not be "updated" to the last nightly.
	const r = run({ builds: ['nightly-20261002-bbbb222'],
		osRelease: 'GITHUB_VERSION="feature+dddd444, 2026-10-05"\n' });
	check('a camera ahead of the newest build: no flash call', r.flashed.length === 0);
	check('and it is not called current either', r.result === 'nocheck');
}
{
	const r = run({ builds: ['nightly-20261001-bbbb222'] });
	check('a different build of the same day: no flash call', r.flashed.length === 0 && r.result === 'nocheck');
}
{
	const r = run({ builds: ['nightly-20261002-bbbb222'], osRelease: 'GITHUB_VERSION="master+aaaa111"\n' });
	check('an installed build with no date: no flash call', r.flashed.length === 0 && r.result === 'nocheck');
}

group('an upgrade that starts while this one is checking');
{
	const r = run({ builds: ['nightly-20261002-bbbb222'], race: true });
	check('no flash call', r.flashed.length === 0);
	check('recorded as busy', r.result === 'busy');
}

group('a second copy of the job');
{
	const r = run({ builds: ['nightly-20261002-bbbb222'], self: true });
	check('does nothing', r.flashed.length === 0 && r.result === undefined && r.status === 0);
}
{
	const r = run({ builds: ['nightly-20261001-aaaa111'] });
	check('a run releases its lock on the way out', !r.selfLockLeft);
}

group('no record, no flash');
if (process.getuid && process.getuid() === 0) {
	// root writes through a read-only mode, so the case cannot be staged.
	check('skipped: running as root', true);
} else {
	const r = run({ builds: ['nightly-20261002-bbbb222'], readOnlyRecord: true });
	check('a record that cannot be written stops the flash', r.flashed.length === 0);
	check('and fails', r.status !== 0);
}

done();
