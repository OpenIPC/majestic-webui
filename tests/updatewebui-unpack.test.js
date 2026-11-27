'use strict';

// What an update unpacks into /tmp, which on a camera is RAM (#747).
//
// The archive is the whole repository and the installer needs a third less of
// it than that. Unpacking all of it, beside the archive, took 9.8 MB on a 64 MB
// SSC325 and the kernel killed majestic for it -- on a --dry-run. Nothing on a
// workstation with gigabytes free can show that, so this runs the shipped
// fetch_tree under busybox over hand-built archives and looks at what it left
// in /tmp, and at whether it asks for the memory before it takes it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { check, group, done } = require('./assert');
const { zipWith } = require('./zip');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'sbin', 'updatewebui'), 'utf8');
function shellFn(name) {
	const start = SRC.indexOf('\n' + name + '() {');
	const end = SRC.indexOf('\n}\n', start);
	if (start < 0 || end < 0) throw new Error(name + ' was not found in sbin/updatewebui; this test is testing nothing');
	return SRC.slice(start + 1, end + 3);
}
const reserve = +((/^MEM_RESERVE_KB=(\d+)$/m.exec(SRC) || [])[1]);
if (!reserve) throw new Error('MEM_RESERVE_KB was not found in sbin/updatewebui');

const scratch = [];
process.on('exit', () => scratch.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

// busybox's own applets, unzip above all: the camera's, not whatever this
// machine has. curl is a stand-in that serves the file named in $SERVE.
const BB = fs.mkdtempSync(path.join(os.tmpdir(), 'uwu-bb-'));
scratch.push(BB);
const busybox = spawnSync('sh', ['-c', 'command -v busybox'], { encoding: 'utf8' }).stdout.trim();
if (!busybox) throw new Error('busybox is not on PATH; this test is testing nothing');
for (const a of spawnSync(busybox, ['--list'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)) {
	if (a !== 'curl') fs.symlinkSync(busybox, path.join(BB, a));
}
fs.writeFileSync(path.join(BB, 'curl'), [
	'#!/bin/sh',
	'printf "%s\\n" "$@" >"$CURL_LOG"',
	'out=; prev=',
	'for a in "$@"; do [ "$prev" = "-o" ] && out=$a; prev=$a; done',
	'cat "$SERVE" >"$out"',
].join('\n') + '\n', { mode: 0o755 });

const BIG = 'x'.repeat(20000);
const TREE = [
	['top/www/cgi-bin/p/common.cgi', '#!/usr/bin/haserl\n'],
	['top/www/a/main.js', BIG],
	['top/sbin/updatewebui', '#!/bin/sh\n'],
	['top/bin/ntfy.sh', '#!/bin/sh\n'],
	['top/tests/big.test.js', BIG + BIG + BIG],
	['top/docs/deploying.md', BIG],
	['top/tools/build-dist.sh', BIG],
];
// tmpfs keeps a file in whole 4 kB pages.
const NEED = TREE.filter(([n]) => /^top\/(www|sbin|bin)\//.test(n))
	.reduce((kb, [, t]) => kb + Math.ceil(Buffer.byteLength(t) / 4096) * 4, 0);

// `archive` is the bytes to fetch; `how` is 'file' or 'https'; `avail` the
// MemAvailable to report, or null for a kernel that has no such line.
function fetch(archive, how, avail) {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uwu-'));
	scratch.push(d);
	const tmp = path.join(d, 'tmp');
	fs.mkdirSync(tmp);
	const zip = path.join(d, 'tree.zip');
	fs.writeFileSync(zip, archive);
	const meminfo = path.join(d, 'meminfo');
	fs.writeFileSync(meminfo, 'MemTotal:  27796 kB\n' + (avail === null ? '' : 'MemAvailable: ' + avail + ' kB\n') + 'Cached: 1000 kB\n');
	const curlLog = path.join(d, 'curl.args');
	const fns = shellFn('die') + shellFn('mem_available_kb') + shellFn('fetch_tree');
	const r = spawnSync('busybox', ['sh', '-c', fns + 'fetch_tree && echo "SRC=$src"'], {
		env: {
			PATH: BB, tmp: tmp, scr_name: 'updatewebui', REPO: 'openipc/majestic-webui', SERVE: zip, CURL_LOG: curlLog,
			zip_url: how === 'file' ? 'file://' + zip : 'https://example.invalid/tree.zip',
			MEMINFO: meminfo, MEM_RESERVE_KB: String(reserve),
		},
		encoding: 'utf8',
	});
	if (r.error) throw r.error;
	const walk = (p) => fs.existsSync(p) ? fs.readdirSync(p) : [];
	return { status: r.status, out: r.stdout, err: r.stderr, tmp: walk(tmp), top: walk(path.join(tmp, 'x', 'top')),
		x: walk(path.join(tmp, 'x')),
		src: (/SRC=(.*)/.exec(r.stdout) || [])[1], zipKept: fs.existsSync(zip),
		curl: fs.existsSync(curlLog) ? fs.readFileSync(curlLog, 'utf8').split('\n').filter(Boolean) : null };
}

const plenty = 200000;

group('only what is installed is unpacked');
{
	const r = fetch(zipWith(TREE), 'file', plenty);
	check('the tree is unpacked (otherwise this tests nothing)', r.status === 0 && /\/x\/top$/.test(r.src || ''), r.err);
	check('www, sbin and bin, and nothing else', r.top.sort().join(' ') === 'bin sbin www', r.top.join(' '));
	check('a file:// archive is read where it lies: nothing else is in /tmp', r.tmp.join(' ') === 'x', r.tmp.join(' '));
	check('and it is the caller\'s, so it stays', r.zipKept);
}
{
	const r = fetch(zipWith(TREE), 'https', plenty);
	check('a downloaded archive goes once it is unpacked', r.status === 0 && r.tmp.join(' ') === 'x', r.tmp.join(' ') + r.err);
}

group('the memory is asked for before it is taken');
{
	const r = fetch(zipWith(TREE), 'file', NEED + reserve - 1);
	check('a camera that cannot spare it is refused', r.status !== 0 && /not enough free memory/.test(r.err), r.err);
	check('naming what it needed, in tmpfs pages', new RegExp('needs ' + NEED + ' kB').test(r.err), NEED + ' / ' + r.err);
	check('and having unpacked nothing', r.top.length === 0, r.top.join(' '));
	const ok = fetch(zipWith(TREE), 'file', NEED + reserve);
	check('one that can is not', ok.status === 0, ok.err);
	const old = fetch(zipWith(TREE), 'file', null);
	check('a kernel that cannot say goes ahead, as it always did', old.status === 0 && old.top.length === 3, old.err);
}
{
	// GitHub sends an archive without its size, so the download can only be
	// capped, and refused outright when not even the reserve is free.
	const cap = (r) => { const i = (r.curl || []).indexOf('--max-filesize'); return i < 0 ? null : +r.curl[i + 1]; };
	const r = fetch(zipWith(TREE), 'https', plenty);
	check('a download is capped at what is free beyond the reserve', cap(r) === (plenty - reserve) * 1024,
		JSON.stringify(r.curl));
	const none = fetch(zipWith(TREE), 'https', reserve);
	check('and not started when the reserve is all there is', none.status !== 0 && none.curl === null &&
		/not enough free memory to download/.test(none.err), none.err);
	const old = fetch(zipWith(TREE), 'https', null);
	check('a kernel that cannot say downloads uncapped, as before', old.status === 0 && cap(old) === null,
		JSON.stringify(old.curl));
}

group('the top directory is a name from the archive');
{
	const odd = 'tree [1] *';
	const r = fetch(zipWith(TREE.map(([n, t]) => [n.replace(/^top\//, odd + '/'), t])), 'file', plenty);
	check('one with a space, brackets and a star is unpacked as it is named', r.status === 0 &&
		(r.src || '').endsWith('/x/' + odd), r.err + (r.src || ''));
}

group('what is not a release is still refused');
{
	const r = fetch(Buffer.from('<html>rate limited</html>'), 'https', plenty);
	check('a page that is not a zip', r.status !== 0 && /not a usable zip/.test(r.err), r.err);
	const whole = zipWith(TREE);
	const cut = fetch(whole.subarray(0, Math.floor(whole.length * 0.6)), 'https', plenty);
	check('a truncated download', cut.status !== 0 && /not a usable zip/.test(cut.err), cut.err);
	const two = fetch(zipWith(TREE.concat([['other/www/x', 'y']])), 'https', plenty);
	check('an archive that is not one tree', two.status !== 0 && /expected one directory/.test(two.err), two.err);
	const none = fetch(zipWith([['top/README.md', 'hi']]), 'https', plenty);
	check('one that holds no WebUI', none.status !== 0 && /does not hold a WebUI tree/.test(none.err), none.err);
}

done();
