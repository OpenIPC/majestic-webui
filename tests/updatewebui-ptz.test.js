// Which PTZ files an update installs on a camera with no motor driver: none,
// and what the autofocus schedule left there goes with them.
//
// The firmware leaves them out of such an image and sbin/updatewebui has to
// leave out the same ones. A file missing from its list fails silently -- the
// camera works, with that file and the flash it takes on board -- so the list
// is checked against what the tree itself says belongs to PTZ.
//
// build_plan only plans, so the shipped function runs over this tree, under
// busybox sh, against an overlay in a scratch directory.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { check, group, done } = require('./assert');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const scratch = [];
process.on('exit', () => scratch.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function shellFn(src, name) {
	const start = src.indexOf('\n' + name + '() {');
	const end = src.indexOf('\n}\n', start);
	if (start < 0 || end < 0) throw new Error(name + ' was not found in sbin/updatewebui; this test is testing nothing');
	return src.slice(start + 1, end + 3);
}

// Scripts p/motor.cgi loads, and the CGIs that include the PTZ helper, are PTZ
// wherever they are added next. ptz-presets.js is the one the firmware keeps in
// every image, so it is not among the files left out.
const KEPT = ['/var/www/a/ptz-presets.js'];
const scripts = (read('www/cgi-bin/p/motor.cgi').match(/<script src="\/a\/[^"]+"/g) || [])
	.map((s) => '/var/www' + s.slice('<script src="'.length, -1)).filter((f) => !KEPT.includes(f));
const cgis = fs.readdirSync(path.join(ROOT, 'www/cgi-bin/j'))
	.filter((f) => read('www/cgi-bin/j/' + f).includes('p/ptz_common.sh'))
	.map((f) => '/var/www/cgi-bin/j/' + f);
const PTZ = scripts.concat(cgis, '/var/www/cgi-bin/p/ptz_common.sh').sort();

// An overlay that already holds every one of them, as an earlier update that
// did not leave them out would have made it.
function plan(ptz, upperFiles) {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uwp-'));
	scratch.push(d);
	fs.mkdirSync(path.join(d, 'tmp'));
	fs.mkdirSync(path.join(d, 'upper'));
	for (const f of upperFiles) {
		fs.mkdirSync(path.dirname(path.join(d, 'upper', f)), { recursive: true });
		fs.writeFileSync(path.join(d, 'upper', f), 'installed earlier\n');
	}
	const src = read('sbin/updatewebui');
	const r = spawnSync('busybox', ['sh', '-c', shellFn(src, 'plugin_page') + shellFn(src, 'build_plan') + 'build_plan'], {
		env: {
			PATH: process.env.PATH, src: ROOT, upper: path.join(d, 'upper'), lower: '', tmp: path.join(d, 'tmp'),
			MANIFEST: path.join(d, 'manifest'), PAYLOAD: 'www:/var/www', scr_name: 'updatewebui',
			variant: '', sms: '0', fpv: '0', ptz: ptz, counting: '0',
		},
		encoding: 'utf8',
	});
	if (r.error) throw r.error;
	const list = (f) => fs.readFileSync(path.join(d, 'tmp', f), 'utf8').split('\n').filter(Boolean)
		.map((l) => l.replace(path.join(d, 'upper'), ''));
	return { status: r.status, err: r.err, keep: list('keep'), prune: list('prune'), skipped: list('skipped'),
		write: list('write').map((l) => l.split(' ')) };
}

group('the tree says which files are PTZ');
check('scripts of the pad', scripts.length >= 10, scripts.join(' '));
check('and the endpoints', cgis.length >= 5, cgis.join(' '));
check('all of them exist', PTZ.every((f) => fs.existsSync(path.join(ROOT, f.replace('/var/www', 'www')))), PTZ.join(' '));

group('a camera with no motor driver');
{
	const p = plan('0', PTZ);
	check('the plan is made (otherwise this tests nothing)', p.status === 0 && p.keep.length > 50);
	for (const f of PTZ) {
		check(f + ' is skipped', p.skipped.includes(f) && !p.keep.includes(f));
		check('...and an earlier copy goes', p.prune.includes(f));
	}
	const motor = p.write.find((w) => w[2] === '/var/www/cgi-bin/p/motor.cgi');
	check('p/motor.cgi is installed, empty', !!motor && motor[1].endsWith('motor.cgi.stub'));
	check('what the firmware keeps stays', KEPT.every((f) => p.keep.includes(f)));
	check('nothing but these is skipped for it', p.skipped.length === PTZ.length + plan('1', []).skipped.length,
		p.skipped.length + ' ' + PTZ.length);
}

group('a camera with one');
{
	const p = plan('1', []);
	for (const f of PTZ) check(f + ' is installed', p.write.some((w) => w[2] === f) && !p.skipped.includes(f));
	check('and the whole p/motor.cgi', p.write.some((w) => w[2] === '/var/www/cgi-bin/p/motor.cgi' && !w[1].endsWith('.stub')));
}

// What the autofocus triggers left behind: the schedule j/af_triggers.cgi wrote
// into root's crontab, and the watcher it wrote for those lines to run. The
// endpoint's own sync_cron makes them, so a tag changed on one side and not the
// other fails here rather than leaving the lines on every camera (#751).
function triggers(ptz, cron) {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uwa-'));
	scratch.push(d);
	fs.mkdirSync(path.join(d, 'upper/usr/bin'), { recursive: true });
	const crontab = path.join(d, 'root');
	if (cron != null) fs.writeFileSync(crontab, cron);
	const env = {
		PATH: process.env.PATH, CRONTAB: crontab, CRON_FILE: crontab,
		CHECK_BIN: path.join(d, 'upper/usr/bin/af-trigger-check'), upper: path.join(d, 'upper'),
		scr_name: 'updatewebui', ptz: ptz,
	};
	const cgi = read('www/cgi-bin/j/af_triggers.cgi');
	return {
		// As the Settings page leaves things after "Refocus on IR-cut" stays on
		// and a daily refocus at 03:00 is saved.
		schedule() {
			// install_watcher writes a script through a heredoc, functions and
			// all, so the first closing brace after it is not its own. Both
			// are taken in one piece, up to the end of sync_cron below it.
			const from = cgi.indexOf('\ninstall_watcher() {');
			const to = cgi.indexOf('\n}\n', cgi.indexOf('\nsync_cron() {'));
			if (from < 0 || to < from) throw new Error('install_watcher then sync_cron was not found in j/af_triggers.cgi; this test is testing nothing');
			const r = spawnSync('busybox', ['sh', '-c', cgi.slice(from + 1, to + 3) +
				'ON_IRCUT=1 SCHEDULE=daily SCHEDULE_HOUR=3; sync_cron'], { env, encoding: 'utf8' });
			if (r.error) throw r.error;
			return r.status;
		},
		drop() {
			const src = read('sbin/updatewebui');
			const r = spawnSync('busybox', ['sh', '-c', shellFn(src, 'drop_af_triggers') + 'drop_af_triggers'],
				{ env, encoding: 'utf8' });
			if (r.error) throw r.error;
			return { status: r.status, out: r.stdout, err: r.stderr };
		},
		crontabPath: crontab, watcherPath: env.CHECK_BIN,
		cron: () => fs.existsSync(crontab) ? fs.readFileSync(crontab, 'utf8') : null,
		watcher: () => fs.existsSync(env.CHECK_BIN),
	};
}

const OTHER = '0 4 * * * /usr/sbin/sdscan\n* * * * * /usr/sbin/sms-forward\n';

group('the autofocus schedule on a camera with no motor driver');
{
	const t = triggers('0', OTHER);
	check('the endpoint writes its schedule (otherwise this tests nothing)',
		t.schedule() === 0 && /# af-triggers$/m.test(t.cron()) && t.watcher(), t.cron());
	const r = t.drop();
	check('it goes', r.status === 0 && !/af-trigger/.test(t.cron()), r.err + t.cron());
	check('every other line stays, as it was', t.cron() === OTHER, t.cron());
	check('so does the watcher it ran', !t.watcher());
	check('and the owner is told', /autofocus schedule/.test(r.out), r.out);
}
{
	const t = triggers('0', OTHER);
	const r = t.drop();
	check('a crontab without one is left alone, quietly',
		r.status === 0 && t.cron() === OTHER && r.out === '', r.out + r.err);
}
{
	const t = triggers('0', null);
	const r = t.drop();
	check('and a camera with no crontab gets none', r.status === 0 && t.cron() === null, r.err);
}

{
	// A crontab that is there but cannot be read says nothing about what is
	// in it, so the watcher its lines may run stays too. A directory is
	// unreadable as a crontab to anyone, root included.
	const t = triggers('0', null);
	fs.mkdirSync(t.crontabPath);
	t.schedule(); // writes the watcher; its crontab write fails
	const r = t.drop();
	check('a crontab that cannot be read fails the run', r.status !== 0 && /could not read/.test(r.err), r.err);
	check('...and keeps the watcher', t.watcher());
}
{
	const t = triggers('0', OTHER);
	t.schedule();
	fs.rmSync(t.watcherPath);
	fs.mkdirSync(path.join(t.watcherPath, 'x'), { recursive: true });
	const r = t.drop();
	check('a watcher that will not go is reported, not failed on',
		r.status === 0 && !/af-trigger/.test(t.cron()) && /delete it by hand/.test(r.err), r.err);
}

group('the autofocus schedule on a camera with one');
{
	const t = triggers('1', OTHER);
	t.schedule();
	const before = t.cron();
	const r = t.drop();
	check('stays', r.status === 0 && t.cron() === before && /# af-triggers$/m.test(before), r.err);
	check('and so does its watcher', t.watcher());
}

done();
