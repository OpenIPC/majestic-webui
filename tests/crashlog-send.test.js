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

const ANSWER = (code, title, compact) => {
	const body = code < 300 ? {
		duplicate: code === 200, id: 'c-abcd2345', kind: 'panic', self_inflicted: false, signature: '0123456789ab',
		title, url: 'https://openipc.org/crashes/#0123456789ab',
	} : { error: 'the daily limit is reached' };
	// Go's encoder writes < > & as \u003c \u003e \u0026; so does this one.
	return JSON.stringify(body, null, compact ? undefined : '  ')
		.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
};

// A crash log as the firmware packs it: a gzipped tar of pstore records, and
// the firmware's meta.json when it is given one.
function record(cam, text, meta, where) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crashlog-rec-'));
	fs.writeFileSync(path.join(dir, 'dmesg-ramoops-0'), text);
	if (meta) fs.writeFileSync(path.join(dir, 'meta.json'), meta);
	const out = where || path.join(cam.crash, 'crash.tar.gz');
	fs.mkdirSync(path.dirname(out), { recursive: true });
	execFileSync('sh', ['-c', 'tar -cf - -C "$1" . | gzip > "$2"', 'sh', dir, out]);
}
const older = (cam, name, text, meta) => record(cam, text, meta, path.join(cam.crash, 'older', name + '.tar.gz'));
const metas = (cam) => fs.existsSync(cam.calls + '.meta') ? fs.readFileSync(cam.calls + '.meta', 'utf8').split('\n').filter(Boolean) : [];

function camera() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crashlog-send-'));
	const bin = path.join(dir, 'bin');
	const crash = path.join(dir, 'crash');
	fs.mkdirSync(bin);
	fs.mkdirSync(crash);
	// curl: one argument a line, the answer into --output, the status out.
	fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\n' +
		'out=; prev=\n' +
		'for a in "$@"; do printf "%s\\n" "$a" >> "$CALLS"; [ "$prev" = --output ] && out=$a; prev=$a\n' +
		'  case "$a" in bundle=@*) f=${a#bundle=@}; f=${f%%;*}; gzip -dc "$f" | tar -tf - | sed "s#^\\./##" | grep -v "^$" | sort | tr "\\n" " " >> "$CALLS.list"; echo >> "$CALLS.list" ;;\n' +
		'  "meta=<"*) cat "${a#meta=<}" >> "$CALLS.meta"; echo >> "$CALLS.meta" ;; esac\n' +
		'done\n' +
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
		CRASHLOG_LOCK: path.join(cam.dir, 'lock'),
		ANSWER: ANSWER(Number((env && env.CODE) || 201), (env && env.TITLE) || 'NULL pointer dereference in example_handler', env && env.COMPACT),
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
const lists = (cam) => fs.existsSync(cam.calls + '.list') ? fs.readFileSync(cam.calls + '.list', 'utf8').split('\n').map((l) => l.trim()) : [];
const sent = (cam) => fs.existsSync(path.join(cam.crash, 'sent')) ? fs.readFileSync(path.join(cam.crash, 'sent'), 'utf8') : '';

group('nothing goes without the owner');
{
	const cam = camera();
	record(cam, 'first crash');
	let r = send(cam, ['--auto']);
	check('--auto without the owner\'s yes sends nothing, quietly', r.rc === 0 && r.out === '' && calls(cam).length === 0);
	fs.writeFileSync(cam.conf, 'crashlog_auto=false\n');
	r = send(cam, ['--auto']);
	check('nor with the switch off', r.rc === 0 && calls(cam).length === 0);
}

