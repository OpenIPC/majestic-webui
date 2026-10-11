// The Live bar on a small stage: one row, and the rest behind ⋯ More.
//
// On a phone the bar's groups -- View, Detail, Area, the stream, WebRTC/MSE,
// By ear, Stats, sound, talk -- wrapped to four rows over the lower half of the
// picture (measured on an iPhone at 390px). Most of them are for whoever is
// tuning the camera, not for somebody looking at it. So on a small stage the
// bar keeps what a viewer reaches for -- View, the stream, the snapshot and
// fullscreen -- and the others move, as the same live nodes with their wiring
// untouched, into a sheet that ⋯ More opens from the bottom. Leaving the small
// size puts each back where it was. A larger window never sees any of this.
// `$` is a global from main.js.
window.MajesticBarSheet = (function () {
	'use strict';

	// The groups that leave the bar on a small stage, in the bar's own order.
	const SHEET = ['mj-detail-ctl', 'mj-area-ctl', 'mj-peer-ctl', 'mj-audio-ctl', 'mj-talk-ctl',
		'mj-transport-ctl', 'mj-ear-ctl', 'mj-stats-ctl'];
	const SMALL = '(max-width: 575.98px), (max-height: 480px)';

	// Which groups the sheet holds and whether ⋯ More is worth showing: the
	// sheet's groups that are present, and More only when one of them is not
	// hidden -- a camera without audio, talk or a peer has fewer, and a sheet
	// of nothing is a button that opens nothing.
	function plan(present, hidden, small) {
		const moved = small ? SHEET.filter((id) => present.indexOf(id) >= 0) : [];
		const more = moved.some((id) => !hidden[id]);
		return { moved: moved, more: more };
	}

	function wire() {
		const stage = $('#mj-stage'), bar = $('#mj-bar');
		if (!stage || !bar || !window.matchMedia) return;
		const small = window.matchMedia(SMALL);
		const groups = SHEET.map((id) => document.getElementById(id)).filter(Boolean);
		if (!groups.length) return;

		// Where each group stands in the bar, so it goes back to that place.
		const marks = new Map();
		for (const g of groups) {
			const m = document.createComment(' ' + g.id + ' ');
			g.parentNode.insertBefore(m, g);
			marks.set(g, m);
		}

		const sheet = document.createElement('dialog');
		sheet.className = 'mj-more-sheet';
		sheet.setAttribute('aria-label', 'More controls');
		const head = document.createElement('div');
		head.className = 'mj-more-head';
		const title = document.createElement('span');
		title.className = 'mj-more-title';
		title.textContent = 'More';
		const close = document.createElement('button');
		close.type = 'button';
		close.className = 'mj-hud-ico mj-more-close';
		close.setAttribute('aria-label', 'Close');
		close.innerHTML = '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" ' +
			'stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M5 5l10 10M15 5 5 15"></path></svg>';
		head.append(title, close);
		const body = document.createElement('div');
		body.className = 'mj-more-body';
		sheet.append(head, body);
		// In the document, not the stage: the stage's own gestures -- pan,
		// pinch, drawing an Area, pressing a peer -- skip the bar's controls
		// by their place in .mj-bar, and a control moved under the stage
		// would be read as a touch on the picture. Out here none of them
		// sees it. A modal dialog is drawn on top whatever its parent.
		document.body.appendChild(sheet);

		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'mj-hud-ico mj-more-btn';
		btn.hidden = true;
		btn.setAttribute('aria-label', 'More controls');
		btn.title = 'More controls';
		btn.setAttribute('aria-haspopup', 'dialog');
		btn.innerHTML = '<svg viewBox="0 0 20 20" width="20" height="20" fill="currentColor" aria-hidden="true">' +
			'<circle cx="4.5" cy="10" r="1.6"></circle><circle cx="10" cy="10" r="1.6"></circle>' +
			'<circle cx="15.5" cy="10" r="1.6"></circle></svg>';
		const icons = bar.querySelector('.mj-ico-wrap');
		if (icons) icons.appendChild(btn); else bar.appendChild(btn);

		const keepBar = (on) => {
			stage.classList.toggle('mj-show', on || stage.classList.contains('mj-show'));
			stage.classList.toggle('mj-sheet-open', on);
		};
		const apply = () => {
			const hidden = {};
			for (const g of groups) hidden[g.id] = g.hidden;
			const p = plan(groups.map((g) => g.id), hidden, small.matches);
			for (const g of groups) {
				const into = p.moved.indexOf(g.id) >= 0;
				if (into && g.parentNode !== body) body.appendChild(g);
				else if (!into && g.parentNode === body) {
					const m = marks.get(g);
					m.parentNode.insertBefore(g, m.nextSibling);
				}
			}
			btn.hidden = !p.more;
			if (!p.more && sheet.open) sheet.close();
		};
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			if (sheet.open) { sheet.close(); return; }
			try { sheet.showModal(); } catch (err) { sheet.setAttribute('open', ''); }
			keepBar(true);
		});
		close.addEventListener('click', () => sheet.close());
		// A tap on the backdrop -- the dialog itself, outside its body -- closes.
		sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); });
		sheet.addEventListener('close', () => keepBar(false));

		apply();
		if (small.addEventListener) small.addEventListener('change', apply);
		else if (small.addListener) small.addListener(apply);
		// The groups are unhidden as the player learns what the camera has:
		// More follows.
		if (typeof MutationObserver === 'function') {
			const mo = new MutationObserver(apply);
			for (const g of groups) mo.observe(g, { attributes: true, attributeFilter: ['hidden'] });
		}
	}

	if (typeof document !== 'undefined' && document.getElementById) {
		if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
		else wire();
	}
	return { plan: plan, SHEET: SHEET };
})();
