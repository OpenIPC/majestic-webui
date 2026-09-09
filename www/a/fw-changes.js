// What changed in the camera software since this build, and nothing about how
// to say it.
//
// Two surfaces ask the same question and word the answer differently: the
// "N builds behind" notice on every page (update-check.js) writes one sentence
// and a collapsed list, and the Firmware page (update.js) writes counts beside
// the Install button and a grouped changelog card. The arithmetic that decides
// WHICH builds are since mine, and what may be counted at all, has to be one
// copy or the two will disagree about the same camera on the same day — which
// is the whole of majestic-webui#348 arriving by a different road.
//
// So everything here is a fact about the feed, and every sentence is at the
// call site. Nothing in this file touches the DOM.
//
// The camera never contacts the internet for this. It reports only what it
// already knows about itself, and the BROWSER fetches the public feed and does
// the arithmetic. One URL for everybody, no query string and no camera identity
// in the request: fetching it says only that somebody opened an OpenIPC web
// interface. A camera on an isolated network is not nagged, is not slowed, and
// is not made to phone anywhere.
//
// Everything fails to silence. No feed, an unparseable body, a build the ledger
// has never heard of — all return null, and a caller that cannot tell must say
// nothing rather than guess.
(function () {
	'use strict';

	const FEED = 'https://openipc.s3-eu-west-1.amazonaws.com/majestic-changes.json';

	// `ipcinfo --vendor` is lowercase and so is the feed's token; this is only
	// for the sentence.
	const VENDOR_NAMES = {
		hisilicon: 'HiSilicon', sigmastar: 'SigmaStar', ingenic: 'Ingenic',
		rockchip: 'Rockchip', novatek: 'Novatek', fullhan: 'Fullhan',
		grainmedia: 'GrainMedia', xiongmai: 'Xiongmai', allwinner: 'Allwinner',
	};

	const CATEGORIES = ['feature', 'fix', 'security', 'other'];

	function esc(s) {
		return String(s).replace(/[&<>"']/g, c => ({
			'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
		}[c]));
	}

	// A date is a date, or it is not evidence.
	//
	// Both inputs here are untrusted in different ways. The feed arrives over
	// the network, and parseBuild lifts any YYYY-MM-DD-shaped run of digits out
	// of a version string without checking it names a real day. Comparing either
	// as a raw string would rank "z" after every real date and "0000-00-00"
	// before them, turning nonsense into a confident "at least N builds behind".
	function isDate(s) {
		if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
		const t = Date.parse(s + 'T00:00:00Z');
		if (isNaN(t)) return false;
		// Round-trip, because Date.parse rolls 2026-02-31 forward into March
		// rather than rejecting it.
		return new Date(t).toISOString().slice(0, 10) === s;
	}

	function plural(n, one, many) {
		return n + ' ' + (n === 1 ? one : many);
	}

	// `majestic -v` prints "<Release> <Vendor>[ (<Platform>)], <ver>, <date>",
	// where <ver> is "<branch>+<rev>" or a tag. Actions checks out a detached
	// HEAD, so the branch reads "HEAD" rather than "master" on a shipped build:
	// take the revision and never the prefix.
	function parseBuild(version) {
		if (!version) return null;
		const rev = /[+ ]([0-9a-f]{7,40})\b/.exec(version);
		const date = /(\d{4}-\d{2}-\d{2})/.exec(version);
		if (!rev) return null;
		// A date that is not a real day is no date at all: nothing downstream
		// should have to ask twice.
		return { rev: rev[1], date: (date && isDate(date[1])) ? date[1] : null };
	}

	function daysSince(iso) {
		if (!isDate(iso)) return null;
		const then = Date.parse(iso + 'T00:00:00Z');
		if (isNaN(then)) return null;
		return Math.floor((Date.now() - then) / 86400000);
	}

	// A count is a count, or the entry is not usable.
	//
	// Two reasons, and the weaker one is the interesting one. An absent reading
	// is not a zero: an entry missing its `fix` count would otherwise render a
	// confident total that silently understates what the owner would gain, and
	// could drop the severity from warn to info by losing a security count.
	//
	// The stronger reason is that this arrives over the network and ends up in
	// innerHTML. Anything that is not a plain non-negative integer -- a string
	// carrying markup, most obviously -- must never reach a sentence builder,
	// and rejecting it here is what guarantees that, rather than escaping it
	// correctly at every point it is interpolated later.
	function counts(entry) {
		if (!entry || typeof entry.counts !== 'object' || entry.counts === null) return null;
		const out = {};
		for (const k of CATEGORIES) {
			const v = entry.counts[k];
			if (typeof v !== 'number' || !isFinite(v) || v < 0 || Math.floor(v) !== v) {
				return null;
			}
			out[k] = v;
		}
		return out;
	}

	// Everything published after the running build. The camera's own revision
	// is the boundary: a commit above it is in the next build it takes,
	// whichever night that one happened to publish.
	function delta(feed, rev, buildDate) {
		if (!feed || !rev) return null;
		const totals = { feature: 0, fix: 0, security: 0, other: 0 };
		const vendors = new Set();
		const said = [];
		let builds = 0, found = false;

		for (const entry of feed.builds || []) {
			if (typeof entry.sha !== 'string' || !entry.sha) return null;
			if (rev.indexOf(entry.sha) === 0 || entry.sha.indexOf(rev) === 0) {
				found = true;
				break;
			}
			const c = counts(entry);
			// One malformed entry above the running build makes the whole tally
			// a guess. Say nothing rather than a number that is wrong.
			if (!c) return null;
			builds++;
			for (const k of CATEGORIES) totals[k] += c[k];
			for (const note of entry.notes || []) {
				if (!note) continue;
				if (typeof note.vendor === 'string') vendors.add(note.vendor);
				// Remote text, bound for innerHTML. Kept as data here and
				// escaped where it is written, like every other string the feed
				// supplies.
				if (typeof note.text === 'string' && note.text) {
					// The vendor comes too. It is this note's SCOPE, which is
					// already how the sentence uses it, and a list that drops it
					// offers one vendor's fix to every other vendor's camera.
					said.push({ cat: note.cat, vendor: note.vendor, text: note.text });
				}
			}
		}
		if (found) return { builds, totals, vendors, said, atLeast: false };

		// Not in the ledger, which is two very different situations.
		//
		// A build NEWER than the feed -- a development build, or a nightly the
		// feed has not caught up with -- has nothing to be told.
		//
		// A build OLDER than the ledger reaches is the common case and the one
		// that matters: the ledger starts somewhere, and every camera flashed
		// before that point falls off the end of it. Saying nothing to those
		// would leave the banner permanently silent for exactly the owners
		// furthest behind, which is the opposite of the point.
		//
		// The build date separates the two. Only when it is strictly older than
		// the oldest entry has the camera provably been passed by, and even then
		// the totals are a floor rather than a count, so the sentence says "at
		// least". Same-day is not evidence either way, and stays silent.
		const eldest = (feed.builds || [])[(feed.builds || []).length - 1];
		if (isDate(buildDate) && eldest && isDate(eldest.date) &&
			buildDate < eldest.date) {
			return { builds, totals, vendors, said, atLeast: true };
		}
		return null;
	}

	// The notes this camera may be shown, security first.
	//
	// A note carrying a vendor applies to that vendor's cameras and no others;
	// one carrying none applies everywhere. Listing another vendor's work would
	// promise this owner something their camera will never do — the same mistake
	// the "cameras like this one" sentence avoids by only claiming a match.
	//
	// SECURITY FIRST, then features, then fixes: it is the ordering an owner
	// deciding whether to update now rather than at the weekend actually needs.
	//
	// The list is deliberately allowed to be shorter than the counts imply. A
	// change whose sentence was withheld is still counted and simply not
	// described, and no caller may draw attention to the gap — saying "some
	// changes are not described" invites exactly the question the withholding
	// existed to avoid.
	const CAT_RANK = { security: 0, feature: 1, fix: 2 };

	function applies(said, vendor) {
		if (!said || !said.length) return [];
		const mine = (vendor || '').toLowerCase();
		const rank = (c) => (c in CAT_RANK) ? CAT_RANK[c] : 3;
		return said
			.filter(n => !n.vendor || n.vendor === mine)
			.sort((a, b) => rank(a.cat) - rank(b.cat));
	}

	// The feed, or null. Never throws, never rejects: a camera with no route out
	// must not hold a page open waiting, and every caller treats null as "say
	// nothing" rather than as "nothing changed".
	function load(signal) {
		return fetch(FEED, { signal: signal, cache: 'no-cache' })
			.then(r => r.ok ? r.json() : Promise.reject(r.status))
			.catch(() => null);
	}

	window.MajesticChanges = {
		FEED, VENDOR_NAMES, CATEGORIES,
		esc, isDate, plural, parseBuild, daysSince, counts, delta, applies, load,
	};
})();
