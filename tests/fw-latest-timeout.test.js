// fw_latest_build's time bound, which has to hold on a camera with a route and
// no internet -- the one network a page cannot tell from a slow one (#683).
//
// It failed silently: the page simply took as long as curl did to give up, and
// the 15 seconds in the source read as a bound that was being kept. busybox
// `timeout` kills the command it ran and nothing that command started, and a
// curl sysupgrade left blocked still holds the stdout it inherited. A caller
// reading that through a pipe waits for the last writer, not for `timeout`.
// Reproducing it takes a camera, a network that drops packets rather than
// refusing them, and a stopwatch.
//
// So `timeout` is stubbed with busybox's semantics -- kill the one pid -- rather
// than the host's coreutils, which signals the whole process group and would
// hide exactly the fault this file is about. Its bound is a second, not 15:
// what is pinned is that the bound is the one that ends the wait.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { check, group, done } = require('./assert');

const FW_SH = path.join(__dirname, '..', 'www', 'cgi-bin', 'p', 'firmware.sh');

// The orphan outlives the bound by far more than the slack allowed below, so a
// wait that is not ended by `timeout` cannot pass by accident.
const ORPHAN_S = 20;

function run(opts) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-latest-'));
	const bin = path.join(dir, 'bin');
	fs.mkdirSync(bin);
	fs.writeFileSync(path.join(bin, 'ip'),
		'#!/bin/sh\necho "default via 192.0.2.1 dev eth0"\n', { mode: 0o755 });
	// busybox: run it, kill that pid when the time is up, and only that pid.
	// The watcher's own descriptors are pointed away, so the stub itself holds
	// nothing open that the code under test might be waiting on.
	fs.writeFileSync(path.join(bin, 'timeout'), [
		'#!/bin/sh',
		'shift',
		'"$@" & p=$!',
		'( sleep 1; kill "$p" 2>/dev/null ) </dev/null >/dev/null 2>&1 & w=$!',
		'wait "$p"; rc=$?',
		'kill "$w" 2>/dev/null',
		'exit "$rc"',
		'',
	].join('\n'), { mode: 0o755 });
	// sysupgrade as it behaves offline: it has printed its banner, and then sits
	// in a curl that inherited its stdout. The background sleep is that curl.
	fs.writeFileSync(path.join(bin, 'sysupgrade'), [
		'#!/bin/sh',
		'echo "Available builds for hi3516av300_lite (newest first):"',
		opts.build ? `echo "    ${opts.build}"` : ':',
		`sleep ${ORPHAN_S} &`,
		`sleep ${ORPHAN_S}`,
		'',
	].join('\n'), { mode: 0o755 });

	const t0 = Date.now();
	const r = spawnSync('sh', ['-c', '. "$1"; fw_latest_build', 'sh', FW_SH], {
		env: Object.assign({}, process.env, { PATH: bin + ':' + process.env.PATH }),
		encoding: 'utf8',
		timeout: (ORPHAN_S + 5) * 1000,
	});
	const secs = (Date.now() - t0) / 1000;
	fs.rmSync(dir, { recursive: true, force: true });
	return { out: (r.stdout || '').trim(), secs: secs, status: r.status };
}

group('an updater stuck behind an orphaned curl');
{
	const r = run({ build: 'nightly-20261013-68bbac0' });
	check('returns when timeout fires, not when the orphan exits (took ' + r.secs.toFixed(1) + 's)',
		r.secs < 5);
	check('keeps what sysupgrade printed before it was killed', r.out === 'nightly-20261013-68bbac0', r.out);
}
{
	const r = run({});
	check('nothing printed: answers nothing, and as promptly (took ' + r.secs.toFixed(1) + 's)',
		r.out === '' && r.secs < 5, JSON.stringify(r));
}

group('nothing left behind');
{
	const before = fs.readdirSync('/tmp').filter((f) => f.startsWith('fw-builds.')).length;
	run({ build: 'nightly-20261013-68bbac0' });
	const after = fs.readdirSync('/tmp').filter((f) => f.startsWith('fw-builds.')).length;
	check('the scratch file is removed', after <= before, before + ' -> ' + after);
}

done();
