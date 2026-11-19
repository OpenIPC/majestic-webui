// What the root-only scripts refuse, and that the WebUI's own use still works.
//
// Every refusal here guards a value that reaches root as shell, a cron line or
// an interfaces stanza, and none of them fails loudly when it is missing: the
// save goes through, the page says so, and what was injected runs later, at
// the next ifup or the next minute. The scripts that ship are run under
// busybox `sh`, the shell they run under on a camera.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { check, group, done } = require('./assert');

const ROOT = path.join(__dirname, '..');
const SH = ['busybox', 'sh'];

function run(script, args, env, input) {
	const r = spawnSync(SH[0], [SH[1], path.join(ROOT, script), ...args], {
		env: { PATH: process.env.PATH, ...env },
		input: input || '',
		encoding: 'utf8',
	});
	return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

group('setnetwork refuses what would become a line of the stanza');
{
	const base = ['-i', 'eth0', '-m', 'static', '-a', '192.0.2.10', '-n', '255.255.255.0'];
	const refused = [
		['a nameserver with a pre-up after a newline', [...base, '-d', '1.1.1.1\n    pre-up touch /tmp/x']],
		['a nameserver with a command after it', [...base, '-d', '1.1.1.1;id']],
		['an address with a newline', ['-i', 'eth0', '-m', 'static', '-a', '192.0.2.10\n    up id', '-n', '255.255.255.0']],
		['a netmask that is not one', ['-i', 'eth0', '-m', 'static', '-a', '192.0.2.10', '-n', '255.255.255.0 x']],
		['a gateway past 255', [...base, '-g', '192.0.2.256']],
		['an interface that is a path', ['-i', '../../etc/init.d/S99x', '-m', 'dhcp']],
		['an interface with a second line', ['-i', 'eth0\nwlan0', '-m', 'dhcp']],
		['a hostname with a second line', ['-i', 'eth0', '-m', 'dhcp', '-h', 'cam\n192.0.2.66 example.org']],
		['a mode that is not one', ['-i', 'eth0', '-m', 'static\n    up id', '-a', '192.0.2.10', '-n', '255.255.255.0']],
	];
	for (const [name, args] of refused) {
		const r = run('sbin/setnetwork', args);
		check(name + ' is refused', r.status !== 0, r.out);
	}

	// The accepting side, without writing /etc: is_ipv4 as it ships.
	const src = fs.readFileSync(path.join(ROOT, 'sbin/setnetwork'), 'utf8');
	const start = src.indexOf('is_ipv4() {');
	check('is_ipv4 is in setnetwork (otherwise this tests nothing)', start >= 0);
	const fn = src.slice(start, src.indexOf('\n}\n', start) + 3);
	const ok = (v) => spawnSync(SH[0], [SH[1], '-c', fn + 'is_ipv4 "$1"', 'sh', v]).status === 0;
	for (const v of ['192.0.2.10', '255.255.255.0', '0.0.0.0', '198.51.100.1'])
		check(v + ' is an address', ok(v));
	for (const v of ['', '1.2.3', '1.2.3.4.5', '01.2.3.4x', '1.2.3.4 ', '1.2.3.4\n5.6.7.8'])
		check(JSON.stringify(v) + ' is not', !ok(v));
}

group('j/save.cgi writes on POST only, whole or not at all');
{
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'save-cgi-'));
	const f = path.join(d, 'target');
	fs.writeFileSync(f, 'original\n');
	fs.chmodSync(f, 0o750);

	let r = run('www/cgi-bin/j/save.cgi', [], { REQUEST_METHOD: 'GET', GET_path: f });
	check('a GET is refused', /"ok":false/.test(r.out), r.out);
	check('...and leaves the file as it was', fs.readFileSync(f, 'utf8') === 'original\n');

	r = run('www/cgi-bin/j/save.cgi', [], { REQUEST_METHOD: 'POST', GET_path: f }, 'new\n');
	check('a POST writes', /"ok":true/.test(r.out), r.out);
	check('...the body', fs.readFileSync(f, 'utf8') === 'new\n');
	check('...keeping the mode', (fs.statSync(f).mode & 0o777) === 0o750);
	check('...and leaving no temporary file', fs.readdirSync(d).length === 1, fs.readdirSync(d).join(' '));

	const link = path.join(d, 'link');
	fs.symlinkSync(f, link);
	r = run('www/cgi-bin/j/save.cgi', [], { REQUEST_METHOD: 'PUT', GET_path: link }, 'through\n');
	check('a symlink is written through', fs.readFileSync(f, 'utf8') === 'through\n', r.out);
	check('...and stays a symlink', fs.lstatSync(link).isSymbolicLink());

	// Two names for one file: both must read what was saved.
	const other = path.join(d, 'other-name');
	fs.linkSync(f, other);
	r = run('www/cgi-bin/j/save.cgi', [], { REQUEST_METHOD: 'POST', GET_path: f }, 'linked\n');
	check('a hard-linked file is saved', /"ok":true/.test(r.out), r.out);
	check('...and its other name reads the new text', fs.readFileSync(other, 'utf8') === 'linked\n');
	check('...through the same inode', fs.statSync(f).ino === fs.statSync(other).ino);
	fs.unlinkSync(other);

	const missing = path.join(d, 'no-such-dir', 'x');
	r = run('www/cgi-bin/j/save.cgi', [], { REQUEST_METHOD: 'POST', GET_path: missing }, 'x');
	check('a write that cannot happen says so', /"ok":false/.test(r.out), r.out);
	fs.rmSync(d, { recursive: true, force: true });
}

