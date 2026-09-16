'use strict';

// The stub that stands where the installer used to be.
//
// /usr/sbin/updatewebui is no longer the installer; it is a few lines that
// download the installer and run it. Every decision it makes fails silently,
// which is why this file exists:
//
//   * it picks which branch's installer to fetch out of the arguments. Get
//     that wrong and the run still succeeds — with the wrong installer, which
//     is precisely the case the old in-flight handover existed to serve.
//   * it decides whether what came back IS the installer. Without curl's -f a
//     404 exits 0 and the error page is written to the file, and the next
//     thing that happens is `sh` on it. The same defect, in the same shape,
//     shipped in /etc/profile's majestic_webui() for years.
//   * --restore promises in its own help text that it downloads nothing. That
//     promise now rests on the stub preferring its cache, and nothing on a
//     camera would report it broken.
//   * the arguments have to arrive intact at the other side.
//
// So: a fake curl and a fake installer, the real stub run against them, and
// assertions about what was fetched and what was run. The stub is REWRITTEN
// rather than re-typed, and a substitution that stops matching is a failure
// rather than a skip — the rule the other shell tests here follow.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { check, group, done } = require('./assert');

const STUB = path.join(__dirname, '..', 'sbin', 'updatewebui-fetch');
const NL = String.fromCharCode(10);

// An installer that does nothing but record how it was called. It carries the
// marker line the stub checks for, because that check is one of the subjects.
const INSTALLER = [
	'#!/bin/sh',
	'scr_name=updatewebui',
	'printf "%s' + '\\n' + '" "$@" >"$0.argv"',
	'echo RAN',
].join(NL) + NL;

let dir;

// Stand a camera up: a PATH carrying our own curl, and a directory standing in
// for /etc/webui. `serve` is what that curl answers with; null makes it fail
// the way an unreachable host does.
function camera(serve) {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uwf-'));
	fs.mkdirSync(path.join(dir, 'bin'));
	fs.mkdirSync(path.join(dir, 'state'));
	const log = path.join(dir, 'curl.args');
	const body = path.join(dir, 'served');
	const fake = [
		'#!/bin/sh',
		'for a in "$@"; do printf "%s' + '\\n' + '" "$a" >>' + q(log) + '; done',
		'out=; prev=',
		'for a in "$@"; do [ "$prev" = "-o" ] && out=$a; prev=$a; done',
		serve === null ? 'exit 7' : 'cat ' + q(body) + ' >"$out"',
		'exit 0',
	].join(NL) + NL;
	fs.writeFileSync(path.join(dir, 'bin', 'curl'), fake, { mode: 0o755 });
	if (serve !== null) fs.writeFileSync(body, serve);
}

function q(s) {
	return "'" + s + "'";
}

function stub() {
	let s = fs.readFileSync(STUB, 'utf8');
	const re = /^STATE_DIR=\/etc\/webui$/m;
	if (!re.test(s)) throw new Error('the stub no longer sets STATE_DIR=/etc/webui');
	s = s.replace(re, 'STATE_DIR=' + path.join(dir, 'state'));
	const p = path.join(dir, 'stub');
	fs.writeFileSync(p, s, { mode: 0o755 });
	return p;
}

function run(args, cb) {
	execFile(
		'/bin/sh',
		[stub()].concat(args),
		{ env: Object.assign({}, process.env, { PATH: path.join(dir, 'bin') + ':' + process.env.PATH }) },
		(err, stdout, stderr) => cb({ code: err ? err.code : 0, stdout: stdout, stderr: stderr }),
	);
}

function fetched() {
	const p = path.join(dir, 'curl.args');
	if (!fs.existsSync(p)) return [];
	return fs.readFileSync(p, 'utf8').split(NL).filter(Boolean);
}

const urlAsked = () => fetched().filter((a) => a.indexOf('https://') === 0).pop() || '';
const cachePath = () => path.join(dir, 'state', 'updatewebui.sh');
const ranWith = () => {
	const p = cachePath() + '.argv';
	return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split(NL).filter(Boolean) : null;
};

// -------------------------------------------------------- which branch -----

const RAW = 'https://raw.githubusercontent.com/openipc/majestic-webui/';

