#!/usr/bin/env node
// Look at a rendered page, rather than at its source.
//
// Everything else here reads source: `npm test` reads markup and JS,
// lint-templates.sh parses the haserl, regen-bootstrap-css.sh diffs the purged
// CSS. All of it is blind to what a page LOOKS like once a browser has laid it
// out, and that blind spot has a measured cost. #464 records five faults that
// reached a reader, not one of them catchable by reading the file: a heading
// printed twice, a <select> clipped to "rtl8188fu-generic - no po", a Save bar 4px past
// the viewport at 390px (and the same on time.cgi), and a grid row half empty.
//
//   WEBUI_LOGIN=root:pw node tools/check-layout.mjs http://<camera>/cgi-bin/network.cgi
//   node tools/check-layout.mjs --self-test
//
// A camera needs credentials: WEBUI_LOGIN=root:secret. A chromium binary comes
// from CHROME=, or the usual paths. Neither is installed by this repo -- it is
// a developer tool run against a running camera, not a CI job.
//
// --self-test renders a page with faults planted in it and fails unless every
// one is reported. Run it before believing a clean result: an early version of
// this reported "no problems" three times while measuring the LOGIN page, and a
// check that cannot fail is worth exactly as much as no check.
import { existsSync } from 'node:fs';

const PUP = 'puppeteer-core';
let puppeteer;
try {
	puppeteer = (await import(PUP)).default;
} catch {
	console.error(`${PUP} is not installed. \`npm ci\` provides it (devDependency).`);
	process.exit(2);
}

// The widths that actually decide things: a phone, a laptop, and a monitor wide
// enough that a page with no ceiling stops being readable.
const VIEWPORTS = [
	[390, 844, 'phone'],
	[1280, 900, 'laptop'],
	[2560, 1440, 'monitor'],
];

const CHROME = [
	process.env.CHROME,
	'/usr/bin/chromium-browser',
	'/usr/bin/chromium',
	'/usr/bin/google-chrome',
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => p && existsSync(p));

if (!CHROME) {
	console.error('No chromium found. Set CHROME=/path/to/chromium.');
	process.exit(2);
}

