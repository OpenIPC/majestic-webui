/*
 * Where the plate reader comes from.
 *
 * Same rule as the raw editor next door, the HEVC decoder in preview-wasm.js
 * and CodeMirror in files.js: about nine megabytes of model and runtime is far
 * too big to sit in a camera's flash, so it is fetched, version-pinned, with an
 * error path. A camera with no route to it is offered the tab anyway and says
 * so when asked to read — the same bargain the editor itself makes, and the
 * reason `loadFailed` below is remembered. Nothing else on the raw page depends
 * on it.
 *
 * jsDelivr serves the tag straight from the repository, so there is no npm step
 * between a release and this URL.
 *
 * `webui_lpr_base` in /etc/webui/webui.conf points a camera somewhere else: a
 * mirror of one's own, for a camera that must not reach a public CDN. `/etc`
 * rather than a file in this tree because that is where a camera's own
 * decisions live: `sbin/updatewebui` replaces `/var/www`, and a choice made
 * here has to outlive that. raw.cgi turns the value into a <meta>, which is why
 * it is read out of the document below. window.MJ_LPR_BASE wins over both, for
 * a development build.
 *
 * Everything else follows raw-loader.js: a capability check that costs nothing,
 * a deadline, and a remembered failure so a camera with no route out pays the
 * timeout once rather than once per press.
 */
window.MajesticLpr = (function () {
	'use strict';

	/*
	 * Where the base comes from, and why it is read out of the document.
	 *
	 * raw.cgi writes it into a <meta content>, because the value comes from a
	 * file an operator edits by hand and the only escaper available there is an
	 * HTML-attribute one. In an attribute that is correct by construction and
	 * the DOM parser gives the string back verbatim -- a query string survives,
	 * and a newline cannot end a statement it was never inside.
	 *
	 * Only http(s). The file is root-owned, so this is not a hostile input, but
	 * a typo that made the base a `javascript:` or `data:` URL would turn a
	 * configuration mistake into a module import from somewhere unintended, and
	 * refusing costs one comparison.
	 *
	 * window.MJ_LPR_BASE still wins, for a development build.
	 *
	 * Three answers, not two. `undefined` is "nothing was configured", and the
	 * pinned default below is used. `null` is "something was configured and
	 * refused", and there is then no reader at all: a camera is pointed at a
	 * mirror precisely when it must not reach a public CDN, so a typo in that
	 * address must not quietly send it to one.
	 */
	function configuredBase() {
		let v = window.MJ_LPR_BASE;
		if (!v && typeof document === 'object' && document.querySelector) {
			const m = document.querySelector('meta[name="mj-lpr-base"]');
			v = m && m.content;
		}
		if (!v) return undefined;
		if (!/^https?:\/\//i.test(v)) return null;
		/* A missing trailing slash is the likeliest way to mistype this, and
		 * 'dist' + 'lpr.js' resolves somewhere else entirely. Completed only
		 * when there is nothing after the path: appending a slash to a base
		 * carrying a query string or a fragment would land it in the wrong
		 * place, and such a base cannot take a filename by concatenation
		 * anyway, so it is left exactly as the operator wrote it. */
		if (v.indexOf('?') !== -1 || v.indexOf('#') !== -1) return v;
		return v.charAt(v.length - 1) === '/' ? v : v + '/';
	}

	const DEFAULT_BASE = 'https://cdn.jsdelivr.net/gh/OpenIPC/lpr-wasm@v0.1.0/dist/';

	// Unset means the pinned default; refused means no reader. See above.
	const CONFIGURED = configuredBase();
	const BASE = CONFIGURED === undefined ? DEFAULT_BASE : CONFIGURED;
	const LOAD_TIMEOUT_MS = 8000;

	let loadFailed = false;
	let loading = null;

	// Cheap and synchronous, so the page can decide whether to offer plate
	// reading before spending anything. Both halves matter: the module runs in
	// WebAssembly inside a worker, and it has to have somewhere to come from.
	const available = !!BASE &&
		typeof Worker === 'function' &&
		typeof WebAssembly === 'object' &&
		typeof Promise === 'function';

	function load() {
		if (!BASE) return Promise.reject(new Error('bad-base'));
		if (!available) return Promise.reject(new Error('unsupported-browser'));
		if (loadFailed) return Promise.reject(new Error('unavailable'));
		if (loading) return loading;
		// import() takes no AbortSignal, so the deadline is a race. The import
		// carries on in the background if it loses; nothing waits on it.
		loading = Promise.race([
			import(BASE + 'lpr.js'),
			new Promise(function (_, reject) {
				setTimeout(function () { reject(new Error('timeout')); }, LOAD_TIMEOUT_MS);
			}),
		]).catch(function (e) {
			loadFailed = true;
			loading = null;
			throw e;
		});
		return loading;
	}

	/*
	 * The reader, once. Resolves to the module's session — `detect`, `read`,
	 * `readAll` — which the caller holds for the life of the page, because
	 * building it costs nine megabytes of model.
	 */
	let session = null;
	function open(opts) {
		if (session) return session;
		session = load().then(function (mod) {
			return mod.open(Object.assign({ base: BASE }, opts || {}));
		}).catch(function (e) {
			session = null;          // a failed open must not be cached as one
			throw e;
		});
		return session;
	}

	return { BASE: BASE, available: available, load: load, open: open };
})();
