'use strict';

// What happens the moment something moves on a camera with no memory card.
//
// This one subject cannot be reproduced by reading the script. It decides
// between two mechanisms by asking the daemon a question, captures at most one
// clip for two senders, and must stand down entirely when the recorder is
// going to do the job properly — and every one of those decisions fails
// SILENTLY when it goes wrong: a duplicate message, a missed event, or two
// simultaneous captures on a camera that can barely afford one. Nothing
// reads the script's exit status in production, so nothing on a camera would
// ever tell you.
//
// So: a server that plays both the camera's clip endpoint and its config API,
// the real script run against it, senders stubbed to record what they were
// handed, and assertions about which requests were made. The script and the
// config helper are REWRITTEN rather than re-typed, and a substitution that no
// longer matches is a failure rather than a skip — the same rule
// delivery.test.js follows, for the same reason.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const { check, group, done } = require('./assert');

const ROOT = path.join(__dirname, '..');
const CLIP = Buffer.from('\x00\x00\x00\x18ftypisomCLIP-FROM-THE-CAMERA', 'binary');

// ---------------------------------------------------------------- server ---

const clips = [];
const asked = [];
// What the camera says about itself. `null` means the key is not set, which
// the config helper reports as a different answer from "could not ask".
let config = { 'records.enabled': null, 'records.mode': null };
// What the recorder says it is DOING, which is the question the script asks:
// state 0 is the only one in which a clip can be written, and a recorder that
// has written nothing yet is not taken to be covering anything.
let recorder = { state: 0, written: 0 };
let clipPlan = { status: 200, body: CLIP, truncate: false };

const server = http.createServer((req, res) => {
	const [url, query] = req.url.split('?');

	if (url === '/api/v1/get') {
		const key = new URLSearchParams(query || '').get('key');
		asked.push(key);
		const val = config[key];
		if (val === undefined || val === null) {
			res.writeHead(404).end('');
			return;
		}
		res.writeHead(200, { 'Content-Type': 'text/plain' }).end(String(val));
		return;
	}

	if (url === '/metrics/records') {
		asked.push('metrics');
		res.writeHead(200, { 'Content-Type': 'text/plain' }).end(
			'records_state ' + recorder.state + '\n' +
			'records_fragments_written_total ' + recorder.written + '\n');
		return;
	}

	if (url === '/video.mp4') {
		clips.push(req.url);
		if (clipPlan.truncate) {
			res.writeHead(200, {
				'Content-Type': 'video/mp4',
				'Content-Length': String(clipPlan.body.length + 4096),
			});
			res.write(clipPlan.body);
			setTimeout(() => req.socket.destroy(), 30);
			return;
		}
		res.writeHead(clipPlan.status, { 'Content-Type': 'video/mp4' });
		res.end(clipPlan.body);
		return;
	}

	res.writeHead(404).end('');
});

// ------------------------------------------------------------------ rig ---

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-'));
const bin = path.join(tmp, 'bin');
const conf = path.join(tmp, 'conf');
fs.mkdirSync(bin);
fs.mkdirSync(conf);

fs.writeFileSync(path.join(bin, 'hostname'), '#!/bin/sh\necho lab-cam\n', { mode: 0o755 });

// The senders, stubbed to write down what they were handed. They must be
// handed a path to a real file, and the SAME path as each other.
const sent = path.join(tmp, 'sent.log');
function sender(name, code) {
	const p = path.join(bin, name);
	fs.writeFileSync(p,
		'#!/bin/sh\n' +
		'printf "%s\\t%s\\t%s\\n" ' + name + ' "$1" "$(wc -c < "$1" 2>/dev/null || echo missing)" >> ' +
		JSON.stringify(sent) + '\n' +
		'exit ' + code + '\n', { mode: 0o755 });
	return p;
}

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

