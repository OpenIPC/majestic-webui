// Which PTZ files an update installs on a camera with no motor driver: none.
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

done();
