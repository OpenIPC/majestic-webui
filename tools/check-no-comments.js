#!/usr/bin/env node
'use strict';

/*
 * The gate: nothing in the shipped payload may carry a comment.
 *
 * Comments are written for whoever edits the source, and the source of record
 * is git. A camera is a deployment target with a 5120 KB rootfs, and a CGI
 * reply comes back chunked with no Content-Encoding however the request asks
 * for one, so every comment byte in a .cgi is paid for twice: once in flash,
 * and again on the wire on every single request. The Live page was 53.5%
 * comments by the time anyone measured it.
 *
 * Run against the staged package by build-dist.sh, which is also what
 * check.yml runs on a pull request -- so this fires on both paths from one
 * definition and cannot drift from the build it guards.
 *
 * For .cgi the test is `stripCgi(src) === src`, which makes the gate and the
 * stripper the same code by construction: anything the stripper would remove
 * is by definition a comment that should not be here, and neither can grow a
 * blind spot the other does not have. For .js the oracle is terser's own
 * parser -- print the file with comments and without, and compare -- because
 * telling a `//` from one inside a string or a regex literal is not a job for
 * a regular expression. CSS and HTML get small scanners that do track strings.
 *
 * ALLOW is the whole list of exceptions and each is pinned to an exact count,
 * so a new one cannot arrive quietly. Both entries are comments that are
 * CONTENT -- addressed to whoever fetches the file, not to whoever edits it:
 *
 *   www/setup.html          the note about who may accept the EULA. Its reader
 *                           is a person or an agent looking at the served page,
 *                           which is the only copy they will ever see.
 *   www/a/bootstrap.min.css upstream's MIT licence banner. Removing it is a
 *                           licence violation, not a saving.
 */

const fs = require('fs');
const path = require('path');
const { stripCgi } = require('./strip-cgi-comments.js');

const ALLOW = [
	{ file: 'www/setup.html', marker: '<!--!', count: 1 },
	{ file: 'www/a/bootstrap.min.css', marker: '/*!', count: 1 },
];

function allowance(rel, marker) {
	const e = ALLOW.find((a) => a.file === rel && a.marker === marker);
	return e ? e.count : 0;
}

function lineOf(src, index) {
	return src.slice(0, index).split('\n').length;
}

/* CSS: /* ... *​/ outside a string. Tracks quotes so content:"/*" is not a hit. */
function cssComments(src) {
	const hits = [];
	let i = 0;
	let q = null;
	while (i < src.length) {
		const c = src[i];
		if (q) {
			if (c === '\\') { i += 2; continue; }
			if (c === q) q = null;
			i++;
			continue;
		}
		if (c === '"' || c === "'") { q = c; i++; continue; }
		if (c === '/' && src[i + 1] === '*') {
			hits.push({ index: i, bang: src[i + 2] === '!' });
			const e = src.indexOf('*/', i + 2);
			i = e === -1 ? src.length : e + 2;
			continue;
		}
		i++;
	}
	return hits;
}

function htmlComments(src) {
	const hits = [];
	let i = 0;
	for (;;) {
		const j = src.indexOf('<!--', i);
		if (j === -1) return hits;
		hits.push({ index: j, bang: src[j + 4] === '!' });
		const e = src.indexOf('-->', j);
		i = e === -1 ? src.length : e + 3;
	}
}

/* Inline <script>/<style> bodies, so a comment cannot hide inside a page that
 * has no external asset to check. Skips <script src=...>, which has no body. */
function inlineBlocks(src, tag) {
	const re = new RegExp(`<${tag}([^>]*)>([\\s\\S]*?)</${tag}>`, 'gi');
	const out = [];
	let m;
	while ((m = re.exec(src)) !== null) {
		if (/\bsrc\s*=/i.test(m[1])) continue;
		out.push({ body: m[2], index: m.index });
	}
	return out;
}

/* terser as the oracle: same parse, same print, comments the only variable. */
async function jsHasComments(code, minify) {
	const opts = { compress: false, mangle: false };
	const bare = await minify(code, { ...opts, format: { comments: false } });
	const kept = await minify(code, { ...opts, format: { comments: 'all' } });
	if (bare.error || kept.error) throw bare.error || kept.error;
	return bare.code !== kept.code;
}

