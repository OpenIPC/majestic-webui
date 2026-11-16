'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { check, done } = require('./assert.js');

const root = path.resolve(__dirname, '..');

function runSh(script, env) {
	return execFileSync('/bin/sh', ['-c', script], {
		env: { ...process.env, ...env },
		encoding: 'utf8',
	});
}

function runCgiExpectFail(cgiPath, env) {
	try {
		execFileSync('/bin/sh', [cgiPath], {
			env: { ...process.env, ...env },
			encoding: 'utf8',
		});
		return '';
	} catch (err) {
		return err.stdout || '';
	}
}

// 1. Test ptz_common.sh position read/write/delta/persist directly
{
	const tmpPos = path.join('/tmp', 'ptz_pos_tmp_' + process.pid + '.conf');
	const etcPos = path.join('/tmp', 'ptz_pos_etc_' + process.pid + '.conf');
	const common = path.join(root, 'www/cgi-bin/p/ptz_common.sh');
	try {
		fs.writeFileSync(tmpPos, 'PAN_MS=100\nTILT_MS=-50\nFOCUS_MS=20\n');
		const out = runSh(`
			. "${common}"
			PTZ_POS_TMP="${tmpPos}"
			PTZ_POS_ETC="${etcPos}"
			ptz_apply_axis_delta right 250 0
			ptz_apply_axis_delta left 100 0
			ptz_apply_axis_delta up 200 0
			ptz_apply_axis_delta down 50 0
			ptz_apply_axis_delta far 30 1
			ptz_read_pos
			printf '%s,%s,%s\\n' "$PAN_MS" "$TILT_MS" "$FOCUS_MS"
		`);
		check('ptz_common.sh updates pan/tilt/focus across moves', out.trim() === '250,100,50', 'got ' + out.trim());
		const persisted = fs.readFileSync(etcPos, 'utf8').trim();
		check('ptz_common.sh persists to PTZ_POS_ETC when persist=1',
			persisted === 'PAN_MS=250\nTILT_MS=100\nFOCUS_MS=50', 'got ' + JSON.stringify(persisted));
	} finally {
		fs.rmSync(tmpPos, { force: true });
		fs.rmSync(etcPos, { force: true });
	}
}

// 2. Reject GET mutations on ptz_presets.cgi with 405
{
	const cgi = path.join(root, 'www/cgi-bin/j/ptz_presets.cgi');
	const out = runCgiExpectFail(cgi, { REQUEST_METHOD: 'GET', QUERY_STRING: 'act=goto&id=1' });
	check('ptz_presets.cgi rejects GET mutation with 405', /HTTP\/1\.1 405 Method Not Allowed/.test(out), 'got ' + out);
}

// 3. Reject cross-site POSTs on all PTZ/AF CGIs
for (const rel of [
	'www/cgi-bin/j/ptz_presets.cgi',
	'www/cgi-bin/j/box_ptz.cgi',
	'www/cgi-bin/j/af_triggers.cgi',
	'www/cgi-bin/j/af_candidates.cgi',
]) {
	const cgi = path.join(root, rel);
	const qs = rel.endsWith('af_candidates.cgi') ? 'clear=1' : 'act=delete&id=1';
	const outRef = runCgiExpectFail(cgi, {
		REQUEST_METHOD: 'POST',
		QUERY_STRING: qs,
		HTTP_HOST: 'camera.lan',
		HTTP_REFERER: 'http://evil.example/attack.html',
	});
	check(path.basename(rel) + ' rejects foreign Referer with 400', /HTTP\/1\.1 400 Bad Request/.test(outRef), 'got ' + outRef);

	const outCt = runCgiExpectFail(cgi, {
		REQUEST_METHOD: 'POST',
		QUERY_STRING: qs,
		CONTENT_TYPE: 'application/x-www-form-urlencoded',
	});
	check(path.basename(rel) + ' rejects form Content-Type with 400', /HTTP\/1\.1 400 Bad Request/.test(outCt), 'got ' + outCt);
}

// 4. box_ptz.cgi GET returns ok:true JSON
{
	const cgi = path.join(root, 'www/cgi-bin/j/box_ptz.cgi');
	const out = execFileSync('/bin/sh', [cgi], {
		env: { ...process.env, REQUEST_METHOD: 'GET', QUERY_STRING: '' },
		encoding: 'utf8',
	});
	const body = out.split('\n\n')[1] || out;
	const parsed = JSON.parse(body.trim());
	check('box_ptz.cgi GET returns ok:true', parsed.ok === true);
	check('box_ptz.cgi GET returns null or numeric current_mag',
		parsed.current_mag === null || typeof parsed.current_mag === 'number');
}

