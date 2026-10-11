// The Live bar on a small stage: one row, and the rest behind ⋯ More.
//
// On a phone the bar's groups -- View, Detail, Area, the stream, WebRTC/MSE,
// By ear, Stats, sound, talk -- wrapped to four rows over the lower half of the
// picture (measured on an iPhone at 390px). Most of them are for whoever is
// tuning the camera, not for somebody looking at it. So on a small stage the
// bar keeps what a viewer reaches for -- View, the stream and two icons -- and
// the others move, as the same live nodes with their wiring untouched, into a
// list that ⋯ More opens from the bottom: one row each, its name, one line on
// what it does, and its control. Leaving the small size puts each back where
// it was. A larger window never sees any of this.
//
// It also offers Fill screen where the browser has no fullscreen for the
// page (an iPhone): the navbar, the banners and -- inside a share -- the share
// page's own bar go, and the picture takes the screen.
// `$` is a global from main.js.
window.MajesticBarSheet = (function () {
	'use strict';

	// The groups that leave the bar on a small stage, in the bar's own order.
	// The Source chooser (a second sensor, a USB webcam) is among them: beside
	// the stream it is what made the row wrap on a camera that has one.
	const SHEET = ['mj-detail-ctl', 'mj-area-ctl', 'mj-peer-ctl', 'mj-source', 'mj-audio-ctl', 'mj-talk-ctl',
		'mj-transport-ctl', 'mj-ear-ctl', 'mj-stats-ctl'];
	const SMALL = '(max-width: 575.98px), (max-height: 480px)';

	// The list: sections in order, and each row's name and one line. The
	// words are what the control does for whoever is looking, not how.
	const SECTIONS = [
		['Picture', [
			['mj-detail-ctl', 'Detail', 'Freeze what you are looking at, uncompressed, at full resolution'],
			['mj-area-ctl', 'Area', 'Draw a box to enlarge part of the picture'],
			['mj-peer-ctl', 'Another camera', 'Lay another camera’s view of this scene over it'],
			['mj-source', 'Source', 'Which of this camera’s sensors to show'],
			['mj-snap-row', 'Snapshot', 'Save a full-resolution still'],
		]],
		['Stream', [
			['mj-transport-ctl', 'Delivery', 'WebRTC is live and fits your connection; MSE runs a couple of seconds behind, steadily'],
			['mj-adapt-row', 'Bitrate notices', 'Say when the camera changes the stream’s bitrate'],
			['mj-stats-ctl', 'Stats', 'Live measurements of the connection'],
		]],
		['Sound', [
			['mj-audio-ctl', 'Sound', 'Hear the camera’s microphone'],
			['mj-talk-ctl', 'Talk', 'Speak through the camera’s speaker'],
		]],
		['Focus', [
			['mj-ear-ctl', 'By ear', 'Hear the focus while you turn the lens'],
		]],
	];

	// Which groups the sheet holds and whether ⋯ More is worth showing: the
	// sheet's groups that are present, and More only when one of them is not
	// hidden -- a camera without audio, talk or a peer has fewer, and a sheet
	// of nothing is a button that opens nothing.
	//
	// Snapshot joins them where a third icon stands beside it -- Fullscreen,
	// or Fill screen where there is none: three icons beside View and the
	// stream do not fit a 390 px phone.
	function plan(present, hidden, small, thirdIcon) {
		const moved = small ? SHEET.filter((id) => present.indexOf(id) >= 0) : [];
		const snap = !!(small && thirdIcon);
		const more = snap || moved.some((id) => !hidden[id]);
		return { moved: moved, more: more, snap: snap };
	}

	// The share page this page runs in, if any (its frame's parent).
	function share() {
		try {
			const p = window.parent;
			return p && p !== window && p.__share ? p.__share : null;
		} catch (e) { return null; }
	}

	const ICON_MORE = '<svg viewBox="0 0 20 20" width="20" height="20" fill="currentColor" aria-hidden="true">' +
		'<circle cx="4.5" cy="10" r="1.6"></circle><circle cx="10" cy="10" r="1.6"></circle>' +
		'<circle cx="15.5" cy="10" r="1.6"></circle></svg>';
	const ICON_FILL = '<svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" ' +
		'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
		'<path d="M7.5 3H3v4.5M12.5 3H17v4.5M7.5 17H3v-4.5M12.5 17H17v-4.5M6 10h8M10 6v8"></path></svg>';
	const ICON_CLOSE = '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" ' +
		'stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M5 5l10 10M15 5 5 15"></path></svg>';

	function el(tag, cls, text) {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text) e.textContent = text;
		return e;
	}

	function wire() {
		const stage = $('#mj-stage'), bar = $('#mj-bar');
		if (!stage || !bar || !window.matchMedia) return;
		const small = window.matchMedia(SMALL);
		const icons = bar.querySelector('.mj-ico-wrap');
		const fsBtn = document.getElementById('mj-fs');
		const snap = document.getElementById('mj-snap');

		// ---- Fill screen ---------------------------------------------------
		const fill = el('button', 'mj-hud-ico mj-fill-btn');
		fill.type = 'button';
		fill.hidden = true;
		fill.innerHTML = ICON_FILL;
		const setFill = (on) => {
			document.body.classList.toggle('mj-fill', on);
			fill.setAttribute('aria-pressed', String(on));
			const say = on ? 'Leave fill screen' : 'Fill the screen';
			fill.setAttribute('aria-label', say);
			fill.title = say;
			const s = share();
			if (s && typeof s.fill === 'function') { try { s.fill(on); } catch (e) { /* the share page's */ } }
			// The stage changed size: the picture and the chrome re-measure.
			window.dispatchEvent(new Event('resize'));
		};
		setFill(false);
		fill.addEventListener('click', (e) => { e.stopPropagation(); setFill(!document.body.classList.contains('mj-fill')); });
		document.addEventListener('keydown', (e) => {
			if (e.key === 'Escape' && document.body.classList.contains('mj-fill') && !sheet.open) setFill(false);
		});
		// Shown where real fullscreen is not: the two are one button's job.
		const fillWanted = () => !(fsBtn && !fsBtn.hidden && document.fullscreenEnabled);

		// ---- the list ------------------------------------------------------
		const sheet = document.createElement('dialog');
		sheet.className = 'mj-more-sheet';
		sheet.setAttribute('aria-label', 'More controls');
		const head = el('div', 'mj-more-head');
		const close = el('button', 'mj-hud-ico mj-more-close');
		close.type = 'button';
		close.setAttribute('aria-label', 'Close');
		close.innerHTML = ICON_CLOSE;
		head.append(el('span', 'mj-more-title', 'More'), close);
		const body = el('div', 'mj-more-body');
		sheet.append(head, body);
		// In the document, not the stage: the stage's own gestures -- pan,
		// pinch, drawing an Area, pressing a peer -- skip the bar's controls
		// by their place in .mj-bar, and a control moved under the stage
		// would be read as a touch on the picture. Out here none of them
		// sees it. A modal dialog is drawn on top whatever its parent.
		document.body.appendChild(sheet);

		// One row per entry: the words, and a slot the control is moved into.
		const rows = new Map(), slots = new Map(), sections = [];
		for (const [name, entries] of SECTIONS) {
			const sec = el('section', 'mj-more-sec');
			sec.append(el('h3', 'mj-more-cap', name));
			for (const [id, title, line] of entries) {
				const row = el('div', 'mj-more-row');
				const words = el('div', 'mj-more-words');
				words.append(el('span', 'mj-more-name', title), el('span', 'mj-more-line', line));
				const slot = el('div', 'mj-more-slot');
				row.append(words, slot);
				row.hidden = true;
				sec.append(row);
				rows.set(id, row);
				slots.set(id, slot);
			}
			body.append(sec);
			sections.push(sec);
		}

		// Bitrate notices: its own switch, the toast's × turned around.
		const A = window.MajesticAdapt;
		if (A && A.setEnabled) {
			const lbl = el('label', 'mj-more-switch');
			const box = el('input');
			box.type = 'checkbox';
			box.setAttribute('role', 'switch');
			box.setAttribute('aria-label', 'Bitrate notices');
			lbl.append(box, el('span', 'mj-more-knob'));
			box.addEventListener('change', () => A.setEnabled(box.checked));
			sheet.addEventListener('toggle', () => { box.checked = A.enabled(); });
			slots.get('mj-adapt-row').append(lbl);
			rows.get('mj-adapt-row').hidden = false;
			box.checked = A.enabled();
		}

		// Where each group stands in the bar, so it goes back to that place.
		const groups = SHEET.map((id) => document.getElementById(id)).filter(Boolean);
		const marks = new Map();
		for (const g of groups.concat(snap ? [snap] : [])) {
			const m = document.createComment(' ' + g.id + ' ');
			g.parentNode.insertBefore(m, g);
			marks.set(g, m);
		}
		const home = (g) => { const m = marks.get(g); m.parentNode.insertBefore(g, m.nextSibling); };

		const btn = el('button', 'mj-hud-ico mj-more-btn');
		btn.type = 'button';
		btn.hidden = true;
		btn.setAttribute('aria-label', 'More controls');
		btn.title = 'More controls';
		btn.setAttribute('aria-haspopup', 'dialog');
		btn.innerHTML = ICON_MORE;
		if (icons) icons.append(fill, btn); else bar.append(fill, btn);

		const apply = () => {
			fill.hidden = !(small.matches && fillWanted());
			if (fill.hidden && document.body.classList.contains('mj-fill')) setFill(false);
			const hidden = {};
			for (const g of groups) hidden[g.id] = g.hidden;
			const third = !!((fsBtn && !fsBtn.hidden) || !fill.hidden);
			const p = plan(groups.map((g) => g.id), hidden, small.matches, third);
			for (const g of groups) {
				const into = p.moved.indexOf(g.id) >= 0;
				if (into && g.parentNode !== slots.get(g.id)) slots.get(g.id).append(g);
				else if (!into && g.parentNode === slots.get(g.id)) home(g);
				rows.get(g.id).hidden = !into || g.hidden;
			}
			if (snap) {
				if (p.snap && snap.parentNode !== slots.get('mj-snap-row')) slots.get('mj-snap-row').append(snap);
				else if (!p.snap && snap.parentNode === slots.get('mj-snap-row')) home(snap);
				rows.get('mj-snap-row').hidden = !p.snap || snap.hidden;
			}
			// A section with no row left says nothing.
			for (const sec of sections) sec.hidden = ![...sec.querySelectorAll('.mj-more-row')].some((r) => !r.hidden);
			btn.hidden = !p.more;
			if (!p.more && sheet.open) sheet.close();
		};
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			if (sheet.open) { sheet.close(); return; }
			try { sheet.showModal(); } catch (err) { sheet.setAttribute('open', ''); }
			stage.classList.add('mj-show');
			sheet.dispatchEvent(new Event('toggle'));
		});
		close.addEventListener('click', () => sheet.close());
		// A tap on the backdrop -- the dialog itself, outside its body -- closes.
		sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); });

		apply();
		if (small.addEventListener) small.addEventListener('change', apply);
		else if (small.addListener) small.addListener(apply);
		// The groups and icons are unhidden as the player learns what the
		// camera has: the bar and the list follow.
		if (typeof MutationObserver === 'function') {
			const mo = new MutationObserver(apply);
			for (const g of groups.concat([fsBtn, snap]).filter(Boolean)) {
				mo.observe(g, { attributes: true, attributeFilter: ['hidden'] });
			}
		}
	}

	if (typeof document !== 'undefined' && document.getElementById) {
		if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
		else wire();
	}
	return { plan: plan, SHEET: SHEET, SECTIONS: SECTIONS };
})();
