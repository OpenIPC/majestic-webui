// The Plugins group of the Services menu, and what an update leaves of it.
//
// A plugin page is registered by being there, so every way this goes wrong is
// a menu that looks like a menu: an entry that is missing, a heading over
// nothing, a name that is markup, or a title the camera ran while drawing the
// bar. The other half is sbin/updatewebui, where the failure is a page that is
// gone after an update nobody connects with it.
//
// The code is taken from the files that ship and run under busybox sh. Where a
// path is replaced, a replacement that no longer matches is a failure.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { check, group, done } = require('./assert');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const scratch = [];
process.on('exit', () => scratch.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function mktmp() {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-'));
	scratch.push(d);
	return d;
}

function shellFn(src, name, file) {
	const start = src.indexOf('\n' + name + '() {');
	const end = src.indexOf('\n}\n', start);
	if (start < 0 || end < 0) throw new Error(name + ' was not found in ' + file + '; this test is testing nothing');
	return src.slice(start + 1, end + 3);
}

function sh(script, env, cwd) {
	const r = spawnSync('busybox', ['sh', '-c', script], {
		cwd: cwd || os.tmpdir(),
		env: Object.assign({ PATH: process.env.PATH }, env),
		encoding: 'utf8',
	});
	if (r.error) throw r.error;
	return { status: r.status, out: r.stdout, err: r.stderr };
}

// --- the menu ---------------------------------------------------------------

const WWW = '/var/www/cgi-bin/';
const pages = read('www/cgi-bin/p/pages.cgi');
const common = read('www/cgi-bin/p/common.cgi');

function menuFns(dir) {
	let s = '';
	for (const name of ['plugin_pages', 'plugin_label']) {
		const fn = shellFn(pages, name, 'p/pages.cgi');
		if (!fn.includes(WWW)) throw new Error(name + ' no longer reads ' + WWW);
		s += fn.split(WWW).join(dir + '/');
	}
	return s + shellFn(common, 'esc', 'p/common.cgi') + shellFn(common, 'attr_escape', 'p/common.cgi') +
		shellFn(pages, 'page_menu', 'p/pages.cgi');
}

// The group's own lines of header.cgi as the shell haserl makes of them: text
// is printed, <% %> is code, <%= %> is echo and <%# %> is nothing.
function menuBlock() {
	const header = read('www/cgi-bin/p/header.cgi');
	const at = header.indexOf('plugins=$(plugin_pages)');
	const start = header.lastIndexOf('<%', at);
	const end = header.indexOf('</ul>', at);
	if (at < 0 || start < 0 || end < 0) throw new Error('the plugin group was not found in p/header.cgi');
	const quote = (t) => "printf '%s' '" + t.replace(/'/g, "'\\''") + "'\n";
	return header.slice(start, end).split(/(<%[\s\S]*?%>)/).map((part) => {
		if (!part.startsWith('<%')) return part ? quote(part) : '';
		const code = part.slice(2, -2);
		if (code[0] === '#') return '';
		return (code[0] === '=' ? 'echo ' + code.slice(1) : code) + '\n';
	}).join('');
}

const page = (title) => '#!/usr/bin/haserl\n<%in p/common.cgi %>\n<%\n' + title + '\n%>\n';

function cgiBin(files) {
	const d = mktmp();
	for (const f of Object.keys(files)) fs.writeFileSync(path.join(d, f), files[f]);
	return d;
}

function menu(dir, cwd, override) {
	const r = sh(menuFns(dir) + (override || '') + menuBlock(), { INJECTED: 'expanded' }, cwd);
	const entries = [];
	const re = /<a class="dropdown-item" href="([^"]*)">([\s\S]*?)<\/a>/g;
	let m;
	while ((m = re.exec(r.out))) entries.push([m[1].replace(/\s/g, ''), m[2]]);
	return { status: r.status, err: r.err, html: r.out, entries: entries };
}

