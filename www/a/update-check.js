// "Your camera software is N builds behind", on every page.
//
// The counting lives in fw-changes.js, because the Firmware page asks the same
// question and must not answer it differently — see the note at the top of that
// file. What is here is this banner's own wording and its silences.
//
// Everything here fails to silence. No feed, no network, an unparseable body, a
// build the ledger has never heard of -- all render nothing. A camera that
// cannot answer the question must look normal, not alarmed.
(function () {
	'use strict';

	const C = window.MajesticChanges;

	// Whether an image this board can actually install exists. Same-origin, and
	// the same question the Firmware page asks, through the same updater.
	const FW_LATEST = '/cgi-bin/j/fw-latest.cgi';
	const SLOT = 'update-notice';
	const SEEN = 'mj-update-seen';
	// A build nobody has updated in half a year is a liability by itself, so it
	// escalates whatever happens to have shipped.
	const STALE_DAYS = 182;
	const TIMEOUT_MS = 6000;

	function sentence(d, mine, stale) {
		const t = d.totals;
		const parts = [];
		if (t.feature) parts.push(C.plural(t.feature, 'new feature', 'new features'));
		if (t.fix) parts.push(C.plural(t.fix, 'fix', 'fixes'));
		if (t.security) parts.push(C.plural(t.security, 'security fix', 'security fixes'));

		let head = '<b>Your camera software is ' + (d.atLeast ? 'at least ' : '') +
			C.plural(d.builds, 'build', 'builds') + ' behind</b>';
		if (!parts.length) {
			return head + ' &mdash; updating brings it in line with the current release.';
		}

		let s = head + (d.atLeast ? ' &mdash; in the changes we can see: '
			: ' &mdash; since your build: ') +
			parts.slice(0, -1).join(', ') +
			(parts.length > 1 ? ' and ' : '') + parts[parts.length - 1];
		if (mine) {
			s += ', including work on ' + C.esc(C.VENDOR_NAMES[mine] || mine) +
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

	// The counts are the headline because they are what makes the banner
	// scannable, but they are also the least useful thing in it: "11 fixes" does
	// not tell an owner whether any of them is theirs. The sentences do, and
	// until now they were fetched and thrown away.
	//
	// Collapsed by default. This sits on every page, and a banner that pushes
	// the page down to list a fortnight of changes is one people learn to close
	// rather than read. The Firmware page shows the same list open, because
	// there it is the page's subject rather than an interruption of one.
	const MAX_SHOWN = 8;

	function whatsNew(said, mine) {
		const sorted = C.applies(said, mine);
		if (!sorted.length) return '';
		const items = sorted.slice(0, MAX_SHOWN).map(n =>
			'<li>' + (n.cat === 'security' ? '<b>Security</b> &mdash; ' : '') +
			C.esc(n.text) + '</li>').join('');
		const rest = sorted.length - MAX_SHOWN;
		const more = rest > 0
			? '<p class="small text-secondary mb-0">and ' + rest + ' more</p>'
			: '';
		return '<details class="mj-whatsnew"><summary>What’s new</summary>' +
			'<ul class="small mb-1">' + items + '</ul>' + more + '</details>';
	}

	function render(slot, feed, build) {
		const d = C.delta(feed, build.rev, build.date);
		if (!d || d.builds === 0) return;

		const age = C.daysSince(build.date);
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
			body: whatsNew(d.said, mine),
			acts: '<a class="btn btn-sm btn-primary" href="update.cgi">Firmware update</a>',
			dismiss: true,
		});
		slot.addEventListener('click', e => {
			if (e.target.closest('[data-bs-dismiss]')) {
				try { localStorage.setItem(SEEN, feed.cursor); } catch (e2) { /* ignore */ }
			}
		});
	}

	document.addEventListener('DOMContentLoaded', function () {
		// The Firmware page renders no slot: pressing this banner's button is how
		// you get there, so the same sentence arriving again is a summons that
		// has already been answered. It says all of this as its own subject
		// instead — see p/header.cgi.
		const slot = document.getElementById(SLOT);
		if (!slot || typeof mjNotice !== 'function' || !C) return;

		const build = C.parseBuild(slot.dataset.mjVersion);
		if (!build) return;

		// A camera with no route out must not hold the page open waiting.
		const ctl = ('AbortController' in window) ? new AbortController() : null;
		const timer = setTimeout(() => ctl && ctl.abort(), TIMEOUT_MS);
		const signal = ctl ? ctl.signal : undefined;

		// Both questions, because either one alone misleads. The feed says what
		// changed in the camera's software; the endpoint says whether an image
		// carrying it exists for this board. Telling an owner they are behind
		// while the Firmware page offers them nothing to install is the
		// contradiction this pair exists to make impossible.
		const fw = fetch(FW_LATEST, { signal: signal, cache: 'no-cache' })
			.then(r => r.ok ? r.json() : Promise.reject(r.status))
			.catch(() => null);

		Promise.all([C.load(signal), fw])
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