// Everything measured, in one pass, inside the page.
//
// Returned rather than logged so the self-test can assert on it. Each rule
// exists because something shipped past it.
function measure() {
	const R = { clipped: [], overlap: [], empty: [], spill: null, title: document.title };
	const nm = (e) =>
		e.id
			? '#' + e.id
			: e.tagName.toLowerCase() +
				(typeof e.className === 'string' && e.className.trim()
					? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.')
					: '');

	// Does the page itself scroll sideways, and because of what? The element is
	// the one whose right edge is over while its parent's is not -- the symptom
	// alone ("394 > 390") does not tell you where to look.
	if (document.documentElement.scrollWidth > window.innerWidth + 1) {
		const over = [];
		for (const e of document.querySelectorAll('body *')) {
			const r = e.getBoundingClientRect();
			if (r.width === 0 || r.right <= window.innerWidth + 1) continue;
			const pr = e.parentElement?.getBoundingClientRect();
			if (pr && pr.right > window.innerWidth + 1) continue;
			over.push(`${nm(e)} right=${Math.round(r.right)}`);
		}
		R.spill = `${document.documentElement.scrollWidth} > ${window.innerWidth} — ${over.slice(0, 5).join('; ') || 'no single culprit'}`;
	}

	// Content wider than the box holding it. A Bootstrap .row carries negative
	// margins, so its parent is legitimately about a gutter wider than its own
	// box -- on every grid page in the UI. Only real spill is interesting, and
	// only on something actually on screen.
	for (const e of document.querySelectorAll('main *, body > *')) {
		const spill = e.scrollWidth - e.clientWidth;
		if (spill <= 16 || !e.clientWidth || !e.offsetParent) continue;
		if (e.querySelector(':scope > .row')) continue;
		const ov = getComputedStyle(e).overflowX;
		if (ov === 'visible' || ov === 'clip' || ov === 'hidden')
			R.clipped.push(`${nm(e)}: content ${e.scrollWidth}px in ${e.clientWidth}px (overflow-x:${ov})`);
	}

	// A <select> does not wrap, it truncates, and it truncates silently -- the
	// page looks fine and the words are gone. Measured in the control's OWN
	// font: getComputedStyle().font serialises to an empty string unless every
	// sub-property is set, so copying it measures the default face and finds
	// nothing.
	for (const s of document.querySelectorAll('select')) {
		if (!s.offsetParent) continue;
		const cs = getComputedStyle(s);
		const probe = document.createElement('span');
		probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap';
		probe.style.fontFamily = cs.fontFamily;
		probe.style.fontSize = cs.fontSize;
		probe.style.fontWeight = cs.fontWeight;
		probe.style.letterSpacing = cs.letterSpacing;
		let widest = 0;
		let text = '';
		for (const o of s.options) {
			probe.textContent = o.textContent;
			document.body.appendChild(probe);
			if (probe.offsetWidth > widest) {
				widest = probe.offsetWidth;
				text = o.textContent;
			}
			probe.remove();
		}
		const room = s.clientWidth - 28; // the arrow's gutter
		if (widest <= room) continue;
		// Wider than the window is the content's length, not the layout's
		// fault: a phone opens a native picker that shows the whole string.
		if (widest + 60 > window.innerWidth) continue;
		R.clipped.push(
			`select ${nm(s)}: longest option needs ${widest + 28}px, has ${s.clientWidth}px — "${text.slice(0, 44)}"`,
		);
	}

	// Two things drawn on top of each other. Nested pairs are not overlap.
	const boxes = [...document.querySelectorAll('main .card, main .mj-foot, main .mj-status, main .mj-notice, main details')]
		.map((e) => ({ e, r: e.getBoundingClientRect() }))
		.filter((x) => x.r.width > 0 && x.r.height > 0);
	for (let i = 0; i < boxes.length; i++)
		for (let j = i + 1; j < boxes.length; j++) {
			const a = boxes[i];
			const b = boxes[j];
			if (a.e.contains(b.e) || b.e.contains(a.e)) continue;
			const ox = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
			const oy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
			if (ox > 2 && oy > 2)
				R.overlap.push(`${nm(a.e)} overlaps ${nm(b.e)} by ${Math.round(ox)}x${Math.round(oy)}px`);
		}

	// A grid line that leaves a hole. One card alone on a second row beside
	// half a screen of nothing reads as a mistake, because it is one.
	for (const row of document.querySelectorAll('main .row')) {
		const kids = [...row.children].filter((k) => k.getBoundingClientRect().width > 0);
		if (kids.length < 2) continue;
		const rw = row.getBoundingClientRect().width;
		const lines = new Map();
		for (const k of kids) {
			const r = k.getBoundingClientRect();
			const key = Math.round(r.top);
			lines.set(key, (lines.get(key) || 0) + r.width);
		}
		for (const [top, used] of lines)
			if (used < rw * 0.7)
				R.empty.push(`row line at y=${top}: cells use ${Math.round(used)}px of ${Math.round(rw)}px (${Math.round((100 * used) / rw)}%)`);
	}
	return R;
}

