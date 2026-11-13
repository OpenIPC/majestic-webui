#!/usr/bin/env node
// Every name a front-end module reads has to be declared by something.
//
// The modules in www/a are classic scripts, so a name one of them does not
// declare is resolved at run time against everything else the page loaded. Move
// a function into another file's closure and the callers left behind still
// parse, still minify and still load; they throw only when the line runs, and if
// that line is behind a menu nobody opens, the fault ships. The pin map's
// exclude control was dead for seven weeks that way (#711).
//
// So this asks terser which names each file leaves undeclared, then requires
// each to be one of two things: a browser global on the list below, or a name
// some module in the tree publishes, as a top-level declaration or a property
// assigned onto the global object. Being declared elsewhere does not prove the
// page that needs it loads that file; this catches the name nothing provides.
//
// It lives here rather than in tests/ because it needs terser, and `npm test`
// is plain node with no dependency. CI runs it in the job that has installed
// the devDependencies.
'use strict';

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'www', 'a');

// What a browser provides, plus the node names modules reach for behind a test
// of which one they are in. A new web API belongs here; a helper does not.
const BROWSER = new Set(`
	AbortController AudioContext AudioWorkletNode Blob BroadcastChannel
	CSS CompressionStream CustomEvent DOMParser DataView DecompressionStream
	Element Event EventSource File FileReader FormData HTMLCanvasElement
	HTMLElement Headers Image ImageData Intl MediaSource MediaStream
	MediaStreamTrackProcessor MutationObserver Node Notification
	OffscreenCanvas Option RTCPeerConnection ReadableStream Request
	ResizeObserver Response TextDecoder TextEncoder URL URLSearchParams
	WebAssembly WebSocket Worker XMLHttpRequest addEventListener alert atob
	bootstrap btoa cancelAnimationFrame clearInterval clearTimeout confirm
	console createImageBitmap crypto document fetch getComputedStyle globalThis
	history import indexedDB localStorage location matchMedia navigator
	performance postMessage prompt queueMicrotask removeEventListener
	requestAnimationFrame screen self sessionStorage setInterval setTimeout
	structuredClone unescape window
	Buffer module require exports
`.trim().split(/\s+/));

const LANGUAGE = new Set(Object.getOwnPropertyNames(globalThis).filter((n) =>
	['Array', 'ArrayBuffer', 'BigInt', 'BigInt64Array', 'BigUint64Array',
		'Boolean', 'Date', 'Error', 'Float32Array', 'Float64Array', 'Function',
		'Infinity', 'Int16Array', 'Int32Array', 'Int8Array', 'JSON', 'Map', 'Math',
		'NaN', 'Number', 'Object', 'Promise', 'Proxy', 'RangeError', 'Reflect',
		'RegExp', 'Set', 'SharedArrayBuffer', 'String', 'Symbol', 'SyntaxError',
		'TypeError', 'URIError', 'Uint16Array', 'Uint32Array', 'Uint8Array',
		'Uint8ClampedArray', 'WeakMap', 'WeakRef', 'WeakSet', 'decodeURI',
		'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'eval',
		'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'undefined'].includes(n)));
LANGUAGE.add('arguments');

(async () => {
	const { minify } = await import('terser');
	const published = new Set();
	const reads = new Map();

	for (const f of fs.readdirSync(DIR).filter((n) => n.endsWith('.js'))) {
		const code = fs.readFileSync(path.join(DIR, f), 'utf8');
		const r = await minify(code, {
			compress: false, mangle: false, format: { ast: true, code: false },
		});
		r.ast.figure_out_scope({});
		r.ast.variables.forEach((_, name) => published.add(name));
		for (const m of code.matchAll(/\b(?:window|self|globalThis)\.(\w+)\s*=[^=]/g))
			published.add(m[1]);
		r.ast.globals.forEach((_, name) => {
			if (!reads.has(name)) reads.set(name, []);
			reads.get(name).push(f);
		});
	}

	const bad = [...reads.keys()]
		.filter((n) => !BROWSER.has(n) && !LANGUAGE.has(n) && !published.has(n))
		.sort();
	if (bad.length) {
		bad.forEach((n) => console.error('undeclared: ' + n + ' in ' + reads.get(n).join(', ')));
		console.error('\nNothing in www/a declares these. A browser API goes on the ' +
			'list in this file; anything else is a call that throws when it runs.');
		process.exit(1);
	}
	console.log('lint-undeclared: ' + reads.size + ' names, all declared');
})().catch((e) => { console.error(e); process.exit(2); });
