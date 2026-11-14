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

done();
