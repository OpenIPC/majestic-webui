#!/usr/bin/env node
// Point rc-check.js at a real camera and print what the page would say.
//
// The unit test feeds it a hand-written metrics map. This feeds it the bytes a
// camera actually serves, parsed the way main.js parses them, so a rename on
// either side shows up as silence here rather than as a green suite.
//
//   node tools/rc-live-check.mjs http://<camera> [channel]
//
// A developer tool run against a running camera, not a CI job: /metrics is
// unauthenticated, so this needs no credentials, but it does need a camera
// whose majestic publishes venc*_rc_state.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const rc = require(path.join(here, '..', 'www', 'a', 'rc-check.js'));

const base = (process.argv[2] || '').replace(/\/$/, '');
const chn = Number(process.argv[3] || 0);
if (!base) {
	console.error('usage: node tools/rc-live-check.mjs http://<camera> [channel]');
	process.exit(2);
}

// main.js's parser, in the one shape that matters here: unlabelled gauge to
// number, first write wins, comment lines skipped. Kept deliberately small --
// borrowing the real one would mean loading a browser global.
function parseMetrics(text) {
	const v = Object.create(null);
	for (const line of text.split('\n')) {
		if (!line || line[0] === '#') continue;
		const sp = line.indexOf(' ');
		if (sp < 0) continue;
		const k = line.slice(0, sp);
		if (k.includes('{') || k in v) continue;
		const n = Number(line.slice(sp + 1));
		if (!Number.isNaN(n)) v[k] = n;
	}
	return v;
}

const [venc, cfg] = await Promise.all([
	fetch(base + '/metrics/venc').then((r) => r.text()),
	fetch(base + '/api/v1/config.json')
		.then((r) => (r.ok ? r.json() : null))
		.catch(() => null),
]);

const v = parseMetrics(venc);
const s = { ok: true, fails: 0, m: { v } };
const chCfg = cfg && cfg['video' + chn]
	? { bitrate: cfg['video' + chn].bitrate, fps: cfg['video' + chn].fps }
	: null;

const keys = ['rc_state', 'mean_qp', 'max_qp', 'encoded_frames_total', 'rcvd_bytes'];
console.log('what the camera published:');
for (const k of keys) {
	const key = 'venc' + chn + '_' + k;
	console.log('  ' + key + ' = ' + (key in v ? v[key] : '(absent)'));
}
console.log('  configured: ' + JSON.stringify(chCfg));

const f = rc.diagnose(s, chCfg, chn);
console.log('\nwhat the settings page would show:');
console.log(f ? '  [' + f.level + '] ' + f.title + '\n  ' + f.detail : '  (nothing)');
console.log('\nwhat the dashboard tile would show:');
const n = rc.note(s, chCfg, chn);
console.log(n ? '  ' + n : '  (nothing)');

// A camera publishing a verdict this cannot turn into a sentence is the
// failure worth exiting on: it means the two sides have drifted apart.
const state = rc.readState(v, chn);
if (state !== null && state !== rc.OK && !f) {
	console.error('\nFAIL: camera says ' + state + ' and the page says nothing');
	process.exit(1);
}
