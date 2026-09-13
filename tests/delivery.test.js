'use strict';

// What the senders actually put on the wire, and what they say about it
// afterwards.
//
// Everything else about these two scripts is checked by reading them:
// `sh -n` in tools/lint-templates.sh has their syntax, and the template lint
// has the pages that write their config. Neither can see what a send does,
// and a send is where both of them fail SILENTLY. `bin/ntfy.sh` ends with a
// bare `exit 0` and reports nothing about the upload it just made, so a
// rejected topic, a wrong password and a successful notification are one
// answer to the operator -- and `ntfy.cgi`'s test button prints OK for all
// three. Reproducing that by hand needs a real server, a real topic and a
// real rejection, which is why it has stood.
//
// So: a server that plays the camera, the Bot API and ntfy at once, the real
// scripts run against it, and assertions about the bytes that arrived. The
// scripts are REWRITTEN rather than re-typed -- the config path and the
// endpoints are substituted, and a substitution that no longer matches is a
// failure, not a skip -- for the reason notice.test.js cuts its functions out
// of the real file: a test that carries its own copy of the subject stops
// describing it the first time somebody edits the original.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const { check, group, done } = require('./assert');

const ROOT = path.join(__dirname, '..');
const IMAGE = Buffer.from('\xff\xd8\xff\xe0JPEG-FROM-THE-CAMERA\xff\xd9', 'binary');
const CLIP = Buffer.from('\x00\x00\x00\x18ftypisomMP4-FROM-THE-RECORDER', 'binary');

// ---------------------------------------------------------------- server ---

// One server, three roles. `plan` lets a case say what the API should answer,
// so a rejection can be tested without a rejection being arranged.
const sent = [];
const stills = [];
let plan = { status: 200, body: '{"ok":true}' };

function parseMultipart(buf, type) {
	const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(type || '');
	if (!m) return null;
	const sep = Buffer.from('--' + (m[1] || m[2]).trim());
	const parts = {};
	let at = buf.indexOf(sep);
	while (at !== -1) {
		const start = at + sep.length;
		let end = buf.indexOf(sep, start);
		if (end === -1) break;
		const chunk = buf.slice(start, end);
		const head = chunk.indexOf('\r\n\r\n');
		if (head !== -1) {
			const headers = chunk.slice(0, head).toString('latin1');
			const name = /name="([^"]*)"/.exec(headers);
			const file = /filename="([^"]*)"/.exec(headers);
			// Trailing CRLF belongs to the boundary, not to the value.
			const body = chunk.slice(head + 4, chunk.length - 2);
			if (name) parts[name[1]] = { body, filename: file ? file[1] : null, headers };
		}
		at = end;
	}
	return parts;
}

const server = http.createServer((req, res) => {
	const chunks = [];
	req.on('data', (c) => chunks.push(c));
	req.on('end', () => {
		const body = Buffer.concat(chunks);
		const url = req.url.split('?')[0];

		if (url === '/image.jpg' || url === '/image.heif') {
			// Recorded as well as served: "it did not go and take a picture"
			// is half of what sending a clip means, and a check that reads a
			// list the stills never reach cannot fail.
			stills.push(url);
			res.writeHead(200, { 'Content-Type': 'image/jpeg' });
			res.end(IMAGE);
			return;
		}

		sent.push({
			method: req.method,
			url,
			headers: req.headers,
			body,
			parts: parseMultipart(body, req.headers['content-type']),
		});
		res.writeHead(plan.status, { 'Content-Type': 'application/json' });
		res.end(plan.body);
	});
});

// ------------------------------------------------------------------ rig ---

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-'));
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);

// The camera-only commands the captions are built from. Stubbed so a caption
// is the same string on every machine, and so the tests say what they expect
// rather than what this host happens to be called.
fs.writeFileSync(path.join(bin, 'hostname'), '#!/bin/sh\necho lab-cam\n', { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'ipcinfo'), '#!/bin/sh\necho 42.0\n', { mode: 0o755 });

const clip = path.join(tmp, '19-28-cam0.mp4');
fs.writeFileSync(clip, CLIP);

// Substitute, and refuse to run if the thing being substituted has moved.
function rewrite(src, subs, out) {
	let s = fs.readFileSync(path.join(ROOT, src), 'utf8');
	for (const [from, to] of subs) {
		if (!s.includes(from)) {
			throw new Error(src + ' no longer contains ' + JSON.stringify(from) +
				' — this test is rewriting something that has moved.');
		}
		s = s.split(from).join(to);
	}
	const dst = path.join(tmp, out);
	fs.writeFileSync(dst, s, { mode: 0o755 });
	return dst;
}