group('pressing Send');
{
	const cam = camera();
	record(cam, 'first crash');
	const r = send(cam, [], { SENSOR: '@/etc/shadow' });
	const args = (calls(cam)[0] || '').split('\n');
	check('it says where the crash was filed', r.rc === 0 && r.out === 'Sent to openipc.org: NULL pointer dereference in example_handler');
	check('the log goes as the file part bundle', args.includes('-F') && /;type=application\/gzip$/.test(args.find((a) => a.startsWith('bundle=@')) || ''));
	check('and holds the kernel\'s records', lists(cam)[0] === 'dmesg-ramoops-0');
	check('with no meta.json, no meta goes', metas(cam).length === 0);
	check('a value starting with @ goes as text, never as a file to read',
		args[args.indexOf('sensor=@/etc/shadow') - 1] === '--form-string');
	check('the chip goes too', args.includes('soc=gk7205v300'));
	check('a redirected POST stays a POST', args.includes('--post301') && args.includes('--location'));
	const note = sent(cam);
	check('the answer is kept for the page',
		/^url=https:\/\/openipc.org\/crashes\/#0123456789ab$/m.test(note) && /^signature=0123456789ab$/m.test(note) &&
		/^bundle=[0-9a-f]{32}$/m.test(note));

	fs.writeFileSync(cam.conf, 'crashlog_auto=true\n');
	send(cam, ['--auto']);
	check('cron does not send the same crash again', calls(cam).length === 1);

	// The firmware keeps only the latest crash: the file is another crash now.
	record(cam, 'second crash');
	const r2 = send(cam, ['--auto']);
	check('cron sends a crash that came since', r2.rc === 0 && calls(cam).length === 2);
	send(cam, ['--auto']);
	check('and that one once', calls(cam).length === 2);
}

group('when openipc.org says no');
{
	const cam = camera();
	record(cam, 'a crash');
	const r = send(cam, [], { CODE: '429' });
	check('the refusal is said, with the site\'s reason',
		r.rc === 1 && r.out === 'openipc.org did not take the crash (HTTP 429): the daily limit is reached');
	check('and nothing is marked sent, so cron tries again', sent(cam) === '');
	const again = send(cam, [], { CODE: '200', TITLE: 'a title with "quotes" <and> & more' });
	check('a crash the site already had says so, its title read back whole',
		again.rc === 0 && again.out === 'openipc.org already had this crash: a title with "quotes" <and> & more');
}

group('reading the answer');
{
	const cam = camera();
	record(cam, 'a crash');
	const r = send(cam, [], { COMPACT: '1' });
	check('an answer on one line is read as well as one key a line',
		r.rc === 0 && /^signature=0123456789ab$/m.test(sent(cam)));
}

group('one sender at a time');
{
	const cam = camera();
	record(cam, 'a crash');
	fs.writeFileSync(cam.conf, 'crashlog_auto=true\n');
	// Another sender holds the lock for the length of this run.
	const holder = require('child_process').spawn('sh', ['-c', 'exec 9>"$1"; flock 9; sleep 3', 'sh', path.join(cam.dir, 'lock')]);
	execFileSync('sh', ['-c', 'sleep 0.5']);
	const quiet = send(cam, ['--auto']);
	const pressed = send(cam);
	holder.kill();
	check('cron steps aside, quietly', quiet.rc === 0 && quiet.out === '' && calls(cam).length === 0);
	check('the button says the crash is going already', pressed.rc === 1 && /being sent already/.test(pressed.out));
}
{
	// A build without flock: the lock is a directory naming its holder.
	const cam = camera();
	record(cam, 'a crash');
	const noflock = { CRASHLOG_FLOCK: 'no-such-flock' };
	const lockdir = path.join(cam.dir, 'lock.d');
	fs.mkdirSync(lockdir);
	fs.writeFileSync(path.join(lockdir, 'pid'), String(process.pid)); // alive: this test
	const pressed = send(cam, [], noflock);
	check('without flock, a live holder still keeps a second sender out', pressed.rc === 1 && calls(cam).length === 0);
	fs.writeFileSync(path.join(lockdir, 'pid'), '999999'); // a run that was killed
	const after = send(cam, [], noflock);
	check('and a dead one does not lock sending out for good', after.rc === 0 && calls(cam).length === 1);
	check('the lock goes with the run', !fs.existsSync(lockdir));
}

group('a note that cannot be kept');
{
	const cam = camera();
	record(cam, 'a crash');
	fs.mkdirSync(path.join(cam.crash, 'sent.new'));
	const r = send(cam);
	check('is not reported as sent', r.rc === 1 && /could not note that it was sent/.test(r.out) && sent(cam) === '');
}

