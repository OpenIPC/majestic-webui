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

	// Short labels + display order for the x-live image knobs in the Live
	// adjustments deck (keyed by the field's dot tail).
	//
	// The emoji that used to ride in front of each label are gone. A word in
	// small caps is denser and less ambiguous than a glyph plus the same word,
	// and emoji are not a typeface we control: 👁, on the IR filter button, has
	// no glyph in the stack the camera ships and rendered as an empty box on
	// hardware. What icons remain are inline SVG on a 20px grid.
	const LIVE_META = {
		luminance:  { label: 'Brightness' },
		contrast:   { label: 'Contrast' },
		saturation: { label: 'Saturation' },
		hue:        { label: 'Hue' },
		mirror:     { label: 'Mirror' },
		flip:       { label: 'Flip' },
	};
	const LIVE_ORDER = ['luminance', 'contrast', 'saturation', 'hue', 'mirror', 'flip'];

	// Stroked 20px-grid icons, currentColor, used on the stage chrome. Kept as
	// strings because every consumer builds its markup with innerHTML.
	const ICON = {
		reset: '<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M4.2 10a5.8 5.8 0 1 0 1.9-4.3"></path><path d="M3.4 3.6v3.9h3.9"></path></svg>',
		night: '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M16.4 12.3A7 7 0 0 1 7.7 3.6a7 7 0 1 0 8.7 8.7z"></path></svg>',
		ircut: '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="10" cy="10" r="6.6"></circle><path d="M10 3.4v13.2M4.3 6.7l11.4 6.6M4.3 13.3l11.4-6.6"></path></svg>',
		lamp: '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.6 14.4a5 5 0 1 1 4.8 0v1.7H7.6z"></path><path d="M8.2 17.6h3.6"></path></svg>',
		compare: '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><rect x="2.5" y="4" width="15" height="12" rx="1.6"></rect><path d="M10 4v12"></path><path d="M4.6 8.4h3M4.6 11.6h3"></path></svg>',
		snap: '<svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M2.6 6.6h3.2l1.5-2.1h5.4l1.5 2.1h3.2v9H2.6z" stroke-linejoin="round"></path><circle cx="10" cy="10.6" r="3.1"></circle></svg>',
		fs: '<svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M3 7.4V3h4.4M16.9 7.4V3h-4.4M3 12.6V17h4.4M16.9 12.6V17h-4.4"></path></svg>',
	};

	// Scene starting points, keyed by the same dot tails as LIVE_META. They are
	// exactly that — a place to start before you tune by eye — and the panel
	// says so, because a preset presented as an answer is worse than no preset:
	// every install has its own light. Tone only; a preset must never quietly
	// change which way up the picture is.
	const LIVE_PRESETS = [
		{ id: 'neutral',  label: 'Neutral',   v: { luminance: 50, contrast: 50, saturation: 50, hue: 50 } },
		{ id: 'indoor',   label: 'Indoor',    v: { luminance: 52, contrast: 46, saturation: 52, hue: 50 } },
		{ id: 'outdoor',  label: 'Outdoor',   v: { luminance: 46, contrast: 58, saturation: 54, hue: 50 } },
		{ id: 'lowlight', label: 'Low light', v: { luminance: 60, contrast: 42, saturation: 38, hue: 50 } },
	];

	// The orientation pad's four states. mirror/flip stay two independent
	// booleans in the config — this is only how a camera presents them, and how
	// every camera UI worth copying does.
	const GEO_STATES = [
		{ label: 'Normal', mirror: false, flip: false, tf: '' },
		{ label: 'Mirror', mirror: true,  flip: false, tf: 'translate(20,0) scale(-1,1)' },
		{ label: 'Flip',   mirror: false, flip: true,  tf: 'translate(0,20) scale(1,-1)' },
		{ label: '180°',   mirror: true,  flip: true,  tf: 'translate(20,20) scale(-1,-1)' },
	];

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
		const cur = groupOf(state.sec);
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
			if (WIDE.matches || q || (cur && cur.id === g.id)) li.classList.add('mj-open');

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
				// A keyboard-activated link fires its click with detail 0, a
				// pointer with the tap count — decided here, where the event is,
				// because revealSection() runs after an await and cannot ask.
				const byPointer = ev.detail > 0;
				// Picking the section that is already open is still a deliberate
				// pick: below md it means "take me back down to it", and a control
				// that does nothing at all reads as a dead one.
				if (newTab === state.sec) { revealSection(byPointer); return; }
				// Answering "no" to the prompt is choosing to stay, so nothing moves.
				if (hasDirty() && !confirm('You have unsaved changes. Discard and switch sections?')) return;
				// After load(), never inside it: the section has to be in the document
				// first, and buildNav() — which load() re-runs while a search is
				// active, resizing the rail *above* the form — has to have finished.
				load(newTab, /*push*/ true).then(() => revealSection(byPointer));
			});
		});
	}

	// Put the person in front of the section they just picked. Below md the rail
	// is stacked *above* the form rather than beside it, so a tap left them
	// looking at navigation with the fields they asked for below the fold (#199).
	// On >=md the rail is sticky-md-top and stays on screen at every offset, so
	// there is nothing there to correct and nothing worth jumping for.
	//
	// The whole column rather than the section's card: the live leaf renders a
	// row of two panels and no card at all, so there is no single card to aim at
	// — and the column's top edge is what should end up near the top of the
	// screen anyway. How far below the edge it lands is scroll-margin-top, in the
	// stylesheet beside the rest of the below-md rail rules.
	function revealSection(byPointer) {
		const form = document.getElementById('mj-settings-form');
		const col = document.getElementById('mj-settings-form-col');
		if (!form || !col) return;

		// A tap that neither navigates nor moves focus says nothing to a screen
		// reader, so the section's own heading takes it and announces the name.
		// preventScroll because the scroll below is ours: focusing the live
		// panel's heading would otherwise skip the preview sitting above it.
		//
		// Whether a script-set focus draws the browser's ring is a per-engine
		// guess — Safari answers :focus-visible for it where Chrome and Firefox
		// do not, and painted its default ring round every section title a
		// pointer picked (#222). So the pick's own modality decides, not the
		// heuristic: a pointer pick mutes the ring, a keyboard pick keeps it.
		const h = form.querySelector('h3');
		if (h) {
			h.tabIndex = -1;
			if (byPointer) {
				h.classList.add('mj-focus-quiet');
				h.addEventListener('blur', () => h.classList.remove('mj-focus-quiet'), { once: true });
			}
			h.focus({ preventScroll: true });
		}

		// No behaviour argument: bootstrap's reboot already sets scroll-behavior
		// on :root, inside @media (prefers-reduced-motion: no-preference), so a
		// bare scrollIntoView() animates like every other scroll on the site and
		// stops animating for anyone who asked it to. Naming 'smooth' or 'instant'
		// here would opt this one navigation out of both.
		if (!WIDE.matches) col.scrollIntoView();
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
		// Anything this leaf wired outside its own subtree — document-level
		// listeners for hold-to-compare, timers — is undone here. The subtree
		// itself goes with form.innerHTML, but a listener on `document` would
		// survive every navigation and accumulate one copy per visit.
		(state.liveCleanup || []).forEach(fn => { try { fn(); } catch (e) { /* teardown is best-effort */ } });
		state.liveCleanup = [];

		// Through the swap, which closes the trial as well as the player on
		// screen. Destroying only state.previewPlayer would leave a transport
		// still being judged behind on every visit — a live socket nobody has a
		// handle to, which is the leak this used to exist to prevent.
		if (state.previewSwap) {
			try { state.previewSwap.stop(); } catch (e) {}
			state.previewSwap = null;
			state.previewPlayer = null;
			return;
		}
		if (state.previewPlayer) {
			state.previewPlayer.destroy();
			state.previewPlayer = null;
		}
	}

	// What one x-live field is worth right now, and what the schema says it
	// should be. Sliders send their number; booleans send 1/0.
	function liveValue(f) {
		return f.type === 'boolean' ? (f.control.checked ? 1 : 0) : f.control.value;
	}

	function liveDefault(f) {
		const d = f.schema ? f.schema.default : undefined;
		if (d === undefined) return liveValue(f);
		return f.type === 'boolean' ? (toBool(d) ? 1 : 0) : d;
	}

	// The query string /api/v1/image takes, over ALL x-live fields — sending
	// them together is what lets the backend apply combined settings (mirror
	// and flip need each other). `valueOf` picks what each field contributes,
	// so hold-to-compare can post the defaults through the same builder rather
	// than growing a second copy of it.
	function liveQuery(valueOf) {
		const parts = [];
		for (const f of state.fields) {
			if (!f.schema || !f.schema['x-live']) continue;
			parts.push(encodeURIComponent(f.dot.split('.').pop()) + '=' +
				encodeURIComponent(valueOf(f)));
		}
		return parts.join('&');
	}

	// Serialised, not fire-and-forget. Hold-to-compare issues two of these — the
	// defaults on press, the live values on release — and independent fetches
	// have no ordering guarantee, so a short hold could let the defaults land
	// second and leave the camera sitting at stock: precisely the state this
	// control exists to undo. Each link swallows its own rejection, because a
	// write that fails must not wedge every write after it.
	let liveWrite = Promise.resolve();
	function postLive(q) {
		if (!q) return liveWrite;
		liveWrite = liveWrite.then(() =>
			apiFetch('/api/v1/image?' + q, { method: 'POST', credentials: 'same-origin' })
				.catch(() => {}));
		return liveWrite;
	}

	// Debounced live apply: on any x-live field change, POST the current value
	// of every x-live field at once.
	let liveTimer = null;
	function pushLive() {
		if (liveTimer) clearTimeout(liveTimer);
		liveTimer = setTimeout(() => { liveTimer = null; postLive(liveQuery(liveValue)); }, 120);
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
		state.liveSync = [];

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
			// The Live leaf's head, reused rather than imitated: micro-caps name,
			// hairline, and a note on the right. Still an <h3> — revealSection()
			// focuses it (#222) — with the heading's own size and margin taken off
			// by .mj-live-head h3.
			const head = el('div', 'mj-live-head');
			const h = el('h3', 'mj-cap');
			h.textContent = label(sec);
			const note = el('span', 'mj-live-note');
			note.id = 'mj-stock-note';
			head.appendChild(h);
			head.appendChild(el('span', 'mj-live-rule'));
			head.appendChild(note);
			body.appendChild(head);
			const lifted = liftedNote(sec);
			if (lifted) body.appendChild(lifted);
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
		paintStock();

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

		// The same swap the Preview page uses, for the same reason: a transport
		// that cannot run must not cost the viewer the picture that could. This
		// panel wants less from the outcome — there is no badge, no MJPEG and
		// no toggle here — but the machinery underneath is identical, and a
		// second copy of it would drift in ways that look like a picture rather
		// than an error.
		const swap = window.MajesticSwap({
			// Getters, not nodes: the MSE player replaces its element on every
			// reconnect (cloneNode plus replaceChild, keeping the id), so a
			// captured node is detached within a session and every show or hide
			// afterwards writes to something nobody can see.
			elements: [
				() => document.getElementById('mj-live-video'),
				() => document.getElementById('mj-live-video-b'),
			],
			open: (kind, el, id, onState) => {
				const impl = window.MajesticTransport.impl(kind);
				return impl.attach(el, {
					stream: stream,
					// Opened with the volume it should have rather than given
					// it afterwards; see preview-swap.js on why applying
					// preferences post-promotion undoes the staging.
					volume: 1,
					// Same list the Preview page builds, and for the same
					// reason: without it the browser offers host candidates
					// only, and a session opened from anywhere but the same LAN
					// negotiates cleanly and then never carries a packet.
					iceServers: () => window.MajesticTransport.iceServers(
						getDotted(state.config, 'webrtc.iceServers'),
						getDotted(state.config, 'webrtc.turnUsername'),
						getDotted(state.config, 'webrtc.turnCredential')),
					onState: onState,
				});
			},
			// state.previewPlayer is what the tab teardown closes, so it has to
			// name whatever is actually on screen — a stale handle there leaves
			// a live socket behind on every visit.
			onPromoted: () => { state.previewPlayer = swap.player(); },
			onFailed: (kind, why, permanent) => {
				// 'fallback' is durable and worth remembering; 'busy' says the
				// camera is full, which it will not be for long.
				if (kind === 'webrtc' && permanent) {
					window.MajesticTransport.demote();
				}
			},
			// Nothing on screen left to protect. MSE is the last thing to try;
			// past that this panel simply has no preview, which is what its
			// empty element already shows.
			onExhausted: (kind) => {
				state.previewPlayer = null;
				if (kind === 'webrtc') swap.start('mse');
			},
			onLive: (st, d, kind) => {
				if (kind !== 'webrtc') return;
				if (st === 'fallback' || st === 'busy') {
					if (st === 'fallback') window.MajesticTransport.demote();
					// Its picture is frozen from here; the replacement is
					// staged over it rather than blanking the panel.
					swap.retire();
					swap.start('mse');
				}
			},
		});
		state.previewSwap = swap;

		function attach(kind) { swap.start(kind); }

		attach(window.MajesticTransport.preferred());

		// Sub is offered only where there is one; `stream` above has already
		// fallen back to Main if not, so the control shows what is playing.
		const s0 = document.getElementById('mj-live-s0');
		const s1 = document.getElementById('mj-live-s1');
		const subLbl = document.getElementById('mj-live-sub');
		if (subLbl && subAvailable) subLbl.hidden = false;
		// Hiding the label leaves the input focusable — Bootstrap's btn-check
		// keeps it in the tab order — so arrow-key navigation could select a
		// stream that does not exist and land the panel on "no signal".
		if (s1) s1.disabled = !subAvailable;
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
				// And the trial, if one is being judged: it keeps the stream it
				// was opened with, so it would otherwise be promoted onto the
				// channel just moved away from.
				const t = swap.trial();
				if (t) t.setStream(n);
			});
		});
	}

	// ── The Live adjustments leaf ─────────────────────────────────────────
	//
	// The picture is the hero and it owns the column; everything else is either
	// overlaid on it or in the deck below, so nothing a control does can move
	// it. What this replaced put a 520x292 picture in a 990px column with the
	// knobs in a card beside it, and left roughly 60% of the content area
	// holding nothing.
	//
	// Two kinds of thing live on this leaf and the layout is what tells them
	// apart. Tone and orientation are CONFIGURATION: applied live to the
	// preview so they can be judged by eye, staged in the form until Save
	// writes them. Night, IR-cut and the lamp are RUNTIME: pressing one changes
	// the camera for every viewer immediately and none of them ever reaches the
	// save bar. So runtime sits on the picture and configuration sits in the
	// form — which is the distinction the old panel made with a blue outline
	// button next to a blue slider, i.e. not at all.

	function runtimeHtml() {
		// Checkbox + label rather than a <button>, so `checked` and `disabled`
		// keep meaning what wireRuntime() has always assumed and the LED is a
		// plain :checked rule. The input is off-screen, not display:none — a
		// hidden input is not focusable, and these are the only controls on the
		// stage a keyboard can reach.
		const one = (id, icon, text, cls) =>
			'<input type="checkbox" class="mj-hrt-in" id="' + id + '">' +
			'<label class="mj-hrt' + (cls ? ' ' + cls : '') + '" for="' + id + '">' +
			'<span class="mj-led"></span>' + icon + '<span>' + text + '</span></label>';
		return '<span class="mj-hud-rt mj-glass">' +
			one('toggle-night', ICON.night, 'Night') +
			one('toggle-ircut', ICON.ircut, 'IR&#8209;cut') +
			one('toggle-light', ICON.lamp, 'Lamp', 'mj-hrt-amber') +
			'</span>' +
			'<span class="mj-hud-chip mj-glass" id="mj-lightmon" hidden>' +
			'<a href="mj-settings.cgi?tab=nightMode">Light monitor is driving night, IR&#8209;cut and the lamp</a>' +
			'</span>';
	}

	function renderStage(form) {
		const stage = el('div', 'mj-live-stage');
		stage.id = 'mj-live-stage';
		// Two video elements because MajesticSwap stages a replacement on the
		// spare one and only shows it once it has a picture; it toggles them
		// through style.display, so the second starts that way rather than with
		// the `hidden` attribute.
		stage.innerHTML =
			'<video id="mj-live-video" autoplay muted playsinline class="mj-live-video"></video>' +
			'<video id="mj-live-video-b" autoplay muted playsinline class="mj-live-video" style="display:none"></video>' +
			'<div class="mj-live-bar">' +
			runtimeHtml() +
			'<button type="button" class="mj-hud-btn mj-glass" id="mj-live-compare">' +
			ICON.compare + '<span>Hold to compare</span></button>' +
			'<span class="mj-hud-end">' +
			'<button type="button" class="mj-hud-ico mj-glass" id="mj-live-snap" hidden aria-label="Snapshot" title="Snapshot"></button>' +
			'<button type="button" class="mj-hud-ico mj-glass" id="mj-live-fs" hidden aria-label="Fullscreen" title="Fullscreen"></button>' +
			'</span>' +
			'</div>';
		stage.querySelector('#mj-live-snap').innerHTML = ICON.snap;
		stage.querySelector('#mj-live-fs').innerHTML = ICON.fs;
		form.appendChild(stage);
		return stage;
	}

	// The night/IR/light runtime toggles. They live on this page rather than on
	// the Live page, which is deliberately settings-free. Gating mirrors what
	// that page did: the light monitor owns all three while it is active, and
	// IR cut / light need their pins configured. State comes from the metrics
	// endpoint because these are runtime facts, not config values.
	function wireRuntime(root) {
		const byId = id => root.querySelector('#' + id);
		const lbl = id => root.querySelector('label[for="' + id + '"]');
		const night = byId('toggle-night'), ircut = byId('toggle-ircut');
		const light = byId('toggle-light'), lightmon = byId('mj-lightmon');
		if (!night) return;
		const active = v => v !== false && v != null;
		const lm = active(getDotted(state.config, 'nightMode.lightMonitor'));

		// The monitor is driving all three, so three dead switches say less than
		// one sentence naming what has the wheel — and where to go to take it
		// back. The old panel showed the switches anyway with a small link
		// beside them.
		if (lm) {
			const grp = root.querySelector('.mj-hud-rt');
			if (grp) grp.hidden = true;
			if (lightmon) lightmon.hidden = false;
			return;
		}

		ircut.disabled = !active(getDotted(state.config, 'nightMode.irCutPin1'));
		light.disabled = !active(getDotted(state.config, 'nightMode.backlightPin'));
		// A control that cannot work should say which pin is missing rather than
		// just refusing to move.
		if (ircut.disabled && lbl('toggle-ircut'))
			lbl('toggle-ircut').title = 'nightMode.irCutPin1 is not configured.';
		if (light.disabled && lbl('toggle-light'))
			lbl('toggle-light').title = 'nightMode.backlightPin is not configured.';

		[['night', night], ['ircut', ircut], ['light', light]].forEach(([n, el2]) =>
			apiFetch('/metrics/night?value=' + n + '_enabled', { credentials: 'same-origin' })
				.then(r => r.text()).then(v => { el2.checked = +v > 0; })
				.catch(() => {}));

		night.addEventListener('click', () => {
			apiFetch('/night/toggle', { credentials: 'same-origin' })
				.then(r => r.json()).then(data => {
					night.checked = data;
					// Night mode drives the filter and the light where they are
					// not independently pinned, so the controls follow it.
					if (!ircut.disabled) ircut.checked = data;
					if (!light.disabled) light.checked = data;
				}).catch(() => {});
		});
		ircut.addEventListener('click', () => {
			apiFetch('/night/ircut', { credentials: 'same-origin' })
				.then(r => r.json()).then(data => { ircut.checked = data; })
				.catch(() => {});
		});
		light.addEventListener('click', () => {
			apiFetch('/night/light', { credentials: 'same-origin' })
				.then(r => r.json()).then(data => { light.checked = data; })
				.catch(() => {});
		});
	}

	// Hold to compare: post the schema defaults while the button is held, then
	// put the live values back on release. The same endpoint the sliders already
	// drive, so this is not a new kind of write — but it is the one control on
	// the stage that can leave the camera somewhere nobody asked for, so the
	// restore is guarded on every way a press can end, not just pointerup. If
	// the browser dies mid-hold the camera stays at stock; the form is still
	// dirty, so Save puts it right.
	function wireCompare(btn) {
		if (!btn) return;
		let held = false;
		const down = (e) => {
			if (held) return;
			held = true;
			btn.classList.add('mj-hud-on');
			// A queued push would land 120 ms later and undo the comparison.
			if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }
			if (e && e.pointerId != null && btn.setPointerCapture) {
				try { btn.setPointerCapture(e.pointerId); } catch (_) { /* the guards below still restore */ }
			}
			postLive(liveQuery(liveDefault));
		};
		const up = () => {
			if (!held) return;
			held = false;
			btn.classList.remove('mj-hud-on');
			postLive(liveQuery(liveValue));
		};
		btn.addEventListener('pointerdown', down);
		btn.addEventListener('pointerup', up);
		btn.addEventListener('pointercancel', up);
		btn.addEventListener('lostpointercapture', up);
		btn.addEventListener('blur', up);
		// Space and Enter on a focused button fire click, not pointerdown, so a
		// keyboard hold needs its own pair.
		btn.addEventListener('keydown', (e) => {
			if (e.repeat || (e.key !== ' ' && e.key !== 'Enter')) return;
			e.preventDefault();
			down(null);
		});
		btn.addEventListener('keyup', (e) => {
			if (e.key === ' ' || e.key === 'Enter') up();
		});
		// A tab switch or an alt-tab ends the press with no pointer event at all.
		document.addEventListener('visibilitychange', up);
		window.addEventListener('blur', up);
		state.liveCleanup.push(() => {
			document.removeEventListener('visibilitychange', up);
			window.removeEventListener('blur', up);
			up();
		});
	}

	// A titled group inside a deck column: micro-caps label, a rule to the
	// margin, an optional note on the right. Returns the body to fill.
	function liveGroup(container, title, note) {
		const g = el('div', 'mj-live-grp');
		const h = el('div', 'mj-live-grp-head');
		h.innerHTML = '<span class="mj-cap">' + esc(title) + '</span>' +
			'<span class="mj-live-rule"></span>' +
			(note ? '<span class="mj-live-note">' + esc(note) + '</span>' : '');
		g.appendChild(h);
		const body = el('div');
		g.appendChild(body);
		container.appendChild(g);
		return body;
	}

	// Set an x-live field and let the event drive everything downstream — the
	// row's own repaint, updateDirty, pushLive and the orientation pad all hang
	// off `input`, so this is the single way any code here changes a value.
	function setLive(f, v) {
		f.setValue(v);
		f.control.dispatchEvent(new Event('input', { bubbles: true }));
	}

	// Every x-live knob back to its schema default — staged, exactly like the
	// per-row ↺ and for the same reason. This used to call /api/v1/reset, which
	// wrote the camera the moment it was pressed while the sliders beside it
	// did not: on a panel whose whole claim is that nothing is written until
	// Save, it was the one control that broke the rule. The rest of the page
	// keeps the server-side reset, where every row behaves that way.
	function resetLiveAll() {
		for (const f of state.fields) {
			if (!f.schema || !f.schema['x-live']) continue;
			if (f.schema.default === undefined) continue;
			setLive(f, f.schema.default);
		}
	}

	// Mirror and flip are two booleans in the config and four states to a
	// person, which is how every camera UI worth copying presents them. The pad
	// is those four states; the two checkboxes stay real fields — hidden — so
	// Save, dirty tracking and refresh() never learn that any of this happened.
	function renderGeometry(container, mirrorField, flipField) {
		const row = el('div', 'mj-geo-row');
		const btns = GEO_STATES.map(g => {
			const b = el('button', 'mj-geo');
			b.type = 'button';
			b.innerHTML =
				'<svg viewBox="0 0 20 20" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">' +
				'<rect x="1.5" y="3.5" width="17" height="13" rx="1.8" opacity="0.4"></rect>' +
				'<g transform="' + g.tf + '"><path d="M7.6 6.8h5.2M7.6 10h3.7M7.6 6.8v6.4" stroke-linecap="round" stroke-width="1.7"></path></g>' +
				'</svg><span>' + esc(g.label) + '</span>';
			b.addEventListener('click', () => {
				setLive(mirrorField, g.mirror);
				setLive(flipField, g.flip);
			});
			row.appendChild(b);
			return b;
		});
		container.appendChild(row);

		const sync = () => {
			const m = toBool(mirrorField.getValue()), fl = toBool(flipField.getValue());
			GEO_STATES.forEach((g, i) => {
				const on = g.mirror === m && g.flip === fl;
				btns[i].classList.toggle('mj-geo-on', on);
				btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
			});
		};
		[mirrorField, flipField].forEach(f => {
			f.control.addEventListener('input', sync);
			f.control.addEventListener('change', sync);
		});
		// refresh() pushes values in with setValue and fires no events, so the
		// pad has to be told to re-read after a save or a reset.
		state.liveSync.push(sync);
		sync();

		// The pad is only half of orientation, and without saying so it looks
		// like all of it. Quarter turns are `rotate`, whose enum is deliberately
		// ["0","90","270"] — 180 is absent because mirror+flip already give you
		// that, at sensor level and for free. 90 and 270 are the ones this pad
		// cannot reach: they are a VPSS operation that swaps the stream's width
		// and height, so they are not x-live, do not belong on a panel whose
		// controls all apply live, and stay on their own leaf. Point at it
		// rather than move it here.
		const sec = mirrorField.dot.slice(0, mirrorField.dot.lastIndexOf('.'));
		const rotSchema = (((state.schema.properties || {})[sec] || {}).properties || {}).rotate;
		const turns = rotSchema && Array.isArray(rotSchema.enum)
			? rotSchema.enum.filter(v => String(v) !== '0') : [];
		if (turns.length && !EXCLUDE.has(sec + '.rotate')) {
			const hint = el('p', 'mj-live-hint');
			hint.innerHTML = 'Quarter turns (' +
				turns.map(v => esc(String(v)) + '&#176;').join(', ') +
				') resize the stream, so they are saved and applied with a reload: ' +
				'<a href="mj-settings.cgi?tab=' + esc(sec) + '">' + esc(label(sec)) + '</a>.';
			container.appendChild(hint);
		}
	}

	// Scene presets. Which one is "on" is DERIVED by comparing the current tone
	// values against the table, never stored: there is no fifth piece of state
	// to keep in step with the four that already exist, and a preset the user
	// has since nudged reports itself as Custom without anyone having to
	// remember to clear a flag.
	function renderScene(container, tone) {
		const byKey = {};
		tone.forEach(f => { byKey[f.key] = f; });
		// Only offer presets we can actually apply in full. A build missing one
		// of the four knobs would otherwise get a control that half-works.
		if (!LIVE_PRESETS.every(p => Object.keys(p.v).every(k => byKey[k]))) return;

		const row = el('div', 'mj-scene-row');
		const chips = LIVE_PRESETS.map(p => {
			const b = el('button', 'mj-scene-chip');
			b.type = 'button';
			b.textContent = p.label;
			b.addEventListener('click', () => {
				Object.keys(p.v).forEach(k => setLive(byKey[k], p.v[k]));
			});
			row.appendChild(b);
			return b;
		});
		container.appendChild(row);

		const status = el('div', 'mj-scene-status');
		status.innerHTML = '<span class="mj-pip"></span><span></span>';
		container.appendChild(status);
		const pip = status.querySelector('.mj-pip');
		const text = status.querySelector('span:last-child');

		const sync = () => {
			const cur = {};
			Object.keys(byKey).forEach(k => { cur[k] = Number(byKey[k].getValue()); });
			const hit = LIVE_PRESETS.find(p =>
				Object.keys(p.v).every(k => cur[k] === p.v[k]));
			chips.forEach((b, i) => {
				const on = !!hit && LIVE_PRESETS[i].id === hit.id;
				b.classList.toggle('mj-scene-chip-on', on);
				b.setAttribute('aria-pressed', on ? 'true' : 'false');
			});
			// "Stock" and "Neutral" are the same four numbers, but they are not
			// the same statement: one says the camera is untouched, the other
			// that a preset was chosen. The first is what somebody inheriting
			// this camera needs to hear.
			const off = tone.filter(f => f.schema.default !== undefined &&
				Number(f.getValue()) !== Number(f.schema.default)).length;
			let head, tail;
			// "Stock" is a claim about the SCHEMA's defaults, so it is answered
			// by comparing against them — not by matching the Neutral row of a
			// table that hard-codes 50. On a build whose defaults are not 50,
			// matching Neutral and being at the factory setting are different
			// facts, and saying the second when only the first is true is the
			// one lie this line must never tell.
			if (!off) {
				head = 'Stock';
				tail = '— every value at its factory default';
			} else if (hit) {
				head = hit.label;
				tail = '— unmodified preset';
			} else {
				head = 'Custom';
				tail = '— ' + off + (off === 1 ? ' value differs' : ' values differ') + ' from stock';
			}
			pip.style.opacity = off ? '1' : '0.25';
			text.innerHTML = '<b>' + esc(head) + '</b> ' + esc(tail);
		};
		tone.forEach(f => {
			f.control.addEventListener('input', sync);
			f.control.addEventListener('change', sync);
		});
		state.liveSync.push(sync);
		sync();
	}

	// The luma histogram. Everything it needs is already in the browser — the
	// decoded picture — so this costs the camera nothing and needs no endpoint.
	function renderLuma(container) {
		if (!window.MajesticLuma) return;
		const wrap = el('div', 'mj-luma');
		wrap.innerHTML =
			'<div class="mj-luma-plot">' +
			'<svg viewBox="0 0 ' + window.MajesticLuma.BINS + ' 100" preserveAspectRatio="none" aria-hidden="true">' +
			'<path class="mj-luma-path" d=""></path>' +
			'<path class="mj-luma-mid" d="M' + (window.MajesticLuma.BINS / 2) + ' 0 V100"></path>' +
			'</svg>' +
			'<span class="mj-luma-clip mj-luma-clip-l" hidden></span>' +
			'<span class="mj-luma-clip mj-luma-clip-r" hidden></span>' +
			'</div>' +
			'<div class="mj-luma-read"><span class="mj-luma-verdict"></span>' +
			'<span class="mj-luma-scale">Y&#8242; 0&#8211;255</span></div>';
		container.appendChild(wrap);

		const pathEl = wrap.querySelector('.mj-luma-path');
		const clipL = wrap.querySelector('.mj-luma-clip-l');
		const clipR = wrap.querySelector('.mj-luma-clip-r');
		const verdict = wrap.querySelector('.mj-luma-verdict');
		const meanEl = container.parentNode.querySelector('.mj-luma-mean');

		const sampler = window.MajesticLuma.start({
			video: () => {
				// Whichever element the swap currently has on screen; the MSE
				// player replaces its node on every reconnect.
				const a = document.getElementById('mj-live-video');
				const b = document.getElementById('mj-live-video-b');
				if (a && a.style.display !== 'none' && a.readyState >= 2) return a;
				if (b && b.style.display !== 'none' && b.readyState >= 2) return b;
				return a || b;
			},
			onData: (r) => {
				pathEl.setAttribute('d', r.path);
				// One per cent is the threshold worth a warning: below it you
				// are looking at a specular highlight or a genuinely black
				// corner, not at an exposure that needs moving.
				const lo = r.low >= 0.01, hi = r.high >= 0.01;
				clipL.hidden = !lo;
				clipR.hidden = !hi;
				const parts = [];
				if (lo) parts.push((r.low * 100).toFixed(1) + '% crushed');
				if (hi) parts.push((r.high * 100).toFixed(1) + '% blown');
				verdict.className = 'mj-luma-verdict' + (parts.length ? ' mj-luma-warn' : ' mj-luma-ok');
				verdict.textContent = parts.length ? parts.join(' · ') : 'no clipping';
				if (meanEl) meanEl.textContent = 'mean ' + Math.round(r.mean);
			},
		});
		// Torn down with the rest of the leaf, so a section change does not
		// leave a timer reading a detached element four navigations later.
		state.liveCleanup.push(() => sampler.stop());
	}

	function renderLive(form) {
		const fields = liveFields();
		// The whole player stack, not just the decoder. attachLivePreview()
		// reaches for MajesticTransport and MajesticSwap as well, so a page
		// served without them — an older install, a half-finished deploy —
		// threw there and abandoned renderLive with the stage on screen and the
		// deck never built, silently. Missing scripts should cost the preview,
		// not the controls.
		const withVideo = !!(window.MajesticVideo && window.MajesticSwap &&
			window.MajesticTransport);

		// The only place the leaf names itself — the rail's active item says it
		// too — with the stream picker on the same line rather than in a card
		// header of its own.
		//
		// An <h3> despite the micro-caps styling, and not a <span>: revealSection()
		// focuses `form h3` after a navigation so the section announces itself to
		// a screen reader (#222). Every other leaf has one; styling this like a
		// group label must not cost the Live leaf its heading.
		const head = el('div', 'mj-live-head');
		head.innerHTML =
			'<h3 class="mj-cap">Live adjustments</h3>' +
			'<span class="mj-live-rule"></span>' +
			'<span class="mj-seg" role="group" aria-label="Stream">' +
			'<input type="radio" class="mj-seg-in" name="mj-live-stream" id="mj-live-s0" autocomplete="off">' +
			'<label class="mj-seg-lbl" for="mj-live-s0">Main</label>' +
			'<input type="radio" class="mj-seg-in" name="mj-live-stream" id="mj-live-s1" autocomplete="off">' +
			'<label class="mj-seg-lbl" for="mj-live-s1" id="mj-live-sub" hidden>Sub</label>' +
			'</span>';
		form.appendChild(head);

		if (withVideo) {
			const stage = renderStage(form);
			attachLivePreview(stage.querySelector('#mj-live-video'));
			wireRuntime(stage);
			wireCompare(stage.querySelector('#mj-live-compare'));
			// Shared with the Live page rather than copied: the /image.jpg
			// naming, the jpeg.enabled gate and the delayed revokeObjectURL are
			// details a second copy would drift on.
			if (window.MajesticHero) {
				// The disposer matters here and not on the Live page: this stage
				// is rebuilt every time the leaf is opened.
				const offFs = window.MajesticHero.wireFullscreen(stage, stage.querySelector('#mj-live-fs'));
				if (offFs) state.liveCleanup.push(offFs);
				window.MajesticHero.wireSnapshot(stage.querySelector('#mj-live-snap'));
			}
			const note = el('p', 'mj-live-hint');
			note.textContent = 'Night, IR-cut and the lamp are on the picture because they are runtime state: ' +
				'pressing one changes the camera for every viewer immediately, and none of them is part of Save.';
			form.appendChild(note);
		}

		// The deck: one card split by a rule, so tone and orientation read as
		// one instrument rather than as two unrelated panels.
		const deck = el('div', 'mj-live-deck');
		const colA = el('div', 'mj-live-col');
		const colB = el('div', 'mj-live-col mj-live-col-b');
		deck.appendChild(colA);
		deck.appendChild(colB);
		form.appendChild(deck);

		// The pad replaces the two switches only when BOTH halves of it are
		// there. A build that marks just one of them x-live — or that marks some
		// other boolean x-live — keeps the switch it has always had.
		const mirror = fields.find(f => f.key === 'mirror' && f.sub.type === 'boolean');
		const flip = fields.find(f => f.key === 'flip' && f.sub.type === 'boolean');
		const useGeo = !!(mirror && flip);

		const hasTone = fields.some(f => f !== mirror && f !== flip);
		// Tone starts the left column, with nothing above it: whatever sits
		// between the picture and the first slider comes straight off the one
		// guarantee this panel owes, which is that a knob and the effect it has
		// are on screen together (#239). Scene used to be there and cost 111px,
		// which put Brightness exactly on the fold at 1440x900.
		//
		// Scene goes UNDER the sliders rather than into the other column. It
		// sets those same four values, so it belongs beside them; and the two
		// columns have to carry comparable weight or the deck is mostly empty
		// on one side — parking it on the right left 282px of nothing under
		// "Reset all to stock".
		const toneBody = hasTone ? liveGroup(colA, 'Tone', 'saved with the page') : null;

		for (const f of fields) {
			const geoField = useGeo && (f === mirror || f === flip);
			const box = geoField ? colB : (toneBody || colA);
			const field = renderField(box, f.dot, f.key, f.sub,
				getDotted(state.config, f.dot), { live: true, hidden: geoField });
			if (!field) continue;
			state.fields.push(field);
			state.initial[f.dot] = field.getValue();
		}

		if (toneBody) {
			const foot = el('div', 'mj-live-foot');
			const rall = el('button', 'mj-live-linkbtn');
			rall.type = 'button';
			rall.innerHTML = ICON.reset + '<span>Reset all to stock</span>';
			rall.addEventListener('click', resetLiveAll);
			foot.appendChild(rall);
			toneBody.appendChild(foot);
		}

		// Under the sliders it drives, and last in the left column so it never
		// pushes them away from the picture.
		const toneFields = state.fields.filter(f =>
			f.schema && f.schema['x-live'] && f.type === 'integer');
		if (hasTone && toneFields.length) {
			renderScene(liveGroup(colA, 'Scene', 'starting points, then tune by eye'),
				toneFields);
		}

		if (withVideo) {
			// The group's note slot carries the running mean rather than a
			// caption — a number that changes is worth more there than a word
			// that does not.
			const lumaBody = liveGroup(colB, 'Luma', 'mean —');
			const note = lumaBody.parentNode.querySelector('.mj-live-note');
			if (note) note.className = 'mj-live-note mj-luma-mean';
			renderLuma(lumaBody);
		}

		if (useGeo) {
			const mf = state.fields.find(f => f.dot === mirror.dot);
			const ff = state.fields.find(f => f.dot === flip.dot);
			if (mf && ff) renderGeometry(liveGroup(colB, 'Orientation', ''), mf, ff);
		}

		// Every group above is conditional — on the schema, and on which player
		// scripts loaded — so an empty column is reachable rather than
		// hypothetical: without the player there is no Luma, and a build that
		// marks only one of mirror/flip x-live has no Orientation either, which
		// between them leave the right column holding nothing. It is 23rem wide
		// with a divider whether or not anything is in it, so it would squeeze
		// the surviving controls and add a blank section once stacked. Drop
		// whatever came out empty instead of enumerating the combinations.
		[colA, colB].forEach(c => { if (!c.childElementCount) c.remove(); });
		if (!deck.childElementCount) deck.remove();
	}

	const isGroup = (sub) => !!(sub && sub.type === 'object' && sub.properties);

	// A section whose knobs were lifted onto the Live leaf looks half-empty and
	// says nothing about why: image is two rows because six of its eight are
	// x-live and render where the picture is. Only claims what is actually on
	// that leaf — liveFields() is the same list renderLive() mounts, so a build
	// whose live knobs live in another group gets no note rather than a wrong one.
	function liftedNote(sec) {
		const mine = liveFields().filter(f => f.section === sec);
		if (!mine.length) return null;
		const names = mine.map(f => liveLabel(f.key, f.sub).toLowerCase());
		const list = names.length > 1
			? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1]
			: names[0];
		const p = el('p', 'mj-lifted');
		p.innerHTML = esc(list.charAt(0).toUpperCase() + list.slice(1)) +
			' apply as you drag them, so they are on ' +
			'<a href="?tab=' + LIVE_ID + '">Live adjustments</a> with the picture.';
		return p;
	}

	// "all N at stock" / "N of M off stock" for the section head — the question
	// the per-row ↺ can only answer one row at a time. Counted over what is on
	// screen (a visibleWhen-hidden row is not one of the section's N from here)
	// and over fields the schema records a default for, so the sentence is
	// provable: a key with no recorded default can never be shown to be either.
	// Measured against the default rather than against the last save, so it goes
	// on saying "off stock" after Save — it is a fact about the camera.
	function paintStock() {
		const note = document.getElementById('mj-stock-note');
		if (!note) return;
		let shown = 0, known = 0, off = 0;
		for (const f of state.fields) {
			if (!f.p || f.p.style.display === 'none') continue;
			shown++;
			if (!f.schema || !Object.prototype.hasOwnProperty.call(f.schema, 'default')) continue;
			known++;
			if (String(f.getValue()) !== String(f.schema.default)) off++;
		}
		// The denominator is the rows on screen, so it matches what can be
		// counted; "all at stock" carries no number at all, because the honest
		// one is the number of *defaulted* fields and printing "all 9" beside
		// twelve visible rows invites exactly the wrong reading.
		note.textContent = !known ? ''
			: off ? off + ' of ' + shown + ' off stock'
				: 'all at stock';
		note.classList.toggle('mj-off-stock', off > 0);
	}

	function renderProps(container, basePath, props) {
		// Scalars first, object subtrees after. An object renders as a labelled
		// group and everything below its heading reads as part of it, so a scalar
		// sibling that happens to come later in the schema is captured by it:
		// isp.blkCnt — memory blocks for the encoder — read as an iris setting,
		// which is where nobody would look for it.
		const keys = Object.keys(props);
		const ordered = keys.filter(k => !isGroup(props[k])).concat(keys.filter(k => isGroup(props[k])));
		for (const key of ordered) {
			const dot = basePath + '.' + key;
			if (EXCLUDE.has(dot)) continue;
			if (dot === ROI_DOT) continue;        // renders on the Visual editor leaf
			const sub = props[key];
			if (sub && sub['x-live']) continue;   // live knobs render on their own leaf
			if (isGroup(sub)) {
				// The Live deck's group head, verbatim: micro-caps name and a
				// hairline to the column edge, rather than a 20px grey <h5> that
				// outweighed every label under it.
				const h = el('div', 'mj-live-grp-head');
				const t = el('span', 'mj-cap');
				t.textContent = sub.title || titleCase(key);
				h.appendChild(t);
				h.appendChild(el('span', 'mj-live-rule'));
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
			controllers.add(ctrl);
		}
		// Flipping a controller changes which rows exist, so anything that counts
		// rows has to run again — once per controller, and only once every
		// dependent row has been shown or hidden.
		//
		// Registered after the loop, not inside it: listeners fire in the order
		// they were added, so attaching this beside the first dependent field's
		// update() ran it after that one row and before the other seven. Setting
		// isp.iris.type to DC reveals eight rows and the count read one of them —
		// "1 of 13 off stock" against thirteen rows on a screen showing twenty.
		for (const ctrl of controllers) {
			const recount = () => { paintStock(); if (state.q.trim()) buildNav(); };
			ctrl.control.addEventListener('change', recount);
			ctrl.control.addEventListener('input', recount);
		}
	}

	function runVisibility() {
		(state.visUpdaters || []).forEach(u => u());
		// what is on screen just changed, and the head counts what is on screen
		paintStock();
	}

	// At or below this many visible rows a section stays in one column.
	const SOLO_MAX = 4;

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

		// A handful of rows does not want two columns. image is two rows once its
		// six x-live knobs are on the Live leaf, and dealt in half that is one row
		// beside one row across 966px of card. Under the cut they stay in one
		// column at a readable measure and the second column is not drawn at all,
		// divider included.
		const shown = items.filter(it => it.offsetHeight).length;
		const solo = shown <= SOLO_MAX;
		box.classList.toggle('mj-solo', solo);
		if (solo) {
			if (b.childElementCount) {
				const held = grabFocus(box);
				items.forEach(it => a.appendChild(it));
				restoreFocus(held);
			}
			return;
		}

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
			if (i < items.length && items[i - 1].classList.contains('mj-live-grp-head')) continue;
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
		// live knobs use the short label; everything else uses the title.
		// data-hl carries the raw text so highlightPanel() can re-mark the label
		// in place when the search term changes, without re-rendering the control
		// (which would throw away unsaved edits)
		const hlSpan = (t) => '<span data-hl="' + esc(t) + '">' + esc(t) + '</span>';
		const labelHtml = hlSpan(live ? liveLabel(key, sub) : desc);
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

		if (live && type === 'integer' && isNum(sub.maximum)) {
			// The detent slider. Its fill runs from the schema's own default to
			// the current value rather than from the minimum, so a stock camera
			// shows no fill at all and one look down the column answers the
			// question an installer actually has: has anyone touched this, and
			// which way. The tick marks the default; the signed delta says how
			// far in numbers.
			p = el('p', 'range mj-row mj-live-row');
			const min = isNum(sub.minimum) ? sub.minimum : 0;
			const max = sub.maximum;
			const span = (max - min) || 1;
			// No declared default means no detent to run from: the fill starts
			// at the minimum, the tick and the delta are omitted, and ↺ has
			// nothing to reset to.
			const hasDef = isNum(sub.default);
			const def = hasDef ? sub.default : min;
			const v = isNumish(eff) ? Number(eff) : def;
			const pct = (n) => ((n - min) / span * 100);
			const name = esc(liveLabel(key, sub));
			p.innerHTML =
				'<label class="mj-live-name" for="' + id + '">' + labelHtml + '</label>' +
				'<span class="mj-live-track">' +
				'<span class="mj-live-bg"></span>' +
				(hasDef ? '<span class="mj-live-tick" style="left:' + pct(def).toFixed(3) + '%"></span>' : '') +
				'<span class="mj-live-fill"></span>' +
				'<input type="range" class="mj-live-input" id="' + id + '" min="' + min + '" max="' + max + '" step="1" value="' + v + '">' +
				'</span>' +
				'<input type="number" class="mj-live-num" min="' + min + '" max="' + max + '" step="1" value="' + v + '" aria-label="' + name + ' value">' +
				'<span class="mj-live-delta" aria-hidden="true"></span>' +
				'<button type="button" class="mj-live-rst" aria-label="Reset ' + name + ' to ' + def + '">' + ICON.reset + '</button>';
			control = p.querySelector('.mj-live-input');
			const num = p.querySelector('.mj-live-num');
			const fill = p.querySelector('.mj-live-fill');
			const delta = p.querySelector('.mj-live-delta');
			const rst = p.querySelector('.mj-live-rst');

			const paint = () => {
				const cur = Number(control.value);
				const lo = Math.min(cur, def), hi = Math.max(cur, def);
				fill.style.left = pct(lo).toFixed(3) + '%';
				fill.style.width = (pct(hi) - pct(lo)).toFixed(3) + '%';
				const d = cur - def;
				delta.textContent = (!hasDef || d === 0) ? '' : (d > 0 ? '+' + d : '−' + (-d));
				p.classList.toggle('mj-live-off', hasDef && d !== 0);
				if (num.value !== String(cur)) num.value = cur;
				rst.disabled = !hasDef || d === 0;
			};

			// Snap to the detent, but only under a pointer. Snapping on every
			// input would trap the arrow keys at the default (49 -> 50, 51 ->
			// 50) and put both of those values permanently out of reach.
			let dragging = false;
			const endDrag = () => { dragging = false; };
			control.addEventListener('pointerdown', () => { dragging = true; });
			control.addEventListener('pointerup', endDrag);
			control.addEventListener('pointercancel', endDrag);
			// Registered before renderField's own updateDirty/pushLive listeners
			// below, so the snapped value is what they read.
			control.addEventListener('input', () => {
				if (dragging && hasDef && Math.abs(Number(control.value) - def) <= 1)
					control.value = def;
				paint();
			});

			// The readout is an input, not a label: typing an exact value is
			// what a number is for, and a slider alone cannot hit one.
			const fromNum = () => {
				if (num.value === '') return;      // mid-edit, not a value yet
				let n = Number(num.value);
				if (!isFinite(n)) return;
				n = Math.max(min, Math.min(max, Math.round(n)));
				if (String(n) === control.value) return;
				control.value = n;
				control.dispatchEvent(new Event('input', { bubbles: true }));
			};
			num.addEventListener('input', fromNum);
			num.addEventListener('change', () => { fromNum(); paint(); });

			// A LOCAL reset: put the control on its default and leave the row
			// dirty. Everywhere else on this page ↺ calls /api/v1/reset and
			// persists immediately — here that would be the only control on the
			// leaf that writes the camera before Save, which is exactly the
			// confusion the layout is trying to remove.
			rst.addEventListener('click', () => {
				if (!hasDef) return;
				control.value = def;
				control.dispatchEvent(new Event('input', { bubbles: true }));
			});

			control._set = (val) => {
				control.value = isNumish(val) ? Number(val) : def;
				paint();
			};
			paint();
		} else if (type === 'boolean') {
			// The label goes above the switch, like every other type's, instead of
			// beside it: a switch row was 26px where a select row is 64, so a
			// column mixing the two had no rhythm, and the ↺ — which trails the
			// control — sat at a different x on a boolean than on anything else.
			// The lit word carries the state, the way the Live bar's toggles do:
			// a bare switch states its position but not what the position means.
			//
			// Live rows keep the inline shape. They are not wrapped in .mj-ctl
			// (see below), so the two-line form would leave the label stranded
			// above a switch with no rail to line up against.
			p = el('p', 'boolean mj-row' + liveCls);
			p.innerHTML = live
				? '<span class="form-check form-switch">' +
					'<input type="checkbox" id="' + id + '" class="form-check-input">' +
					'<label for="' + id + '" class="form-check-label">' + labelHtml + '</label>' +
					'</span>'
				: '<label for="' + id + '" class="form-label">' + labelHtml + '</label>' +
					'<span class="form-check form-switch">' +
					'<input type="checkbox" id="' + id + '" class="form-check-input">' +
					'</span>' +
					'<span class="mj-state" aria-hidden="true"></span>';
			control = p.querySelector('input');
			control.checked = toBool(eff);
			const word = p.querySelector('.mj-state');
			if (word) {
				const paintState = () => {
					word.textContent = control.checked ? 'On' : 'Off';
					word.classList.toggle('mj-state-on', control.checked);
				};
				control.addEventListener('change', paintState);
				// refresh() and onReset() push values in through setValue and fire
				// no events, so the word has to be repainted on that path too —
				// the same _set hatch the detent slider uses.
				control._set = (v) => { control.checked = toBool(v); paintState(); };
				paintState();
			}
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
			reset.className = 'mj-reset';
			// The Live deck's glyph, not U+21BA: a text arrow is a different shape
			// in every font stack, and these two controls do the same thing.
			reset.innerHTML = ICON.reset;
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

		// A field the orientation pad drives instead: still a real field, so
		// Save, dirty tracking and refresh() are untouched, just not drawn.
		if (opts.hidden) p.hidden = true;

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
		paintStock();
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
		// setValue fires no events, so anything that mirrors a field rather than
		// owning it — the orientation pad — has to be told to re-read.
		(state.liveSync || []).forEach(fn => fn());
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