group('the WebUI updater installs nothing that came over plain http');
{
	// Both read --url: the fetcher, and the installer it hands over to. Each
	// refuses before it fetches, writes or runs anything.
	for (const script of ['sbin/updatewebui', 'sbin/updatewebui-fetch']) {
		const r = run(script, ['--url=http://192.0.2.1/tree.zip', '--dry-run']);
		check(script + ' refuses an http:// archive', r.status !== 0 && /http/.test(r.out), r.out);
	}
}

group('time.cgi takes every zone its own list offers, and no second line');
{
	// The checks as they ship, run over the whole bundled list: a zone the page
	// offers and the save refuses is a camera that cannot be set to it.
	const src = fs.readFileSync(path.join(ROOT, 'www/cgi-bin/time.cgi'), 'utf8');
	const nameCase = src.match(/case "\$POST_tz_name" in\n[\s\S]*?esac/);
	const dataCase = src.match(/case "\$POST_tz_data" in\n[\s\S]*?esac/);
	check('both checks are in time.cgi (otherwise this tests nothing)', !!nameCase && !!dataCase);
	const tz = fs.readFileSync(path.join(ROOT, 'www/a/timezone.js'), 'utf8');
	const zones = [...tz.matchAll(/n:\s*'([^']*)',\s*v:\s*'([^']*)'/g)].map((m) => [m[1], m[2]]);
	check('the bundled list was read (otherwise this tests nothing)', zones.length > 400, String(zones.length));
	// One shell for the whole list: prints each refused pair.
	const script = 'redirect_to() { echo "REFUSED $POST_tz_name|$POST_tz_data"; }\n' +
		'while IFS="|" read -r POST_tz_name POST_tz_data; do\n' + nameCase[0] + '\n' + dataCase[0] + '\ndone';
	const r = spawnSync(SH[0], [SH[1], '-c', script], { input: zones.map((z) => z.join('|')).join('\n') + '\n', encoding: 'utf8' });
	check('every bundled zone is accepted', r.stdout === '', r.stdout.split('\n').slice(0, 5).join(' / '));
	const one = (name, data) => spawnSync(SH[0], [SH[1], '-c', 'redirect_to() { echo REFUSED; }\n' + nameCase[0] + '\n' + dataCase[0]],
		{ env: { PATH: process.env.PATH, POST_tz_name: name, POST_tz_data: data }, encoding: 'utf8' }).stdout;
	check('a zone name with a second line is refused', /REFUSED/.test(one('Europe/Berlin\nserver 192.0.2.66', 'CET-1')));
	check('a TZ value with a second line is refused', /REFUSED/.test(one('Europe/Berlin', 'CET-1\nx')));
}

group('j/time.cgi changes the clock on POST only');
{
	const r = run('www/cgi-bin/j/time.cgi', [], { REQUEST_METHOD: 'GET', QUERY_STRING: 'set=0' });
	check('a GET is answered 405', /^HTTP\/1\.1 405/.test(r.out), r.out);
}

done();