const BRANCHES = [
	[[], 'master', 'nothing asked for'],
	[['-b', 'topic'], 'topic', '-b NAME'],
	[['--branch=topic'], 'topic', '--branch=NAME'],
	[['topic'], 'topic', 'a bare argument'],
	[['--dry-run'], 'master', 'an option is not a branch'],
	[['-r'], 'master', 'a --restore with no cache is not a branch'],
	[['--url=https://example.invalid/x.zip'], 'master', 'a --url value is not a branch'],
	[['-b', 'topic', '--dry-run'], 'topic', 'a branch followed by options'],
];

group('the installer comes from the branch being installed');

// One at a time. Each case stands up its own camera and `dir` is what says
// which one, so starting them together would have every assertion read the
// last camera's log — which is exactly what happened when this was a forEach.
(function next(i) {
	if (i === BRANCHES.length) return refusals();
	const [args, want, what] = BRANCHES[i];
	camera(INSTALLER);
	run(args, () => {
		check(what + ' -> ' + want, urlAsked() === RAW + want + '/sbin/updatewebui', urlAsked());
		next(i + 1);
	});
})(0);

// ------------------------------------------------------- what came back ----

function refusals() {
	group('what came back has to be the installer');

	camera(INSTALLER);
	run([], () => {
		check('curl is asked to fail on an HTTP error (-f)', fetched().indexOf('-fsSL') !== -1, fetched().join(' '));
		check('a good download is run', ranWith() !== null, 'the installer did not run');
		check('and is kept for next time', fs.existsSync(cachePath()));

		// A 200 carrying something else — the shape -f cannot see.
		camera('<html><head><title>404: Not Found</title></head></html>' + NL);
		run([], (r) => {
			check('an error page arriving with a 200 is refused', r.code !== 0, 'exit ' + r.code);
			check('and is not cached', !fs.existsSync(cachePath()), 'it was cached');
			check('leaving no half-written file behind', !fs.existsSync(cachePath() + '.new'));

			// A real shell script, but not this one.
			camera('#!/bin/sh' + NL + 'echo I am something else' + NL);
			run([], (r2) => {
				check('a shell script that is not the installer is refused', r2.code !== 0, 'exit ' + r2.code);
				check('and says so', /not the installer/.test(r2.stderr), r2.stderr.trim());
				offline();
			});
		});
	});
}

// ------------------------------------------------------------ offline ------

function offline() {
	group('a camera that cannot reach GitHub');

	camera(null);
	run([], (r) => {
		check('with nothing cached, the run stops', r.code !== 0, 'exit ' + r.code);
		check('and says why', /cannot reach GitHub/.test(r.stderr), r.stderr.trim());
		check('and says how to fetch one by hand', /curl -fsSL/.test(r.stderr), r.stderr.trim());

		camera(null);
		fs.writeFileSync(cachePath(), INSTALLER, { mode: 0o755 });
		run([], (r2) => {
			check('with a cached installer the run goes ahead', ranWith() !== null, 'it did not run');
			check('and says the cache is what ran', /using the installer cached/.test(r2.stderr), r2.stderr.trim());
			restore();
		});
	});
}

// ------------------------------------------------------------ restore ------

function restore() {
	group('--restore keeps its promise to download nothing');

	// A camera that CAN reach GitHub: the point is that it is not asked to.
	camera(INSTALLER);
	fs.writeFileSync(cachePath(), INSTALLER, { mode: 0o755 });
	run(['--restore'], () => {
		check('a cached installer is used without fetching', fetched().length === 0, fetched().join(' '));
		check('and it runs', ranWith() !== null, 'it did not run');
		check('with the argument it was given', (ranWith() || []).join(' ') === '--restore', String(ranWith()));

		// With no cache there is nothing to restore from, so fetching is
		// better than refusing to undo an install that went wrong.
		camera(INSTALLER);
		run(['-r'], () => {
			check('with no cache it falls back to fetching', fetched().length > 0, 'it did not fetch');
			passthrough();
		});
	});
}

// -------------------------------------------------------- pass-through -----

function passthrough() {
	group('the arguments reach the installer');

	camera(INSTALLER);
	const args = ['--branch=topic', '--dry-run', '--no-backup'];
	run(args, () => {
		check('every argument, in order', (ranWith() || []).join(' ') === args.join(' '), JSON.stringify(ranWith()));
		done();
	});
}