// Asynchronous, and it has to be: the server below lives in this process, so
// a synchronous exec would block the event loop that is meant to answer the
// request the script is making, and the two would wait for each other.
function run(script, args) {
	return new Promise((resolve) => {
		execFile('sh', [script].concat(args || []), {
			encoding: 'utf8',
			timeout: 20000,
			env: Object.assign({}, process.env, { PATH: bin + ':' + process.env.PATH }),
		}, (err, stdout, stderr) => {
			resolve({
				status: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
				stdout: stdout || '',
				stderr: stderr || '',
			});
		});
	});
}

function conf(name, body) {
	const p = path.join(tmp, name);
	fs.writeFileSync(p, body);
	return p;
}

server.listen(0, '127.0.0.1', async () => {
	const port = server.address().port;
	const origin = 'http://127.0.0.1:' + port;

	const tgConf = conf('telegram.conf', [
		'telegram_enabled="true"',
		'telegram_token="BOTTOKEN"',
		'telegram_channel="-100123"',
		'telegram_caption="%hostname cam"',
		'',
	].join('\n'));

	const ntfyConf = conf('ntfy.conf', [
		'ntfy_enabled="true"',
		'ntfy_topic="doorbell"',
		'ntfy_server="' + origin + '"',
		'ntfy_caption="%hostname cam"',
		'',
	].join('\n'));

	const telegram = rewrite('sbin/telegram', [
		['/etc/webui/telegram.conf', tgConf],
		['https://api.telegram.org', origin],
		['localhost/image.jpg', '127.0.0.1:' + port + '/image.jpg'],
		['localhost/image.heif', '127.0.0.1:' + port + '/image.heif'],
	], 'telegram');

	const ntfy = rewrite('bin/ntfy.sh', [
		['/etc/webui/ntfy.conf', ntfyConf],
		['localhost/image.jpg', '127.0.0.1:' + port + '/image.jpg'],
		['localhost/image.heif', '127.0.0.1:' + port + '/image.heif'],
	], 'ntfy.sh');

	const reset = (status, body) => {
		sent.length = 0;
		stills.length = 0;
		plan = { status: status || 200, body: body || '{"ok":true}' };
	};

	group('telegram — a still, with no argument');
	{
		reset();
		const r = await run(telegram, []);
		const req = sent[0] || {};
		const photo = req.parts && req.parts.photo;
		check('posts to sendPhoto', req.url === '/botBOTTOKEN/sendPhoto', req.url);
		check('carries the camera\'s own bytes',
			!!photo && photo.body.equals(IMAGE),
			photo ? photo.body.length + ' bytes' : 'no photo part');
		check('names the chat', !!req.parts && req.parts.chat_id &&
			req.parts.chat_id.body.toString() === '-100123');
		check('expands the caption', !!req.parts && req.parts.caption &&
			req.parts.caption.body.toString() === 'lab-cam cam',
			req.parts && req.parts.caption && req.parts.caption.body.toString());
		check('exits 0 on 200', r.status === 0, 'status ' + r.status);
		// stderr as well as stdout: curl's --verbose wrote the request line
		// there, and the request line carries the bot token. Nothing read it
		// while this ran from cron; a hook that runs per clip hands its
		// stderr to whatever called it.
		check('never prints the token', !(r.stdout + r.stderr).includes('BOTTOKEN'),
			(r.stdout + r.stderr).slice(0, 120));
	}

	group('telegram — a clip, given its path');
	{
		reset();
		const r = await run(telegram, [clip]);
		const req = sent[0] || {};
		const video = req.parts && (req.parts.video || req.parts.document);
		check('posts to sendVideo', req.url === '/botBOTTOKEN/sendVideo', req.url);
		check('carries the clip\'s bytes', !!video && video.body.equals(CLIP),
			video ? video.body.length + ' bytes' : 'no video part');
		check('keeps the clip\'s filename',
			!!video && video.filename === '19-28-cam0.mp4',
			video && video.filename);
		check('fetched no still', stills.length === 0, stills.join(','));
		check('exits 0 on 200', r.status === 0, 'status ' + r.status);
	}

	group('telegram — a send the API rejects');
	{
		reset(401, '{"ok":false,"description":"Unauthorized"}');
		const r = await run(telegram, [clip]);
		check('exits non-zero', r.status !== 0, 'status ' + r.status);
		check('shows what the API said', r.stdout.includes('Unauthorized'), r.stdout.slice(0, 80));
	}

	group('ntfy — a still, with no argument');
	{
		reset();
		const r = await run(ntfy, []);
		const req = sent[0] || {};
		check('PUTs to the topic', req.method === 'PUT' && req.url === '/doorbell',
			req.method + ' ' + req.url);
		check('carries the camera\'s own bytes', !!req.body && req.body.equals(IMAGE),
			req.body && req.body.length + ' bytes');
		check('expands the caption', !!req.headers && req.headers.message === 'lab-cam cam',
			req.headers && req.headers.message);
		check('exits 0 on 200', r.status === 0, 'status ' + r.status);
	}

	group('ntfy — a clip, given its path');
	{
		reset();
		const r = await run(ntfy, [clip]);
		const req = sent[0] || {};
		check('PUTs the clip', !!req.body && req.body.equals(CLIP),
			req.body && req.body.length + ' bytes');
		check('says it is video', !!req.headers && req.headers['content-type'] === 'video/mp4',
			req.headers && req.headers['content-type']);
		check('names the file', !!req.headers && req.headers.filename === '19-28-cam0.mp4',
			req.headers && req.headers.filename);
		check('fetched no still', stills.length === 0, stills.join(','));
		check('exits 0 on 200', r.status === 0, 'status ' + r.status);
	}

	group('ntfy — the failures it used to swallow');
	{
		reset(401, 'unauthorized');
		const r = await run(ntfy, [clip]);
		check('a rejected upload exits non-zero', r.status !== 0, 'status ' + r.status);

		reset();
		const withAuth = conf('ntfy-auth.conf', [
			'ntfy_enabled="true"',
			'ntfy_topic="doorbell"',
			'ntfy_server="' + origin + '"',
			'ntfy_user="alice"',
			'ntfy_pass="s3cr3t"',
			'',
		].join('\n'));
		const authed = rewrite('bin/ntfy.sh', [
			['/etc/webui/ntfy.conf', withAuth],
			['localhost/image.jpg', '127.0.0.1:' + port + '/image.jpg'],
			['localhost/image.heif', '127.0.0.1:' + port + '/image.heif'],
		], 'ntfy-auth.sh');
		const a = await run(authed, [clip]);
		check('never prints the password',
			!(a.stdout + a.stderr).includes('s3cr3t'),
			(a.stdout + a.stderr).slice(0, 120));

		reset();
		const off = conf('ntfy-off.conf', 'ntfy_enabled="false"\nntfy_topic="doorbell"\n');
		const offed = rewrite('bin/ntfy.sh', [
			['/etc/webui/ntfy.conf', off],
			['localhost/image.jpg', '127.0.0.1:' + port + '/image.jpg'],
			['localhost/image.heif', '127.0.0.1:' + port + '/image.heif'],
		], 'ntfy-off.sh');
		const o = await run(offed, []);
		check('a disabled integration exits non-zero', o.status !== 0, 'status ' + o.status);
		check('and sends nothing', sent.length === 0, sent.length + ' request(s)');
	}

	group('both — a clip whose name could close a quote');
	{
		// records.path is a pattern an operator types, and both senders build
		// a command string that is eval'd. A quote in the name used to end
		// the quoting and hand the rest of it to sh.
		const odd = path.join(tmp, "o'brien cam.mp4");
		fs.writeFileSync(odd, CLIP);

		reset();
		const t = await run(telegram, [odd]);
		const treq = sent[0] || {};
		const video = treq.parts && treq.parts.video;
		check('telegram sends it whole', !!video && video.body.equals(CLIP),
			video ? video.body.length + ' bytes' : 'no video part');
		check('telegram exits 0', t.status === 0, 'status ' + t.status);

		reset();
		const n = await run(ntfy, [odd]);
		const nreq = sent[0] || {};
		check('ntfy sends it whole', !!nreq.body && nreq.body.equals(CLIP),
			nreq.body && nreq.body.length + ' bytes');
		check('ntfy exits 0', n.status === 0, 'status ' + n.status);
	}

	group('both — a clip that is not there');
	{
		reset();
		const t = await run(telegram, [path.join(tmp, 'gone.mp4')]);
		check('telegram refuses', t.status !== 0, 'status ' + t.status);
		const n = await run(ntfy, [path.join(tmp, 'gone.mp4')]);
		check('ntfy refuses', n.status !== 0, 'status ' + n.status);
		check('neither sends anything', sent.length === 0, sent.length + ' request(s)');
	}

	server.close();
	fs.rmSync(tmp, { recursive: true, force: true });
	done();
});
