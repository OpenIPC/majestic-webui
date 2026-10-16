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

function sandbox(token) {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'netapply-'));
	for (const sub of ['bin', 'ifdir', 'run', 'varrun', 'proc']) fs.mkdirSync(path.join(d, sub));
	sockets(d, [], []);
	const stub = (name, body) => {
		const f = path.join(d, 'bin', name);
		fs.writeFileSync(f, '#!/bin/sh\n' + body + '\n');
		fs.chmodSync(f, 0o755);
	};
	const log = path.join(d, 'calls');
	stub('ifdown', `echo "ifdown $*" >> "${log}"`);
	// Refuses a stanza other than the firmware's while $d/badup exists.
	stub('ifup', `echo "ifup $*" >> "${log}"; [ "$1" = -i ] && [ -e "${d}/badup" ] && exit 1; exit 0`);
	stub('logger', `echo "logger $*" >> "${log}"`);
	// A default route through the interface exists while $d/leased does.
	stub('ip', `[ -e "${d}/leased" ] && [ "$3" = show ] && echo "default via 192.0.2.1 dev $5"; exit 0`);
	fs.writeFileSync(path.join(d, 'ifdir', 'eth0'), 'iface eth0 inet static\n    address 192.0.2.99\n');
	fs.writeFileSync(path.join(d, 'backup'), 'iface eth0 inet dhcp\n');
	// network.cgi takes the record before it starts the worker.
	if (token) fs.writeFileSync(path.join(d, 'run', 'netapply.pending'), `1 ${token} eth0 starting\n`);
	return d;
}

// The kernel's socket tables, as /proc/net/tcp and tcp6 spell them. Rows are
// [state, local, remote] with dotted IPv4 and a port; tcp6 rows are written
// v4-mapped, the way an IPv4 browser shows up on majestic's dual-stack port.
const hex4 = (ip) => ip.split('.').reverse().map((o) => (+o).toString(16).padStart(2, '0')).join('').toUpperCase();
const hexEnd = (ep) => {
	const i = ep.lastIndexOf(':');
	return [ep.slice(0, i), (+ep.slice(i + 1)).toString(16).padStart(4, '0').toUpperCase()];
};
function sockets(d, v4, v6) {
	const row = (i, [st, l, r], six) => {
		const [li, lp] = hexEnd(l), [ri, rp] = hexEnd(r);
		const a = (ip) => (ip === '::' ? '0'.repeat(32) : (six ? '0000000000000000FFFF0000' : '') + hex4(ip));
		return `   ${i}: ${a(li)}:${lp} ${a(ri)}:${rp} ${st} 00000000:00000000 00:00000000 00000000     0        0 1 1 0 100 0 0 10 0`;
	};
	const head = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
	// majestic's listener, dual-stack as on a camera, bound to the wildcard.
	v6 = [['0A', ':::80', ':::0']].concat(v6);
	fs.writeFileSync(path.join(d, 'proc', 'tcp'), [head].concat(v4.map((x, i) => row(i, x, false))).join('\n') + '\n');
	fs.writeFileSync(path.join(d, 'proc', 'tcp6'), [head].concat(v6.map((x, i) => row(i, x, true))).join('\n') + '\n');
}

function run(shell, d, mode, token) {
	const env = Object.assign({}, process.env, {
		PATH: path.join(d, 'bin') + ':' + process.env.PATH,
		NETAPPLY_IFDIR: path.join(d, 'ifdir'),
		NETAPPLY_RUN: path.join(d, 'run'),
		NETAPPLY_VARRUN: path.join(d, 'varrun'),
		NETAPPLY_PROC: path.join(d, 'proc'),
		NETAPPLY_WAIT: '3',
		NETAPPLY_WAIT_DHCP: '3',
		NETAPPLY_DELAY: '1',
	});
	const p = spawn(shell[0], shell.slice(1).concat([SCRIPT, 'eth0', token, path.join(d, 'backup'), mode]), { env });
	const exit = new Promise((res) => p.on('exit', (code) => res(code)));
	exit.pid = p.pid;
	return exit;
}

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } };
const phase = (d) => (read(path.join(d, 'run', 'netapply.pending')) || '').trim().split(' ')[3];
const outcome = (d) => (read(path.join(d, 'run', 'netapply.done')) || '').trim();
const boot = (d) => read(path.join(d, 'ifdir', 'eth0'));
const OLD = 'iface eth0 inet dhcp\n';
async function until(cond, ms) {
	for (let t = 0; t < ms; t += 50) { if (cond()) return true; await sleep(50); }
	return false;
}