group('a boot loop with no kernel log');
{
	const cam = camera();
	fs.writeFileSync(path.join(cam.crash, 'failsafe'), 'reason=bootlimit\nutc=0\n');
	const r = send(cam);
	check('the failsafe note is packed and sent', r.rc === 0 && lists(cam)[0] === 'failsafe');
}
{
	const cam = camera();
	record(cam, 'a panic, then a boot loop');
	fs.writeFileSync(path.join(cam.crash, 'failsafe'), 'reason=bootlimit\nutc=0\n');
	const r = send(cam);
	check('with a kernel log too, both go in one archive', r.rc === 0 && lists(cam)[0] === 'dmesg-ramoops-0 failsafe');
}

group('earlier crashes the firmware kept');
{
	const cam = camera();
	record(cam, 'the latest', '{"soc":"latest"}');
	older(cam, '20260101000000', 'the first', '{"soc":"first"}');
	older(cam, '20260102000000', 'the second');
	const r = send(cam);
	check('Send sends the latest and every earlier one', r.rc === 0 && calls(cam).length === 3 &&
		/^Sent to openipc.org: .*Earlier crashes sent: 2\.$/.test(r.out));
	check('the firmware\'s meta.json goes as the meta field, read from the file',
		metas(cam).includes('{"soc":"latest"}') && metas(cam).includes('{"soc":"first"}') && metas(cam).length === 2);
	check('each earlier crash is noted beside it',
		/^signature=0123456789ab$/m.test(fs.readFileSync(path.join(cam.crash, 'older', '20260101000000.tar.gz.sent'), 'utf8')) &&
		fs.existsSync(path.join(cam.crash, 'older', '20260102000000.tar.gz.sent')));
	fs.writeFileSync(cam.conf, 'crashlog_auto=true\n');
	send(cam, ['--auto']);
	check('and none of them goes twice', calls(cam).length === 3);

	// The firmware moved the latest under older/ when another crash came: the
	// latest is the new one, and the moved one has no note of its own yet.
	fs.renameSync(path.join(cam.crash, 'crash.tar.gz'), path.join(cam.crash, 'older', '20260103000000.tar.gz'));
	fs.unlinkSync(path.join(cam.crash, 'older', '20260101000000.tar.gz')); // dropped past the cap
	record(cam, 'the newest');
	send(cam, ['--auto']);
	check('cron sends the new latest and the moved one', calls(cam).length === 5);
	check('a note whose crash the firmware dropped goes with it', !fs.existsSync(path.join(cam.crash, 'older', '20260101000000.tar.gz.sent')));
}
{
	const cam = camera();
	fs.writeFileSync(cam.conf, 'crashlog_auto=true\n');
	older(cam, '20260101000000', 'only an earlier one');
	const r = send(cam, ['--auto']);
	check('with only earlier crashes on record, cron sends them', r.rc === 0 && calls(cam).length === 1);
}
{
	const cam = camera();
	record(cam, 'the latest');
	older(cam, '20260101000000', 'an earlier one');
	const r = send(cam, [], { CODE: '429' });
	check('one that is refused is said, and the rest were tried', r.rc === 1 && calls(cam).length === 2 &&
		/Earlier crashes not sent: 1 \(openipc.org did not take the crash \(HTTP 429\): the daily limit is reached\)\.$/.test(r.out));
	check('and nothing refused is noted as sent',
		sent(cam) === '' && !fs.existsSync(path.join(cam.crash, 'older', '20260101000000.tar.gz.sent')));
}
{
	const cam = camera();
	const r = send(cam);
	check('with nothing on record, Send says so', r.rc === 1 && r.out === 'There is no crash on record to send.' && calls(cam).length === 0);
}

group('what the review found');
{
	const cam = camera();
	fs.writeFileSync(path.join(cam.crash, 'crash.tar.gz'), 'not an archive');
	older(cam, '20260101000000', 'an earlier one');
	const r = send(cam);
	check('a latest crash that cannot be read does not hold back the earlier ones',
		r.rc === 1 && calls(cam).length === 1 && /^The latest crash log could not be read\. Earlier crashes sent: 1\.$/.test(r.out));
}
{
	const cam = camera();
	record(cam, 'sent by cron meanwhile');
	send(cam);
	const r = send(cam);
	check('a Send for crashes already sent says so, not nothing', r.rc === 0 && r.out === 'These crashes were already sent to openipc.org.' && calls(cam).length === 1);
}
{
	// The camera before it was refused, so a stale reason was lying about;
	// this one is taken, and its trouble is its note.
	const cam = camera();
	record(cam, 'refused first');
	send(cam, [], { CODE: '429' });
	older(cam, '20260102000000', 'taken, but its note cannot be written');
	fs.mkdirSync(path.join(cam.crash, 'older', '20260102000000.tar.gz.sent.new'));
	const r = send(cam);
	check('a note that cannot be written is reported as that, not as a stale refusal',
		r.rc === 1 && /Earlier crashes not sent: 1 \(openipc.org took it, but this camera could not note that it was sent\)\.$/.test(r.out) &&
		!/HTTP 429/.test(r.out));
}

