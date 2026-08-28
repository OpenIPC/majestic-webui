(() => {
	'use strict';

	const bootEl = document.getElementById('mj-settings-boot');
	if (!bootEl) return;

	let boot;
	try {
		boot = JSON.parse(bootEl.textContent);
	} catch (e) {
		console.error('mj-settings: malformed boot data', e);
		return;
	}

	const EXCLUDE = new Set(boot.exclude || []);
	const SENSORS = boot.sensors || [];

	// Emoji + short label + display order for the x-live image knobs shown in the
	// "Live adjustments" panel beside the preview (keyed by the field's dot tail).
	const LIVE_META = {
		luminance:  { icon: '☀', label: 'Brightness' },
		contrast:   { icon: '🌗', label: 'Contrast' },
		saturation: { icon: '💧', label: 'Saturation' },
		hue:        { icon: '🌈', label: 'Hue' },
		mirror:     { icon: '⇄', label: 'Mirror' },
		flip:       { icon: '⇅', label: 'Flip' },
	};
	const LIVE_ORDER = ['luminance', 'contrast', 'saturation', 'hue', 'mirror', 'flip'];

	// Curated resolution presets (the de-facto set the firmware assumes), used
	// to build the resolution dropdown for the *.size fields. Options are
	// labelled "name · W×H · AR"; the backend's per-channel x-min/x-max/x-native
	// (when present) filter this to what the sensor/channel supports, and the
	// sub stream is additionally capped at the main stream's resolution.
	const RES_PRESETS = [
		[3840, 2160, '4K'], [2592, 1944, '5 MP'], [2560, 1440, '4 MP'],
		[2304, 1296, '3 MP'], [2048, 1536, '3 MP'], [1920, 1080, '1080p'],
		[1600, 1200, '2 MP'], [1280, 960, '1.3 MP'], [1280, 720, '720p'],
		[1024, 576, ''], [704, 576, 'D1'], [640, 480, 'VGA'],
		[640, 360, 'nHD'], [352, 288, 'CIF'],
	];
	const RES_CUSTOM = '__custom__';
	// Sizes an unset field falls back to, per the firmware's own defaulting, so
	// "no value" reads as a deliberate choice instead of an empty Custom box.
	const RES_AUTO_LABEL = {
		'video0.size': 'Auto · sensor native',
		'jpeg.size': 'Auto · follows the main stream',
	};
	// Aspect ratios are compared as numbers with a small tolerance, never as
	// reduced "W:H" strings: sensor natives are often near but not exactly 16:9
	// (imx335 4M is 2592x1520 = 1.705, 4.3 % off, reducing to "162:95"), and an
	// exact match then rejects every curated preset and empties the dropdown.
	// 4:3 sits 25 % away from 16:9, so the two buckets stay well separated.
	const AR_TOL = 0.06;
	function arNear(a, b) { return Math.abs(a - b) / b <= AR_TOL; }
	function gcdInt(a, b) { return b ? gcdInt(b, a % b) : a; }
	function resAR(w, h) { const g = gcdInt(w, h) || 1; return (w / g) + ':' + (h / g); }
	function resName(w, h) {
		const p = RES_PRESETS.find(r => r[0] === w && r[1] === h);
		if (p && p[2]) return p[2];
		const mp = w * h / 1e6;
		return (mp >= 10 ? mp.toFixed(0) : mp.toFixed(1)) + ' MP';
	}
	function resLabel(w, h) { return resName(w, h) + ' · ' + w + '×' + h + ' · ' + resAR(w, h); }
	function parseWH(s) {
		const m = /^\s*(\d+)\s*x\s*(\d+)\s*$/i.exec(String(s == null ? '' : s));
		return m ? { w: +m[1], h: +m[2] } : null;
	}

	// `sec` is the section being shown — the page renders exactly one at a time.
	// `q` is the live search term; it filters the tree rather than replacing it.
	const state = {
		sec: boot.tab,
		q: '',
		schema: null,
		config: null,
		fields: [],
		initial: {},
		fieldCache: {},
		// the mounted section's .mj-cols box, or null on the live/ROI leaves
		cols: null,
		dirtyN: 0,
		// a save whose changes need a pipeline reload leaves this set until the
		// reload actually runs, so Apply survives switching sections
		applyPending: false,
		toolbarMsg: '',
	};

	// synthetic leaves: the live-preview panel and the ROI canvas are not config
	// sections, but they are things you navigate to, so the tree carries them
	const LIVE_ID = 'live';
	const ROI_ID = 'roi';
	const ROI_DOT = 'motionDetect.roi';
	// matches the col-md-3 stacking point: below it the rail is full width and
	// the categories collapse to an accordion
	const WIDE = window.matchMedia('(min-width: 768px)');

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}

	async function init() {
		try {
			// both up front: the tree needs the schema to list sections, and the
			// search needs the config to know which visibleWhen rows are on the page
			state.schema = await fetchJson('/api/v1/config.schema.json');
			state.config = await fetchJson('/api/v1/config.json');
		} catch (e) {
			const form = document.getElementById('mj-settings-form');
			if (form) showFatal(form, 'Failed to load schema: ' + e.message);
			return;
		}
		buildNav();
		wireSearch();
		// the rail is a tree on >=md and an accordion below it; re-render rather
		// than try to keep both shapes live at once
		const onWidth = () => buildNav();
		if (WIDE.addEventListener) WIDE.addEventListener('change', onWidth);
		else if (WIDE.addListener) WIDE.addListener(onWidth);
		window.addEventListener('popstate', onPopState);
		// the column split depends on how tall each row renders, so it is worth
		// redoing when the width changes — but only then, never on a visibility
		// change (#189). Debounced: a drag fires resize continuously.
		let rt = 0;
		window.addEventListener('resize', () => {
			clearTimeout(rt);
			rt = setTimeout(layoutCols, 120);
		});
		await load(state.sec, /*push*/ false);
	}

	function label(key) {
		return (boot.labels && boot.labels[key]) ||
			(key ? key.charAt(0).toUpperCase() + key.slice(1) : key);
	}

	// Tabs are the schema's x-groups manifest (Image/Video/Events/...), each
	// merging several config sections. Only sections present in the live schema
	// (and groups with >=1 such section) are shown — unsupported features hide.
	function groups() {
		const xg = (state.schema && state.schema['x-groups']) || [];
		const props = (state.schema && state.schema.properties) || {};
		const out = [];
		for (const g of xg) {
			const secs = (g.sections || []).filter(s => props[s] && props[s].properties);
			if (secs.length) out.push({ id: g.id, label: g.label, sections: secs });
		}
		return out;
	}

	// Every leaf a section can render, flattened from the schema once and cached:
	// {key, dot, title, hint} for each field renderProps would draw, so the search
	// can match on the same words the page shows. Nested objects recurse and
	// x-live knobs are lifted out, exactly as renderProps does.
	function sectionFields(section) {
		if (state.fieldCache[section]) return state.fieldCache[section];
		const out = [];
		const walk = (basePath, props) => {
			for (const key of Object.keys(props)) {
				const dot = basePath + '.' + key;
				if (EXCLUDE.has(dot)) continue;
				const sub = props[key];
				if (!sub || sub['x-live']) continue;
				if (sub.type === 'object' && sub.properties) {
					walk(dot, sub.properties);
					continue;
				}
				if (!RENDERABLE.has(sub.type)) continue;
				out.push({ key, dot, sub, title: sub.title || sub.description || key, hint: sub.hint || '' });
			}
		};
		const props = ((state.schema.properties || {})[section] || {}).properties;
		if (props) walk(section, props);
		state.fieldCache[section] = out;
		return out;
	}

	// The types renderField actually draws — number/object fall through its
	// dispatch and return null, so they must not make a section look non-empty.
	const RENDERABLE = new Set(['boolean', 'integer', 'string', 'array']);

	// A field hidden by visibleWhen is not on the page, so a search must not
	// count it. Same rule the rendered page applies (visMatches) — and against
	// the same value: the mounted control when the controlling field is on
	// screen, including an edit that has not been saved yet, falling back to the
	// saved config and then the schema default for sections that are not
	// rendered. Reading only the config made the count disagree with the page
	// as soon as someone touched a controller.
	function fieldVisible(f) {
		const vw = f.sub && f.sub.visibleWhen;
		if (!vw || !vw.field) return true;
		const parent = f.dot.slice(0, f.dot.lastIndexOf('.'));
		const sibDot = parent + '.' + vw.field;
		const mounted = (state.fields || []).find(x => x.dot === sibDot);
		if (mounted) return visMatches(vw, mounted.getValue());
		let v = getDotted(state.config, sibDot);
		if (v === undefined) {
			const sib = sectionFields(f.dot.split('.')[0]).find(x => x.dot === sibDot);
			v = sib && sib.sub ? sib.sub.default : undefined;
		}
		return visMatches(vw, v);
	}

	// The navigable leaves of one group, in the order the tree lists them.
	function groupSections(g) {
		const out = [];
		if (groupHasLive(g)) out.push({ id: LIVE_ID, label: 'Live adjustments' });
		for (const s of g.sections) {
			if (!leafFields(s).length) continue;   // e.g. a section that is all x-live
			out.push({ id: s, label: label(s) });
		}
		if (groupHasMotion(g)) out.push({ id: ROI_ID, label: 'Visual editor' });
		return out;
	}

	function tree() {
		return groups().map(g => ({ id: g.id, label: g.label, group: g, sections: groupSections(g) }))
			.filter(t => t.sections.length);
	}

	function leaves() {
		return tree().reduce((acc, t) => acc.concat(t.sections.map(s => s.id)), []);
	}

	function groupOf(secId) {
		return tree().find(t => t.sections.some(s => s.id === secId));
	}

	// ?tab= carries a section id. A group id still resolves — old bookmarks from
	// when the tabs were categories land on that category's first section.
	function sectionForTab(tab) {
		const t = tree();
		if (!t.length) return null;
		if (tab) {
			if (leaves().includes(tab)) return tab;
			const g = t.find(x => x.id === tab);
			if (g) return g.sections[0].id;
		}
		return t[0].sections[0].id;
	}

	// The reporter's filtering rule (issue #163): a category whose own name
	// matches keeps ALL of its subsections; otherwise a subsection survives on
	// its own label or on any of its fields' names/descriptions. The field count
	// is what tells you why a section kept only by its field text is still listed.
	function filterTree() {
		const q = state.q.trim().toLowerCase();
		const t = tree();
		if (!q) return t.map(x => ({ ...x, sections: x.sections.map(s => ({ ...s, n: 0 })) }));
		const out = [];
		for (const x of t) {
			const gm = x.label.toLowerCase().includes(q);
			const secs = [];
			for (const s of x.sections) {
				const n = matchCount(s.id, q);
				if (gm || s.label.toLowerCase().includes(q) || n) secs.push({ ...s, n });
			}
			if (secs.length) out.push({ ...x, sections: secs });
		}
		return out;
	}

	// What a given leaf actually renders. The synthetic leaves have no schema
	// section of their own, and motionDetect.roi belongs to the Visual editor
	// rather than to Motion detection, so it is subtracted here exactly as
	// renderProps skips it.
	function leafFields(secId) {
		if (secId === LIVE_ID) return liveFields().map(f =>
			({ sub: f.sub, dot: f.dot, title: liveLabel(f.key, f.sub), hint: f.sub.hint || '' }));
		if (secId === ROI_ID) return roiFields();
		const fields = sectionFields(secId);
		return secId === 'motionDetect' ? fields.filter(f => f.dot !== ROI_DOT) : fields;
	}

	function matchCount(secId, q) {
		return leafFields(secId).filter(f => fieldVisible(f) &&
			((f.title || '').toLowerCase().includes(q) ||
				(f.hint || '').toLowerCase().includes(q) ||
				// four of ~170 fields ship no title; renderField falls back to the
				// key for display, so the search matches it too
				f.dot.split('.').pop().toLowerCase().includes(q))).length;
	}

	function buildNav() {
		const nav = document.getElementById('mj-settings-nav');
		if (!nav) return;
		const q = state.q.trim();
		const t = filterTree();
		nav.innerHTML = '';

		if (!t.length) {
			const li = el('li', 'nav-item mj-tree-empty');
			li.textContent = 'Nothing matches “' + q + '”.';
			nav.appendChild(li);
			return;
		}

		for (const g of t) {
			const li = el('li', 'nav-item mj-tree-group');
			li.dataset.group = g.id;
			// open on desktop (the whole tree stays visible), and on mobile only
			// while a search is narrowing it or this is the group you are in
			if (WIDE.matches || q) li.classList.add('mj-open');

			const cat = el('button', 'mj-tree-cat');
			cat.type = 'button';
			cat.innerHTML = '<span class="mj-tree-caret"></span>';
			cat.appendChild(hi(g.label));
			cat.setAttribute('aria-expanded', String(li.classList.contains('mj-open')));
			cat.addEventListener('click', () => toggleGroup(li));
			li.appendChild(cat);

			const sub = el('ul', 'nav flex-column mj-tree-sub');
			for (const s of g.sections) {
				const item = el('li', 'nav-item');
				const a = el('a', 'nav-link');
				a.href = 'mj-settings.cgi?tab=' + encodeURIComponent(s.id);
				a.appendChild(hi(s.label));
				if (s.n) {
					const n = el('span', 'mj-tree-n');
					n.textContent = String(s.n);
					n.title = s.n + (s.n === 1 ? ' matching setting' : ' matching settings');
					a.appendChild(n);
				}
				item.appendChild(a);
				sub.appendChild(item);
			}
			li.appendChild(sub);
			nav.appendChild(li);
		}
		wireNav();
		setActiveNav(state.sec);
	}

	// Mobile is a true accordion: opening one category closes the others, so the
	// rail never carries a section you are not looking at. On >=md the sub-lists
	// are forced open by CSS and the header is inert.
	function toggleGroup(li) {
		const open = li.classList.contains('mj-open');
		if (!open) {
			li.parentElement.querySelectorAll('.mj-tree-group.mj-open').forEach(o => {
				o.classList.remove('mj-open');
				const b = o.querySelector('.mj-tree-cat');
				if (b) b.setAttribute('aria-expanded', 'false');
			});
		}
		li.classList.toggle('mj-open', !open);
		const b = li.querySelector('.mj-tree-cat');
		if (b) b.setAttribute('aria-expanded', String(!open));
	}

	function wireNav() {
		document.querySelectorAll('#mj-settings-nav .nav-link').forEach(link => {
			link.addEventListener('click', ev => {
				const u = new URL(link.href);
				const newTab = u.searchParams.get('tab');
				if (!newTab) return;
				ev.preventDefault();
				if (newTab === state.sec) return;
				if (hasDirty() && !confirm('You have unsaved changes. Discard and switch sections?')) return;
				load(newTab, /*push*/ true);
			});
		});
	}

	function onPopState(ev) {
		const tabFromUrl = new URLSearchParams(location.search).get('tab');
		const sec = sectionForTab(tabFromUrl);
		if (sec === state.sec) return;
		load(tabFromUrl, /*push*/ false);
	}

	// Escape `text`, wrapping the run that matches the live query in <mark>.
	// Returns a fragment: slicing the raw string and escaping each piece keeps
	// the mark outside the escaped text instead of escaping markup we just added.
	function hi(text) {
		const t = String(text == null ? '' : text);
		const frag = document.createDocumentFragment();
		const q = state.q.trim().toLowerCase();
		const i = q ? t.toLowerCase().indexOf(q) : -1;
		if (i < 0) {
			frag.appendChild(document.createTextNode(t));
			return frag;
		}
		frag.appendChild(document.createTextNode(t.slice(0, i)));
		const m = document.createElement('mark');
		m.textContent = t.slice(i, i + q.length);
		frag.appendChild(m);
		frag.appendChild(document.createTextNode(t.slice(i + q.length)));
		return frag;
	}

	function wireSearch() {
		const wrap = document.getElementById('mj-search-wrap');
		const input = document.getElementById('mj-search');
		if (!wrap || !input) return;
		wrap.classList.remove('d-none');
		input.addEventListener('input', () => {
			state.q = input.value;
			buildNav();
			highlightPanel();
		});
	}

	// Re-mark the open section's labels and hints in place. Deliberately NOT a
	// re-render: rebuilding the form on every keystroke would reset every control
	// to its saved value and silently throw away unsaved edits.
	function highlightPanel() {
		document.querySelectorAll('#mj-settings-form [data-hl]').forEach(n => {
			n.textContent = '';
			n.appendChild(hi(n.dataset.hl));
		});
	}

	function groupHasMotion(group) {
		return !!(group && group.sections && group.sections.includes('motionDetect'));
	}

	// A group has a live preview when any of its fields are x-live (the
	// HiSilicon image CSC knobs) — so the user can see the effect while dragging.
	function groupHasLive(group) {
		if (!group) return false;
		// only the first such group owns the leaf: the tree keys on section id
		// and two "Live adjustments" entries would collide
		const owner = groups().find(g => groupLiveFields(g).length);
		return !!owner && owner.id === group.id;
	}

	function groupLiveFields(group) {
		const props = (state.schema && state.schema.properties) || {};
		const out = [];
		if (!group) return out;
		for (const section of group.sections) {
			const sp = (props[section] || {}).properties || {};
			for (const key of Object.keys(sp)) {
				if (!sp[key] || !sp[key]['x-live']) continue;
				if (EXCLUDE.has(section + '.' + key)) continue;
				out.push({ section, key, sub: sp[key], dot: section + '.' + key });
			}
		}
		out.sort((a, b) => {
			const ia = LIVE_ORDER.indexOf(a.key), ib = LIVE_ORDER.indexOf(b.key);
			return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
		});
		return out;
	}

	// the x-live knobs of whichever group owns the Live adjustments leaf
	function liveFields() {
		const owner = groups().find(g => groupLiveFields(g).length);
		return owner ? groupLiveFields(owner) : [];
	}

	function liveLabel(key, sub) {
		const meta = LIVE_META[key];
		return meta ? meta.label : (sub.title || sub.description || key);
	}

	// The Visual editor leaf owns motionDetect.roi: the region list belongs with
	// the canvas that draws it, and m/img.html reaches window.mjRoiAdd/mjRoiList,
	// which only exist while the field is mounted.
	function roiFields() {
		return sectionFields('motionDetect').filter(f => f.dot === ROI_DOT);
	}

	function stopLivePreview() {
		if (state.previewPlayer) {
			state.previewPlayer.destroy();
			state.previewPlayer = null;
		}
	}

	// Debounced live apply: on any x-live field change, POST the current value
	// of ALL x-live fields to /api/v1/image at once. Sending them together lets
	// the backend apply combined settings (e.g. mirror+flip need both). Sliders
	// send their number; booleans send 1/0.
	let liveTimer = null;
	function pushLive() {
		if (liveTimer) clearTimeout(liveTimer);
		liveTimer = setTimeout(() => {
			const parts = [];
			for (const f of state.fields) {
				if (!f.schema || !f.schema['x-live']) continue;
				const name = f.dot.split('.').pop();
				const val = f.type === 'boolean' ? (f.control.checked ? 1 : 0) : f.control.value;
				parts.push(encodeURIComponent(name) + '=' + encodeURIComponent(val));
			}
			if (parts.length)
				apiFetch('/api/v1/image?' + parts.join('&'),
					{ method: 'POST', credentials: 'same-origin' }).catch(() => {});
		}, 120);
	}

	async function load(tab, push) {
		const form = document.getElementById('mj-settings-form');
		if (!form) return;
		stopLivePreview();

		// schema/config must be loaded before we can resolve groups.
		try {
			if (!state.schema) state.schema = await fetchJson('/api/v1/config.schema.json');
			if (!state.config) state.config = await fetchJson('/api/v1/config.json');
		} catch (e) {
			showFatal(form, 'Failed to load schema or config: ' + e.message);
			return;
		}

		const sec = sectionForTab(tab);
		if (!sec) {
			showFatal(form, 'No settings groups in schema.');
			return;
		}
		state.sec = sec;

		setActiveNav(sec);
		if (push) {
			history.pushState({ tab: sec }, '', 'mj-settings.cgi?tab=' + encodeURIComponent(sec));
		}

		form.innerHTML = '';
		if (!form.dataset.bound) {
			form.addEventListener('submit', onSubmit);
			form.dataset.bound = '1';
		}

		const err = document.createElement('div');
		err.className = 'mj-error alert alert-danger d-none';
		err.role = 'alert';
		form.appendChild(err);

		state.fields = [];
		state.initial = {};
		state.cols = null;

		// Exactly one section on the page, so it gets the whole width — and its
		// fields are dealt into the two columns of .mj-cols, rather than run
		// down the left as a single strip of controls.
		if (sec === LIVE_ID) {
			renderLive(form);
		} else if (sec === ROI_ID) {
			renderRoi(form);
		} else {
			const card = el('div', 'card');
			const body = el('div', 'card-body');
			const h = el('h3');
			h.textContent = label(sec);
			body.appendChild(h);
			const cols = el('div', 'mj-cols');
			cols.appendChild(el('div', 'mj-col'));
			cols.appendChild(el('div', 'mj-col'));
			state.cols = cols;
			body.appendChild(cols);
			card.appendChild(body);
			form.appendChild(card);
			const props = ((state.schema.properties || {})[sec] || {}).properties || {};
			// all rows into the first column; layoutCols() deals the tail over
			// into the second once applyVisibility() has settled what is on screen
			renderProps(cols.firstElementChild, sec, props);
		}

		// Save and Apply share this bar, and each is present only while its own
		// action is available — so with nothing pending the bar is not there at
		// all. Built once and toggled by renderToolbar(); rebuilding it would
		// throw away the transient "Saving…"/"Applying…" labels mid-flight.
		const toolbar = document.createElement('div');
		toolbar.id = 'mj-toolbar';
		toolbar.className = 'mj-toolbar d-none align-items-center gap-2';
		toolbar.innerHTML =
			'<span class="me-auto small" id="mj-dirty-count"></span>' +
			'<button type="button" class="btn btn-warning d-none" id="mj-apply-btn">Apply now</button>' +
			'<button type="submit" class="btn btn-primary d-none" id="mj-save">Save Changes</button>';
		form.appendChild(toolbar);
		document.getElementById('mj-apply-btn').addEventListener('click', applyReload);

		applyVisibility();
		layoutCols();

		// renderField writes labels as plain text; with a query already active,
		// the section just mounted has to pick up the marks too, or navigating
		// to a hit highlights its hints and not its field names.
		highlightPanel();

		// Counts are read off the mounted controls, so swapping sections changes
		// what they are read from — including when the swap discarded unsaved
		// edits, which is exactly when the old numbers are wrong.
		if (state.q.trim()) buildNav();

		updateDirty();
	}

	function setActiveNav(tab) {
		document.querySelectorAll('#mj-settings-nav .nav-link').forEach(link => {
			const u = new URL(link.href);
			const t = u.searchParams.get('tab');
			const active = t === tab;
			link.classList.toggle('active', active);
			if (active) link.setAttribute('aria-current', 'page');
			else link.removeAttribute('aria-current');
		});
	}

	// The Visual editor leaf: the ROI canvas plus the region list it edits. The
	// list is rendered here rather than under Motion detection because
	// m/img.html calls back into window.mjRoiAdd/mjRoiList, which renderField
	// only installs while motionDetect.roi is mounted — and only one section is
	// mounted at a time now.
	function renderRoi(form) {
		const card = el('div', 'card');
		const body = el('div', 'card-body');
		body.innerHTML =
			'<h3>Visual editor</h3>' +
			'<div class="mj-roi-wrap"><iframe id="mj-roi-iframe" src="/m/img.html" frameborder="0" class="mj-roi-iframe"></iframe></div>';
		card.appendChild(body);
		form.appendChild(card);

		// canvas, then the list it writes into, then the control that empties it
		for (const f of roiFields()) {
			const field = renderField(body, f.dot, f.key, f.sub, getDotted(state.config, f.dot));
			if (field) {
				state.fields.push(field);
				state.initial[f.dot] = field.getValue();
			}
		}

		const clear = el('button', 'btn btn-outline-secondary');
		clear.type = 'button';
		clear.id = 'mj-roi-clear';
		clear.textContent = 'Clear all regions';
		body.appendChild(clear);

		const clearBtn = document.getElementById('mj-roi-clear');
		if (clearBtn) {
			clearBtn.addEventListener('click', () => {
				const roiField = state.fields.find(f => f.dot === ROI_DOT);
				if (roiField) {
					roiField.setValue('');
					updateDirty();
				}
			});
		}
	}

	function hasDirty() {
		return state.fields.some(f => f.getValue() !== state.initial[f.dot]);
	}

	function titleCase(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

	// The preview beside the live knobs, on the transport with the least lag.
	//
	// WebRTC, because this is the one page where latency is the feature: someone
	// is dragging a saturation slider and watching for the effect, and MSE is
	// about a second behind where WebRTC is not. The earlier reasoning for
	// keeping this page on MSE — that a WebRTC viewer joins the encoder's
	// bitrate loop and would disturb a judgement about image quality — does not
	// survive looking at what the page actually offers. Brightness, contrast,
	// saturation, hue, mirror and flip are ISP knobs; nothing here judges an
	// encoder setting, and whoever is tuning videoN.bitrate is on another tab
	// with no preview at all.
	//
	// The substream, by the same convention the Preview page follows: the main
	// channel is what an NVR or the SD card records, and this preview only has
	// to show what the ISP is doing — which looks the same on either channel,
	// because both are the same picture scaled. Main where no substream is
	// configured, because /ws/video subscribes to whatever number it is handed
	// and then quietly delivers nothing, which reads as "no signal" rather than
	// as a misconfiguration. state.config is loaded by the time this runs; the
	// knobs beside the preview are rendered from it.
	//
	// The fallback is a dozen lines rather than a call into shared code, because
	// what the Preview page does on a fallback — badge, MJPEG, keeping a toggle
	// in step — has nothing to do with this panel. The part that must not
	// diverge is which transport to prefer and what to remember, and that is
	// preview-transport.js.
	function attachLivePreview(video) {
		// This page's own remembered choice, defaulting to the substream. Not
		// the Preview page's: the two are looked at for different reasons and
		// can reasonably want different channels.
		const subAvailable = getDotted(state.config, 'video1.enabled') === true;
		const remembered = window.MajesticTransport.chosenStream('live');
		let stream = (remembered === null ? 1 : remembered) === 1 && subAvailable
			? 1 : 0;

		// Which attachment is the live one. MajesticWebRTC can report 'fallback'
		// from inside attach() — it does exactly that when RTCPeerConnection or
		// addTransceiver throws — so the handler below runs, installs MSE, and
		// then the outer assignment completes and buries it under the façade
		// that just failed. The picture would look right and the handle would be
		// wrong, which is worse: state.previewPlayer is what the tab teardown
		// destroys, so every visit would leave a live socket behind.
		let gen = 0;

		function attach(kind) {
			const mine = ++gen;

			// Whatever is running loses its handle here, so it has to be closed
			// here. In the synchronous case there is nothing yet to close.
			if (state.previewPlayer) {
				try { state.previewPlayer.destroy(); } catch (e) {}
				state.previewPlayer = null;
			}

			const impl = window.MajesticTransport.impl(kind);
			if (!impl) return;

			const p = impl.attach(video, {
				stream: stream,
				// Same list the Preview page builds, and for the same reason:
				// without it the browser offers host candidates only, and a
				// session opened from anywhere but the same LAN negotiates
				// cleanly and then never carries a packet.
				iceServers: () => window.MajesticTransport.iceServers(
					getDotted(state.config, 'webrtc.iceServers'),
					getDotted(state.config, 'webrtc.turnUsername'),
					getDotted(state.config, 'webrtc.turnCredential')),
				onState: (st) => {
					if (mine !== gen || kind !== 'webrtc') return;
					// 'fallback' is durable and worth remembering; 'busy' says
					// the camera is full, which it will not be for long.
					if (st === 'fallback' || st === 'busy') {
						if (st === 'fallback') window.MajesticTransport.demote();
						attach('mse');
					}
				},
			});

			// Superseded while attach() was still running: something else is
			// playing now, so drop what we just built rather than bury it.
			if (mine !== gen) {
				try { p.destroy(); } catch (e) {}
				return;
			}
			state.previewPlayer = p;
		}

		attach(window.MajesticTransport.preferred());

		// Sub is offered only where there is one; `stream` above has already
		// fallen back to Main if not, so the control shows what is playing.
		const s0 = document.getElementById('mj-live-s0');
		const s1 = document.getElementById('mj-live-s1');
		const subLbl = document.getElementById('mj-live-sub');
		if (subLbl && subAvailable) subLbl.hidden = false;
		if (s0) s0.checked = stream === 0;
		if (s1) s1.checked = stream === 1;
		[s0, s1].forEach(function (elm, n) {
			if (!elm) return;
			// On click rather than change, for the reason the Preview page
			// records it that way: pressing the one already selected fires no
			// change event and is still an answer worth remembering.
			elm.addEventListener('click', function () {
				window.MajesticTransport.chooseStream('live', n);
				if (n === stream) return;
				stream = n;
				if (state.previewPlayer) state.previewPlayer.setStream(n);
			});
		});
	}

	// The Live adjustments leaf: the preview and the x-live knobs side by side, so
	// dragging one shows its effect without scrolling. One "Reset all" rather than
	// a per-knob reset. The knobs register in state.fields, so the page Save and
	// dirty tracking cover them like any other field.
	function renderLive(form) {
		const row = el('div', 'row g-4');
		form.appendChild(row);

		const withVideo = !!window.MajesticVideo;
		if (withVideo) {
			const pv = el('div', 'col-12 col-lg-7');
			pv.id = 'mj-live-preview';
			// Its own Main/Sub control, because the remembered choice is
			// per page: without one here this panel could only ever be the
			// substream, and the case that makes the choice worth having —
			// video0 cropped and video1 not — is exactly the case where that
			// is the wrong picture.
			pv.innerHTML =
				'<div class="card"><div class="card-body">' +
				'<div class="d-flex align-items-center mb-1">' +
				'<div class="text-secondary small me-auto">Live preview</div>' +
				'<div class="btn-group btn-group-sm" role="group" aria-label="Stream">' +
				'<input type="radio" class="btn-check" name="mj-live-stream" id="mj-live-s0" autocomplete="off">' +
				'<label class="btn btn-outline-primary" for="mj-live-s0">Main</label>' +
				'<input type="radio" class="btn-check" name="mj-live-stream" id="mj-live-s1" autocomplete="off">' +
				'<label class="btn btn-outline-primary" for="mj-live-s1" id="mj-live-sub" hidden>Sub</label>' +
				'</div></div>' +
				'<video id="mj-live-video" autoplay muted playsinline class="mj-live-video"></video>' +
				'</div></div>';
			row.appendChild(pv);
			attachLivePreview(pv.querySelector('#mj-live-video'));
		}

		const col = el('div', withVideo ? 'col-12 col-lg-5' : 'col-12 col-lg-6');
		col.id = 'mj-live-panel';
		const card = el('div', 'card');
		const body = el('div', 'card-body');
		const head = el('div', 'd-flex align-items-center mb-2');
		head.innerHTML =
			'<h3 class="mb-0 me-auto">Live adjustments</h3>' +
			'<button type="button" class="btn btn-sm btn-link p-0 mj-live-reset" id="mj-live-reset">↺ Reset all</button>';
		body.appendChild(head);

		const dots = [];
		for (const f of liveFields()) {
			const eff = getDotted(state.config, f.dot);
			const field = renderField(body, f.dot, f.key, f.sub, eff, { live: true });
			if (field) {
				state.fields.push(field);
				state.initial[f.dot] = field.getValue();
				dots.push(f.dot);
			}
		}

		card.appendChild(body);
		col.appendChild(card);
		row.appendChild(col);

		const rb = document.getElementById('mj-live-reset');
		if (rb) rb.addEventListener('click', () => onResetLive(dots, rb));
	}

	async function onResetLive(dots, btn) {
		if (!dots.length) return;
		if (!confirm('Reset all live image adjustments to their defaults?')) return;
		btn.disabled = true;
		const orig = btn.textContent;
		btn.textContent = '…';
		clearError();
		try {
			const q = dots.map(d => 'key=' + encodeURIComponent(d)).join('&');
			const res = await apiFetch('/api/v1/reset?' + q, { credentials: 'same-origin' });
			if (!res.ok) {
				const txt = await safeText(res);
				showError('Reset failed (HTTP ' + res.status + '). ' + txt);
				return;
			}
			await refresh();
		} catch (e) {
			showError('Reset failed: ' + e.message);
		} finally {
			btn.textContent = orig;
			btn.disabled = false;
		}
	}

	function renderProps(container, basePath, props) {
		for (const key of Object.keys(props)) {
			const dot = basePath + '.' + key;
			if (EXCLUDE.has(dot)) continue;
			if (dot === ROI_DOT) continue;        // renders on the Visual editor leaf
			const sub = props[key];
			if (sub && sub['x-live']) continue;   // live knobs render on their own leaf
			if (sub && sub.type === 'object' && sub.properties) {
				const h = el('h5', 'mt-4 mb-2 text-secondary');
				h.textContent = sub.title || titleCase(key);
				container.appendChild(h);
				renderProps(container, dot, sub.properties);
				continue;
			}
			const eff = getDotted(state.config, dot);
			const field = renderField(container, dot, key, sub, eff);
			if (field) {
				state.fields.push(field);
				state.initial[dot] = field.getValue();
			}
		}
	}

	// Evaluate a visibleWhen condition against the controlling field's value.
	// Supports equals (v === value), notEquals (v !== value) and in (v is one
	// of a list). An unrecognised operator returns true — a field is shown
	// rather than stranded invisible when a newer schema uses a condition this
	// build does not know yet.
	function visMatches(vw, v) {
		v = String(v);
		if ('equals' in vw) return v === String(vw.equals);
		if ('notEquals' in vw) return v !== String(vw.notEquals);
		if (Array.isArray(vw.in)) return vw.in.map(String).includes(v);
		return true;
	}

	function applyVisibility() {
		state.visUpdaters = [];
		const controllers = new Set();
		const byDot = {};
		for (const f of state.fields) byDot[f.dot] = f;
		for (const f of state.fields) {
			const vw = f.schema && f.schema.visibleWhen;
			if (!vw || !vw.field) continue;
			const parent = f.dot.slice(0, f.dot.lastIndexOf('.'));
			const ctrl = byDot[parent + '.' + vw.field];
			if (!ctrl) continue;
			const update = () => { f.p.style.display = visMatches(vw, ctrl.getValue()) ? '' : 'none'; };
			ctrl.control.addEventListener('change', update);
			ctrl.control.addEventListener('input', update);
			state.visUpdaters.push(update);
			update();
			// flipping a controller changes which rows exist, so a live search
			// has to recount. Once per controller, not once per dependent field.
			if (!controllers.has(ctrl)) {
				controllers.add(ctrl);
				const recount = () => { if (state.q.trim()) buildNav(); };
				ctrl.control.addEventListener('change', recount);
				ctrl.control.addEventListener('input', recount);
			}
		}
	}

	function runVisibility() {
		(state.visUpdaters || []).forEach(u => u());
	}

	// Deal the section's rows into the two columns of .mj-cols.
	//
	// The rows used to flow through a CSS multi-column box, which re-balances
	// itself every time a visibleWhen row is shown or hidden: flipping one
	// select pushed unrelated rows across the fold, and at some widths pushed
	// the very select being edited across it (#189). So the split is decided
	// here instead — at mount and on resize, never while a row toggles. Showing
	// or hiding a row then only moves what is under it in its own column, which
	// is what makes the form predictable to edit.
	function layoutCols() {
		const box = state.cols;
		// below md the columns stack, and every split reads the same stacked
		if (!box || !WIDE.matches) return;
		const a = box.children[0], b = box.children[1];
		if (!a || !b) return;
		// document order, wherever the last deal left them
		const items = Array.from(a.children).concat(Array.from(b.children));
		if (!items.length) return;

		// Both columns are flex: 1 1 0, so each row already measures at the
		// width it keeps on either side of the fold — nothing has to be moved
		// to size it first.
		const rows = rowBoxes(items);
		if (!rows.length) return;

		// Where each row would sit if they all ran down one column, so that a
		// candidate's two column heights can be read off as differences. Facing
		// margins between two rows in the same column collapse to the larger of
		// the pair; the top margin of the first row and the bottom margin of the
		// last are kept whole, because a flex item is its own block formatting
		// context and cannot collapse them away.
		const y = [];
		let run = rows[0].mt;
		rows.forEach((r, i) => {
			y.push(run);
			run += r.h + (i + 1 < rows.length ? Math.max(r.mb, rows[i + 1].mt) : r.mb);
		});
		const total = run;

		// visible rows lying to the left of each possible cut
		const seen = [0];
		items.forEach(it => seen.push(seen[seen.length - 1] + (it.offsetHeight ? 1 : 0)));

		// The cut that leaves the taller column as short as it can be. Both
		// heights come from the rows' own boxes rather than from where the last
		// deal put them, so a given width always picks the same cut however the
		// rows are arranged when this runs.
		let best = Infinity, cut = items.length;
		for (let i = 1; i <= items.length; i++) {
			// a group heading belongs to the rows under it, so it must not be
			// left as the last thing in a column
			if (i < items.length && items[i - 1].tagName === 'H5') continue;
			const n = seen[i];
			const left = n ? y[n - 1] + rows[n - 1].h + rows[n - 1].mb : 0;
			const right = n < rows.length ? rows[n].mt + total - y[n] : 0;
			const taller = Math.max(left, right);
			if (taller < best) { best = taller; cut = i; }
		}
		if (cut === a.children.length) return;   // already dealt this way

		// re-parenting blurs whatever control the user is in, which resizing
		// the window mid-edit would otherwise do
		const held = grabFocus(box);
		items.forEach((it, i) => (i < cut ? a : b).appendChild(it));
		restoreFocus(held);
	}

	// The visible rows with the box each one occupies. A row costs its column
	// more than offsetHeight — a column of short switch rows is mostly the
	// margins between them — so the margins are read too. Hidden rows are left
	// out entirely: they take up no space, and dropping them here is what keeps
	// them free on whichever side of the fold they fall.
	function rowBoxes(items) {
		return items.filter(it => it.offsetHeight).map(it => {
			const cs = getComputedStyle(it);
			return {
				h: it.offsetHeight,
				mt: parseFloat(cs.marginTop) || 0,
				mb: parseFloat(cs.marginBottom) || 0,
			};
		});
	}

	// Moving a node re-parents it, so anything focused inside has to be picked
	// up and put back — text selection included, or a caret mid-word jumps to
	// the end of the field.
	function grabFocus(box) {
		const node = document.activeElement;
		if (!node || !box.contains(node)) return null;
		let sel = null;
		// number and range inputs throw on .selectionStart rather than answer null
		try { sel = [node.selectionStart, node.selectionEnd]; } catch (e) { /* no selection */ }
		return { node, sel };
	}

	function restoreFocus(held) {
		if (!held) return;
		held.node.focus();
		if (!held.sel || held.sel[0] == null) return;
		try { held.node.setSelectionRange(held.sel[0], held.sel[1]); } catch (e) { /* no selection */ }
	}

	function renderField(container, dot, key, sub, eff, opts) {
		opts = opts || {};
		const live = !!opts.live;
		// the field's `title` is the short label; older schemas only had `description`
		const desc = sub.title || sub.description || key;
		const meta = LIVE_META[key];
		// live knobs show an emoji + short label; everything else uses the title
		// data-hl carries the raw text so highlightPanel() can re-mark the label
		// in place when the search term changes, without re-rendering the control
		// (which would throw away unsaved edits)
		const hlSpan = (t) => '<span data-hl="' + esc(t) + '">' + esc(t) + '</span>';
		const labelHtml = (live && meta)
			? '<span class="mj-live-ico">' + meta.icon + '</span> ' + hlSpan(meta.label)
			: hlSpan(desc);
		const liveCls = live ? ' mj-live-row' : '';
		const type = sub.type;
		const id = 'mjf-' + dot.replace(/\./g, '-');
		const hasDefault = Object.prototype.hasOwnProperty.call(sub, 'default');
		const isSensorPath = dot === 'isp.sensorConfig' && SENSORS.length > 0;
		const enumVals = Array.isArray(sub.enum) ? sub.enum : null;
		// resolution picker for the video/jpeg size fields: a dropdown of named
		// presets + a "Custom…" escape hatch. Selected by the backend's
		// x-resolution flag, or by an explicit path allow-list so it still works
		// against older firmware (NOT a /\.size$/ match — that caught osd.size,
		// which is a font scale, not a resolution).
		const isResolution = type === 'string' &&
			(sub['x-resolution'] ||
				dot === 'video0.size' || dot === 'video1.size' || dot === 'jpeg.size');

		let p, control;

		if (type === 'boolean') {
			p = el('p', 'boolean mj-row' + liveCls);
			p.innerHTML =
				'<span class="form-check form-switch">' +
				'<input type="checkbox" id="' + id + '" class="form-check-input">' +
				'<label for="' + id + '" class="form-check-label">' + labelHtml + '</label>' +
				'</span>';
			control = p.querySelector('input');
			control.checked = toBool(eff);
		} else if (type === 'integer' && isNum(sub.maximum) && sub.maximum <= 100) {
			p = el('p', 'range mj-row' + liveCls);
			const min = isNum(sub.minimum) ? sub.minimum : 0;
			const max = sub.maximum;
			const v = isNumish(eff) ? String(eff) : '';
			p.innerHTML =
				'<label for="' + id + '" class="form-label">' + labelHtml + '</label>' +
				'<span class="input-group">' +
				'<input type="range" id="' + id + '" class="form-control form-range" min="' + min + '" max="' + max + '" step="1" value="' + esc(v) + '">' +
				'<span class="input-group-text show-value">' + esc(v) + '</span>' +
				'</span>';
			control = p.querySelector('input');
			const show = p.querySelector('.show-value');
			control.addEventListener('input', () => { show.textContent = control.value; });
		} else if (type === 'integer') {
			p = el('p', 'number mj-row');
			const minA = isNum(sub.minimum) ? ' min="' + sub.minimum + '"' : '';
			const maxA = isNum(sub.maximum) ? ' max="' + sub.maximum + '"' : '';
			const v = isNumish(eff) ? String(eff) : '';
			p.innerHTML =
				'<label for="' + id + '" class="form-label">' + labelHtml + '</label>' +
				'<span class="input-group">' +
				'<input type="number" id="' + id + '" class="form-control text-end"' + minA + maxA + ' step="1" value="' + esc(v) + '">' +
				'</span>';
			control = p.querySelector('input');
		} else if (isResolution) {
			p = el('p', 'select mj-row mj-wide');
			const cur = eff !== undefined && eff !== null ? String(eff) : '';
			const max = parseWH(sub['x-max']);
			const min = parseWH(sub['x-min']);
			const native = parseWH(sub['x-native']);
			const arRef = native;                 // AR comes only from the real sensor native
			const nativeKey = native ? native.w + 'x' + native.h : '';
			// curated list filtered by the published caps (+ an optional extra
			// cap, used to keep the sub stream <= the live main resolution)
			const buildList = (extraMax) => {
				let list = RES_PRESETS.map(r => ({ w: r[0], h: r[1] }));
				if (max) list = list.filter(o => o.w <= max.w && o.h <= max.h);
				if (min) list = list.filter(o => o.w >= min.w && o.h >= min.h);
				// the sub stream has no x-native, so it inherits the main stream's
				// aspect ratio; jpeg (no native, no main) is left unfiltered by AR.
				// A sensor whose AR matches nothing at all keeps the whole list —
				// an advisory filter must never leave the user with no choice.
				const arSrc = arRef || extraMax;
				if (arSrc) {
					const target = arSrc.w / arSrc.h;
					const near = list.filter(o => arNear(o.w / o.h, target));
					if (near.length) list = near;
				}
				if (extraMax) list = list.filter(o => o.w <= extraMax.w && o.h <= extraMax.h);
				// the sensor native stays selectable even once it is no longer the
				// current value, so a stream can always be put back to full frame
				if (native && !list.some(o => o.w === native.w && o.h === native.h))
					list.push({ w: native.w, h: native.h });
				const c = parseWH(cur);   // always keep the current value selectable
				if (c && !list.some(o => o.w === c.w && o.h === c.h)) list.push(c);
				list.sort((a, b) => b.w * b.h - a.w * a.h);
				return list;
			};
			// An empty value means "let the firmware decide" for the fields that
			// document a fallback; elsewhere it is only offered when the field is
			// already unset, so the UI can show that state without inventing it.
			const autoLabel = RES_AUTO_LABEL[dot] || (cur ? '' : 'Auto · unset');
			const optsHtml = (list, selVal) => (autoLabel
				? '<option value=""' + (selVal === '' ? ' selected' : '') + '>' + esc(autoLabel) + '</option>'
				: '') + list.map(o => {
				const val = o.w + 'x' + o.h;
				const lbl = resLabel(o.w, o.h) + (val === nativeKey ? ' · Native' : '');
				return '<option value="' + esc(val) + '"' + (val === selVal ? ' selected' : '') + '>' + esc(lbl) + '</option>';
			}).join('') + '<option value="' + RES_CUSTOM + '">Custom…</option>';
			p.innerHTML =
				'<label for="' + id + '" class="form-label">' + labelHtml + '</label>' +
				'<select class="form-select" id="' + id + '">' + optsHtml(buildList(), cur) + '</select>' +
				'<input type="text" class="form-control mt-1 mj-res-custom" placeholder="custom, e.g. 1920x1080" value="' + esc(cur) + '" style="display:none">';
			control = p.querySelector('select');
			const txt = p.querySelector('.mj-res-custom');
			const inList = (v) => Array.from(control.options).some(o => o.value === v && o.value !== RES_CUSTOM);
			// the value an empty field selects: the Auto entry where one exists,
			// Custom (with an empty box) otherwise
			const emptyVal = () => autoLabel ? '' : RES_CUSTOM;
			const syncDisplay = () => {
				txt.style.display = control.value === RES_CUSTOM ? '' : 'none';
			};
			// focus belongs to syncCustom, which only ever runs from the select's
			// change event. Focusing from _set() would drag the viewport to
			// whichever custom box was refreshed last after every save (#127).
			const syncCustom = () => {
				syncDisplay();
				if (control.value === RES_CUSTOM) txt.focus();
			};
			// an off-list current value starts in Custom mode; an unset one
			// round-trips as "" and stays clean either way
			if (!cur) { control.value = emptyVal(); }
			else if (!inList(cur)) { control.value = RES_CUSTOM; }
			syncDisplay();
			control.addEventListener('change', syncCustom);
			txt.addEventListener('input', updateDirty);
			txt.addEventListener('change', updateDirty);
			// text box wins when Custom is active; otherwise the select value
			control._get = () => control.value === RES_CUSTOM ? String(txt.value).trim() : control.value;
			control._set = (v) => {
				const s = v == null ? '' : String(v);
				txt.value = s;
				control.value = s ? (inList(s) ? s : RES_CUSTOM) : emptyVal();
				syncDisplay();
			};
			// the sub stream is downscaled from the main, so it can't exceed it:
			// re-prune its options whenever the main resolution changes.
			if (dot === 'video1.size') {
				const rebuild = () => {
					const mainF = (state.fields || []).find(f => f.dot === 'video0.size');
					const mainWH = parseWH(mainF ? mainF.getValue() : (state.config.video0 || {}).size);
					const keep = control._get();
					control.innerHTML = optsHtml(buildList(mainWH), keep);
					control._set(keep);
				};
				p._rebuildRes = rebuild;
				rebuild();
			}
			if (dot === 'video0.size') {
				control.addEventListener('change', () => {
					const subF = (state.fields || []).find(f => f.dot === 'video1.size');
					if (subF && subF.p._rebuildRes) subF.p._rebuildRes();
				});
			}
		} else if (type === 'string' && enumVals && enumVals.length) {
			p = el('p', 'select mj-row');
			// short enums get a moderate width cap; long-option enums stay full-width
			if (enumVals.some(o => String(o).length > 14)) p.classList.add('mj-wide');
			// A select can only show a value it has an option for. majestic narrows
			// some enums to what that consumer can actually carry (outgoing.audioCodec
			// drops opus, which FLV cannot frame), but a hand-written majestic.yaml
			// can still pin one — and the daemon honours it deliberately. Without a
			// place to hold it the browser falls back to the first option and the page
			// reports a codec that is not the one in effect, so carry the live value
			// as an explicitly-unsupported entry instead.
			const cur = eff === undefined || eff === null ? '' : String(eff);
			const unlisted = cur !== '' && !enumVals.some(o => String(o) === cur);
			const opts =
				(unlisted ? option(cur, true, cur + ' (unsupported)') : '') +
				enumVals.map(o => option(o, !unlisted && cur === String(o))).join('');
			p.innerHTML =
				'<label for="' + id + '" class="form-label">' + labelHtml + '</label>' +
				'<select class="form-select" id="' + id + '">' + opts + '</select>';
			control = p.querySelector('select');
		} else if (type === 'string' && isSensorPath) {
			p = el('p', 'select mj-row mj-wide');
			const opts = option('', !eff) + SENSORS.map(s => option(s, String(eff) === s)).join('');
			p.innerHTML =
				'<label for="' + id + '" class="form-label">' + labelHtml + '</label>' +
				'<select class="form-select" id="' + id + '">' + opts + '</select>';
			control = p.querySelector('select');
		} else if (type === 'string') {
			p = el('p', 'string mj-row');
			const v = eff !== undefined && eff !== null ? String(eff) : '';
			p.innerHTML =
				'<label for="' + id + '" class="form-label">' + labelHtml + '</label>' +
				'<input type="text" id="' + id + '" class="form-control" value="' + esc(v) + '">';
			control = p.querySelector('input');
		} else if (type === 'array') {
			// MultiRect fields (motionDetect.roi, crop, privacyMasks) are a list of
			// "AxBxCxD" regions: render one editable row per region, not a single
			// comma-joined string. The Visual editor (m/img.html) adds/reads rows
			// through the window.mjRoi* hooks exposed below.
			p = el('p', 'array mj-row');
			p.innerHTML =
				'<label class="form-label">' + labelHtml + '</label>' +
				'<div class="mj-array" id="' + id + '"></div>' +
				'<button type="button" class="btn btn-sm btn-outline-secondary mt-1 mj-array-add">+ Add region</button>';
			control = p.querySelector('.mj-array');
			// Re-render the Visual editor's canvas whenever the list changes
			// (add/delete/edit/reset), so drawn rectangles track the rows.
			const syncEditor = () => {
				if (dot !== 'motionDetect.roi') return;
				const ifr = document.getElementById('mj-roi-iframe');
				if (ifr && ifr.contentWindow && ifr.contentWindow.mjRoiRedraw)
					ifr.contentWindow.mjRoiRedraw();
			};
			const onChange = () => { updateDirty(); syncEditor(); };
			control._sync = syncEditor;
			const addRow = (val) => {
				const row = el('div', 'input-group input-group-sm mb-1 mj-array-row');
				const inp = el('input', 'form-control');
				inp.type = 'text';
				inp.placeholder = 'XxYxWxH';
				inp.value = val || '';
				inp.addEventListener('input', onChange);
				inp.addEventListener('change', onChange);
				const del = el('button', 'btn btn-outline-danger mj-array-del');
				del.type = 'button';
				del.textContent = '×';
				del.addEventListener('click', () => { row.remove(); onChange(); });
				row.appendChild(inp);
				row.appendChild(del);
				control.appendChild(row);
				return inp;
			};
			control._addRow = addRow;
			control._rows = () => Array.from(control.querySelectorAll('.mj-array-row input'))
				.map(i => i.value.trim()).filter(s => s.length);
			(Array.isArray(eff) ? eff : (eff ? String(eff).split(/\s*,\s*/) : []))
				.forEach(x => { if (x) addRow(x); });
			p.querySelector('.mj-array-add').addEventListener('click', () => { addRow(''); onChange(); });
			if (dot === 'motionDetect.roi') {
				window.mjRoiAdd = (dim) => { if (dim) { addRow(dim); onChange(); } };
				window.mjRoiList = () => control._rows();
			}
		} else {
			return null;
		}

		// live knobs share one "Reset all" in the panel header — no per-knob reset
		if (!live) {
			const reset = document.createElement('button');
			reset.type = 'button';
			reset.className = 'btn btn-sm btn-link p-0 mj-reset';
			reset.textContent = '↺';
			reset.setAttribute('aria-label', 'Reset ' + desc + ' to default');
			if (!hasDefault) {
				reset.disabled = true;
				reset.title = 'Server has no recorded default for this key.';
			} else {
				reset.title = 'Reset to default: ' + String(sub.default);
				reset.addEventListener('click', () => onReset(dot, reset));
			}
			// Put the glyph on the control's own line instead of below it. The
			// live rows are left alone: .mj-live-row.range > .input-group is a
			// direct-child selector that this wrapper would break.
			const ctl = el('span', 'mj-ctl');
			const inner = el('span', 'mj-ctl-in');
			const kids = Array.from(p.children);
			const first = kids[0] && kids[0].tagName === 'LABEL' ? 1 : 0;
			kids.slice(first).forEach(n => inner.appendChild(n));
			ctl.appendChild(inner);
			ctl.appendChild(reset);
			p.appendChild(ctl);
		}

		// detailed help under the control (skipped on the compact live-panel rows):
		// the authored `hint` plus auto-context (value range for bounded integers).
		if (!live) {
			const hintParts = [];
			if (sub.hint) hintParts.push('<span data-hl="' + esc(sub.hint) + '"></span>');
			// only plain number inputs gain a range hint; sliders (max ≤ 100)
			// already show their bounds via the track and the live value box
			const isSlider = type === 'integer' && isNum(sub.maximum) && sub.maximum <= 100;
			if (type === 'integer' && !isSlider && isNum(sub.minimum) && isNum(sub.maximum))
				hintParts.push(esc(sub.minimum + '–' + sub.maximum));
			if (hintParts.length) {
				// block-level so it sits on its own line below the control row
				const hint = el('div', 'hint text-secondary');
				hint.innerHTML = hintParts.join(' · ');
				const authored = hint.querySelector('[data-hl]');
				if (authored) authored.appendChild(hi(sub.hint));
				p.appendChild(hint);
			}
		}

		container.appendChild(p);

		control.addEventListener('input', updateDirty);
		control.addEventListener('change', updateDirty);

		// Live-tunable fields (schema "x-live", e.g. HiSilicon image knobs):
		// apply to the SDK on change via POST /api/v1/image — instant, no
		// save/reinit. The value still persists only on the page's Save.
		if (sub && sub['x-live']) {
			control.addEventListener('input', pushLive);
			control.addEventListener('change', pushLive);
		}

		// array fields canonicalise to a comma-joined string so dirty-tracking
		// (a plain !== against state.initial) keeps working; onSubmit splits it
		// back into a list before POSTing.
		const getValue = control._get
			? control._get
			: type === 'boolean'
			? () => control.checked ? 'true' : 'false'
			: type === 'array'
			? () => control._rows().join(', ')
			: () => String(control.value);

		const setValue = control._set ? control._set : (v) => {
			if (type === 'boolean') {
				control.checked = toBool(v);
			} else if (type === 'array') {
				control.querySelectorAll('.mj-array-row').forEach(r => r.remove());
				const arr = Array.isArray(v) ? v : (v ? String(v).split(/\s*,\s*/) : []);
				arr.forEach(x => { if (x) control._addRow(x); });
				if (control._sync) control._sync();
			} else {
				control.value = v !== undefined && v !== null ? String(v) : '';
				const show = p.querySelector('.show-value');
				if (show) show.textContent = control.value;
			}
		};

		return { dot, key, schema: sub, type, control, p, getValue, setValue };
	}

	function updateDirty() {
		let n = 0;
		for (const f of state.fields) {
			const d = f.getValue() !== state.initial[f.dot];
			f.p.classList.toggle('mj-dirty', d);
			if (d) n++;
		}
		state.dirtyN = n;
		renderToolbar();
	}

	// One visibility rule for both buttons: show each only while its action can
	// actually be taken. A save that needs a pipeline reload leaves applyPending
	// set, so Save stands down and Apply takes its place until the reload runs.
	function renderToolbar() {
		const bar = document.getElementById('mj-toolbar');
		if (!bar) return;
		const n = state.dirtyN || 0;
		const apply = !!state.applyPending;
		bar.classList.toggle('d-flex', !!(n || apply));
		bar.classList.toggle('d-none', !(n || apply));

		const lbl = document.getElementById('mj-dirty-count');
		if (lbl && !state.toolbarMsg) {
			// mj-apply-note rather than Bootstrap's text-warning: that utility is
			// not in the PurgeCSS subset we ship (tools/purgecss.config.cjs)
			lbl.className = 'me-auto small ' + (apply && !n ? 'mj-apply-note' : 'text-secondary');
			// nothing pending: leave the hidden bar empty rather than parked on a
			// stale message
			lbl.textContent = n
				? (n + ' change' + (n === 1 ? '' : 's') + ' pending.' +
					(apply ? ' A pipeline reload is still due.' : ''))
				: (apply
					? 'Saved. Resolution, codec and frame-rate changes take effect after a pipeline reload (the video streams will blink briefly).'
					: '');
		}
		const save = document.getElementById('mj-save');
		if (save) save.classList.toggle('d-none', n === 0);
		// Apply reloads the pipeline and the page with it, which would throw
		// away unsaved edits — and two buttons at once is a fourth state the
		// three-state model does not have. Save first; Apply comes back after.
		const applyBtn = document.getElementById('mj-apply-btn');
		if (applyBtn) applyBtn.classList.toggle('d-none', !(apply && n === 0));
	}

	// A message that outranks the computed status until it is cleared (the
	// reload-took-too-long case, which has nowhere else to go now the banner
	// is gone).
	function setToolbarMsg(text, cls) {
		state.toolbarMsg = text || '';
		const lbl = document.getElementById('mj-dirty-count');
		if (!lbl) return;
		if (!text) { renderToolbar(); return; }
		lbl.className = 'me-auto small ' + (cls || 'text-danger');
		lbl.textContent = text;
	}

	async function onSubmit(ev) {
		ev.preventDefault();
		const dirty = state.fields.filter(f => f.getValue() !== state.initial[f.dot]);
		if (!dirty.length) return;

		const body = {};
		for (const f of dirty) {
			let val = f.getValue();
			// array-typed schema fields (MultiRect: roi/crop/privacyMasks) post as a
			// list of strings, not a comma-joined scalar.
			if (f.schema && f.schema.type === 'array')
				val = String(val).split(',').map(s => s.trim()).filter(s => s.length);
			setDotted(body, f.dot, val);
		}

		const btn = document.getElementById('mj-save');
		btn.disabled = true;
		btn.textContent = 'Saving…';
		setToolbarMsg('');
		clearError();
		try {
			const res = await apiFetch('/api/v1/config', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				const txt = await safeText(res);
				showError('Save failed (HTTP ' + res.status + '). ' + txt);
				return;
			}
			await refresh();
			// Image knobs (x-live) apply instantly; everything structural
			// (resolution, codec, fps, ...) only takes effect after majestic
			// reloads its pipeline. Offer that as an explicit step, in the same
			// bar the Save was just pressed in.
			if (dirty.some(f => !(f.schema && f.schema['x-live'])))
				state.applyPending = true;
		} catch (e) {
			showError('Save failed: ' + e.message);
		} finally {
			btn.disabled = false;
			btn.textContent = 'Save Changes';
			updateDirty();
		}
	}

	// majestic is the HTTP server, so we don't restart the process — we SIGHUP
	// it (via j/mj-apply.cgi) for an in-process reload that rebuilds the encoder
	// pipeline while the web server stays up, then poll until it answers again.
	async function pollUp(maxMs) {
		const deadline = Date.now() + maxMs;
		while (Date.now() < deadline) {
			try {
				const ctl = new AbortController();
				const t = setTimeout(() => ctl.abort(), 3000);
				const r = await apiFetch('/api/v1/config.json',
					{ cache: 'no-store', credentials: 'same-origin', signal: ctl.signal });
				clearTimeout(t);
				if (r.ok) return true;
			} catch (e) { /* loop is busy reloading / connection blipped */ }
			await new Promise(res => setTimeout(res, 1000));
		}
		return false;
	}

	async function applyReload() {
		const btn = document.getElementById('mj-apply-btn');
		if (btn) { btn.disabled = true; btn.textContent = 'Applying…'; }
		setToolbarMsg('');
		stopLivePreview();   // the stream drops while the pipeline rebuilds
		try {
			await apiFetch('j/mj-apply.cgi', { credentials: 'same-origin' });
		} catch (e) { /* the reload may sever this request — expected */ }
		const up = await pollUp(30000);
		if (up) {
			state.applyPending = false;
			location.reload();   // clean re-fetch of schema/config + preview
			return;
		}
		setToolbarMsg('The reload is taking longer than expected — the camera may still be applying changes.');
		if (btn) { btn.disabled = false; btn.textContent = 'Retry'; }
	}

	async function onReset(dot, btn) {
		if (!confirm('Reset "' + dot + '" to its declared default?')) return;
		btn.disabled = true;
		const orig = btn.textContent;
		btn.textContent = '…';
		clearError();
		try {
			const res = await apiFetch('/api/v1/reset?key=' + encodeURIComponent(dot), { credentials: 'same-origin' });
			if (!res.ok) {
				if (res.status === 404) {
					btn.title = 'Server has no recorded default for this key.';
					btn.disabled = true;
				} else {
					const txt = await safeText(res);
					showError('Reset failed (HTTP ' + res.status + '). ' + txt);
				}
				return;
			}
			await refresh();
		} catch (e) {
			showError('Reset failed: ' + e.message);
		} finally {
			btn.textContent = orig;
			if (!btn.title.startsWith('Server has no')) btn.disabled = false;
		}
	}

	async function refresh() {
		state.config = await fetchJson('/api/v1/config.json');
		for (const f of state.fields) {
			const eff = getDotted(state.config, f.dot);
			f.setValue(eff);
			state.initial[f.dot] = f.getValue();
		}
		runVisibility();
		updateDirty();
	}

	/* helpers */

	async function fetchJson(url) {
		const r = await apiFetch(url, { credentials: 'same-origin' });
		if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
		return r.json();
	}

	async function safeText(r) {
		try { return (await r.text()) || ''; } catch (_) { return ''; }
	}

	function getDotted(obj, dot) {
		return dot.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
	}

	function setDotted(obj, dot, val) {
		const parts = dot.split('.');
		let cur = obj;
		for (let i = 0; i < parts.length - 1; i++) {
			const k = parts[i];
			if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
			cur = cur[k];
		}
		cur[parts[parts.length - 1]] = val;
	}

	function toBool(v) {
		if (typeof v === 'boolean') return v;
		if (typeof v === 'string') return v === 'true';
		return Boolean(v);
	}

	function isNum(v) { return typeof v === 'number' && !isNaN(v); }
	function isNumish(v) { return isNum(v) || (typeof v === 'string' && v !== '' && !isNaN(Number(v))); }

	function el(tag, cls) {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		return e;
	}

	function esc(s) {
		return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
	}

	// An empty enum member is a real choice — majestic uses it for "inherit"
	// (outgoing/records audioCodec follow audio.codec) and for "auto-detect"
	// (isp.sensorConfig). Rendered verbatim it is an invisible blank row that
	// reads as a separator, so give it the same word the resolution pickers
	// use for the same idea (OpenIPC/majestic#291). `label` overrides the text
	// for callers that need to say more about the value than its own name.
	function option(v, selected, label) {
		const text = label !== undefined ? label : (String(v) === '' ? 'Auto' : v);
		return '<option value="' + esc(v) + '"' + (selected ? ' selected' : '') + '>' +
			esc(text) + '</option>';
	}

	function showError(msg) {
		const e = document.querySelector('#mj-settings-form .mj-error');
		if (!e) return;
		e.textContent = msg;
		e.classList.remove('d-none');
	}

	function clearError() {
		const e = document.querySelector('#mj-settings-form .mj-error');
		if (!e) return;
		e.textContent = '';
		e.classList.add('d-none');
	}

	function showFatal(container, msg) {
		const a = document.createElement('div');
		a.className = 'alert alert-danger';
		a.textContent = msg;
		container.appendChild(a);
	}
})();
