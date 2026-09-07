/* One live write in flight, and at most one waiting behind it.
 *
 * The settings page previews a drag by pushing the camera on every
 * pointermove. Those writes have to be SERIALISED — hold-to-compare issues
 * two, the defaults on press and the live values on release, and independent
 * fetches have no ordering guarantee, so a short hold could let the defaults
 * land second and leave the camera sitting at stock, precisely the state that
 * control exists to undo.
 *
 * But serialised alone is a QUEUE. Measured from a browser sharing the camera
 * with a video stream, a live write takes about half a second whatever the
 * same request costs from a shell — so a drag of a dozen moves is a dozen
 * requests, and the picture goes on catching up for the better part of ten
 * seconds after the pointer has stopped. What is on the video meanwhile is the
 * overlay, or the privacy mask, at a position nobody asked for and nothing on
 * screen agrees with: OpenIPC/majestic-webui#340 reports it as a mask sitting
 * apart from its own outline.
 *
 * So a write that arrives while one is in flight REPLACES the one waiting
 * rather than joining the queue — but only where it says the same thing about
 * the same keys. A write naming other keys is a different statement and takes
 * its own place in line, or the whole-page undo would be swallowed by the drag
 * that came before it.
 *
 * Two invariants, and both are silent when broken: at most one request is
 * outstanding, and the LAST thing said always lands. A queue that grows shows
 * up as a camera lagging the page, which on a fast camera never happens at
 * all; a statement dropped for another that only looked like it shows up as an
 * undo that did not undo.
 */
(function () {
	'use strict';

	// Which keys a document names, sorted, so that two pushes of the same drag
	// are one statement and a document naming anything else is not. Arrays are
	// leaves: a privacy mask list says one thing however many rectangles it
	// holds, and its length changing must not make it a different statement.
	function docSig(doc) {
		const out = [];
		(function walk(v, at) {
			if (v && typeof v === 'object' && !Array.isArray(v)) {
				const keys = Object.keys(v).sort();
				for (let i = 0; i < keys.length; i++)
					walk(v[keys[i]], at + '.' + keys[i]);
			} else {
				out.push(at);
			}
		})(doc, '');
		return out.join(',');
	}

	// The same question of a query string: what it names, not what it says.
	function querySig(q) {
		return String(q).split('&')
			.map(function (p) { return p.split('=')[0]; })
			.sort().join(',');
	}

	// sendOne(payload) -> Promise of whatever the caller wants back. It must
	// not reject: a write that fails must not wedge every write after it, so
	// the failure is a value like any other.
	//
	// A CALLER CANNOT ASSUME ITS OWN PAYLOAD WAS THE ONE SENT. Ten replaced
	// pushes share one promise and one transmitted payload, so anything that
	// has to act on what the camera was actually given — a fallback to another
	// endpoint, say — belongs inside sendOne, which is handed exactly that.
	// Hung off the returned promise instead, it would run once per superseded
	// caller and carry positions the drag had already passed through.
	function coalesce(sendOne, sigOf) {
		let flight = null;
		const queue = [];

		function pump() {
			if (flight || !queue.length) return;
			const it = queue.shift();
			flight = sendOne(it.payload).then(function (r) {
				flight = null;
				it.resolve(r);
				pump();
				return r;
			});
		}

		return function (payload) {
			const sig = sigOf(payload);
			const last = queue[queue.length - 1];
			// Replaced, not appended: the one waiting has not been said yet,
			// and this supersedes it.
			if (last && last.sig === sig) {
				last.payload = payload;
				return last.promise;
			}
			const it = { sig: sig, payload: payload, resolve: null, promise: null };
			it.promise = new Promise(function (res) { it.resolve = res; });
			queue.push(it);
			pump();
			return it.promise;
		};
	}

	const api = { coalesce: coalesce, docSig: docSig, querySig: querySig };
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticQueue = api;
})();
