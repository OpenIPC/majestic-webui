// The dist build's comment stripper, which is also the gate that refuses to
// ship one (check-no-comments.js tests `stripFile(src) === src`).
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
const { stripCgi, stripFile, isShellScript } = require('../tools/strip-cgi-comments.js');

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

// One command line can open more than one, and the second body begins where
// the first delimiter ended. Remembering only the first left B's body looking
// like shell -- which would strip a comment out of emitted text and, worse,
// read data as code.
check('two heredocs on one command: both bodies are output',
	S('<%\ncat <<A <<B\n<!-- gone -->\nkeep a\nA\n<!-- also gone -->\nkeep b\nB\n%>') ===
	'<%\ncat <<A <<B\nkeep a\nA\nkeep b\nB\n%>');

check('a # line in the second body is data, not a comment',
	S('<%\ncat <<A <<B\nfirst\nA\n#id { a: b }\nB\n%>').includes('#id { a: b }'));

group('strip-cgi-comments: what fails loudly');

// A `<<` mistaken for a heredoc opener swallows the rest of the file as body.
// Guessing there is how a stripper silently deletes code, so it throws.
let threw = false;
try { S('<%\ncat <<EOF\nbody\n%>'); } catch (e) { threw = /never closed/.test(e.message); }
check('unclosed heredoc throws', threw);

threw = false;
try { S('<% x=1'); } catch (e) { threw = /never closed/.test(e.message); }
check('unclosed <% throws', threw);

group('strip-cgi-comments: plain scripts');

const F = (src, name) => stripFile(src, name || 'j/x.cgi');

// The fault this group exists for: a j/*.cgi has no <%, so it was read as a
// template with no code in it and came back byte for byte, comments and all --
// and the gate, asking the same function, agreed.
check('a #!/bin/sh .cgi loses its comments',
	F('#!/bin/sh\n# gone\necho "{}"\n') === '#!/bin/sh\necho "{}"\n');

check('so does an extensionless script in sbin/',
	F('#!/bin/sh\n# gone\nx=1\n', 'sbin/telegram') === '#!/bin/sh\nx=1\n');

check('and a sourced .sh library',
	F('#!/bin/sh\n# gone\nf() { :; }\n', 'p/majestic.sh') === '#!/bin/sh\nf() { :; }\n');

// In a script a heredoc writes a message, a reply or a file; <!-- there is data.
check('a script\'s heredoc body is left whole, <!-- included',
	F('#!/bin/sh\ncat <<EOF\n<!-- keep -->\n#keep\nEOF\n').includes('<!-- keep -->\n#keep'));

// After a trailing backslash, the comment is what ends the command; lifting it
// out would run the next line as its argument.
check('a comment after a continued line stays',
	F('#!/bin/sh\nrm -f a \\\n# stop\nreboot\n') === '#!/bin/sh\nrm -f a \\\n# stop\nreboot\n');

check('a data file in j/ is untouched',
	F('mj_audio=Audio\n', 'j/locale.cgi') === 'mj_audio=Audio\n');

check('a haserl template is still a template',
	F('#!/usr/bin/haserl\n<%\n# gone\n%>\n<!-- gone -->\n', 'x.cgi') === '#!/usr/bin/haserl\n<%\n%>\n');

check('shebang recognition',
	isShellScript('#!/bin/sh\n') && isShellScript('#!/bin/sh -e\n') &&
	isShellScript('#!/bin/ash') && !isShellScript('#!/usr/bin/haserl\n') &&
	!isShellScript('#!/usr/bin/env node\n') && !isShellScript('# not one\n'));

group('strip-cgi-comments: idempotent, and real files survive it');

const root = path.join(__dirname, '..');
const files = [];
const scripts = [];
(function walk(d) {
	for (const e of fs.readdirSync(d, { withFileTypes: true })) {
		const p = path.join(d, e.name);
		if (e.isDirectory()) walk(p);
		else if (p.endsWith('.cgi')) files.push(p);
		else if (p.endsWith('.sh')) scripts.push(p);
	}
})(path.join(root, 'www', 'cgi-bin'));
for (const d of ['sbin', 'bin']) {
	for (const n of fs.readdirSync(path.join(root, d))) scripts.push(path.join(root, d, n));
}

check('found the templates', files.length > 50, `${files.length} found`);

let stable = 0;
let shrank = 0;
for (const f of files) {
	const src = fs.readFileSync(f, 'utf8');
	const once = stripFile(src, f);
	if (stripFile(once, f) === once) stable++;
	if (once.length < src.length) shrank++;
}
check('stripping twice changes nothing the second time', stable === files.length,
	`${stable}/${files.length}`);
check('it actually removes something', shrank > 0, `${shrank} files shrank`);

// Every script that ships is one the build now edits, so every one of them must
// be recognised as a script -- one that is not ships its comments silently.
const missed = scripts.filter((f) => {
	const src = fs.readFileSync(f, 'utf8');
	return !isShellScript(src) || stripFile(src, f) === src;
});
check('every script in sbin/, bin/ and p/*.sh is recognised and stripped',
	scripts.length > 15 && !missed.length,
	missed.length ? missed.map((f) => path.relative(root, f)).join(', ') : `${scripts.length} found`);

done();
