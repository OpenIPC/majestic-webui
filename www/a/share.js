// Share: hand this camera to someone else for a while, by link.
//
// The camera mints the link (POST /api/v1/shares); this is the dialog around
// it. The link's secret is shown exactly once, in the answer to the mint --
// the camera keeps only a hash of it -- so the dialog shows it the moment it
// arrives and never again. The list below it is the live shares, each with
// its access, when it ends and a way to end it now.
//
// While any link is live the navbar item says how many. A camera that can be
// opened from the Internet is a fact its owner should not have to open a
// dialog to be reminded of. A list that could not be read says nothing: no
// count is not a count of zero.
//
// Inside a share -- the camera's own pages carried to a guest by the share
// page -- none of this applies: a guest can neither see nor mint shares, and
// has no session of their own to sign out of. Both items are hidden there,
// and so is every menu entry the guest's access level would only be refused.
'use strict';

const SHARE_DURATIONS = [
	[3600, '1 h'],
	[7200, '2 h'],
	[8 * 3600, '8 h'],
	[86400, '1 day'],
	[3 * 86400, '3 days'],
	[7 * 86400, '7 days'],
];
const SHARE_DEFAULT_TTL = 7200;

// The access a link carries, as the owner chooses it. Watch only is the
// default: the common case is someone who should see the picture, and the
// level that can change the camera should be picked on purpose, not left on.
// `label` is how a live link names its access; `short` is the dialog's
// segmented control, three across a phone. Only the chosen level's hint is
// shown, and full control's is a warning: it says so where the choice is
// made rather than in a block of its own below it.
const SHARE_SCOPES = {
	view: {
		label: 'Watch only',
		short: 'Watch only',
		hint: 'The live picture. Nothing on the camera can be changed.',
	},
	admin: {
		label: 'Watch and change settings',
		short: 'Settings',
		hint: 'The camera’s pages and settings, but not its password, firmware, network, console or files. What they change stays changed after the link ends.',
	},
	full: {
		label: 'Full control',
		short: 'Full control',
		hint: 'Everything you can do: the console, firmware and files. Whoever holds the link has it until the link ends.',
		warn: true,
	},
};

// Where the dialog notes that this browser has made a link before. The
// explanation of what a link is stands open until then and folds to one line
// after: an owner who shares every day has read it.
const SHARE_SEEN_KEY = 'mj-share-seen';

// Whether the explanation should stand open: only when the note is known to
// be absent. Storage that cannot be read is not a first visit -- it would
// otherwise be one on every visit, which is the repetition this replaces --
// and the explanation is one click away either way.
function shareFirstTime(read) {
	try {
		return read(SHARE_SEEN_KEY) === null;
	} catch (e) {
		return false;
	}
}

// More live links than this fold behind their heading, so the form below
// them stays where the hand expects it.
const SHARE_LIVE_OPEN_MAX = 3;
function shareLiveFolded(count) {
	return count > SHARE_LIVE_OPEN_MAX;
}
const SHARE_DEFAULT_SCOPE = 'view';

// The pages a guest below full control is refused: the camera answers each
// of them 403 through a link that is not full control. Hiding them
// is not the protection -- the camera refuses them whatever the menu shows --
// it only spares the guest a menu of doors that do not open. A page missing
// here is still refused, it is just still offered.
const SHARE_OWNER_PAGES = [
	'access.cgi', 'update.cgi', 'backup.cgi', 'logs.cgi', 'console.cgi', 'files.cgi',
	'network.cgi', 'telegram.cgi', 'ntfy.cgi', 'max.cgi', 'openwall.cgi',
	'vtun.cgi', 'wireguard.cgi', 'proxy.cgi', 'restart.cgi',
	'time.cgi', 'sdcard.cgi', 'usb.cgi', 'wfb.cgi', 'crashlog.cgi',
];

// "1 h 52 min", "3 d 4 h", "4 min": what is left of a share at `now`.
function shareRemaining(expires, now) {
	const s = Math.max(0, Math.floor(expires - now / 1000));
	const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
	if (d) return `${d} d ${h} h`;
	if (h) return `${h} h ${m} min`;
	return `${Math.max(m, s > 0 ? 1 : 0)} min`;
}

