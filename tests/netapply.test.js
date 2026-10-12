// Applying a network change now, and taking it back unless it is confirmed.
//
// sbin/netapply runs as root on a camera, bounces the interface its owner's
// browser is probably on, and is the only thing standing between a mistyped
// address and a camera nobody can reach. Every way it goes wrong is silent: a
// change kept that should have been rolled back is a camera off the network,
// a rollback that did not restore the file comes back wrong at the next boot,
// and a confirmation taken before the change was in effect proves nothing.
//
// The shipped script runs against stand-ins for ifdown/ifup/ip/logger, with its
// paths moved into a temporary directory and its waits shortened.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { check, group, done } = require('./assert');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'sbin', 'netapply');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sandbox() {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'netapply-'));
	for (const sub of ['bin', 'ifdir', 'run', 'varrun']) fs.mkdirSync(path.join(d, sub));
	const stub = (name, body) => {
		const f = path.join(d, 'bin', name);
		fs.writeFileSync(f, '#!/bin/sh\n' + body + '\n');
		fs.chmodSync(f, 0o755);
	};
	const log = path.join(d, 'calls');
	stub('ifdown', `echo "ifdown $*" >> "${log}"`);
	stub('ifup', `echo "ifup $*" >> "${log}"`);
	stub('logger', `echo "logger $*" >> "${log}"`);
	// A default route through the interface exists while $d/leased does.
	stub('ip', `[ -e "${d}/leased" ] && [ "$4" = dev ] && echo "default via 10.0.0.1 dev $5"; exit 0`);
	fs.writeFileSync(path.join(d, 'ifdir', 'eth0'), 'iface eth0 inet static\n    address 10.0.0.99\n');
	fs.writeFileSync(path.join(d, 'backup'), 'iface eth0 inet dhcp\n');
	return d;
}

function run(shell, d, mode, token) {
	const env = Object.assign({}, process.env, {
		PATH: path.join(d, 'bin') + ':' + process.env.PATH,
		NETAPPLY_IFDIR: path.join(d, 'ifdir'),
		NETAPPLY_RUN: path.join(d, 'run'),
		NETAPPLY_VARRUN: path.join(d, 'varrun'),
		NETAPPLY_WAIT: '3',
		NETAPPLY_WAIT_DHCP: '3',
		NETAPPLY_DELAY: '1',
	});
	const p = spawn(shell[0], shell.slice(1).concat([SCRIPT, 'eth0', token, path.join(d, 'backup'), mode]), { env });
	return new Promise((res) => p.on('exit', (code) => res(code)));
}

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } };
const phase = (d) => (read(path.join(d, 'run', 'netapply.pending')) || '').trim().split(' ')[3];
async function until(cond, ms) {
	for (let t = 0; t < ms; t += 50) { if (cond()) return true; await sleep(50); }
	return false;
}

