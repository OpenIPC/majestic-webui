// `local` outside a function, which every other check in this repo lets past.
//
// It is legal in a function and a RUNTIME error at top level: ash prints
// "local: not in a function" and ABORTS THE SCRIPT there. So the page does not
// misbehave, it stops -- everything after that line is simply never emitted.
// Live came back 9,780 bytes instead of 31,952, with the whole player missing
// and one line on a stderr nobody reads, from a partial that had just been
// lifted out of a function.
//
// Nothing caught it. `sh -n` is a SYNTAX check and this is valid syntax;
// haserl -d then sh -n, which is what tools/lint-templates.sh runs over every
// template, accepts it for the same reason. Only rendering the page and
// looking at the output did.
//
// The rule: `local` is legal only with a function open. Scope is tracked by
// brace groups, and only a group opened by a `name()` definition counts --
// a bare { } group at top level is not a function and `local` in one is the
// same error.
//
// Deliberately narrow, like the gates in pr_compliance_checklist.yaml: it
// looks for `local` in command position at the start of a line, which is how
// all 93 of the real ones in this tree are written. A `x=1; local y` would be
// missed. That is a worthwhile trade for a check with no false positives --
// the ones it would catch are the ones people actually write.
'use strict';

const fs = require('fs');
const path = require('path');
const { check, group, done } = require('./assert');
const { shellLines } = require('../tools/strip-cgi-comments.js');

const ROOT = path.join(__dirname, '..');

function firstLine(p) {
	const fd = fs.openSync(p, 'r');
	try {
		const buf = Buffer.alloc(64);
		const n = fs.readSync(fd, buf, 0, 64, 0);
		return buf.slice(0, n).toString('latin1').split('\n')[0];
	} finally {
		fs.closeSync(fd);
	}
}

/* Tokens of a line that are OUTSIDE quotes, with any trailing comment cut.
 * Quoted characters survive as NULs so that a brace inside `awk '{...}'` or a
 * "}" in a string can never be mistaken for shell's own. */
function bareTokens(line) {
	const out = [];
	let cur = '';
	let q = null;
	let esc = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (esc) { esc = false; cur += '\0'; continue; }
		if (q) {
			if (q === '"' && c === '\\') { esc = true; continue; }
			if (c === q) q = null;
			cur += '\0';
			continue;
		}
		if (c === '\\') { esc = true; continue; }
		if (c === "'" || c === '"') { q = c; cur += '\0'; continue; }
		/* A parameter expansion is one word however much whitespace is inside
		 * it, and its closing brace is not shell's. ${inet#* } ends in "space
		 * brace" and split naively it hands back a bare } that closes whatever
		 * function is open -- which is exactly how this check first accused
		 * network.cgi of a `local` that is properly inside one. */
		if (c === '$' && line[i + 1] === '{') {
			let depth = 0;
			for (; i < line.length; i++) {
				if (line[i] === '{') depth++;
				else if (line[i] === '}' && --depth === 0) break;
				cur += '\0';
			}
			cur += '\0';
			continue;
		}
		if (c === '#' && (i === 0 || /[ \t;&|(]/.test(line[i - 1]))) break;
		if (c === ' ' || c === '\t') { if (cur) { out.push(cur); cur = ''; } continue; }
		cur += c;
	}
	if (cur) out.push(cur);
	return out;
}

const FN_DEF = /^[A-Za-z_][A-Za-z0-9_]*\(\)$/;

/* [{ line, text }] of offending lines. */
function localsOutsideFunctions(src, where) {
	const findings = [];
	const stack = [];
	let pendingFn = false;
	for (const { line, text } of shellLines(src, where)) {
		if (/^[ \t]*local([ \t]|$)/.test(text) && !stack.includes('fn')) {
			findings.push({ line, text: text.trim() });
		}
		const toks = bareTokens(text);
		if (toks.some((t) => FN_DEF.test(t))) pendingFn = true;
		for (const t of toks) {
			if (t === '{') { stack.push(pendingFn ? 'fn' : 'grp'); pendingFn = false; }
			else if (t === '}') stack.pop();
		}
	}
	return findings;
}

const S = (src) => localsOutsideFunctions(src, '<test>');

group('local outside a function: what is caught');

check('top level of a code block',
	S('<%\nlocal x\n%>').length === 1);

check('after a function has closed',
	S('<%\nf() {\n\tlocal ok\n}\nlocal bad\n%>').length === 1);

check('a bare brace group is not a function',
	S('<%\n{\n\tlocal bad\n}\n%>').length === 1);

check('a plain shell script with no code block',
	S('#!/bin/sh\nlocal bad\n').length === 1);

group('local outside a function: what is not');

check('inside a function',
	S('<%\nf() {\n\tlocal ok\n}\n%>').length === 0);

check('inside an indented function (update.cgi has one)',
	S('<%\nif true; then\n\tg() {\n\t\tlocal ok\n\t}\nfi\n%>').length === 0);

check('inside a nested function',
	S('<%\nf() {\n\tg() {\n\t\tlocal ok\n\t}\n\tlocal also\n}\n%>').length === 0);

check('in a shell comment',
	S('<%\n# no local here, this is prose\n%>').length === 0);

check('in literal markup',
	S('<p>local weather</p>\n<%\nx=1\n%>').length === 0);

check('in a heredoc body',
	S('<%\ncat <<EOF\nlocal conditions apply\nEOF\n%>').length === 0);

check('a brace inside a quoted awk program does not close a function',
	S('<%\nf() {\n\tawk \'{print}\' /dev/null\n\tlocal ok\n}\n%>').length === 0);

check('${v} is not a closing brace',
	S('<%\nf() {\n\ty=${v}\n\tlocal ok\n}\n%>').length === 0);

// ${inet#* } ends in "space brace". Split on whitespace it yields a bare },
// which closed net_read() and made this check's first run accuse
// network.cgi:74 of a `local` that is properly inside a function.
check('a parameter expansion containing a space is still one word',
	S('<%\nf() {\n\ty=${v#* }\n\tlocal ok\n}\n%>').length === 0);

check('and the same with the other trim operators',
	S('<%\nf() {\n\ta=${v% *}\n\tb=${v##* }\n\tc=${v:-"x y"}\n\tlocal ok\n}\n%>').length === 0);

check('the word local inside a string',
	S('<%\nf="a local file"\n%>').length === 0);

group('the shipped tree');

const files = [];
function walk(d) {
	if (!fs.existsSync(d)) return;
	for (const e of fs.readdirSync(d, { withFileTypes: true })) {
		const p = path.join(d, e.name);
		if (e.isDirectory()) { walk(p); continue; }
		if (p.endsWith('.cgi')) { files.push(p); continue; }
		/* the sbin/bin helpers, selected by shebang the way lint-templates.sh
		 * selects them. Only the first line is read: www/ also holds fonts and
		 * images, and slurping those to look at 40 bytes is a waste. */
		if (firstLine(p).match(/^#!.*\/(sh|ash|dash)$/)) files.push(p);
	}
}
for (const d of ['www', 'sbin', 'bin']) walk(path.join(ROOT, d));

check('found the shell files', files.length > 50, `${files.length} found`);

const bad = [];
for (const f of files) {
	const rel = path.relative(ROOT, f);
	let hits;
	try {
		hits = localsOutsideFunctions(fs.readFileSync(f, 'utf8'), rel);
	} catch (e) {
		bad.push(`${rel}: ${e.message}`);
		continue;
	}
	for (const h of hits) bad.push(`${rel}:${h.line}: ${h.text}`);
}
check('no `local` outside a function anywhere', bad.length === 0, bad.join(' | '));

done();