function run(script) {
	return new Promise((resolve) => {
		execFile('sh', [script, '100', '120', '260', '300'], {
			encoding: 'utf8',
			timeout: 30000,
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

function writeConf(name, lines) {
	fs.writeFileSync(path.join(conf, name + '.conf'), lines.join('\n') + '\n');
}

function sentLines() {
	if (!fs.existsSync(sent)) return [];
	return fs.readFileSync(sent, 'utf8').trim().split('\n').filter(Boolean)
		.map((l) => { const [who, file, size] = l.split('\t'); return { who, file, size }; });
}

server.listen(0, '127.0.0.1', async () => {
	const port = server.address().port;

	// The REAL config helper, pointed at the fake camera. Rewriting it here
	// rather than stubbing mj_cfg is the point: the script's stand-down
	// decision rests on that helper's three-valued answer, so the test has to
	// exercise the helper itself.
	const mjsh = rewrite('www/cgi-bin/p/majestic.sh', [
		['http://127.0.0.1/api/v1/get', 'http://127.0.0.1:' + port + '/api/v1/get'],
	], 'majestic.sh');

	const lock = path.join(tmp, 'lock');
	const tg = sender('telegram-stub', 0);
	const nf = sender('ntfy-stub', 0);
	const tgFails = sender('telegram-fails', 1);

	const build = (opts) => rewrite('sbin/motion-notify.sh', [
		['CONF_DIR=/etc/webui', 'CONF_DIR=' + conf],
		['MJ_SH=/var/www/cgi-bin/p/majestic.sh', 'MJ_SH=' + ((opts || {}).mj === false ? '/nonexistent' : mjsh)],
		['LOCK=/tmp/motion-notify.lock', 'LOCK=' + lock],
		['localhost/video.mp4', '127.0.0.1:' + port + '/video.mp4'],
		['localhost/metrics/records', '127.0.0.1:' + port + '/metrics/records'],
		['/usr/sbin/telegram', (opts || {}).tg || tg],
		['/usr/bin/ntfy.sh', nf],
	], (opts || {}).out || 'motion-notify.sh');

	const reset = () => {
		clips.length = 0;
		asked.length = 0;
		fs.rmSync(sent, { force: true });
		fs.rmSync(lock, { recursive: true, force: true });
		config = { 'records.enabled': null, 'records.mode': null };
		recorder = { state: 0, written: 0 };
		clipPlan = { status: 200, body: CLIP, truncate: false };
	};

	const both = () => {
		writeConf('telegram', ['telegram_enabled="true"', 'telegram_clips="true"', 'telegram_video_seconds="10"']);
		writeConf('ntfy', ['ntfy_enabled="true"', 'ntfy_clips="true"', 'ntfy_video_seconds="15"']);
	};

	group('one capture where both want the same length');
	{
		reset();
		writeConf('telegram', ['telegram_enabled="true"', 'telegram_clips="true"', 'telegram_video_seconds="10"']);
		writeConf('ntfy', ['ntfy_enabled="true"', 'ntfy_clips="true"', 'ntfy_video_seconds="10"']);
		const r = await run(build());
		const out = sentLines();
		check('asked the camera once', clips.length === 1, clips.join(','));
		check('for that length', clips[0] === '/video.mp4?pre=10&duration=10', clips[0]);
		check('handed it to both senders', out.length === 2, JSON.stringify(out));
		check('and handed them the same file',
			out.length === 2 && out[0].file === out[1].file,
			out.map((o) => o.file).join(' vs '));
		check('which held the clip', out.every((o) => o.size === String(CLIP.length)),
			out.map((o) => o.size).join(','));
		check('exits 0', r.status === 0, 'status ' + r.status);
	}

	group('two captures where they want different lengths');
	{
		// Handing both the longer clip would silently lengthen one service's
		// video because the other was switched on, while its own page went on
		// showing the shorter figure.
		reset();
		both();   // telegram 10, ntfy 15
		const r = await run(build());
		const out = sentLines();
		check('asked the camera twice', clips.length === 2, clips.join(','));
		check('each for what its own page promised',
			clips.includes('/video.mp4?pre=10&duration=10') &&
			clips.includes('/video.mp4?pre=15&duration=15'), clips.join(','));
		check('one clip each', out.length === 2, JSON.stringify(out));
		check('and they are different files',
			out.length === 2 && out[0].file !== out[1].file,
			out.map((o) => o.file).join(' vs '));
		check('exits 0', r.status === 0, 'status ' + r.status);
	}

	group('it stands aside when the recorder is demonstrably doing it');
	{
		reset();
		both();
		config = { 'records.enabled': 'true', 'records.mode': 'motion' };
		recorder = { state: 0, written: 412 };
		const r = await run(build());
		check('asked the camera what it records', asked.includes('records.mode'), asked.join(','));
		check('and what the recorder is doing', asked.includes('metrics'), asked.join(','));
		check('recorded nothing itself', clips.length === 0, clips.join(','));
		check('and sent nothing', sentLines().length === 0, JSON.stringify(sentLines()));
		check('exits 0 — there is nothing wrong here', r.status === 0, 'status ' + r.status);
	}

	group('a recorder that cannot write is not cover');
	{
		// The camera this whole script exists for: no card, and settings that
		// still say motion recording is on. The recorder reports itself ok
		// until it tries, so only what it has actually DONE can be trusted.
		reset();
		both();
		config = { 'records.enabled': 'true', 'records.mode': 'motion' };
		recorder = { state: 3, written: 0 };
		const offline = await run(build());
		check('sends anyway when the recorder is offline', clips.length === 2, clips.join(','));
		check('to both senders', sentLines().length === 2, JSON.stringify(sentLines()));
		check('exits 0', offline.status === 0, 'status ' + offline.status);

		// Freshly restarted with a perfectly good card: nothing written yet,
		// so this one event may arrive twice. A duplicate is the right way to
		// be wrong here.
		reset();
		both();
		config = { 'records.enabled': 'true', 'records.mode': 'motion' };
		recorder = { state: 0, written: 0 };
		const fresh = await run(build());
		check('sends when the recorder has recorded nothing yet', clips.length === 2, clips.join(','));
		check('exits 0', fresh.status === 0, 'status ' + fresh.status);
	}

	group('recording switched off is not cover, however healthy it looks');
	{
		// records.mode keeps saying motion after recording is turned off, the
		// health gauge stays at 0 because nothing has tried, and the write
		// counter keeps whatever it reached before. All three can look like a
		// working recorder on a camera that will never finish another clip.
		reset();
		both();
		config = { 'records.enabled': 'false', 'records.mode': 'motion' };
		recorder = { state: 0, written: 8123 };
		const r = await run(build());
		check('sends anyway', clips.length === 2, clips.join(','));
		check('exits 0', r.status === 0, 'status ' + r.status);
	}

	group('recording, but not on movement, is not cover');
	{
		// A camera recording continuously never closes a clip when movement
		// stops, so the clip hook never fires for an event and this path is
		// the only one that will say anything.
		reset();
		both();
		config = { 'records.enabled': 'true', 'records.mode': 'continuous' };
		recorder = { state: 0, written: 9000 };
		const r = await run(build());
		check('records its own clip', clips.length === 2, clips.join(','));
		check('and sends it', sentLines().length === 2, JSON.stringify(sentLines()));
		check('exits 0', r.status === 0, 'status ' + r.status);
	}

	group('a camera that cannot be asked is given the benefit of the doubt');
	{
		// A missed event is worse than a duplicate, and a camera that will not
		// answer is usually one that is restarting.
		reset();
		both();
		const r = await run(build({ mj: false, out: 'motion-no-helper.sh' }));
		check('goes ahead', clips.length === 2, clips.join(','));
		check('and sends', sentLines().length === 2, JSON.stringify(sentLines()));
		check('exits 0', r.status === 0, 'status ' + r.status);
	}

	group('nobody wants it');
	{
		reset();
		writeConf('telegram', ['telegram_enabled="true"', 'telegram_clips="false"']);
		writeConf('ntfy', ['ntfy_enabled="false"', 'ntfy_clips="true"']);
		const r = await run(build());
		check('asks the camera for nothing', clips.length === 0, clips.join(','));
		check('sends nothing', sentLines().length === 0, JSON.stringify(sentLines()));
		check('and does not even ask what it records', asked.length === 0, asked.join(','));
		check('exits 0', r.status === 0, 'status ' + r.status);
	}

	group('one sender only, and its own length');
	{
		reset();
		writeConf('telegram', ['telegram_enabled="true"', 'telegram_clips="true"', 'telegram_video_seconds="30"']);
		writeConf('ntfy', ['ntfy_enabled="false"', 'ntfy_clips="true"', 'ntfy_video_seconds="60"']);
		await run(build());
		check('asks for the wanting sender\'s length',
			clips[0] === '/video.mp4?pre=30&duration=30', clips[0]);
		check('and sends to it alone',
			sentLines().length === 1 && sentLines()[0].who === 'telegram-stub',
			JSON.stringify(sentLines()));
	}

	group('a length that is not one is clamped, as the sender clamps it');
	{
		reset();
		writeConf('telegram', ['telegram_enabled="true"', 'telegram_clips="true"', 'telegram_video_seconds="600"']);
		writeConf('ntfy', ['ntfy_enabled="false"', 'ntfy_clips="false"']);
		await run(build());
		check('cut to a minute', clips[0] === '/video.mp4?pre=60&duration=60', clips[0]);

		reset();
		writeConf('telegram', ['telegram_enabled="true"', 'telegram_clips="true"', 'telegram_video_seconds="ten"']);
		await run(build());
		check('a word falls back to the default', clips[0] === '/video.mp4?pre=10&duration=10', clips[0]);
	}

	group('a clip that did not arrive whole is not sent');
	{
		reset();
		both();
		clipPlan = { status: 503, body: Buffer.alloc(0), truncate: false };
		const refused = await run(build());
		check('nothing sent on a refusal', sentLines().length === 0, JSON.stringify(sentLines()));
		check('and it says so', refused.status !== 0, 'status ' + refused.status);

		reset();
		both();
		clipPlan = { status: 200, body: CLIP, truncate: true };
		const cut = await run(build());
		check('nothing sent on a cut transfer', sentLines().length === 0, JSON.stringify(sentLines()));
		check('and it says so', cut.status !== 0, 'status ' + cut.status);

		reset();
		both();
		clipPlan = { status: 200, body: Buffer.alloc(0), truncate: false };
		const empty = await run(build());
		check('nothing sent on an empty clip', sentLines().length === 0, JSON.stringify(sentLines()));
		check('and it says so', empty.status !== 0, 'status ' + empty.status);
	}

	group('a sender that fails is reported, and does not stop the other');
	{
		reset();
		both();
		const r = await run(build({ tg: tgFails, out: 'motion-tg-fails.sh' }));
		const out = sentLines();
		check('both were tried', out.length === 2, JSON.stringify(out));
		check('and the failure is the exit status', r.status !== 0, 'status ' + r.status);
	}

	group('one at a time, camera-wide');
	{
		// A live holder keeps the lock however long it runs: a capture plus two
		// uploads over a slow link is minutes, and any age short enough to
		// recover from a kill -9 is short enough to expire under a delivery
		// that is still going.
		reset();
		both();
		fs.mkdirSync(lock);
		fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
		const held = await run(build());
		check('a live holder means no second capture', clips.length === 0, clips.join(','));
		check('and no send', sentLines().length === 0, JSON.stringify(sentLines()));
		check('exits 0', held.status === 0, 'status ' + held.status);
		fs.rmSync(lock, { recursive: true, force: true });

		// A holder that is gone is proof, and needs no waiting: a run killed
		// outright must not silence the camera until somebody reboots it.
		reset();
		both();
		fs.mkdirSync(lock);
		fs.writeFileSync(path.join(lock, 'pid'), '999999');
		const dead = await run(build());
		check('a dead holder is taken over at once', clips.length === 2, clips.join(','));
		check('and the event is sent', sentLines().length === 2, JSON.stringify(sentLines()));
		check('exits 0', dead.status === 0, 'status ' + dead.status);

		// And the run whose lock was taken from it must not take away the one
		// its successor is holding.
		reset();
		both();
		fs.mkdirSync(lock);
		fs.writeFileSync(path.join(lock, 'pid'), '999998');
		await run(build());
		check('the successor still holds a lock of its own',
			!fs.existsSync(lock) || fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim() !== '999998',
			'the stale pid file survived');
	}

	group('it leaves nothing behind');
	{
		reset();
		both();
		await run(build());
		const leftovers = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('motion.'));
		check('no working directory survives', leftovers.length === 0, leftovers.join(','));
		check('and the lock is released', !fs.existsSync(lock), 'lock still held');
	}

	server.close();
	fs.rmSync(tmp, { recursive: true, force: true });
	done();
});
