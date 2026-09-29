// Share: hand this camera to someone else for a while, by link.
//
// The camera mints the link (POST /api/v1/shares); this is the dialog around
// it. The link's secret is shown exactly once, in the answer to the mint --
// the camera keeps only a hash of it -- so the dialog shows it the moment it
// arrives and never again. The list below it is the live shares, each with
// its access, its remaining time and a way to end it now.
//
// Inside a share -- the camera's own pages carried to a guest by the share
// page -- none of this applies: a guest can neither see nor mint shares, and
// has no session of their own to sign out of. Both items are hidden there.
'use strict';

const SHARE_DURATIONS = [
	[3600, '1 hour'],
	[7200, '2 hours'],
	[8 * 3600, '8 hours'],
	[86400, '1 day'],
	[3 * 86400, '3 days'],
	[7 * 86400, '7 days'],
];
const SHARE_DEFAULT_TTL = 7200;

const SHARE_SCOPES = {
	view: 'Watch only',
	admin: 'Watch and change settings',
	full: 'Full control',
};

// "1 h 52 min", "3 d 4 h", "4 min": what is left of a share at `now`.
function shareRemaining(expires, now) {
	const s = Math.max(0, Math.floor(expires - now / 1000));
	const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
	if (d) return `${d} d ${h} h`;
	if (h) return `${h} h ${m} min`;
	return `${Math.max(m, s > 0 ? 1 : 0)} min`;
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
	module.exports = { shareRemaining, shareGuest, shareError, shareReason, SHARE_DURATIONS, SHARE_DEFAULT_TTL };
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => {
	const item = document.getElementById('nav-share');
	if (!item) return;
	if (shareGuest(window)) {
		item.closest('li').classList.add('d-none');
		const out = document.getElementById('nav-logout');
		if (out) out.closest('li').classList.add('d-none');
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

	const ttl = el('select', { class: 'form-select', id: 'share-ttl' });
	for (const [s, label] of SHARE_DURATIONS) {
		const o = el('option', { value: String(s), text: label });
		if (s === SHARE_DEFAULT_TTL) o.selected = true;
		ttl.append(o);
	}
	const scopes = el('div', { class: 'd-flex flex-column gap-1' });
	for (const [k, label] of Object.entries(SHARE_SCOPES)) {
		const id = 'share-scope-' + k;
		const r = el('input', { class: 'form-check-input', type: 'radio', name: 'share-scope', id, value: k });
		if (k === 'admin') r.checked = true;
		scopes.append(el('div', { class: 'form-check' }, r, el('label', { class: 'form-check-label', for: id, text: label })));
	}
	const fullWarn = el('div', { class: 'alert alert-warning py-2 mb-0 d-none', text:
		'Full control includes the console, firmware and files: whoever holds the link can do anything you can, until it ends.' });
	const label = el('input', { class: 'form-control', id: 'share-label', maxlength: '64', placeholder: 'Who is it for? (optional)' });
	const create = el('button', { class: 'btn btn-primary', type: 'button', text: 'Create link' });
	const err = el('div', { class: 'alert alert-danger py-2 mb-0 d-none' });
	const result = el('div', { class: 'd-none' });
	const list = el('div', { class: 'd-flex flex-column gap-2' });

	const dlg = el('dialog', { class: 'mj-modal', id: 'share-dlg' },
		el('div', { class: 'modal-header' },
			el('h5', { class: 'modal-title', text: 'Share this camera' }),
			el('button', { class: 'btn-close', 'data-bs-dismiss': 'modal', 'aria-label': 'Close' })),
		el('div', { class: 'modal-body d-flex flex-column gap-3' },
			el('p', { class: 'mb-0 text-body-secondary', text:
				'Anyone with the link can reach this camera over the Internet until the link ends or you end it. The connection goes straight to the camera; your password is never shared.' }),
			el('div', {}, el('label', { class: 'form-label mj-cap', for: 'share-ttl', text: 'For' }), ttl),
			el('div', {}, el('span', { class: 'form-label mj-cap d-block', text: 'They can' }), scopes),
			fullWarn,
			el('div', {}, el('label', { class: 'form-label mj-cap', for: 'share-label', text: 'Note' }), label),
			el('div', {}, create),
			err, result,
			el('div', {}, el('span', { class: 'form-label mj-cap d-block', text: 'Active links' }), list)));
	document.body.append(dlg);

	for (const r of scopes.querySelectorAll('input')) {
		r.addEventListener('change', () => fullWarn.classList.toggle('d-none', r.value !== 'full' || !r.checked));
	}

	const showError = (text) => { err.textContent = text; err.classList.toggle('d-none', !text); };

	async function refreshList() {
		list.replaceChildren(el('span', { class: 'text-body-secondary', text: 'Loading…' }));
		let data;
		try {
			const r = await apiFetch('/api/v1/shares');
			if (!r.ok) throw new Error(shareError(r.status));
			data = await r.json();
		} catch (e) {
			list.replaceChildren(el('span', { class: 'text-danger', text: e.message }));
			return;
		}
		if (!data.shares.length) {
			list.replaceChildren(el('span', { class: 'text-body-secondary', text: 'None. Nobody can reach this camera by link.' }));
			return;
		}
		list.replaceChildren(...data.shares.map((s) => {
			const end = el('button', { class: 'btn btn-sm btn-outline-danger', type: 'button', text: 'End now' });
			end.addEventListener('click', async () => {
				end.disabled = true;
				const r = await apiFetch('/api/v1/shares?id=' + encodeURIComponent(s.id), { method: 'DELETE' });
				// 500 is "ended now, but not saved": the camera's own sentence
				// says what that means, and it is the one worth showing.
				if (!r.ok && r.status !== 404)
					showError(shareError(r.status, shareReason(await r.text())));
				refreshList();
			});
			return el('div', { class: 'd-flex align-items-center gap-2 border rounded px-2 py-1' },
				el('div', { class: 'flex-grow-1', style: 'min-width:0' },
					el('div', { class: 'fw-semibold text-truncate', text: s.label || 'Link' }),
					el('div', { class: 'small text-body-secondary', text:
						(SHARE_SCOPES[s.scope] || s.scope) + ' · ends in ' + shareRemaining(s.expires, Date.now()) })),
				end);
		}));
	}

	create.addEventListener('click', async () => {
		showError('');
		create.disabled = true;
		try {
			const scope = scopes.querySelector('input:checked').value;
			const r = await apiFetch('/api/v1/shares', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ttl: +ttl.value, scope, label: label.value.trim() }),
			});
			if (!r.ok) { showError(shareError(r.status, shareReason(await r.text()))); return; }
			const s = await r.json();
			const link = el('input', { class: 'form-control font-monospace', readonly: '', value: s.link });
			const copy = el('button', { class: 'btn btn-outline-secondary', type: 'button', text: 'Copy' });
			copy.addEventListener('click', async () => {
				try { await navigator.clipboard.writeText(s.link); copy.textContent = 'Copied'; }
				catch (e) { link.select(); document.execCommand('copy'); copy.textContent = 'Copied'; }
			});
			result.replaceChildren(
				el('div', { class: 'alert alert-success py-2 mb-2', text:
					'Send this link to the person you are sharing with. It is shown only now: the camera keeps no copy it could show again.' }),
				el('div', { class: 'input-group' }, link, copy));
			result.classList.remove('d-none');
			label.value = '';
			refreshList();
		} catch (e) {
			showError(e.message);
		} finally {
			create.disabled = false;
		}
	});

	item.addEventListener('click', (ev) => {
		ev.preventDefault();
		result.classList.add('d-none');
		result.replaceChildren();
		showError('');
		bootstrap.Modal.getOrCreateInstance(dlg).show();
		refreshList();
	});
});
