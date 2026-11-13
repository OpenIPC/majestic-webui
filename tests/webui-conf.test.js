// Changing the theme must not take the rest of webui.conf with it.
//
// `/etc/webui/webui.conf` is where a camera's own decisions about the web
// interface live -- the ones that have to survive `updatewebui` replacing the
// whole of /var/www. There are two keys in it today: the theme, which the
// interface writes, and `webui_lpr_base`, which the owner adds by hand to
// point the plate reader at a mirror of their own.
//
// The theme was written with `echo ... > "$config_file"`, which truncates. So
// picking a different theme deleted that mirror, and the only symptom was a
// camera quietly going back to the public CDN -- or, on one with no route to
// it, a Plates tab that had stopped existing. No error, nothing in a log, and
// the file it came from is not one anybody thinks to look at after changing a
// colour.
//
// The write is shell and shell is what runs here: the function is taken out of
// the CGI that ships and driven with a real `sh`, because asserting against a
// JavaScript transcription of it would test the transcription.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { check, group, done } = require('./assert');

const CGI = path.join(__dirname, '..', 'www', 'cgi-bin', 'access.cgi');
const src = fs.readFileSync(CGI, 'utf8');
const fn = src.slice(src.indexOf('set_webui_conf() {'),
	src.indexOf('if [ "$REQUEST_METHOD" = "POST" ]'));
if (!fn || fn.indexOf('mv "$_tmp"') < 0)
	throw new Error('set_webui_conf was not found in the CGI; this test is testing nothing');

// The case arm that calls it, so what is tested is the call the page makes
// rather than a call invented here.
const arm = src.slice(src.indexOf('\t\ttheme)'), src.indexOf('update_caminfo\n\t\t\tredirect_back'));
if (arm.indexOf('set_webui_conf webui_theme') < 0)
	throw new Error('the theme arm no longer calls set_webui_conf');

function run(before, body) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webuiconf-'));
	const conf = path.join(dir, 'webui.conf');
	if (before !== null) fs.writeFileSync(conf, before);
	const script = 'config_file=' + JSON.stringify(conf) + '\n' + fn + '\n' + body + '\n';
	try {
		execFileSync('sh', ['-c', script], { encoding: 'utf8' });
		return fs.existsSync(conf) ? fs.readFileSync(conf, 'utf8') : null;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// What the page really runs, with the redirect and update_caminfo stubbed.
const themeArm = 'POST_webui_theme="$1"\n' + arm
	.replace(/^\t\ttheme\)/, '')
	.replace(/redirect_back[^\n]*/g, ':')
	.replace(/update_caminfo/g, ':');

group('the mirror survives a change of theme');

let out = run('webui_theme="dark"\nwebui_lpr_base="https://example.invalid/lpr/"\n',
	'set_webui_conf webui_theme light');
check('the theme is the new one',
	/^webui_theme="light"$/m.test(out), JSON.stringify(out));
check('and the plate reader base is still there',
	/^webui_lpr_base="https:\/\/example\.invalid\/lpr\/"$/m.test(out), JSON.stringify(out));
check('with no duplicate theme line left behind',
	(out.match(/^webui_theme=/gm) || []).length === 1, JSON.stringify(out));

out = run('webui_theme="dark"\nwebui_lpr_base="https://example.invalid/lpr/"\n',
	themeArm.replace('"$1"', '"auto"'));
check('and the page\'s own arm does the same thing',
	/webui_theme="auto"/.test(out) && /webui_lpr_base=/.test(out), JSON.stringify(out));

group('the file is still a file whatever state it was in');

out = run(null, 'set_webui_conf webui_theme dark');
check('a missing file is created rather than failing',
	out === 'webui_theme="dark"\n', JSON.stringify(out));

out = run('', 'set_webui_conf webui_theme dark');
check('an empty one gains exactly one line',
	out === 'webui_theme="dark"\n', JSON.stringify(out));

out = run('webui_lpr_base="https://example.invalid/lpr/"\n', 'set_webui_conf webui_theme dark');
check('a file with no theme in it gets one, keeping what was there',
	/webui_lpr_base=/.test(out) && /webui_theme="dark"/.test(out), JSON.stringify(out));

// A key whose name is a prefix of another must not be matched by mistake:
// anchoring on the name alone would have `webui_theme` eat `webui_theme_extra`.
out = run('webui_theme_extra="keep"\nwebui_theme="dark"\n', 'set_webui_conf webui_theme light');
check('a key whose name merely starts the same is left alone',
	/webui_theme_extra="keep"/.test(out) && /^webui_theme="light"$/m.test(out),
	JSON.stringify(out));

group('no temporary file is left lying in /etc');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webuiconf-'));
const conf = path.join(dir, 'webui.conf');
fs.writeFileSync(conf, 'webui_theme="dark"\n');
execFileSync('sh', ['-c', 'config_file=' + JSON.stringify(conf) + '\n' + fn +
	'\nset_webui_conf webui_theme light\n'], { encoding: 'utf8' });
check('the directory holds the config and nothing else',
	fs.readdirSync(dir).join(',') === 'webui.conf', fs.readdirSync(dir).join(','));
fs.rmSync(dir, { recursive: true, force: true });

done();