group('a camera with no plugin pages has no group');
{
	for (const [name, files] of [
		['an empty directory', {}],
		['only the WebUI\'s own pages', { 'proxy.cgi': page(''), 'live.cgi': page('') }],
		['only names that do not count', { 'plugin-.cgi': page(''), 'plugin-Big.cgi': page('') }],
	]) {
		const m = menu(cgiBin(files));
		check(name + ': nothing is drawn', m.html.trim() === '' && m.status === 0 && m.err === '', m.html + m.err);
	}
}

group('the group appears with the first page');
{
	const d = cgiBin({ 'plugin-camex.cgi': page('page_title="Camex"') });
	const m = menu(d);
	check('one heading', (m.html.match(/<h6 class="dropdown-header">Plugins<\/h6>/g) || []).length === 1, m.html);
	check('one entry, linking the page', JSON.stringify(m.entries) === '[["plugin-camex.cgi","Camex"]]', m.html);
	fs.unlinkSync(path.join(d, 'plugin-camex.cgi'));
	check('and it goes with the page', menu(d).html.trim() === '');
	check('its browser title sits under Services',
		sh(menuFns(d) + 'page_menu plugin-camex').out === 'Services');
}

group('a name outside a-z0-9- is not a plugin');
{
	const files = { 'plugin-good-2.cgi': page(''), 'plugin-old.cgi.bak': page(''), 'plugins.cgi': page(''), 'xplugin-a.cgi': page('') };
	for (const n of ['', 'Upper', 'under_score', 'a b', 'a.b', 'a"b', 'a<b', 'a&b', 'a;b', 'a$INJECTED', 'a`b', 'a\\b', 'a%41', 'a\nb', 'é'])
		files['plugin-' + n + '.cgi'] = page('page_title="Bad"');
	const d = cgiBin(files);
	fs.mkdirSync(path.join(d, 'plugin-dir.cgi'));
	fs.symlinkSync(path.join(d, 'nowhere'), path.join(d, 'plugin-dangling.cgi'));
	const m = menu(d);
	check('only the well-formed file is listed', JSON.stringify(m.entries) === '[["plugin-good-2.cgi","good-2"]]', m.html);
	check('and nothing is reported on the way', m.err === '', m.err);
}

group('the order is the order of the names');
{
	const m = menu(cgiBin({
		'plugin-zeta.cgi': page('page_title="Aaa"'),
		'plugin-camex.cgi': page('page_title="Zzz"'),
		'plugin-10.cgi': page(''),
		'plugin-pusher.cgi': page('page_title="Mmm"'),
	}));
	check('by file name, whatever the titles say',
		m.entries.map((e) => e[0]).join() === 'plugin-10.cgi,plugin-camex.cgi,plugin-pusher.cgi,plugin-zeta.cgi', m.html);
}

group('the label is the page\'s own page_title');
{
	const label = (body) => menu(cgiBin({ 'plugin-x.cgi': page(body) })).entries[0][1];
	check('a literal title', label('page_title="My plugin"') === 'My plugin');
	check('an indented one', label('\tpage_title="My plugin"  ') === 'My plugin');
	check('the first of two', label('page_title="One"\npage_title="Two"') === 'One');
	check('not ASCII', label('page_title="Камера"') === 'Камера');
	check('none: the bare name', label('') === 'x');
	check('empty: the bare name', label('page_title=""') === 'x');
	check('commented out: the bare name', label('# page_title="No"') === 'x');
	check('single-quoted: the bare name', label("page_title='No'") === 'x');
	check('with code after it: the bare name', label('page_title="No"; reboot') === 'x');
}

