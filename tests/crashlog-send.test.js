// Sending a crash to openipc.org, and the one decision that runs unattended.
//
// With the owner's yes, cron offers each crash to the sender every ten
// minutes, and the sender must tell "already sent" from "a crash since" by
// itself. Wrong, it fails silently either way: it sends the same crash every
// ten minutes for as long as the camera runs, or it never sends the next one
// and the page says it did. Neither shows on a bench, because it needs a
// camera that crashes twice. The form it builds fails as quietly: a value
// passed as -F that starts with @ uploads the file it names (#547).
//
// So the shipped script is run as it is, against a stub curl that records its
// arguments and answers as openipc.org does.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { check, group, done } = require('./assert');

const SENDER = path.join(__dirname, '..', 'sbin', 'crashlog-send');

const ANSWER = (code, title) => code < 300 ? JSON.stringify({
	duplicate: code === 200, id: 'c-abcd2345', kind: 'panic', self_inflicted: false, signature: '73e7c36bd808',
	title, url: 'https://openipc.org/crashes/#73e7c36bd808',
}, null, '  ') : JSON.stringify({ error: 'the daily limit is reached' }, null, '  ');

function camera() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crashlog-send-'));
	const bin = path.join(dir, 'bin');
	const crash = path.join(dir, 'crash');
	fs.mkdirSync(bin);
	fs.mkdirSync(crash);
	// curl: one argument a line, the answer into --output, the status out.
	fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\n' +
		'out=; prev=\n' +
		'for a in "$@"; do printf "%s\\n" "$a" >> "$CALLS"; [ "$prev" = --output ] && out=$a; prev=$a; done\n' +
		'echo "--" >> "$CALLS"\n' +
		'printf "%s" "$ANSWER" > "$out"\n' +
		'printf "%s" "${CODE:-201}"\n', { mode: 0o755 });
	fs.writeFileSync(path.join(bin, 'ipcinfo'),
		'#!/bin/sh\ncase "$1" in -v) echo hisilicon ;; --chip-name) echo gk7205v300 ;; esac\n', { mode: 0o755 });
	fs.writeFileSync(path.join(bin, 'fw_printenv'), '#!/bin/sh\necho "${SENSOR:-imx335}"\n', { mode: 0o755 });
	fs.writeFileSync(path.join(bin, 'ip'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
	return { dir, bin, crash, calls: path.join(dir, 'calls'), conf: path.join(dir, 'crashlog.conf') };
}

function send(cam, args, env) {
	const e = Object.assign({}, process.env, {
		PATH: cam.bin + ':' + process.env.PATH, CALLS: cam.calls,
		CRASHLOG_DIR: cam.crash, CRASHLOG_CONF: cam.conf, CRASHLOG_URL: 'https://openipc.test/api/v1/crashes',
		ANSWER: ANSWER(Number((env && env.CODE) || 201), (env && env.TITLE) || 'NULL pointer dereference in RGN_PutRegion'),
	}, env || {});
	let out = '';
	let rc = 0;
	try {
		out = execFileSync('sh', [SENDER].concat(args || []), { env: e, encoding: 'utf8' });
	} catch (err) {
		out = String(err.stdout || '');
		rc = err.status;
	}
	return { out: out.trim(), rc };
}

const calls = (cam) => fs.existsSync(cam.calls) ? fs.readFileSync(cam.calls, 'utf8').split('--\n').filter(Boolean) : [];
const sent = (cam) => fs.existsSync(path.join(cam.crash, 'sent')) ? fs.readFileSync(path.join(cam.crash, 'sent'), 'utf8') : '';

group('nothing goes without the owner');
{
	const cam = camera();
	fs.writeFileSync(path.join(cam.crash, 'crash.tar.gz'), 'first crash');
	let r = send(cam, ['--auto']);
	check('--auto without the owner\'s yes sends nothing, quietly', r.rc === 0 && r.out === '' && calls(cam).length === 0);
	fs.writeFileSync(cam.conf, 'crashlog_auto=false\n');
	r = send(cam, ['--auto']);
	check('nor with the switch off', r.rc === 0 && calls(cam).length === 0);
}

group('pressing Send');
{
	const cam = camera();
	fs.writeFileSync(path.join(cam.crash, 'crash.tar.gz'), 'first crash');
	const r = send(cam, [], { SENSOR: '@/etc/shadow' });
	const args = (calls(cam)[0] || '').split('\n');
	check('it says where the crash was filed', r.rc === 0 && r.out === 'Sent to openipc.org: NULL pointer dereference in RGN_PutRegion');
	check('the log goes as the file part bundle',
		args.includes('-F') && args.includes('bundle=@' + path.join(cam.crash, 'crash.tar.gz') + ';type=application/gzip'));
	check('a value starting with @ goes as text, never as a file to read',
		args[args.indexOf('sensor=@/etc/shadow') - 1] === '--form-string');
	check('the chip goes too', args.includes('soc=gk7205v300'));
	check('a redirected POST stays a POST', args.includes('--post301') && args.includes('--location'));
	const note = sent(cam);
	check('the answer is kept for the page',
		/^url=https:\/\/openipc.org\/crashes\/#73e7c36bd808$/m.test(note) && /^signature=73e7c36bd808$/m.test(note) &&
		/^bundle=[0-9a-f]{32}$/m.test(note));

	fs.writeFileSync(cam.conf, 'crashlog_auto=true\n');
	send(cam, ['--auto']);
	check('cron does not send the same crash again', calls(cam).length === 1);

	// The firmware keeps only the latest crash: the file is another crash now.
	fs.writeFileSync(path.join(cam.crash, 'crash.tar.gz'), 'second crash');
	const r2 = send(cam, ['--auto']);
	check('cron sends a crash that came since', r2.rc === 0 && calls(cam).length === 2);
	send(cam, ['--auto']);
	check('and that one once', calls(cam).length === 2);
}

group('when openipc.org says no');
{
	const cam = camera();
	fs.writeFileSync(path.join(cam.crash, 'crash.tar.gz'), 'a crash');
	const r = send(cam, [], { CODE: '429' });
	check('the refusal is said, with the site\'s reason',
		r.rc === 1 && r.out === 'openipc.org did not take the crash (HTTP 429): the daily limit is reached');
	check('and nothing is marked sent, so cron tries again', sent(cam) === '');
	const again = send(cam, [], { CODE: '200', TITLE: 'a title with "quotes"' });
	check('a crash the site already had says so', again.rc === 0 && again.out === 'openipc.org already had this crash: a title with "quotes"');
}

group('a boot loop with no kernel log');
{
	const cam = camera();
	fs.writeFileSync(path.join(cam.crash, 'failsafe'), 'reason=bootlimit\nutc=0\n');
	const r = send(cam);
	const args = (calls(cam)[0] || '').split('\n');
	const part = args.find((a) => a.startsWith('bundle=@')) || '';
	check('the failsafe note is packed and sent', r.rc === 0 && /failsafe\.tar\.gz;type=application\/gzip$/.test(part));
}
{
	const cam = camera();
	const r = send(cam);
	check('with nothing on record, Send says so', r.rc === 1 && r.out === 'There is no crash on record to send.' && calls(cam).length === 0);
}

done();