// 5. ptz_presets.cgi actions against a sandbox. Each CGI is copied with its
// /etc and /tmp paths moved under a temporary directory, so the real
// actions run unmodified. Every failure here is silent on a camera: a flash
// write nobody sees, a preset overwritten without a word, a position
// written in the wrong frame.
function presetsSandbox() {
	const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ptz-presets-'));
	for (const sub of ['etc', 'tmp', 'j', 'p']) fs.mkdirSync(path.join(dir, sub));
	const relocate = (src, dst) => fs.writeFileSync(dst,
		fs.readFileSync(path.join(root, src), 'utf8')
			.replace(/\/(etc|tmp)\//g, (m, d) => dir + '/' + d + '/'));
	relocate('www/cgi-bin/j/ptz_presets.cgi', path.join(dir, 'j/ptz_presets.cgi'));
	relocate('www/cgi-bin/p/ptz_common.sh', path.join(dir, 'p/ptz_common.sh'));
	const run = (qs) => {
		const out = execFileSync('/bin/sh', [path.join(dir, 'j/ptz_presets.cgi')], {
			env: { PATH: process.env.PATH, REQUEST_METHOD: 'POST', QUERY_STRING: qs, CONTENT_LENGTH: '0' },
			encoding: 'utf8',
		});
		return JSON.parse(out.slice(out.indexOf('\n\n') + 2).trim());
	};
	const file = (rel) => path.join(dir, rel);
	return { dir, run, file };
}

{
	const sb = presetsSandbox();
	try {
		fs.writeFileSync(sb.file('etc/ptz_pos.conf'), 'PAN_MS=0\nTILT_MS=0\nFOCUS_MS=0\n');
		sb.run('act=track&pan_ms=300&tilt_ms=-40&focus_ms=0');
		check('track keeps the position in RAM',
			fs.readFileSync(sb.file('tmp/ptz_pos.conf'), 'utf8').startsWith('PAN_MS=300\nTILT_MS=-40\n'));
		check('track does not write the flash copy',
			fs.readFileSync(sb.file('etc/ptz_pos.conf'), 'utf8') === 'PAN_MS=0\nTILT_MS=0\nFOCUS_MS=0\n');
		sb.run('act=persist');
		check('persist copies the position to flash',
			fs.readFileSync(sb.file('etc/ptz_pos.conf'), 'utf8').startsWith('PAN_MS=300\nTILT_MS=-40\n'));
	} finally {
		fs.rmSync(sb.dir, { recursive: true, force: true });
	}
}

{
	const sb = presetsSandbox();
	try {
		const rows = [];
		for (let i = 1; i <= 32; i++) rows.push(i + '|View ' + i + '|1.0|0|1|' + (i * 100) + '|0|0');
		fs.writeFileSync(sb.file('etc/ptz_presets.tsv'), rows.join('\n') + '\n');
		const d = sb.run('act=set_home_here&name=Home');
		check('Save Home refuses when every slot is taken and no Home is set', d.ok === false && /32 preset slots/.test(d.error || ''),
			JSON.stringify(d));
		check('Save Home leaves preset #1 alone',
			fs.readFileSync(sb.file('etc/ptz_presets.tsv'), 'utf8').startsWith('1|View 1|1.0|0|1|100|0|0\n'));

		fs.writeFileSync(sb.file('etc/ptz_presets.tsv'), '2|Homestead|1.0|0|1|500|0|0\n');
		const h = sb.run('act=set_home_here&name=Home');
		check('Save Home takes the first free slot, not a preset whose name starts with "home"',
			h.ok === true && h.boot_home === 1 && h.presets.some(p => p.id === 2 && p.name === 'Homestead' && p.pan_ms === 500),
			JSON.stringify(h));
	} finally {
		fs.rmSync(sb.dir, { recursive: true, force: true });
	}
}

{
	const sb = presetsSandbox();
	try {
		fs.writeFileSync(sb.file('etc/ptz_presets.tsv'), '1|Door|1.0|0|1|1000|200|0\n');
		fs.writeFileSync(sb.file('tmp/ptz_pos.conf'), 'PAN_MS=400\nTILT_MS=0\nFOCUS_MS=0\n');
		// A preset move in progress: the lock is held by a live process.
		fs.mkdirSync(sb.file('tmp/ptz_job.lock'));
		fs.writeFileSync(sb.file('tmp/ptz_job.lock/pid'), String(process.pid));
		for (const act of ['zero', 'shift_all&pan_ms=500', 'sync_pos&id=1', 'set_home_here']) {
			const d = sb.run('act=' + act);
			check(act.split('&')[0] + ' waits for a running preset move', d.ok === false && /in progress/.test(d.error || ''),
				JSON.stringify(d));
		}
		check('nothing was rewritten under the move',
			fs.readFileSync(sb.file('etc/ptz_presets.tsv'), 'utf8') === '1|Door|1.0|0|1|1000|200|0\n' &&
			fs.readFileSync(sb.file('tmp/ptz_pos.conf'), 'utf8') === 'PAN_MS=400\nTILT_MS=0\nFOCUS_MS=0\n');
		check('a refused action leaves the move\'s lock in place',
			fs.readFileSync(sb.file('tmp/ptz_job.lock/pid'), 'utf8') === String(process.pid));
	} finally {
		fs.rmSync(sb.dir, { recursive: true, force: true });
	}
}

done();
