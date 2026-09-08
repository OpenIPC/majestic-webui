// The dist build's comment stripper, which is also the gate that refuses to
// ship one (check-no-comments.js tests `stripCgi(src) === src`).
//
// Every failure mode here is silent in the direction that matters. Stripping
// too little costs bytes and nobody notices. Stripping too MUCH edits a shell
// script that will run as root on a camera, and the damage does not look like
// a comment bug: a `#` line lifted out of a heredoc body is a CSS rule that
// stopped existing, and one lifted out of an unterminated quote is a truncated
// command. Neither shows up until a page is opened on hardware.
//
// So the cases below are mostly about what must SURVIVE.
'use strict';

const path = require('path');
const fs = require('fs');
const { check, group, done } = require('./assert');
const { stripCgi } = require('../tools/strip-cgi-comments.js');

const S = (src) => stripCgi(src, '<test>');

group('strip-cgi-comments: what goes');

check('HTML comment in literal text',
	S('<p>a</p>\n<!-- gone -->\n<p>b</p>\n') === '<p>a</p>\n<p>b</p>\n');

check('haserl <%# %> comment',
	S('<p>a</p>\n<%# gone %>\n<p>b</p>\n') === '<p>a</p>\n<p>b</p>\n');

check('whole-line shell comment',
	S('<%\n# gone\nx=1\n%>') === '<%\nx=1\n%>');

check('HTML comment inside a heredoc body',
	S('<%\ncat <<EOF\n<div>\n<!-- gone -->\n</div>\nEOF\n%>') ===
	'<%\ncat <<EOF\n<div>\n</div>\nEOF\n%>');

check('multi-line HTML comment',
	S('<a>\n<!-- one\n     two -->\n<b>\n') === '<a>\n<b>\n');

group('strip-cgi-comments: what stays');

// The one comment in this tree addressed to whoever FETCHES the page.
check('<!--! is content, not a comment',
	S('<!--! note to the reader -->\n').includes('note to the reader'));

// `#` after a word is not a comment opener, and ${v#pfx} is not one either.
check('trailing # is left alone',
	S('<%\nx=1 # keep\n%>') === '<%\nx=1 # keep\n%>');

check('${v#pfx} survives',
	S('<%\ny=${v#pfx}\n%>') === '<%\ny=${v#pfx}\n%>');

// A heredoc body is output, so a line starting with # is a CSS id selector.
check('# line inside a heredoc body is data',
	S('<%\ncat <<EOF\n#mj-stage { inset: 0 }\nEOF\n%>')
		.includes('#mj-stage { inset: 0 }'));

// Same for a quoted delimiter, which is the form this tree now uses.
check('quoted heredoc delimiter behaves the same',
	S("<%\ncat <<'EOF'\n#id { a: b }\n<!-- gone -->\nEOF\n%>") ===
	"<%\ncat <<'EOF'\n#id { a: b }\nEOF\n%>");

// A line that begins inside an unclosed quote is data mid-string.
check('# inside a multi-line string is not a comment',
	S('<%\nx="one\n# two\nthree"\n%>') === '<%\nx="one\n# two\nthree"\n%>');

check('<%= %> is left exactly alone',
	S('<%= $mj_version %>') === '<%= $mj_version %>');

check('an apostrophe in a comment cannot open a quote',
	S("<%\n# don't do this\nx=1\n%>") === '<%\nx=1\n%>');

group('strip-cgi-comments: what fails loudly');

// A `<<` mistaken for a heredoc opener swallows the rest of the file as body.
// Guessing there is how a stripper silently deletes code, so it throws.
let threw = false;
try { S('<%\ncat <<EOF\nbody\n%>'); } catch (e) { threw = /never closed/.test(e.message); }
check('unclosed heredoc throws', threw);

threw = false;
try { S('<% x=1'); } catch (e) { threw = /never closed/.test(e.message); }
check('unclosed <% throws', threw);

group('strip-cgi-comments: idempotent, and real files survive it');

const dir = path.join(__dirname, '..', 'www', 'cgi-bin');
const files = [];
(function walk(d) {
	for (const e of fs.readdirSync(d, { withFileTypes: true })) {
		const p = path.join(d, e.name);
		if (e.isDirectory()) walk(p);
		else if (p.endsWith('.cgi')) files.push(p);
	}
})(dir);

check('found the templates', files.length > 50, `${files.length} found`);

let stable = 0;
let shrank = 0;
for (const f of files) {
	const src = fs.readFileSync(f, 'utf8');
	const once = stripCgi(src, f);
	if (stripCgi(once, f) === once) stable++;
	if (once.length < src.length) shrank++;
}
check('stripping twice changes nothing the second time', stable === files.length,
	`${stable}/${files.length}`);
check('it actually removes something', shrank > 0, `${shrank} files shrank`);

done();
