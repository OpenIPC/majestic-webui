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
//
// It records beside the FIXTURE rather than beside itself: the stub runs the
// installer from a scratch directory it removes on exit, so a file written
// next to $0 is gone before this process can read it.
function installer() {
	return [
		'#!/bin/sh',
		'scr_name=updatewebui',
		'printf "%s' + '\\n' + '" "$@" >' + q(path.join(dir, 'argv')),
		'echo RAN',
	].join(NL) + NL;
}

let dir;

// Stand a camera up: a PATH carrying our own curl, and a directory standing in
// for /etc/webui. `serve` is what that curl answers with; null makes it fail
// the way an unreachable host does.
const AS_INSTALLER = { installer: true };

function camera(serve, withState) {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uwf-'));
	fs.mkdirSync(path.join(dir, 'bin'));
	// NOT created by default. A camera that has never run an install has no
	// /etc/webui, and staging the download inside it is a download that fails
	// before it starts — which is what the first version of this stub did, and
	// what this fixture hid by making the directory up front.
	if (withState) fs.mkdirSync(path.join(dir, 'state'));
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
	if (serve !== null) fs.writeFileSync(body, serve === AS_INSTALLER ? installer() : serve);
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

// A store-only zip holding one entry, built by hand: the point is that the
// camera's own unzip opens it, so nothing here may pre-digest it.
function zipWith(entries) {
	const tbl = [];
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		tbl[n] = c >>> 0;
	}
	const crc32 = (b) => {
		let c = 0xffffffff;
		for (const x of b) c = tbl[(c ^ x) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const locals = [];
	const central = [];
	let off = 0;
	for (const [name, text] of entries) {
		const n = Buffer.from(name);
		const d = Buffer.from(text);
		const c = crc32(d);
		const lh = Buffer.alloc(30);
		lh.writeUInt32LE(0x04034b50, 0);
		lh.writeUInt16LE(20, 4);
		lh.writeUInt32LE(c, 14);
		lh.writeUInt32LE(d.length, 18);
		lh.writeUInt32LE(d.length, 22);
		lh.writeUInt16LE(n.length, 26);
		locals.push(lh, n, d);
		const ch = Buffer.alloc(46);
		ch.writeUInt32LE(0x02014b50, 0);
		ch.writeUInt16LE(20, 4);
		ch.writeUInt16LE(20, 6);
		ch.writeUInt32LE(c, 16);
		ch.writeUInt32LE(d.length, 20);
		ch.writeUInt32LE(d.length, 24);
		ch.writeUInt16LE(n.length, 28);
		ch.writeUInt32LE(0o100755 * 0x10000, 38); // << 16 goes negative in a 32-bit signed shift
		ch.writeUInt32LE(off, 42);
		central.push(ch, n);
		off += 30 + n.length + d.length;
	}
	const body = Buffer.concat(locals);
	const dir_ = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(dir_.length, 12);
	end.writeUInt32LE(body.length, 16);
	return Buffer.concat([body, dir_, end]);
}

const urlAsked = () => fetched().filter((a) => a.indexOf('https://') === 0).pop() || '';
const cachePath = () => path.join(dir, 'state', 'updatewebui.sh');
const ranWith = () => {
	const p = path.join(dir, 'argv');
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
	[['-b', 'topic', '--dry-run'], 'topic', 'a branch followed by options'],
];

group('the installer comes from the branch being installed');

// One at a time. Each case stands up its own camera and `dir` is what says
// which one, so starting them together would have every assertion read the
// last camera's log — which is exactly what happened when this was a forEach.
(function next(i) {
	if (i === BRANCHES.length) return refusals();
	const [args, want, what] = BRANCHES[i];
	camera(AS_INSTALLER);
	run(args, () => {
		check(what + ' -> ' + want, urlAsked() === RAW + want + '/sbin/updatewebui', urlAsked());
		next(i + 1);
	});
})(0);

// ------------------------------------------------------- what came back ----

function refusals() {
	group('what came back has to be the installer');

	camera(AS_INSTALLER);
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

		camera(null, true);
		fs.writeFileSync(cachePath(), installer(), { mode: 0o755 });
		run([], (r2) => {
			check('with a cached installer the run goes ahead', ranWith() !== null, 'it did not run');
			check('and says the cache is what ran', /using the installer kept in/.test(r2.stderr), r2.stderr.trim());
			restore();
		});
	});
}