// A page with each fault planted in it, so a clean run means something.
const SELF_TEST_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; font: 14px system-ui; }
  .row { display: flex; flex-wrap: wrap; margin: 0 -12px; }
  .row > * { padding: 0 12px; box-sizing: border-box; }
  .quarter { width: 25%; }
  .card { border: 1px solid #ccc; height: 60px; }
  select { width: 120px; }
  .spill { width: 120%; height: 20px; background: #eee; }
</style></head><body><main>
  <select id="planted-clip"><option>a value far too long for one hundred and twenty pixels</option></select>
  <div class="row"><div class="quarter"><div class="card">a</div></div><div class="quarter"><div class="card">b</div></div></div>
  <div class="card" style="position:absolute;top:10px;left:10px;width:200px">A</div>
  <div class="card" style="position:absolute;top:20px;left:20px;width:200px">B</div>
  <div class="spill"></div>
</main></body></html>`;

// Sign in the way the browser does.
//
// NOT a Basic header and NOT page.authenticate(): HTTP Basic is the deprecated
// path here, and page.authenticate() cannot work anyway -- it waits for a 401
// challenge, and majestic deliberately redirects an unauthenticated browser
// navigation to /login.html instead of challenging, so the browser lands on the
// sign-in page and every measurement describes THAT rather than the page asked
// for. Three clean runs in a row were of the login page.
//
// So this is what www/login.html itself does: POST the credentials to /login
// as a form, which answers `Set-Cookie: session=...`, and let the browser's own
// jar carry it into every later request. Posting it from a page already on the
// camera's origin is what makes the cookie land and what keeps this on the
// supported path rather than beside it.
async function signIn(page, url) {
	const origin = new URL(url).origin;
	await page.goto(origin + '/login.html', { waitUntil: 'domcontentloaded', timeout: 45000 });
	const [user, ...rest] = process.env.WEBUI_LOGIN.split(':');
	const status = await page.evaluate(
		async (u, p) =>
			(
				await fetch('/login', {
					method: 'POST',
					credentials: 'same-origin',
					headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
					body: 'username=' + encodeURIComponent(u) + '&password=' + encodeURIComponent(p),
				})
			).status,
		user,
		rest.join(':'),
	);
	if (status >= 400) throw new Error(`sign-in refused with HTTP ${status} — check WEBUI_LOGIN`);
}

async function run(browser, url, setContent, seen = new Set()) {
	let bad = 0;
	for (const [w, h, label] of VIEWPORTS) {
		const page = await browser.newPage();
		await page.setViewport({ width: w, height: h });
		if (!setContent && process.env.WEBUI_LOGIN) await signIn(page, url);
		let res = null;
		if (setContent) await page.setContent(url);
		else res = await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
		const R = await page.evaluate(measure);
		const landed = setContent ? null : page.url();
		await page.close();

		console.log(`\n  ${label} ${w}x${h}`);
		// Refuse to report on a page that is not the one asked for. Measuring
		// the wrong document and calling it clean is the exact failure this
		// file exists to stop, so the guard is about the page's IDENTITY rather
		// than one title string: a 404, a 500, a mistyped path and a redirect
		// to the sign-in or first-boot page all used to reach the measurements
		// below and come back "clean".
		const wrong = setContent
			? null
			: !res || !res.ok()
				? `HTTP ${res ? res.status() : 'no response'}`
				: new URL(landed).pathname !== new URL(url).pathname
					? `redirected to ${new URL(landed).pathname}`
					: /sign in/i.test(R.title)
						? `sign-in page ("${R.title}")`
						: null;
		if (wrong) {
			console.log(
				`    NOT THE PAGE ASKED FOR — ${wrong}.` +
					(/sign|redirect/i.test(wrong) ? ' Set WEBUI_LOGIN=user:pass.' : ''),
			);
			bad++;
			continue;
		}
		const found = [
			...(R.spill ? [`page scrolls sideways: ${R.spill}`] : []),
			...R.clipped.map((m) => `clipped: ${m}`),
			...R.overlap.map((m) => `overlap: ${m}`),
			...R.empty.map((m) => `empty:   ${m}`),
		];
		if (!found.length) console.log('    clean');
		found.forEach((m) => console.log('    ' + m));
		bad += found.length;
		if (R.spill) seen.add('spill');
		for (const k of ['clipped', 'overlap', 'empty']) if (R[k].length) seen.add(k);
	}
	return bad;
}

const browser = await puppeteer.launch({
	executablePath: CHROME,
	args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

let status = 0;
const args = process.argv.slice(2);
if (args[0] === '--self-test') {
	console.log('self-test: a page with a clipped select, an overlap, a half-empty row and a spill');
	const seen = new Set();
	const found = await run(browser, SELF_TEST_PAGE, true, seen);
	// EVERY rule has to fire, not merely some total. A count is green while a
	// whole rule sits silent -- which is how the first cut of this shipped with
	// its half-empty-row check never once running, because the page it was
	// proved against had a row with a single cell and the rule needs two.
	const want = ['spill', 'clipped', 'overlap', 'empty'];
	const missing = want.filter((k) => !seen.has(k));
	if (missing.length) {
		console.error(`\nself-test FAILED: these rules never fired: ${missing.join(', ')}.`);
		console.error('The checker is not seeing what it claims to see; do not trust a clean run.');
		status = 1;
	} else {
		console.log(`\nself-test ok: ${found} findings, all ${want.length} rules fired`);
	}
} else if (!args.length) {
	console.error('usage: node tools/check-layout.mjs <url> [url…]   |   --self-test');
	status = 2;
} else {
	for (const url of args) {
		console.log(`\n=== ${url} ===`);
		status = (await run(browser, url, false)) ? 1 : status;
	}
}
await browser.close();
process.exit(status);
