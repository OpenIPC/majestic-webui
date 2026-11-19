// Where a value from a link or a stored file reaches the owner's page, and
// what it is allowed to become there.
//
// A signed-in owner who follows a link to /login.html?next=... is forwarded by
// that page itself, so whatever the forwarded-to page reflects runs as script
// in the camera's origin -- same-origin, past every cross-site check majestic
// makes. Each case here is one of those reflections or the forward itself, and
// none of them fails loudly: the page renders, with something extra in it.
// The functions are taken from the files that ship, as shell-quoting.test.js
// does, and the shell ones run under busybox sh.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { check, group, done } = require('./assert');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function shellFn(src, name, file) {
	const start = src.indexOf(name + '() {');
	if (start < 0) throw new Error(name + ' was not found in ' + file + '; this test is testing nothing');
	return src.slice(start, src.indexOf('\n}\n', start) + 3);
}

function sh(script, env) {
	const r = spawnSync('busybox', ['sh', '-c', script], {
		env: { PATH: process.env.PATH, ...env },
		encoding: 'utf8',
	});
	return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}

group('login.html forwards only to this camera');
{
	const html = read('www/login.html');
	const start = html.indexOf('function safeNext() {');
	check('safeNext is in login.html (otherwise this tests nothing)', start >= 0);
	let depth = 0, end = start;
	for (let i = html.indexOf('{', start); i < html.length; i++) {
		if (html[i] === '{') depth++;
		else if (html[i] === '}' && --depth === 0) { end = i + 1; break; }
	}
	const fn = html.slice(start, end);
	const origin = 'http://192.0.2.10';
	const next = (raw) => {
		const location = new URL(origin + '/login.html?next=' + encodeURIComponent(raw));
		return vm.runInNewContext(fn + '; safeNext()', { location, URL, URLSearchParams });
	};
	const home = '/cgi-bin/live.cgi';
	for (const [name, raw] of [
		['a tab before the second slash', '/\t/evil.example'],
		['a line feed there', '/\n/evil.example'],
		['a carriage return there', '/\r/evil.example'],
		['a scheme-relative URL', '//evil.example'],
		['a backslash', '/\\evil.example'],
		['an absolute URL', 'https://evil.example/'],
		['a javascript: URL', 'javascript:alert(1)'],
		['this page itself', '/login.html?next=/x'],
	]) check(name + ' goes home', next(raw) === home, next(raw));
	check('a page on this camera is kept, query and all',
		next('/cgi-bin/network.cgi?confirm=ab12#mac') === '/cgi-bin/network.cgi?confirm=ab12#mac');
	check('nothing goes home', next('') === home);
}

group('the file editor shows a file, never runs it');
{
	const src = read('www/cgi-bin/p/common.cgi');
	const fn = shellFn(src, 'field_textedit', 'p/common.cgi');
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'textedit-'));
	const f = path.join(d, 'f');
	fs.writeFileSync(f, 'a & b </textarea><script>alert(1)</script>\n');
	const out = sh(fn + 'field_textedit t T "' + f + '"', {}).out;
	check('the field renders (otherwise this tests nothing)', /<textarea id="t"/.test(out), out);
	check('a </textarea> in the file does not end the textarea', !out.includes('</textarea><script>'), out);
	check('...it is shown as text', out.includes('&lt;/textarea&gt;&lt;script&gt;'), out);
	check('an & is kept as one, so saving does not change it', out.includes('a &amp; b'), out);
	fs.rmSync(d, { recursive: true, force: true });
}

group('a redirect is one Location header');
{
	const src = read('www/cgi-bin/p/common.cgi');
	const fn = shellFn(src, 'redirect_to', 'p/common.cgi');
	const out = sh('log_create() { :; }\n' + fn + 'redirect_to "$T"', { T: 'editor.cgi?f=/x\r\nSet-Cookie: a=b' }).out;
	check('the target keeps no line break', !/\nSet-Cookie/.test(out), JSON.stringify(out));
	check('...and is still sent', /^Location: editor\.cgi\?f=\/xSet-Cookie: a=b$/m.test(out), JSON.stringify(out));
}

group('a preset name is one row, whatever it holds');
{
	const src = read('www/cgi-bin/j/ptz_presets.cgi');
	const fn = shellFn(src, 'upsert_preset_row', 'j/ptz_presets.cgi');
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'presets-'));
	const file = path.join(d, 'p.tsv');
	fs.writeFileSync(file, '1|Gate|1.0|1|1|0|0|\n');
	// The name as it reaches the row: control characters and | are already
	// gone, but a backslash sequence is not, and awk -v decoded it.
	const row = '2|x\\n9<img src=x onerror=alert(1)>|1.0|1|1|0|0|';
	sh(fn + 'upsert_preset_row 2 "$ROW"', { PRESETS_FILE: file, ROW: row });
	const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
	check('two rows, not three', lines.length === 2, lines.join(' / '));
	check('...the new one exactly as given', lines[1] === row, lines[1]);
	fs.rmSync(d, { recursive: true, force: true });
}

group('pages that write a request value into a script block narrow it first');
{
	for (const f of ['www/cgi-bin/camera.cgi', 'www/cgi-bin/wfb.cgi']) {
		const s = read(f);
		const at = s.indexOf('label="$GET_tab"');
		check(f + ' reads ?tab= (otherwise this tests nothing)', at >= 0);
		check(f + ' narrows it on the next line', /^case "\$label" in$/m.test(s.slice(at, at + 400)), s.slice(at, at + 200));
	}
}

done();