async function main() {
	const root = process.argv[2];
	if (!root) {
		console.error('usage: check-no-comments.js <staged-package-dir>');
		process.exit(2);
	}
	let minify;
	try {
		minify = require('terser').minify;
	} catch (e) {
		console.error('check-no-comments: terser not available (run npm ci)');
		process.exit(2);
	}

	const files = [];
	(function walk(d) {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p);
			else files.push(p);
		}
	})(root);

	const findings = [];
	const used = new Map();
	let checked = 0;

	for (const p of files) {
		const rel = path.relative(root, p).split(path.sep).join('/');
		const ext = path.extname(p);
		if (!['.cgi', '.js', '.css', '.html'].includes(ext)) continue;
		const src = fs.readFileSync(p, 'utf8');
		checked++;

		if (ext === '.cgi') {
			let stripped;
			try {
				stripped = stripCgi(src, rel);
			} catch (e) {
				findings.push(`${rel}: cannot be checked: ${e.message}`);
				continue;
			}
			if (stripped !== src) {
				const a = src.split('\n');
				const b = new Set(stripped.split('\n'));
				const n = a.filter((l) => l.trim() && !b.has(l)).length;
				findings.push(
					`${rel}: ${Buffer.byteLength(src) - Buffer.byteLength(stripped)} ` +
					`bytes of comments (~${n} lines) -- strip-cgi-comments.js did not run`);
			}
			continue;
		}

		if (ext === '.css') {
			for (const h of cssComments(src)) {
				const marker = h.bang ? '/*!' : '/*';
				if (h.bang) {
					const k = `${rel}|${marker}`;
					used.set(k, (used.get(k) || 0) + 1);
					if (used.get(k) <= allowance(rel, marker)) continue;
				}
				findings.push(`${rel}:${lineOf(src, h.index)}: CSS comment ${marker}`);
			}
			continue;
		}

		if (ext === '.js') {
			if (await jsHasComments(src, minify)) {
				findings.push(`${rel}: JavaScript comment(s) present`);
			}
			continue;
		}

		/* .html: the markup, then anything inlined into it. */
		for (const h of htmlComments(src)) {
			const marker = h.bang ? '<!--!' : '<!--';
			if (h.bang) {
				const k = `${rel}|${marker}`;
				used.set(k, (used.get(k) || 0) + 1);
				if (used.get(k) <= allowance(rel, marker)) continue;
			}
			findings.push(`${rel}:${lineOf(src, h.index)}: HTML comment ${marker}`);
		}
		for (const b of inlineBlocks(src, 'script')) {
			let bad = false;
			try {
				bad = await jsHasComments(b.body, minify);
			} catch (e) {
				findings.push(`${rel}:${lineOf(src, b.index)}: inline script unparseable: ${e.message}`);
				continue;
			}
			if (bad) {
				findings.push(`${rel}:${lineOf(src, b.index)}: comment in inline <script>`);
			}
		}
		for (const b of inlineBlocks(src, 'style')) {
			for (const h of cssComments(b.body)) {
				findings.push(
					`${rel}:${lineOf(src, b.index + h.index)}: comment in inline <style>`);
			}
		}
	}

	/* An allowance that stopped matching is a finding too: the comment it
	 * protects is content, and losing it is silent -- the page still works and
	 * no longer says the thing it exists to say. */
	for (const a of ALLOW) {
		const got = used.get(`${a.file}|${a.marker}`) || 0;
		if (got !== a.count) {
			findings.push(
				`${a.file}: expected ${a.count} kept ${a.marker} comment(s), found ${got}`);
		}
	}

	if (!checked) {
		console.error('check-no-comments: no assets found under ' + root + ' -- selection is broken');
		process.exit(1);
	}

	if (findings.length) {
		console.error('');
		console.error('check-no-comments: the payload would ship comments to the camera.');
		console.error('');
		for (const f of findings) console.error('  ' + f);
		console.error('');
		console.error(`${findings.length} finding(s) across ${checked} assets.`);
		console.error('Comments belong in git, not on a 5120 KB rootfs that re-sends them');
		console.error('uncompressed on every request. If one is genuinely addressed to the');
		console.error('reader of the served file, mark it <!--! (or /*!) and pin it in ALLOW.');
		console.error('');
		process.exit(1);
	}
	console.log(`check-no-comments: ok, ${checked} assets carry no comments`);
}

main().catch((e) => {
	console.error('check-no-comments: ' + (e && e.stack ? e.stack : e));
	process.exit(2);
});
