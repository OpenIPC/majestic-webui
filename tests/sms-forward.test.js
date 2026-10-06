// Forwarding SMS to Telegram: what reaches the chat, and how often.
//
// Two ways this fails silently. The camera decodes PDUs in awk, a second
// decoder beside www/a/sms-pdu.js, and a wrong septet or a misread surrogate
// pair is a plausible message in the chat. And "new" is the modem's read flag,
// so a run that lists messages and then loses them -- a refused send, a part
// that has not arrived yet -- takes them out of reach of every later run, and
// nothing anywhere says a message was dropped.
//
// So the shipped script runs against stand-ins for the modem and the sender,
// once under the system's sh and awk and once under busybox's when this
// machine has one, since busybox awk is what a camera runs. The decoded text
// is held to the browser decoder's answer for the same PDUs.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { check, group, done } = require('./assert');

const ROOT = path.join(__dirname, '..');
const S = require(path.join(ROOT, 'www', 'a', 'sms-pdu.js'));

// ---------------------------------------------------------------- PDUs ----

const hex = (bytes) => bytes.map((b) => (b < 16 ? '0' : '') + b.toString(16)).join('').toUpperCase();
const EXT = { '\f': 0x0A, '^': 0x14, '{': 0x28, '}': 0x29, '\\': 0x2F, '[': 0x3C, '~': 0x3D, ']': 0x3E, '|': 0x40, '€': 0x65 };
const septets = (text) => {
	const out = [];
	for (const ch of text) {
		const i = S.GSM7.indexOf(ch);
		if (i >= 0 && i !== 0x1B) out.push(i);
		else out.push(0x1B, EXT[ch]);
	}
	return out;
};

// An SMS-DELIVER, as the network hands one to the modem.
function deliver(o) {
	let oa;
	if (o.alpha) {
		const s = septets(o.from);
		const packed = S.pack7(s);
		oa = [Math.ceil(s.length * 7 / 4), 0xD0].concat(packed);
	} else {
		const d = o.from.replace('+', '');
		const p = d.length % 2 ? d + 'F' : d;
		oa = [d.length, o.from[0] === '+' ? 0x91 : 0x81];
		for (let i = 0; i < p.length; i += 2) oa.push(parseInt(p[i + 1] + p[i], 16));
	}
	const head = o.total ? [0x05, 0x00, 0x03, o.ref, o.total, o.seq] : [];
	let dcs, udl, ud;
	if (o.ucs2) {
		dcs = 0x08;
		ud = head.slice();
		for (let i = 0; i < o.text.length; i++) { const c = o.text.charCodeAt(i); ud.push(c >> 8, c & 0xFF); }
		udl = ud.length;
	} else {
		dcs = 0x00;
		const s = septets(o.text);
		ud = S.pack7(s, head);
		udl = Math.ceil(head.length * 8 / 7) + s.length;
	}
	if (o.dcs !== undefined) dcs = o.dcs;
	const fo = 0x04 | (o.total ? 0x40 : 0);
	// 2026-10-06 09:15:00, UTC+3, unless the case says otherwise.
	const scts = o.scts || [0x62, 0x01, 0x60, 0x90, 0x51, 0x00, 0x21];
	return '00' + hex([fo].concat(oa, [0x00, dcs], scts, [udl], ud));
}

// A transcript as modem-at prints it: what is unread in the first block,
// everything in the second.
function transcript(unread, all) {
	const lines = ['=> AT+CMGF=0', 'OK'];
	if (unread) {
		lines.push('=> AT+CPMS="ME"', '+CPMS: 1,180,1,180,1,180', 'OK', '=> AT+CMGL=0');
		for (const [i, p] of unread) lines.push('+CMGL: ' + i + ',0,,' + (p.length / 2 - 1), p);
		lines.push('OK');
	}
	lines.push('=> AT+CPMS="ME"', '+CPMS: 1,180,1,180,1,180', 'OK', '=> AT+CMGL=4');
	for (const [i, p] of all) lines.push('+CMGL: ' + i + ',1,,' + (p.length / 2 - 1), p);
	lines.push('OK');
	return lines.join('\n') + '\n';
}

