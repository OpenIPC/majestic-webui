/*
 * Where the raw editor comes from.
 *
 * Same rule as the HEVC decoder in preview-wasm.js, xterm.js in console.cgi and
 * CodeMirror in files.js: too big to sit in a camera's flash, so it is fetched,
 * version-pinned, with an error path — and a camera with no route to it simply
 * does not get it. Raw capture works without the editor; only the editing does
 * not.
 *
 * There is a second reason here. Only some HiSilicon and Goke parts serve
 * /image.dng at all, and the WebUI ships as one archive for every board, so an
 * editor carried in the image would be dead weight on most of them.
 *
 * jsDelivr serves the tag straight from the repository, so there is no npm step
 * between a release and this URL. Unlike the decoder this one is imported
 * rather than run from a blob: a module can be imported cross-origin, and the
 * editor makes its own worker.
 *
 * MJ_RAW_BASE overrides it, for a development build or an operator who would
 * rather host it themselves.
 */
window.MajesticRaw = (function () {
	const BASE = (window.MJ_RAW_BASE ||
		'https://cdn.jsdelivr.net/gh/OpenIPC/raw-editor@v0.18.0/dist/');
	const LOAD_TIMEOUT_MS = 8000;

	// Remembered for the session once the module has failed to arrive. Without
	// it every press of the button pays the same doomed round trip again, and
	// on a camera with no route out that is a timeout each time.
	let loadFailed = false;
	let loading = null;

	// Cheap and synchronous, so a page can decide whether to offer the editor
	// before spending anything. The editor develops in a worker and decodes in
	// WebAssembly; without either there is nothing to fetch.
	const available = typeof Worker === 'function' &&
		typeof WebAssembly === 'object' &&
		typeof Promise === 'function';

	function load() {
		if (!available) return Promise.reject(new Error('unsupported-browser'));
		if (loadFailed) return Promise.reject(new Error('unavailable'));
		if (loading) return loading;
		// import() takes no AbortSignal, so the deadline is a race. The import
		// carries on in the background if it loses; nothing waits on it.
		loading = Promise.race([
			import(BASE + 'editor.js'),
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

	function mount(root, opts) {
		return load().then(function (mod) {
			const o = Object.assign({ base: BASE }, opts || {});
			return mod.mountEditor(root, o);
		});
	}

	return { BASE: BASE, available: available, load: load, mount: mount };
})();