// A moment as the owner's clock shows it: "16:51" today, "3 Oct 16:51" on
// any other day. A link lasts up to a week, so the time alone would be
// ambiguous for most of them.
const SHARE_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shareClock(t, now) {
	const d = new Date(t * 1000), n = new Date(now);
	const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
	const today = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
	return today ? hm : `${d.getDate()} ${SHARE_MONTHS[d.getMonth()]} ${hm}`;
}

// What each link is called in the list: its note, or when it was made. Two
// links without a note both read "Link" otherwise, and the owner ends the
// wrong one. Two that still share a name -- made in the same minute, or given
// the same note -- are numbered in the order they were made.
function shareNames(shares, now) {
	const base = shares.map((s) => s.label || 'Link from ' + shareClock(s.created, now));
	const order = shares.map((s, i) => i).sort((a, b) => shares[a].created - shares[b].created);
	const seen = {}, out = base.slice();
	for (const i of order) {
		const dup = base.filter((n) => n === base[i]).length > 1;
		seen[base[i]] = (seen[base[i]] || 0) + 1;
		if (dup) out[i] = `${base[i]} (${seen[base[i]]})`;
	}
	return out;
}

// "Watch only · ends 16:51 (in 1 h 58 min)". The time and the duration are
// each held on one line: "(in 59" above "min)" reads as two facts.
function shareSummary(s, now) {
	const scope = SHARE_SCOPES[s.scope] ? SHARE_SCOPES[s.scope].label : s.scope;
	const keep = (t) => t.replace(/ /g, '\u00a0');
	return `${scope} · ends ${keep(shareClock(s.expires, now))} ${keep(`(in ${shareRemaining(s.expires, now)})`)}`;
}

// The links still running at `now`, and how long until the next of them
// ends (null when none is running). A list the camera answered can hold a
// link that has run out since, and that one is not live.
function shareLive(list, now) {
	const live = (list || []).filter((s) => s.expires * 1000 > now);
	return { count: live.length, next: live.length ? Math.min(...live.map((s) => s.expires)) * 1000 - now : null };
}

// Whether this page is being shown to a share's guest: the share page is the
// parent, same origin, and announces itself.
function shareGuest(win) {
	try {
		return !!(win.parent && win.parent !== win && win.parent.__share);
	} catch (e) {
		return false;
	}
}

// The guest's access level, from the camera's welcome to the share page, or
// null where it is not known. Unknown is treated as the narrower level by the
// caller: a menu missing an entry costs a guest nothing the camera would give.
function shareGuestScope(win) {
	try {
		const w = win.parent.__share.welcome;
		return w && typeof w.scope === 'string' ? w.scope : null;
	} catch (e) {
		return null;
	}
}