// The T2 capture from tests/sms-pdu.test.js: a four-part UCS2 welcome
// message with emoji, the subscriber's number replaced.
const T2 = {
	13: '07919740430901F44409D074994B5E0700086201507132232134050003D504040442043D0430044F0020043F04350440043504300434044004350441043004460438044F00200053004D0053002E',
	14: '07919740430901F44409D074994B5E070008620150713223218A050003D5040127640020041F043E04370434044004300432043B044F0435043C002004410020043F043E0434043A043B044E04470435043D04380435043C0020043A00200054003200210020000A27050020041204300448002004420430044004380444003A002000220418043D044204350440043D0435044200200434043B044F0020043A0430043C',
	15: '07919740430901F44409D074994B5E070008620150713223218A050003D50402043504400022002E000AD83DDCDE0020041D043E043C043504400020003700390039003900300030003000310031003200320020043E044104420430043504420441044F00200432043004480438043C0020043D0430043204410435043304340430002E000A0412002004420430044004380444002004320445043E043404380442003A',
	16: '07919740430901F44409D074994B5E070008620150713223218A050003D50403000AD83CDF100020043F0430043A0435044200200413041100200434043B044F002004380441043F043E043B044C0437043E04320430043D0438044F002004320020043F04400438043B043E04360435043D04380438002000220423043C043D044B043900200434043E043C00220020002C000A27090020043104350441043F043B0430',
};
const t2All = Object.keys(T2).map((k) => [+k, T2[k]]);
const t2Text = S.joinParts(S.parseList(['=> AT+CPMS="ME"'].concat(...t2All.map(([i, p]) => ['+CMGL: ' + i + ',1,,0', p])))).find((m) => m.ref === 0xD5).text;

// ------------------------------------------------------------- harness ----

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-forward-'));
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);

