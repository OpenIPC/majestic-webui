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
// Every ?pre=/?duration= the senders asked the camera for. The query is the
// subject of half these checks: a clamp that silently sent 600 to the camera
// would look exactly like one that worked, since the fake camera answers
// whatever it is asked.
const clips = [];
let plan = { status: 200, body: '{"ok":true}' };
let clipPlan = { status: 200, body: CLIP, preroll: '0' };
const maxCalls = [];
const maxUploads = [];
const maxMessages = [];
let maxPlan = { slotStatus: 200, notReady: 0, messageStatus: 200, messageBody: '{"message":{"body":{"mid":"m1"}}}' };
// The upload slot MAX hands back points at this same server, and the handler
// runs before listen() has bound a port, so the origin is filled in there.
let selfOrigin = '';

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

		if (url === '/video.mp4') {
			clips.push(req.url);
			const head = { 'Content-Type': 'video/mp4' };
			if (clipPlan.preroll !== null) head['X-Preroll-Seconds'] = clipPlan.preroll;

			// A camera that answers, starts sending, and then goes away: the
			// status line is already a 200 and some of the file is already on
			// disk. Announcing more than is written and then destroying the
			// socket is what a stall, a reset or a deadline looks like from
			// the client's side.
			if (clipPlan.truncate) {
				head['Content-Length'] = String(clipPlan.body.length + 4096);
				res.writeHead(200, head);
				res.write(clipPlan.body);
				setTimeout(() => req.socket.destroy(), 30);
				return;
			}

			res.writeHead(clipPlan.status, head);
			res.end(clipPlan.body);
			return;
		}

		// MAX is three calls, not one, and the two payload kinds do not agree
		// on where the token comes from -- for a video it is in the slot, for
		// an image it comes back from the upload. Measured against the live
		// service; a stand-in that made them alike would let a sender that
		// handles only one of them pass.
		if (url === '/uploads') {
			maxCalls.push(req.url);
			const kind = /type=([a-z]+)/.exec(req.url);
			res.writeHead(maxPlan.slotStatus, { 'Content-Type': 'application/json' });
			res.end(maxPlan.slotStatus !== 200 ? '{"code":"no"}'
				: JSON.stringify(kind && kind[1] === 'image'
					? { url: selfOrigin + '/max-upload?kind=image' }
					: { url: selfOrigin + '/max-upload?kind=video', token: 'VIDEO-TOKEN' }));
			return;
		}

		if (url === '/max-upload') {
			maxUploads.push({ url: req.url, parts: parseMultipart(body, req.headers['content-type']) });
			if (/kind=image/.test(req.url)) {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end('{"photos":{"a/b+c=":{"token":"IMAGE-TOKEN"}}}');
				return;
			}
			// What the real upload host answers for a video: not JSON at all.
			res.writeHead(200, { 'Content-Type': 'text/xml' });
			res.end('<retval>1</retval>');
			return;
		}

		if (url === '/messages') {
			maxMessages.push({ url: req.url, body: body.toString() });
			if (maxPlan.notReady > 0) {
				maxPlan.notReady -= 1;
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end('{"code":"attachment.not.ready","message":"not processed"}');
				return;
			}
			res.writeHead(maxPlan.messageStatus, { 'Content-Type': 'application/json' });
			res.end(maxPlan.messageBody);
			return;
		}

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
	selfOrigin = origin;

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

	const cam = (s) => [s, '127.0.0.1:' + port + s.slice('localhost'.length)];

	const telegram = rewrite('sbin/telegram', [
		['/etc/webui/telegram.conf', tgConf],
		['https://api.telegram.org', origin],
		cam('localhost/image.jpg'),
		cam('localhost/image.heif'),
		cam('localhost/video.mp4'),
	], 'telegram');

	const ntfy = rewrite('bin/ntfy.sh', [
		['/etc/webui/ntfy.conf', ntfyConf],
		cam('localhost/image.jpg'),
		cam('localhost/image.heif'),
		cam('localhost/video.mp4'),
	], 'ntfy.sh');

	const reset = (status, body) => {
		sent.length = 0;
		stills.length = 0;
		clips.length = 0;
		plan = { status: status || 200, body: body || '{"ok":true}' };
		clipPlan = { status: 200, body: CLIP, preroll: '0', truncate: false };
	};

	// The same two senders, configured to record a clip of their own rather
	// than take a picture. Built per case so a case can say what else is set,
	// and through the same rewrite() as the originals, so a substitution that
	// stops matching fails here too.
	const telegramRec = (name, extra) => rewrite('sbin/telegram', [
		['/etc/webui/telegram.conf', conf(name + '.conf', [
			'telegram_enabled="true"',
			'telegram_token="BOTTOKEN"',
			'telegram_channel="-100123"',
			'telegram_video="true"',
		].concat(extra || [], ['']).join('\n'))],
		['https://api.telegram.org', origin],
		cam('localhost/image.jpg'),
		cam('localhost/image.heif'),
		cam('localhost/video.mp4'),
	], name);

	const maxRec = (name, extra) => rewrite('sbin/max', [
		['/etc/webui/max.conf', conf(name + '.conf', [
			'max_enabled="true"',
			'max_token="MAXTOKEN"',
			'max_chat_id="-99001122334455"',
			'max_video="true"',
		].concat(extra || [], ['']).join('\n'))],
		['https://platform-api.max.ru', origin],
		cam('localhost/image.jpg'),
		cam('localhost/video.mp4'),
	], name);

	// A sender that bails out early posts nothing, and indexing an empty list
	// throws -- which reports a crash where the interesting thing is WHICH
	// check failed. Reading through this keeps a missing message an ordinary
	// failed assertion.
	const lastMsg = () => maxMessages[maxMessages.length - 1] || { url: '', body: '(no message was posted)' };
	const lastUp = () => maxUploads[maxUploads.length - 1] ||
		{ url: '', parts: { file: { body: Buffer.from('(nothing was uploaded)') } } };

	const resetMax = () => {
		maxCalls.length = 0;
		maxUploads.length = 0;
		maxMessages.length = 0;
		maxPlan = { slotStatus: 200, notReady: 0, messageStatus: 200, messageBody: '{"message":{"body":{"mid":"m1"}}}' };
	};

	const ntfyRec = (name, extra) => rewrite('bin/ntfy.sh', [
		['/etc/webui/ntfy.conf', conf(name + '.conf', [
			'ntfy_enabled="true"',
			'ntfy_topic="doorbell"',
			'ntfy_server="' + origin + '"',
			'ntfy_video="true"',
		].concat(extra || [], ['']).join('\n'))],
		cam('localhost/image.jpg'),
		cam('localhost/image.heif'),
		cam('localhost/video.mp4'),
	], name);

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

	// ------------------------------------------------- clips of their own ---
	//
	// The camera can now be asked for a clip without a card, a recorder or an
	// HLS playlist -- /video.mp4?duration=N holds the muxer up for one request
	// and gives it back. These are the two senders as its first consumers, and
	// what is checked here is the part neither script can be read for: which
	// URL was asked for, and whether the bytes that came back are the bytes
	// that went out.

	group('telegram — records its own clip when the schedule says video');
	{
		reset();
		clipPlan.preroll = '3';
		const r = await run(telegramRec('telegram-rec'), []);
		const req = sent[0] || {};
		const video = req.parts && req.parts.video;
		check('asked the camera for a clip', clips.length === 1, clips.join(','));
		check('asked for the configured length, run-up included',
			clips[0] === '/video.mp4?pre=10&duration=10', clips[0]);
		check('posts to sendVideo', req.url === '/botBOTTOKEN/sendVideo', req.url);
		check('sends the bytes the camera gave it',
			!!video && video.body.equals(CLIP),
			video ? video.body.length + ' bytes' : 'no video part');
		check('names it .mp4', !!video && /\.mp4$/.test(video.filename || ''),
			video && video.filename);
		check('took no picture', stills.length === 0, stills.join(','));
		check('says how much run-up it got', r.stdout.includes('run-up 3s'),
			r.stdout.trim());
		check('exits 0', r.status === 0, 'status ' + r.status);

		// A camera that says nothing about the run-up is not a camera
		// reporting none of it, and the line must not invent the figure.
		reset();
		clipPlan.preroll = null;
		const q = await run(telegramRec('telegram-quiet'), []);
		check('a camera that does not say gets no figure',
			q.stdout.includes('Recorded') && !q.stdout.includes('run-up'),
			q.stdout.trim());
		check('and the clip still goes out',
			(sent[0] || {}).url === '/botBOTTOKEN/sendVideo', (sent[0] || {}).url);
	}

	group('telegram — the webhook verbs outrank the schedule');
	{
		// ?send=image on a camera whose schedule sends video: a dashboard
		// pulling a thumbnail must go on getting one.
		reset();
		const rec = telegramRec('telegram-verbs');
		const img = await run(rec, ['--image']);
		check('--image takes a picture', stills.length === 1, stills.join(','));
		check('and asks for no clip', clips.length === 0, clips.join(','));
		check('posting it to sendPhoto',
			(sent[0] || {}).url === '/botBOTTOKEN/sendPhoto', (sent[0] || {}).url);
		check('exits 0', img.status === 0, 'status ' + img.status);

		// And the other way round: a still-picture camera asked for video.
		reset();
		const clip = await run(telegram, ['--clip']);
		check('--clip records one even with the switch off', clips.length === 1,
			clips.join(','));
		check('taking no picture', stills.length === 0, stills.join(','));
		check('and sending it as video',
			(sent[0] || {}).url === '/botBOTTOKEN/sendVideo', (sent[0] || {}).url);
		check('exits 0', clip.status === 0, 'status ' + clip.status);
	}

	group('telegram — a handed-over recording still wins');
	{
		// record.sh calls the sender with the clip majestic has just closed.
		// A camera that also records its own must not answer that by recording
		// a second one: the file in hand is the motion, a fresh capture is
		// whatever is happening a minute later.
		reset();
		const r = await run(telegramRec('telegram-rec-path'), [clip]);
		const video = (sent[0] || {}).parts && sent[0].parts.video;
		check('sends the file it was given', !!video && video.body.equals(CLIP),
			video ? video.body.length + ' bytes' : 'no video part');
		check('keeps its name', !!video && video.filename === '19-28-cam0.mp4',
			video && video.filename);
		check('records nothing itself', clips.length === 0, clips.join(','));
		check('exits 0', r.status === 0, 'status ' + r.status);
	}

	group('both — a length that is not one');
	{
		// records.preRollSec is a number on a page; this one reaches a URL and
		// an arithmetic expansion, so what arrives is clamped rather than
		// trusted. A camera answering whatever it is asked cannot show this.
		reset();
		await run(telegramRec('telegram-long', ['telegram_video_seconds="600"']), []);
		check('too long is cut to a minute',
			clips[0] === '/video.mp4?pre=60&duration=60', clips[0]);

		reset();
		await run(telegramRec('telegram-junk', ['telegram_video_seconds="ten"']), []);
		check('a word falls back to the default',
			clips[0] === '/video.mp4?pre=10&duration=10', clips[0]);

		reset();
		await run(ntfyRec('ntfy-short', ['ntfy_video_seconds="5"']), []);
		check('and a real figure is passed through',
			clips[0] === '/video.mp4?pre=5&duration=5', clips[0]);
	}

	group('both — a camera that will not record');
	{
		// The refusal /video.mp4 answers with when there is no video channel
		// to mux. Quietly sending a picture instead would leave an operator
		// believing the clips they configured are being sent.
		reset();
		clipPlan = { status: 503, body: Buffer.alloc(0), preroll: null };
		const t = await run(telegramRec('telegram-503'), []);
		check('telegram refuses', t.status !== 0, 'status ' + t.status);
		check('sends nothing at all', sent.length === 0, sent.length + ' request(s)');
		check('and does not fall back to a picture', stills.length === 0,
			stills.join(','));
		check('naming the code', t.stdout.includes('503'), t.stdout.trim());

		reset();
		clipPlan = { status: 503, body: Buffer.alloc(0), preroll: null };
		const n = await run(ntfyRec('ntfy-503'), []);
		check('ntfy refuses', n.status !== 0, 'status ' + n.status);
		check('sends nothing at all', sent.length === 0, sent.length + ' request(s)');
		check('and does not fall back to a picture', stills.length === 0,
			stills.join(','));

		// The transfer that dies after the status line. curl reports the 200
		// it was given and leaves a partial file, so a sender judging only
		// those two sends half a video -- which plays, up to where it stops,
		// with nothing about it saying it was cut.
		reset();
		clipPlan = { status: 200, body: CLIP, preroll: '0', truncate: true };
		const t2 = await run(telegramRec('telegram-cut'), []);
		check('a transfer cut short is a refusal', t2.status !== 0, 'status ' + t2.status);
		check('with nothing sent', sent.length === 0, sent.length + ' request(s)');
		check('and no picture in its place', stills.length === 0, stills.join(','));

		reset();
		clipPlan = { status: 200, body: CLIP, preroll: '0', truncate: true };
		const n2 = await run(ntfyRec('ntfy-cut'), []);
		check('ntfy refuses it too', n2.status !== 0, 'status ' + n2.status);
		check('with nothing sent', sent.length === 0, sent.length + ' request(s)');

		// A 200 that carries nothing is the shape a pipeline torn down
		// mid-clip leaves behind, and a zero-byte video is worse than silence.
		reset();
		clipPlan = { status: 200, body: Buffer.alloc(0), preroll: '0' };
		const e = await run(telegramRec('telegram-empty'), []);
		check('an empty clip is a refusal too', e.status !== 0, 'status ' + e.status);
		check('with nothing sent', sent.length === 0, sent.length + ' request(s)');
	}

	group('ntfy — records its own clip when told to');
	{
		reset();
		const r = await run(ntfyRec('ntfy-rec'), []);
		const req = sent[0] || {};
		check('asked the camera for a clip',
			clips[0] === '/video.mp4?pre=10&duration=10', clips[0]);
		check('PUTs the bytes the camera gave it',
			!!req.body && req.body.equals(CLIP),
			req.body && req.body.length + ' bytes');
		check('says it is video',
			!!req.headers && req.headers['content-type'] === 'video/mp4',
			req.headers && req.headers['content-type']);
		check('names it .mp4',
			!!req.headers && /\.mp4$/.test(req.headers.filename || ''),
			req.headers && req.headers.filename);
		check('took no picture', stills.length === 0, stills.join(','));
		check('exits 0', r.status === 0, 'status ' + r.status);

		reset();
		const img = await run(ntfyRec('ntfy-verbs'), ['--image']);
		check('--image overrides it', stills.length === 1 && clips.length === 0,
			stills.join(',') + ' / ' + clips.join(','));
		check('pushing a jpeg', (sent[0] || {}).headers['content-type'] === 'image/jpeg',
			(sent[0] || {}).headers['content-type']);
		check('exits 0', img.status === 0, 'status ' + img.status);
	}

	// ------------------------------------------------------------ max ---
	//
	// MAX takes three calls where Telegram takes one, and the awkward part is
	// that the two payload kinds disagree about where the token lives. A
	// sender that assumed they were alike would work for video and silently
	// fail for stills, which is the shape of bug the page could not show.

	group('max — a clip of its own, in three steps');
	{
		reset();
		resetMax();
		const r = await run(maxRec('max-clip', ['max_video_seconds="10"']));
		check('it recorded rather than taking a picture',
			clips.length === 1 && stills.length === 0,
			JSON.stringify({ clips, stills }));
		check('and asked for the length it was set to',
			clips[0] === '/video.mp4?pre=10&duration=10', clips[0]);
		check('it asked for a video slot',
			maxCalls.length === 1 && /type=video/.test(maxCalls[0]), JSON.stringify(maxCalls));
		check('then put the bytes at the slot it was given',
			maxUploads.length === 1 && lastUp().parts.file.body.equals(CLIP),
			JSON.stringify(maxUploads.map((u) => u.url)));
		check('and posted one message afterwards',
			maxMessages.length === 1, JSON.stringify(maxMessages.map((m) => m.url)));
		check('to the chat it was given',
			/chat_id=-99001122334455/.test(lastMsg().url), lastMsg().url);
		check('carrying the token the SLOT gave, which is where a video keeps it',
			/"token":"VIDEO-TOKEN"/.test(lastMsg().body), lastMsg().body);
		check('as a video attachment',
			/"type":"video"/.test(lastMsg().body), lastMsg().body);
		check('and it says it sent', r.status === 0 && /Sent to MAX/.test(r.stdout),
			r.stdout + r.stderr);
	}

	group('max — a still takes its token from the upload, not the slot');
	{
		reset();
		resetMax();
		const r = await run(maxRec('max-still', ['max_video="false"']));
		check('it took a picture', stills.length === 1 && clips.length === 0,
			JSON.stringify({ clips, stills }));
		check('and asked for an image slot',
			/type=image/.test(maxCalls[0]), JSON.stringify(maxCalls));
		check('the message carries the token the UPLOAD answered with',
			/"token":"IMAGE-TOKEN"/.test(lastMsg().body), lastMsg().body);
		check('and never the video one',
			!/VIDEO-TOKEN/.test(lastMsg().body), lastMsg().body);
		check('as an image attachment',
			/"type":"image"/.test(lastMsg().body), lastMsg().body);
		check('and it says it sent', r.status === 0, r.stdout + r.stderr);
	}

	group('max — an attachment the service has not finished with');
	{
		// The upload is accepted before it is processed, and the message post
		// is refused until it is. Asking again is the whole remedy; waiting
		// first would put that delay on every send instead of the rare one.
		reset();
		resetMax();
		maxPlan.notReady = 2;
		const r = await run(maxRec('max-notready'));
		check('it asked more than once', maxMessages.length === 3,
			'posts: ' + maxMessages.length);
		check('it did not upload again for each try', maxUploads.length === 1,
			'uploads: ' + maxUploads.length);
		check('and the send succeeded in the end', r.status === 0, r.stdout + r.stderr);
	}

	group('max — a refusal is a refusal');
	{
		reset();
		resetMax();
		maxPlan.slotStatus = 403;
		const r = await run(maxRec('max-refused'));
		check('nothing was uploaded', maxUploads.length === 0, JSON.stringify(maxUploads));
		check('and no message was posted', maxMessages.length === 0,
			JSON.stringify(maxMessages));
		check('the send reports failure', r.status !== 0, 'exit ' + r.status);
		check('and says MAX would not take it',
			/would not take an upload/.test(r.stdout + r.stderr), r.stdout + r.stderr);
	}

	group('max — a recording handed over is sent, not replaced');
	{
		// What sbin/motion-notify.sh does: one capture, handed to every
		// sender. A sender that went and recorded its own would send a
		// different moment from its neighbours.
		reset();
		resetMax();
		const r = await run(maxRec('max-handed'), [clip]);
		check('it recorded nothing of its own',
			clips.length === 0 && stills.length === 0, JSON.stringify({ clips, stills }));
		check('and uploaded the file it was handed',
			maxUploads.length === 1 && lastUp().parts.file.body.equals(CLIP),
			JSON.stringify(maxUploads.map((u) => u.url)));
		check('as a video, from the extension it was given',
			/"type":"video"/.test(lastMsg().body), lastMsg().body);
		check('and it says it sent', r.status === 0, r.stdout + r.stderr);
	}

	group('max — a refusal that looks like a success');
	{
		// MAX puts a `message` field in its ERRORS as well: a camera with the
		// wrong token gets {"code":"verify.token","message":"No access token"}
		// back. A sender that looked for the word rather than the shape called
		// that a delivery, which is the worst thing a notifier can do -- every
		// send reported as sent, nothing arriving.
		reset();
		resetMax();
		maxPlan.messageStatus = 401;
		maxPlan.messageBody = '{"code":"verify.token","message":"No access token"}';
		const r = await run(maxRec('max-badtoken'));
		check('the send fails', r.status !== 0, 'exit ' + r.status);
		check('and says so rather than claiming it sent',
			!/Sent to MAX/.test(r.stdout) && /refused/.test(r.stdout + r.stderr),
			r.stdout + r.stderr);
	}

	group('max — an error with a 200 is still an error');
	{
		// The status alone is not enough either: the shape has to say a message
		// was created, or a service answering 200 with an error body would read
		// as a delivery.
		reset();
		resetMax();
		maxPlan.messageBody = '{"code":"chat.not.found","message":"no such chat"}';
		const r = await run(maxRec('max-nochat'));
		check('it does not report a send', !/Sent to MAX/.test(r.stdout), r.stdout);
		check('and exits non-zero', r.status !== 0, 'exit ' + r.status);
	}

	group('max — a length that is not one');
	{
		reset();
		resetMax();
		await run(maxRec('max-clamp', ['max_video_seconds="600"']));
		check('the camera is asked for the clamped length, not the typed one',
			clips[0] === '/video.mp4?pre=60&duration=60', clips[0]);
	}

	server.close();
	fs.rmSync(tmp, { recursive: true, force: true });
	done();
});
