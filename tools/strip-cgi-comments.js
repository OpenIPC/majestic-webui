#!/usr/bin/env node
'use strict';

/*
 * Remove editor-facing comments from haserl .cgi templates, for the dist build
 * only. The source in git keeps every word; the camera gets none of them.
 *
 * Why this is not `html-minifier --remove-comments`: a .cgi here is haserl, and
 * a .cgi is three languages at once. Literal HTML between the tags, shell
 * inside `<% %>`, and -- the part that catches people -- more literal HTML
 * inside the heredocs that shell writes. Each has its own comment syntax and
 * its own answer to "does the camera see this":
 *
 *   <!-- ... -->   in literal text or a heredoc body -> EMITTED. Costs rootfs
 *                  and crosses the wire on every request. `preview()` alone
 *                  shipped 11.8 KB of design rationale to the browser.
 *   <%# ... %>     haserl comment -> never emitted, costs rootfs.
 *   # ...          shell comment -> never emitted, costs rootfs.
 *
 * The one exception is `<!--!`, which by the convention build-dist.sh already
 * relies on marks a comment addressed to whoever FETCHES the page rather than
 * to whoever edits the file. setup.html's note about who may accept the EULA is
 * the only one, and it is content: it is kept here for the same reason.
 *
 * Only WHOLE-LINE shell comments are removed, never a trailing one, because
 * telling `# comment` from `${v#pfx}` or a `#` inside a string needs the
 * quoting state and a whole-line rule needs almost none of it. What state it
 * does need is tracked: a line that begins inside an unclosed quote is data,
 * not code, and is left exactly as it is.
 *
 * Anything this cannot parse confidently throws rather than guessing. An
 * unclosed heredoc is the one that matters -- it is what a `<<` mistaken for a
 * heredoc opener would look like -- and silently swallowing the rest of a file
 * as heredoc body is precisely the failure that must never reach a camera.
 */

/* Emitted text: drop <!-- --> but keep <!--!. A comment that occupies whole
 * lines takes its lines with it, so nothing is left but a blank gap. */
function stripHtmlComments(text) {
	let out = '';
	let i = 0;
	for (;;) {
		const j = text.indexOf('<!--', i);
		if (j === -1) {
			out += text.slice(i);
			return out;
		}
		const e = text.indexOf('-->', j);
		if (e === -1) {
			/* Unterminated. Not ours to interpret; hand the rest back whole. */
			out += text.slice(i);
			return out;
		}
		if (text[j + 4] === '!') {
			out += text.slice(i, e + 3);
			i = e + 3;
			continue;
		}
		let start = j;
		let end = e + 3;
		const lineStart = text.lastIndexOf('\n', start) + 1;
		if (/^[ \t]*$/.test(text.slice(lineStart, start))) {
			start = lineStart;
			/* Take the line's own newline with it. At the end of the text there
			 * is none, and the newline that separated this line from the one
			 * before is then the one left over -- take that instead, or the
			 * removed line comes back as a blank one. */
			if (text[end] === '\n') end += 1;
			else if (start > 0 && text[start - 1] === '\n') start -= 1;
		}
		out += text.slice(i, start);
		i = end;
	}
}

/* Walk one line of shell, carrying the quoting state in and out. Stops at an
 * unquoted `#` in command position, so an apostrophe inside a comment cannot
 * open a quote that swallows the rest of the file. Reports the first heredoc
 * the line opens. */
function scanShellLine(line, quote) {
	let q = quote;
	let esc = false;
	let heredoc = null;
	let i = 0;
	while (i < line.length) {
		const c = line[i];
		if (esc) { esc = false; i++; continue; }
		if (q === "'") { if (c === "'") q = null; i++; continue; }
		if (q === '"') {
			if (c === '\\') { esc = true; i++; continue; }
			if (c === '"') q = null;
			i++;
			continue;
		}
		if (c === '\\') { esc = true; i++; continue; }
		if (c === "'" || c === '"') { q = c; i++; continue; }
		if (c === '#' && (i === 0 || /[ \t;&|(]/.test(line[i - 1]))) break;
		if (!heredoc && c === '<' && line[i + 1] === '<' && line[i + 2] !== '<') {
			const m = /^<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|([A-Za-z_][A-Za-z0-9_]*))/
				.exec(line.slice(i));
			if (m) {
				heredoc = {
					dash: m[1] === '-',
					delim: m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4],
				};
				i += m[0].length;
				continue;
			}
		}
		i++;
	}
	return { quote: q, heredoc };
}

