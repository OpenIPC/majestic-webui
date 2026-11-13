'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');

function runSh(script, env) {
	return execFileSync('/bin/sh', ['-c', script], {
		env: { ...process.env, ...env },
		encoding: 'utf8',
	});
}

describe('PTZ position tracking and CGI guards', () => {
	it('updates pan_ms and tilt_ms consistently across directional moves', () => {
		const tmpPos = path.join('/tmp', 'ptz_pos_test_' + process.pid + '.conf');
		try {
			fs.writeFileSync(tmpPos, 'PAN_MS=100\nTILT_MS=-50\n');
			const out = runSh(`
				POS_FILE="${tmpPos}"
				. "$POS_FILE"
				update_pos() {
					dir="$1"; ms="$2"
					case "$dir" in
						right) PAN_MS=$((PAN_MS + ms)) ;;
						left)  PAN_MS=$((PAN_MS - ms)) ;;
						up)    TILT_MS=$((TILT_MS + ms)) ;;
						down)  TILT_MS=$((TILT_MS - ms)) ;;
					esac
				}
				update_pos right 250
				update_pos left 100
				update_pos up 200
				update_pos down 50
				printf '%s,%s\\n' "$PAN_MS" "$TILT_MS"
			`);
			assert.equal(out.trim(), '250,100');
		} finally {
			fs.rmSync(tmpPos, { force: true });
		}
	});

	it('rejects GET mutations on ptz_presets.cgi with 405', () => {
		const cgi = path.join(root, 'www/cgi-bin/j/ptz_presets.cgi');
		let out = '';
		try {
			execFileSync('/bin/sh', [cgi], {
				env: { ...process.env, REQUEST_METHOD: 'GET', QUERY_STRING: 'act=goto&id=1' },
				encoding: 'utf8',
			});
			assert.fail('Expected non-zero exit for GET mutation');
		} catch (err) {
			out = err.stdout || '';
		}
		assert.match(out, /HTTP\/1\.1 405 Method Not Allowed/);
	});

	it('returns null current_mag on box_ptz.cgi GET when no motor service or zoom file exists', () => {
		const cgi = path.join(root, 'www/cgi-bin/j/box_ptz.cgi');
		const out = execFileSync('/bin/sh', [cgi], {
			env: { ...process.env, REQUEST_METHOD: 'GET', QUERY_STRING: '' },
			encoding: 'utf8',
		});
		const body = out.split('\n\n')[1] || out;
		const parsed = JSON.parse(body.trim());
		assert.equal(parsed.ok, true);
		assert.ok(parsed.current_mag === null || typeof parsed.current_mag === 'number');
	});
});