group('a title is never expanded or run');
{
	for (const [name, title] of [
		['a variable', '$INJECTED'],
		['a braced variable', '${INJECTED}'],
		['a command substitution', '$(touch canary; echo ran)'],
		['a backquoted command', '`touch canary; echo ran`'],
		['a backslash', 'a\\nb'],
		['an escaped quote', 'a\\"b'],
	]) {
		const cwd = mktmp();
		const m = menu(cgiBin({ 'plugin-x.cgi': page('page_title="' + title + '"') }), cwd);
		check(name + ': the bare name instead', JSON.stringify(m.entries) === '[["plugin-x.cgi","x"]]', m.html);
		check('...and nothing ran', !fs.existsSync(path.join(cwd, 'canary')));
	}
	const cwd = mktmp();
	menu(cgiBin({ 'plugin-x.cgi': '#!/bin/sh\ntouch canary\npage_title="X"\n' }), cwd);
	check('the page itself is not run either', !fs.existsSync(path.join(cwd, 'canary')));
}

group('a title is text, not markup');
{
	const m = menu(cgiBin({ 'plugin-x.cgi': page('page_title="<script>alert(1)</script> & \'co\' %s *"') }));
	check('it is escaped', m.entries.length === 1 &&
		m.entries[0][1] === '&lt;script&gt;alert(1)&lt;/script&gt; &amp; \'co\' %s *', m.html);
}

group('a name that got past the alphabet would still be text');
{
	const m = menu(cgiBin({}), null, "plugin_pages() { printf '%s' 'plugin-a\"><b>&'; }\n");
	check('the link is escaped', m.html.includes('href="plugin-a&quot;&gt;&lt;b&gt;&amp;.cgi"'), m.html);
}

group('only the first 50 lines are read for a title');
{
	const at = (n) => menu(cgiBin({ 'plugin-x.cgi': '\n'.repeat(n - 1) + 'page_title="Found"\n' })).entries[0][1];
	check('line 1 counts', at(1) === 'Found');
	check('line 50 counts', at(50) === 'Found');
	check('line 51 does not', at(51) === 'x');
}

// --- the installer ------------------------------------------------------------

// build_plan only plans: it reads the release, the overlay and the firmware's
// copy, and lists what an install would do. So a tree in a scratch directory
// is a whole camera to it. A whiteout is a device node, which takes root to
// make; a fifo is the same thing to this code, an entry that is not a file.
//
// plan_removals is the same for --restore, so both run on the same camera.
const INSTALLER = read('sbin/updatewebui');

function plan(step, manifest) {
	const d = mktmp();
	const put = (f, text) => {
		fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
		fs.writeFileSync(path.join(d, f), text);
	};
	const cgi = 'upper/var/www/cgi-bin/';
	put('src/www/cgi-bin/live.cgi', 'release\n');
	put(cgi + 'live.cgi', 'release\n');
	put(cgi + 'plugin-camex.cgi', 'plugin\n');
	put(cgi + 'stale.cgi', 'stale\n');
	put(cgi + 'plugins.cgi', 'stale\n');
	put(cgi + 'plugin-old.cgi.bak', 'stale\n');
	put(cgi + 'p/plugin-inc.cgi', 'stale\n');
	put(cgi + 'plugin-d/inc.cgi', 'stale\n');
	put('upper/var/www/a/plugin-x.js', 'stale\n');
	put('upper/var/www/plugin-x.cgi', 'stale\n');
	for (const f of ['plugin-gone.cgi', 'restart.cgi'])
		if (spawnSync('mkfifo', [path.join(d, cgi + f)]).status !== 0) throw new Error('mkfifo failed');
	put('elsewhere.cgi', 'plugin\n');
	fs.symlinkSync(path.join(d, 'elsewhere.cgi'), path.join(d, cgi + 'plugin-linked.cgi'));
	fs.symlinkSync('/nowhere/at/all', path.join(d, cgi + 'plugin-dangling.cgi'));
	fs.mkdirSync(path.join(d, 'tmp'));
	if (manifest !== null) put('manifest', manifest);

	const fns = ['plugin_page', step].map((f) => shellFn(INSTALLER, f, 'sbin/updatewebui')).join('');
	const r = sh(fns + step, {
		src: path.join(d, 'src'), upper: path.join(d, 'upper'), lower: '', tmp: path.join(d, 'tmp'),
		MANIFEST: path.join(d, 'manifest'), PAYLOAD: 'www:/var/www', scr_name: 'updatewebui',
		LEGACY_SHARED: '', variant: '', sms: '0', fpv: '0', ptz: '0', counting: '0',
	});
	const list = (f) => !fs.existsSync(path.join(d, 'tmp', f)) ? null :
		fs.readFileSync(path.join(d, 'tmp', f), 'utf8').split('\n').filter(Boolean)
		.map((l) => l.replace(path.join(d, 'upper'), '')).sort();
	return { status: r.status, err: r.err, prune: list('prune'), atrisk: list('atrisk'), local: list('local'), kept: list('kept') };
}