// Whether a menu entry -- a link's href, or a form's action -- leads to a
// page a guest at `scope` is refused.
function shareRefused(href, scope) {
	if (scope === 'full') return false;
	const page = String(href || '').split(/[?#]/)[0].split('/').pop();
	return SHARE_OWNER_PAGES.includes(page);
}

// The sentence in the camera's error page: its <h1>, which the <title>
// repeats with the status code in front.
function shareReason(html) {
	const m = /<h1>([\s\S]*?)<\/h1>/i.exec(html || '');
	return (m ? m[1] : (html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// What the camera said, as a sentence for the owner.
function shareError(status, text) {
	if (status === 503) return 'The camera’s clock is not set yet, so it cannot tell when a link should end. Try again once it has synchronised.';
	if (status === 409) return 'This camera already has as many links as it can hold. End one below first.';
	if (status === 403) return 'Only the camera’s owner can share it.';
	return text || `The camera refused (HTTP ${status}).`;
}

if (typeof module !== 'undefined') {
	module.exports = {
		shareRemaining, shareClock, shareNames, shareSummary, shareLive, shareGuest, shareGuestScope, shareRefused,
		shareError, shareReason, SHARE_DURATIONS, SHARE_DEFAULT_TTL, SHARE_SCOPES, SHARE_DEFAULT_SCOPE,
		shareFirstTime, shareLiveFolded, SHARE_SEEN_KEY,
	};
}

// A guest's menu: Share and Sign out go, and so does every entry their level
// would be refused. A section heading left with nothing under it goes too.
function sharePruneGuestMenu(scope) {
	for (const id of ['nav-share', 'nav-logout']) {
		const a = document.getElementById(id);
		if (a) a.closest('li').classList.add('d-none');
	}
	// Other cameras on the owner's network are nobody else's business, and
	// their addresses lead nowhere from outside it.
	const sw = document.getElementById('cam-switch');
	if (sw) sw.classList.add('d-none');
	for (const a of document.querySelectorAll('.navbar a.dropdown-item, .navbar a.nav-link')) {
		if (shareRefused(a.getAttribute('href'), scope)) a.closest('li').classList.add('d-none');
	}
	// Restart is a form, not a link: it posts rather than navigates.
	for (const f of document.querySelectorAll('.navbar form[action]')) {
		if (shareRefused(f.getAttribute('action'), scope)) f.closest('li').classList.add('d-none');
	}
	// A banner whose every action is a refused page -- the crash report the
	// owner is asked to look at -- is the owner's, not the guest's. One that
	// also offers something the guest may open keeps its words and that
	// action, and loses only the refused link: the live picture's diagnosis
	// still explains the fault, and points at the settings, without the logs.
	for (const box of document.querySelectorAll('.alert')) {
		const links = [...box.querySelectorAll('a[href]')];
		const refused = links.filter((a) => shareRefused(a.getAttribute('href'), scope));
		if (!refused.length) continue;
		if (refused.length === links.length) box.classList.add('d-none');
		else for (const a of refused) a.classList.add('d-none');
	}
	for (const h of document.querySelectorAll('.navbar .dropdown-header')) {
		const head = h.closest('li');
		let empty = true;
		for (let li = head.nextElementSibling; li && !li.querySelector('.dropdown-header'); li = li.nextElementSibling) {
			if (!li.classList.contains('d-none') && !li.hidden) { empty = false; break; }
		}
		if (empty) head.classList.add('d-none');
	}
	// And a whole menu with nothing left in it: a heading the guest can open
	// onto an empty list is a door to nothing.
	for (const menu of document.querySelectorAll('.navbar .nav-item.dropdown')) {
		const left = [...menu.querySelectorAll('.dropdown-item')].some((i) => !i.closest('.d-none') && !i.closest('[hidden]'));
		if (!left) menu.classList.add('d-none');
	}
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => {
	const item = document.getElementById('nav-share');
	if (!item) return;
	if (shareGuest(window)) {
		sharePruneGuestMenu(shareGuestScope(window));
		return;
	}

	const el = (tag, attrs, ...kids) => {
		const n = document.createElement(tag);
		for (const [k, v] of Object.entries(attrs || {})) {
			if (k === 'text') n.textContent = v; else if (k === 'class') n.className = v; else n.setAttribute(k, v);
		}
		for (const c of kids) if (c) n.append(c);
		return n;
	};

	// The navbar item: "Share", or "Share" and the number of live links --
	// those whose end is still ahead, counted again when the next one runs out,
	// so a page left open does not go on calling an ended link live. `null` is
	// a list that could not be read, and shows no count: not zero, and not the
	// last number either.
	let navList = null, navTimer = null;
	const navShow = (list) => {
		navList = list;
		clearTimeout(navTimer);
		navTimer = null;
		const { count, next } = shareLive(list, Date.now());
		item.replaceChildren('Share');
		item.title = 'Share this camera by link';
		if (!count) return;
		item.append(el('span', { class: 'badge text-bg-warning ms-1 align-middle', text: String(count) }));
		item.title = count === 1
			? 'One link is live: someone can open this camera over the Internet.'
			: `${count} links are live: they can open this camera over the Internet.`;
		navTimer = setTimeout(() => navShow(navList), next + 1000);
	};

	// Every read of the list, this first one included, takes a number, and
	// only the newest may paint: an older reply arriving late would otherwise
	// put back a count, or a list, from before the link just made or ended.
	let generation = 0;
	const first = ++generation;
	apiFetch('/api/v1/shares')
		.then((r) => (r.ok ? r.json() : null))
		.then((d) => { if (first === generation) navShow(d && Array.isArray(d.shares) ? d.shares : null); })
		.catch(() => { if (first === generation) navShow(null); });

	// The dialog is two views that take turns rather than one column: the form,
	// and the link it made. Stacked, the link landed under the form -- on a
	// MacBook Air's 830px window, below the dialog's own edge, in a body that
	// scrolled without a scrollbar -- and it is the one thing the owner came
	// for and the one thing shown only once.
	const radios = (name, cls, items, checked) => items.map(([value, text]) => {
		const id = `share-${name}-${value}`;
		const r = el('input', { class: 'mj-seg-in', type: 'radio', name: 'share-' + name, id, value: String(value) });
		if (value === checked) r.checked = true;
		return [r, el('label', { class: cls, for: id, text })];
	}).flat();

	const scopeIds = Object.keys(SHARE_SCOPES);
	const scopes = el('div', { class: 'mj-seg mj-share-seg', role: 'radiogroup', 'aria-labelledby': 'share-scope-cap' },
		...radios('scope', 'mj-seg-lbl', scopeIds.map((k) => [k, SHARE_SCOPES[k].short]), SHARE_DEFAULT_SCOPE));
	const hint = el('div', { class: 'mj-share-hint', id: 'share-scope-hint', 'aria-live': 'polite' });
	for (const r of scopes.querySelectorAll('input')) r.setAttribute('aria-describedby', 'share-scope-hint');
	const ttls = el('div', { class: 'mj-share-chips', role: 'radiogroup', 'aria-labelledby': 'share-ttl-cap' },
		...radios('ttl', 'mj-share-chip', SHARE_DURATIONS, SHARE_DEFAULT_TTL));
	const label = el('input', { class: 'form-control', id: 'share-label', maxlength: '64', placeholder: 'Who is it for? (optional)' });
	// Not "straight to the camera": a guest behind a strict NAT is relayed.
	// What holds either way is that the relay carries only encrypted traffic,
	// and that no password goes anywhere.
	const about = el('details', { class: 'mj-share-about' },
		el('summary', { text: 'Anyone with the link can open this camera until it ends.' }),
		el('p', { text: 'Over the Internet, until the link ends or you end it. What they see is encrypted between their browser and the camera, and your password is never shared.' }));
	const err = el('div', { class: 'alert alert-danger py-2 mb-0 d-none', role: 'alert' });

	const liveCap = el('button', { class: 'mj-cap mj-share-live-cap', type: 'button', 'aria-expanded': 'true', 'aria-controls': 'share-live-list' });
	const list = el('div', { class: 'd-flex flex-column gap-2', id: 'share-live-list' });
	const live = el('div', { class: 'd-flex flex-column gap-1 d-none' }, liveCap, list);

	const create = el('button', { class: 'btn btn-primary mj-share-go', type: 'button' });

	const compose = el('div', { class: 'mj-share-view' },
		el('div', { class: 'modal-body mj-share-body' },
			live,
			el('div', { class: 'd-flex flex-column gap-1' },
				el('span', { class: 'mj-cap', id: 'share-scope-cap', text: 'They can' }), scopes, hint),
			el('div', { class: 'd-flex flex-column gap-1' },
				el('span', { class: 'mj-cap', id: 'share-ttl-cap', text: 'For' }), ttls),
			el('div', { class: 'd-flex flex-column gap-1' },
				el('label', { class: 'mj-cap', for: 'share-label', text: 'Note' }), label),
			about, err),
		el('div', { class: 'modal-footer' }, create));

	const readyLead = el('span', { class: 'fw-semibold' });
	const okMark = el('span', { class: 'mj-share-ok', 'aria-hidden': 'true' });
	okMark.innerHTML = '<svg viewBox="0 0 20 20" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" ' +
		'stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="8"></circle><path d="M6.5 10.2 9 12.6l4.5-5"></path></svg>';
	const readyLink = el('input', { class: 'form-control font-monospace mj-share-link', readonly: '', 'aria-label': 'Link' });
	const copy = el('button', { class: 'btn btn-primary mj-share-copy', type: 'button', text: 'Copy' });
	const readyWhat = el('div', { class: 'small text-body-secondary' });
	const another = el('button', { class: 'btn btn-outline-secondary', type: 'button', text: 'Create another' });
	const doneBtn = el('button', { class: 'btn btn-primary', type: 'button', text: 'Done' });
	const ready = el('div', { class: 'mj-share-view', hidden: '' },
		el('div', { class: 'modal-body mj-share-body' },
			el('div', { class: 'd-flex align-items-center gap-2' },
				okMark, readyLead),
			el('div', { class: 'mj-share-linkrow' }, readyLink, copy),
			readyWhat,
			el('div', { class: 'small text-body-secondary', text: 'Shown only now: the camera keeps no copy it could show again.' })),
		el('div', { class: 'modal-footer' }, another, doneBtn));

	// Named, because the camera switcher makes "this camera" ambiguous: the
	// owner may have several open, and a link to the wrong one is a link to
	// somebody's other room.
	const camera = item.dataset.camera;
	const composeTitle = camera ? `Share ${camera}` : 'Share this camera';
	const title = el('h5', { class: 'modal-title text-truncate', text: composeTitle });
	const dlg = el('dialog', { class: 'mj-modal mj-share', id: 'share-dlg', 'aria-labelledby': 'share-dlg-title' },
		el('div', { class: 'modal-header' }, title,
			el('button', { class: 'btn-close', 'data-bs-dismiss': 'modal', 'aria-label': 'Close' })),
		compose, ready);
	title.id = 'share-dlg-title';
	document.body.append(dlg);

	const pickedScope = () => scopes.querySelector('input:checked').value;
	const showScope = () => {
		const s = SHARE_SCOPES[pickedScope()];
		hint.textContent = s.hint;
		hint.classList.toggle('mj-share-warn', !!s.warn);
		create.textContent = s.warn ? 'Create full-control link' : 'Create link';
	};
	for (const r of scopes.querySelectorAll('input')) r.addEventListener('change', showScope);
	showScope();

	const showError = (text) => {
		err.textContent = text;
		err.classList.toggle('d-none', !text);
		if (text && err.scrollIntoView) err.scrollIntoView({ block: 'nearest' });
	};

	const show = (view) => {
		compose.hidden = view !== 'compose';
		ready.hidden = view !== 'ready';
		title.textContent = view === 'ready' ? 'Link ready' : composeTitle;
	};

	// Folded when there are many, until the owner opens them; the choice holds
	// while the dialog is open.
	let liveOpen = null;
	liveCap.addEventListener('click', () => {
		liveOpen = liveCap.getAttribute('aria-expanded') !== 'true';
		liveCap.setAttribute('aria-expanded', String(liveOpen));
		list.classList.toggle('d-none', !liveOpen);
	});
	const liveHead = (text, foldable) => {
		liveCap.textContent = text;
		liveCap.disabled = !foldable;
		const open = foldable ? (liveOpen === null ? false : liveOpen) : true;
		liveCap.setAttribute('aria-expanded', String(open));
		// A class, not `hidden`: the list is d-flex, whose !important display
		// outranks the attribute, and a folded list stayed open.
		list.classList.toggle('d-none', !open);
	};

	// The last list the camera gave, so the clock can move the times on
	// without asking again; and how many Ends are still waiting on an answer,
	// during which the clock leaves the list alone rather than give a pressed
	// button back.
	let shares = null;
	let ending = 0;

	function paint() {
		const now = Date.now();
		const running = shares.filter((s) => s.expires * 1000 > now);
		// None: nothing to say here. The navbar has no count either, and the
		// form below is what the dialog is for.
		live.classList.toggle('d-none', !running.length);
		if (!running.length) { list.replaceChildren(); return; }
		liveHead(`Live now · ${running.length}`, shareLiveFolded(running.length));
		const names = shareNames(running, now);
		list.replaceChildren(...running.map((s, i) => {
			const end = el('button', { class: 'btn btn-sm btn-outline-danger flex-shrink-0 mj-share-end', type: 'button', text: 'End', 'aria-label': 'End ' + names[i] });
			end.addEventListener('click', async () => {
				showError('');
				end.disabled = true;
				ending++;
				try {
					const r = await apiFetch('/api/v1/shares?id=' + encodeURIComponent(s.id), { method: 'DELETE' });
					// 500 is "ended now, but not saved": the camera's own sentence
					// says what that means, and it is the one worth showing.
					if (!r.ok && r.status !== 404) showError(shareError(r.status, shareReason(await r.text())));
				} catch (e) {
					// Not known to have ended: say so, and leave the button to
					// try again with.
					showError('The camera did not answer. The link may still work; try End again.');
					end.disabled = false;
					return;
				} finally {
					ending--;
				}
				refreshList();
			});
			// Full control reads in the warning colour wherever it is listed.
			const warn = SHARE_SCOPES[s.scope] && SHARE_SCOPES[s.scope].warn;
			const what = el('div', { class: warn ? 'small mj-share-warn' : 'small text-body-secondary', text: shareSummary(s, now) });
			return el('div', { class: 'd-flex align-items-center gap-2 border rounded ps-3 pe-2 py-2' },
				el('div', { class: 'flex-grow-1', style: 'min-width:0' },
					el('div', { class: 'fw-semibold text-truncate', text: names[i] }), what),
				end);
		}));
	}

	async function refreshList() {
		const mine = ++generation;
		let data;
		try {
			const r = await apiFetch('/api/v1/shares');
			if (!r.ok) throw new Error(shareError(r.status));
			data = await r.json();
		} catch (e) {
			if (mine === generation) {
				// Could not ask is not "none": the heading stays, with why.
				shares = null;
				navShow(null);
				live.classList.remove('d-none');
				liveHead('Live now', false);
				list.replaceChildren(el('span', { class: 'text-danger small', text: e.message }));
			}
			return;
		}
		if (mine !== generation) return;
		shares = data.shares;
		navShow(shares);
		paint();
	}

	// While the dialog is open the times move on with the clock. A link that
	// has run out is asked about again rather than shown at "0 min".
	let tick = null;
	dlg.addEventListener('close', () => { clearInterval(tick); tick = null; });

	const readSeen = (k) => localStorage.getItem(k);

	create.addEventListener('click', async () => {
		showError('');
		create.disabled = true;
		try {
			const scope = pickedScope();
			const ttl = +ttls.querySelector('input:checked').value;
			const note = label.value.trim();
			const r = await apiFetch('/api/v1/shares', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ttl, scope, label: note }),
			});
			if (!r.ok) { showError(shareError(r.status, shareReason(await r.text()))); return; }
			const s = await r.json();
			try { localStorage.setItem(SHARE_SEEN_KEY, '1'); } catch (e) { /* a convenience */ }
			readyLead.textContent = note ? `Send this link to ${note}` : 'Send this link to whoever it is for';
			readyLink.value = s.link;
			// Only what the camera answered: it states the link's access and end
			// with the link. An answer without them shows neither, rather than
			// what was asked for and the browser's clock passed off as the
			// camera's; the live list above has the camera's own once it loads.
			const known = typeof s.scope === 'string' && s.scope && Number.isFinite(s.expires) && s.expires > 0;
			readyWhat.textContent = known ? shareSummary(s, Date.now()) : '';
			readyWhat.classList.toggle('d-none', !known);
			copy.textContent = 'Copy';
			copy.classList.remove('btn-success');
			copy.classList.add('btn-primary');
			label.value = '';
			show('ready');
			copy.focus();
			refreshList();
		} catch (e) {
			showError(e.message);
		} finally {
			create.disabled = false;
		}
	});

	copy.addEventListener('click', async () => {
		let copied = false;
		try {
			await navigator.clipboard.writeText(readyLink.value);
			copied = true;
		} catch (e) {
			readyLink.select();
			try { copied = document.execCommand('copy'); } catch (e2) { copied = false; }
		}
		// Only a copy that happened is reported as one: this link is shown
		// once, and an owner told it is on the clipboard will close the
		// dialog on the strength of it.
		copy.textContent = copied ? 'Copied' : 'Select and copy it';
		copy.classList.toggle('btn-success', copied);
		copy.classList.toggle('btn-primary', !copied);
		if (!copied) readyLink.select();
	});
	readyLink.addEventListener('focus', () => readyLink.select());

	another.addEventListener('click', () => {
		show('compose');
		scopes.querySelector('input:checked').focus();
	});
	doneBtn.addEventListener('click', () => bootstrap.Modal.getOrCreateInstance(dlg).hide());

	item.addEventListener('click', (ev) => {
		ev.preventDefault();
		showError('');
		show('compose');
		about.open = shareFirstTime(readSeen);
		liveOpen = null;
		bootstrap.Modal.getOrCreateInstance(dlg).show();
		refreshList();
		clearInterval(tick);
		tick = setInterval(() => {
			if (!shares || ending) return;
			if (shares.some((s) => s.expires * 1000 <= Date.now())) refreshList();
			else paint();
		}, 30000);
	});
});