async function suite(shell) {
	const label = shell.join(' ');

	let d = sandbox('aa11');
	let exit = run(shell, d, 'static', 'aa11');
	const sawApplying = await until(() => phase(d) === 'applying', 1000);
	const sawApplied = await until(() => phase(d) === 'applied', 3000);
	const bootDuring = boot(d);
	fs.writeFileSync(path.join(d, 'run', 'netapply.ok.aa11'), '');
	await exit;
	check(label + ': the pending file goes applying, then applied', sawApplying && sawApplied);
	check(label + ': until it is kept, the camera would boot on the previous stanza', bootDuring === OLD, bootDuring);
	check(label + ': a confirmed static change is kept',
		boot(d).includes('192.0.2.99') && outcome(d) === 'aa11 kept', outcome(d));
	check(label + ': ...and leaves nothing behind',
		!fs.existsSync(path.join(d, 'backup')) && !fs.existsSync(path.join(d, 'run', 'netapply.pending')) &&
		!fs.existsSync(path.join(d, 'run', 'netapply.new.eth0')));

	d = sandbox('bb22');
	await run(shell, d, 'static', 'bb22');
	const calls = read(path.join(d, 'calls')) || '';
	check(label + ': an unconfirmed static change is put back',
		boot(d) === OLD && outcome(d) === 'bb22 rolledback', outcome(d));
	check(label + ': ...the new stanza applied, then the restored one',
		/^ifup -i \S+netapply\.new\.eth0 eth0$/m.test(calls) && /^ifup eth0$/m.test(calls), calls);

	d = sandbox('cc33');
	exit = run(shell, d, 'static', 'cc33');
	fs.writeFileSync(path.join(d, 'run', 'netapply.ok.cc33'), '');
	await exit;
	check(label + ': a confirmation from before the change was applied does not count',
		boot(d) === OLD && outcome(d) === 'cc33 rolledback');

	// The browser that saved the change is on the old address; reaching the
	// new one -- even only its sign-in page, a connection now closed -- keeps
	// the change with no confirmation request at all (#690).
	const BROWSER = '10.0.0.5', OLDADDR = '192.0.2.10', NEWADDR = '192.0.2.99';
	d = sandbox('ac01');
	sockets(d, [], [['01', OLDADDR + ':80', BROWSER + ':40000']]);
	exit = run(shell, d, 'static', 'ac01');
	await until(() => phase(d) === 'applied', 3000);
	sockets(d, [], [['06', NEWADDR + ':80', BROWSER + ':40100']]);
	await exit;
	check(label + ': the saving browser reaching the new address keeps the change',
		boot(d).includes(NEWADDR) && outcome(d) === 'ac01 kept' &&
		/kept the new eth0 settings \(reached\)/.test(read(path.join(d, 'calls')) || ''), outcome(d));

	d = sandbox('ac02');
	sockets(d, [['01', OLDADDR + ':80', BROWSER + ':40000']], []);
	exit = run(shell, d, 'static', 'ac02');
	await until(() => phase(d) === 'applied', 3000);
	sockets(d, [['01', NEWADDR + ':80', '10.0.0.6:40100']], []);
	await exit;
	check(label + ': a client that was not talking to the camera proves nothing',
		boot(d) === OLD && outcome(d) === 'ac02 rolledback', outcome(d));

	d = sandbox('ac03');
	sockets(d, [], [['01', OLDADDR + ':80', BROWSER + ':40000']]);
	exit = run(shell, d, 'static', 'ac03');
	await until(() => phase(d) === 'applied', 3000);
	sockets(d, [], [['03', NEWADDR + ':80', BROWSER + ':40100']]);
	await exit;
	check(label + ': a SYN that arrived, answered by nothing that got back, proves nothing',
		boot(d) === OLD && outcome(d) === 'ac03 rolledback', outcome(d));

	// The camera's own outbound connection names a peer, not a browser: that
	// peer later reaching the new address says nothing about its owner.
	d = sandbox('ac05');
	sockets(d, [], [['01', OLDADDR + ':80', BROWSER + ':40000'], ['01', OLDADDR + ':41000', '10.0.0.7:443']]);
	exit = run(shell, d, 'static', 'ac05');
	await until(() => phase(d) === 'applied', 3000);
	sockets(d, [], [['06', NEWADDR + ':80', '10.0.0.7:40100']]);
	await exit;
	check(label + ': a peer the camera itself had dialled out to proves nothing',
		boot(d) === OLD && outcome(d) === 'ac05 rolledback', outcome(d));

	// The new address can be the old one with only the gateway changed: the
	// connections already open to it were made under the old settings.
	d = sandbox('ac04');
	sockets(d, [], [['01', NEWADDR + ':80', BROWSER + ':40000']]);
	await run(shell, d, 'static', 'ac04');
	check(label + ': a connection that was already open to the address does not count',
		boot(d) === OLD && outcome(d) === 'ac04 rolledback', outcome(d));

	d = sandbox('dd44');
	fs.writeFileSync(path.join(d, 'leased'), '');
	await run(shell, d, 'dhcp', 'dd44');
	check(label + ': a DHCP change is kept once a lease brings a default route',
		boot(d).includes('192.0.2.99') && outcome(d) === 'dd44 kept');

	d = sandbox('ee55');
	await run(shell, d, 'dhcp', 'ee55');
	check(label + ': a DHCP change with no lease is put back', boot(d) === OLD && outcome(d) === 'ee55 rolledback');

	// ifdown has to stop the interface by the stanza that started it: by the
	// new one, a DHCP eth0 taken to a fixed address was left with its udhcpc
	// running (seen on a camera), to renew the lease over the typed address.
	d = sandbox('ab12');
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
		downs[0] === 'ifdown -i ' + path.join(d, 'ifdir', 'eth0') + ' -f eth0', downs.join(' | '));
	const stopped = await Promise.race([oldExit, sleep(2000).then(() => false)]);
	check(label + ': a udhcpc the old stanza started does not outlive it', stopped);
	if (!stopped) process.kill(-old.pid);

	d = sandbox('cd34');
	await run(shell, d, 'static', 'cd34');
	const rb = (read(path.join(d, 'calls')) || '').split('\n').filter((l) => l.startsWith('ifdown'));
	check(label + ': a rollback takes the interface down by the stanza being undone',
		rb[1] === 'ifdown -i ' + path.join(d, 'run', 'netapply.new.eth0') + ' -f eth0', rb.join(' | '));

	d = sandbox('ef01');
	fs.writeFileSync(path.join(d, 'badup'), '');
	exit = run(shell, d, 'static', 'ef01');
	const fast = await Promise.race([exit.then(() => true), sleep(2500).then(() => false)]);
	check(label + ': a stanza ifup refuses is put back at once, never offered for confirmation',
		fast && boot(d) === OLD && outcome(d) === 'ef01 rolledback', outcome(d));

	d = sandbox('fa02');
	exit = run(shell, d, 'static', 'fa02');
	await until(() => phase(d) === 'applied', 3000);
	process.kill(exit.pid, 'SIGTERM');
	await exit;
	check(label + ': stopped while waiting, it puts the previous settings back',
		boot(d) === OLD && outcome(d) === 'fa02 rolledback' &&
		/^ifup eth0$/m.test(read(path.join(d, 'calls')) || ''), outcome(d));

	d = sandbox('fb03');
	exit = run(shell, d, 'static', 'fb03');
	await until(() => phase(d) === 'applied', 3000);
	fs.chmodSync(path.join(d, 'ifdir'), 0o555);
	fs.writeFileSync(path.join(d, 'run', 'netapply.ok.fb03'), '');
	await exit;
	fs.chmodSync(path.join(d, 'ifdir'), 0o755);
	check(label + ': a change kept but not written says so, and the boot file is the old one',
		boot(d) === OLD && outcome(d) === 'fb03 unsaved', outcome(d));

	d = sandbox('');
	const code0 = await run(shell, d, 'static', 'fc04');
	check(label + ': without the record network.cgi takes first it does nothing at all',
		code0 !== 0 && !fs.existsSync(path.join(d, 'calls')) && boot(d).includes('192.0.2.99'));

	d = sandbox('ff66');
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