// ------------------------------------------------------------ restore ------

function restore() {
	group('--restore keeps its promise to download nothing');

	// A camera that CAN reach GitHub: the point is that it is not asked to.
	camera(AS_INSTALLER, true);
	fs.writeFileSync(cachePath(), installer(), { mode: 0o755 });
	run(['--restore'], () => {
		check('a cached installer is used without fetching', fetched().length === 0, fetched().join(' '));
		check('and it runs', ranWith() !== null, 'it did not run');
		check('with the argument it was given', (ranWith() || []).join(' ') === '--restore', String(ranWith()));

		// With no cache there is nothing to restore from, so fetching is
		// better than refusing to undo an install that went wrong.
		camera(AS_INSTALLER);
		run(['-r'], () => {
			check('with no cache it falls back to fetching', fetched().length > 0, 'it did not fetch');
			archive();
		});
	});
}

// --------------------------------------------------- an archive of its own --

// The path that has to work with no route out at all: a zip already on the
// camera carries its own installer, so nothing needs to be reachable. This is
// how a camera that must not be given internet is updated, and it worked
// before the split because the installer was on the image.
function archive() {
	group('--url installs from the archive, and asks nothing else');

	camera(AS_INSTALLER);
	const zip = path.join(dir, 'tree.zip');
	fs.writeFileSync(zip, zipWith([['tree/sbin/updatewebui', installer()]]));
	run(['--url=file://' + zip], () => {
		check('the installer comes out of the archive', ranWith() !== null, 'it did not run');
		check('and nothing was fetched', fetched().length === 0, fetched().join(' '));
		check('and no copy is kept, since it is not ours', !fs.existsSync(cachePath()));

		// An archive that carries no installer — an older tree, or a partial
		// one. A copy already here still knows how to unpack it.
		camera(AS_INSTALLER, true);
		const bare = path.join(dir, 'tree.zip');
		fs.writeFileSync(bare, zipWith([['tree/www/index.html', 'hello']]));
		fs.writeFileSync(cachePath(), installer(), { mode: 0o755 });
		run(['--url=file://' + bare], (r) => {
			check('an archive with no installer falls back to the kept copy', ranWith() !== null, 'it did not run');
			check('and says so', /carries no installer/.test(r.stderr), r.stderr.trim());

			// With neither, stopping is the only honest answer.
			camera(AS_INSTALLER);
			const bare2 = path.join(dir, 'tree.zip');
			fs.writeFileSync(bare2, zipWith([['tree/www/index.html', 'hello']]));
			run(['--url=file://' + bare2], (r2) => {
				check('with no copy either, the run stops', r2.code !== 0, 'exit ' + r2.code);
				check('naming what is missing', /carries no updatewebui/.test(r2.stderr), r2.stderr.trim());
				dryrun();
			});
		});
	});
}

// ------------------------------------------------------------- dry run -----

function dryrun() {
	group('--dry-run leaves the camera alone');

	camera(AS_INSTALLER);
	run(['--dry-run'], () => {
		check('the installer still runs', ranWith() !== null, 'it did not run');
		check('but nothing is written to the state directory', !fs.existsSync(cachePath()), 'a copy was kept');
		check('and the directory is not created either', !fs.existsSync(path.join(dir, 'state')));
		offlineHelp();
	});
}

// -------------------------------------------------------- help, offline ----

function offlineHelp() {
	group('--help answers even with nothing reachable');

	camera(null);
	run(['--help'], (r) => {
		check('it exits cleanly rather than reporting a network fault', r.code === 0, 'exit ' + r.code);
		check('and lists the options', /--branch=NAME/.test(r.stdout) && /--restore/.test(r.stdout), r.stdout.slice(0, 80));
		check('and says where the full help comes from', /downloads the installer/.test(r.stdout), r.stdout.slice(0, 80));
		passthrough();
	});
}

