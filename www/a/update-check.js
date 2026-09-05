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
		return { rev: rev[1], date: date ? date[1] : null };
	}

	function daysSince(iso) {
		if (!iso) return null;
		const then = Date.parse(iso + 'T00:00:00Z');
		if (isNaN(then)) return null;
		return Math.floor((Date.now() - then) / 86400000);
	}

	// Everything published after the running build. The camera's own revision
	// is the boundary: a commit above it is in the next build it takes,
	// whichever night that one happened to publish.
	function delta(feed, rev) {
		const totals = { feature: 0, fix: 0, security: 0, other: 0 };
		const vendors = new Set();
		let builds = 0, found = false;

		for (const entry of feed.builds || []) {
			if (entry.sha && rev.indexOf(entry.sha) === 0) { found = true; break; }
			if (entry.sha && entry.sha.indexOf(rev) === 0) { found = true; break; }
			builds++;
			for (const k in totals) totals[k] += (entry.counts && entry.counts[k]) || 0;
			for (const note of entry.notes || []) {
				if (note.vendor) vendors.add(note.vendor);
			}
		}
		// Not in the ledger: either newer than the feed (nothing to say) or
		// older than it reaches (we would be guessing). Say nothing either way.
		if (!found) return null;
		return { builds, totals, vendors };
	}

	function sentence(d, mine, stale) {
		const t = d.totals;
		const parts = [];
		if (t.feature) parts.push(plural(t.feature, 'new feature', 'new features'));
		if (t.fix) parts.push(plural(t.fix, 'fix', 'fixes'));
		if (t.security) parts.push(plural(t.security, 'security fix', 'security fixes'));

		let head = '<b>Your camera software is ' +
			plural(d.builds, 'build', 'builds') + ' behind</b>';
		if (!parts.length) {
			return head + ' &mdash; updating brings it in line with the current release.';
		}

		let s = head + ' &mdash; since your build: ' +
			parts.slice(0, -1).join(', ') +
			(parts.length > 1 ? ' and ' : '') + parts[parts.length - 1];
		if (mine) {
			s += ', including work on ' + esc(VENDOR_NAMES[mine] || mine) +
				' cameras like this one';
		}
		s += '.';
		if (stale) {
			s += ' This camera has not been updated in over six months.';
		}
		return s;
	}

	function render(slot, feed, build) {
		const d = delta(feed, build.rev);
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

		slot.innerHTML = mjNotice(severity, sentence(d, matched, stale), {
			acts: '<a class="btn btn-primary btn-sm" href="update.cgi">Firmware update &rarr;</a>',
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

		fetch(FEED, { signal: ctl ? ctl.signal : undefined, cache: 'no-cache' })
			.then(r => r.ok ? r.json() : Promise.reject(r.status))
			.then(feed => render(slot, feed, build))
			.catch(() => { /* offline, blocked, or malformed: say nothing */ })
			.then(() => clearTimeout(timer));
	});
})();
