// "Your camera software is N builds behind", on every page.
//
// The camera never contacts the internet for this. It reports only what it
// already knows about itself -- the data attributes p/header.cgi puts on the
// slot, from update_caminfo() -- and this browser fetches the public feed and
// does the arithmetic. A camera on an isolated network is not nagged, is not
// slowed, and is not made to phone anywhere.
//
// One URL for everybody, no query string and no camera identity in the request:
// fetching the feed says only that somebody opened an OpenIPC web interface.
//
// Everything here fails to silence. No feed, no network, an unparseable body, a
// build the ledger has never heard of -- all render nothing. A camera that
// cannot answer the question must look normal, not alarmed.
(function () {
	'use strict';

	const FEED = 'https://openipc.s3-eu-west-1.amazonaws.com/majestic-changes.json';
	// Whether an image this board can actually install exists. Same-origin, and
	// the same question the Firmware page asks, through the same updater.
	const FW_LATEST = '/cgi-bin/j/fw-latest.cgi';
	const SLOT = 'update-notice';
	const SEEN = 'mj-update-seen';
	// A build nobody has updated in half a year is a liability by itself, so it
	// escalates whatever happens to have shipped.
	const STALE_DAYS = 182;
	const TIMEOUT_MS = 6000;

	// `ipcinfo --vendor` is lowercase and so is the feed's token; this is only
	// for the sentence.
	const VENDOR_NAMES = {
		hisilicon: 'HiSilicon', sigmastar: 'SigmaStar', ingenic: 'Ingenic',
		rockchip: 'Rockchip', novatek: 'Novatek', fullhan: 'Fullhan',
		grainmedia: 'GrainMedia', xiongmai: 'Xiongmai', allwinner: 'Allwinner',
	};

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

	const CATEGORIES = ['feature', 'fix', 'security', 'other'];

	// A count is a count, or the entry is not usable.
	//
	// Two reasons, and the weaker one is the interesting one. An absent reading
	// is not a zero: an entry missing its `fix` count would otherwise render a
	// confident total that silently understates what the owner would gain, and
	// could drop the severity from warn to info by losing a security count.
	//
	// The stronger reason is that this arrives over the network and ends up in
	// innerHTML. Anything that is not a plain non-negative integer -- a string
	// carrying markup, most obviously -- must never reach the sentence builder,
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
		const totals = { feature: 0, fix: 0, security: 0, other: 0 };
		const vendors = new Set();
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
				if (note && typeof note.vendor === 'string') vendors.add(note.vendor);
			}
		}
		if (found) return { builds, totals, vendors, atLeast: false };

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
		const eldest = feed.builds[feed.builds.length - 1];
		if (isDate(buildDate) && eldest && isDate(eldest.date) &&
			buildDate < eldest.date) {
			return { builds, totals, vendors, atLeast: true };
		}
		return null;
	}

	function sentence(d, mine, stale) {
		const t = d.totals;
		const parts = [];
		if (t.feature) parts.push(plural(t.feature, 'new feature', 'new features'));
		if (t.fix) parts.push(plural(t.fix, 'fix', 'fixes'));
		if (t.security) parts.push(plural(t.security, 'security fix', 'security fixes'));

		let head = '<b>Your camera software is ' + (d.atLeast ? 'at least ' : '') +
			plural(d.builds, 'build', 'builds') + ' behind</b>';
		if (!parts.length) {
			return head + ' &mdash; updating brings it in line with the current release.';
		}

		let s = head + (d.atLeast ? ' &mdash; in the changes we can see: '
			: ' &mdash; since your build: ') +
			parts.slice(0, -1).join(', ') +
			(parts.length > 1 ? ' and ' : '') + parts[parts.length - 1];
		if (mine) {
			s += ', including work on ' + esc(VENDOR_NAMES[mine] || mine) +
				' cameras like this one';
		}
		s += '.';
		if (stale) {
			// What is known is the date the running software was BUILT, which
			// is not when the camera was flashed: a camera set up yesterday
			// from an old image would be told it had been neglected for half a
			// year. Say only the part the build date supports.
			s += ' The software on this camera is over six months old.';
		}
		return s;
	}

	function render(slot, feed, build) {
		const d = delta(feed, build.rev, build.date);
		if (!d || d.builds === 0) return;

		const age = daysSince(build.date);
		const stale = age !== null && age > STALE_DAYS;
		const mine = (slot.dataset.socVendor || '').toLowerCase();
		const matched = mine && d.vendors.has(mine) ? mine : null;
		const severity = (d.totals.security || stale) ? 'warn' : 'info';

		// Dismissal is keyed on what the feed knows, so closing it means "not
		// now" rather than "never": the banner returns when something new lands.
		let seen = null;
		try { seen = localStorage.getItem(SEEN); } catch (e) { /* private mode */ }
		if (seen === feed.cursor) return;

		// A plain link, like every other notice that points at a page. This
		// was a filled btn-primary, which put two notices side by side on the
		// Dashboard making the same offer -- go to a page -- in two different
		// shapes (#347). A .btn in a notice means the press acts on the camera
		// then and there; this one navigates.
		slot.innerHTML = mjNotice(severity, sentence(d, matched, stale), {
			acts: '<a href="update.cgi">Firmware update &rarr;</a>',
			dismiss: true,
		});
		slot.addEventListener('click', e => {
			if (e.target.closest('[data-bs-dismiss]')) {
				try { localStorage.setItem(SEEN, feed.cursor); } catch (e2) { /* ignore */ }
			}
		});
	}

	document.addEventListener('DOMContentLoaded', function () {
		const slot = document.getElementById(SLOT);
		if (!slot || typeof mjNotice !== 'function') return;

		const build = parseBuild(slot.dataset.mjVersion);
		if (!build) return;

		// A camera with no route out must not hold the page open waiting.
		const ctl = ('AbortController' in window) ? new AbortController() : null;
		const timer = setTimeout(() => ctl && ctl.abort(), TIMEOUT_MS);
		const signal = ctl ? ctl.signal : undefined;
		const grab = (url) => fetch(url, { signal: signal, cache: 'no-cache' })
			.then(r => r.ok ? r.json() : Promise.reject(r.status))
			.catch(() => null);

		// Both questions, because either one alone misleads. The feed says what
		// changed in the camera's software; the endpoint says whether an image
		// carrying it exists for this board. Telling an owner they are behind
		// while the Firmware page offers them nothing to install is the
		// contradiction this pair exists to make impossible.
		Promise.all([grab(FEED), grab(FW_LATEST)])
			.then(([feed, fw]) => {
				// `newer` is true, false, or null for "cannot tell". Only true
				// is permission to speak: an unreachable updater is not evidence
				// that an update exists.
				if (!feed || !fw || fw.newer !== true) return;
				render(slot, feed, build);
			})
			.catch(() => { /* offline, blocked, or malformed: say nothing */ })
			.then(() => clearTimeout(timer));
	});
})();