// -------------------------------------------------------- pass-through -----

function passthrough() {
	group('the arguments reach the installer');

	camera(AS_INSTALLER);
	const args = ['--branch=topic', '--no-backup'];
	run(args, () => {
		check('every argument, in order', (ranWith() || []).join(' ') === args.join(' '), JSON.stringify(ranWith()));
		payload();
	});
}

// ------------------------------------------------------------ payload ------

// What a camera actually receives, which is decided in tools/build-dist.sh.
//
// This is the silent one. If that step stopped renaming the stub onto the
// canonical name, the tarball would carry the 48 KB installer again and the
// boards this exists for would quietly go back over their partition; if it
// renamed and the stub were missing, cameras would ship no updatewebui at all
// and nothing would report either. The rename is EXECUTED here, lifted out of
// the script rather than re-typed, so a change to it is what this sees.
function payload() {
	group('the dist payload carries the stub under the canonical name');

	const build = fs.readFileSync(path.join(__dirname, '..', 'tools', 'build-dist.sh'), 'utf8');
	// Extracted as a whole function, so a change INSIDE it shows up as changed
	// behaviour here rather than as a pattern that stopped matching.
	const m = build.match(/^stub_over_installer\(\) \{[\s\S]*?^\}$/m);
	check('build-dist.sh still has the rename step', !!m, 'stub_over_installer is gone or was renamed');
	if (!m) return done();

	const stage = (files) => {
		const pkg = fs.mkdtempSync(path.join(os.tmpdir(), 'uwp-'));
		fs.mkdirSync(path.join(pkg, 'sbin'));
		for (const [n, body] of files) fs.writeFileSync(path.join(pkg, 'sbin', n), body);
		fs.writeFileSync(path.join(pkg, 'step.sh'), 'PKG=' + q(pkg) + NL + m[0] + NL + 'stub_over_installer' + NL);
		return pkg;
	};

	const pkg = stage([
		['updatewebui', 'the 48 KB installer'],
		['updatewebui-fetch', 'the stub'],
	]);

	execFile('/bin/sh', [path.join(pkg, 'step.sh')], () => {
		const at = (n) => {
			try {
				return fs.readFileSync(path.join(pkg, 'sbin', n), 'utf8');
			} catch (e) {
				return null;
			}
		};
		check('the stub ends up under the name people type', at('updatewebui') === 'the stub', String(at('updatewebui')));
		check('and the installer is not shipped beside it', at('updatewebui-fetch') === null, 'it is still there');

		// The shipped tree therefore has the stub sitting at sbin/updatewebui
		// and no -fetch. The installer's own walk must not skip that file, or
		// a camera installing such a tree would end up with no updatewebui —
		// so the skip is conditional on the -fetch file being present.
		const inst = fs.readFileSync(path.join(__dirname, '..', 'sbin', 'updatewebui'), 'utf8');
		const guard = /sbin\/\$scr_name\)[\s\S]*?if \[ -f "\$src\/sbin\/\$scr_name-fetch" \]; then[\s\S]*?continue/;
		check('and the installer only skips it when the stub is beside it', guard.test(inst), 'the skip is unconditional');

		// The stub going missing from the tree must STOP the build. Guarded,
		// it would leave the 48 KB installer at that path and ship a green
		// build, which is the silent regression this whole change removes.
		const bare = stage([['updatewebui', 'the 48 KB installer']]);
		execFile('/bin/sh', [path.join(bare, 'step.sh')], (err, out, errout) => {
			check('a payload with no stub fails the build', !!err, 'the build step succeeded');
			check('and says what would have shipped', /would ship the 48 KB installer/.test(errout), errout.trim());
			check(
				'leaving the installer where it was rather than half-renamed',
				fs.readFileSync(path.join(bare, 'sbin', 'updatewebui'), 'utf8') === 'the 48 KB installer',
				'the file was changed',
			);
			done();
		});
	});
}