async function suite(shell) {
	const label = shell.join(' ');

	let d = sandbox();
	let exit = run(shell, d, 'static', 'aa11');
	const sawApplying = await until(() => phase(d) === 'applying', 1000);
	const sawApplied = await until(() => phase(d) === 'applied', 3000);
	fs.writeFileSync(path.join(d, 'run', 'netapply.ok.aa11'), '');
	await exit;
	check(label + ': the pending file goes applying, then applied', sawApplying && sawApplied);
	check(label + ': a confirmed static change is kept',
		read(path.join(d, 'ifdir', 'eth0')).includes('10.0.0.99') &&
		!fs.existsSync(path.join(d, 'run', 'netapply.rolledback')));
	check(label + ': ...and leaves nothing behind',
		!fs.existsSync(path.join(d, 'backup')) && !fs.existsSync(path.join(d, 'run', 'netapply.pending')));

	d = sandbox();
	await run(shell, d, 'static', 'bb22');
	const calls = read(path.join(d, 'calls')) || '';
	check(label + ': an unconfirmed static change is put back',
		read(path.join(d, 'ifdir', 'eth0')) === 'iface eth0 inet dhcp\n' &&
		(read(path.join(d, 'run', 'netapply.rolledback')) || '').trim() === 'bb22');
	check(label + ': ...and the restored stanza is applied',
		(calls.match(/^ifup eth0$/gm) || []).length === 2, calls);

	d = sandbox();
	exit = run(shell, d, 'static', 'cc33');
	fs.writeFileSync(path.join(d, 'run', 'netapply.ok.cc33'), '');
	await exit;
	check(label + ': a confirmation from before the change was applied does not count',
		read(path.join(d, 'ifdir', 'eth0')) === 'iface eth0 inet dhcp\n');

	d = sandbox();
	fs.writeFileSync(path.join(d, 'leased'), '');
	await run(shell, d, 'dhcp', 'dd44');
	check(label + ': a DHCP change is kept once a lease brings a default route',
		read(path.join(d, 'ifdir', 'eth0')).includes('10.0.0.99') &&
		!fs.existsSync(path.join(d, 'run', 'netapply.rolledback')));

	d = sandbox();
	await run(shell, d, 'dhcp', 'ee55');
	check(label + ': a DHCP change with no lease is put back',
		read(path.join(d, 'ifdir', 'eth0')) === 'iface eth0 inet dhcp\n');

	// ifdown has to stop the interface by the stanza that started it: by the
	// new one, a DHCP eth0 taken to a fixed address was left with its udhcpc
	// running (seen on a camera), to renew the lease over the typed address.
	d = sandbox();
	const stray = path.join(d, 'bin', 'udhcpc');
	// No exec: comm stays "udhcpc", the name netapply checks before it kills.
	fs.writeFileSync(stray, '#!/bin/sh\nwhile :; do sleep 1; done\n');
	fs.chmodSync(stray, 0o755);
	const old = spawn(stray, [], { detached: true, stdio: 'ignore' });
	const oldExit = new Promise((res) => old.on('exit', () => res(true)));
	fs.writeFileSync(path.join(d, 'varrun', 'udhcpc.eth0.pid'), String(old.pid));
	exit = run(shell, d, 'static', 'ab12');
	await until(() => phase(d) === 'applied', 3000);
	fs.writeFileSync(path.join(d, 'run', 'netapply.ok.ab12'), '');
	await exit;
	const downs = (read(path.join(d, 'calls')) || '').split('\n').filter((l) => l.startsWith('ifdown'));
	check(label + ': the interface is taken down by the stanza that brought it up',
		downs[0] === 'ifdown -i ' + path.join(d, 'backup') + ' -f eth0', downs.join(' | '));
	const stopped = await Promise.race([oldExit, sleep(2000).then(() => false)]);
	check(label + ': a udhcpc the old stanza started does not outlive it', stopped);
	if (!stopped) process.kill(-old.pid);

	d = sandbox();
	await run(shell, d, 'static', 'cd34');
	const rb = (read(path.join(d, 'calls')) || '').split('\n').filter((l) => l.startsWith('ifdown'));
	check(label + ': a rollback takes the interface down by the stanza being undone',
		rb[1] === 'ifdown -i ' + path.join(d, 'run', 'netapply.new.eth0') + ' -f eth0', rb.join(' | '));

	d = sandbox();
	fs.unlinkSync(path.join(d, 'backup'));
	const code = await run(shell, d, 'static', 'ff66');
	check(label + ': with no backup to fall back on it does nothing at all',
		code !== 0 && !fs.existsSync(path.join(d, 'calls')));
}

(async () => {
	group('netapply');
	// Run under the system's sh only: a busybox built to prefer its applets
	// runs its own ifup, ifdown and ip over the stand-ins on PATH, and would
	// bounce this machine's interfaces. Busybox still gets to parse it, which
	// is what a camera does first.
	const bb = spawnSync('busybox', ['sh', '-n', SCRIPT]);
	if (!bb.error) check('busybox sh parses it', bb.status === 0, String(bb.stderr));
	await suite(['sh']);
	done();
})();