function stripShell(code, where) {
	const lines = code.split('\n');
	const out = [];
	let quote = null;
	let hd = null;
	let body = [];
	const flushBody = () => {
		if (body.length) {
			out.push(stripHtmlComments(body.join('\n')));
			body = [];
		}
	};
	for (const line of lines) {
		if (hd) {
			const t = hd.dash ? line.replace(/^[\t]+/, '') : line;
			if (t === hd.delim) {
				flushBody();
				out.push(line);
				hd = null;
			} else {
				body.push(line);
			}
			continue;
		}
		if (!quote && /^[ \t]*#/.test(line)) continue;
		out.push(line);
		const r = scanShellLine(line, quote);
		quote = r.quote;
		if (r.heredoc) hd = r.heredoc;
	}
	if (hd) {
		throw new Error(
			`${where}: heredoc <<${hd.delim} is never closed -- refusing to guess`);
	}
	flushBody();
	return out.join('\n');
}

function stripCgi(src, where) {
	where = where || '<input>';
	let out = '';
	let i = 0;
	for (;;) {
		const j = src.indexOf('<%', i);
		if (j === -1) {
			out += stripHtmlComments(src.slice(i));
			return out;
		}
		const k = src.indexOf('%>', j);
		if (k === -1) {
			throw new Error(`${where}: '<%' at offset ${j} is never closed`);
		}
		let literal = src.slice(i, j);
		const kind = src[j + 2];
		if (kind === '#') {
			/* A haserl comment on a line of its own takes the line with it. */
			let tail = k + 2;
			const lineStart = literal.lastIndexOf('\n') + 1;
			if (/^[ \t]*$/.test(literal.slice(lineStart)) && src[tail] === '\n') {
				literal = literal.slice(0, lineStart);
				tail += 1;
			}
			out += stripHtmlComments(literal);
			i = tail;
			continue;
		}
		out += stripHtmlComments(literal);
		if (kind === '=') {
			out += src.slice(j, k + 2);
		} else {
			out += '<%' + stripShell(src.slice(j + 2, k), where) + '%>';
		}
		i = k + 2;
	}
}

module.exports = { stripCgi, stripShell, stripHtmlComments };

if (require.main === module) {
	const fs = require('fs');
	const path = require('path');
	const args = process.argv.slice(2);
	if (!args.length) {
		console.error('usage: strip-cgi-comments.js <dir>|<file.cgi>...');
		process.exit(2);
	}
	/* A directory is walked here rather than by find|xargs in the caller: one
	 * node process instead of a startup per file, no dependence on how xargs
	 * decides to batch (which would print a summary per batch), and the same
	 * interface check-no-comments.js takes. */
	const files = [];
	for (const a of args) {
		if (fs.statSync(a).isDirectory()) {
			(function walk(d) {
				for (const e of fs.readdirSync(d, { withFileTypes: true })) {
					const q = path.join(d, e.name);
					if (e.isDirectory()) walk(q);
					else if (q.endsWith('.cgi')) files.push(q);
				}
			})(a);
		} else {
			files.push(a);
		}
	}
	if (!files.length) {
		console.error('strip-cgi-comments: no .cgi files found -- selection is broken');
		process.exit(1);
	}
	let before = 0;
	let after = 0;
	for (const f of files) {
		const src = fs.readFileSync(f, 'utf8');
		const stripped = stripCgi(src, f);
		before += Buffer.byteLength(src);
		after += Buffer.byteLength(stripped);
		fs.writeFileSync(f, stripped);
	}
	const saved = before - after;
	console.log(
		`strip-cgi-comments: ${files.length} files, ` +
		`${before} -> ${after} bytes (-${saved}, ${(100 * saved / before).toFixed(1)}%)`);
}