group("majestic's own crashes");
{
	// A dump as majestic writes it: a header of text, then memory. The sender
	// reads none of it; it only has to be the file that goes.
	const dump = (cam, name, n) => fs.writeFileSync(path.join(cam.crash, name),
		Buffer.concat([Buffer.from('MJCD\x01\x00\x01\x00HDR signal=11\n'), Buffer.alloc(64, n)]));
	const osRelease = (cam) => {
		const f = path.join(cam.dir, 'os-release');
		fs.writeFileSync(f, 'OPENIPC_VERSION=2.6.10.05\nBUILD_OPTION=lite\nGITHUB_VERSION="master+988f385, 2026-10-05"\n' +
			'BUILD_ID=nightly-20261005-988f385\nBUILD_PLATFORM=gk7205v300_lite\n');
		return f;
	};
	const mjSent = (cam) => fs.existsSync(path.join(cam.crash, 'majestic.sent')) ?
		fs.readFileSync(path.join(cam.crash, 'majestic.sent'), 'utf8').split('\n').filter(Boolean) : [];

	const cam = camera();
	dump(cam, 'majestic.dump', 1);
	dump(cam, 'majestic.dump.1', 2);
	const env = { CRASHLOG_OS_RELEASE: osRelease(cam), TITLE: 'SIGSEGV (NULL pointer)' };
	let r = send(cam, [], env);
	check('Send sends both dumps, each a bundle of its own', r.rc === 0 && calls(cam).length === 2 &&
		lists(cam)[0] === 'majestic.dump meta.json' && lists(cam)[1] === 'majestic.dump meta.json');
	check('and says so', r.out === "majestic's crashes sent to openipc.org: 2.");
	const meta = JSON.parse(metas(cam)[0] || '{}');
	check('with the build openipc.org reads the libraries from', meta.firmware && meta.firmware.build_id === 'nightly-20261005-988f385' &&
		meta.firmware.platform === 'gk7205v300_lite' && meta.soc === 'gk7205v300');
	check('each noted by its checksum', mjSent(cam).length === 2 && mjSent(cam).every((l) => /^[0-9a-f]{32} /.test(l)));

	r = send(cam, [], env);
	check('sent once: Send again sends nothing', calls(cam).length === 2 && r.out === 'These crashes were already sent to openipc.org.');

	// majestic crashes again: it renames the dump to .1 and writes a new one.
	fs.renameSync(path.join(cam.crash, 'majestic.dump'), path.join(cam.crash, 'majestic.dump.1'));
	dump(cam, 'majestic.dump', 3);
	r = send(cam, [], env);
	check('after the next crash, only the new dump goes', calls(cam).length === 3 && r.out === "majestic's crash sent to openipc.org: SIGSEGV (NULL pointer).");
	check('and the note of the one majestic dropped goes', mjSent(cam).length === 2);
}
{
	// The owner's yes to sending on its own covers the kernel's logs; a dump,
	// which holds majestic's memory, needs its own.
	const cam = camera();
	fs.writeFileSync(path.join(cam.crash, 'majestic.dump'), Buffer.from('MJCD\x01\x00\x01\x00'));
	fs.writeFileSync(cam.conf, 'crashlog_auto=true\n');
	let r = send(cam, ['--auto']);
	check('--auto does not send a dump on the yes for logs alone', r.rc === 0 && calls(cam).length === 0);
	fs.writeFileSync(cam.conf, 'crashlog_auto=true\ncrashlog_majestic=true\n');
	r = send(cam, ['--auto']);
	check('with the second yes it does', r.rc === 0 && calls(cam).length === 1);
	r = send(cam, ['--auto']);
	check('once', calls(cam).length === 1);
}

done();
