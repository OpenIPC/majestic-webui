(() => {
	'use strict';

	// The shared condition evaluator (visibleWhen and x-requires). Read once,
	// here, so a page served without it degrades the same way everywhere
	// instead of throwing at the first conditional row.
	const REQ = (typeof window === 'object' && window.MajesticRequires) || null;

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
		// A rectangle being drawn: dashed, with the crosshair centre that says
		// the next drag lands one.
		draw: '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><rect x="3" y="4.5" width="14" height="11" rx="1.4" stroke-dasharray="2.6 2.2"></rect><path d="M10 8v4M8 10h4"></path></svg>',
		plus: '<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11"></path></svg>',
		trash: '<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6h11M8 6V4.2h4V6M6.3 6l.7 9.6h6l.7-9.6"></path></svg>',
		compare: '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><rect x="2.5" y="4" width="15" height="12" rx="1.6"></rect><path d="M10 4v12"></path><path d="M4.6 8.4h3M4.6 11.6h3"></path></svg>',
		// The snapshot and fullscreen glyphs went with the buttons they sit on,
		// into mj-preview.js: a caller asking the stage for a snapshot button
		// should not also have to supply its icon.
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
		// the mj-preview.js handle for whatever section is showing a picture,
		// or null. One at a time only because one section is mounted at a time —
		// the stage itself no longer cares how many of it there are.
		preview: null,
		dirtyN: 0,
		// a save whose changes need a pipeline reload leaves this set until the
		// reload actually runs, so Apply survives switching sections
		applyPending: false,
		flashPending: false,
		flashTimer: null,
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
		watchIrcut();
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
	// `withLive` keeps the x-live fields in. They are normally left out because
	// the Live adjustments leaf lifts them out of their sections and renders
	// them beside the picture — but that leaf only lifts from the group that
	// owns it, so a section elsewhere whose keys became live has to render its
	// own. The Overlay leaf is that case: the camera classes its placement keys
	// live (it can move the region without a rebuild), and without this they
	// would be lifted nowhere and simply disappear from the settings page.
	function sectionFields(section, withLive) {
		const ck = withLive ? section + '\u0000live' : section;
		if (state.fieldCache[ck]) return state.fieldCache[ck];
		const out = [];
		const walk = (basePath, props) => {
			for (const key of Object.keys(props)) {
				const dot = basePath + '.' + key;
				if (EXCLUDE.has(dot)) continue;
				const sub = props[key];
				if (!sub) continue;
				if (sub['x-live'] && !withLive) continue;
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
		state.fieldCache[ck] = out;
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
			// The Visual editor was its own leaf until the regions moved onto
			// Motion detection's picture. A bookmark to it is not a dead link:
			// it names a thing that still exists, on the page that now holds it.
			if (tab === ROI_ID) tab = 'motionDetect';
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

	// What a given leaf actually renders. The Live leaf has no schema section of
	// its own; every other leaf renders its whole section, motionDetect.roi
	// included — the regions are drawn on that section's own picture now, so
	// searching for "region" has one place to land instead of two.
	function leafFields(secId) {
		if (secId === LIVE_ID) return liveFields().map(f =>
			({ sub: f.sub, dot: f.dot, title: liveLabel(f.key, f.sub), hint: f.sub.hint || '' }));
		return sectionFields(secId, secId === 'osd');
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
				a.href = 'camera.cgi?tab=' + encodeURIComponent(s.id);
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
			// Set to match this pick, every time, and never taken off on blur.
			//
			// Blur was the obvious moment to drop it and it is the wrong one:
			// switching browser tabs blurs the heading, and coming back focuses
			// it again with no new intent from anyone in between. The tag was
			// gone by then, so the ring reappeared on return — and only
			// sometimes, because it depends on whether the tab was switched with
			// the keyboard, which is what makes the engine call the restored
			// focus "visible" (#222).
			//
			// Leaving it costs nothing. tabindex -1 keeps the heading out of the
			// tab order, so nothing but this function can focus it, and this
			// function sets the tag both ways on every pick.
			h.classList.toggle('mj-focus-quiet', !!byPointer);
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

	function stopLivePreview() {
		// The camera is the first thing this leaf changed outside its own
		// subtree, and it used to be the one thing teardown left behind (#259).
		// Before the fields go, put it back where they say it is.
		revertLive();

		// Anything this leaf wired outside its own subtree — document-level
		// listeners for hold-to-compare, timers — is undone here. The subtree
		// itself goes with form.innerHTML, but a listener on `document` would
		// survive every navigation and accumulate one copy per visit.
		(state.liveCleanup || []).forEach(fn => { try { fn(); } catch (e) { /* teardown is best-effort */ } });
		state.liveCleanup = [];

		// The pin map puts keydown and pointerdown on `document`, which is
		// exactly the kind of listener the comment above is about: it has to
		// come off when the section goes, not when a replacement happens to
		// mount, or Escape keeps being intercepted from another tab entirely.
		if (state.ircutMap && state.ircutMap.destroy) {
			try { state.ircutMap.destroy(); } catch (e) { /* best-effort */ }
			state.ircutMap = null;
			state.ircutRoles = null;
		}

		// The stage closes its own transports — including a trial still being
		// judged, which is the leak this has always been about: a live socket
		// nobody holds a handle to, left behind on every visit.
		if (state.preview) {
			try { state.preview.destroy(); } catch (e) { /* best-effort */ }
			state.preview = null;
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

	// What the config says this knob is, as /api/v1/image wants it. state.initial
	// is snapshotted from config.json at mount, so it is at once what the
	// controls will read after a re-render and what the camera has to be put
	// back to. It holds getValue()'s strings — 'true'/'false' for a switch —
	// while the endpoint wants 1/0, which is the whole reason this is not just
	// `state.initial[f.dot]`.
	function liveSaved(f) {
		const v = state.initial[f.dot];
		if (v === undefined) return liveValue(f);
		return f.type === 'boolean' ? (toBool(v) ? 1 : 0) : v;
	}

	const isLive = (f) => !!(f.schema && f.schema['x-live']);

	// A save that is on the wire owns the live values. It has handed the camera
	// the dragged ones on purpose, and state.initial does not catch up until the
	// response comes back — so for that window `liveDrift()` reports a
	// difference that is about to stop being one, and a revert built from it
	// would undo the save.
	let liveSaving = 0;

	// Whether the camera is running something this page has not saved. Dragging
	// a knob POSTs it to the SDK immediately; that is a runtime write and never
	// reaches config.json, so nothing else on the page can tell.
	function liveDrift() {
		if (liveSaving) return false;
		return state.fields.some(f => isLive(f) && f.getValue() !== state.initial[f.dot]);
	}

	// Put the camera back where the controls say it is. Discarding used to drop
	// the FORM and nothing else: the sliders came back at their saved values
	// while the ISP kept the dragged ones, and the controls were the ones lying
	// (#259). Reported for the section switch, but the same hole was open on
	// browser Back, which does not even prompt — so this lives in the teardown
	// every one of those paths already runs through rather than at any of them.
	function revertLive() {
		// The debounced write is the discarded edit, still 120ms from being
		// sent. postLive serialises, so leaving it queued would put it AFTER the
		// revert and hand the camera back the very values being thrown away —
		// a fast navigation right after a drag would have undone the undo.
		if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }
		if (!state.fields.length || !liveDrift()) return;
		postLive(liveQuery(liveSaved));
	}

	// A reload, or a closed tab, abandons the edit exactly as a section switch
	// does — and it is the one path a normal request cannot cover, because the
	// fetch dies with the document. sendBeacon is queued by the browser and
	// outlives it.
	//
	// Not on a bfcache hide: that page is coming back with its controls still
	// where they were dragged to, so the camera should be waiting for it. The
	// bug this fixes is the controls and the camera disagreeing, and reverting
	// here would only re-create it facing the other way.
	function wireUnloadRevert() {
		const onHide = (ev) => {
			// Same reason as in revertLive: a queued write would be the discarded
			// edit arriving after the revert. There is no chaining it here — the
			// beacon leaves outside liveWrite because nothing can be awaited on
			// the way out — so cancelling is the whole of the ordering guarantee,
			// and it covers everything except a write already on the wire when
			// the tab closed. That one can still be reordered by the server, and
			// this page has no way to stop it.
			if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }
			if (ev.persisted || !state.fields.length || !liveDrift()) return;
			const q = liveQuery(liveSaved);
			if (q && navigator.sendBeacon) navigator.sendBeacon('/api/v1/image?' + q);
		};
		window.addEventListener('pagehide', onHide);
		return () => window.removeEventListener('pagehide', onHide);
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
			history.pushState({ tab: sec }, '', 'camera.cgi?tab=' + encodeURIComponent(sec));
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
		// dropped with the fields they paint: a stale closure would keep
		// writing into a row that is no longer in the document
		state.reqUpdaters = [];

		// Exactly one section on the page, so it gets the whole width — and its
		// fields are dealt into the two columns of .mj-cols, rather than run
		// down the left as a single strip of controls.
		if (sec === LIVE_ID) {
			renderLive(form);
		} else if (sec === 'osd') {
			renderOsd(form);
		} else if (sec === 'motionDetect') {
			renderMotion(form);
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
			// Above the fields, not below them: on Day / Night the verdict is
			// what someone came to read, and the pin numbers are what they will
			// change because of it.
			const ircut = ircutPanel(sec);
			if (ircut) body.appendChild(ircut);
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
		// Paints from whatever the heartbeat has already published; the
		// subscription keeps it current from there.
		paintFindings();

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

	function hasDirty() {
		return state.fields.some(f => f.getValue() !== state.initial[f.dot]);
	}

	function titleCase(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

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
			// A sentence in a bar that cannot wrap: on the picture it truncates
			// with the title carrying the rest, and below md dockRuntime moves
			// it off the picture entirely, where it has a line to itself.
			'<span class="mj-hud-chip mj-glass" id="mj-lightmon" hidden' +
			' title="Light monitor is driving night, IR-cut and the lamp">' +
			'<a href="camera.cgi?tab=nightMode">Light monitor is driving night, IR&#8209;cut and the lamp</a>' +
			'</span>';
	}

	// The bar does not wrap any more — wrapping took 42% of a 290px picture on a
	// 540px phone (#239) — so when it will not fit, the widest group moves off
	// the picture instead of stacking on top of more of it. The runtime toggles
	// are the ones that move: they are the widest, they are state rather than
	// player controls, and under the picture they get full-width touch targets
	// instead of being the thing that scrolls out of reach. What stays is the
	// player's own row — channel, compare, snapshot, fullscreen.
	//
	// MEASURED, not a breakpoint. The stage's width comes from the window's
	// HEIGHT as much as its width, and the bar holds a different set of controls
	// on different cameras — no substream, no lamp pin, the light-monitor
	// sentence instead of the three switches — so the width at which it stops
	// fitting is a property of this camera in this window, and no media query
	// knows it. Every child is flex:0 0 auto (see bootstrap.override.css), which
	// is what makes scrollWidth its natural width rather than its squeezed one.
	//
	// Relocation rather than two copies, the same way preview-ptz.js moves the
	// pad into the stage: one set of inputs means wireRuntime() keeps driving
	// the controls the person is looking at, whichever side of the picture edge
	// that is.
	function dockRuntime(preview, mount) {
		const stage = preview.stage;
		const bar = preview.bar;
		const gap = 8;
		const movable = () => [
			bar.querySelector('.mj-hud-rt') || mount.querySelector('.mj-hud-rt'),
			bar.querySelector('#mj-lightmon') || mount.querySelector('#mj-lightmon'),
		].filter(Boolean);

		const move = (to) => {
			movable().forEach(n => {
				if (n.parentNode === to) return;
				n.classList.toggle('mj-glass', to === bar);
				// Before the compare button, which is where it sits in the bar;
				// appended in the mount, which holds nothing else. By class and
				// not by id: the bar belongs to a component that can be mounted
				// more than once on a page, and an id would name the wrong one.
				if (to === bar) bar.insertBefore(n, bar.querySelector('.mj-live-compare'));
				else to.appendChild(n);
			});
		};

		const widthOf = (nodes) => nodes.reduce((w, n) => w + n.scrollWidth + gap, 0);

		// What the group costs the bar, remembered from the last time it was in
		// it. While it is docked its width cannot be measured — in the mount the
		// switches stretch to the full column — so this is the only figure there
		// is, and it is why undocking is decided on a remembered number rather
		// than a fresh one. If it has gone stale the next pass corrects it, and
		// the stage clips rather than reflows in the meantime.
		let cost = 0;
		let docked = false;
		let pending = false;

		const place = () => {
			pending = false;
			const room = bar.clientWidth;
			// A stage that has not been laid out yet answers 0 and would dock
			// everything; the observers below fire again with a real width.
			if (!room) return;
			const extras = movable();
			if (!docked) cost = widthOf(extras.filter(n => !n.hidden));
			const rest = [...bar.children].filter(n => !n.hidden && extras.indexOf(n) < 0);
			const need = rest.reduce((w, n) => w + n.scrollWidth, 0) +
				gap * Math.max(0, rest.length - 1) + cost;
			// Hysteresis, and it is load-bearing rather than polish: docking
			// adds a row under the picture, the stage's reserve grows to hold
			// it (.mj-live-docked) and the stage therefore NARROWS — so the
			// measurement that follows a dock is taken in less room than the one
			// that caused it. Without a band to come back through, a window
			// sitting exactly on the boundary would dock, narrow, undock, widen,
			// for as long as it was open.
			const want = docked ? need > room - 24 : need > room;
			// Nothing moves unless the answer changed. That is what makes the
			// mutation observer below safe: a pass that writes to the DOM would
			// wake it, and a pass woken by its own writes never stops.
			if (want === docked) return;
			move(want ? mount : bar);
			docked = want;
			mount.hidden = !want;
			stage.classList.toggle('mj-live-docked', want);
		};

		const later = () => {
			if (pending) return;
			pending = true;
			requestAnimationFrame(place);
		};

		place();

		// Two things change what the bar needs without changing the bar. The
		// snapshot and fullscreen buttons start hidden and are revealed only
		// once preview-hero.js knows the camera has jpeg.enabled and the browser
		// has the fullscreen API — that is +76px arriving a second late, and it
		// is what made a 1024x700 window measure as fitting and then overflow.
		// The brand font is the other: header.cgi loads it media="print" so a
		// camera with no internet still paints, and Montserrat is wider than the
		// system stack it replaces.
		let mo = null;
		if (window.MutationObserver) {
			mo = new MutationObserver(later);
			mo.observe(bar, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
		}
		if (document.fonts && document.fonts.ready) document.fonts.ready.then(later);

		// ResizeObserver on the bar rather than on the window: the bar's width
		// changes when the rail, the container or the stream's aspect ratio
		// changes, none of which is a window resize.
		let ro = null;
		if (window.ResizeObserver) {
			ro = new ResizeObserver(later);
			ro.observe(bar);
		} else {
			window.addEventListener('resize', later);
		}
		return () => {
			if (mo) mo.disconnect();
			if (ro) ro.disconnect();
			else window.removeEventListener('resize', later);
		};
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

		// Parked (nightMode.*Enabled: false) outranks wired: the daemon
		// refuses the toggle, so a live-looking switch would move and snap
		// back. Explicit === false — an absent key on an older daemon means
		// the switch does not exist there, not that it is off.
		const ircutParked =
			getDotted(state.config, 'nightMode.irCutEnabled') === false;
		const lightParked =
			getDotted(state.config, 'nightMode.backlightEnabled') === false;
		ircut.disabled = ircutParked ||
			!active(getDotted(state.config, 'nightMode.irCutPin1'));
		light.disabled = lightParked ||
			!active(getDotted(state.config, 'nightMode.backlightPin'));
		// A control that cannot work should say which pin is missing — or that
		// the actuator is deliberately parked — rather than just refusing.
		if (ircut.disabled && lbl('toggle-ircut'))
			lbl('toggle-ircut').title = ircutParked
				? 'The IR-cut filter is switched off in Day / Night settings; its wiring is kept.'
				: 'Nothing is connected to the IR-cut filter.';
		if (light.disabled && lbl('toggle-light'))
			lbl('toggle-light').title = lightParked
				? 'The lamp is switched off in Day / Night settings; its wiring is kept.'
				: 'Nothing is connected to the night illuminator.';

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
				'<a href="camera.cgi?tab=' + esc(sec) + '">' + esc(label(sec)) + '</a>.';
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
	function renderLuma(container, preview) {
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
			// Whichever element the stage currently has a picture on. It was a
			// scan of four document ids here, which is the same fact the stage
			// already knows and the reason it could only ever be mounted once;
			// media() is that scan, kept where the slots are — including the
			// part that makes it honest, that a canvas is only offered once the
			// player has marked it painted, so a histogram measures UNKNOWN
			// rather than black while the picture is merely starting.
			video: () => preview.media(),
			// So an off-thread readback that began on the channel just left is
			// dropped rather than published as the current one — see mj-luma.js.
			token: () => preview.generation(),
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

		// The only place the leaf names itself — the rail's active item says it
		// too. The stream picker used to share this line; it is on the picture
		// now, and the picture is mj-preview.js's, so what is left here is the
		// heading and its rule.
		//
		// An <h3> despite the micro-caps styling, and not a <span>: revealSection()
		// focuses `form h3` after a navigation so the section announces itself to
		// a screen reader (#222). Every other leaf has one; styling this like a
		// group label must not cost the Live leaf its heading.
		const head = el('div', 'mj-live-head');
		head.innerHTML =
			'<h3 class="mj-cap">Live adjustments</h3>' +
			'<span class="mj-live-rule"></span>';
		form.appendChild(head);

		// The picture, on the transport with the least lag — which is the
		// stage's own default and is deliberately not overridden here.
		//
		// This is the one panel where latency IS the feature: someone is
		// dragging a saturation slider and watching for the effect, and MSE is
		// about a second behind where WebRTC is not. The earlier reasoning for
		// pinning this panel to MSE — that a WebRTC viewer joins the encoder's
		// bitrate loop and would disturb a judgement about image quality — does
		// not survive looking at what the panel actually offers: brightness,
		// contrast, saturation, hue, mirror and flip are ISP knobs, nothing here
		// judges an encoder setting, and whoever is tuning videoN.bitrate is on
		// another section with no preview at all.
		//
		// Null when the player stack is not on the page — an older install, a
		// half-finished deploy. Everything below is written to survive that,
		// because the knobs write to the camera whether or not there is a
		// picture to judge them by: missing scripts should cost the preview,
		// not the controls. It used to be an inline check of the same three
		// globals, which mount() now makes on the caller's behalf.
		const preview = window.MajesticPreview &&
			window.MajesticPreview.mount(form, {
				// A getter, not state.config itself: a save re-fetches the
				// config, and the channel picker should notice a substream
				// that has just been enabled without re-mounting the picture.
				config: () => state.config,
				// This panel's own remembered channel, not the Live View
				// page's: the two are looked at for different reasons and can
				// reasonably want different channels.
				where: 'live',
			});
		state.preview = preview;

		if (preview) {
			// The runtime toggles and hold-to-compare are this leaf's, not the
			// stage's — one is camera state that never reaches Save, the other
			// is about the x-live knobs below — so they are handed to the bar
			// rather than built into it. They land to the left of the snapshot
			// and fullscreen icons, which is where they were.
			const holder = el('div');
			holder.innerHTML = runtimeHtml();
			Array.prototype.slice.call(holder.children)
				.forEach(n => preview.barInsert(n));

			// The label is dropped below md (the bar does not wrap, and at
			// 390px it was the one thing that did not fit), so the title has to
			// carry it there — same trade the snapshot and fullscreen icons
			// make.
			const cmp = el('button', 'mj-hud-btn mj-glass mj-live-compare');
			cmp.type = 'button';
			cmp.title = 'Hold to compare';
			cmp.setAttribute('aria-label', 'Hold to compare');
			cmp.innerHTML = ICON.compare + '<span>Hold to compare</span>';
			preview.barInsert(cmp);

			// Before dockRuntime, which MOVES these same nodes rather than
			// making a second set of them: both of these capture the nodes they
			// wire, so wiring them while they are still in the bar is what keeps
			// working after they have been docked under the picture.
			wireRuntime(preview.stage);
			wireCompare(cmp);

			const rtMount = el('div', 'mj-live-rt-mount');
			form.appendChild(rtMount);
			state.liveCleanup.push(dockRuntime(preview, rtMount));

			const note = el('p', 'mj-live-hint');
			note.textContent = 'Night, IR-cut and the lamp are runtime state: pressing one changes ' +
				'the camera for every viewer immediately, and none of them is part of Save.';
			form.appendChild(note);
		}

		// The pad replaces the two switches only when BOTH halves of it are
		// there. A build that marks just one of them x-live — or that marks some
		// other boolean x-live — keeps the switch it has always had.
		const mirror = fields.find(f => f.key === 'mirror' && f.sub.type === 'boolean');
		const flip = fields.find(f => f.key === 'flip' && f.sub.type === 'boolean');
		const useGeo = !!(mirror && flip);
		// The strip is for knobs, so it is integers that decide whether there is
		// one. A build that marks only booleans x-live has no strip and loses
		// nothing: they render in the row below, where a switch has room to be a
		// switch rather than a fifth cell of a four-cell instrument.
		const hasTone = fields.some(f => f.sub.type === 'integer');

		// Out here rather than beside the stage: the knobs write to the camera
		// whether or not the player scripts loaded, so the promise to put it
		// back is not the picture's to keep.
		state.liveCleanup.push(wireUnloadRevert());

		// The deck is now two cards, not one. The first is the knob strip: the
		// Tone rows laid ACROSS it, directly under the picture, with nothing
		// between. Four rows stacked cost 186px and the strip costs 76, and that
		// difference is what the picture grew by — the reserve in
		// bootstrap.override.css holds room for this strip and nothing else, so
		// the guarantee stays "a knob and the effect it has, together" while the
		// picture takes everything left over (#239).
		const strip = el('div', 'mj-live-strip');
		if (hasTone) form.appendChild(strip);

		// The second card carries what is worth having but not worth the
		// picture's height: Scene, Luma and Orientation, side by side rather
		// than as the 405px two-column block they used to make. Shallow enough
		// that on a 1080p window the whole panel is on screen again.
		const deck = el('div', 'mj-live-deck');
		const colScene = el('div', 'mj-live-col mj-live-col-scene');
		const colLuma = el('div', 'mj-live-col');
		const colGeo = el('div', 'mj-live-col mj-live-col-geo');
		deck.appendChild(colScene);
		deck.appendChild(colLuma);
		deck.appendChild(colGeo);
		form.appendChild(deck);

		for (const f of fields) {
			const geoField = useGeo && (f === mirror || f === flip);
			// The geometry checkboxes stay real fields — hidden — beside the pad
			// that replaces them, so Save and dirty tracking never learn any of
			// this happened.
			const box = (!geoField && f.sub.type === 'integer') ? strip : colGeo;
			const field = renderField(box, f.dot, f.key, f.sub,
				getDotted(state.config, f.dot), { live: true, hidden: geoField });
			if (!field) continue;
			state.fields.push(field);
			state.initial[f.dot] = field.getValue();
		}

		// Last cell of the strip rather than a footer under it: a footer would
		// be another line between the picture and the row below, and this is a
		// control that belongs to the four beside it.
		if (hasTone) {
			const foot = el('div', 'mj-live-strip-foot');
			const rall = el('button', 'mj-live-linkbtn');
			rall.type = 'button';
			rall.innerHTML = ICON.reset + '<span>Stock</span>';
			rall.title = 'Reset all four to their factory defaults';
			rall.addEventListener('click', resetLiveAll);
			foot.appendChild(rall);
			strip.appendChild(foot);
		}

		const toneFields = state.fields.filter(f =>
			f.schema && f.schema['x-live'] && f.type === 'integer');
		if (hasTone && toneFields.length) {
			renderScene(liveGroup(colScene, 'Scene', 'starting points'), toneFields);
		}

		if (preview) {
			// The group's note slot carries the running mean rather than a
			// caption — a number that changes is worth more there than a word
			// that does not.
			const lumaBody = liveGroup(colLuma, 'Luma', 'mean —');
			const note = lumaBody.parentNode.querySelector('.mj-live-note');
			if (note) note.className = 'mj-live-note mj-luma-mean';
			renderLuma(lumaBody, preview);
		}

		if (useGeo) {
			const mf = state.fields.find(f => f.dot === mirror.dot);
			const ff = state.fields.find(f => f.dot === flip.dot);
			if (mf && ff) renderGeometry(liveGroup(colGeo, 'Orientation', ''), mf, ff);
		}

		// Every group above is conditional — on the schema, and on which player
		// scripts loaded — so an empty column is reachable rather than
		// hypothetical: without the player there is no Luma, and a build that
		// marks only one of mirror/flip x-live has no Orientation either. A cell
		// is a fixed width with a divider whether or not anything is in it, so
		// an empty one would squeeze its neighbours and add a blank section once
		// stacked. Drop whatever came out empty instead of enumerating the
		// combinations. colGeo is judged on what is VISIBLE in it: with the pad
		// mounted it holds the two hidden checkboxes as well, and without the
		// pad it may hold nothing but them — a cell that renders as a divider
		// and 15rem of nothing.
		if (!colGeo.querySelector('.mj-live-grp, .mj-live-row:not([hidden])')) {
			// The hidden fields go with it. They are detached, not destroyed:
			// state.fields still holds them, and getValue()/Save read the
			// control, which does not care whether it is in the document.
			colGeo.remove();
		}
		[colScene, colLuma].forEach(c => { if (!c.childElementCount) c.remove(); });
		if (!deck.childElementCount) deck.remove();
		if (hasTone && !strip.querySelector('.mj-live-row')) strip.remove();
	}

	// ── The Motion detection leaf ─────────────────────────────────────────
	//
	// One page where there were two. Motion detection carried the four settings
	// and a separate "Visual editor" leaf carried the regions — drawn on a STILL
	// /image.jpg inside an iframe (www/m/img.html), which blocked on its own
	// synchronous fetch of a config the parent already had, never refreshed, and
	// showed nothing at all on a camera with the JPEG channel off. The regions
	// are the shape of what the settings beside them do, so splitting them
	// across two rail entries asked people to hold one in their head while
	// looking at the other.
	//
	// It is laid out as the Live adjustments leaf is, because it is the same
	// kind of page: a picture you change things against. Head, then the picture,
	// then the strip for the one knob worth dragging while you watch, then the
	// deck. And it keeps that leaf's rule about what may sit on the glass —
	// RUNTIME on the picture, CONFIGURATION in the form. All four motionDetect
	// fields go through Save, so none of them is a lit toggle on the bar; the
	// only thing added there is Draw regions, which is a tool rather than a
	// setting, exactly as Zoom to an area is on the Live View page.
	function renderMotion(form) {
		const fields = sectionFields('motionDetect');

		const head = el('div', 'mj-live-head');
		head.innerHTML = '<h3 class="mj-cap">' + esc(label('motionDetect')) + '</h3>' +
			'<span class="mj-live-rule"></span>';
		const note = el('span', 'mj-live-note');
		head.appendChild(note);
		form.appendChild(head);

		// The frame size arrives a beat after the picture does (it comes from
		// the player's codec event), and every rectangle's geometry depends on
		// it — so the overlay has to be repainted when it lands rather than
		// drawn once at mount. Assigned below; a no-op until then.
		let repaint = () => {};
		const preview = window.MajesticPreview &&
			window.MajesticPreview.mount(form, {
				config: () => state.config,
				// Its own remembered channel. Regions are judged against the
				// whole field of view, and the sub stream is the cheaper way to
				// look at it — but this is not the Live leaf's question and does
				// not share its answer.
				where: 'motion',
				onFrame: () => repaint(),
			});
		state.preview = preview;

		const sens = fields.find(f => f.key === 'sensitivity' &&
			f.sub.type === 'integer' && isNum(f.sub.maximum));
		const strip = el('div', 'mj-live-strip');
		if (sens) form.appendChild(strip);

		const deck = el('div', 'mj-live-deck');
		const colRegions = el('div', 'mj-live-col');
		const colDetect = el('div', 'mj-live-col mj-live-col-b');
		deck.appendChild(colRegions);
		deck.appendChild(colDetect);
		form.appendChild(deck);

		// Seeded with the count it will carry rather than with '': liveGroup only
		// builds the note span when there is something to put in it, so an empty
		// string here leaves paint() with nowhere to write and the count silently
		// never appears.
		const regionBody = liveGroup(colRegions, 'Regions', 'none');
		const regionNote = colRegions.querySelector('.mj-live-grp-head .mj-live-note');
		const detectBody = liveGroup(colDetect, 'Detection', '');

		// The regions field renders HIDDEN rather than not at all — the same
		// pattern the nightMode pin map uses. It stays a real field, so dirty
		// tracking, Save and the per-row reset keep working on it without
		// knowing an editor exists, and a camera where the editor cannot mount
		// (no player scripts, no readable frame size) gets its plain list of
		// coordinate boxes back instead of losing the setting.
		let roiField = null;
		for (const f of fields) {
			const isRoi = f.dot === ROI_DOT;
			const box = f === sens ? strip : (isRoi ? regionBody : detectBody);
			const opt = isRoi ? { hidden: true } : (f === sens ? { live: true } : undefined);
			const field = renderField(box, f.dot, f.key, f.sub,
				getDotted(state.config, f.dot), opt);
			if (!field) continue;
			state.fields.push(field);
			state.initial[f.dot] = field.getValue();
			if (isRoi) roiField = field;
		}

		// The strip's last cell, as on the Live leaf: a control that belongs to
		// the knob beside it rather than a footer under it.
		if (sens) {
			const foot = el('div', 'mj-live-strip-foot');
			const rall = el('button', 'mj-live-linkbtn');
			rall.type = 'button';
			rall.innerHTML = ICON.reset + '<span>Stock</span>';
			rall.title = 'Reset sensitivity to its factory default';
			rall.addEventListener('click', () => {
				const f = state.fields.find(x => x.dot === 'motionDetect.sensitivity');
				if (f && isNum(sens.sub.default)) { f.setValue(sens.sub.default); updateDirty(); }
			});
			foot.appendChild(rall);
			strip.appendChild(foot);
			if (!strip.querySelector('.mj-live-row')) strip.remove();
		}

		if (roiField && preview && window.MajesticRegion) {
			repaint = mountRegions(preview, roiField, regionBody, regionNote).repaint;
			// The field's own reset, MOVED into the group head rather than made
			// again — the same relocation dockRuntime does with the runtime
			// toggles, and for the same reason: one control, with its real
			// handler and its real disabled-when-there-is-no-default state.
			//
			// Hiding the row hid this with it, and nothing else on the page can
			// do what it does. "Clear all" stages an empty list for the next
			// Save; this asks the camera to put the key back to unconfigured,
			// which is a different state and the only way to recover a recorded
			// default that is not empty.
			const rst = roiField.p.querySelector('.mj-reset');
			const gh = colRegions.querySelector('.mj-live-grp-head');
			if (rst && gh) gh.appendChild(rst);
		} else if (roiField) {
			// Nothing to draw on, or nothing to judge the drawing with: say
			// which, rather than leaving the coordinate boxes to be explained by
			// nothing — or explained by the wrong half, which is what naming the
			// preview would do on a camera whose preview came up fine.
			roiField.p.hidden = false;
			const p = el('p', 'mj-live-hint');
			p.textContent = (preview ? 'The region editor could not be loaded'
				: 'The preview could not be loaded') +
				', so regions can only be given as coordinates here.';
			regionBody.appendChild(p);
		}

		// What the page is doing right now, in the head's own note slot. A
		// camera with detection off keeps every region and the sensitivity it
		// was given — and uses none of them, which is worth a sentence where
		// somebody is about to spend time drawing.
		const enabled = state.fields.find(f => f.dot === 'motionDetect.enabled');
		const paintNote = () => {
			const off = enabled && enabled.getValue() === 'false';
			note.textContent = off
				? 'Detection is off — regions and sensitivity are saved, not used.'
				: '';
			note.classList.toggle('mj-md-warn', !!off);
		};
		if (enabled) {
			enabled.control.addEventListener('change', paintNote);
			state.liveSync.push(paintNote);
		}
		paintNote();
	}

	// The region editor: rectangles on the picture, the list beside it, and one
	// mode that turns a drag into a new region.
	//
	// Returns its repaint function, which renderMotion hands to the stage's
	// onFrame — the geometry below cannot be computed until a frame has said how
	// big it is.
	// `words` is the whole of what differs between the two callers. Motion
	// regions say where to watch; privacy masks are burned into the stream. Same
	// control, different sentence beside it — sharing the sentence would be the
	// one thing that must not be shared.
	//
	// `words.gated` says the caller decides when a drag draws (the Overlay leaf
	// has two things you can place on one picture, so it owns that choice); the
	// Motion leaf leaves it ungated and the picture is drawable throughout.
	function mountRegions(preview, field, listBox, noteEl, words) {
		words = words || {};
		const W = {
			one: words.one || '1 region',
			many: words.many || ' regions',
			draw: words.draw || 'Draw regions',
			drawHint: words.drawHint || 'Drag a rectangle on the picture',
			empty: words.empty ||
				'No regions — the whole picture is watched. Drag one on the picture to watch part of it instead.',
			clearAsk: words.clearAsk ||
				'Remove every region? The whole picture will be watched.',
			clearLabel: words.clearLabel || 'Clear all',
			base: words.base ||
				'Regions are stored in the main stream’s pixels, and this camera has ' +
				'no main resolution set. Switch the picture to Main to draw them.',
			// The singular noun the row verdicts build their sentences from,
			// and the two things a rectangle the camera cannot use is failing
			// to do. Kept as words rather than as a boolean, because "watches"
			// and "hides" are not the same promise and the whole reason these
			// two callers share a control is that only the sentences differ.
			thing: words.thing || 'region',
			deadSome: words.deadSome ||
				'A region with no area, or one outside the picture, is saved but never watched.',
			deadAll: words.deadAll ||
				'None of these regions watches anything, so nothing will be detected: ' +
				'detection is limited to the regions listed and does not fall back to ' +
				'the whole picture.',
			space: words.space || 'Coordinates are main-stream pixels',
		};
		// Ungated callers are always live; a gated one starts off and is turned
		// on by the caller's own mode control.
		let active = !words.gated;
		const ctl = field.control;

		// ── coordinates ───────────────────────────────────────────────────
		//
		// Regions are stored in the MAIN stream's pixels, which is what
		// majestic.yaml holds and what the old editor computed against
		// video0.size. The picture on screen may be the sub stream — a different
		// resolution of the same field of view — so the mapping goes through
		// fractions of the frame rather than through either size directly.
		//
		// video0.size can also be unset, meaning "sensor native", which the
		// config does not spell out. Then the only honest base is the frame
		// itself, and only while the frame IS the main stream; on the sub
		// stream there is nothing to scale by and the editor says so instead of
		// drawing rectangles in the wrong places.
		function base() {
			const cfg = parseWH(getDotted(state.config, 'video0.size'));
			if (cfg) return cfg;
			const f = preview.frame();
			return (f && preview.stream() === 0) ? { w: f.w, h: f.h } : null;
		}

		// Where the picture actually is inside the stage. object-fit: contain
		// letterboxes anything that is not the stage's 16/9, and a rectangle
		// drawn against the stage rather than against the picture would sit off
		// the scene by the size of the letterbox.
		function pic() {
			const f = preview.frame();
			const w = preview.stage.clientWidth, h = preview.stage.clientHeight;
			if (!f || !f.w || !f.h || !w || !h) return null;
			const s = Math.min(w / f.w, h / f.h);
			return { x: (w - f.w * s) / 2, y: (h - f.h * s) / 2, w: f.w * s, h: f.h * s };
		}

		// The geometry verdicts live in mj-region.js, away from the DOM, because
		// every branch of them renders a confident-looking chip and only a
		// camera at a particular resolution reaches most of them. What is left
		// here is where the answers are put on screen.
		const RGN = window.MajesticRegion;
		const parse = RGN.parse;
		// The verdict's class in the module's own vocabulary, dressed here:
		// the module has no idea what this page's stylesheet calls things.
		const CLS = { bad: 'mj-md-bad', ok: 'mj-md-pct' };
		// The underlying inputs, empties INCLUDED — _rows() drops those, and an
		// empty row is exactly the one somebody is about to type coordinates
		// into. Read from the DOM rather than kept alongside it: the field's
		// rows are the model, and a second copy is a thing to keep in step.
		const inputs = () => Array.prototype.slice.call(
			ctl.querySelectorAll('.mj-array-row input'));
		const list = () => inputs().map(i => i.value.trim());

		// Declared below list() rather than beside the other geometry helpers:
		// it reads one, and a const read from above its own declaration is the
		// temporal dead zone this file has already been bitten by once.
		const tally = () => RGN.tally(list(), base(), W.thing);

		// ── the layers ────────────────────────────────────────────────────
		//
		// Order matters and is the whole of the hit-testing rule: the catcher is
		// BENEATH the regions, so a press on empty picture draws a new one and a
		// press on a region edits that region. Nothing has to ask "did I hit
		// something" — the DOM already answered.
		const catcher = el('div', 'mj-md-catch');
		preview.overlay.appendChild(catcher);

		const layer = el('div', 'mj-md-layer');
		preview.overlay.appendChild(layer);

		// The overlay is pointer-transparent by design, so the picture keeps its
		// own gestures; this is the child that takes the pointer back.
		//
		// It is ALWAYS live, not only while the button is armed, and that is the
		// other half of mirroring zoom-to-area. On the Live View page a drag
		// draws whenever the picture is not pannable — `armed ||
		// stage.classList.contains('mj-drawable')` — and it is the Area button
		// that exists for the case where a bare drag would pan instead. This
		// stage never pans: nothing here zooms it, so a drag on it has nothing
		// else it could mean, which is exactly the drawable state. Requiring the
		// button first was a control standing in front of a gesture that had
		// nothing to compete with.
		// The rubber band, mirroring the Live View page's #mj-marquee exactly:
		// ONE element, hidden between drags, whose 9999px shadow spread dims
		// everything outside the rectangle rather than four elements fenced
		// around it. The stage's overflow trims the spread, and the bar sits
		// above the overlay so the controls stay lit while the picture dims.
		const band = el('div', 'mj-md-band');
		band.hidden = true;
		preview.overlay.appendChild(band);

		// A gated caller drives the picture from its own control, so this one
		// would be a second switch for the same thing.
		const btn = el('button', 'mj-hud-btn mj-glass mj-md-draw');
		btn.type = 'button';
		btn.innerHTML = ICON.draw + '<span>' + esc(W.draw) + '</span>';
		btn.title = W.draw;
		if (!words.gated) preview.barInsert(btn);

		let armed = false;
		// Which region is selected, by index, or -1. A drawn region is worth
		// nothing if it cannot be adjusted afterwards, and the only thing that
		// can carry handles and a delete button is the one you have picked.
		let sel = -1;
		// The gesture in flight: drawing a new region, moving one, or resizing
		// one by an edge. All three are a pointer down, some movement and a
		// release, so they share the machinery and differ only in what they do
		// with the delta.
		let gesture = null;
		// Per-row handles from the last paint(), so a move can write the numbers
		// into the row as they change rather than after the fact.
		let rowRefs = [];

		// The eight grips, as [name, x-anchor, y-anchor] where the anchors say
		// which edges that grip moves. Corners move two, edges move one.
		const GRIPS = [
			['nw', 'x', 'y'], ['n', '', 'y'], ['ne', 'r', 'y'],
			['w', 'x', ''], ['e', 'r', ''],
			['sw', 'x', 'b'], ['s', '', 'b'], ['se', 'r', 'b'],
		];
		// Never smaller than this in the stream's own pixels. A region that has
		// been dragged to nothing is not a region, and it would be invisible on
		// the picture and so impossible to grab back.
		const MIN_PX = 16;

		// ── painting ──────────────────────────────────────────────────────
		//
		// Declared before paint() rather than after it: paint is hoisted and the
		// boxes are not, so a call added above them later would fail on a name
		// that reads as though it is in scope.
		const view = el('div', 'mj-md-list');
		const warn = el('p', 'mj-live-hint mj-md-warn');
		warn.hidden = true;
		// What an unusable rectangle costs, under the list rather than in the
		// row: the row says WHICH one, this says what happens because of it,
		// and the sentence changes when every one of them is unusable — that is
		// the case the reporter of #330 was in, and it is the only one where a
		// mistyped region turns the whole feature off.
		const dead = el('p', 'mj-live-hint mj-md-warn');
		dead.hidden = true;
		// The coordinate space, stated once. The editor knew it all along and
		// never said it, so the numbers in these boxes were the only ones on
		// the page with no scale printed anywhere near them.
		const space = el('p', 'mj-live-hint mj-md-space');
		space.hidden = true;
		listBox.appendChild(view);
		listBox.appendChild(warn);
		listBox.appendChild(dead);
		listBox.appendChild(space);

		// The head's count and the two lines under the list. Called from paint()
		// and from every keystroke in a coordinate box: the count used to be
		// written only by the full paint, so it lagged one row behind the list
		// beside it — three rows on screen under a head that said "2 regions".
		function paintTally() {
			const t = tally(), b = base();
			if (noteEl) {
				noteEl.textContent = !t.n ? 'none'
					: (t.n === 1 ? W.one : t.n + W.many) +
						(t.bad ? ' · ' + t.bad + ' unusable' : '');
				noteEl.classList.toggle('mj-md-warn', t.bad > 0);
			}
			dead.textContent = !t.bad ? ''
				: (t.bad === t.n ? W.deadAll : W.deadSome);
			dead.hidden = !t.bad;
			space.textContent = b ? W.space + ' — ' + b.w + ' × ' + b.h + '.' : '';
			space.hidden = !b || !t.n;
		}

		// The rectangles alone. Split out because typing in a coordinate box has
		// to move its rectangle without rebuilding the box being typed into.
		function paintBoxes() {
			const p = pic(), b = base();
			layer.innerHTML = '';
			if (!p || !b) return;
			list().forEach((raw, i) => {
				const r = parse(raw);
				if (!r) return;
				const box = el('div', 'mj-md-rgn' + (i === sel ? ' mj-md-sel' : ''));
				box.dataset.i = String(i);
				box.style.left = (p.x + r.x / b.w * p.w) + 'px';
				box.style.top = (p.y + r.y / b.h * p.h) + 'px';
				box.style.width = (r.w / b.w * p.w) + 'px';
				box.style.height = (r.h / b.h * p.h) + 'px';
				const n = el('span', 'mj-md-rgn-n');
				n.textContent = String(i + 1);
				box.appendChild(n);
				// Grips and the delete button only on the selected one. Eight
				// grips on every region at once is a picture of controls rather
				// than a picture of what the camera is watching.
				if (i === sel) {
					GRIPS.forEach(([name]) => {
						const g = el('span', 'mj-md-h mj-md-h-' + name);
						g.dataset.grip = name;
						box.appendChild(g);
					});
					const x = el('button', 'mj-md-x');
					x.type = 'button';
					x.dataset.del = String(i);
					x.innerHTML = '&times;';
					x.title = 'Remove region ' + (i + 1);
					x.setAttribute('aria-label', 'Remove region ' + (i + 1));
					box.appendChild(x);
				}
				layer.appendChild(box);
			});
		}

		function paint() {
			const p = pic(), b = base();
			paintBoxes();
			const rows = list();

			// A selection that outlived its row would put handles on somebody
			// else's rectangle: deleting region 2 of 3 renumbers the third.
			if (sel >= rows.length) sel = -1;
			paintTally();

			// The list beside the picture is a VIEW of the field, rebuilt from
			// it, never a second copy kept in step by hand: the hidden field is
			// the only model, and every edit below goes back through it.
			view.innerHTML = '';
			// The old rows are about to be detached; anything still holding one
			// would be writing a dragged coordinate into a node nobody can see.
			rowRefs = [];
			if (!rows.length) {
				const empty = el('p', 'mj-live-hint mj-md-empty');
				// Says the gesture, because the gesture is the only thing there
				// is to find: with nothing drawn there is no rectangle on the
				// picture to suggest that rectangles are what this page is for.
				empty.textContent = W.empty;
				view.appendChild(empty);
			}

			rows.forEach((raw, i) => {
				const r = parse(raw);

				const row = el('div', 'mj-md-row');
				const chip = el('span', 'mj-md-chip');
				chip.textContent = String(i + 1);
				// An input, not a label. Typing coordinates is how this setting
				// has always been editable, and hiding the field that used to
				// carry them would have quietly taken that away — an installer
				// working from a spec has numbers, not a mouse.
				const co = el('input', 'mj-md-co');
				co.type = 'text';
				co.value = raw;
				co.placeholder = 'XxYxWxH';
				co.setAttribute('aria-label', 'Region ' + (i + 1) + ' coordinates');
				co.addEventListener('input', () => {
					const src = inputs()[i];
					if (src) src.value = co.value;
					updateDirty();
					// Only the rectangles and this row's own verdict. Repainting
					// the whole list would rebuild the input being typed into
					// and take the caret with it — but repainting NOTHING but
					// the rectangles left the verdict behind, so a corrected
					// value still read "not XxYxWxH" and a resized one still
					// showed the share of the frame it used to have. Both are
					// the row saying something about text that is no longer in
					// it. The head's count and the lines under the list are
					// derived from the same verdicts, so they move with the
					// keystroke too — everything except the list itself, which
					// is what holds the caret.
					says(parse(co.value));
					paintTally();
					paintBoxes();
				});
				const del = el('button', 'mj-md-del');
				del.type = 'button';
				del.innerHTML = '&times;';
				del.title = 'Remove region ' + (i + 1);
				del.setAttribute('aria-label', 'Remove region ' + (i + 1));
				del.addEventListener('click', () => removeAt(i));
				row.appendChild(chip);
				row.appendChild(co);

				// What this row makes of its own text. A region whose numbers do
				// not parse is the one thing the old editor could not show at
				// all — it drew what it understood and left the rest to be a
				// silently missing rectangle — so it is said here, beside the
				// box you would fix it in. Built once and rewritten in place,
				// because it has to keep up with typing.
				const vd = el('span', 'mj-md-pct');
				vd.title = 'share of the frame';
				row.appendChild(vd);
				const says = (rr) => {
					const v = RGN.verdict(rr, b, W.thing);
					vd.className = CLS[v.cls];
					vd.textContent = v.text;
					if (v.title) vd.title = v.title;
					else vd.removeAttribute('title');
				};
				says(r);
				row.appendChild(del);
				view.appendChild(row);

				// The pairing is the point of the merge: the row and the
				// rectangle are the same region, so hovering either says so.
				// By index rather than by a captured node — paintBoxes() rebuilds
				// them on every keystroke, and a held reference would be stale
				// by the second character.
				const lit = (on) => {
					const box = layer.querySelector('[data-i="' + i + '"]');
					if (box) box.classList.toggle('mj-md-on', on);
				};
				row.addEventListener('mouseenter', () => lit(true));
				row.addEventListener('mouseleave', () => lit(false));
				// The pairing goes both ways: picking a row picks its rectangle,
				// so the handles appear on the one you are reading the numbers
				// of. Not from the coordinate box — clicking into that is how
				// you edit the text, and it must not also move the picture.
				row.addEventListener('click', (ev) => {
					if (ev.target.closest('input, button')) return;
					select(i);
				});
				rowRefs[i] = { co: co, says: says };
			});

			// A rectangle needs two things to be placed: the size of the frame on
			// screen, and the size the coordinates are written in. Neither is
			// known at mount — the frame size arrives from the player's codec
			// event, which on WebRTC is the 1s getStats poll, well after the
			// video element reports it can play.
			//
			// So the tool is DISABLED until they are, rather than left pressable
			// over a picture that cannot yet take a drag. That second is easy to
			// be inside: press Draw the moment the picture appears, drag, and
			// the old shape of this code silently did nothing and said nothing —
			// the exact failure the rest of this page is written to avoid. Only
			// the base problem is worth a printed line; waiting for a frame
			// resolves itself and would be a warning that flashes.
			const noBase = !!p && !b;
			warn.textContent = noBase ? W.base : '';
			warn.hidden = !noBase;
			const usable = !!p && !noBase && active;
			btn.disabled = !usable;
			btn.title = noBase ? W.base
				: (!p ? 'Waiting for the picture' : W.drawHint);
			// The crosshair is the disclosure that a bare drag does something,
			// so it tracks whether a drag CAN do something rather than whether
			// the button has been pressed. On the stage as well as the media, so
			// it reads the same over the letterbox.
			preview.stage.classList.toggle('mj-md-armed', usable);
			catcher.hidden = !usable;
			// Nothing left to draw on, so the button cannot stay lit: it would
			// promise a drag that now does nothing.
			if (!usable && armed) setArmed(false);
		}

		// Clear-all, beside the field's own "+ Add region" — the two ways of
		// editing the list that are not the picture.
		const foot = el('div', 'mj-md-foot');
		const byNum = el('button', 'mj-live-linkbtn');
		byNum.type = 'button';
		byNum.innerHTML = ICON.plus + '<span>Add by coordinates</span>';
		byNum.title = 'Add an empty region to type numbers into';
		byNum.addEventListener('click', () => {
			ctl._add('');
			const boxes = view.querySelectorAll('.mj-md-co');
			const last = boxes[boxes.length - 1];
			if (last) last.focus();
		});
		foot.appendChild(byNum);
		const clear = el('button', 'mj-live-linkbtn');
		clear.type = 'button';
		clear.innerHTML = ICON.trash + '<span>' + esc(W.clearLabel) + '</span>';
		clear.addEventListener('click', () => {
			if (!list().length) return;
			if (!confirm(W.clearAsk)) return;
			field.setValue('');
			updateDirty();
		});
		foot.appendChild(clear);
		listBox.appendChild(foot);

		// Whatever moves the list — typing in a box, the field's own Add, a
		// per-row reset, refresh() after a save — repaints both halves.
		ctl._sync = paint;

		// ── the mode ──────────────────────────────────────────────────────
		// `armed` is now only the button's own lit state. The drag does not need
		// it — see the catcher above — so this is a highlight and a shortcut for
		// somebody who came looking for a control, not a gate.
		function setArmed(on) {
			armed = !!on;
			// Deliberately does NOT clear `gesture`: dropping one without
			// putting back what it had already written is exactly the bug
			// cancelGesture() exists for. The gesture's own lifecycle owns it.
			band.hidden = true;
			btn.classList.toggle('mj-hud-on', armed);
			btn.setAttribute('aria-pressed', armed ? 'true' : 'false');
			paint();
		}
		btn.addEventListener('click', () => setArmed(!armed));

		// Document-level, because the pointer is wherever the last click left
		// it — and taken off again in the teardown below, or Escape keeps being
		// swallowed from another section entirely.
		const onKey = (e) => {
			// Never while somebody is typing. Backspace in a coordinate box is
			// how you correct a number, and taking the region away instead would
			// be the worst possible reading of it.
			const t = e.target;
			const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' ||
				t.isContentEditable);
			if (e.key === 'Escape') {
				// Everything transient, in one press. Ordering these — selection
				// first, then the tool — meant a lit button survived an Escape
				// that had a selection to clear, so the key looked like it had
				// done nothing. There is no reading of Escape under which some
				// of the temporary state should stay.
				if (sel < 0 && !armed && !gesture) return;
				e.preventDefault();
				// The drag first, and restoring rather than dropping it: by now
				// it has already written a half-finished rectangle into the row.
				cancelGesture();
				select(-1);
				setArmed(false);
				return;
			}
			if ((e.key === 'Delete' || e.key === 'Backspace') && sel >= 0 && !typing) {
				e.preventDefault();
				removeAt(sel);
			}
		};
		document.addEventListener('keydown', onKey);

		// ── drawing, and editing what was drawn ───────────────────────────
		//
		// Three gestures over one machine, because they are the same gesture with
		// different arithmetic: press, move, release. Which one you get is decided
		// by what was under the pointer, which is why the catcher sits beneath the
		// regions — empty picture draws, a region moves, a grip resizes.
		//
		// Drawing is the Live View page's zoom-to-area (preview-zoom.js) and the
		// parts that look like detail are the parts that make it cost one drag.

		const at = (e) => {
			const r = preview.overlay.getBoundingClientRect();
			return { x: e.clientX - r.left, y: e.clientY - r.top };
		};

		// Stage pixels to the stream's own, and back. Everything below works in
		// STREAM pixels once the gesture starts, so a region cannot drift by a
		// rounding step per pointermove the way it would if each move re-read the
		// rectangle it had just written.
		const toStream = (dx, dy, p, b) => ({
			dx: dx / p.w * b.w,
			dy: dy / p.h * b.h,
		});

		// Both ends held inside the PICTURE, so the band shows exactly what will be
		// stored — and a drag that never leaves the letterbox collapses to nothing,
		// which the minimum size then throws away. Clamping only at the end, as
		// this did first, draws a rectangle over the black and stores a smaller
		// one: the band was a promise the result broke.
		function bandRect(e) {
			// Null mid-drag is reachable: a channel change or a dead chain forgets
			// the frame while a pointer is down. Throwing here would take the
			// handler with it — capture never released, the gesture never ended.
			const p = pic();
			if (!p || !gesture) return null;
			const cx = (v) => Math.min(Math.max(v, p.x), p.x + p.w);
			const cy = (v) => Math.min(Math.max(v, p.y), p.y + p.h);
			const n = at(e);
			const x = cx(n.x), y = cy(n.y);
			const x0 = cx(gesture.from.x), y0 = cy(gesture.from.y);
			return {
				x: Math.min(x0, x), y: Math.min(y0, y),
				w: Math.abs(x - x0), h: Math.abs(y - y0),
			};
		}

		// Write a region back, live. The row's own box shows the numbers changing
		// under the drag, because those numbers ARE the thing being edited and
		// watching them move is how you land on a round one.
		function put(i, r) {
			const v = Math.round(r.x) + 'x' + Math.round(r.y) + 'x' +
				Math.round(r.w) + 'x' + Math.round(r.h);
			const src = inputs()[i];
			if (src) src.value = v;
			const ref = rowRefs[i];
			if (ref) { ref.co.value = v; ref.says(parse(v)); }
			return v;
		}

		// Removing a region renumbers every one after it, and the selection is an
		// index — so deleting row 1 of 3 while row 2 is selected would hand the
		// handles and the Delete key to what used to be row 3. Every delete goes
		// through here.
		function removeAt(i) {
			if (sel === i) sel = -1;
			else if (sel > i) sel -= 1;
			ctl._drop(i);
		}

		function select(i) {
			if (sel === i) return;
			sel = i;
			paintBoxes();
		}

		// Put back what a gesture had already written. Move and resize edit the
		// row LIVE — that is the point, the numbers move under the drag — so
		// abandoning one is not just forgetting it: the model already holds the
		// half-finished rectangle. Both ways out land here, a pointercancel
		// (the browser took the gesture: an edge swipe, a rotation, another
		// element capturing the pointer) and Escape mid-drag.
		function cancelGesture() {
			const g = gesture;
			gesture = null;
			band.hidden = true;
			if (!g || g.kind === 'new' || !g.moved || !g.orig) return;
			put(g.i, g.orig);
			paint();
		}

		// What the press landed on decides the gesture.
		function begin(e, surface) {
			if (e.button || gesture) return;
			const p = pic(), b = base();
			if (!p || !b) return;

			const delBtn = e.target.closest && e.target.closest('.mj-md-x');
			if (delBtn) return;                       // handled on click, not here
			const grip = e.target.closest && e.target.closest('.mj-md-h');
			const boxEl = e.target.closest && e.target.closest('.mj-md-rgn');

			if (grip && boxEl) {
				const i = +boxEl.dataset.i;
				gesture = { kind: 'resize', id: e.pointerId, i: i, grip: grip.dataset.grip,
					from: at(e), orig: parse(list()[i]), moved: false };
			} else if (boxEl) {
				const i = +boxEl.dataset.i;
				select(i);
				gesture = { kind: 'move', id: e.pointerId, i: i,
					from: at(e), orig: parse(list()[i]), moved: false };
			} else {
				// Empty picture. A press here is also how you put a selection down,
				// which is what makes the grips and the delete button transient.
				select(-1);
				gesture = { kind: 'new', id: e.pointerId, from: at(e), moved: false };
			}
			if (!gesture.orig && gesture.kind !== 'new') { gesture = null; return; }
			try { surface.setPointerCapture(e.pointerId); } catch (err) {}
			e.preventDefault();
		}

		function move(e) {
			if (!gesture || e.pointerId !== gesture.id) return;
			const p = pic(), b = base();
			if (!p || !b) { band.hidden = true; return; }
			gesture.moved = true;

			if (gesture.kind === 'new') {
				const r = bandRect(e);
				if (!r) { band.hidden = true; return; }
				band.hidden = false;
				band.style.left = r.x + 'px';
				band.style.top = r.y + 'px';
				band.style.width = r.w + 'px';
				band.style.height = r.h + 'px';
				return;
			}

			const n = at(e);
			const d = toStream(n.x - gesture.from.x, n.y - gesture.from.y, p, b);
			const o = gesture.orig;

			if (gesture.kind === 'move') {
				// Clamped as a whole rather than per edge: a region dragged at the
				// frame edge should stop, not squash.
				//
				// Every upper bound is floored at 0, because a region can be
				// LARGER than the frame — the resolution was reduced under it, or
				// the coordinates were typed by hand — and `b.w - o.w` is then
				// negative, so the clamp would drive x below zero and store a
				// negative origin. Pinned to the top-left instead, which is at
				// least a rectangle you can see and drag back.
				const x = Math.min(Math.max(o.x + d.dx, 0), Math.max(0, b.w - o.w));
				const y = Math.min(Math.max(o.y + d.dy, 0), Math.max(0, b.h - o.h));
				put(gesture.i, { x: x, y: y, w: o.w, h: o.h });
			} else {
				let x = o.x, y = o.y, w = o.w, h = o.h;
				const g = gesture.grip;
				if (g.indexOf('w') >= 0) {
					const nx = Math.min(Math.max(o.x + d.dx, 0), Math.max(0, o.x + o.w - MIN_PX));
					w = o.x + o.w - nx; x = nx;
				}
				if (g.indexOf('e') >= 0) {
					// Same flooring, and at MIN_PX rather than 0: a width clamped
					// to a negative bound would come out negative.
					w = Math.min(Math.max(o.w + d.dx, MIN_PX), Math.max(MIN_PX, b.w - o.x));
				}
				if (g.indexOf('n') >= 0) {
					const ny = Math.min(Math.max(o.y + d.dy, 0), Math.max(0, o.y + o.h - MIN_PX));
					h = o.y + o.h - ny; y = ny;
				}
				if (g.indexOf('s') >= 0) {
					h = Math.min(Math.max(o.h + d.dy, MIN_PX), Math.max(MIN_PX, b.h - o.y));
				}
				put(gesture.i, { x: x, y: y, w: w, h: h });
			}
			paintBoxes();
		}

		// `commit` is false for pointercancel: the browser took the gesture away —
		// a system edge swipe, a rotation, another element capturing the pointer —
		// and an interrupted gesture is not a completed one.
		function finish(e, commit, surface) {
			if (!gesture || e.pointerId !== gesture.id) return;
			const g = gesture;
			try { surface.releasePointerCapture(e.pointerId); } catch (err) {}
			if (!commit) { cancelGesture(); return; }
			const r = g.kind === 'new' ? bandRect(e) : null;
			gesture = null;
			band.hidden = true;

			if (g.kind === 'new') {
				const p = pic(), b = base();
				if (r && p && b) {
					// A rectangle has to be deliberate. Per AXIS, and a share of the
					// stage with an absolute floor, so it means the same thing on a
					// 2560px monitor and a 390px phone.
					const minW = Math.max(16, preview.stage.clientWidth * 0.02);
					const minH = Math.max(16, preview.stage.clientHeight * 0.02);
					if (r.w >= minW && r.h >= minH) {
						const px = (v, o, sz, n) => Math.round((v - o) / sz * n);
						const X = px(r.x, p.x, p.w, b.w), Y = px(r.y, p.y, p.h, b.h);
						const W = px(r.x + r.w, p.x, p.w, b.w) - X;
						const H = px(r.y + r.h, p.y, p.h, b.h) - Y;
						if (W > 0 && H > 0) {
							ctl._add(X + 'x' + Y + 'x' + W + 'x' + H);
							// Selected on arrival: the thing you just made is the thing
							// you are most likely to want to nudge.
							select(list().length - 1);
						}
					}
				}
				// One drag, then the button's light goes out — the whole of what
				// makes it cost one press.
				if (armed) setArmed(false);
				return;
			}

			// A move or resize that actually moved is an edit to save; one that did
			// not was a click, and a click is how you select.
			if (g.moved) { updateDirty(); paint(); }
		}

		[catcher, layer].forEach((surface) => {
			surface.addEventListener('pointerdown', (e) => begin(e, surface));
			surface.addEventListener('pointermove', move);
			surface.addEventListener('pointerup', (e) => finish(e, true, surface));
			surface.addEventListener('pointercancel', (e) => finish(e, false, surface));
		});

		// Delete, from the picture. The × on the selected region, and the key that
		// every other canvas in the world binds — guarded on the focus being
		// somewhere that is not a text box, or backspacing a coordinate would
		// delete the region you were correcting.
		layer.addEventListener('click', (e) => {
			const x = e.target.closest && e.target.closest('.mj-md-x');
			if (!x) return;
			e.preventDefault();
			removeAt(+x.dataset.del);
		});


		// The stage resizes with the window, the rail and the docked bar, none
		// of which is a window resize — so watch the stage itself, as the Live
		// leaf's bar does.
		let ro = null;
		if (window.ResizeObserver) {
			ro = new ResizeObserver(() => paint());
			ro.observe(preview.stage);
		} else {
			window.addEventListener('resize', paint);
		}

		state.liveCleanup.push(() => {
			document.removeEventListener('keydown', onKey);
			if (ro) ro.disconnect();
			else window.removeEventListener('resize', paint);
		});

		paint();
		return {
			repaint: paint,
			// Turn the drag surface on or off. The Overlay leaf has two things
			// that can be placed on one picture, so something has to say which
			// one a drag is for; the Motion leaf never calls this.
			setActive: (on) => {
				if (active === !!on) return;
				active = !!on;
				if (!active) select(-1);
				paint();
			},
		};
	}


	// ── The Overlay leaf ──────────────────────────────────────────────────
	//
	// The camera BURNS the overlay into the stream, which is the whole reason
	// this page can be honest: the picture already shows the real thing, in the
	// camera's font, at the camera's idea of where sixteen pixels is. Nothing
	// here imitates it, so nothing here can be wrong about it.
	//
	// What it costs is that only the camera can move it. Placing is a round
	// trip — write the position, the camera re-renders, the next frame carries
	// it — so a drag cannot show its own result. The stand-in below is dashed
	// for exactly that reason, and it is put away the moment the picture is
	// able to disagree with it.
	//
	// Two things can be placed on one picture, so the bar carries a Text/Masks
	// switch rather than letting a drag guess which was meant.
	// Only what the camera can actually print. An unrecognised code does not
	// error and does not print — majestic's specifier switch falls through to
	// `return 0`, which SILENTLY TRUNCATES the rest of the line, so a person who
	// copies a template off a forum gets an overlay that is half missing with
	// nothing anywhere saying why. That is what the chips exist to prevent, and
	// it is why the raw box below them refuses an unknown code rather than
	// letting the camera swallow it.
	const OSD_CODES = 'aAhbBcCedDFgGHIjmMnprRsStTuUWVwxXyYzZf@$%';
	const OSD_PARTS = [
		{ id: 'date', label: 'Date', hint: 'formats',
			opts: [
				{ fmt: '%d.%m.%Y', shows: '02.09.2026' },
				{ fmt: '%Y-%m-%d', shows: '2026-09-02' },
				{ fmt: '%d %b %Y', shows: '02 Sep 2026' },
				{ fmt: '%A', shows: 'Wednesday' },
			] },
		{ id: 'time', label: 'Time', hint: 'formats',
			opts: [
				{ fmt: '%H:%M:%S', shows: '18:08:12' },
				{ fmt: '%H:%M', shows: '18:08' },
				{ fmt: '%I:%M %p', shows: '06:08 PM' },
			] },
		// Live lens magnification. Offered only where there is a lens to report
		// it: on a camera with no focus motor it prints nothing at all, and a
		// chip that is always blank is worse than no chip.
		{ id: 'zoom', label: 'Zoom', needs: 'focus',
			opts: [{ fmt: '%@', shows: 'x3.2' }] },
		{ id: 'text', label: 'Text', free: true },
		// Whitespace is a piece too. It arrives as a literal like any other,
		// but "Text ␣" is a poor name for the thing holding two words apart,
		// and someone widening a gap should not have to count spaces in a box.
		{ id: 'gap', label: 'Gap',
			opts: [
				{ fmt: ' ', shows: 'one space' },
				{ fmt: '   ', shows: 'three' },
				{ fmt: '      ', shows: 'six' },
			] },
	];

	function renderOsd(form) {
		const fields = sectionFields('osd', true);
		const byKey = {};
		fields.forEach(f => { byKey[f.key] = f; });

		const head = el('div', 'mj-live-head');
		head.innerHTML = '<h3 class="mj-cap">' + esc(label('osd')) + '</h3>' +
			'<span class="mj-live-rule"></span>';
		const note = el('span', 'mj-live-note');
		head.appendChild(note);
		form.appendChild(head);

		let repaint = () => {};
		const preview = window.MajesticPreview &&
			window.MajesticPreview.mount(form, {
				config: () => state.config,
				where: 'osd',
				onFrame: () => repaint(),
			});
		state.preview = preview;

		// No knob strip on this leaf. Size would be the one thing worth dragging
		// while watching, but osd.size is a STRING in the schema ("1.0"), so it
		// renders as a text row and a text row in the strip is a card built for
		// a four-cell grid holding one box. It sits with the rest of the look
		// instead; a strip here wants an integer field to exist first.
		const deck = el('div', 'mj-live-deck');
		const colText = el('div', 'mj-live-col');
		const colLook = el('div', 'mj-live-col mj-live-col-b');
		deck.appendChild(colText);
		deck.appendChild(colLook);
		form.appendChild(deck);

		const textBody = liveGroup(colText, 'Text', 'what it says');
		// Two groups in one column: whether it is shown at all is not a question
		// about whether you can read it.
		const onBody = liveGroup(colLook, 'Overlay', '');
		const lookBody = liveGroup(colLook, 'Legibility', '');

		const maskDeck = el('div', 'mj-live-deck');
		const colMask = el('div', 'mj-live-col');
		maskDeck.appendChild(colMask);
		form.appendChild(maskDeck);
		const maskBody = liveGroup(colMask, 'Privacy masks', 'none');
		const maskNote = colMask.querySelector('.mj-live-grp-head .mj-live-note');

		// Where each field goes, and which of them this leaf drives instead of
		// showing. The placement four render hidden — the picture edits them —
		// on the same pattern the nightMode pin map uses, so Save, dirty
		// tracking and the per-row reset never learn a drag exists, and a camera
		// that cannot show a picture gets them back as plain fields.
		const PLACE = { anchor: 1, offsetX: 1, offsetY: 1, posX: 1, posY: 1 };
		const held = {};
		for (const f of fields) {
			const k = f.key;
			const hidden = !!PLACE[k] && !!preview;
			const box = k === 'enabled' ? onBody
				: k === 'template' ? textBody
				: (PLACE[k] ? textBody : lookBody);
			if (k === 'privacyMasks') continue;   // mounted below, in its own deck
			const field = renderField(box, f.dot, k, f.sub,
				getDotted(state.config, f.dot), hidden ? { hidden: true } : undefined);
			if (!field) continue;
			state.fields.push(field);
			state.initial[f.dot] = field.getValue();
			held[k] = field;
		}

		// One question, asked once: hiding the raw coordinate rows is only
		// right where something is going to draw them instead. Asked twice —
		// once for the row and once for the mount — a missing geometry module
		// would hide the field and then mount nothing over it, which is the one
		// outcome the hidden-field pattern exists to rule out.
		const canRegion = !!preview && !!window.MajesticRegion;
		const maskSchema = fields.find(f => f.key === 'privacyMasks');
		let maskField = null;
		if (maskSchema) {
			maskField = renderField(maskBody, maskSchema.dot, 'privacyMasks',
				maskSchema.sub, getDotted(state.config, maskSchema.dot),
				canRegion ? { hidden: true } : undefined);
			if (maskField) {
				state.fields.push(maskField);
				state.initial[maskSchema.dot] = maskField.getValue();
			}
		}

		// The chip builder sits above the raw template row and drives it. The
		// row stays — hidden — so Save and the reset arrow keep working on the
		// field itself, and a build whose template this cannot parse falls back
		// to showing it rather than losing it.
		if (held.template) {
			// Folded away, not removed: "Edit directly" brings it back, and a
			// template the chips cannot parse is still editable where it always
			// was. Save, dirty tracking and the reset arrow never notice.
			held.template.p.hidden = true;
			buildTemplate(textBody, held.template);
		}

		let masks = null;
		if (maskField && canRegion) {
			masks = mountRegions(preview, maskField, maskBody, maskNote, {
				gated: true,
				one: '1 mask', many: ' masks',
				draw: 'Draw masks', drawHint: 'Drag a rectangle on the picture',
				empty: 'No masks. Switch the picture to Masks and drag one over ' +
					'anything that should not be recorded.',
				clearAsk: 'Remove every mask? Everything they cover becomes visible again.',
				base: 'Masks are stored in the main stream’s pixels, and this camera ' +
					'has no main resolution set. Switch the picture to Main to draw them.',
				thing: 'mask',
				deadSome: 'A mask with no area, or one outside the picture, is saved ' +
					'but hides nothing.',
				// No "and so the whole picture is hidden" counterpart: an
				// unusable mask hides nothing, and every unusable mask still
				// hides nothing. The all-unusable case is only worth its own
				// sentence where it inverts the feature, which is the motion
				// list's case and not this one.
				deadAll: 'None of these masks hides anything.',
			});
			// The masks the camera has already applied are painted into the
			// stream as solid blocks. The outlines here are for grabbing them;
			// the black is the camera's, and it is in the recording too.
			const say = el('p', 'mj-live-hint');
			say.textContent = 'A mask is drawn into the video itself, so it is in the ' +
				'recording and in every other viewer’s picture — not just in this preview.';
			maskBody.appendChild(say);
		}

		let placer = null;
		if (preview && held.anchor) {
			placer = mountOsdText(preview, held, note);
			repaint = () => { placer.repaint(); if (masks) masks.repaint(); };
		} else if (masks) {
			repaint = masks.repaint;
		}

		// One picture, two things to place. The switch says which a drag is for
		// rather than letting the drag guess, and it is the only new control the
		// bar gains.
		if (preview && (placer || masks)) {
			const seg = el('span', 'mj-hud mj-seg mj-osd-mode');
			seg.setAttribute('role', 'group');
			seg.setAttribute('aria-label', 'What a drag places');
			const uid = 'mj-osd-mode';
			seg.innerHTML =
				'<input type="radio" class="mj-seg-in" name="' + uid + '" id="' + uid + '-t" checked>' +
				'<label class="mj-seg-lbl" for="' + uid + '-t">Text</label>' +
				'<input type="radio" class="mj-seg-in" name="' + uid + '" id="' + uid + '-m">' +
				'<label class="mj-seg-lbl" for="' + uid + '-m">Masks</label>';
			preview.barInsert(seg);
			const t = seg.querySelector('#' + uid + '-t');
			const m = seg.querySelector('#' + uid + '-m');
			const sync = () => {
				const textMode = t.checked;
				if (placer) placer.setActive(textMode);
				if (masks) masks.setActive(!textMode);
			};
			t.addEventListener('click', sync);
			m.addEventListener('click', sync);
			sync();
			if (!placer) { m.checked = true; sync(); }
		}

		if (!maskField) maskDeck.remove();
	}

	// Placement is a LIVE knob, and that is the whole difference.
	//
	// It used to POST /api/v1/config on every drop, which saves and reloads —
	// and a reload was a full pipeline rebuild, so moving the overlay tore the
	// stream down and put it back. Every viewer dropped, every recording cut,
	// because a text moved sixteen pixels. Unusable, and impossible to do
	// per-pointermove at all.
	//
	// The camera now classes osd.anchor/offsetX/offsetY as live and moves the
	// region with one MPI call per attached encoder, so this pushes them the
	// way the tone sliders push theirs: POST /api/v1/image, nothing saved,
	// nothing rebuilt. The fields stage until Save like everything else on the
	// page, and abandoning the drag reverts through the same path every other
	// live knob already uses.
	const osdLiveQuery = (name, ox, oy) =>
		'anchor=' + encodeURIComponent(name) +
		'&offsetX=' + encodeURIComponent(ox) +
		'&offsetY=' + encodeURIComponent(oy);

	// The nine named anchors, as majestic orders them. -1 is the near edge (left
	// or top), 0 centred, 1 the far edge — the same two tables the camera's own
	// overlay placement indexes, so a name picked here means the same thing there.
	const OSD_ANCHORS = [
		['top-left', -1, -1], ['top', 0, -1], ['top-right', 1, -1],
		['left', -1, 0], ['center', 0, 0], ['right', 1, 0],
		['bottom-left', -1, 1], ['bottom', 0, 1], ['bottom-right', 1, 1],
	];
	const anchorName = (sx, sy) => {
		const hit = OSD_ANCHORS.find(a => a[1] === sx && a[2] === sy);
		return hit ? hit[0] : 'top-left';
	};
	const anchorSides = (name) => {
		const hit = OSD_ANCHORS.find(a => a[0] === name);
		return hit ? { x: hit[1], y: hit[2] } : null;
	};
	const SAY_SIDE = { '-1,-1': 'Top left', '0,-1': 'Top', '1,-1': 'Top right',
		'-1,0': 'Left', '0,0': 'Centre', '1,0': 'Right',
		'-1,1': 'Bottom left', '0,1': 'Bottom', '1,1': 'Bottom right' };

	// Placing the overlay by dragging it, with the picture's own edges and
	// middles as magnets — the sticky guides every layout tool has, and the
	// reason they are right here rather than free pixels: a named corner
	// survives a change of resolution, and "16 px from the left" does not mean
	// the same thing on a 1920 frame as on a 640 one.
	function mountOsdText(preview, held, headNote) {
		const stage = preview.stage;
		let active = true, drag = null;

		const layer = el('div', 'mj-osd-layer');
		preview.overlay.appendChild(layer);
		const guides = el('div', 'mj-osd-guides');
		layer.appendChild(guides);
		['gx-l', 'gx-c', 'gx-r'].forEach(c => guides.appendChild(el('span', 'mj-osd-g mj-osd-v ' + c)));
		['gy-t', 'gy-c', 'gy-b'].forEach(c => guides.appendChild(el('span', 'mj-osd-g mj-osd-h ' + c)));
		const ghost = el('div', 'mj-osd-ghost mono');
		ghost.hidden = true;
		layer.appendChild(ghost);
		const read = el('span', 'mj-osd-read');
		read.hidden = true;
		layer.appendChild(read);

		const catcher = el('div', 'mj-osd-catch');
		preview.overlay.appendChild(catcher);

		// No base() here, unlike the region editor. A share of the frame is
		// resolved by whichever channel is drawing it, so placing the overlay
		// needs nothing but the picture on screen — which also means it works on
		// a camera with no main resolution set, where the mask tool cannot.
		function pic() {
			const f = preview.frame();
			const w = stage.clientWidth, h = stage.clientHeight;
			if (!f || !f.w || !f.h || !w || !h) return null;
			const s = Math.min(w / f.w, h / f.h);
			return { x: (w - f.w * s) / 2, y: (h - f.h * s) / 2, w: f.w * s, h: f.h * s };
		}

		// What the overlay says, resolved here so the stand-in is the right
		// LENGTH — the thing that decides whether it fits where you are putting
		// it. It is not the camera's font and the dashes say so.
		//
		// On the CAMERA's clock, not the browser's. They are routinely hours
		// apart — this board runs Etc/GMT while the browser was +03:00 — and a
		// stand-in showing 21:57 beside a picture showing 18:57 invites exactly
		// the wrong conclusion about which one is wrong. Same source every other
		// page uses for the device's wall clock (j/pulse.cgi, once).
		let camSkewMs = 0, camOffMs = 0;
		apiFetch('j/pulse.cgi', { credentials: 'same-origin' })
			.then(r => r.json())
			.then((j) => {
				if (j && j.time_now) camSkewMs = (+j.time_now || 0) * 1000 - Date.now();
				const off = parseTzOffsetMs(j && j.utc_offset);
				if (off !== null && off !== undefined) camOffMs = off;
				paint();
			})
			.catch(() => {});

		function camNow() {
			// Shifted into UTC-reading position, so the getters below spell the
			// camera's local time rather than this browser's.
			return new Date(Date.now() + camSkewMs + camOffMs);
		}

		function shown() {
			const t = held.template ? held.template.getValue() : '';
			const d = camNow();
			const p2 = (n) => String(n).padStart(2, '0');
			const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
				'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
			const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday',
				'Thursday', 'Friday', 'Saturday'];
			const h24 = d.getUTCHours();
			const map = {
				d: p2(d.getUTCDate()), e: String(d.getUTCDate()),
				m: p2(d.getUTCMonth() + 1), b: MON[d.getUTCMonth()], h: MON[d.getUTCMonth()],
				Y: String(d.getUTCFullYear()), y: p2(d.getUTCFullYear() % 100),
				H: p2(h24), M: p2(d.getUTCMinutes()), S: p2(d.getUTCSeconds()),
				I: p2(((h24 + 11) % 12) + 1), p: h24 < 12 ? 'AM' : 'PM',
				A: DAY[d.getUTCDay()], a: DAY[d.getUTCDay()].slice(0, 3),
				// The lens magnification, which this board cannot know without a
				// motor — a plausible-looking number is the honest placeholder
				// for a value whose LENGTH is all the stand-in needs.
				'@': 'x3.2', '%': '%',
			};
			const out = String(t).replace(/%[-_0]?([a-zA-Z@$%])/g,
				(m, c) => (map[c] !== undefined ? map[c] : m));
			return out || 'Overlay';
		}

		// Roughly what the camera will draw. Majestic derives the glyph size
		// from the stream width, so this tracks the same thing; it is an
		// approximation on purpose and never pretends otherwise.
		function em(p) {
			const size = parseFloat(held.size ? held.size.getValue() : '1') || 1;
			return Math.max(8, p.w / 96 * size);
		}

		// Where the overlay is now, from the fields the camera is reading.
		function current(p) {
			const a = held.anchor.getValue();
			const sides = anchorSides(a);
			const w = ghost.offsetWidth || 120, h = ghost.offsetHeight || 20;
			if (!sides) {
				// proportional: posX/posY run -16 (far edge) .. 16 (near edge)
				const map = (v, span, size) => {
					const t = (16 - Math.min(Math.max(+v || 0, -16), 16)) / 32;
					return t * Math.max(0, span - size);
				};
				return {
					x: p.x + map(held.posX && held.posX.getValue(), p.w, w),
					y: p.y + map(held.posY && held.posY.getValue(), p.h, h),
				};
			}
			// The span an offset is measured against is the frame being SHOWN,
			// which is the picture on screen — not video0. That is the same
			// reading majestic takes per channel, which is why a share travels
			// between them and a pixel count does not.
			const f = preview.frame();
			const emPx = em(p);
			const ox = offsetFrac(held.offsetX && held.offsetX.getValue(),
				f ? f.w : 0, emPx * (f ? f.w / p.w : 1)) * p.w;
			const oy = offsetFrac(held.offsetY && held.offsetY.getValue(),
				f ? f.h : 0, emPx * (f ? f.h / p.h : 1)) * p.h;
			const ax = sides.x < 0 ? ox : sides.x > 0 ? p.w - w - ox : (p.w - w) / 2;
			const ay = sides.y < 0 ? oy : sides.y > 0 ? p.h - h - oy : (p.h - h) / 2;
			return { x: p.x + ax, y: p.y + ay };
		}

		function paint() {
			const p = pic();
			layer.hidden = !active || !p;
			catcher.hidden = !active || !p;
			if (!p) return;
			ghost.style.fontSize = em(p).toFixed(1) + 'px';
			ghost.textContent = shown();
			guides.style.left = p.x + 'px';
			guides.style.top = p.y + 'px';
			guides.style.width = p.w + 'px';
			guides.style.height = p.h + 'px';
			if (!drag) {
				ghost.hidden = true;
				read.hidden = true;
				guides.classList.remove('mj-osd-on');
			}
		}

		// Offsets are written as a PERCENTAGE, and that is the whole of the
		// Main/Sub fix. majestic resolves a bare offset as pixels against the
		// channel it is drawing — so "200" is a tenth of the way across a 1920
		// frame and well over a quarter across a 704 one, and the overlay landed
		// somewhere different on each stream from the same setting. `%` is
		// resolved as a share of that channel's own span (`value * span / 100`),
		// and the font is derived from the stream width too,
		// so the text lands in the same visual place on every output.
		//
		// One decimal: enough that a 1920-wide frame can be addressed to the
		// pixel, few enough that a drag does not write a different number every
		// time the pointer jitters.
		const pct = (v) => Math.round(v * 1000) / 10;

		// Read an offset back, whatever unit it was written in — a config
		// written before this, or by hand, is still pixels or em.
		function offsetFrac(spec, span, emPx) {
			const t = String(spec == null ? '' : spec).trim();
			const v = parseFloat(t);
			if (!isFinite(v)) return 0;
			if (/%\s*$/.test(t)) return v / 100;
			if (/em\s*$/i.test(t)) return span ? (v * emPx) / span : 0;
			// bare, or "px": pixels of the channel being drawn. The picture on
			// screen is one of those channels, so its own frame is the span.
			return span ? v / span : 0;
		}

		const SNAP = 12;
		function place(px, py, p) {
			const w = ghost.offsetWidth, h = ghost.offsetHeight;
			const lo = { x: p.x, y: p.y };
			const mid = { x: p.x + (p.w - w) / 2, y: p.y + (p.h - h) / 2 };
			const hi = { x: p.x + p.w - w, y: p.y + p.h - h };
			const pick = (v, a, c, z) => Math.abs(v - a) <= SNAP ? -1
				: Math.abs(v - c) <= SNAP ? 0 : Math.abs(v - z) <= SNAP ? 1 : null;
			let sx = pick(px, lo.x, mid.x, hi.x);
			let sy = pick(py, lo.y, mid.y, hi.y);
			let ox = 0, oy = 0;
			if (sx === null) {
				sx = (px + w / 2) < (p.x + p.w / 2) ? -1 : 1;
				ox = sx < 0 ? (px - p.x) : (p.x + p.w - (px + w));
				ox = pct(Math.max(0, ox) / p.w);
			}
			if (sy === null) {
				sy = (py + h / 2) < (p.y + p.h / 2) ? -1 : 1;
				oy = sy < 0 ? (py - p.y) : (p.y + p.h - (py + h));
				oy = pct(Math.max(0, oy) / p.h);
			}
			// A centred axis ignores its offset — the camera's anchored
			// placement centres it outright — so writing one would be a number
			// the camera never reads and the form would show it as set.
			if (sx === 0) ox = 0;
			if (sy === 0) oy = 0;
			return { sx: sx, sy: sy, ox: ox, oy: oy };
		}

		function preview_(r, p) {
			const w = ghost.offsetWidth, h = ghost.offsetHeight;
			const fx = r.ox / 100, fy = r.oy / 100;
			const gx = r.sx < 0 ? p.x + fx * p.w
				: r.sx > 0 ? p.x + p.w - w - fx * p.w
				: p.x + (p.w - w) / 2;
			const gy = r.sy < 0 ? p.y + fy * p.h
				: r.sy > 0 ? p.y + p.h - h - fy * p.h
				: p.y + (p.h - h) / 2;
			ghost.style.left = gx + 'px';
			ghost.style.top = gy + 'px';
			read.style.left = gx + 'px';
			read.style.top = Math.max(0, gy - 24) + 'px';
			read.innerHTML = '<b>' + esc(SAY_SIDE[r.sx + ',' + r.sy]) + '</b>' +
				(r.ox || r.oy ? '<span>' + r.ox + '% · ' + r.oy + '%</span>' : '');
			guides.classList.toggle('mj-osd-sx', r.sx === -1 || r.sx === 1 || r.sx === 0);
			guides.querySelectorAll('.mj-osd-g').forEach(g => g.classList.remove('mj-osd-lit'));
			const gx_ = r.sx === -1 ? '.gx-l' : r.sx === 0 ? '.gx-c' : '.gx-r';
			const gy_ = r.sy === -1 ? '.gy-t' : r.sy === 0 ? '.gy-c' : '.gy-b';
			if (r.ox === 0) guides.querySelector(gx_).classList.add('mj-osd-lit');
			if (r.oy === 0) guides.querySelector(gy_).classList.add('mj-osd-lit');
		}

		const at = (e) => {
			const r = preview.overlay.getBoundingClientRect();
			return { x: e.clientX - r.left, y: e.clientY - r.top };
		};

		catcher.addEventListener('pointerdown', (e) => {
			if (e.button || drag || !active) return;
			const p = pic();
			if (!p) return;
			ghost.hidden = false;
			read.hidden = false;
			guides.classList.add('mj-osd-on');
			const cur = current(p);
			const n = at(e);
			drag = { id: e.pointerId, dx: n.x - cur.x, dy: n.y - cur.y };
			try { catcher.setPointerCapture(e.pointerId); } catch (err) {}
			preview_(place(cur.x, cur.y, p), p);
			e.preventDefault();
		});

		catcher.addEventListener('pointermove', (e) => {
			if (!drag || e.pointerId !== drag.id) return;
			const p = pic();
			if (!p) return;
			const n = at(e);
			const r = place(n.x - drag.dx, n.y - drag.dy, p);
			preview_(r, p);
			// The camera follows the pointer. postLive serialises and swallows
			// its own failures, so a move that cannot land does not wedge the
			// ones after it or interrupt the drag.
			const name = anchorName(r.sx, r.sy);
			if (name !== drag.lastName || r.ox !== drag.lastOx || r.oy !== drag.lastOy) {
				drag.lastName = name; drag.lastOx = r.ox; drag.lastOy = r.oy;
				postLive(osdLiveQuery(name, r.ox + '%', r.oy + '%'));
			}
		});

		function done(e, commit) {
			if (!drag || e.pointerId !== drag.id) return;
			const p = pic();
			try { catcher.releasePointerCapture(e.pointerId); } catch (err) {}
			const n = commit ? at(e) : null;
			// Where you GRABBED it, kept across the line that clears the drag.
			// Every pointermove placed the overlay at the pointer minus this,
			// and committing the raw pointer instead moved the text by the grab
			// offset at the instant you let go — so it landed somewhere the drag
			// had never shown, and the readout and the camera disagreed.
			const dx = drag.dx, dy = drag.dy;
			drag = null;
			guides.classList.remove('mj-osd-on');
			if (!n || !p) { paint(); return; }

			const r = place(n.x - dx, n.y - dy, p);
			const name = anchorName(r.sx, r.sy);
			// Staged, not saved. The camera is already showing it — that
			// happened on the way here, one push per move — so all that is left
			// is for the form to agree, and for Save to mean what it means
			// everywhere else on the page.
			if (held.anchor) held.anchor.setValue(name);
			if (held.offsetX) held.offsetX.setValue(r.ox + '%');
			if (held.offsetY) held.offsetY.setValue(r.oy + '%');
			runVisibility();
			updateDirty();
			// One last push at the resting place: the drag may have ended
			// between debounces, and the pointer's last position is the one that
			// counts.
			postLive(osdLiveQuery(name, r.ox + '%', r.oy + '%'));
			paint();
		}
		catcher.addEventListener('pointerup', (e) => done(e, true));
		catcher.addEventListener('pointercancel', (e) => done(e, false));

		let ro = null;
		if (window.ResizeObserver) { ro = new ResizeObserver(() => paint()); ro.observe(stage); }
		else window.addEventListener('resize', paint);
		state.liveCleanup.push(() => {
			if (ro) ro.disconnect(); else window.removeEventListener('resize', paint);
		});

		paint();
		return {
			repaint: paint,
			setActive: (on) => { active = !!on; paint(); },
		};
	}

	// The overlay's text, as pieces you can pick up.
	//
	// The template is a printf-ish string and it fails in the worst possible
	// way: majestic's specifier switch returns 0 for anything it does not know,
	// and the caller stops there — so ONE wrong letter silently truncates the
	// rest of the line, with no error and no clue. Measured on an hi3516av300,
	// `AT %@ END` printed `AT`. Somebody who copied that off a forum sees half
	// an overlay and has nowhere to look.
	//
	// So the chips are not a friendlier skin over the string. They are the only
	// version of this control that cannot produce a code the camera will choke
	// on. The string stays underneath — it is how you learn what the chips did,
	// and how an expert pastes one in — but editing it directly is checked
	// before it reaches the camera.
	function buildTemplate(container, field) {
		const wrap = el('div', 'mj-tpl');
		container.insertBefore(wrap, container.firstChild);

		const row = el('div', 'mj-tpl-row');
		wrap.appendChild(row);
		const opts = el('div', 'mj-tpl-opts');
		opts.hidden = true;
		wrap.appendChild(opts);
		const raw = el('div', 'mj-tpl-raw');
		wrap.appendChild(raw);

		let parts = [];
		let open = -1;

		// Longest match first, or %H:%M would eat the front of %H:%M:%S and
		// leave `:%S` as literal text.
		const KNOWN = [];
		OSD_PARTS.forEach((p) => {
			(p.opts || []).forEach(o => KNOWN.push({ id: p.id, fmt: o.fmt, shows: o.shows }));
		});
		KNOWN.sort((a, b) => b.fmt.length - a.fmt.length);

		function parse(t) {
			const out = [];
			let i = 0, lit = '';
			const flush = () => {
				if (!lit) return;
				// A run of nothing but spaces is a Gap; anything else is words.
				out.push(/^\s+$/.test(lit) ? { id: 'gap', fmt: lit } : { id: 'text', text: lit });
				lit = '';
			};
			while (i < t.length) {
				const hit = KNOWN.find(k => t.startsWith(k.fmt, i));
				if (hit) { flush(); out.push({ id: hit.id, fmt: hit.fmt }); i += hit.fmt.length; }
				else { lit += t[i]; i++; }
			}
			flush();
			return out;
		}
		const serialize = () => parts.map(p => p.id === 'text' ? p.text : p.fmt).join('');

		function commit() {
			field.setValue(serialize());
			updateDirty();
			draw();
		}

		// Anything the camera cannot print, named before it can swallow the rest
		// of the line.
		function unknownCodes(t) {
			const bad = [];
			String(t).replace(/%[-_0]?(.)/g, (m, c) => {
				if (OSD_CODES.indexOf(c) < 0) bad.push('%' + c);
				return m;
			});
			return bad;
		}

		function drawRaw() {
			const t = serialize();
			const bad = unknownCodes(t);
			raw.innerHTML = '';
			const line = el('div', 'mj-tpl-rawline');
			const cap = el('span', 'mj-cap');
			cap.textContent = 'Sends';
			const code = el('code', 'mj-tpl-code');
			code.textContent = t || '(nothing)';
			const edit = el('button', 'mj-live-linkbtn');
			edit.type = 'button';
			edit.textContent = field.p.hidden ? 'Edit directly' : 'Done';
			edit.addEventListener('click', () => {
				field.p.hidden = !field.p.hidden;
				drawRaw();
				if (!field.p.hidden) field.control.focus();
			});
			line.appendChild(cap);
			line.appendChild(code);
			line.appendChild(edit);
			raw.appendChild(line);
			if (bad.length) {
				const w = el('p', 'mj-live-hint mj-md-warn');
				w.textContent = bad.join(', ') + (bad.length === 1 ? ' is not a code this camera knows' :
					' are not codes this camera knows') +
					' — it prints nothing from there on, so the rest of the line disappears.';
				raw.appendChild(w);
			}
		}

		function drawOpts() {
			opts.innerHTML = '';
			opts.hidden = open < 0;
			if (open < 0) return;
			const part = parts[open];
			const def = OSD_PARTS.find(p => p.id === part.id);
			if (!def) { opts.hidden = true; return; }
			const head = el('div', 'mj-live-grp-head');
			head.innerHTML = '<span class="mj-cap">' + esc(def.label) + ' reads</span>' +
				'<span class="mj-live-rule"></span>';
			opts.appendChild(head);
			if (def.free) {
				const inp = el('input', 'form-control form-control-sm');
				inp.type = 'text';
				inp.value = part.text || '';
				inp.placeholder = 'Anything you like';
				inp.addEventListener('input', () => {
					part.text = inp.value;
					field.setValue(serialize());
					updateDirty();
					drawChips();
					drawRaw();
				});
				opts.appendChild(inp);
				return;
			}
			(def.opts || []).forEach((o) => {
				const b = el('button', 'mj-tpl-opt' + (o.fmt === part.fmt ? ' mj-tpl-on' : ''));
				b.type = 'button';
				b.innerHTML = '<span class="mj-tpl-dot"></span><span>' + esc(o.shows) + '</span>' +
					'<code>' + esc(o.fmt) + '</code>';
				b.addEventListener('click', () => { part.fmt = o.fmt; commit(); });
				opts.appendChild(b);
			});
		}

		// Reordering is the ask: nobody should have to know that the date comes
		// before the time because of where %d sits in a string.
		let dragging = null;
		function onDown(e, i) {
			if (e.button) return;
			dragging = { i: i, id: e.pointerId, moved: false };
			try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
		}
		function onMove(e) {
			if (!dragging || e.pointerId !== dragging.id) return;
			dragging.moved = true;
			const chips = Array.prototype.slice.call(row.querySelectorAll('.mj-tpl-chip'));
			let to = chips.length;
			for (let n = 0; n < chips.length; n++) {
				const r = chips[n].getBoundingClientRect();
				if (e.clientX < r.left + r.width / 2) { to = n; break; }
			}
			row.querySelectorAll('.mj-tpl-caret').forEach(c => c.remove());
			const caret = el('span', 'mj-tpl-caret');
			if (to >= chips.length) row.insertBefore(caret, row.querySelector('.mj-tpl-add'));
			else row.insertBefore(caret, chips[to]);
			dragging.to = to;
		}
		function onUp(e) {
			if (!dragging || e.pointerId !== dragging.id) return;
			const d = dragging;
			dragging = null;
			row.querySelectorAll('.mj-tpl-caret').forEach(c => c.remove());
			if (!d.moved || d.to === undefined) { open = open === d.i ? -1 : d.i; drawOpts(); return; }
			let to = d.to;
			if (to > d.i) to -= 1;
			if (to === d.i) { drawChips(); return; }
			const moved = parts.splice(d.i, 1)[0];
			parts.splice(to, 0, moved);
			open = -1;
			commit();
		}

		function drawChips() {
			row.innerHTML = '';
			parts.forEach((part, i) => {
				const def = OSD_PARTS.find(p => p.id === part.id) || { label: 'Text' };
				const chip = el('span', 'mj-tpl-chip' +
					(part.id === 'text' ? ' mj-tpl-lit' : '') + (i === open ? ' mj-tpl-sel' : ''));
				chip.innerHTML =
					'<span class="mj-tpl-grip"><i></i><i></i><i></i></span>' +
					'<span class="mj-tpl-k">' + esc(def.label) + '</span>' +
					'<span class="mj-tpl-v">' + esc(
						part.id === 'text' ? (part.text || '␣')
						: part.id === 'gap' ? '␣'.repeat(Math.min(6, (part.fmt || ' ').length))
						: ((def.opts || []).find(o => o.fmt === part.fmt) || {}).shows || part.fmt
					) + '</span>';
				const x = el('button', 'mj-tpl-x');
				x.type = 'button';
				x.innerHTML = '&times;';
				x.title = 'Remove';
				x.addEventListener('click', (ev) => {
					ev.stopPropagation();
					parts.splice(i, 1);
					open = -1;
					commit();
				});
				chip.appendChild(x);
				chip.addEventListener('pointerdown', (e) => {
					if (e.target.closest('.mj-tpl-x')) return;
					onDown(e, i);
				});
				chip.addEventListener('pointermove', onMove);
				chip.addEventListener('pointerup', onUp);
				chip.addEventListener('pointercancel', () => { dragging = null; });
				row.appendChild(chip);
			});

			const add = el('span', 'mj-tpl-chip mj-tpl-add');
			add.innerHTML = ICON.plus + '<span>Add</span>';
			add.addEventListener('click', () => {
				const menu = row.querySelector('.mj-tpl-menu');
				if (menu) { menu.remove(); return; }
				const m = el('div', 'mj-tpl-menu');
				OSD_PARTS.forEach((def) => {
					const b = el('button', 'mj-tpl-mi');
					b.type = 'button';
					b.innerHTML = '<span>' + esc(def.label) + '</span>' +
						'<span class="mj-tpl-mi-s">' + esc(def.free ? 'your own words'
							: def.id === 'gap' ? 'space between'
							: (def.opts[0] || {}).shows || '') + '</span>';
					b.addEventListener('click', () => {
						parts.push(def.free ? { id: 'text', text: ' ' }
							: { id: def.id, fmt: def.opts[0].fmt });
						open = parts.length - 1;
						m.remove();
						commit();
						drawOpts();
					});
					m.appendChild(b);
				});
				const hint = el('p', 'mj-tpl-mi-hint');
				hint.textContent = 'Zoom needs a motorised lens; without one the camera prints nothing for it.';
				m.appendChild(hint);
				add.appendChild(m);
			});
			row.appendChild(add);
		}

		function draw() { drawChips(); drawOpts(); drawRaw(); }

		// Re-read whenever the field moves under us — a save, a reset, or the
		// raw box being typed in. The field is the model; these chips are a view
		// of it, exactly as the region list is a view of the ROI field.
		function reload() {
			parts = parse(field.getValue() || '');
			if (open >= parts.length) open = -1;
			draw();
		}
		field.control.addEventListener('input', () => { parts = parse(field.getValue() || ''); draw(); });
		field.control.addEventListener('change', () => { parts = parse(field.getValue() || ''); draw(); });
		state.liveSync.push(reload);
		reload();
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

	// ── The IR-cut panel, on Day / Night ────────────────────────────────────
	//
	// This section's fields are pin numbers, and a pin number is the one kind
	// of setting whose page cannot show you whether it is right: the form will
	// happily hold 11 for a board that wants 8 and look identical either way.
	// So the section carries the two things the form cannot be — what the
	// current configuration already implies (passive, always on screen) and a
	// control that moves the filter and watches the picture change (active, on
	// request). The verdicts are in /a/ircut-check.js; this is only their page.
	const IRCUT = window.MajesticIrcut;
	const ircutTrack = IRCUT ? IRCUT.tracker() : null;
	let ircutSample = null;
	let ircutStats = { flips: 0, conflictS: 0 };
	let ircutBusy = false;

	// Subscribed once for the page rather than once per mount: main.js keeps no
	// unsubscribe, so re-subscribing on every visit to this section would leave
	// a live handler behind for each one.
	function watchIrcut() {
		if (!IRCUT || typeof mjMetricsSubscribe !== 'function') return;
		mjMetricsSubscribe((s) => {
			if (!s.ok) return;
			const v = (s.m && s.m.v) || {};
			ircutSample = {
				night: s.night, ircut: s.ircut, light: s.light,
				// Which door the daemon says is being watched — diagnose()
				// tells an automatic monitor from a blind one by it, and null
				// (gauge absent) keeps the older-firmware reading.
				src: ('night_mode_source' in v) ? v.night_mode_source : null,
			};
			ircutStats = ircutTrack.push(ircutSample, performance.now() / 1000);
			paintFindings();
			paintMonitor(s);
		});
	}

	// The light monitor's live view: one sentence about what it is doing and a
	// chart of the value it is watching, with the switching bands shaded. What
	// to show is decided in ircut-check.js (monitorView, tested); this only
	// mounts it. The chart is remade when the mode or the bands change, and
	// the superseded instance is dropped from the registry.
	let monChart = null;
	let monKey = '';
	function paintMonitor(s) {
		const box = document.getElementById('mj-ircut-mon');
		if (!box) return;
		const MC = window.MjCharts;
		const view = IRCUT.monitorView(nightCfg(), (s.m && s.m.v) || null);
		if (!view || !MC) {
			box.hidden = true;
			return;
		}
		box.hidden = false;
		const line = document.getElementById('mj-ircut-mon-line');
		if (line) line.textContent = view.line;
		const host = document.getElementById('mj-ircut-mon-chart');
		if (!host) return;
		const key = view.mode + '|' + JSON.stringify(view.bands);
		if (!monChart || monChart.host !== host || monKey !== key) {
			// The superseded instance is unregistered, not merely abandoned:
			// every remount of this section makes a new host, and the chart
			// registry would otherwise keep each one for the life of the tab.
			MC.dropChart(monChart);
			host.innerHTML = '';
			monChart = MC.makeChart(host, {
				h: 110, lo: 0, hi: null, colors: ['#4c60d8'],
				bands: view.bands,
				fmt: view.mode === 'auto'
					? (x) => (x >= 10 ? String(Math.round(x)) : x.toFixed(1)) + 'x'
					: undefined,
			});
			monKey = key;
		}
		if (view.value != null) MC.pushChart(monChart, [view.value]);
	}

	function nightCfg() { return (state.config && state.config.nightMode) || {}; }

	// Why the button cannot run, or null. Each reason is specific: a disabled
	// control that will not say what it wants is the thing this whole panel
	// exists to stop being.
	function testBlocker() {
		const nm = nightCfg();
		if (!isNumish(nm.irCutPin1))
			return 'Nothing is connected to the filter yet, so there is nothing to test.';
		// Parked outranks wired: the daemon refuses to move a parked filter,
		// so the test's toggle would silently do nothing and every verdict
		// would read "stuck" on a filter that is fine.
		if (nm.irCutEnabled === false)
			return 'The filter is switched off (its wiring is kept). Turn "Drive the ' +
				'IR-cut filter" on to test it.';
		if (!toBool(getDotted(state.config, 'jpeg.enabled')))
			return 'The test reads a still picture, and this camera has JPEG snapshots turned off.';
		// The monitor re-drives the filter on its own schedule, and a snapshot
		// taken after it had snapped the filter back would read as "it never
		// moved" — convicting a correctly wired camera. Refusing to run beats
		// running and possibly lying.
		if (toBool(nm.lightMonitor))
			return 'The light monitor would drive the filter back mid-test. Turn it off, ' +
				'run the test, then turn it back on.';
		return null;
	}

	// Re-reads testBlocker() against the current config and dresses the button
	// accordingly. Asked at mount, whenever the map changes, and after a save:
	// the answer goes stale the moment a save gives the camera the pins the
	// button was refusing for want of.
	function syncTestBtn() {
		const btn = document.getElementById('mj-ircut-run');
		if (!btn) return;
		const why = testBlocker();
		btn.disabled = !!why;
		btn.title = why || 'Moves the filter and compares the picture in both positions.';
		// The reason goes on the page, not only in the title. A tooltip is not
		// an explanation on a touchscreen, where there is no hover at all, and
		// a control that refuses without saying why is the thing this whole
		// panel exists to stop happening.
		const note = document.getElementById('mj-ircut-why');
		if (note) {
			note.textContent = why || '';
			note.hidden = !why;
		}
	}

	function paintFindings() {
		const box = document.getElementById('mj-ircut-findings');
		if (!box || !IRCUT) return;
		const found = IRCUT.diagnose(nightCfg(), ircutSample, ircutStats);
		box.innerHTML = '';
		found.forEach((f) => {
			const cls = f.level === 'danger' ? 'alert-danger'
				: f.level === 'warning' ? 'alert-warning' : 'alert-secondary';
			const d = el('div', 'alert ' + cls + ' py-2 px-3 mb-2 small');
			d.innerHTML = '<b>' + esc(f.title) + '</b> ' + esc(f.detail);
			box.appendChild(d);
		});
	}

	const IRCUT_STEP = {
		first: 'Reading the picture…',
		toggle: 'Moving the filter…',
		second: 'Reading it again…',
		restore: 'Putting the filter back…',
	};

	function runIrcutTest(btn, status, result) {
		if (ircutBusy) return;
		// The filter is a physical part and the picture jumps twice while this
		// runs, which is worth a sentence before it happens rather than an
		// explanation afterwards.
		if (!confirm('Move the IR-cut filter twice and compare the picture?\n\n' +
			'The live view will flicker for a couple of seconds. The filter is ' +
			'put back where it started.')) return;

		ircutBusy = true;
		btn.disabled = true;
		result.hidden = true;
		// The heartbeat's last sample is only a fallback — probe() reads the
		// filter's position from the camera itself, because which capture is
		// the day one turns on it and a stale answer does not mis-word the
		// verdict, it inverts it.
		const start = ircutSample ? (ircutSample.ircut | 0) : 0;
		// Snapshot the wiring now, not when the probe returns: it takes seconds
		// and the map stays live throughout, so reading the fields at the end
		// would stamp the verdict with an assignment it was never measured
		// against — and syncVerdict() would then find them matching and keep a
		// stale verdict on screen.
		const testedOn = fieldAssign();

		IRCUT.probe({
			settleMs: 1500,
			snap: () => IRCUT.snapshot('/image.jpg'),
			state: () => apiFetch('/metrics/night?value=ircut_enabled',
				{ credentials: 'same-origin' })
				.then(r => r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)))
				.then(t => (+t > 0 ? 1 : 0)),
			toggle: () => apiFetch('/night/ircut', { credentials: 'same-origin' })
				.then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))),
			wait: (ms) => new Promise(r => setTimeout(r, ms)),
			onStep: (s) => { status.textContent = IRCUT_STEP[s] || ''; },
		}, start).then((out) => {
			const v = out.verdict;
			// A test that could not put the filter back outranks whatever it
			// found: the camera is sitting in the wrong position right now, and
			// on a board that holds its filter electrically that means daylight
			// is magenta until somebody fixes it.
			const cls = out.restored === false ? 'alert-danger'
				: v.level === 'danger' ? 'alert-danger'
					: v.level === 'warning' ? 'alert-warning'
						: v.level === 'ok' ? 'alert-success' : 'alert-secondary';
			result.className = 'alert ' + cls + ' py-2 px-3 mt-2 mb-0 small';
			result.innerHTML = (out.restored === false
				? '<b>The filter could not be put back.</b> It is still in the ' +
				'position the test left it in &mdash; use the IR-cut switch on ' +
				'Live adjustments to move it back. The test itself found: '
				: '') + '<b>' + esc(v.title) + '</b> ' + esc(v.detail);
			result.hidden = false;
			state.ircutTestedOn = testedOn;
			// Edited while the probe ran: the verdict describes wiring that is
			// no longer on screen, so it goes straight back out.
			syncVerdict();
		}).catch((e) => {
			result.className = 'alert alert-danger py-2 px-3 mt-2 mb-0 small';
			// A test that could not finish reports that it could not finish. It
			// must never fall through to a verdict — half a measurement is not
			// evidence about the filter.
			result.textContent = 'The test could not finish: ' + (e && e.message ? e.message : e) +
				'. The filter was left where it started.';
			result.hidden = false;
			state.ircutTestedOn = testedOn;
			// Edited while the probe ran: the verdict describes wiring that is
			// no longer on screen, so it goes straight back out.
			syncVerdict();
		}).finally(() => {
			ircutBusy = false;
			btn.disabled = false;
			status.textContent = '';
		});
	}

	// The four wiring pins, by the name majestic's config gives them. Numbers
	// are plain running integers everywhere in the UI — the same 11 that goes
	// into nightMode.irCutPin1 and the same 11 the wiki's GPIO table lists. The
	// kernel's bank_pin spelling is deliberately never shown: a second
	// numbering nobody can map onto the one they have to type is worse than the
	// harder one alone.
	const PIN_KEYS = ['irCutPin1', 'irCutPin2', 'backlightPin', 'lightSensorPin'];
	const PIN_DOTS = {};
	PIN_KEYS.forEach((k) => { PIN_DOTS['nightMode.' + k] = 1; });

	function pinField(key) {
		return state.fields.filter((f) => f.dot === 'nightMode.' + key)[0];
	}

	// The map reports; this writes what it reports into the real fields, so the
	// save bar appears exactly as it would have for a typed number.
	function pushAssign(a) {
		PIN_KEYS.forEach((k) => {
			const f = pinField(k);
			if (f) f.setValue(a[k] === undefined ? '' : String(a[k]));
		});
		updateDirty();
	}

	// A pin the save cleared has to be GONE from the config, not set to
	// something: majestic stores "" in an integer as 0, and 0 is a real GPIO —
	// the wiki lists it as RESET on several boards — so a camera whose coil was
	// "not connected" ended up configured to drive pad 0, with no missing-pin
	// warning anywhere because the key was, technically, set.
	//
	// A JSON null leaf in the ordinary save batch is how that is said now:
	// majestic removes the key, in the same round trip that writes the others,
	// so there is no window in which pad 0 is configured and no second endpoint
	// to keep in step. It replaced a `j/gpio.cgi?unset=` call that edited the
	// file with yaml-cli behind majestic's back and then waited out a deferred
	// SIGHUP.
	//
	// A majestic without that fix answers 202 and does nothing, so the check
	// below is what keeps this honest — the whole point of the feature is that
	// a coil reading "not connected" is not connected, and a save that silently
	// failed to clear one would say the opposite.
	// The name the page puts on screen, never the config key: a key is a second
	// vocabulary, readable only by someone who already knows the answer, and
	// this sentence is being read by someone who does not.
	function roleName(key) {
		const m = window.MajesticIrcutMap;
		const r = m && m.ROLES && m.ROLES.filter((x) => x.key === key)[0];
		return r ? r.label : '';
	}

	function stillSet(cleared) {
		return (cleared || [])
			.map((f) => f.dot.slice('nightMode.'.length))
			.filter((k) => isNumish(getDotted(state.config, 'nightMode.' + k)))
			.map(roleName)
			.filter(Boolean);
	}

	// The filter test's verdict names a wiring and a fix for it ("swap the two
	// coils"), so it stops being true the moment the wiring is edited — and it
	// is worst when it stays: a stale "wired backwards" tells someone to undo a
	// swap they have already made. It is remembered as the assignment it was
	// measured against and dropped as soon as that stops matching, which covers
	// a map edit, a save, a per-row reset and the scan's proposal alike (#273).
	function fieldAssign() {
		const a = {};
		PIN_KEYS.forEach((k) => {
			const f = pinField(k);
			a[k] = f ? String(f.getValue()) : '';
		});
		return JSON.stringify(a);
	}

	function syncVerdict() {
		const r = document.getElementById('mj-ircut-result');
		if (!r || r.hidden || !state.ircutTestedOn) return;
		// The scan borrows this same element, and its own hit writes the pins
		// it found — which lands here as a changed assignment. Hiding it then
		// would take the Stop button away from a sweep that is still driving
		// pads, on the one control in this UI that can stop a camera
		// answering. Only ever hide a verdict.
		if (r.classList.contains('mj-ircut-scan')) return;
		if (state.ircutTestedOn !== fieldAssign()) {
			r.hidden = true;
			state.ircutTestedOn = null;
		}
	}

	function currentAssign() {
		const a = {};
		PIN_KEYS.forEach((k) => {
			const v = getDotted(state.config, 'nightMode.' + k);
			if (isNumish(v)) a[k] = Number(v);
		});
		return a;
	}

	function ircutPanel(sec) {
		if (sec !== 'nightMode' || !IRCUT) return null;
		const box = el('div', 'mj-ircut');
		box.innerHTML =
			'<div id="mj-ircut-findings"></div>' +
			'<div class="mj-ircut-wire">' +
			'<div class="mj-ircut-map" id="mj-ircut-map"></div>' +
			'<div class="mj-ircut-roles">' +
			'<div class="mj-live-grp-head"><span class="mj-cap">Connected to</span>' +
			'<span class="mj-live-rule"></span></div>' +
			'<div id="mj-ircut-rolelist"></div>' +
			'<div class="mj-ircut-acts">' +
			'<button type="button" class="btn btn-primary btn-sm" id="mj-ircut-find">Find them for me</button>' +
			'<button type="button" class="btn btn-outline-secondary btn-sm" id="mj-ircut-run">Test the filter</button>' +
			'</div>' +
			'<div class="small text-secondary mt-2" id="mj-ircut-why" hidden></div>' +
			'<div class="small text-secondary mt-2" id="mj-ircut-status"></div>' +
			'<div id="mj-ircut-result" class="small" hidden></div>' +
			'</div></div>' +
			'<div id="mj-ircut-mon" hidden>' +
			'<div class="mj-live-grp-head mt-3"><span class="mj-cap">Light monitor</span>' +
			'<span class="mj-live-rule"></span></div>' +
			'<div class="small text-secondary mb-1" id="mj-ircut-mon-line"></div>' +
			'<div id="mj-ircut-mon-chart"></div>' +
			'</div>';

		// Wired once, gated every time.
		const btn = box.querySelector('#mj-ircut-run');
		btn.addEventListener('click', () => {
			if (btn.disabled) return;
			runIrcutTest(btn, box.querySelector('#mj-ircut-status'),
				box.querySelector('#mj-ircut-result'));
		});
		syncTestBtn();
		// The map needs the camera's real pad list, which is a fetch, so it
		// mounts late. Everything else on the section is already usable.
		mountPinMap(box);
		return box;
	}

	// The pad map, plus the role list beside it. Both are driven by one
	// assignment object; clicking either side moves the same thing.
	async function mountPinMap(box) {
		const host = box.querySelector('#mj-ircut-map');
		const list = box.querySelector('#mj-ircut-rolelist');
		if (!host || !window.MajesticIrcutMap) return;
		let info;
		try {
			const r = await apiFetch('/cgi-bin/j/gpio.cgi', { credentials: 'same-origin' });
			info = await r.json();
		} catch (e) {
			// No pad list, no map. The hidden number fields are still there, so
			// nothing is unreachable — say which door is shut and unhide them.
			host.innerHTML = '<p class="small text-secondary mb-0">' +
				'Could not read this camera\'s GPIO list, so the pin map is not available. ' +
				'The pin numbers below can still be set by hand.</p>';
			PIN_KEYS.forEach((k) => { const f = pinField(k); if (f) f.p.hidden = false; });
			layoutCols();
			return;
		}

		state.ircutInfo = info;
		const map = window.MajesticIrcutMap.mount(host, {
			info: info,
			assign: currentAssign(),
			soc: (window.mjSoc || '') + (info.banks ? ' · ' + info.banks.length + ' banks' : ''),
			onChange: (a) => { pushAssign(a); paintRoles(); },
		});
		// Leaving the section while this fetch was in flight means the panel
		// this map belongs to is already gone; mounting it now would strand a
		// second set of document listeners with nothing to remove them.
		if (state.sec !== 'nightMode') { map.destroy(); return; }
		state.ircutMap = map;
		// refresh() re-syncs the map from config with `quiet`, which suppresses
		// onChange — and onChange is what repaints this list. Without a handle
		// to it the pads moved and the roles beside them did not, so a coil the
		// camera still drives could sit under the word "not set".
		state.ircutRoles = paintRoles;

		function paintRoles() {
			syncTestBtn();
			const a = map.get();
			list.innerHTML = '';
			map.roles.forEach((r) => {
				const row = el('button', 'mj-ircut-role');
				row.type = 'button';
				const set = a[r.key] !== undefined;
				if (!set) row.classList.add('mj-ircut-role-unset');
				const dot = el('span', 'mj-ircut-rdot');
				dot.style.background = set ? r.color : '';
				row.appendChild(dot);
				const t = el('span', 'mj-ircut-rtext');
				const l = el('b');
				l.textContent = r.label;
				t.appendChild(l);
				const h = el('em');
				h.textContent = r.hint;
				t.appendChild(h);
				row.appendChild(t);
				const onChip = set && map.has(a[r.key]);
				const pin = el('span', 'mj-ircut-rpin');
				pin.textContent = set ? String(a[r.key]) : 'not set';
				row.appendChild(pin);
				if (set && !onChip) {
					// Configured, but this kernel reports no such pad — a config
					// from another SoC, or a hand-edited yaml. Saying so beats a
					// row that points at a pad which is not drawn.
					row.classList.add('mj-ircut-role-unset');
					const h = row.querySelector('.mj-ircut-rtext em');
					if (h) h.textContent = 'not a pin on this processor';
				}
				// Clicking a role selects its pad, so the two halves of the
				// panel always point at the same thing.
				row.addEventListener('click', () => {
					if (onChip) map.select(a[r.key]);
				});
				list.appendChild(row);
			});
		}
		paintRoles();

		const find = box.querySelector('#mj-ircut-find');
		// Re-read the pads rather than reusing the mount-time snapshot. That
		// snapshot carries `assigned`, and pairs() skips every pad in it — so
		// after clearing the pins and saving, the scan went on skipping the two
		// pads it was being asked to find, and reported nothing. Reloading the
		// page "fixed" it, which is the tell that the staleness was in here and
		// not on the camera (#273). The pad list can also move underneath the
		// page for reasons of its own, majestic releasing an export among them.
		if (find) find.addEventListener('click', async () => {
			let fresh = info;
			try {
				const r = await apiFetch('/cgi-bin/j/gpio.cgi',
					{ credentials: 'same-origin' });
				fresh = await r.json();
				state.ircutInfo = fresh;
			} catch (e) {
				// The cached list is stale, not wrong: every pad it names is
				// still a pad. Scanning with it beats refusing to scan.
			}
			openScan(box, map, fresh);
		});

		// A camera that came back from the dead mid-scan says so before anything
		// else — the pad that did it is named and excluded.
		const dead = window.MajesticIrcutScan &&
			window.MajesticIrcutScan.casualty(info);
		if (dead) {
			// The journal records the PAIR that was being driven, because a pair
			// is what an actuation takes. Reading one pin off it printed
			// "undefined" and excluded nothing, which left the pair that
			// rebooted the camera free to be tried again on the next scan —
			// the exact outcome the journal exists to prevent.
			const pins = (dead.pins || []).map(Number).filter((n) => !isNaN(n));
			const w = el('div', 'alert alert-warning py-2 px-3 mb-2 small');
			w.innerHTML = '<b>The last pin scan stopped the camera.</b> It was driving ' +
				(pins.length > 1 ? 'pins ' + esc(pins.join(' and ')) : 'pin ' + esc(String(pins[0]))) +
				' when it stopped answering, and the watchdog restarted it. ' +
				(pins.length > 1 ? 'Those pins have' : 'That pin has') +
				' been excluded from further scans.';
			box.querySelector('#mj-ircut-findings').appendChild(w);
			state.ircutExclude = (state.ircutExclude || []).concat(pins);
		}
	}

	// Finding the pins by driving them. This is the only control in the WebUI
	// that can stop a camera answering, so it asks first, in those words, and
	// the endpoint behind it journals each pad to flash before touching it.
	function openScan(box, map, info) {
		const SCAN = window.MajesticIrcutScan;
		if (!SCAN) return;
		const host = box.querySelector('#mj-ircut-result');
		// Taking the element over destroys whatever verdict was in it, so the
		// assignment that verdict was measured against stops meaning anything.
		state.ircutTestedOn = null;
		const status = box.querySelector('#mj-ircut-status');
		const list = SCAN.pairs(info, { exclude: state.ircutExclude || [] });
		let stop = false;

		host.hidden = false;
		host.className = 'mj-ircut-scan';
		// Dressed as a group of this section, not as an announcement inside it:
		// micro-caps head, hairline to the margin, note on the right, small body
		// — the same head the deck gives Wiring and Connected to. A lead
		// paragraph at full body size was the only 1rem text on the page.
		host.innerHTML =
			'<div class="mj-live-grp-head"><span class="mj-cap">Find the pins</span>' +
			'<span class="mj-live-rule"></span>' +
			'<span class="mj-live-note" id="mj-scan-n"></span></div>' +
			'<p class="small mb-2">Each pad is driven against another while the ' +
			'picture is watched for the filter to move. An IR-cut filter is driven ' +
			'across two pads, so pairs are what get tried; the pairs other boards ' +
			'use go first, so this usually ends in seconds.</p>' +
			'<div class="alert alert-warning py-2 px-3 mb-2 small">' +
			'<b>This drives pads whose job is unknown.</b> One of them may reset the ' +
			'network, cut power to the sensor, or stop the camera answering. That risk ' +
			'cannot be removed &mdash; only made survivable: each pad is written to flash ' +
			'before it is driven, so a camera that has to be restarted comes back knowing ' +
			'which pad did it.</div>' +
			'<p class="x-small text-secondary mb-2">Pads already spoken for are skipped. ' +
			'This reads the picture, so it needs daylight &mdash; at night nothing will ' +
			'look like it moved.</p>' +
			'<div class="d-flex gap-2 align-items-center">' +
			'<button type="button" class="btn btn-primary btn-sm" id="mj-scan-go">Start</button>' +
			'<button type="button" class="btn btn-outline-secondary btn-sm" id="mj-scan-no">Cancel</button>' +
			'</div>';
		host.querySelector('#mj-scan-n').textContent = list.length + ' pairs to try';
		host.querySelector('#mj-scan-no').addEventListener('click', () => {
			stop = true; host.hidden = true;
		});
		host.querySelector('#mj-scan-go').addEventListener('click', () => {
			host.innerHTML =
				'<div class="mj-live-grp-head"><span class="mj-cap">Scanning</span>' +
				'<span class="mj-live-rule"></span>' +
				'<span class="mj-live-note" id="mj-scan-s"></span></div>' +
				'<p class="small mb-2" id="mj-scan-t">Starting&hellip;</p>' +
				'<button type="button" class="btn btn-outline-secondary btn-sm" id="mj-scan-stop">Stop</button>';
			const t = host.querySelector('#mj-scan-t');
			const s = host.querySelector('#mj-scan-s');
			host.querySelector('#mj-scan-stop').addEventListener('click', () => { stop = true; });

			SCAN.run({
				// A refusal and a failure are not the same answer. The endpoint
				// guards pads with owners and says so with a 200 carrying
				// done:false — that pair is skipped and the sweep goes on. A
				// request that does not arrive at all is a camera that has
				// stopped answering, and flattening it into "this pair did not
				// move anything" made the scan keep firing GPIO writes at a dead
				// camera for another two hundred pairs and then report that
				// nothing moved. It rejects now, and the sweep stops.
				drive: (a, b) => apiFetch('/cgi-bin/j/gpio.cgi?pair=' + a + ',' + b,
					{ credentials: 'same-origin' })
					.then((r) => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))),
				release: (a, b) => apiFetch('/cgi-bin/j/gpio.cgi?park=' + a + ',' + b + '&mode=float',
					{ credentials: 'same-origin' })
					.then((r) => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))),
				look: () => IRCUT.snapshot('/image.jpg'),
				wait: (ms) => new Promise((r) => setTimeout(r, ms)),
				stopped: () => stop,
				onStep: (st) => {
					t.textContent = 'Trying pins ' + st.a + ' and ' + st.b;
					s.textContent = (st.index + 1) + ' of ' + st.total;
					map.sweep(st.a);
				},
			}, list).then((res) => {
				map.sweep(null);
				const found = res.pins;
				if (!found) {
					host.innerHTML = '<div class="mj-live-grp-head">' +
						'<span class="mj-cap">Find the pins</span>' +
						'<span class="mj-live-rule"></span></div>' +
						'<div class="alert alert-secondary py-2 px-3 mb-0 small">' +
						'<b>Nothing moved the picture.</b> Either the filter is on a pair this ' +
						'scan did not reach, or there is not enough light to see it move. ' +
						'Try again in daylight, or set the pins by hand.' +
						// Named because it is a real class of camera the sweep
						// cannot reach, rather than a gap in the pad list. A
						// single-pad filter is moved by HOLDING one pad at a
						// level, and holding a pad is the thing this scan may
						// not do: on a two-coil board it would leave a winding
						// carrying current, which is why every actuation here
						// is a brief pulse across a pair. So that wiring is
						// found by hand and confirmed by the test (#273).
						'<br><br>A filter driven from a single pad is not something ' +
						'this sweep can find: it works by pulsing pairs, and a ' +
						'single-pad filter is moved by holding one pad at a level, ' +
						'which is not safe to do to a pad whose job is unknown. ' +
						'If yours is wired that way, put the pad on the opening coil ' +
						'yourself and press <b>Test the filter</b>.</div>';
					return;
				}
				// The pair itself was watched moving the picture, so it is
				// reported either way; what may be missing is the classification
				// and the guarantee that the filter was left closed.
				// brakeHeld is three-valued. null is a test that did not run:
				// one of these pads is already majestic's, so it was braked
				// rather than let go of, and there is no way to see whether the
				// filter would have sprung open. Saying "it holds its position
				// on its own" from that would be a claim made about a pad
				// nothing released (#273).
				const tail = !found.settled
					? 'The checks after that did not finish, so the filter may not have ' +
						'been left closed &mdash; look at the picture before trusting it.'
					: found.brakeHeld === null
						? 'Whether it holds its position on its own was not tested: ' +
							'majestic is already driving one of these pads, and letting ' +
							'go of it here would have moved the filter.'
						: found.brakeHeld
							? 'It springs open when the pins are released, so they have to stay driven.'
							: 'It holds its position on its own.';
				host.innerHTML = '<div class="mj-live-grp-head">' +
					'<span class="mj-cap">Find the pins</span>' +
					'<span class="mj-live-rule"></span></div>' +
					'<div class="alert ' + (found.settled ? 'alert-success' : 'alert-warning') +
					' py-2 px-3 mb-2 small"><b>' +
					(found.settled ? 'Found it.' : 'Found the pins, but not cleanly.') + '</b> ' +
					'Pins ' + esc(String(found.irCutPin1)) + ' and ' + esc(String(found.irCutPin2)) +
					' drive the filter &mdash; ' + esc(String(found.closesWhenHigh)) +
					' is the one that closes it. ' + tail +
					'</div><button type="button" class="btn btn-primary btn-sm" id="mj-scan-use">' +
					'Use these pins</button>';
				host.querySelector('#mj-scan-use').addEventListener('click', () => {
					// Staged, never written behind the person's back: the map
					// fills the fields and the save bar appears like any edit.
					const a = map.get();
					a.irCutPin1 = found.irCutPin1;
					a.irCutPin2 = found.irCutPin2;
					// set() fires onChange, which pushes the fields and repaints
					// the roles — no second push needed.
					map.set(a);
					host.hidden = true;
					if (status) status.textContent = 'Pins staged — Save, then test the filter.';
				});
			}).catch((e) => {
				map.sweep(null);
				host.innerHTML = '<div class="mj-live-grp-head">' +
					'<span class="mj-cap">Find the pins</span>' +
					'<span class="mj-live-rule"></span></div>' +
					'<div class="alert alert-danger py-2 px-3 mb-0 small">' +
					'The scan could not finish: ' + esc(e && e.message ? e.message : String(e)) +
					'</div>';
			});
		});
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
			// The default has to be serialised the way the control serialises its
			// own value or the two are not comparable: an array control reads back
			// as ", "-joined (getValue → _rows().join(', ')) while String([a,b])
			// joins on a bare comma, so an untouched two-region default would count
			// as off stock. Every array default majestic ships today is [], which
			// stringifies to "" either way — this is the case that has not bitten
			// yet, not the one that cannot.
			const def = f.schema.default;
			const defStr = Array.isArray(def) ? def.join(', ') : String(def);
			if (String(f.getValue()) !== defStr) off++;
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
			// The four wiring pins render hidden rather than not at all: the pin
			// map above the form is what edits them, but they stay real fields
			// so dirty tracking, Save and the per-row reset keep working on them
			// without knowing a map exists.
			const field = renderField(container, dot, key, sub, eff,
				PIN_DOTS[dot] ? { hidden: true } : undefined);
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
	// One implementation of "does this condition hold", shared with x-requires
	// and tested in mj-requires.js. A missing module leaves every conditional
	// row shown and every requirement satisfied, which is the same fail-open
	// direction the operator itself takes.
	function visMatches(vw, v) {
		return REQ ? REQ.matches(vw, v) : true;
	}

	// Is an x-requires condition met? Unlike visibleWhen, whose `field` is a
	// sibling, this one names an absolute dotted path — what decides a setting's
	// fate is rarely its neighbour, and the case this exists for
	// (outgoing.substream needing video1.enabled) spans two tabs. So the
	// controlling field is usually NOT mounted, and the value comes from the
	// saved config; a mounted control still wins where the two share a page, so
	// an unsaved edit is reflected the same way fieldVisible reflects one.
	//
	// Shares visMatches, and with it the fail-open rule: an operator this build
	// does not understand counts as satisfied, so a newer schema can never
	// strand a warning on screen that nothing on the page can clear.
	function reqNotice(req, getSelf) {
		if (!REQ) return '';
		return REQ.notice(req, {
			self: getSelf,
			mounted: (dot) => {
				const f = (state.fields || []).find(x => x.dot === dot);
				return f ? f.getValue() : undefined;
			},
			saved: (dot) => getDotted(state.config, dot),
			// withLive, or a live-classified controlling field has no default to
			// find: sectionFields skips x-live keys unless asked for them, since
			// the Live adjustments leaf lifts those out of their own sections.
			// The lift is about where a control is DRAWN; this is asking the
			// schema what the key defaults to, and an unresolvable controlling
			// field makes met() fail open and the warning never draw at all.
			fallback: (dot) => {
				const g = sectionFields(dot.split('.')[0], true).find(x => x.dot === dot);
				return g && g.sub ? g.sub.default : undefined;
			},
		});
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
		// An x-requires condition names an absolute path, so its controlling
		// field is usually on another tab and the saved config answers for it.
		// Where it does happen to share the page, an unsaved edit to it has to
		// repaint the warning, exactly as it moves a visibleWhen row.
		for (const u of state.reqUpdaters || []) {
			const ctrl = byDot[u.req.field];
			if (!ctrl || ctrl.dot === u.dot) continue;
			ctrl.control.addEventListener('change', u.paint);
			ctrl.control.addEventListener('input', u.paint);
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
		// a saved edit can have met or broken a requirement on this page
		(state.reqUpdaters || []).forEach(u => u.paint());
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
		// Rows only: a group heading is not a setting, and counting it would spend
		// a section's budget on its own furniture — four controls under one
		// heading would be dealt into two columns while claiming to be under the
		// limit.
		const shown = items.filter(it => it.offsetHeight && it.classList.contains('mj-row')).length;
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

		// The field's two value accessors. They are declared here, above the widget
		// dispatch that builds `control`, and they reach `control._get`/`._set` on
		// every call rather than capturing whichever function is there when this
		// line runs. Both halves are the fix, and the second is what makes the first
		// safe.
		//
		// Capturing is how this crashed. The accessors used to sit at the bottom of
		// the function, beside the return that hands them out, which meant they
		// could not be declared until the branch assigning the hatches had run --
		// and the x-requires block well above them paints its warning on mount,
		// reading `getValue` to ask what the field is set to. A `const` reached
		// before its declaration is a ReferenceError, not an undefined, so the paint
		// threw, the throw left renderField, and it took every field after the
		// annotated one with it -- and the save bar, which is built after the fields
		// are. On the first camera whose schema carried the annotation the Outgoing
		// tab rendered three of its seven rows and could not be saved.
		//
		// Reading the hatches late is what retires the hazard rather than ruling it
		// out of bounds: there is no longer a line in this function above which the
		// field's value may not be read, so a new widget branch or annotation block
		// cannot reintroduce it by being written in the wrong place.
		//
		// Array fields canonicalise to a comma-joined string so dirty-tracking (a
		// plain !== against state.initial) keeps working; onSubmit splits it back
		// into a list before POSTing.
		const getValue = () => {
			if (control._get) return control._get();
			if (type === 'boolean') return control.checked ? 'true' : 'false';
			if (type === 'array') return control._rows().join(', ');
			return String(control.value);
		};

		const setValue = (v) => {
			if (control._set) return control._set(v);
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
			// comma-joined string.
			p = el('p', 'array mj-row');
			p.innerHTML =
				'<label class="form-label">' + labelHtml + '</label>' +
				'<div class="mj-array" id="' + id + '"></div>' +
				'<button type="button" class="btn btn-sm btn-outline-secondary mt-1 mj-array-add">+ Add region</button>';
			control = p.querySelector('.mj-array');
			// Whoever is drawing these rectangles wants to know when the list
			// moves — added, deleted, edited, reset. It used to be a reach into
			// a named iframe's window (`mj-roi-iframe`), which meant this field
			// could only ever be drawn by one thing, in one place, under one id.
			// A plain assignable hook says the same thing without knowing who
			// is listening, and stays a no-op where nobody is.
			control._sync = () => {};
			const onChange = () => { updateDirty(); control._sync(); };
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
			// Adding one from outside — a rectangle dragged on the picture — is
			// the same edit as typing one, so it goes through the same pair.
			control._add = (v) => { addRow(v || ''); onChange(); };
			control._drop = (i) => {
				const rows = Array.from(control.querySelectorAll('.mj-array-row'));
				if (rows[i]) { rows[i].remove(); onChange(); }
			};
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

		// A setting the daemon will quietly substitute for. The substitution is
		// the right behaviour — publishing the main stream beats publishing
		// nothing — but it used to be invisible outside the camera's log, and
		// nobody reads a camera's log. In OpenIPC/majestic#311 the reporter's
		// camera published 1080p H.265 at four times the bitrate his
		// configuration asked for, over a link he was already reporting as
		// troubled; asked to test the setting he toggled it and saw no change,
		// because with video1 off both positions mean the same thing, and
		// reported that it made no difference — which reads as the setting not
		// mattering rather than as it being inert.
		//
		// Drawn as a warning under the control rather than by hiding or
		// disabling it: the setting is a legitimate thing to want, it is
		// remembered, and it starts working the moment its requirement is met.
		// Hiding it would only move the surprise.
		if (!live && sub['x-requires'] && sub['x-requires'].field) {
			const req = sub['x-requires'];
			const warn = el('div', 'hint mj-requires');
			const paint = () => {
				const msg = reqNotice(req, getValue);
				warn.textContent = msg;
				warn.hidden = !msg;
			};
			paint();
			p.appendChild(warn);
			// Half the condition is this field's own value, so its own edits
			// have to repaint it. The ordinary input/change path runs
			// updateDirty() and nothing else, which knows nothing about this.
			//
			// Listened for on the ROW, not on `control`: both events bubble, and
			// a field's value does not always come from the one element this
			// variable points at. The resolution picker keeps its custom text box
			// as a SIBLING of the select — which is why the dirty tracker has to
			// bind that box separately — and an array field's value lives in rows
			// added and removed under it. Bound to the control alone the warning
			// would paint once at mount and then go stale under exactly the edit
			// that clears or triggers it, which is the same silence this whole
			// block exists to break.
			p.addEventListener('input', paint);
			p.addEventListener('change', paint);
			// The other half is a field that may or may not be on this page;
			// applyVisibility() wires the listener where it is.
			(state.reqUpdaters || []).push({ dot: dot, req: req, paint: paint });
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
		// A new edit outranks the last save's confirmation. renderToolbar leaves
		// the label alone while a message is set, so leaving the flash up would
		// print "Saved and applied" beside a Save button that has work to do.
		if (n && state.flashPending) setToolbarMsg('');
		renderToolbar();
		paintStock();
		// Every edit funnels through here — the map, a save, a per-row reset,
		// and the four pin fields directly, which is the path that matters when
		// the pad map could not be read and they are exposed as plain numbers.
		syncVerdict();
	}

	// One visibility rule for both buttons: show each only while its action can
	// actually be taken. A save that needs a pipeline reload leaves applyPending
	// set, so Save stands down and Apply takes its place until the reload runs.
	function renderToolbar() {
		const bar = document.getElementById('mj-toolbar');
		if (!bar) return;
		const n = state.dirtyN || 0;
		const apply = !!state.applyPending;
		const show = !!(n || apply || state.flashPending);
		bar.classList.toggle('d-flex', show);
		bar.classList.toggle('d-none', !show);

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
					? 'Saved. This change needs a pipeline reload before it takes effect (the video streams will blink briefly).'
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
		// Clearing the message also ends a flash. A flash IS a message with a
		// timer on it, and leaving flashPending set would hold the bar open
		// around nothing.
		if (!text) {
			if (state.flashTimer) clearTimeout(state.flashTimer);
			state.flashTimer = null;
			state.flashPending = false;
		}
		const lbl = document.getElementById('mj-dirty-count');
		if (!lbl) return;
		if (!text) { renderToolbar(); return; }
		lbl.className = 'me-auto small ' + (cls || 'text-danger');
		lbl.textContent = text;
	}

	// How long a save's confirmation stays up. It is the only thing holding the
	// bar open, so it has to go away on its own.
	const FLASH_MS = 6000;

	// What a successful save says when it leaves nothing pending. An in-place
	// change is carried by the save itself — no reload, no blink — so without
	// this the bar vanishes the instant Save is pressed and the operator is
	// left to guess whether anything happened. `flashPending` is the third
	// reason for the bar to exist, beside dirty changes and a due reload, and
	// renderToolbar already knows it.
	//
	// It did not exist. The call site shipped without it, inside onSubmit's
	// try, so a save that had SUCCEEDED threw a ReferenceError on its way out
	// and the catch reported "Save failed: Can't find variable: flashToolbar"
	// over a change the camera had already taken (#273).
	function flashToolbar(text) {
		if (state.flashTimer) clearTimeout(state.flashTimer);
		setToolbarMsg(text, 'text-secondary');
		state.flashPending = true;
		renderToolbar();
		state.flashTimer = setTimeout(() => {
			state.flashTimer = null;
			setToolbarMsg('');
		}, FLASH_MS);
	}

	// What a change costs, as the camera itself declares it, reduced to the
	// three answers this page can act on.
	//
	// `x-reload` is the daemon's own classification, and it is the answer to a
	// question this page used to guess at. The guess was binary: x-live, or else
	// assume the whole pipeline has to come down. That was true when the only
	// classified keys WERE the live image knobs, and it has been wrong since the
	// daemon learned the middle classes: a camera that restarts its overlay in
	// place, encoders untouched, was being reported to the operator as a pipeline
	// reload with blinking streams, and then offered a button that reloads
	// nothing.
	//
	// Matched against the vocabulary rather than passed through, because an
	// unrecognised string must fall to `pipeline` and not off the end of the
	// world: a class this page has never heard of is one it cannot claim was
	// carried, and saying nothing about it would leave the setting unapplied with
	// no Apply offered — the exact failure this function exists to prevent,
	// reached from the other side.
	//
	//   none, live            nothing left to do; the save carried it
	//   service:x, channel:n  carried too, in place, streams left running
	//   service, channel      NAMING NOTHING, which the daemon itself answers
	//                         with a pipeline rebuild, so this must agree
	//   pipeline, anything    the operator is still owed a reload
	//
	// x-live is the fallback, not the rule, because an older majestic publishes
	// it and no x-reload at all. There it still means live, and everything else
	// still means pipeline — exactly today's behaviour on those builds. A key
	// with neither is pipeline for the same reason the daemon says so: an
	// undeclared key costs the most until somebody proves otherwise.
	function changeCost(f) {
		const sc = (f && f.schema) || {};
		const spec = sc['x-reload'];
		if (typeof spec !== 'string' || !spec)
			return sc['x-live'] ? 'none' : 'pipeline';
		if (spec === 'none' || spec === 'live') return 'none';
		// The colon is the whole test: it is what tells a class that names its
		// subsystem or its channel from one that names neither.
		if (spec.indexOf('service:') === 0 || spec.indexOf('channel:') === 0)
			return spec.length > spec.indexOf(':') + 1 ? 'inplace' : 'pipeline';
		return 'pipeline';
	}

	// Only a pipeline rebuild is something the operator still has to ask for.
	// The live setters run during the save, and so do the service restarts and
	// the per-channel rebuilds — all three are carried by the same
	// POST /api/v1/config round trip, which is why none of them leaves anything
	// pending afterwards.
	function needsPipelineReload(fields) {
		return fields.some(f => changeCost(f) === 'pipeline');
	}

	// Whether the save moved anything the streams did not notice, so the page can
	// say what happened instead of going quiet. Deliberately not a count and
	// deliberately not a key name: what the operator wants to know is whether the
	// picture was interrupted.
	function appliedInPlace(fields) {
		return fields.some(f => changeCost(f) === 'inplace');
	}

	async function onSubmit(ev) {
		ev.preventDefault();
		const all = state.fields.filter(f => f.getValue() !== state.initial[f.dot]);
		// A cleared pin rides the same batch as everything else, as a null —
		// which majestic removes rather than stores. Withholding it and tidying
		// up afterwards was the older shape, and it left the two halves of one
		// save able to disagree.
		const cleared = all.filter(f => PIN_DOTS[f.dot] && String(f.getValue()) === '');
		const dirty = all;
		if (!all.length) return;

		const body = {};
		// What each field was worth when the body was built, not when the
		// response comes back: the snapshot below has to record what was
		// actually sent, and a knob can be dragged again while the POST is in
		// flight.
		const sent = new Map();
		for (const f of dirty) {
			let val = f.getValue();
			sent.set(f, val);
			// array-typed schema fields (MultiRect: roi/crop/privacyMasks) post as a
			// list of strings, not a comma-joined scalar.
			if (f.schema && f.schema.type === 'array')
				val = String(val).split(',').map(s => s.trim()).filter(s => s.length);
			// null is "remove this key". Only a cleared pin means it — an empty
			// string field is an empty string, which is a value someone chose.
			else if (cleared.indexOf(f) >= 0)
				val = null;
			setDotted(body, f.dot, val);
		}

		const btn = document.getElementById('mj-save');
		btn.disabled = true;
		btn.textContent = 'Saving…';
		setToolbarMsg('');
		clearError();
		liveSaving++;
		// Whether the camera has already taken the change. Everything after the
		// POST answers ok is the PAGE catching up — re-reading the config,
		// re-baselining, dressing the toolbar — and a throw in any of it is not
		// a save that failed. Reported as one, it tells the operator to redo a
		// change the camera is already holding, and hides a real page bug
		// behind a plausible sentence about the camera. That is what happened
		// when the toolbar's confirmation helper turned out never to have been
		// defined: the save landed and the page said "Save failed" (#273).
		let landed = false;
		try {
			if (dirty.length) {
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
			}
			landed = true;
			// The camera now holds these, so the snapshot the revert is built
			// from has to say so before anything can read it again. refresh()
			// sets the same values a moment later from the config itself — but
			// it can throw, and leaving state.initial stale through a failed
			// refresh would let a later discard "revert" the camera to values
			// that are no longer what was saved (#259).
			sent.forEach((v, f) => { state.initial[f.dot] = v; });
			await refresh();
			// refresh() has just re-read the config, so this asks the camera
			// rather than the form. A pin still holding a number here means the
			// null did not take — an older majestic, which answers 202 and
			// ignores it — and nothing else on the page would ever say so.
			const kept = stillSet(cleared);
			if (kept.length)
				// Joined with semicolons, because the role names have commas in
				// them: "IR-cut filter, closing coil, IR-cut filter, opening
				// coil" reads as four things and names none of them.
				showError('Saved, but these could not be disconnected: ' +
					kept.join('; ') + '. The camera is still configured to ' +
					'drive them; its firmware may be too old to clear a setting.');
			// Ask the camera what this cost rather than assuming the worst.
			// Only a pipeline-class change is still owed a reload; a service
			// restart or a channel rebuild already happened inside the save,
			// with the rest of the pipeline left running.
			if (needsPipelineReload(dirty))
				state.applyPending = true;
			else if (appliedInPlace(dirty))
				flashToolbar(
					'Saved and applied. The video streams were not interrupted.');
		} catch (e) {
			// Accepted, not verified. The POST answering ok means majestic
			// took every leaf and saved once — but the page's own confirmation
			// of what the camera now holds is the step that just threw, and on
			// an older daemon a cleared pin comes back 202 and is ignored. So
			// this says what is known and hands the reader the way to find out
			// the rest, rather than swapping one confident wrong answer for
			// another.
			showError(landed
				? 'The camera accepted the change, but the page could not ' +
					'read back what it is holding now: ' + e.message +
					'. Reload the page before changing anything else.'
				: 'Save failed: ' + e.message);
		} finally {
			liveSaving--;
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
		// The stage settles one thing at mount that this may have just changed:
		// whether there is a substream to offer. Enabling video1 is done on
		// another section of this same page, so the picker would otherwise go on
		// refusing a channel that now exists until the leaf was re-opened.
		if (state.preview) state.preview.syncConfig();
		// The map holds its own copy of the assignments, taken once at mount.
		// A save or a per-row reset changes the fields underneath it, and the
		// next edit on the map would push its whole stale set back — restoring
		// pins the refresh had just removed.
		if (state.ircutMap) state.ircutMap.set(currentAssign(), { quiet: true });
		// The pads are only half of it; the role list is drawn from onChange,
		// which `quiet` just skipped.
		if (state.ircutRoles) state.ircutRoles();
		syncTestBtn();
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
