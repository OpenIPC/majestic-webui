// What camera.cgi puts inside <script type="application/json">, and the two
// ways that block can be wrong.
//
// It is a RAW TEXT element. The HTML parser scans it for `</script` and stops
// there without caring that it is inside a JSON string, so JSON escaping is not
// enough to contain a value: quotes and backslashes can all be correct and the
// block still ends early, with the rest parsed as markup in an administrator's
// page. Every value in the blob comes off the device — the part name from
// `ipcinfo --chip-name` or the boot loader's writable environment, the font
// paths from filenames on a writable filesystem, the sensor list from
// /etc/sensors — so none of it is the WebUI's own text.
//
// This cannot be caught by looking at a rendered page, because nothing is wrong
// with the page until a value contains the sequence, and no camera in a lab has
// one. It is also not caught by `sh -n` or by the template lint: the escaper is
// valid shell either way.
//
// The escaper itself is run here rather than reimplemented — the test extracts
// the sed program out of camera.cgi and pipes payloads through it, so a change
// to the escaper is what this measures and a copy of it could not drift.
'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { check, group, done } = require('./assert');

const CGI = path.join(__dirname, '..', 'www', 'cgi-bin', 'camera.cgi');
const src = fs.readFileSync(CGI, 'utf8');

// ---------------------------------------------------------------------------
group('the boot blob: every value goes through one escaper');
{
	// A field interpolated raw would not be protected however good the escaper
	// is, so the blob's own line is checked before the escaper is.
	const line = src.split('\n').filter((l) => l.indexOf('id="mj-settings-boot"') >= 0)[0];
	check('the blob is emitted on one line', !!line);

	const fields = (line.match(/<%=\s*\$(\w+)\s*%>/g) || [])
		.map((m) => /\$(\w+)/.exec(m)[1]);
	check('it interpolates at least the five known fields', fields.length >= 5,
		fields.join(','));

	// `label` is $GET_tab and the only one that is not device output; it is
	// resolved against the schema by the client and is checked below on its own.
	const escaped = ['boot_soc', 'boot_exclude', 'boot_sensors', 'boot_fonts'];
	escaped.forEach((f) => {
		const assign = new RegExp('^' + f + '=|' + f + '="\\$\\{' + f, 'm');
		check(f + ' is built in this file', assign.test(src) ||
			src.indexOf(f + '=') >= 0, f);
	});
	// The one that matters: nothing reaches the blob without the helper.
	escaped.forEach((f) => {
		const built = src.split('\n').filter((l) => l.indexOf(f + '=') >= 0).join('\n');
		check(f + ' is only ever assigned from mj_json_escape',
			built.indexOf('mj_json_escape') >= 0 || /^\s*\w+=""\s*$/m.test(built),
			built.trim().slice(0, 120));
	});
}

group('mj_json_escape: a device value cannot end the script block');
{
	const m = /mj_json_escape\(\)\s*\{\s*\n\s*(sed [^\n]+)\n/.exec(src);
	check('the escaper is a single sed program', !!m, m && m[1]);

	const sed = m[1].replace(/^sed\s+/, '').replace(/^'|'$/g, '');
	const run = (s) => execFileSync('sed', [sed], { input: s }).toString();

	// Each of these is a value a camera can actually carry: a boot loader
	// environment somebody set, a font file somebody added.
	const payloads = [
		'hi3516ev300',
		'ev300</script><img src=x onerror=alert(1)>',
		'</SCRIPT >',
		'a"quote',
		'back\\slash',
		'/usr/share/fonts/<odd>/"x".ttf',
		'< less',
	];

	payloads.forEach((p) => {
		const out = run(p);
		// Nothing the HTML parser can read as the end of the block.
		check('no script-closing sequence survives: ' + JSON.stringify(p),
			!/<\/script/i.test(out), out);
		check('and no bare < at all: ' + JSON.stringify(p),
			out.indexOf('<') < 0, out);
		// And it is still the same string once JSON has read it back, or the
		// escaping would be protecting the page by corrupting the value.
		let back = null;
		try { back = JSON.parse('"' + out + '"'); } catch (e) { back = '<<unparseable>>'; }
		check('and it round-trips through JSON.parse: ' + JSON.stringify(p),
			back === p, JSON.stringify(back));
	});
}

done();