// modem-at: the storages, then whichever listing was asked for.
fs.writeFileSync(path.join(bin, 'modem-at'), `#!/bin/sh
case "$*" in
*"AT+CPMS=?"*) echo '+CPMS: ("ME"),("ME"),("ME")'; echo OK ;;
*"AT+CMGL=0"*) echo called >> "$MJ_DIR/modem.log"; cat "$MJ_DIR/first"; [ -e "$MJ_DIR/fail" ] && exit 3 ;;
*) echo again >> "$MJ_DIR/modem.log"; cat "$MJ_DIR/again" ;;
esac
`, { mode: 0o755 });
// telegram --text: keep what it was given; refuse while $MJ_DIR/refuse exists.
fs.writeFileSync(path.join(bin, 'telegram'), `#!/bin/sh
[ "$1" = "--text" ] || exit 2
[ -e "$MJ_DIR/refuse" ] && { cat > /dev/null; exit 1; }
n=$(ls "$MJ_DIR/sent" | wc -l)
cat > "$MJ_DIR/sent/$((n + 1))"
`, { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'hostname'), '#!/bin/sh\necho lab-cam\n', { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'logger'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
// The wait for a missing part is the script's business; the test's is what
// it does after.
fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

const conf = path.join(tmp, 'sms.conf');
const queue = path.join(tmp, 'queue');
let src = fs.readFileSync(path.join(ROOT, 'sbin', 'sms-forward'), 'utf8');
for (const [from, to] of [
	['/etc/webui/sms.conf', conf],
	['LOCK=/var/lock/sms-forward', 'LOCK=' + path.join(tmp, 'lock')],
	['QUEUE=/tmp/sms-forward', 'QUEUE=' + queue],
]) {
	if (!src.includes(from)) throw new Error('sbin/sms-forward no longer contains ' + from);
	src = src.split(from).join(to);
}
const script = path.join(tmp, 'sms-forward');
fs.writeFileSync(script, src, { mode: 0o755 });

function fresh() {
	const d = fs.mkdtempSync(path.join(tmp, 'case-'));
	fs.mkdirSync(path.join(d, 'sent'));
	fs.rmSync(queue, { recursive: true, force: true });
	fs.writeFileSync(conf, "sms_forward='telegram'\n");
	return d;
}

function sentTexts(d) {
	return fs.readdirSync(path.join(d, 'sent')).sort((a, b) => a - b)
		.map((f) => fs.readFileSync(path.join(d, 'sent', f), 'utf8'));
}

function suite(name, shell, pathPrefix, host) {
	const env = Object.assign({}, process.env, { PATH: pathPrefix + bin + ':' + process.env.PATH });
	const run = (d, args, input) => spawnSync(shell[0], shell.slice(1).concat([script], args || []), {
		encoding: 'utf8', input: input || '', timeout: 30000,
		env: Object.assign({}, env, { MJ_DIR: d }),
	});

	group(name + ': a four-part UCS2 message, one part new');
	{
		const d = fresh();
		fs.writeFileSync(path.join(d, 'first'), transcript([[13, T2[13]]], t2All));
		const r = run(d);
		const sent = sentTexts(d);
		check('one message sent, not four', sent.length === 1, sent.length + ' ' + r.stderr);
		check('the same text the page shows', sent[0] && sent[0].endsWith('\n\n' + t2Text), sent[0]);
		check('says who sent it, to which camera, when',
			sent[0] && sent[0].startsWith('SMS from t2.ru to ' + host + ', 2026-10-05 17:23 +03:00\n\n'), sent[0] && sent[0].split('\n')[0]);
		check('nothing left waiting', !fs.existsSync(queue) || fs.readdirSync(queue).length === 0);
	}

	group(name + ': nothing unread');
	{
		const d = fresh();
		fs.writeFileSync(path.join(d, 'first'), transcript([], t2All));
		run(d);
		check('nothing sent', sentTexts(d).length === 0);
	}

	group(name + ': GSM 7-bit, the extension table, a named sender');
	{
		const d = fresh();
		const p = deliver({ from: 'Bank', alpha: true, text: 'Balance: 5€ [ok] {x} ~|^\\' });
		fs.writeFileSync(path.join(d, 'first'), transcript([[0, p]], [[0, p]]));
		run(d);
		const sent = sentTexts(d);
		check('decoded', sent[0] && sent[0].endsWith('\n\nBalance: 5€ [ok] {x} ~|^\\'), sent[0]);
		check('sender', sent[0] && sent[0].startsWith('SMS from Bank to ' + host + ', 2026-10-06 09:15 +03:00'), sent[0]);
		check('agrees with the page', sent[0] && sent[0].endsWith(S.decodePdu(p).text));
	}

	group(name + ': a part that arrives during the wait');
	{
		const d = fresh();
		const a = deliver({ from: '+15550100', text: 'x'.repeat(153), ref: 7, total: 2, seq: 1 });
		const b = deliver({ from: '+15550100', text: 'tail', ref: 7, total: 2, seq: 2 });
		fs.writeFileSync(path.join(d, 'first'), transcript([[0, a]], [[0, a]]));
		fs.writeFileSync(path.join(d, 'again'), transcript(null, [[0, a], [1, b]]));
		run(d);
		const sent = sentTexts(d);
		check('waited, then looked again', fs.readFileSync(path.join(d, 'modem.log'), 'utf8').includes('again'));
		check('sent once, whole', sent.length === 1 && sent[0].endsWith('\n\n' + 'x'.repeat(153) + 'tail'), sent.length + ' ' + (sent[0] || '').slice(-20));
		check('no gap note', sent[0] && !sent[0].includes('did not arrive'));
	}

	group(name + ': a part that never arrives');
	{
		const d = fresh();
		const a = deliver({ from: '+15550100', text: 'first half', ref: 9, total: 2, seq: 1, ucs2: true });
		fs.writeFileSync(path.join(d, 'first'), transcript([[0, a]], [[0, a]]));
		fs.writeFileSync(path.join(d, 'again'), transcript(null, [[0, a]]));
		run(d);
		const sent = sentTexts(d);
		check('sent anyway, not held forever', sent.length === 1, sent.length);
		check('the gap is in the text', sent[0] && sent[0].includes('first half [...]'), sent[0]);
		check('and said', sent[0] && sent[0].includes('(1 of 2 parts did not arrive)'));
	}

	group(name + ': Telegram refuses, then accepts');
	{
		const d = fresh();
		const p = deliver({ from: '+15550100', text: 'top up now' });
		fs.writeFileSync(path.join(d, 'first'), transcript([[0, p]], [[0, p]]));
		fs.writeFileSync(path.join(d, 'refuse'), '');
		run(d);
		check('not sent', sentTexts(d).length === 0);
		check('kept for the next run', fs.readdirSync(queue).length === 1);
		// The modem now says it is read: the next listing has nothing unread.
		fs.writeFileSync(path.join(d, 'first'), transcript([], [[0, p]]));
		fs.unlinkSync(path.join(d, 'refuse'));
		run(d);
		const sent = sentTexts(d);
		check('sent on the next run', sent.length === 1 && sent[0].endsWith('\n\ntop up now'), sent.length);
		check('and only once', fs.readdirSync(queue).length === 0);
	}

	group(name + ': --collect, as the SMS page runs it');
	{
		const d = fresh();
		const p = deliver({ from: '+15550100', text: 'seen on the page first' });
		fs.writeFileSync(path.join(d, 'first'), transcript([[0, p]], [[0, p]]));
		run(d, ['--collect']);
		check('sends nothing: the page must not wait on Telegram', sentTexts(d).length === 0);
		check('but takes it before the page marks it read', fs.readdirSync(queue).length === 1);
		fs.writeFileSync(path.join(d, 'first'), transcript([], [[0, p]]));
		run(d);
		const sent = sentTexts(d);
		check('cron sends it', sent.length === 1 && sent[0].endsWith('\n\nseen on the page first'));
	}

	group(name + ': an old message that shares the reference');
	{
		const d = fresh();
		// Part 1 of today's message is new; part 2 on the SIM is from a
		// message a month ago that the sender numbered the same.
		const now1 = deliver({ from: 'T2', alpha: true, text: 'Balance low. ', ref: 5, total: 2, seq: 1 });
		const old2 = deliver({ from: 'T2', alpha: true, text: 'Welcome!', ref: 5, total: 2, seq: 2, scts: [0x62, 0x90, 0x60, 0x90, 0x51, 0x00, 0x21] });
		fs.writeFileSync(path.join(d, 'first'), transcript([[1, now1]], [[0, old2], [1, now1]]));
		fs.writeFileSync(path.join(d, 'again'), transcript(null, [[0, old2], [1, now1]]));
		run(d);
		const sent = sentTexts(d);
		check('the old part is not joined', sent[0] && !sent[0].includes('Welcome'), sent[0]);
		check('it is a gap instead', sent[0] && sent[0].includes('(1 of 2 parts did not arrive)'));
	}

	group(name + ': what cannot be read is said, not garbled');
	{
		const d = fresh();
		const comp = deliver({ from: '+15550100', text: 'zzzzzzzz', dcs: 0x20 });
		const cut = deliver({ from: '+15550100', text: 'a message that loses its end' }).slice(0, -8);
		fs.writeFileSync(path.join(d, 'first'), transcript([[0, comp], [1, cut]], [[0, comp], [1, cut]]));
		run(d);
		const sent = sentTexts(d).join('\n');
		check('compressed', sent.includes('[a compressed message, which this camera cannot read]'), sent);
		check('cut short', sent.includes('[cut short]'), sent);
	}

	group(name + ': two collections in one second');
	{
		const d = fresh();
		fs.writeFileSync(path.join(d, 'refuse'), '');
		const a = deliver({ from: '+15550100', text: 'first' });
		const b = deliver({ from: '+15550100', text: 'second' });
		fs.writeFileSync(path.join(d, 'first'), transcript([[0, a]], [[0, a]]));
		run(d, ['--collect']);
		fs.writeFileSync(path.join(d, 'first'), transcript([[1, b]], [[0, a], [1, b]]));
		run(d, ['--collect']);
		check('both kept', fs.readdirSync(queue).length === 2, fs.readdirSync(queue).join(' '));
	}

	group(name + ': a collection that could not ask');
	{
		const d = fresh();
		const p = deliver({ from: '+15550100', text: 'half-read' });
		fs.writeFileSync(path.join(d, 'first'), transcript([[0, p]], [[0, p]]));
		fs.writeFileSync(path.join(d, 'fail'), '');
		const r = run(d, ['--collect']);
		check('says so, so the page does not list', r.status !== 0, 'status ' + r.status);
		check('keeps what it did read', fs.readdirSync(queue).length === 1);
	}

	group(name + ': switched off');
	{
		const d = fresh();
		fs.writeFileSync(conf, "sms_forward=''\n");
		fs.writeFileSync(path.join(d, 'first'), transcript([[13, T2[13]]], t2All));
		const r = run(d);
		check('exits quietly', r.status === 0);
		check('the modem is not asked', !fs.existsSync(path.join(d, 'modem.log')));
		check('nothing sent', sentTexts(d).length === 0);
	}

	group(name + ': --decode');
	{
		const r = run(fresh(), ['--decode'], transcript([[13, T2[13]]], t2All));
		check('prints the message', r.stdout.includes(t2Text), r.stdout.slice(0, 80) + r.stderr);
	}
}

suite('sh + awk', ['sh'], '', 'lab-cam');

let busybox = '';
try { busybox = execFileSync('sh', ['-c', 'command -v busybox'], { encoding: 'utf8' }).trim(); } catch (e) { /* none */ }
// Builds differ: Ubuntu's has no flock. Only the applets this one carries
// stand in; awk is the one that matters, and without it there is no point.
const applets = busybox ? execFileSync(busybox, ['--list'], { encoding: 'utf8' }).split('\n') : [];
if (busybox && applets.includes('awk')) {
	const bb = path.join(tmp, 'bb');
	fs.mkdirSync(bb);
	for (const applet of ['awk', 'sed', 'mktemp', 'flock', 'timeout', 'tr', 'grep', 'cat', 'ls', 'mv', 'rm', 'mkdir', 'date', 'wc']) {
		if (applets.includes(applet)) fs.symlinkSync(busybox, path.join(bb, applet));
	}
	// busybox sh may run its own hostname applet ahead of PATH.
	const host = execFileSync(busybox, ['sh', '-c', 'PATH=' + bin + ':$PATH hostname -s'], { encoding: 'utf8' }).trim();
	suite('busybox', [busybox, 'sh'], bb + ':', host);
} else {
	console.log('(no busybox awk on this machine: the camera\'s awk is not covered here)');
}

fs.rmSync(tmp, { recursive: true, force: true });
done();
