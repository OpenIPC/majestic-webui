/*
 * Where the plate reader comes from — and it comes from nowhere by default.
 *
 * Unlike the raw editor next door, this one is NOT pinned to a CDN tag here.
 * The models it fetches are published under CC BY-NC 4.0: attribution, and
 * non-commercial use only. majestic is a commercial product, so a WebUI that
 * reached for those weights on every camera would be making that decision on
 * behalf of everyone running one, including the vendors who ship cameras for a
 * living.
 *
 * So the operator opts in, once, on the camera:
 *
 *     echo 'webui_lpr_base="https://cdn.jsdelivr.net/gh/OpenIPC/lpr-wasm@v0.1.0/dist/"' \
 *         >> /etc/webui/webui.conf
 *
 * raw.cgi turns that into `window.MJ_LPR_BASE` and this file uses it. With no
 * base there is no reader, `available` is false, and the page passes no plate
 * capability to the editor at all — so the Plates tab is never built, rather
 * than appearing and failing. A control that can never work is worse than none.
 *
 * `/etc` rather than a file in this tree because that is where a camera's own
 * decisions live: `sbin/updatewebui` replaces `/var/www`, and a choice made
 * here has to outlive that.
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
	 */
	function configuredBase() {
		let v = window.MJ_LPR_BASE;
		if (!v && typeof document === 'object' && document.querySelector) {
			const m = document.querySelector('meta[name="mj-lpr-base"]');
			v = m && m.content;
		}
		if (!v) return null;
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

	// No fallback. An unset base is a decision, not a misconfiguration.
	const BASE = configuredBase();
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
		if (!BASE) return Promise.reject(new Error('not-configured'));
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