for (const [name, manifest] of [
	['an update leaves a plugin page alone', null],
	['...and on a camera that has a manifest', '0123456789abcdef0123456789abcdef  /var/www/cgi-bin/nothing.cgi\n'],
]) {
	group(name);
	const p = plan('build_plan', manifest);
	const has = (l, f) => l.includes('/var/www/cgi-bin/' + f);
	check('the plan is made (otherwise this tests nothing)', p.status === 0 && p.prune.length > 0, p.err);
	check('the page is not removed', !has(p.prune, 'plugin-camex.cgi'), p.prune.join(' '));
	check('nor one that is a link to a file', !has(p.prune, 'plugin-linked.cgi'), p.prune.join(' '));
	check('nor counted as a customization to archive',
		!has(p.local, 'plugin-camex.cgi') && !has(p.atrisk, 'plugin-camex.cgi'));
	check('a whiteout of the same name goes', has(p.prune, 'plugin-gone.cgi'), p.prune.join(' '));
	check('so does a link to nothing', has(p.prune, 'plugin-dangling.cgi'), p.prune.join(' '));
	check('and any other whiteout', has(p.prune, 'restart.cgi'), p.prune.join(' '));
	check('a stale page goes', has(p.prune, 'stale.cgi'), p.prune.join(' '));
	for (const f of ['plugins.cgi', 'plugin-old.cgi.bak', 'p/plugin-inc.cgi', 'plugin-d/inc.cgi'])
		check(f + ' is not a plugin page and goes', has(p.prune, f), p.prune.join(' '));
	check('only cgi-bin is reserved', p.prune.includes('/var/www/a/plugin-x.js') &&
		p.prune.includes('/var/www/plugin-x.cgi'), p.prune.join(' '));
	check('what the release ships stays', !has(p.prune, 'live.cgi'), p.prune.join(' '));
}

for (const [name, manifest, swept] of [
	['--restore on a camera with no manifest leaves it too', null, true],
	['...and with one', '0123456789abcdef0123456789abcdef  /var/www/cgi-bin/nothing.cgi\n', false],
	['...and after an earlier --restore emptied it', '', false],
]) {
	group(name);
	const p = plan('plan_removals', manifest);
	const has = (l, f) => l.includes('/var/www/cgi-bin/' + f);
	check('the plan is made (otherwise this tests nothing)', p.status === 0 && p.prune.length > 0, p.err);
	check('the page is not removed', !has(p.prune, 'plugin-camex.cgi'), p.prune.join(' '));
	check('nor one that is a link to a file', !has(p.prune, 'plugin-linked.cgi') && has(p.kept, 'plugin-linked.cgi'), p.prune.join(' '));
	check('and is reported as left in place', has(p.kept, 'plugin-camex.cgi'), p.kept.join(' '));
	for (const f of ['plugin-gone.cgi', 'plugin-dangling.cgi', 'restart.cgi'])
		check(f + ', not a file, goes', has(p.prune, f), p.prune.join(' '));
	// Without a record everything else still goes; with one, only what it names.
	for (const f of ['live.cgi', 'stale.cgi', 'plugins.cgi', 'plugin-old.cgi.bak', 'p/plugin-inc.cgi', 'plugin-d/inc.cgi'])
		check(f + (swept ? ' goes' : ' stays'), has(p.prune, f) === swept, p.prune.join(' '));
}

done();
