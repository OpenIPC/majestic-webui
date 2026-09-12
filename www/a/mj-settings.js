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
	const FONTS = boot.fonts || [];
	// The part this camera is. Read from the boot blob, which camera.cgi fills
	// from sysinfo — it used to be read from `window.mjSoc`, a global no file in
	// this tree ever assigned, so the pin map's caption was empty on every
	// camera and the pin sweep had no way to know what it was scanning.
	const SOC = boot.soc || '';

	// The name a font file goes by. The setting stores a path — freetype takes
	// one — but a path is not what anybody chooses between: on the camera this
	// was written against there is exactly one face and its row read
	// "/usr/share/fonts/truetype/UbuntuMono-Regular.ttf", which is thirty
	// characters of directory in front of the four that vary.
	function fontName(path) {
		const base = String(path).split('/').pop();
		return base.replace(/\.(ttf|otf|ttc)$/i, '') || base;
	}

	// Whether this key names the file an overlay is drawn with. Both spellings,
	// because the flat osd.font IS overlay 0's and the rest are nested under it.
	function isFontPath(dot) {
		return dot === 'osd.font' || /^osd\.overlays\.\d+\.font$/.test(dot);
	}

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
	//
	// No Neutral. It was the four schema defaults under another name, and the
	// strip's Stock control already puts those back — two buttons for one
	// effect, side by side (#355). The status line under the chips still says
	// "Stock" when every knob is at its default, judged against the schema
	// rather than against a row of 50s, so the state has a name without a
	// second button to reach it.
	const LIVE_PRESETS = [
		{ id: 'indoor',   label: 'Indoor',    v: { luminance: 52, contrast: 46, saturation: 52, hue: 50 } },
		{ id: 'outdoor',  label: 'Outdoor',   v: { luminance: 46, contrast: 58, saturation: 54, hue: 50 } },
		{ id: 'lowlight', label: 'Low light', v: { luminance: 60, contrast: 42, saturation: 38, hue: 50 } },
	];

	// The eight ways up a picture can be — every quarter turn of the frame, and
	// the mirror image of each — drawn as the letter F, which the reporter of
	// #316 asked for back after a spell of arrows: an F is asymmetric both
	// ways, so each of the eight is a different shape, which is the whole
	// reason image tooling draws its orientation chart with one. The config
	// stores three switches — mirror, flip, a quarter turn — that reach twelve
	// states for these eight pictures; each cell writes one canonical triple,
	// and the lit cell is worked out from whatever the config holds, so a
	// camera configured by hand lights the right picture too.
	//
	// The arithmetic. The sensor mirrors and flips first; the VPSS then turns
	// the result clockwise. A vertical flip is a mirror plus a half turn, so a
	// picture is (mirrored k, turned a) with k = mirror + flip mod 2 and
	// a = turn + 180·flip mod 360. Going back, a half turn is written as
	// mirror + flip — the sensor does that for free — and everything else as
	// a mirror and a quarter turn.
	const ORIENT = [
		{ k: 0, a: 0,   label: 'Normal',      title: 'As the sensor sees it', home: true },
		{ k: 0, a: 90,  label: '90°',         title: 'Turned a quarter clockwise' },
		{ k: 0, a: 180, label: '180°',        title: 'Upside down' },
		{ k: 0, a: 270, label: '270°',        title: 'Turned a quarter anticlockwise' },
		{ k: 1, a: 0,   label: 'Mirror',      title: 'Mirrored left to right' },
		{ k: 1, a: 90,  label: 'Mirror 90°',  title: 'Mirrored, then turned a quarter clockwise' },
		{ k: 1, a: 180, label: 'Flip',        title: 'Flipped top to bottom' },
		{ k: 1, a: 270, label: 'Mirror 270°', title: 'Mirrored, then turned a quarter anticlockwise' },
	];
	const orientOf = (mirror, flip, turn) =>
		({ k: ((mirror ? 1 : 0) + (flip ? 1 : 0)) % 2, a: (turn + (flip ? 180 : 0)) % 360 });
	const configFor = (o) => (o.a === 180
		? { mirror: o.k === 0, flip: true, turn: 0 }
		: { mirror: o.k === 1, flip: false, turn: o.a });

	// The glyph: the frame the stream comes back in — portrait after a quarter
	// turn — and the F put through the same mirror-then-turn as the picture.
	const GEO_FRAME = '<rect x="1.5" y="3.5" width="17" height="13" rx="1.8" opacity="0.4"></rect>';
	const GEO_FRAME_TALL = '<rect x="3.5" y="1.5" width="13" height="17" rx="1.8" opacity="0.4"></rect>';
	function orientSvg(o) {
		const tf = 'rotate(' + o.a + ' 10 10)' + (o.k ? ' translate(20,0) scale(-1,1)' : '');
		return '<svg viewBox="0 0 20 20" width="24" height="24" fill="none" stroke="currentColor" ' +
			'stroke-width="1.3" stroke-linecap="round" aria-hidden="true">' +
			(o.a % 180 ? GEO_FRAME_TALL : GEO_FRAME) +
			'<g transform="' + tf + '"><path d="M7.6 6.8h5.2M7.6 10h3.7M7.6 6.8v6.4" stroke-width="1.7"></path></g>' +
			'</svg>';
	}

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
	// What a slider prints instead of a number when nothing is chosen. The same
	// plain word the resolution picker's "Auto · unset" entry ends on, because
	// it is the same state: the key is absent from the camera's config and the
	// camera is doing whatever it does without one.
	const UNSET_WORD = 'Unset';
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
		// the mj-tree.js instance for state.schema, built on first use
		tree: null,
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

	// The tree — which leaf every schema key is drawn on — is mj-tree.js's:
	// groups, the lifted set, absorption, what each leaf draws. Built once per
	// schema and asked through the wrappers below, so the rest of this file
	// reads as it did. It is a module because its failures are silent (a key
	// placed nowhere is a row that is simply not there) and only a module can be
	// asked by a test; tests/tree.test.js asks it where every key landed. Read
	// once, here, like REQ — but there is no page without it, so load() says so
	// rather than throwing at the first lookup.
	const TREE = (typeof window === 'object' && window.MajesticTree) || null;
	function treeOf() {
		if (!state.tree || state.tree.schema !== state.schema) {
			state.tree = TREE.build(state.schema, {
				exclude: EXCLUDE, liveOrder: LIVE_ORDER, liveId: LIVE_ID, liveLabel,
			});
			state.tree.schema = state.schema;
		}
		return state.tree;
	}
	function groups() { return treeOf().groups(); }
	function sectionFields(section, withLifted) { return treeOf().sectionFields(section, withLifted); }
	function groupLiveFields(g) { return treeOf().groupLiveFields(g); }
	function liveFields() { return treeOf().liveFields(); }
	function lifted() { return treeOf().lifted(); }
	function absorbed(sec) { return treeOf().absorbed(sec); }
	function absorbedSections() { return treeOf().absorbedSections(); }
	function leafFields(id) { return treeOf().leafFields(id); }
	function sectionGroups(sec) { return TREE && TREE.sectionGroups(sec); }
	function groupHasLive(g) {
		const o = treeOf().owner();
		return !!(o && g && o.id === g.id);
	}

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

	// The navigable leaves of one group, in the order the rail lists them: the
	// Live leaf first where the group owns it, then every section with
	// something left to draw — a section the Live leaf absorbed has none.
	function groupSections(g) {
		return treeOf().leafIds(g).map(id =>
			({ id, label: id === LIVE_ID ? 'Live adjustments' : label(id) }));
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
			// Nor is a bookmark to a section the Live leaf absorbed: an image
			// bookmark lands where the image settings are.
			if (absorbed(tab)) tab = LIVE_ID;
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

	// A member of the overlay collection, rather than a field of the camera's
	// own overlay.
	//
	// mj-tree's walk recurses into nested objects, which is what isp.iris wants
	// and what osd.overlays.<n> emphatically does not: it is an indexed
	// collection, and walked flat it puts every member's eleven fields on the
	// Overlay leaf — seventy-seven rows — while renderOsd's byKey, which keys on
	// the last dotted segment, quietly hands the panel the LAST template it saw
	// instead of the camera's own. Neither half announces itself: the page still
	// renders, still saves, and edits the wrong overlay.
	//
	// So until the item list can pick one, this leaf draws the first overlay,
	// which is the flat keys. That is the line W3 changes.
	// Both subtrees of osd.* that belong to a THING on the picture rather than
	// to the section: the operator's overlays, and the vendor mark. Without
	// the second, the mark's five placement keys render as loose rows beside
	// overlay 0's own — a second Position anchor, a second Horizontal offset,
	// with nothing to say which of the two things on the picture they move.
	function isOverlayMember(dot) {
		return /^osd\.overlays\./.test(dot) || /^osd\.mark\./.test(dot);
	}

	function matchCount(secId, q) {
		return leafFields(secId).filter(f => !isOverlayMember(f.dot) && fieldVisible(f) &&
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

	function liveLabel(key, sub) {
		const meta = LIVE_META[key];
		return meta ? meta.label : (sub.title || sub.description || key);
	}

	function stopLivePreview() {
		// The camera is the first thing this leaf changed outside its own
		// subtree, and it used to be the one thing teardown left behind (#259).
		// Before the fields go, put it back where they say it is.
		revertLive();
		revertOsdPlace();

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

	// Wired live, as renderField decided it — not merely flagged live by the
	// schema. The stream bitrate on Main stream is flagged and is not wired.
	const isLive = (f) => !!f.pushes;

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
			// beacon leaves outside the live queue because nothing can be awaited on
			// the way out — so cancelling is the whole of the ordering guarantee,
			// and it covers everything except a write already on the wire when
			// the tab closed. That one can still be reordered by the server, and
			// this page has no way to stop it.
			if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }
			if (ev.persisted) return;
			beaconOsdDrop();
			if (!state.fields.length || !liveDrift()) return;
			const q = liveQuery(liveSaved);
			if (q && navigator.sendBeacon) navigator.sendBeacon('/api/v1/image?' + q);
		};
		window.addEventListener('pagehide', onHide);
		return () => window.removeEventListener('pagehide', onHide);
	}

	// The query string /api/v1/image takes, over ALL the wired-live fields —
	// sending them together is what lets the backend apply combined settings
	// (mirror and flip need each other). `valueOf` picks what each field
	// contributes, so hold-to-compare can post the defaults through the same
	// builder rather than growing a second copy of it.
	function liveQuery(valueOf) {
		const parts = [];
		for (const f of state.fields) {
			if (!isLive(f)) continue;
			parts.push(encodeURIComponent(f.dot.split('.').pop()) + '=' +
				encodeURIComponent(valueOf(f)));
		}
		return parts.join('&');
	}

	// Live writes go through mj-queue.js: one in flight, and at most one
	// waiting behind it per statement. Why that is the policy is written out
	// there; what matters here is that order holds — hold-to-compare's two
	// writes must not swap — and that a drag on a slow camera does not leave a
	// queue of positions still arriving after the pointer has stopped.
	//
	// Without the module, the behaviour this page had before it existed:
	// serialised, so order still holds, and one request per push. Each link
	// swallows its own rejection either way, because a write that fails must
	// not wedge every write after it.
	function queued(sendOne, sig) {
		const Q = window.MajesticQueue;
		if (Q) return Q.coalesce(sendOne, Q[sig]);
		let chain = Promise.resolve();
		return (payload) => (chain = chain.then(() => sendOne(payload)));
	}

	let liveQueue = null;
	function postLive(q) {
		if (!q) return Promise.resolve(true);
		if (!liveQueue) liveQueue = queued(
			(s) => apiFetch('/api/v1/image?' + s,
				{ method: 'POST', credentials: 'same-origin' })
				.then((r) => r.ok, () => false),
			'querySig');
		return liveQueue(q);
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
		if (!TREE) {
			showFatal(form, 'The settings page cannot build its navigation: /a/mj-tree.js did not load.');
			return;
		}

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
		err.className = 'mj-error mj-notice mj-notice-danger d-none';
		err.role = 'alert';
		form.appendChild(err);

		state.fields = [];
		state.initial = {};
		state.cols = null;
		state.liveSync = [];
		// dropped with the fields they paint: a stale closure would keep
		// writing into a row that is no longer in the document
		state.reqUpdaters = [];
		state.legacyBox = null;

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
			// After the rows exist and before layoutCols deals them, so the
			// switch is dealt with everything else and the hidden set is
			// already settled when the cut is chosen.
			if (sec === 'nightMode') mountLegacy(cols.firstElementChild);
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
			' title="Automatic day/night is driving night, IR-cut and the lamp">' +
			'<a href="camera.cgi?tab=nightMode">Automatic day/night is driving night, IR&#8209;cut and the lamp</a>' +
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
		// back. Explicit === false, because absent is not off: a key the page
		// was never given is one it knows nothing about, and reading that as
		// "switched off" would grey out the control on a camera whose filter
		// is working perfectly.
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
			if (held || btn.disabled) return;
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

	// The strip's knobs back to their schema defaults — staged, exactly like the
	// per-row ↺ and for the same reason. This used to call /api/v1/reset, which
	// wrote the camera the moment it was pressed while the sliders beside it
	// did not: on a panel whose whole claim is that nothing is written until
	// Save, it was the one control that broke the rule. The rest of the page
	// keeps the server-side reset, where every row behaves that way.
	//
	// The four tone knobs only — the ones the Scene presets name, which is the
	// vocabulary the strip and the button share. The button's title says four;
	// mirror and flip are wired live too, and resetting them from here turned
	// the picture over on a press that promised to touch brightness — and would
	// now leave the quarter turn beside them where it was, half an orientation
	// reset. Orientation is a mounting decision, not a tone, and stays put; so
	// does any integer a future schema lifts beside these, until a preset
	// learns it.
	const TONE_KEYS = new Set(Object.keys(LIVE_PRESETS[0].v));
	function resetLiveAll() {
		for (const f of state.fields) {
			if (!isLive(f) || !TONE_KEYS.has(f.key)) continue;
			if (f.schema.default === undefined) continue;
			setLive(f, f.schema.default);
		}
	}

	// Mirror, flip and the quarter turn are three switches in the config and
	// eight pictures to a person, so the group is the eight pictures. The three
	// fields stay real — hidden — so Save, dirty tracking, the reset arrow and
	// refresh() never learn that a pad exists. The quarter turn is the one of
	// them that is not live: a VPSS operation that swaps the stream's width and
	// height, hence a pipeline reload rather than a knob, and that difference
	// in cost once decided where it was drawn — on a page of its own, each
	// page pointing at the other (#316). Which way up the camera is mounted is
	// one decision, and this is the picture it is judged against; the save bar
	// that appears on a press says what the press costs, so the group carries
	// no note. Only the pictures this camera can reach are offered: a build
	// without a quarter turn has four, in one row, and one whose enum lists a
	// single turn has six — a cell for a turn the enum lacks would write a
	// value the hidden select cannot hold, and stage an empty one for Save.
	function renderOrientation(body, mirrorField, flipField, turn) {
		const turnField = turn ? turn.field : null;
		const cells = ORIENT.filter(o => o.a % 180 === 0 || (turn && turn.has.has(String(o.a))));
		const rows = [el('div', 'mj-geo-row'), el('div', 'mj-geo-row')];
		const btns = cells.map((o, i) => {
			const b = el('button', 'mj-geo' + (o.home ? ' mj-geo-home' : ''));
			b.type = 'button';
			b.title = o.title;
			b.innerHTML = orientSvg(o) + '<span>' + esc(o.label) + '</span>';
			b.addEventListener('click', () => {
				const c = configFor(o);
				setLive(mirrorField, c.mirror);
				setLive(flipField, c.flip);
				if (turnField) setLive(turnField, String(c.turn));
			});
			rows[i < 4 ? 0 : 1].appendChild(b);
			return b;
		});
		rows.forEach(r => { if (r.childElementCount) body.appendChild(r); });

		const sync = () => {
			let turn = 0;
			if (turnField) {
				const t = Number(turnField.getValue());
				if (Number.isFinite(t)) turn = t;
			}
			const cur = orientOf(toBool(mirrorField.getValue()), toBool(flipField.getValue()), turn);
			cells.forEach((o, i) => {
				const on = o.k === cur.k && o.a === cur.a;
				btns[i].classList.toggle('mj-geo-on', on);
				btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
			});
		};
		[mirrorField, flipField, turnField].forEach(f => {
			if (!f) return;
			f.control.addEventListener('input', sync);
			f.control.addEventListener('change', sync);
		});
		// refresh() pushes values in with setValue and fires no events, so the
		// pad has to be told to re-read after a save or a reset.
		state.liveSync.push(sync);
		sync();
	}

	// The quarter turn's field, mounted hidden under the pad — pin-map style —
	// where the schema has one, handed back with the set of turns its enum
	// actually lists so the pad offers no other. The enum is deliberately
	// ["0","90","270"]: 180 is absent because mirror+flip already give it, at
	// sensor level and for free, which is exactly how configFor() writes it.
	function mountTurnField(body, sec) {
		const dot = sec + '.rotate';
		if (EXCLUDE.has(dot)) return null;
		const sub = (((state.schema.properties || {})[sec] || {}).properties || {}).rotate;
		if (!sub || sub.type !== 'string' || !Array.isArray(sub.enum)) return null;
		// Whole degrees only, and at least one that is not zero: a value the
		// pad could not turn by would be a cell that draws nothing.
		const turns = sub.enum.map(String).filter(v => /^\d+$/.test(v));
		if (!turns.some(v => v !== '0')) return null;
		const field = renderField(body, dot, 'rotate', sub, getDotted(state.config, dot), { hidden: true });
		if (!field) return null;
		state.fields.push(field);
		state.initial[dot] = field.getValue();
		return { field, has: new Set(turns) };
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
			// "Stock" is what somebody inheriting this camera needs to hear, and
			// it outranks a preset match: a preset that happens to equal the
			// defaults is still the untouched camera.
			const off = tone.filter(f => f.schema.default !== undefined &&
				Number(f.getValue()) !== Number(f.schema.default)).length;
			let head, tail;
			// "Stock" is a claim about the SCHEMA's defaults, so it is answered
			// by comparing against them — never by matching a row of a table
			// that hard-codes numbers. On a build whose defaults are not 50,
			// matching a preset and being at the factory setting are different
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
		let cmpBtn = null;
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
			cmp.innerHTML = ICON.compare + '<span>Hold to compare</span>';
			preview.barInsert(cmp);
			cmpBtn = cmp;

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

		// Hold to compare shows the picture at stock while it is held. At stock
		// there is nothing to compare, and a press that changes nothing read as
		// a button that does nothing (#316) — so it is disabled there, and its
		// title says what it compares against either way. Re-asked on every
		// edit and after a refresh, the same way the pad re-reads its fields.
		if (cmpBtn) {
			const syncCompare = () => {
				const off = state.fields.some(f => isLive(f) && f.schema &&
					f.schema.default !== undefined &&
					String(liveValue(f)) !== String(liveDefault(f)));
				cmpBtn.disabled = !off;
				cmpBtn.title = off
					? 'Hold to see the picture at stock; release to come back'
					: 'Nothing to compare: every knob is at stock';
				cmpBtn.setAttribute('aria-label', cmpBtn.title);
			};
			for (const f of state.fields) {
				if (!isLive(f)) continue;
				f.control.addEventListener('input', syncCompare);
				f.control.addEventListener('change', syncCompare);
			}
			state.liveSync.push(syncCompare);
			syncCompare();
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
			if (mf && ff) {
				const geo = liveGroup(colGeo, 'Orientation', '');
				renderOrientation(geo, mf, ff, mountTurnField(geo, mirror.section));
			}
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

		// The leftovers of a section this leaf absorbed — on this build, the
		// image section's Automatic tuning — as the ordinary rows they would
		// have been on a page of their own, in a card under the deck. Generic on
		// purpose: the rows come from the schema, so a key the section grows
		// tomorrow lands here rather than on a page that no longer exists. What
		// the deck already claimed (the quarter turns) is skipped by dot.
		const claimed = new Set(state.fields.map(f => f.dot));
		for (const sec of absorbedSections()) {
			if (!sectionFields(sec).some(f => !claimed.has(f.dot))) continue;
			const card = el('div', 'card mj-live-rest');
			const body = el('div', 'card-body');
			const head = el('div', 'mj-live-head');
			const h = el('h3', 'mj-cap');
			h.textContent = label(sec);
			head.appendChild(h);
			head.appendChild(el('span', 'mj-live-rule'));
			body.appendChild(head);
			const cols = el('div', 'mj-cols');
			cols.appendChild(el('div', 'mj-col'));
			cols.appendChild(el('div', 'mj-col'));
			state.cols = cols;
			body.appendChild(cols);
			card.appendChild(body);
			form.appendChild(card);
			renderProps(cols.firstElementChild, sec,
				((state.schema.properties || {})[sec] || {}).properties || {}, claimed);
		}
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
			// Regions are in the main stream's pixels and the picture may be
			// the sub stream; how one lands on the other is the camera's to
			// say, and it says so in the same report the Overlay leaf polls.
			// Asked once here — a crop cannot change under a running
			// pipeline — and the outlines are redrawn when it answers.
			refreshOsdRects().then(() => repaint());
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
			// The camera's own word for the main stream's size, where it has
			// given one. It is not always video0.size: a crop on the main
			// stream makes the stream the crop's size, and the rectangles
			// are written in THAT.
			const m = camView();
			if (m) return m.b;
			const cfg = parseWH(getDotted(state.config, 'video0.size'));
			if (cfg) return cfg;
			const f = preview.frame();
			return (f && preview.stream() === 0) ? { w: f.w, h: f.h } : null;
		}

		// How a main-stream rectangle lands on the stream being shown, as
		// the camera draws it. The two are not the same picture when either
		// stream is cropped: the camera maps through the sensor's frame, and
		// drawn as a plain ratio of the main stream the outline sat on the
		// wrong part of the sub stream, beside the camera's block on the
		// right part (#340). Null until the camera has said, and then the
		// ratio is right exactly when neither stream is cropped.
		function camView() {
			return RGN.view(camRects.group, camRects.views, 0, preview.stream());
		}

		// EVERY conversion between a rectangle and pixels on screen goes
		// through here, in both directions, so that the outline, the press
		// that picks it up, the drag that moves it and the band that draws a
		// new one cannot disagree about where the picture is. `b` is the
		// main frame, the space rectangles are written in; `f` the frame the
		// picture on screen shows; k and o the map between them.
		function geom() {
			const p = pic(), b = base();
			if (!p || !b) return null;
			// NOT BEFORE THE CAMERA HAS ANSWERED. Until it has, whether the
			// ratio is right is unknown, and an outline drawn by it on a
			// cropped camera sits on the wrong part of the picture until the
			// answer arrives and moves it. A camera with no such endpoint at
			// all is a different state, and one the ratio is the only answer
			// for; so is one that answered without saying, which is a backend
			// that draws every stream by the ratio itself.
			if (camRects.ok && !camRects.known) return null;
			const m = camView();
			const f = m ? m.f : b;
			const k = m ? m.k : { x: 1, y: 1 };
			const o = m ? m.o : { x: 0, y: 0 };
			return {
				p: p, b: b,
				sx: (x) => p.x + (k.x * x + o.x) / f.w * p.w,
				sy: (y) => p.y + (k.y * y + o.y) / f.h * p.h,
				mx: (s) => ((s - p.x) / p.w * f.w - o.x) / k.x,
				my: (s) => ((s - p.y) / p.h * f.h - o.y) / k.y,
				dx: (d) => d / p.w * f.w / k.x,
				dy: (d) => d / p.h * f.h / k.y,
			};
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
			const g = geom();
			layer.innerHTML = '';
			if (!g) return;
			list().forEach((raw, i) => {
				const r = parse(raw);
				if (!r) return;
				const box = el('div', 'mj-md-rgn' + (i === sel ? ' mj-md-sel' : ''));
				box.dataset.i = String(i);
				const l = g.sx(r.x), t = g.sy(r.y);
				box.style.left = l + 'px';
				box.style.top = t + 'px';
				box.style.width = (g.sx(r.x + r.w) - l) + 'px';
				box.style.height = (g.sy(r.y + r.h) - t) + 'px';
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
			// geom() is also null while the camera has not yet said how this
			// picture maps, which is the same state as no picture: nothing
			// can be placed on it yet, and the button says so the same way.
			const usable = !!p && !noBase && active && !!geom();
			btn.disabled = !usable;
			btn.title = noBase ? W.base
				: (!usable ? 'Waiting for the picture' : W.drawHint);
			// The crosshair is the disclosure that a bare drag does something,
			// so it tracks whether a drag CAN do something rather than whether
			// the button has been pressed. On the stage as well as the media, so
			// it reads the same over the letterbox.
			preview.stage.classList.toggle('mj-md-armed', usable);
			catcher.hidden = !usable;
			// The rectangles are pointer-events: auto so that what a press lands
			// on decides the gesture. That has to stop when this editor is not
			// the one in charge, or a mask keeps swallowing presses meant for
			// the overlay underneath it — which until now was prevented only by
			// the ORDER the two were mounted in, an arrangement nothing stated
			// and anything could have reordered.
			layer.style.pointerEvents = active ? '' : 'none';
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
			pushLive();
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
			// Not while another editor owns the picture. This listener is on
			// `document` and used to fire whenever there was a selection at all,
			// so with two editors on one picture both claimed Escape and Delete
			// and the one that answered was whichever mounted last. `active` is
			// the same flag the drag surface is gated on, so the keyboard now
			// follows the pointer rather than racing it.
			if (!active) return;
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

		// Everything below works in STREAM pixels once the gesture starts, so
		// a region cannot drift by a rounding step per pointermove the way it
		// would if each move re-read the rectangle it had just written. The
		// stage-to-stream step is geom()'s dx/dy.

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
			pushLive();
			return v;
		}

		// The camera follows the drag, where the caller wired it to.
		//
		// Without this a mask was the one thing on this picture that did not
		// move until Save, while the text beside it followed the pointer — so
		// the same gesture on the same picture behaved two different ways. The
		// daemon classes osd.privacyMasks live and moves the covers with one
		// call per stream, which is what makes this the same promise the
		// placement already makes: nothing saved, nothing rebuilt.
		function pushLive() {
			if (words.onLive) words.onLive(list().filter(Boolean).join(','));
			if (onEdit) onEdit();
		}

		// Removing a region renumbers every one after it, and the selection is an
		// index — so deleting row 1 of 3 while row 2 is selected would hand the
		// handles and the Delete key to what used to be row 3. Every delete goes
		// through here.
		function removeAt(i) {
			if (sel === i) sel = -1;
			else if (sel > i) sel -= 1;
			ctl._drop(i);
			pushLive();
		}

		let onEdit = null;

		// Told, not asked. select() already returns early on no change, so a
		// listener here cannot loop back into it.
		let onSelect = null;
		function select(i) {
			if (sel === i) return;
			sel = i;
			paintBoxes();
			if (onSelect) onSelect(i);
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

		// Where a region is on the stage, in the stage's own pixels. The DOM
		// knows this too, but only while the layer is taking the pointer — and
		// the whole point of this pair is to answer for an editor that is NOT
		// the one in charge, whose rectangles are deliberately pointer-
		// transparent so they cannot swallow presses meant for what is under
		// them.
		function boxOf(i) {
			const g = geom();
			if (!g) return null;
			const r = parse(list()[i]);
			if (!r) return null;
			const l = g.sx(r.x), t = g.sy(r.y);
			return {
				x: l, y: t,
				w: g.sx(r.x + r.w) - l, h: g.sy(r.y + r.h) - t,
			};
		}

		// Which region a press is reaching for, asked by whoever owns the
		// picture at the time. The SMALLEST one under the press wins an
		// overlap — the same rule the text overlays are picked by, and for the
		// same reason: a small rectangle inside a large one is the one being
		// reached for, and the large one can be taken anywhere else along its
		// span.
		function hitAt(pt) {
			let found = null;
			list().forEach((raw, i) => {
				const o = boxOf(i);
				if (!o) return;
				if (pt.x < o.x || pt.x > o.x + o.w) return;
				if (pt.y < o.y || pt.y > o.y + o.h) return;
				const a = o.w * o.h;
				if (!found || a < found.area) found = { i: i, area: a };
			});
			return found;
		}

		// Taking hold of a region from a press that arrived somewhere else —
		// another editor's catcher handing the gesture over because the press
		// landed here. Capture goes on THIS editor's catcher rather than on
		// whatever the pointer is physically over, or the moves and the release
		// would be delivered to the surface that has just given the gesture
		// away and this drag would end where it started.
		function grabAt(i, e) {
			const p = pic(), b = base(), o = parse(list()[i]);
			if (!p || !b || !o || gesture) return;
			select(i);
			gesture = { kind: 'move', id: e.pointerId, i: i,
				from: at(e), orig: o, moved: false };
			try { catcher.setPointerCapture(e.pointerId); } catch (err) {}
			e.preventDefault();
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

			// ONE RULE ACROSS BOTH EDITORS: the smallest thing under the press
			// is the one being reached for.
			//
			// The DOM answers for this editor's own rectangles; a text overlay
			// is not a DOM rectangle at all — the camera draws it and the leaf
			// hit-tests against the rectangles the camera reports — so the two
			// answers have to be COMPARED rather than merely stacked. Stacking
			// is what was wrong before: whichever editor was not in charge had
			// its layer made pointer-transparent, so a press on a mask dragged
			// the selected text, and a mask large enough to contain the text
			// made that text unreachable for as long as the mask was selected.
			//
			// A grip is exempt. It is a control rather than a picture, it only
			// exists on the selected region, and a press on one can only ever
			// mean resize that region.
			if (!grip) {
				const mine = boxEl ? boxOf(+boxEl.dataset.i) : null;
				const myArea = mine ? mine.w * mine.h : Infinity;
				const seen = words.pickAt && words.pickAt(at(e), 'mask', true);
				// Asked twice on purpose: the probe decides, and only the
				// second call selects, so measuring cannot move the selection.
				if (seen && seen.area < myArea) {
					const other = words.pickAt(at(e), 'mask');
					if (other) { other.grab(e); return; }
				}
			}

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
			const g = geom();
			if (!g) { band.hidden = true; return; }
			const b = g.b;
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
			const d = { dx: g.dx(n.x - gesture.from.x), dy: g.dy(n.y - gesture.from.y) };
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
				const gm = geom();
				if (r && gm) {
					// A rectangle has to be deliberate. Per AXIS, and a share of the
					// stage with an absolute floor, so it means the same thing on a
					// 2560px monitor and a 390px phone.
					const minW = Math.max(16, preview.stage.clientWidth * 0.02);
					const minH = Math.max(16, preview.stage.clientHeight * 0.02);
					if (r.w >= minW && r.h >= minH) {
						const X = Math.round(gm.mx(r.x)), Y = Math.round(gm.my(r.y));
						const W = Math.round(gm.mx(r.x + r.w)) - X;
						const H = Math.round(gm.my(r.y + r.h)) - Y;
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

		// Over something this editor does not own, the press means "pick that
		// one up" rather than "start drawing here", and the cursor is the only
		// place that can be disclosed before the press commits to one of them.
		catcher.addEventListener('pointermove', (e) => {
			if (gesture) return;
			const other = words.pickAt && words.pickAt(at(e), 'mask', true);
			catcher.classList.toggle('mj-osd-pickable', !!other);
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
			// The selection, for a caller that lists these things somewhere else
			// and has to agree with the picture about which one is current.
			// Reading it is free; writing it goes through the same select() a
			// click does, so there is one path and one repaint.
			selected: () => sel,
			selectAt: (i) => select(i),
			// The same removal the × on the selected rectangle performs, for a
			// caller that lists these somewhere else and has to offer it the
			// same way it offers the others'.
			removeAt: (i) => removeAt(i),
			// Answering for this editor when it is not the one in charge: which
			// region is under a point, and taking hold of it from a press that
			// landed on somebody else's surface.
			hitAt: hitAt,
			grabAt: grabAt,
			onSelect: (fn) => { onSelect = fn; },
			count: () => list().length,
			// One region's rectangle, read and written, for a caller that
			// shows the selected one somewhere else. Through the same inputs
			// and the same repaint the list's own boxes use, so there is one
			// source of truth and not a second copy to keep in step.
			rectAt: (i) => {
				const v = list()[i];
				return v === undefined ? '' : v;
			},
			setRectAt: (i, v) => {
				const src = inputs()[i];
				if (!src) return;
				src.value = v;
				src.dispatchEvent(new Event('input', { bubbles: true }));
				src.dispatchEvent(new Event('change', { bubbles: true }));
				pushLive();
			},
			// What the list is showing, so a caller can repaint its own view of
			// it when a drag moves the numbers.
			onEdit: (fn) => { onEdit = fn; },
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
		const all = sectionFields('osd', true);
		const fields = all.filter(f => !isOverlayMember(f.dot));

		// WHATEVER IS STAGED ON THE CAMERA, THIS PAGE IS ABOUT TO DRAW THE
		// CONFIG. So the camera is put back to the config first, and the two
		// agree from the first frame.
		//
		// A live push is the camera's, not this tab's: it moves the picture for
		// every viewer and for the recording, and it stays in force until
		// somebody takes it off. The page that staged it does that on its way
		// out — Save, leaving the leaf, closing the tab — but a tab that dies
		// between those (a crash, a sleep, a pulled cable) sends nothing, and
		// the override outlives it. What the next person then opens is a
		// picture that disagrees with every number on the page: the outline
		// where the config says the mask is, and the camera's grey block
		// somewhere else. For a privacy mask that is not merely confusing,
		// because the block left staged can be somewhere that hides LESS than
		// the saved list does.
		//
		// Unconditional, and not guarded by whether THIS page pushed: the whole
		// point is the override that no live page is answering for. The cost of
		// getting it wrong is one dropped preview in another browser, whose
		// very next pointermove pushes it again.
		// ONCE PER VISIT, not on every mount of this leaf.
		//
		// What this is for is the override no live page is answering for: a
		// tab that died between staging one and taking it off. That is a
		// question about the camera when this page arrives, and it has an
		// answer the first time it is asked. Asking it again every time the
		// leaf is remounted — a tab switched away from and back, a save, a
		// search that rebuilds the form — turned a one-off reconciliation
		// into a repeated one, and every repeat is a chance to drop the
		// placement somebody else is in the middle of dragging.
		//
		// It does not make this safe for two people editing at once; nothing
		// here can, since the camera holds one override and cannot say whose.
		// It makes the window one moment per visit instead of one per mount,
		// and the other editor's next pointermove stages theirs again.
		if (!state.osdReconciled) {
			state.osdReconciled = true;
			revertOsdPlace(true);
		}

		// Which overlays this camera can draw, and the fields of each.
		//
		// The flat osd.* keys are overlay 0 — every config in the field has them
		// there and majestic reads them as the first line — and osd.overlays.<n>
		// is the rest. How many there are is the CAMERA's answer: it declares an
		// index only where its region model can address one, so a build that
		// draws a single overlay describes none of these and the Add button
		// below never appears. Adding an index the schema does not carry would
		// be offering a line the camera silently would not draw.
		const extra = {};
		const markFields = [];
		for (const f of all) {
			const m = /^osd\.overlays\.(\d+)\./.exec(f.dot);
			if (m) (extra[m[1]] = extra[m[1]] || []).push(f);
			else if (/^osd\.mark\./.test(f.dot)) markFields.push(f);
		}
		const OVERLAYS = [0].concat(
			Object.keys(extra).map(Number).sort((a, b) => a - b));

		const head = el('div', 'mj-live-head');
		head.innerHTML = '<h3 class="mj-cap">' + esc(label('osd')) + '</h3>' +
			'<span class="mj-live-rule"></span>';
		const note = el('span', 'mj-live-note');
		head.appendChild(note);
		form.appendChild(head);

		// ── the picture and its inspector, side by side ─────────────────
		//
		// The inspector used to float ON the picture. That put the settings
		// next to the thing they change, which was the point, and it also
		// covered a fifth of the video on the only screen most people have —
		// and this page has a whole settings column to the right of a rail,
		// most of which was empty while the panel sat on the video.
		//
		// It also cost more than the pixels it covered: a picture sized from
		// the viewport height, plus a bar and an item list under it, put the
		// item list at or below the fold on a laptop. Beside the picture the
		// column carries the settings, the picture keeps its own width, and
		// what is under it stays on screen.
		//
		// Below lg the row wraps and the inspector goes back under the
		// picture, which is where it already went on a narrow stage.
		const work = el('div', 'mj-osd-work');
		const picCol = el('div', 'mj-osd-pic');
		const sideCol = el('div', 'mj-osd-side');
		work.appendChild(picCol);
		work.appendChild(sideCol);
		form.appendChild(work);

		let repaint = () => {};
		const preview = window.MajesticPreview &&
			window.MajesticPreview.mount(picCol, {
				config: () => state.config,
				where: 'osd',
				onFrame: () => repaint(),
			});
		state.preview = preview;

		// ── the picture belongs to the overlay ───────────────────────────
		//
		// An overlay can be in any of nine places, so the player's own
		// furniture may be in none of them. The bar is pinned to the bottom
		// edge of the stage, which is exactly where the commonest overlay of
		// all goes: on a stock camera the timestamp and the snapshot and
		// fullscreen buttons are drawn on top of one another, and the overlay
		// wins because the camera burned it into the stream. Shipped
		// behaviour, and the reason it survived is that nothing errors — it
		// just looks untidy and the two controls a person reaches for most on
		// this page are the ones underneath it.
		//
		// Down here the bar costs a row of page and nothing of picture. Moving
		// the node rather than restyling it in place keeps mj-preview.js the
		// only thing that builds a bar; this leaf only says where it goes.
		let barRow = null;
		if (preview) {
			preview.stage.classList.add('mj-osd-stage');
			barRow = el('div', 'mj-osd-bar box');
			barRow.appendChild(preview.bar);
			preview.stage.insertAdjacentElement('afterend', barRow);
		}

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
		if (!preview) sideCol.remove();

		// ── the inspector ────────────────────────────────────────────────
		//
		// What an overlay says, how it looks and where it goes are the three
		// questions you ask WHILE looking at it, and on a 1440x900 laptop the
		// deck that held them is entirely below the fold: the picture is sized
		// from the viewport height, so the settings start under it. The answer
		// is not a shorter picture. It is that the settings for the thing you
		// clicked come to the thing you clicked.
		//
		// The tabs are containers and nothing more. Every control below still
		// mounts through renderField() and buildTemplate() exactly as it did
		// when they were columns in a deck — this only says where. That is what
		// keeps Save, dirty tracking, the per-row reset and the schema's own
		// visibleWhen rules working without any of them learning a panel exists.
		const panel = preview ? mountOsdPanel(preview, sideCol) : null;
		const textBody = panel ? panel.tab('text') : liveGroup(colText, 'Text', 'what it says');
		const lookBody = panel ? panel.tab('look') : liveGroup(colLook, 'Legibility', '');
		const placeBody = panel ? panel.tab('place') : colText;
		// Whether anything is shown at all is not a question about the overlay
		// you are editing — it is a question about the leaf — so it stays on
		// the page rather than joining the panel.
		//
		// ON THE ITEM BAR, not in a card. One switch was taking a deck, a
		// column, a group heading and a rule across the full width of the page,
		// which on a laptop pushed it off the bottom of the screen entirely —
		// a control both enormous and invisible. It is the small switch and the
		// short word the design puts on the bar, in the inline shape the live
		// rows already use, and it sits beside the items because whether they
		// are drawn is the one question about all of them at once.
		const onBar = el('span', 'mj-osd-enable');
		onBar.title = 'Draw text and pictures on the video. ' +
			'Privacy masks are not affected by this.';
		const onBody = preview ? onBar : liveGroup(colLook, 'Overlay', '');

		// NOT APPENDED HERE. Where the picture can be drawn on, the inspector
		// says everything about the selected mask — its rectangle, and what a
		// mask costs — and this said it again, under a heading of its own,
		// across the full width of the page. It is still the only way to edit
		// one where there is no picture to draw on, so it goes onto the page
		// exactly there, and nowhere else.
		const maskDeck = el('div', 'mj-live-deck');
		const colMask = el('div', 'mj-live-col');
		maskDeck.appendChild(colMask);
		const maskBody = liveGroup(colMask, 'Privacy masks', 'none');
		const maskNote = colMask.querySelector('.mj-live-grp-head .mj-live-note');

		// Where each field goes.
		//
		// The placement five are ROWS again, in the Place tab, which is what
		// #340 asked for: they were rendered hidden and driven only by the drag,
		// so a position could only be as accurate as the mouse was and could not
		// be reproduced on the next camera. The anchor keeps a pad above it —
		// nine cells that are the nine anchors, in the arrangement they name —
		// but the pad writes the row rather than replacing it, and the schema's
		// own visibleWhen still decides which offsets are shown for the anchor
		// in force. Nothing here is hidden from Save or from the reset arrow.
		const PLACE = { anchor: 1, offsetX: 1, offsetY: 1, posX: 1, posY: 1 };

		// Every overlay's controls, mounted at once, each into its own slot of
		// the panel's three tabs. All of them exist from the start and only the
		// selected one is shown, which is what lets two overlays be edited and
		// saved together — and what keeps Save, dirty tracking and the per-row
		// reset from ever learning that a selector exists.
		const placers = {};
		const HELD = {};
		// What each overlay's picker holds of its picture, for the stand-in.
		const logos = {};
		// Whether each overlay draws a picture, and which one the panel is
		// showing — the tab strip is the selected overlay's, not everyone's.
		const kinds = {};
		let shownKind = 0;
		// The panel's own box for the selected mask's rectangle.
		let maskCo = null;
		for (const n of OVERLAYS) {
			const list = n === 0 ? fields : extra[String(n)];
			const held = {};
			HELD[n] = held;
			const textBox = panel ? panel.slot('text', n) : textBody;
			const lookBox = panel ? panel.slot('look', n) : lookBody;
			const placeBox = panel ? panel.slot('place', n) : placeBody;
			for (const f of list) {
				const k = f.key;
				if (k === 'privacyMasks') continue;   // its own deck, below
				// `enabled` is the leaf's switch, not an overlay's, and only
				// overlay 0 carries one: whether the camera draws any text at
				// all is a different question from what each line says.
				const box = k === 'enabled' ? onBody
					: k === 'template' ? textBox
					: (PLACE[k] ? placeBox : lookBox);
				const field = renderField(box, f.dot, k, f.sub,
					getDotted(state.config, f.dot),
					// The inline switch-then-word shape, which is what makes it
					// a bar item rather than a row wanting a column.
					box === onBar ? { live: true } : undefined);
				if (!field) continue;
				state.fields.push(field);
				state.initial[f.dot] = field.getValue();
				held[k] = field;
			}
			if (panel && held.anchor)
				panel.pad(held, placeBox, () => placers[n]);
			logos[n] = buildContent(textBox, held, n, preview, (logo) => {
				kinds[n] = logo;
				// Only the one on screen decides the strip.
				if (panel && shownKind === n) panel.offer('look', !logo);
				// The panel's own title is derived from what the overlay says,
				// and the placer is what derives it — but it repaints on a
				// video frame, so without this the header goes on naming the
				// text for as long as no frame arrives.
				if (placers[n]) placers[n].repaint();
			}, () => {
				// The picture arrived — from the camera, after a reload —
				// and the stand-in is drawn from it. It is fetched before
				// the placers exist and lands whenever the camera answers,
				// which can be after the last repaint; without this the
				// stand-in stayed the word-sized box until something else
				// happened to repaint it.
				if (placers[n]) placers[n].repaint();
			});
		}
		// ── the vendor mark ──────────────────────────────────────────────
		//
		// An overlay in every way that matters to this page: it has a place on
		// the picture, the same five keys describe it, and the same placer
		// drags it. What it does not have is anything to say or any way to
		// look — the camera decides both — so it gets the Place tab and
		// nothing else, and the item row gives it no way to be removed.
		//
		// Mounted whenever the schema describes it, and SHOWN only while the
		// camera reports drawing it. Those are different questions: the keys
		// exist on every build that has the mark at all, and whether it is on
		// the video turns on the licence, which this page cannot read.
		if (panel && markFields.length) {
			const box = panel.slot('place', MARK);
			const mheld = {};
			for (const f of markFields) {
				const field = renderField(box, f.dot, f.key, f.sub,
					getDotted(state.config, f.dot));
				if (!field) continue;
				state.fields.push(field);
				state.initial[f.dot] = field.getValue();
				mheld[f.key] = field;
			}
			HELD[MARK] = mheld;
			if (mheld.anchor) panel.pad(mheld, box, () => placers[MARK]);
		}

		const held = HELD[0];

		// What an overlay SAYS is also whether it exists — the same rule the
		// camera applies, read from the control so a line added here counts at
		// once. The item list below words it; the picture needs it too, so that
		// a press cannot pick up an overlay that is not being drawn.
		//
		// A LINE OR A PICTURE, which is the camera's own rule for whether an
		// overlay exists at all. Counting only the line left an overlay that
		// draws just a logo on the video and absent from the item list — so
		// there was no chip to select, and therefore no way to reach the thing
		// that would change or remove it.
		const lineOf = (n) => HELD[n] && HELD[n].template
			? String(HELD[n].template.getValue() || '') : '';
		const logoOf = (n) => HELD[n] && HELD[n].image
			? String(HELD[n].image.getValue() || '') : '';
		const saysAnything = (n) =>
			lineOf(n).trim() !== '' || logoOf(n).trim() !== '';
		// AN ITEM IS SOMETHING ON THE PICTURE, whatever its index.
		//
		// Overlay 0 used to be listed whether or not it drew anything, on the
		// grounds that its keys are the flat osd.* ones and every camera has
		// them. That is true of the KEYS and not of the picture, and it made
		// the first line the one item that could not be removed: no cross on
		// its chip, while every other text had one. The reporter's clock and
		// their FRONT GATE behaved differently for a reason nothing on screen
		// could show.
		const listedOverlay = (n) => !!placers[n] && saysAnything(n);
		// The first overlay, until something selects another. Said here rather
		// than left to the item list, which does not exist on a leaf with no
		// picture to put items on.
		if (panel) {
			panel.showOverlay(0);
			panel.offer('look', !kinds[0]);
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

		let masks = null;
		if (maskField && canRegion) {
			masks = mountRegions(preview, maskField, maskBody, maskNote, {
				gated: true,
				// Called through rather than passed, because `pickAt` is
				// declared below this call and reading it here would be the
				// temporal dead zone this file has already been bitten by.
				pickAt: (pt, from, probe) => pickAt(pt, from, probe),
				// The camera follows a mask drag the way it follows a text one.
				// Same endpoint, same document shape, same undo: the drop below
				// puts every staged rectangle back where the config says.
				onLive: (spec) => postLivePlace({ osd: { privacyMasks: spec } }),
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

		// One placer per overlay, exactly one of them active. Each hides its own
		// layer and drag catcher when it is not, so the selected overlay is the
		// only thing a press on the picture can move — which is the whole of
		// what selection has to mean here.
		// Which overlay a press on the picture is reaching for.
		//
		// Answered by the leaf rather than by any one placer, because it is a
		// question about all of them: only the selected overlay has a catcher,
		// so its handler asks here whether the press actually landed on one of
		// the others. `probe` means "just tell me, do not select anything" —
		// that is the pointermove asking so the cursor can say what a press
		// would do.
		//
		// The SMALLEST thing under the press wins an overlap. A short label
		// sitting inside the span of a long clock is the one being reached
		// for; the long one can be taken anywhere else along its length. A
		// mask is measured on the same scale, so a small mask over a long
		// clock is reachable and the clock is still reachable beside it.
		//
		// MASKS ARE IN HERE FOR A REASON THE DOM CANNOT COVER. The regions are
		// real elements and the text overlays are not — they are drawn by the
		// camera, and this page hit-tests them against the rectangles the
		// camera reports. So the two editors cannot arbitrate by stacking
		// order: whichever is not in charge has its layer made pointer-
		// transparent, and a press on its rectangles falls through to the
		// other's full-picture catcher. Pressing a mask dragged the selected
		// TEXT, and pressing the text while a mask was selected drew a new
		// mask across it. One arbiter, asked by both catchers, is what makes
		// the picture a list of things you can pick up rather than two editors
		// taking turns at the same pixels.
		// On the picture right now. Not "configured": the mark is drawn when
		// the camera is unlicensed AND more than one overlay is saying
		// something, and the first of those is not in the schema — so the only
		// honest source is the camera reporting that it drew one.
		function markShown() {
			return !!placers[MARK] &&
				camRects.mark !== null && camRects.mark !== undefined;
		}

		let pickHandler = null;
		const pickAt = (pt, from, probe) => {
			let found = null;
			const offer = (area, sel, grab) => {
				if (!found || area < found.area) found = { area: area, sel: sel, grab: grab };
			};
			for (const n of OVERLAYS) {
				if (n === from || !placers[n]) continue;
				if (!listedOverlay(n) || !placers[n].hitAt(pt)) continue;
				offer(placers[n].area(), { t: 'text', i: n }, (e) => placers[n].grab(e));
			}
			if (masks && from !== 'mask') {
				const m = masks.hitAt(pt);
				if (m) offer(m.area, { t: 'mask', i: m.i }, (e) => masks.grabAt(m.i, e));
			}
			// And the mark, on the same smallest-wins scale as everything
			// else — only while the camera is actually drawing it, or a press
			// would pick up a thing that is not on the picture.
			if (markShown() && from !== MARK && placers[MARK].hitAt(pt)) {
				offer(placers[MARK].area(), { t: 'mark' },
					(e) => placers[MARK].grab(e));
			}
			if (found && !probe && pickHandler) pickHandler(found.sel);
			return found;
		};

		// Asked once at mount and then on a slow tick: the rectangles move when
		// the template changes length, when a save lands, and after a drag —
		// none of which is fast, and none of which the page can predict without
		// asking. Stopped with the rest of the leaf.
		let anyPlacer = false;
		if (preview) {
			refreshOsdRects();
			const rectTimer = setInterval(refreshOsdRects, 2000);
			state.liveCleanup.push(() => clearInterval(rectTimer));
			for (const n of OVERLAYS) {
				if (!HELD[n].anchor) continue;
				placers[n] = mountOsdText(preview, HELD[n], note, panel, n,
					{ pickAt: pickAt, camRect: camRectFor,
					  rectsChanged: () => setTimeout(refreshOsdRects, 400),
					  // An overlay that says something and is not on the
					  // camera's list is one the page has to draw itself —
					  // but only once the camera has answered, since before
					  // that the list is empty for every overlay.
					  standIn: () => camRects.known && listedOverlay(n),
					  logo: () => logos[n] ? logos[n].logo() : null });
				placers[n].setActive(false);
				anyPlacer = true;
			}
			// The stand-ins are decided by the camera's answer, so a new
			// answer repaints them: a save that made the camera draw a line
			// takes the page's copy of it off, a tick later.
			camRects.onRects = () => {
				for (const k of Object.keys(placers)) placers[k].repaint();
				// The masks too: their outlines are drawn through the
				// camera's account of what each stream shows, which arrives
				// with the same answer.
				if (masks) masks.repaint();
			};
			state.liveCleanup.push(() => { camRects.onRects = null; });
			// The same placer, on the same hooks. It hit-tests against the
			// rectangle the camera reports for the mark exactly as the others
			// do against theirs, so dragging it is the gesture already written
			// rather than a second one.
			if (HELD[MARK] && HELD[MARK].anchor) {
				placers[MARK] = mountOsdText(preview, HELD[MARK], note, panel,
					MARK,
					{ pickAt: pickAt, camRect: camRectFor,
					  // Always a share — see unit(). The mark must sit in the
					  // same place on the main stream and the sub, and pixels
					  // cannot say that.
					  unit: '%',
					  rectsChanged: () => setTimeout(refreshOsdRects, 400) });
				placers[MARK].setActive(false);
			}
		}
		if (anyPlacer) {
			repaint = () => {
				for (const k of Object.keys(placers)) placers[k].repaint();
				if (masks) masks.repaint();
			};
		} else if (masks) {
			repaint = masks.repaint;
		}

		// ── one list of the things on the picture ────────────────────────
		//
		// This replaces a Text / Masks switch in the bar, which asked the
		// question the wrong way round: it made you name a KIND before you
		// could touch a thing, and it could not tell you what was on the
		// picture — a mask switched off the screen edge, or three masks where
		// you thought there was one, looked exactly like none.
		//
		// A chip per thing, and pressing one is the same act as pressing the
		// thing itself: both go through the same selection. Labels are DERIVED
		// — a text overlay is the line it prints, a mask is its number — so
		// nothing here needs a name, which is the concept the whole arrangement
		// was chosen to avoid.
		if (preview && (anyPlacer || masks)) {
			const row = el('div', 'mj-osd-items box');
			const cap = el('span', 'mj-cap');
			cap.textContent = 'Items';
			row.appendChild(cap);
			const chips = el('span', 'mj-osd-chips');
			row.appendChild(chips);

			// WHAT IT COSTS, beside what there is. A region refused for want of
			// a handle is not a clipped overlay: it is no overlay at all,
			// drawn nowhere, with the stream carrying on as though nothing had
			// been asked for. Nothing else on this page can report that, so
			// the way to keep somebody out of it is to show what is left
			// before they spend it.
			//
			// TWO BUDGETS AND NOT A TOTAL. Masks and overlays come out of
			// different ranges of the camera's handle map, so a mask can never
			// take an overlay's slot; one number would be wrong in both
			// directions. The camera reports both, and a build that has not
			// written its region map down reports zero — shown as a count with
			// no ceiling, which is what not knowing looks like.
			//
			// The memory is the same arithmetic the camera does: the real
			// rectangles, two bytes a pixel, two buffers a region. It is here
			// because a full-frame logo is megabytes and nothing forbids one —
			// the page shows the price and lets the person decide.
			// ON ITS OWN LINE, under the row rather than in it.
			//
			// In the row it was a 242px item that could not shrink and could
			// not wrap, on a bar that must not wrap — so it came out of the
			// chips' width. In the leaf's picture column, which is about 640px
			// once the inspector has its side, that left the chips 218px and
			// every one of them wrapped onto a line of its own: a 335px bar
			// for three items, with this line floating in the middle of it.
			//
			// Below, it costs one line and takes nothing from anything.
			const cost = el('div', 'mj-osd-cost');
			row.appendChild(onBar);

			function drawCost() {
				const b = camRects.budget;
				const nMask = masks ? masks.count() : 0;
				// COUNTED FROM WHAT IS ON THE PAGE, not from what the camera
				// has drawn so far. An overlay added here does not exist on
				// the camera until Save, and a count that only moved afterwards
				// would tell somebody they had run out one press too late —
				// which is the press this line exists to stop.
				//
				// One region per overlay per distinct frame size, which is the
				// camera's own rule: the glyphs are sized from the width, so
				// two outputs of the same size share a region and a snapshot
				// inheriting the main stream's costs nothing extra. The number
				// of sizes is the camera's to say and is read from its report.
				const items = listed().length + (markShown() ? 1 : 0);
				// HOW MANY STREAM SIZES IS THE CAMERA'S TO SAY, and until it
				// has said, this line says nothing about regions. Standing in
				// 1 for an unknown count turned a guess into a printed number
				// — and understated it on every camera with two stream sizes,
				// which is most of them. That stood before the first reply,
				// after any hiccup, and for good on a build with no
				// /api/v1/osd at all.
				const regions = camRects.widths ? items * camRects.widths : 0;
				const bits = [];
				if (regions) {
					bits.push(b && b.overlays
						? regions + ' of ' + b.overlays + ' regions'
						: regions + (regions === 1 ? ' region' : ' regions'));
				} else {
					bits.push(items + (items === 1 ? ' item' : ' items'));
				}
				if (masks) {
					bits.push(b && b.masks
						? nMask + ' of ' + b.masks + ' masks'
						: nMask + (nMask === 1 ? ' mask' : ' masks'));
				}
				if (camRects.bytes) {
					const mb = camRects.bytes / 1048576;
					bits.push('~' + (mb >= 1 ? mb.toFixed(1) + ' MB'
						: Math.round(camRects.bytes / 1024) + ' KB'));
				}
				cost.textContent = bits.join(' · ');
				// Only where the camera said what the ceiling is; a count with
				// no ceiling has nothing to be near the end of.
				const tight = !!(b && b.overlays && regions >= b.overlays - 2) ||
					!!(b && b.masks && nMask >= b.masks - 1);
				cost.classList.toggle('mj-osd-cost-low', tight);
				cost.title = tight
					? 'Close to this camera\u2019s limit. A region it cannot ' +
					  'create is an overlay that is not drawn at all.'
					: 'One region per item per distinct stream size. Overlay ' +
					  'regions and privacy masks come out of different ranges, ' +
					  'so a mask never costs an overlay its slot. The size is ' +
					  'what the camera is drawing now, in its video memory.';
			}
			camRects.onCost = drawCost;
			state.liveCleanup.push(() => { camRects.onCost = null; });
			(barRow || preview.stage).insertAdjacentElement('afterend', row);
			// After the row is in the document, not before: afterend on a node
			// with no parent silently does nothing, and the line simply never
			// appeared.
			row.insertAdjacentElement('afterend', cost);

			const listed = () => OVERLAYS.filter(listedOverlay);
			// Index 0 included, or emptying the first line would retire it: it
			// is the lowest free index and OVERLAYS is sorted, so + Text takes
			// it back first. An index that can be cleared and never refilled
			// is a line the camera can draw and the page cannot ask for.
			const spare = () =>
				OVERLAYS.find(n => placers[n] && !saysAnything(n));

			// What to select when whatever was selected has gone. Text first,
			// then a mask, then the mark — and `none` where the picture really
			// is empty, which is a state this leaf can now reach.
			function fallbackSel() {
				const l = listed();
				if (l.length) return { t: 'text', i: l[0] };
				if (masks && masks.count()) return { t: 'mask', i: 0 };
				if (markShown()) return { t: 'mark' };
				return { t: 'none' };
			}

			// {t: 'text', i: overlay} or {t: 'mask', i: index} or {t: 'mark'}.
			let sel = anyPlacer || masks ? fallbackSel() : { t: 'mask', i: 0 };

			function pick(next, fromPicture) {
				sel = next;
				for (const k of Object.keys(placers))
					placers[k].setActive(k === MARK
						? sel.t === 'mark'
						: sel.t === 'text' && +k === sel.i);
				if (masks) {
					masks.setActive(sel.t === 'mask');
					if (sel.t === 'mask' && !fromPicture) masks.selectAt(sel.i);
				}
				if (sel.t === 'none' && panel) {
					// The picture is empty. Offering a tab about a thing that
					// is not there is worse than offering none: every control
					// in it would edit an overlay nobody can see.
					panel.offer('text', false);
					panel.offer('look', false);
					panel.offer('place', false);
					panel.name('');
				} else if (sel.t === 'text' && panel) {
					panel.showOverlay(sel.i);
					shownKind = sel.i;
					panel.offer('text', true);
					panel.offer('look', !kinds[sel.i]);
					panel.offer('place', true);
					panel.reveal();
				} else if (sel.t === 'mark' && panel) {
					// A place and nothing else. There is no content to write
					// and no face to choose — the camera answers both, and a
					// tab offering either would be a control that does not
					// work rather than a setting somebody has not found.
					panel.showOverlay(MARK);
					panel.offer('text', false);
					panel.offer('look', false);
					panel.offer('place', true);
					panel.name('OpenIPC');
					panel.reveal('place');
				} else if (sel.t === 'mask' && panel) {
					// A mask has a rectangle and nothing else: no content to
					// write, no font to choose. One tab, and it is the one
					// about where a thing is.
					panel.showOverlay('mask');
					panel.offer('text', false);
					panel.offer('look', false);
					panel.offer('place', true);
					panel.name(sel.i >= 0 ? 'Mask ' + (sel.i + 1) : 'Masks');
					if (maskCo && sel.i >= 0) maskCo.value = masks.rectAt(sel.i);
					panel.reveal('place');
				}
				draw();
			}

			// Adding one is writing a template into the lowest index that has
			// none — which is exactly what makes the camera draw it. Everything
			// else stays at its declared default, so what a save writes is one
			// line of config rather than a transcription of overlay 0.
			function addOverlay() {
				const n = spare();
				if (n === undefined) return;
				const f = HELD[n].template;
				f.setValue('Text');
				// buildTemplate rebuilds its chips from the field's own events,
				// and setValue fires none — so say it moved.
				f.control.dispatchEvent(new Event('change', { bubbles: true }));
				drawWhatWasAdded();
				runVisibility();
				updateDirty();
				pick({ t: 'text', i: n });
				if (panel) panel.reveal('text');
			}

			// Adding a LOGO is one act, not "add some text and then replace it
			// with a picture". It takes the next free index, opens its panel
			// and opens the file chooser straight away — this runs inside the
			// press, so the chooser is allowed to open.
			//
			// Nothing is written until a picture is actually chosen: an
			// overlay with neither a line nor a picture says nothing, so it is
			// not listed, so a cancelled chooser leaves no empty item behind.
			function addLogo() {
				const n = spare();
				if (n === undefined || !HELD[n].image) return;
				pick({ t: 'text', i: n });
				if (panel) panel.reveal('text');
				const slot = panel ? panel.slot('text', n) : null;
				const input = slot &&
					slot.querySelector('.mj-logo input[type=file]');
				if (input) input.click();
			}

			// And removing one is putting the whole overlay back to its declared
			// defaults, template included. A member equal to its default is left
			// out of a save, so the block leaves /etc/majestic.yaml rather than
			// staying behind as an inert one nobody can see.
			//
			// Overlay 0 is not removable: it is the flat keys, which every
			// config has and no camera can be without.
			function removeOverlay(n) {
				// Index 0 is removable like the rest. It cannot cease to
				// EXIST — its keys are the flat ones and are always there —
				// but the line it draws can go, which is the only sense in
				// which any of these is removed: an overlay above zero is
				// gone precisely when it says nothing.
				if (n === undefined || !HELD[n]) return;
				// The file as well as the setting — but on Save, not now: see
				// logoBin. Clearing the field alone would leave the picture in
				// the camera's writable overlay, taking flash for an overlay
				// that no longer refers to it.
				if (logoOf(n).trim() !== '') logoBin.add(n);
				for (const k of Object.keys(HELD[n])) {
					const f = HELD[n][k];
					// WHAT IT SAYS IS CLEARED, not defaulted. The rest of an
					// overlay goes back to its default so the index is clean
					// for whoever takes it next — but a default is the wrong
					// answer for these two, and on index 0 it is the opposite
					// of the one asked for: osd.template's default is the
					// clock, so removing the first line put the clock back.
					// Above zero the default happens to be empty and the two
					// rules agreed, which is why nothing showed it.
					const clears = k === 'template' || k === 'image';
					const d = !clears && f.schema &&
						Object.prototype.hasOwnProperty.call(f.schema, 'default')
						? f.schema.default : '';
					f.setValue(d === undefined || d === null ? '' : String(d));
					f.control.dispatchEvent(new Event('change', { bubbles: true }));
				}
				runVisibility();
				updateDirty();
				pick(fallbackSel());
			}

			// The pill is a WRAPPER, and the label is a button inside it.
			//
			// It was one button with the remove cross nested inside, which is
			// invalid markup — a button may not contain another — and browsers
			// do not agree about what a press on the inner one means. Where the
			// outer button wins the hit test, pressing the cross re-selects the
			// chip it is on: no error, no change, a control that does nothing.
			// Two real buttons side by side inside a plain span is the same
			// picture and has one meaning everywhere.
			function chip(kind, word, on) {
				const wrap = el('span',
					'mj-osd-chip' + (on ? ' mj-osd-chip-on' : ''));
				const b = el('button', 'mj-osd-chip-b');
				b.type = 'button';
				b.innerHTML = '<span class="mj-osd-chip-k"></span>' +
					'<span class="mj-osd-chip-v"></span>';
				b.firstChild.textContent = kind;
				b.lastChild.textContent = word;
				wrap.appendChild(b);

				return { wrap: wrap, b: b };
			}

			function draw() {
				drawCost();
				chips.textContent = '';
				for (const n of listed()) {
					const on = sel.t === 'text' && sel.i === n;
					// What the CAMERA draws, which is the picture wherever
					// there is one — a chip showing the template of an overlay
					// that is drawing a logo names something nobody can see.
					const logo = logoOf(n).trim() !== '';
					const t = lineOf(n);
					const c = logo
						? chip('Logo', 'Picture', on)
						: chip('Text',
							t.length > 20 ? t.slice(0, 19) + '…' : (t || 'Overlay'),
							on);
					c.b.addEventListener('click', () => pick({ t: 'text', i: n }));
					// The remove control rides the chip it removes, and only
					// while that chip is the selected one: a row of crosses is a
					// picture of controls rather than of what is on the screen.
					if (on) {
						const x = el('button', 'mj-osd-chip-x');
						x.type = 'button';
						x.title = 'Remove this overlay';
						x.setAttribute('aria-label', 'Remove this overlay');
						x.textContent = '\u00d7';
						x.addEventListener('click', () => removeOverlay(n));
						c.wrap.appendChild(x);
					}
					chips.appendChild(c.wrap);
				}
				const n = masks ? masks.count() : 0;
				for (let i = 0; i < n; i++) {
					const on = sel.t === 'mask' && sel.i === i;
					const c = chip('Mask', String(i + 1), on);
					c.b.addEventListener('click', () => pick({ t: 'mask', i: i }));
					// The same cross every other item carries. A mask could
					// only be removed from the picture — the × on its selected
					// rectangle, or the Delete key — so the row offered the
					// gesture for text and not for masks, on the same chips,
					// under the same heading.
					if (on) {
						const x = el('button', 'mj-osd-chip-x');
						x.type = 'button';
						x.title = 'Remove this mask';
						x.setAttribute('aria-label', 'Remove this mask');
						x.textContent = '\u00d7';
						x.addEventListener('click', () => {
							masks.removeAt(i);
							// Still among masks. removeAt() has already moved
							// its own selection down — removing one renumbers
							// every mask after it — so the row is told what the
							// editor decided rather than sent back to the first
							// text overlay, which is not where you were.
							pick({ t: 'mask', i: masks.selected() });
						});
						c.wrap.appendChild(x);
					}
					chips.appendChild(c.wrap);
				}
				// AND NO CROSS. Every other chip carries one; this is the item
				// that cannot be taken off, and the absence is the whole
				// statement. A disabled cross would read as a control that is
				// broken rather than as a thing that is not offered, and a
				// cross that explained itself in a tooltip would still be a
				// button somebody presses first and reads second.
				if (markShown()) {
					const c = chip('Logo', 'OpenIPC', sel.t === 'mark');
					c.b.title = 'Drag it anywhere on the picture. ' +
						'It cannot be removed.';
					c.b.addEventListener('click', () => pick({ t: 'mark' }));
					chips.appendChild(c.wrap);
				}
				// Offered only while the camera has an index left to draw on.
				if (spare() !== undefined) {
					const add = el('button', 'mj-osd-chip mj-osd-chip-add');
					add.type = 'button';
					add.textContent = '+ Text';
					add.title = 'Add another line of text to the picture';
					add.addEventListener('click', addOverlay);
					chips.appendChild(add);

					// Only where the camera can draw one: the field exists
					// exactly where the backend said it does.
					if (HELD[spare()] && HELD[spare()].image) {
						const lg = el('button', 'mj-osd-chip mj-osd-chip-add');
						lg.type = 'button';
						lg.textContent = '+ Logo';
						lg.title = 'Put a picture on the video';
						lg.addEventListener('click', addLogo);
						chips.appendChild(lg);
					}
				}

				// AND A MASK, which had no way in at all.
				//
				// Drawing one used to be a press on a Masks switch in the
				// player bar and then a drag. The switch went when the chips
				// replaced it, and a chip only exists for a mask that already
				// exists — so with none there was nothing to press, the mask
				// layer was never active, and a drag on the picture moved the
				// selected overlay instead. The deck below still had "Add by
				// coordinates", which is not the same offer as drawing one.
				//
				// It stays lit while the picture is in mask mode with nothing
				// selected, because that is a state you are IN and the crosshair
				// alone does not say whose crosshair it is.
				if (masks) {
					const mk = el('button', 'mj-osd-chip mj-osd-chip-add' +
						(sel.t === 'mask' && sel.i < 0 ? ' mj-osd-chip-on' : ''));
					mk.type = 'button';
					mk.textContent = n ? '+ Mask' : '+ Mask';
					mk.title = 'Drag a rectangle on the picture to hide it';
					mk.addEventListener('click', () => pick({ t: 'mask', i: -1 }));
					chips.appendChild(mk);
				}
				// Whatever changed the row changed what the picture has to
				// show: a line added is a stand-in to draw, a picture chosen
				// is a stand-in to resize, and neither reaches the placer
				// through any event of its own.
				repaint();
			}

			// Picking a mask ON the picture has to move the chip too, or the two
			// disagree about which one is current and the row becomes a second
			// opinion rather than a view.
			if (masks) masks.onSelect((i) => {
				// A mask drawn on the picture selects itself, which is how the
				// row learns it exists and how the drawn one gets its handles.
				if (i >= 0) { sel = { t: 'mask', i: i }; draw(); }
			});
			// A mask added or removed changes what the row lists. The array
			// widget fires change for every edit that reaches the field, which
			// is every edit: a drawn rectangle goes through the same _add().
			if (maskField) maskField.control.addEventListener('change', draw);
			// So does an overlay's own line — it is the chip's label, and above
			// overlay 0 it is also whether the chip is there at all.
			for (const n of OVERLAYS) {
				if (HELD[n].template) {
					HELD[n].template.control.addEventListener('input', draw);
					HELD[n].template.control.addEventListener('change', draw);
				}
				// A picture chosen or removed changes the chip's kind, and
				// above overlay 0 it changes whether the chip is there at all.
				if (HELD[n].image)
					HELD[n].image.control.addEventListener('change', draw);
			}

			// A press on the picture selects through exactly the same door the
			// chips do, so the chip row cannot disagree with what is being
			// dragged. It carries the whole selector rather than an overlay
			// number, because a mask is one of the things a press can reach.
			pickHandler = (sel_) => pick(sel_);

			// ── the inspector, for a mask ────────────────────────────────
			//
			// A mask is a thing on this picture like the others, and the panel
			// had nothing to say about one: selecting a Mask chip left the
			// last text overlay's settings on screen, which is a panel
			// describing something you are not looking at.
			//
			// What a mask HAS is a rectangle and a consequence, so that is what
			// it shows. The rectangle is the list's own input read and written
			// through mountRegions rather than copied, so the picture, the row
			// below and this box are three views of one value and cannot
			// disagree.
			if (masks && panel) {
				const slot = panel.slot('place', 'mask');
				const box = el('p', 'string mj-row');
				box.innerHTML =
					'<label class="form-label" for="mj-md-inspect">' +
						'Left × Top × Width × Height</label>' +
					'<input type="text" class="form-control" id="mj-md-inspect" ' +
						'spellcheck="false" autocomplete="off">';
				slot.appendChild(box);
				const co = box.querySelector('input');

				const why = el('p', 'mj-live-hint');
				why.textContent = 'A mask is drawn into the video itself, so it ' +
					'is in the recording and in every other viewer’s picture — ' +
					'not just in this preview.';
				slot.appendChild(why);

				// Moving a mask is previewed; adding or removing one is not,
				// and the difference is the camera's rather than this page's.
				// A move rewrites the rectangle of a region that already
				// exists, which the daemon does on a running pipeline. A mask
				// added has no region yet and one removed still has its own,
				// so the daemon refuses the whole list until a save rebuilds
				// it — and the video goes on showing the masks it was given
				// while the outlines here show the ones it has not. Two
				// rectangles, not agreeing, and nothing saying which is which.
				const later = el('p', 'mj-live-hint mj-md-warn');
				slot.appendChild(later);
				// Read rather than captured: a save refreshes what the camera
				// is holding, and a line that went on naming the count from
				// mount would still be there after the save that answered it.
				function sayLater() {
					const was = String(state.initial[maskSchema.dot] || '')
						.match(/\d+x\d+x\d+x\d+/g);
					const off = masks.count() !== (was ? was.length : 0);
					later.textContent = off
						? 'The video still shows the masks it was last given. ' +
							'Save to add or remove one; moving one is shown as ' +
							'you drag.'
						: '';
					later.hidden = !off;
				}
				sayLater();
				// A save is the answer to this line, and it does not reach the
				// drag's own callback: it pushes the saved value back into the
				// field, which repaints the list through _sync. So the line is
				// asked again there, or it would still be standing after the
				// save that made it untrue.
				const synced = maskField.control._sync;
				maskField.control._sync = () => {
					if (synced) synced();
					sayLater();
				};

				maskCo = co;
				co.addEventListener('change', () => {
					if (sel.t === 'mask' && sel.i >= 0)
						masks.setRectAt(sel.i, co.value.trim());
				});
				// The numbers move under a drag, and this is one of the places
				// they are shown.
				masks.onEdit(() => {
					sayLater();
					if (sel.t === 'mask' && sel.i >= 0 &&
						document.activeElement !== co)
						co.value = masks.rectAt(sel.i);
				});
			}

			// It comes and goes with what the camera is drawing — a second
			// overlay brings it a tick later, and removing one takes it away
			// — so the row is rebuilt when that answer changes rather than
			// only when something here is clicked.
			camRects.onMark = () => {
				if (sel.t === 'mark' && !markShown()) {
					pick({ t: 'text', i: listed()[0] });
					return;
				}
				draw();
			};
			state.liveCleanup.push(() => { camRects.onMark = null; });

			pick(sel, false);
		}

		if (maskField && !canRegion) form.appendChild(maskDeck);
		// The switch that was the deck's last tenant is on the item bar, and
		// the two columns it was built for are on the picture. What is left is
		// a border and some padding around nothing, so it goes — but only once
		// it is actually empty, since a leaf with no picture still renders all
		// of it here.
		if (panel) colText.remove();
		// Rehomed BEFORE the column is judged empty, or a leaf with a picture
		// but no items to bar would have the column removed out from under the
		// group this is about to build in it, and the switch would go with it.
		if (!onBar.parentNode && onBar.childElementCount)
			liveGroup(colLook, 'Overlay', '').appendChild(onBar);
		if (!colLook.childElementCount) colLook.remove();
		else if (panel) colLook.classList.remove('mj-live-col-b');
		if (!deck.childElementCount) deck.remove();
	}

	// Adding something to the picture turns the picture on.
	//
	// The switch decides whether ANY overlay is drawn, and it was left wherever
	// it had been: adding a line to a camera whose overlays were off produced
	// an item on the bar, a panel full of settings, and nothing on the video —
	// with nothing saying why, since the switch that explains it is a bar item
	// away from the press. Asking for a thing to be drawn is the same statement
	// as asking for drawing, so the act carries both. It is a staged edit like
	// every other, and the save bar counts it.
	function drawWhatWasAdded() {
		const f = state.fields.find((x) => x.dot === 'osd.enabled');
		if (!f || f.getValue() === 'true') return;
		f.setValue('true');
		f.control.dispatchEvent(new Event('change', { bubbles: true }));
		runVisibility();
		updateDirty();
	}

	// The panel the overlay's settings live in: a card on the picture, opened
	// by clicking the overlay and moved by its header.
	//
	// It is deliberately thin. It owns a header, three tab buttons and three
	// empty bodies; every control inside is mounted by the same renderField()
	// and buildTemplate() calls that filled the deck before, so nothing about
	// saving, dirty tracking, resetting or the schema's visibleWhen rules had to
	// learn about it. The one thing it adds is the anchor pad, and even that
	// writes the anchor ROW rather than standing in for it.
	function mountOsdPanel(preview, mount) {
		const P = window.MajesticPlace;
		const box = el('div', 'mj-osd-panel');
		box.innerHTML =
			'<div class="mj-osd-panel-head">' +
				'<span class="mj-cap mj-osd-panel-name"></span>' +
			'</div>' +
			'<div class="mj-osd-tabs" role="tablist"></div>' +
			'<div class="mj-osd-bodies"></div>';
		mount.appendChild(box);

		const tabs = box.querySelector('.mj-osd-tabs');
		const bodies = box.querySelector('.mj-osd-bodies');
		const made = {};
		// "Content" rather than "Text": what an overlay says is a line or a
		// picture, and the tab holds whichever this one is.
		const TABS = [['text', 'Content'], ['look', 'Look'], ['place', 'Place']];
		let open = 'place';

		for (const [id, word] of TABS) {
			const b = el('button', 'mj-osd-tab');
			b.type = 'button';
			b.textContent = word;
			b.setAttribute('role', 'tab');
			b.addEventListener('click', () => show(id));
			tabs.appendChild(b);
			const body = el('div', 'mj-osd-body');
			bodies.appendChild(body);
			made[id] = { btn: b, body: body };
		}

		function show(id) {
			// A tab that is not offered cannot be the open one: asking for it
			// would leave the strip with nothing lit and the panel blank.
			if (made[id] && made[id].btn.hidden) id = TABS.find(
				([tid]) => !made[tid].btn.hidden)[0];
			open = id;
			for (const [tid] of TABS) {
				made[tid].btn.classList.toggle('mj-osd-tab-on', tid === id);
				made[tid].btn.setAttribute('aria-selected', tid === id ? 'true' : 'false');
				made[tid].body.hidden = tid !== id;
			}
		}
		show(open);

		// Which tabs this overlay has.
		//
		// A picture has no Look: every control there — the font, its size, its
		// weight, its outline, the plate behind the text — draws TEXT, and none
		// of it touches a bitmap the camera blits. Offering them would be three
		// controls and a switch that do nothing, on the tab most likely to be
		// opened looking for how to change the picture.
		function offer(id, on) {
			if (!made[id]) return;
			made[id].btn.hidden = !on;
			if (!on && open === id) show(TABS[0][0]);
			// A strip of ONE is not a strip. A mask and the vendor mark have
			// a place and nothing else, and the lone lit tab above their
			// numbers read as a button — something to press, which then did
			// nothing, because it was already the tab you were on. There is
			// no choice to offer, so nothing is offered: the panel's own
			// heading already says what is selected.
			tabs.hidden =
				TABS.filter(([tid]) => !made[tid].btn.hidden).length < 2;
		}


		// One slot per overlay inside each tab, all but the selected one hidden.
		//
		// Every overlay's controls are mounted at once, which is what keeps
		// Save, dirty tracking and the per-row reset working across all of them
		// — two overlays can be edited and saved together, and none of that
		// machinery learns a selector exists. The alternative, re-rendering the
		// tab on every selection, would throw away unsaved edits the moment you
		// looked at another overlay.
		const slots = {};
		function slot(id, n) {
			const k = id + '.' + n;
			if (!slots[k]) {
				const d = el('div', 'mj-osd-slot');
				made[id].body.appendChild(d);
				slots[k] = d;
			}
			return slots[k];
		}
		let shownOverlay = null;
		function showOverlay(n) {
			shownOverlay = n;
			for (const k of Object.keys(slots))
				slots[k].hidden = k.slice(k.indexOf('.') + 1) !== String(n);
		}

		return {
			el: box,
			tab: (id) => made[id].body,
			offer: offer,
			slot: slot,
			showOverlay: showOverlay,
			// It is always there now, so this only chooses which tab of it you
			// are looking at.
			reveal: (id) => { if (id) show(id); },
			// What it is called, derived rather than stored: a text overlay is
			// the line it prints. Nothing anywhere holds a name for it.
			name: (text) => {
				const t = String(text || '').trim();
				box.querySelector('.mj-osd-panel-name').textContent =
					t ? (t.length > 24 ? t.slice(0, 23) + '…' : t) : 'Overlay';
			},
			// Nine cells that are the nine anchors, in the arrangement they
			// name. It writes the anchor row; the row remains the truth.
			pad: (held, into, pushNow) => {
				const wrap = el('div', 'mj-osd-pad-wrap');
				const grid = el('div', 'mj-osd-pad');
				const cells = [];
				for (let iy = -1; iy <= 1; iy++) {
					for (let ix = -1; ix <= 1; ix++) {
						const b = el('button', 'mj-osd-cell');
						b.type = 'button';
						const nm = P.nameOf(ix, iy);
						b.title = P.sayOf(nm);
						b.setAttribute('aria-label', P.sayOf(nm));
						const bar = el('i');
						bar.style.width = (ix === 0 ? 14 : (iy === 0 ? 4 : 9)) + 'px';
						bar.style.height = (iy === 0 ? 14 : 4) + 'px';
						bar.style.margin = (iy < 0 ? '3px' : 'auto') + ' ' +
							(ix > 0 ? '3px' : 'auto') + ' ' +
							(iy > 0 ? '3px' : 'auto') + ' ' +
							(ix < 0 ? '3px' : 'auto');
						b.appendChild(bar);
						b.addEventListener('click', () => {
							held.anchor.setValue(nm);
							runVisibility();
							updateDirty();
							lightPad();
							// Resolved at press rather than captured: the pads are
							// built while the fields are, before any placer exists.
							const push = pushNow && pushNow();
							if (push) push.pushNow();
						});
						grid.appendChild(b);
						cells.push({ el: b, name: nm });
					}
				}
				function lightPad() {
					const cur = held.anchor.getValue();
					const prop = P.isProportional(cur);
					wrap.classList.toggle('mj-osd-pad-off', prop);
					for (const c of cells)
						c.el.classList.toggle('mj-osd-cell-on', !prop && c.name === cur);
				}
				// No caption: the anchor's own row sits directly beneath and is
				// labelled, so a heading here would print the same word twice.
				// The cells carry aria-labels, which is what a screen reader
				// needs from a grid of nine unlabelled buttons.
				grid.setAttribute('role', 'group');
				grid.setAttribute('aria-label', 'Anchor');
				wrap.appendChild(grid);
				const row = into || made.place.body;
				row.insertBefore(wrap, row.firstChild);
				lightPad();
				held.anchor.control.addEventListener('change', lightPad);
				return { light: lightPad };
			},
		};
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
	// The live placement push, as a DOCUMENT rather than a query string.
	//
	// majestic takes the same nested shape /api/v1/config takes, addressed by
	// real dotted paths. The query form it replaces read a key by its LAST
	// dotted segment, so `osd.overlays.1.anchor` and `osd.overlays.2.anchor`
	// both arrived as `anchor=` and moved the same overlay — the wire format,
	// not the feature, was the ceiling on several overlays.
	//
	// An older daemon has no /api/v1/live and answers 404. That is remembered
	// once and the query form is used from then on: it can say everything a
	// single overlay needs, which is everything those builds have.
	let liveDoc = true;
	// Whether a placement override is in force on the camera that the form has
	// not saved. One flag for every overlay, because one drop clears them all.
	let osdPushed = false;
	function postLivePlace(doc) {
		osdPushed = true;
		if (liveDoc) return postLiveJson(doc);
		return postLive(legacyQuery(doc));
	}

	// The undo those pushes owe.
	//
	// A drag moves the camera on the way past — one push per pointermove — and
	// stages the numbers in the form. Leaving the page without saving therefore
	// has to put the camera back, or the controls come back at their saved
	// values while the overlay stays where it was dragged to: the same defect
	// #259 reported for the tone sliders, which revertLive() covers for
	// everything that pushes through the query endpoint.
	//
	// It cannot cover this one. That path rebuilds a query string from the
	// live fields, and a query string reads a key by its last dotted segment,
	// so it can only ever say "overlay 0". An empty anchor in the document
	// form is majestic's own word for "drop the override and go back to what is
	// saved", and it drops EVERY overlay in one call — which is exactly the
	// undo, whichever ones were dragged.
	function revertOsdPlace(force) {
		if (!osdPushed && !force) return;
		osdPushed = false;
		// The masks go with the placement: an empty list is the same "put back
		// what is saved" the empty anchor is, and both were staged by the same
		// page and are abandoned by the same act of leaving it.
		// THROUGH WHICHEVER DOOR THE PUSHES WENT. postLivePlace() falls back
		// to the query endpoint when the document form answers 404, and this
		// went on addressing the document form regardless — so on exactly the
		// cameras that needed the fallback, the undo was sent to an endpoint
		// that is not there and the overlay stayed where it had been dragged.
		if (liveDoc) {
			postLiveJson({ osd: { anchor: '', privacyMasks: '' } });
			return;
		}
		postLive(legacyQuery({ osd: { anchor: '' } }));
	}

	// The same drop, for the path a normal request cannot survive: a reload or
	// a closed tab kills the fetch with the document. Beacons carry a body, so
	// the document form travels here too.
	function beaconOsdDrop() {
		if (!osdPushed || !navigator.sendBeacon) return;
		osdPushed = false;
		try {
			// Same door as the pushes, for the same reason as revertOsdPlace.
			if (!liveDoc) {
				navigator.sendBeacon('/api/v1/image?' +
					legacyQuery({ osd: { anchor: '' } }));
				return;
			}
			navigator.sendBeacon('/api/v1/live',
				new Blob([JSON.stringify(
					{ osd: { anchor: '', privacyMasks: '' } })],
					{ type: 'application/json' }));
		} catch (e) { /* the tab is going; there is nothing to report to */ }
	}

	// The same three keys the old endpoint understood, for the fallback. posX
	// and posY are sent too: an older daemon ignores them, and one new enough
	// to have learnt the proportional override but not the document form does
	// not exist.
	function legacyQuery(doc) {
		const o = doc.osd || {};
		// An overlay above the first cannot be addressed in this form at all —
		// and a build old enough to need it has no such overlay to move. Saying
		// nothing is right; saying `anchor=` would move overlay 0.
		if (o.overlays) return '';
		// Nor can it say anything about the masks, and a document that carries
		// only those has no placement to translate. It used to fall through to
		// the line below and send a bare `anchor=`, which is majestic's word
		// for "drop the override" — so a mask drag arriving here cancelled the
		// live placement of the text beside it, once per pointermove.
		if (o.anchor === undefined && o.posX === undefined &&
			o.offsetX === undefined && o.posY === undefined &&
			o.offsetY === undefined) return '';
		const bit = (k, v) => v === undefined ? '' :
			'&' + k + '=' + encodeURIComponent(v);
		return 'anchor=' + encodeURIComponent(o.anchor === undefined ? '' : o.anchor) +
			bit('offsetX', o.offsetX) + bit('offsetY', o.offsetY) +
			bit('posX', o.posX) + bit('posY', o.posY);
	}

	// Behind the same one-in-flight queue every other live push uses, and
	// swallowing its own failures for the same reason: a move that cannot land
	// must not wedge the ones after it or interrupt the drag.
	//
	// It answers with the camera's STATUS rather than with yes or no, because
	// the one thing that has to be told apart is an endpoint that is not there
	// from one that refused this request — 0 where there was no answer at all.
	let liveJsonQueue = null;
	function postLiveJson(doc) {
		if (!liveJsonQueue) liveJsonQueue = queued(sendLiveDoc, 'docSig');
		return liveJsonQueue(doc);
	}

	// One write, its answer, and the fallback that answer may owe.
	//
	// The fallback belongs to the write that was actually SENT rather than to
	// the caller that asked for one, because the queue coalesces: ten
	// pointermoves can share one transmitted document and one promise, and a
	// fallback hung off that promise by each caller would turn a single 404
	// into a legacy write per move — the first of them carrying a position the
	// drag had already passed through. Here there is one write, so there is one
	// fallback, and it carries the document the camera was actually given.
	//
	// ONLY a 404 is the door not being there. Anything else is this camera
	// refusing this request, and a refusal is not a reason to stop using the
	// endpoint that reported it: a mask added but not yet saved is refused —
	// there is no region to move until a save creates one — and that one 500
	// used to demote the page for the rest of the visit, after which every drag
	// went out as a query the endpoint reads as "drop the override", once per
	// pointermove.
	function sendLiveDoc(d) {
		return apiFetch('/api/v1/live', {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(d),
		}).then((r) => r.status, () => 0).then((status) => {
			if (status !== 404) return status;
			liveDoc = false;
			return postLive(legacyQuery(d)).then(() => status, () => status);
		});
	}

	// The placement the fields currently describe, as the document to send.
	// Whole every time: majestic installs a whole placement or none, and a
	// request naming only half of one would leave the camera to guess the rest.
	function placementDoc(held, overlay) {
		const P = window.MajesticPlace;
		const anchor = held.anchor ? held.anchor.getValue() : P.PROPORTIONAL;
		const keys = { anchor: anchor };
		if (P.isProportional(anchor)) {
			if (held.posX) keys.posX = String(held.posX.getValue());
			if (held.posY) keys.posY = String(held.posY.getValue());
		} else {
			if (held.offsetX) keys.offsetX = String(held.offsetX.getValue());
			if (held.offsetY) keys.offsetY = String(held.offsetY.getValue());
		}
		return osdPlaceDoc(overlay || 0, keys);
	}

	// Where an overlay's keys sit in the document. Overlay 0 IS the flat osd.*
	// keys — every config in the field has them there and majestic reads them
	// as the first overlay — so it has one spelling and no nesting.
	function osdPlaceDoc(overlay, keys) {
		// The mark is addressed by NAME, not by index. Its slot sits above
		// every overlay the config describes, and majestic refuses that index
		// spelled as an overlay precisely so the two cannot become one door.
		if (overlay === MARK) return { osd: { mark: keys } };
		return overlay
			? { osd: { overlays: { [String(overlay)]: keys } } }
			: { osd: keys };
	}

	// Placing the overlay by dragging it, with the picture's own edges and
	// middles as magnets — the sticky guides every layout tool has, and the
	// reason they are right here rather than free pixels: a named corner
	// survives a change of resolution, and "16 px from the left" does not mean
	// the same thing on a 1920 frame as on a 640 one.
	// See em() below: majestic's own points-to-pixels arithmetic for the
	// overlay's glyph size, as a divisor of the frame width.
	const EM_DIVISOR = 39.6;

	// WHERE THE OVERLAYS ACTUALLY ARE, ASKED OF THE CAMERA.
	//
	// The camera is the renderer: it has the font, its metrics and the padding
	// the region carries. The browser has none of those, so everything it draws
	// over the picture is an estimate — fine for a dashed stand-in nobody
	// measures against the real thing, and wrong for a box a press is tested
	// against. Drawn over a 636px preview the estimate put the clock's box
	// entirely below the clock, and a short label could not be picked up at all.
	//
	// So majestic reports each region's rectangle in its stream's own pixels
	// and this asks for it. A build without the endpoint 404s once and is never
	// asked again; the estimate is still there behind it, which is what every
	// build before this had.
	const camRects = { by: {}, ok: true, mark: null, onMark: null,
		budget: null, widths: 0, bytes: 0, onCost: null,
		// Whether the camera has answered at all this visit. Before it has,
		// "no rectangle for this overlay" is not a fact about the overlay,
		// and nothing below may draw a conclusion from it.
		known: false, sig: '', onRects: null,
		// Which request is the latest. Polls, the refresh after a drag and a
		// leaf remount overlap, and an older answer landing last would put
		// back geometry a newer one had already replaced.
		seq: 0,
		// What each stream shows of the sensor's frame, and that frame's
		// size — the route a mask takes from the main stream's pixels to
		// any other stream's. See MajesticRegion.view().
		group: null, views: null };

	// Logo files whose overlay has been cleared but not yet saved.
	//
	// Deleting the file when the cross is pressed would change the camera on
	// an unsaved edit: the config would still point at it, the load would
	// fail, and the logo would vanish from the video before anyone pressed
	// Save — which is the one thing this page does not do. So the removal is
	// staged like every other edit and the file goes when the save lands.
	// Choosing a new picture for the same overlay takes it back off the list,
	// because that upload has already overwritten the file.
	const logoBin = new Set();

	function flushLogoBin() {
		for (const n of Array.from(logoBin)) {
			apiFetch('/api/v1/osd/image?overlay=' + n,
				{ method: 'POST', credentials: 'same-origin' })
				.catch(() => {});
		}
		logoBin.clear();
	}

	function refreshOsdRects() {
		if (!camRects.ok) return Promise.resolve();
		const my = ++camRects.seq;
		return apiFetch('/api/v1/osd', { credentials: 'same-origin' })
			.then((r) => {
				// 404 is "this camera cannot say", which is a fact about the
				// build and will not change under us. Anything else is a
				// hiccup and worth asking again next tick.
				if (r.status === 404) { camRects.ok = false; return null; }
				return r.ok ? r.json() : null;
			})
			.then((j) => {
				// Overtaken: a later request has been sent, and its answer is
				// the one that describes the camera now.
				if (my !== camRects.seq) return;
				if (!j) return;
				const by = {};
				// WHICH INDEX THE MARK HAS IS THE CAMERA'S TO SAY, and whether
				// there is one at all is the only way this page can know: it
				// turns on the licence and on how many overlays are drawing,
				// and the licence is not in the schema. So the item appears
				// when the camera reports drawing it and goes when it stops —
				// which is also what makes it show up by itself a tick after a
				// second overlay is added.
				let mark = null;
				for (const o of (j.overlays || [])) {
					const f = o.frame || [], r = o.rect || [];
					if (f.length < 2 || r.length < 4) continue;
					if (o.mark) mark = o.overlay;
					(by[o.overlay] = by[o.overlay] || []).push({
						fw: f[0], fh: f[1], x: r[0], y: r[1], w: r[2], h: r[3],
					});
				}
				// WHAT THE PICTURE COSTS, counted rather than estimated.
				//
				// The camera reports one rectangle per ATTACHMENT, and two
				// outputs of the same size share one region — the glyphs are
				// sized from the width, so a snapshot inheriting the main
				// stream's size costs nothing extra. Distinct (overlay, frame)
				// pairs is therefore the region count, and the rectangles are
				// the real ones rather than a guess at what the font will
				// measure. Two bytes a pixel, and the hardware keeps two
				// buffers per region so it can draw one while the other is
				// shown.
				const seen = {};
				let bytes = 0;
				for (const o of (j.overlays || [])) {
					const f = o.frame || [], r = o.rect || [];
					if (f.length < 2 || r.length < 4) continue;
					const key = o.overlay + '@' + f[0] + 'x' + f[1];
					if (seen[key]) continue;
					seen[key] = true;
					bytes += r[2] * r[3] * 2 * 2;
				}
				const wasCost = camRects.widths + '/' + camRects.bytes;
				// How many DISTINCT frame sizes this camera draws on, which is
				// what each overlay costs in regions. Counted from the report
				// rather than from the config: two outputs of the same size
				// share a region, and only the camera knows which sizes it
				// ended up with.
				const sizes = {};
				for (const o of (j.overlays || [])) {
					const f = o.frame || [];
					if (f.length >= 2) sizes[f[0] + 'x' + f[1]] = true;
				}
				camRects.widths = Object.keys(sizes).length;
				camRects.bytes = bytes;
				camRects.budget = j.budget || null;
				camRects.group = j.group || null;
				camRects.views = j.streams || null;

				const was = camRects.mark;
				camRects.by = by;
				camRects.mark = mark;
				camRects.known = true;
				// The stand-ins are drawn from this answer — see undrawn() in
				// mountOsdText — so a change in it repaints them, and a repeat
				// of the same answer is not worth a repaint every two seconds.
				const sig = JSON.stringify([by, camRects.group, camRects.views]);
				if (sig !== camRects.sig) {
					camRects.sig = sig;
					if (camRects.onRects) camRects.onRects();
				}
				if (was !== mark && camRects.onMark) camRects.onMark();
				if (wasCost !== camRects.widths + '/' + camRects.bytes &&
					camRects.onCost) camRects.onCost();
			})
			.catch(() => {});
	}

	// The one for this overlay on the frame being shown. Matched on the frame
	// rather than on a channel number, because that is what the player knows
	// and the two streams differ in exactly that.
	// The symbolic name the mark is mounted under, resolved here to whatever
	// index this camera reports for it. Kept out of the placer so that nothing
	// which draws an overlay has to know one of them is not the operator's.
	const MARK = 'mark';

	function camRectFor(overlay, frame) {
		if (!frame || !frame.w) return null;
		if (overlay === MARK) {
			if (camRects.mark === null || camRects.mark === undefined) return null;
			overlay = camRects.mark;
		}
		const all = camRects.by[overlay];
		if (!all) return null;
		for (const r of all)
			if (r.fw === frame.w && r.fh === frame.h) return r;
		return null;
	}

	function mountOsdText(preview, held, headNote, panel, overlay, hooks) {
		const P = window.MajesticPlace;
		overlay = overlay || 0;
		hooks = hooks || {};
		const stage = preview.stage;
		// Where a press landed, so a TAP can be told from a drag: a tap on the
		// overlay brings its panel back after it has been closed, and a drag
		// must not.
		let tapFrom = null;
		// Focusable, because the arrow keys are half of what #340 asked for and
		// a keydown listener on an unfocusable element never fires. Scoped to
		// this leaf's own stage: mountOsdText is the Overlay leaf's and the
		// preview handle is per-mount.
		stage.tabIndex = 0;
		let active = true, drag = null;

		const layer = el('div', 'mj-osd-layer');
		preview.overlay.appendChild(layer);
		const guides = el('div', 'mj-osd-guides');
		layer.appendChild(guides);
		['gx-l', 'gx-c', 'gx-r'].forEach(c => guides.appendChild(el('span', 'mj-osd-g mj-osd-v ' + c)));
		['gy-t', 'gy-c', 'gy-b'].forEach(c => guides.appendChild(el('span', 'mj-osd-g mj-osd-h ' + c)));
		const ghost = el('div', 'mj-osd-ghost');
		// Hidden by VISIBILITY, not by `hidden`, and its layer stays laid out
		// even when this overlay is not the selected one — because the stand-in
		// is also how this overlay's size is measured, and a display:none box
		// measures zero. That is what lets a press on the picture find an
		// overlay that is not the one currently being dragged.
		ghost.style.visibility = 'hidden';
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
			// A logo is what the camera draws where there is one, so the
			// stand-in says so rather than reading out a template that is not
			// on the video.
			if (held.image && String(held.image.getValue() || '').trim())
				return 'Logo';
			return out || 'Overlay';
		}

		// Roughly what the camera will draw. Majestic derives the glyph size
		// from the stream width, so this tracks the same thing; it is an
		// approximation on purpose and never pretends otherwise.
		//
		// It has to be a CLOSE approximation now, which it was not. The
		// divisor is measured against what the camera actually draws: the
		// overlay's text comes out at about a 39.6th of the frame's width,
		// and the picture on screen is that frame at a different scale, so
		// the ratio holds against the picture's own width. It was 96, which
		// is 2.4x too small: the stand-in came out half the size of the text
		// it stands in for. GET /api/v1/osd reports the real rectangles and
		// is what the hit-testing uses; this is only the stand-in drawn under
		// the pointer before the camera has answered.
		//
		// That was invisible while the stand-in only appeared under a finger
		// mid-drag. It stopped being invisible when the same box became what a
		// press is tested against: drawn over the real overlays, the boxes sat
		// beside and below them, and FRONT GATE could not be picked up at all
		// because only the top edge of its box touched its text.
		function em(p) {
			const size = parseFloat(held.size ? held.size.getValue() : '1') || 1;
			return Math.max(6, p.w / EM_DIVISOR * size);
		}

		// The box the overlay occupies on screen, for the arithmetic below.
		//
		// The camera's own rectangle wherever it is known, and the stand-in's
		// measured size otherwise. The drag maths is built on this — where the
		// overlay is now, where a drop would put it, how far the anchor pulls
		// it — so an estimate here is an estimate in all of it. It matters most
		// for a logo, whose stand-in is a word and whose real shape is a
		// picture of no relation to it.
		const box = () => {
			const f = preview.frame();
			const cam = hooks.camRect && f ? hooks.camRect(overlay, f) : null;
			const p = pic();
			if (cam && p && f.w) {
				const k = p.w / f.w;
				return { w: cam.w * k, h: cam.h * k };
			}
			const lg = logoBox(p);
			if (lg) return lg;
			return {
				w: ghost.offsetWidth || 120,
				h: ghost.offsetHeight || 20,
			};
		};

		// A LOGO'S OWN SIZE ON SCREEN, before the camera has drawn it.
		//
		// The stand-in for a picture used to be the word "Logo" in a box the
		// size of the word — so a 240-pixel-wide picture was placed by
		// dragging a 50-pixel box, and where its far edge would land was a
		// guess until Save. The page has the picture: it decoded and
		// quantised it before sending it, and asks the camera for it back
		// after a reload. What it also has is the frame width the upload was
		// sized against, which is the whole of the camera's own scaling rule
		// — the picture is drawn at w * frame / ref on every stream, so on
		// the picture on screen it is w * p.w / ref, whichever stream that
		// is. Once the camera reports the rectangle it actually gave the
		// region, that answer wins; this is only for the gap before it.
		function logoBox(p) {
			const lg = hooks.logo && hooks.logo();
			if (!lg || !lg.w || !lg.h || !lg.ref || !p || !p.w) return null;
			const k = p.w / lg.ref;
			return { w: Math.max(2, lg.w * k), h: Math.max(2, lg.h * k) };
		}

		// Whether the page has to draw this overlay itself, because the
		// camera is not: a line or a picture added and not yet saved, or a
		// leaf whose switch is off. The camera's report is the only honest
		// source for "not drawn", so nothing is concluded before it has
		// answered once — and the caller says whether this overlay is one
		// that ought to be on the picture at all, since an empty index and
		// the vendor mark both have a placer and neither wants a stand-in.
		//
		// Before this the stand-in existed only under a finger: an item
		// added to the picture was invisible from the moment it was added
		// until Save, and appeared only while being dragged — so a fresh
		// logo or line could not be found on the picture to be dragged in
		// the first place.
		function undrawn() {
			if (!hooks.standIn || !hooks.standIn()) return false;
			const f = preview.frame();
			return !!f && !(hooks.camRect && hooks.camRect(overlay, f));
		}

		// What the stand-in is made of: the picture, where this overlay
		// draws one and the page holds it, and the line otherwise. The same
		// box the drag arithmetic measures — see box() — so a picture is
		// dragged by its own edges rather than by the word "Logo".
		let dressedUrl = '';
		function dress(p) {
			ghost.style.fontSize = em(p).toFixed(1) + 'px';
			const lg = hooks.logo && hooks.logo();
			const b = lg && lg.url ? logoBox(p) : null;
			if (b) {
				ghost.classList.add('mj-osd-ghost-img');
				ghost.style.width = b.w.toFixed(1) + 'px';
				ghost.style.height = b.h.toFixed(1) + 'px';
				// A data URL of the whole picture, set only when it changes:
				// a style write of a megabyte string per repaint is a
				// repaint that costs something.
				if (dressedUrl !== lg.url) {
					dressedUrl = lg.url;
					ghost.style.backgroundImage = 'url("' + lg.url + '")';
				}
				ghost.textContent = '';
				return;
			}
			if (dressedUrl) {
				dressedUrl = '';
				ghost.style.backgroundImage = '';
			}
			ghost.classList.remove('mj-osd-ghost-img');
			ghost.style.width = '';
			ghost.style.height = '';
			ghost.textContent = shown();
		}

		// The span an offset is measured against is the frame being SHOWN,
		// which is the picture on screen — not video0. That is the same reading
		// majestic takes per channel, which is why a share travels between them
		// and a pixel count does not.
		function spans(p) {
			const f = preview.frame();
			const emPx = em(p);
			return {
				w: f ? f.w : 0, h: f ? f.h : 0,
				emx: emPx * (f && p.w ? f.w / p.w : 1),
				emy: emPx * (f && p.h ? f.h / p.h : 1),
			};
		}

		// Which spelling this camera's offsets are written in. A bare non-zero
		// really is pixels and stays pixels; a bare zero carries no choice, and
		// a share is what travels between Main and Sub.
		//
		// EXCEPT WHERE THE CALLER FIXES IT, which the vendor mark does. A bare
		// offset is resolved against the channel being drawn, so pixels chosen
		// on a 2592-wide main are off the edge of a 1280-wide sub and clamp
		// into its corner: dragged to the middle of one picture, cowering in
		// the corner of the other. For an overlay that is the operator's, that
		// is their choice to make and the unit is theirs. For the mark it is
		// not a choice at all — there is no unit control, its position has to
		// hold on every output, and a share is the only spelling that does.
		function unit(axis) {
			if (hooks.unit) return hooks.unit;
			const x = P.unitOf(held.offsetX && held.offsetX.getValue());
			const y = P.unitOf(held.offsetY && held.offsetY.getValue());
			// PER AXIS, because the two fields are two settings. Picking the
			// first spelling either of them happened to hold and writing both
			// in it rewrote an axis that had not moved — a vertical offset in
			// em became a percentage because the horizontal one was, which is
			// a value the operator chose being replaced by one they did not.
			// An axis with no spelling of its own borrows the other's, since
			// there is nothing there to overwrite.
			if (axis === 'y') return y || x || P.DEFAULT_UNIT;
			return x || y || P.DEFAULT_UNIT;
		}

		// Where the overlay is now, from the fields the camera is reading.
		function current(p) {
			const a = held.anchor ? held.anchor.getValue() : P.PROPORTIONAL;
			const b = box();
			if (P.isProportional(a)) {
				return P.proportionalSpot(
					p, b,
					held.posX && held.posX.getValue(),
					held.posY && held.posY.getValue());
			}
			const sp = spans(p);
			const fx = P.toFrac(
				held.offsetX && held.offsetX.getValue(), sp.w, sp.emx);
			const fy = P.toFrac(
				held.offsetY && held.offsetY.getValue(), sp.h, sp.emy);
			return P.anchoredSpot(p, b, P.sidesOf(a), fx, fy);
		}

		// What the placement IS, at rest, in the head beside the section name.
		//
		// The parameter for this was passed and never read: the readout only
		// existed while a finger was down, so the one number worth writing on a
		// sticky note — the thing that reproduces this layout on the next
		// camera, which is what #340 was asking for — was the one number you
		// could not see. It says the mode, and in anchored mode the two offsets
		// in whatever unit they are actually written in.
		function sayPlacement() {
			// Only the selected overlay writes it. There is one note beside the
			// section name and several overlays, so an inactive one repainting
			// would state a placement for something nobody is editing.
			if (!headNote || !active) return;
			const a = held.anchor ? held.anchor.getValue() : P.PROPORTIONAL;
			if (P.isProportional(a)) {
				const px = held.posX ? held.posX.getValue() : 0;
				const py = held.posY ? held.posY.getValue() : 0;
				headNote.textContent = 'Proportional · ' + px + ' · ' + py;
				return;
			}
			const sides = P.sidesOf(a);
			const ox = held.offsetX ? held.offsetX.getValue() : '';
			const oy = held.offsetY ? held.offsetY.getValue() : '';
			headNote.textContent = P.sayOf(a) +
				(sides.x ? ' · ' + ox : '') + (sides.y ? ' · ' + oy : '');
		}

		function paint() {
			sayPlacement();
			if (panel && active) panel.name(shown());
			const p = pic();
			// The LAYER stays whenever there is a picture: an unselected
			// overlay still has to be measurable, and everything in it is
			// invisible and pointer-transparent until a drag starts. Only the
			// catcher is the selected overlay's alone.
			layer.hidden = !p;
			catcher.hidden = !active || !p;
			if (!p) return;
			dress(p);
			guides.style.left = p.x + 'px';
			guides.style.top = p.y + 'px';
			guides.style.width = p.w + 'px';
			guides.style.height = p.h + 'px';
			if (!drag) {
				// Parked where the overlay actually is, invisibly. Only the
				// drag used to position it, so at rest every stand-in sat at
				// the layer's origin — which costs nothing while nobody can
				// see it, and is wrong the moment the element's own box is
				// what a press is tested against.
				const c = current(p);
				ghost.style.left = c.x + 'px';
				ghost.style.top = c.y + 'px';
				// And SHOWN there, when the camera is not drawing this
				// overlay — dashed, because it is the page's drawing and not
				// the camera's, and without the readout and the guides,
				// which belong to a drag. Hidden otherwise: the camera's
				// rendering is on the video already and a second copy
				// beside it would be two overlays for one setting.
				const rest = undrawn();
				ghost.style.visibility = rest ? '' : 'hidden';
				ghost.classList.toggle('mj-osd-rest', rest);
				read.hidden = true;
				guides.classList.remove('mj-osd-on');
			}
		}

		// Where this overlay is on screen right now, selected or not. The same
		// two answers the drag already computes — where the placement puts it,
		// and how big the stand-in is — asked for a different reason.
		function rectOn(p) {
			// The camera's own answer where there is one, mapped from the
			// stream's pixels onto the picture on screen.
			const f = preview.frame();
			const cam = hooks.camRect && f ? hooks.camRect(overlay, f) : null;
			if (cam && f.w) {
				const k = p.w / f.w;
				return {
					x: p.x + cam.x * k, y: p.y + cam.y * k,
					w: cam.w * k, h: cam.h * k,
				};
			}
			const b = box();
			const c = current(p);
			return { x: c.x, y: c.y, w: b.w, h: b.h };
		}

		/* How much of the picture this overlay covers, for deciding between two
		 * that are both under the press. */
		function areaOn() {
			const b = box();
			return b.w * b.h;
		}

		function hitAt(pt) {
			const p = pic();
			if (!p) return false;
			const r = rectOn(p);
			// A little slack either way. Where the rectangle came from the
			// camera it is exact and this only forgives the pointer; where it
			// is still the browser's estimate it forgives the estimate too.
			const pad = Math.max(4, r.h / 4);
			return pt.x >= r.x - pad && pt.x <= r.x + r.w + pad &&
				pt.y >= r.y - pad && pt.y <= r.y + r.h + pad;
		}

		// A DRAG NEVER CHANGES THE ANCHOR.
		//
		// This reverses what shipped, and it is issue #340's own request.
		// Snapping to a named corner is what makes a placement survive a change
		// of resolution — which is why the placer this replaces re-anchored
		// under the drag — and doing it while somebody's finger is down is
		// exactly what read as the editor deciding on their behalf. The anchor
		// is chosen on the pad and nowhere else; the magnet that remains pulls
		// an offset to ZERO, which is the same help without the silent
		// reclassification.
		//
		// In proportional mode the drag writes posX/posY, so a camera that has
		// never been placed by hand keeps the coordinate system it came with.
		function place(px, py, p) {
			const a = held.anchor ? held.anchor.getValue() : P.PROPORTIONAL;
			const b = box();
			if (P.isProportional(a)) {
				const r = P.dragProportional(p, b, { x: px, y: py });
				return { prop: true, posX: r.posX, posY: r.posY };
			}
			const sides = P.sidesOf(a);
			const sp = spans(p);
			const ux = unit('x'), uy = unit('y');
			const f = P.dragWithin(p, b, sides, { x: px, y: py });
			return {
				prop: false, sides: sides, anchor: a, u: ux,
				ox: P.fromFrac(f.fx, ux, sp.w, sp.emx),
				oy: P.fromFrac(f.fy, uy, sp.h, sp.emy),
				fx: f.fx, fy: f.fy,
			};
		}

		// What the drag is about to write, as the document to push.
		function docOf(r) {
			if (r.prop)
				return osdPlaceDoc(overlay, { anchor: P.PROPORTIONAL,
					posX: String(r.posX), posY: String(r.posY) });
			const keys = { anchor: r.anchor };
			if (r.sides.x !== 0) keys.offsetX = r.ox;
			if (r.sides.y !== 0) keys.offsetY = r.oy;
			return osdPlaceDoc(overlay, keys);
		}

		function preview_(r, p) {
			const b = box();
			const g = r.prop
				? P.proportionalSpot(p, b, r.posX, r.posY)
				: P.anchoredSpot(p, b, r.sides, r.fx, r.fy);
			ghost.style.left = g.x + 'px';
			ghost.style.top = g.y + 'px';
			read.style.left = g.x + 'px';
			read.style.top = Math.max(0, g.y - 24) + 'px';
			read.innerHTML = r.prop
				? '<b>Proportional</b><span>' + r.posX + ' · ' + r.posY + '</span>'
				: '<b>' + esc(P.sayOf(r.anchor)) + '</b>' +
					(r.sides.x || r.sides.y
						? '<span>' + (r.sides.x ? r.ox : '—') + ' · ' +
							(r.sides.y ? r.oy : '—') + '</span>'
						: '');
			guides.querySelectorAll('.mj-osd-g').forEach(
				g2 => g2.classList.remove('mj-osd-lit'));
			if (r.prop) return;
			// The guide lights where the offset is zero — the magnet's whole
			// vocabulary now that it no longer moves the anchor.
			const gx = r.sides.x === -1 ? '.gx-l' : r.sides.x === 0 ? '.gx-c' : '.gx-r';
			const gy = r.sides.y === -1 ? '.gy-t' : r.sides.y === 0 ? '.gy-c' : '.gy-b';
			if (r.sides.x !== 0 && r.fx === 0)
				guides.querySelector(gx).classList.add('mj-osd-lit');
			if (r.sides.y !== 0 && r.fy === 0)
				guides.querySelector(gy).classList.add('mj-osd-lit');
		}

		const at = (e) => {
			const r = preview.overlay.getBoundingClientRect();
			return { x: e.clientX - r.left, y: e.clientY - r.top };
		};

		// Taking hold of this overlay, wherever the press came from: its own
		// catcher, or another overlay's catcher handing it over because the
		// press landed here.
		function grab(e) {
			const p = pic();
			if (!p) return;
			tapFrom = { x: e.clientX, y: e.clientY };
			ghost.style.visibility = '';
			read.hidden = false;
			guides.classList.add('mj-osd-on');
			const cur = current(p);
			const n = at(e);
			drag = { id: e.pointerId, dx: n.x - cur.x, dy: n.y - cur.y };
			try { catcher.setPointerCapture(e.pointerId); } catch (err) {}
			try { stage.focus(); } catch (err) {}
			preview_(place(cur.x, cur.y, p), p);
		}

		catcher.addEventListener('pointerdown', (e) => {
			if (e.button || drag || !active) return;
			const p = pic();
			if (!p) return;
			e.preventDefault();

			// WHAT THE PRESS LANDED ON DECIDES WHICH OVERLAY MOVES.
			//
			// The catcher covers the whole picture, so without this a press
			// anywhere drags whichever overlay happens to be selected — and
			// the only way to reach a second one was the chip row under the
			// picture. Pressing the text you want to move is the obvious
			// gesture and it did nothing, which reads as only one overlay
			// being draggable at all.
			//
			// The handover is inside one gesture: the thing under the press is
			// selected AND picked up, so it moves with the same drag rather
			// than needing a second one. It is the same rule the region editor
			// states — a region is a thing you can pick up, and what the press
			// landed on decides the gesture.
			//
			// THIS OVERLAY IS ONE OF THE THINGS UNDER THE PRESS, and has to be
			// weighed against the rest rather than simply losing to them: a
			// privacy mask is a rectangle that can cover the whole picture,
			// and without the comparison it would take every press away from
			// the very overlay it is drawn behind. Off the overlay there is
			// nothing of ours to weigh, so anything found wins — which is what
			// keeps a press on empty picture dragging the selected overlay
			// when there is nothing else there.
			const pt = at(e);
			const mine = hitAt(pt) ? areaOn() : Infinity;
			// Probed first, committed second: measuring must not move the
			// selection, so only the second call is allowed to select.
			const seen = hooks.pickAt && hooks.pickAt(pt, overlay, true);
			if (seen && seen.area < mine) {
				const other = hooks.pickAt(pt, overlay);
				if (other) { other.grab(e); return; }
			}

			grab(e);
		});

		// And the pointer says so before the press: over another overlay this
		// is a thing to pick up, not a picture to drag the selected one across.
		catcher.addEventListener('pointermove', (e) => {
			if (drag || !active) return;
			const pt = at(e);
			const mine = hitAt(pt) ? areaOn() : Infinity;
			const seen = hooks.pickAt && hooks.pickAt(pt, overlay, true);
			catcher.classList.toggle('mj-osd-pickable', !!seen && seen.area < mine);
		});

		catcher.addEventListener('pointermove', (e) => {
			if (!drag || e.pointerId !== drag.id) return;
			const p = pic();
			if (!p) return;
			const n = at(e);
			const r = place(n.x - drag.dx, n.y - drag.dy, p);
			preview_(r, p);
			// The camera follows the pointer. postLivePlace serialises and
			// swallows its own failures, so a move that cannot land does not
			// wedge the ones after it or interrupt the drag.
			const key = JSON.stringify(r.prop
				? [r.posX, r.posY] : [r.anchor, r.ox, r.oy]);
			if (key !== drag.last) {
				drag.last = key;
				postLivePlace(docOf(r));
			}
		});

		// Staged, not saved. The camera is already showing it — that happened on
		// the way here, one push per move — so all that is left is for the form
		// to agree, and for Save to mean what it means everywhere else.
		function commitTo(r) {
			if (r.prop) {
				if (held.posX) held.posX.setValue(r.posX);
				if (held.posY) held.posY.setValue(r.posY);
			} else {
				if (held.offsetX && r.sides.x !== 0) held.offsetX.setValue(r.ox);
				if (held.offsetY && r.sides.y !== 0) held.offsetY.setValue(r.oy);
			}
			runVisibility();
			updateDirty();
			postLivePlace(docOf(r));
			// The camera has just moved it, so its rectangle is stale. Asking
			// now rather than waiting out the tick keeps the next press honest.
			if (hooks.rectsChanged) hooks.rectsChanged();
		}

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
			const moved = tapFrom &&
				(Math.abs(e.clientX - tapFrom.x) > 4 ||
				 Math.abs(e.clientY - tapFrom.y) > 4);
			tapFrom = null;
			if (!moved) { if (panel) panel.reveal(); paint(); return; }
			commitTo(place(n.x - dx, n.y - dy, p));
			paint();
		}

		// One step, exactly, repeatable — the half a mouse cannot do, and what
		// "precise" means in the request this came from. Shift for ten.
		stage.addEventListener('keydown', (e) => {
			if (!active) return;
			const k = e.key;
			if (k !== 'ArrowLeft' && k !== 'ArrowRight' &&
				k !== 'ArrowUp' && k !== 'ArrowDown') return;
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			const p = pic();
			if (!p) return;
			e.preventDefault();
			const big = e.shiftKey ? 10 : 1;
			const a = held.anchor ? held.anchor.getValue() : P.PROPORTIONAL;
			const cl = (v) => Math.min(Math.max(v, -P.POS_MAX), P.POS_MAX);
			if (P.isProportional(a)) {
				const px = +(held.posX && held.posX.getValue()) || 0;
				const py = +(held.posY && held.posY.getValue()) || 0;
				const dx = k === 'ArrowLeft' ? big : k === 'ArrowRight' ? -big : 0;
				const dy = k === 'ArrowUp' ? big : k === 'ArrowDown' ? -big : 0;
				commitTo({ prop: true, posX: cl(px + dx), posY: cl(py + dy) });
				paint();
				return;
			}
			const sides = P.sidesOf(a);
			const sp = spans(p);
			/* The axis being nudged, in ITS unit. An arrow moves one axis, so
			 * writing both in one spelling rewrote the one that had not
			 * moved. */
			const horiz = k === 'ArrowLeft' || k === 'ArrowRight';
			const u = unit(horiz ? 'x' : 'y');
			const ux = unit('x'), uy = unit('y');
			const step = (u === 'px' ? 1 : 0.1) * big;
			const r = (n) => Math.round(n * 10) / 10;
			const cur = {
				ox: parseFloat(held.offsetX && held.offsetX.getValue()) || 0,
				oy: parseFloat(held.offsetY && held.offsetY.getValue()) || 0,
			};
			let ox = cur.ox, oy = cur.oy;
			if (k === 'ArrowLeft' || k === 'ArrowRight')
				ox = Math.max(0, r(ox + P.nudge(sides, 'x',
					k === 'ArrowRight' ? 1 : -1) * step));
			else
				oy = Math.max(0, r(oy + P.nudge(sides, 'y',
					k === 'ArrowDown' ? 1 : -1) * step));
			const sfx = (v) => (v === '%' ? '%' : v === 'em' ? 'em' : '');
			const sx = ox + sfx(ux), sy = oy + sfx(uy);
			commitTo({
				prop: false, sides: sides, anchor: a, u: u,
				ox: sx, oy: sy,
				fx: P.toFrac(sx, sp.w, sp.emx),
				fy: P.toFrac(sy, sp.h, sp.emy),
			});
			paint();
		});

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
			overlay: overlay,
			hitAt: hitAt,
			area: areaOn,
			grab: grab,
			setActive: (on) => { active = !!on; paint(); },
			// For anything that writes the placement rows directly — the anchor
			// pad, a typed offset — so the camera follows a click the same way
			// it follows a drag.
			pushNow: () => { postLivePlace(placementDoc(held, overlay)); paint(); },
		};
	}

	// WHAT AN OVERLAY SAYS: a line or a picture, and only ever one of them.
	//
	// It is CHOSEN BY DOING, not by a mode switch. The switch that stood here
	// was a second row of segmented buttons under the tab strip — two rows of
	// the same control doing two unrelated jobs — and it had a state you could
	// be in with nothing in it: Picture selected, no picture, an empty panel.
	//
	// One button instead, on the thing it changes: from text, "Use a picture
	// instead" opens the chooser, and the overlay only becomes a picture if one
	// is actually chosen — a cancelled chooser leaves it exactly as it was,
	// which a mode switch cannot promise. From a picture, "Use text instead"
	// goes back. The overlay is a picture exactly when it has one, which is the
	// same rule the daemon, the item list and the stand-in all read; nothing
	// here is a second place that answer is kept.
	//
	// `onKind` tells the caller which of the two this is, because the tab strip
	// has to drop Look for a picture: every control on it — the font, its size,
	// its weight, its outline, the plate behind the text — is about drawing
	// text, and none of it touches a bitmap the camera blits.
	function buildContent(box, held, overlay, preview, onKind, onPicture) {
		if (!held.template && !held.image) return;

		const wrap = el('div', 'mj-osd-content');
		box.insertBefore(wrap, box.firstChild);

		const logoPart = el('div');
		const textPart = el('div');
		wrap.appendChild(logoPart);
		wrap.appendChild(textPart);

		// The chip builder sits above the raw template row and drives it. The
		// row stays — hidden — so Save and the reset arrow keep working on the
		// field itself, and a build whose template this cannot parse falls back
		// to showing it rather than losing it.
		if (held.template) {
			held.template.p.hidden = true;
			buildTemplate(textPart, held.template);
		}
		// The image field is a path like osd.font is, so a firmware can ship a
		// picture and this is one way of putting one there rather than the only
		// way. Hidden and driven by the picker, on the pin-map pattern, so Save,
		// dirty tracking and the per-row reset never learn a picker exists.
		let picker = null;
		if (held.image) {
			held.image.p.hidden = true;
			picker = buildLogo(logoPart, held.image, held.template, overlay,
				preview);
			if (onPicture) picker.onPicture(onPicture);
		}

		const isLogo = () =>
			!!(held.image && String(held.image.getValue() || '').trim());

		// The one control, only where the camera can draw a picture at all.
		let swap = null;
		if (held.image) {
			swap = el('button', 'mj-osd-swap');
			swap.type = 'button';
			textPart.appendChild(swap);
			swap.addEventListener('click', () => {
				if (!isLogo()) {
					// Inside the press, which is what lets the chooser open.
					if (picker) picker.choose();
					return;
				}
				if (picker) picker.remove();
			});
			// From a picture, the way back sits with the picture's own
			// controls rather than under the text that is not being shown.
			if (picker) picker.onBack(() => {
				// An overlay that says nothing is not listed, so it would
				// vanish from under the person who just pressed it.
				if (held.template &&
					!String(held.template.getValue() || '').trim()) {
					held.template.setValue('Text');
					held.template.control.dispatchEvent(
						new Event('change', { bubbles: true }));
					runVisibility();
					updateDirty();
				}
			});
		}

		function paint() {
			const logo = isLogo();
			logoPart.hidden = !logo;
			textPart.hidden = logo;
			if (swap) swap.textContent = 'Use a picture instead…';
			if (onKind) onKind(logo);
		}

		if (held.image) held.image.control.addEventListener('change', paint);
		paint();

		// The picture the overlay draws, as the stand-in needs it: its size,
		// the frame width it was sized against, and the pixels. Null for a
		// line, and for a picture the page has not got hold of.
		return { logo: () => (picker ? picker.logo() : null) };
	}

	// A LOGO: a picture drawn into the overlay instead of a line.
	//
	// The browser decodes and quantises, and sends pixels. There is no image
	// decoder anywhere in majestic — no libpng, no stb_image — and a logo is
	// not a reason to put one on the daemon, parsing a hostile file, when the
	// browser has a decoder already and is the only place the result can be
	// shown before it is burned into a video.
	//
	// So the preview here is not a courtesy. It is the same reduction the
	// camera's overlay format forces (four bits a channel; one bit of alpha on
	// HiSilicon gen 1), applied here so that what you approve is what the
	// camera will draw — rather than a crisp picture in the page and a banded
	// one on the stream, with nowhere to see the difference until it is
	// recorded.
	function buildLogo(container, field, tplField, overlay, preview) {
		const wrap = el('div', 'mj-logo');
		container.insertBefore(wrap, container.firstChild);

		wrap.innerHTML =
			'<div class="mj-logo-head">' +
				'<span class="mj-cap">Logo</span>' +
				'<span class="mj-logo-note"></span>' +
			'</div>' +
			'<div class="mj-logo-body">' +
				'<canvas class="mj-logo-shot" hidden></canvas>' +
				'<p class="mj-logo-empty"></p>' +
			'</div>' +
			'<div class="mj-logo-acts">' +
				'<label class="mj-logo-pick">' +
					'<input type="file" accept="image/*" hidden>' +
					'<span class="mj-logo-pick-w">Choose a picture…</span>' +
				'</label>' +
				// "Use text instead", not "Remove": what it does is put the
				// overlay back to drawing its line, and naming the consequence
				// is the difference between a button you can predict and one
				// you have to try.
				'<button type="button" class="mj-logo-drop" hidden>' +
					'Use text instead</button>' +
			'</div>';

		const note = wrap.querySelector('.mj-logo-note');
		const shot = wrap.querySelector('.mj-logo-shot');
		const empty = wrap.querySelector('.mj-logo-empty');
		const input = wrap.querySelector('input[type=file]');
		const drop = wrap.querySelector('.mj-logo-drop');
		const pickWord = wrap.querySelector('.mj-logo-pick-w');
		let onBack = null;

		function say(msg, bad) {
			note.textContent = msg || '';
			note.classList.toggle('mj-logo-bad', !!bad);
		}

		// Declared ABOVE the first thing that reads them. paint() only runs
		// after this point today, but a `let` read before its declaration is a
		// ReferenceError rather than an undefined, and this file has already
		// lost a whole section of a form to exactly that.
		let drawn = false;   // the canvas holds this overlay's picture
		let asked = false;   // the camera has been asked for it
		// The picture as the stand-in on the video needs it: pixel size, the
		// frame width it is scaled against, and the pixels as a data URL.
		// Set when the camera has it — after an upload lands, or when it
		// hands one back — and cleared when the overlay stops drawing it.
		let pict = null;
		let onPicture = null;
		// WHICH PICTURE AN ANSWER IS ABOUT. The fetch, the upload and the
		// removal are all asynchronous against each other, and a reply
		// belongs to the picture that was current when it was asked for:
		// a fetch of the old picture that lands after a replacement was
		// uploaded used to paint the old pixels over the new ones and size
		// the stand-in to them, and an upload that landed after the cross
		// was pressed wrote the path back into a field just cleared. Every
		// start bumps this, every completion checks it, and a stale answer
		// is dropped on the floor.
		let gen = 0;

		function have(p) {
			pict = p;
			if (onPicture) onPicture();
		}

		function paint() {
			const has = !!String(field.getValue() || '').trim();
			drop.hidden = !has;
			// Choosing when there is nothing, replacing when there is.
			pickWord.textContent = has ? 'Replace picture…' : 'Choose a picture…';
			if (!has) {
				shot.hidden = true;
				empty.hidden = false;
				// The picture is gone, whoever took it: the button below, the
				// cross on the item row, a per-row reset, a save that put the
				// field back. Everything the picker holds of it goes with it,
				// and anything still in flight about it is disowned — a fetch
				// of it that lands now would otherwise hand the stand-in a
				// picture the overlay no longer draws, and a line added to
				// this index next would stand in as that picture.
				if (pict || drawn || asked) {
					drawn = false;
					asked = false;
					gen++;
					have(null);
				}
				// What happens if this is left empty, said honestly: it depends
				// on whether the overlay has anything else to say.
				const t = tplField ? String(tplField.getValue() || '').trim() : '';
				empty.textContent = t
					? 'No picture. The overlay draws “' +
						(t.length > 24 ? t.slice(0, 23) + '…' : t) + '”.'
					: 'No picture yet.';
				return;
			}
			// There IS one, so show it. Drawn already if it was chosen in this
			// visit; otherwise fetched, because a reload has had no visit and
			// an empty frame where a picture should be is the worst of the
			// three things this box can say.
			if (drawn) {
				shot.hidden = false;
				empty.hidden = true;
				return;
			}
			shot.hidden = true;
			empty.hidden = false;
			empty.textContent = 'Loading the picture…';
			fetchShot();
		}

		function fetchShot() {
			if (asked) return;
			asked = true;
			const my = ++gen;
			// Cleared on failure below: a transient network error left this
			// set for the life of the editor, so every later repaint refused
			// to look again and the picture stayed on its error message even
			// once the camera was answering.
			apiFetch('/api/v1/osd/image?overlay=' + overlay,
				{ credentials: 'same-origin' })
				.then((r) => {
					if (!r.ok) throw new Error('HTTP ' + r.status);
					const w = +r.headers.get('X-Osd-Width');
					const h = +r.headers.get('X-Osd-Height');
					if (!w || !h) throw new Error('no size');
					// The width the picture is scaled against, which the
					// camera keeps in the file. A file without one is drawn
					// pixel for pixel, and that is what its own width says.
					const ref = +r.headers.get('X-Osd-Ref') || w;
					return r.arrayBuffer().then(
						(b) => ({ w: w, h: h, b: b, ref: ref }));
				})
				.then(({ w, h, b, ref }) => {
					// Not this picture any more: replaced or removed while
					// the camera was answering.
					if (my !== gen) return;
					const src = new Uint8Array(b);
					if (src.length < w * h * 4) throw new Error('short');
					const ctx = shot.getContext('2d');
					shot.width = w;
					shot.height = h;
					const out = ctx.createImageData(w, h);
					// BGRA on the wire, RGBA in a canvas: the same swap the
					// upload does, in reverse.
					for (let i = 0; i < w * h * 4; i += 4) {
						out.data[i] = src[i + 2];
						out.data[i + 1] = src[i + 1];
						out.data[i + 2] = src[i];
						out.data[i + 3] = src[i + 3];
					}
					ctx.putImageData(out, 0, 0);
					drawn = true;
					have({ w: w, h: h, ref: ref, url: shot.toDataURL() });
					shot.hidden = false;
					empty.hidden = true;
					say(w + '×' + h + ' · on the camera');
				})
				.catch(() => {
					if (my !== gen) return;
					// Asked again next time. This is the difference between a
					// logo that is not there and one the camera did not answer
					// for just now, and only the second is worth retrying —
					// but the flag could not tell them apart and refused both
					// for the life of the editor.
					asked = false;
					// A path that is set and a picture that cannot be had are
					// not the same as no picture, and the box says which.
					shot.hidden = true;
					empty.hidden = false;
					empty.textContent =
						'A picture is set, but the camera could not hand it ' +
						'back. It may not be there any more.';
				});
		}

		// What the camera's overlay can carry. Four bits a channel is every
		// current part; gen 1's single alpha bit is not asked about here
		// because this page cannot know the generation — the camera applies it,
		// and a soft edge that comes out hard is the one difference between
		// this preview and the stream.
		function quantise(img) {
			const w = img.width, h = img.height;
			const c = document.createElement('canvas');
			c.width = w; c.height = h;
			const ctx = c.getContext('2d');
			ctx.drawImage(img, 0, 0);
			const d = ctx.getImageData(0, 0, w, h);
			const px = d.data;
			// (v >> 4) * 17 rather than (v >> 4) << 4: it maps the four bits
			// back over the whole range, so white stays 255 instead of 240 and
			// the preview does not read as a picture the camera has dimmed.
			for (let i = 0; i < px.length; i++)
				px[i] = (px[i] >> 4) * 17;
			ctx.putImageData(d, 0, 0);
			return { canvas: c, data: d, w: w, h: h };
		}

		// The frame the pixels are chosen for, so the camera can keep the same
		// share of every stream: it is sent with the upload as `ref` and the
		// camera scales the picture by it. The frame on screen is the one the
		// operator sized it against, so that is what is reported.
		function refWidth() {
			const f = preview && preview.frame && preview.frame();
			return f && f.w ? f.w : 1920;
		}

		function upload(q) {
			const ref = refWidth();
			const my = ++gen;
			say('Sending ' + q.w + '×' + q.h + '…');
			return apiFetch(
				'/api/v1/osd/image?overlay=' + overlay + '&w=' + q.w +
					'&h=' + q.h + '&ref=' + ref,
				{
					method: 'POST',
					credentials: 'same-origin',
					headers: { 'Content-Type': 'application/octet-stream' },
					body: q.data.data,
				})
				.then((r) => (r.ok ? r.json() : r.text().then((t) => {
					throw new Error(t || ('HTTP ' + r.status));
				})))
				.then((j) => {
					// Overtaken: another picture was chosen, or this one
					// removed, before the camera answered. The file on the
					// camera is whichever request it took last, and that
					// request's own completion is the one that says so.
					if (my !== gen) return;
					// This upload has already overwritten the file, so a
					// removal staged earlier in this visit must not delete it.
					logoBin.delete(overlay);
					// What is on the canvas is this picture now, and the
					// camera's copy is worth asking for again if it is ever
					// wanted.
					drawn = true;
					asked = false;
					// What the canvas holds is what the camera now has, sized
					// against the frame this upload named.
					have({ w: q.w, h: q.h, ref: ref, url: shot.toDataURL() });
					// The camera decides the path; this only records it, and
					// it is a staged edit like any other until Save.
					field.setValue(j.path);
					field.control.dispatchEvent(
						new Event('change', { bubbles: true }));
					// A picture chosen is a picture asked for. This is where
					// a logo starts being drawn — "+ Logo" writes nothing
					// until one is picked — so this is where the switch that
					// draws it follows.
					drawWhatWasAdded();
					runVisibility();
					updateDirty();
					paint();
					// The camera's number, not this one's: it compresses the
					// pixels, so what lands in flash is not w*h*4 and saying
					// that would overstate the cost by a factor of fifty.
					// Only where the camera said. w*h*4 is what was SENT, and
					// the comment above says the stored file can be fifty
					// times smaller — so printing that number as the size on
					// the camera is not an estimate, it is the wrong figure
					// with a unit after it. A camera that does not report the
					// stored size gets a sentence with no size in it.
					const kb = j.stored
						? Math.max(1, Math.round(j.stored / 1024)) + ' KB · '
						: '';
					say(q.w + '×' + q.h + ' · ' + kb +
						Math.round(q.w * 100 / ref) +
						'% of the picture’s width. Press Save to draw it.');
				})
				.catch((e) => {
					if (my === gen) say('Could not send it: ' + e.message, true);
				});
		}

		input.addEventListener('change', () => {
			const file = input.files && input.files[0];
			input.value = '';
			if (!file) return;

			const img = new Image();
			const url = URL.createObjectURL(file);
			img.onload = () => {
				URL.revokeObjectURL(url);
				// Bounded by what the camera will store, and said before the
				// upload rather than refused after it: the file lands in the
				// camera's writable overlay and becomes region memory on every
				// stream carrying it.
				if (img.width > 1024 || img.height > 1024) {
					say('That picture is ' + img.width + '×' + img.height +
						'. The camera draws up to 1024 each way.', true);
					return;
				}
				if (img.width * img.height * 4 > (1 << 20)) {
					say('That picture is more than a megabyte of pixels, ' +
						'which is more than the camera will store.', true);
					return;
				}
				const q = quantise(img);
				shot.width = q.w;
				shot.height = q.h;
				shot.getContext('2d').drawImage(q.canvas, 0, 0);
				shot.hidden = false;
				empty.hidden = true;
				upload(q);
			};
			img.onerror = () => {
				URL.revokeObjectURL(url);
				say('That file is not a picture this browser can open.', true);
			};
			img.src = url;
		});

		drop.addEventListener('click', () => {
			if (onBack) setTimeout(onBack, 0);
			// The rest of what removal means — the canvas, the pixels held
			// for the stand-in, anything in flight — is done by paint() when
			// the field goes empty below, because the field can be emptied
			// from outside this picker too.
			// STAGED, like the field beside it. Deleting the file here made
			// one half of this change permanent the moment it was pressed
			// while the other half waited for Save — so leaving without
			// saving, or pressing the row's reset arrow, left a configuration
			// still naming a picture whose bytes were gone, and nothing could
			// put them back. logoBin carries the removal to Save, which is
			// where the rest of this edit lands.
			logoBin.add(overlay);
			field.setValue('');
			field.control.dispatchEvent(new Event('change', { bubbles: true }));
			shot.hidden = true;
			runVisibility();
			updateDirty();
			paint();
			const t = tplField ? String(tplField.getValue() || '') : '';
			say(t ? 'Removed. The overlay draws its text again.'
				: 'Removed. Give the overlay some text, or it draws nothing.');
		});

		field.control.addEventListener('change', paint);
		paint();

		// The two acts the kind switch above needs. `choose` has to be called
		// inside a press or the chooser will not open.
		return {
			choose: () => input.click(),
			remove: () => drop.click(),
			// Run after the picture goes, so the caller can make sure the
			// overlay still says something.
			onBack: (fn) => { onBack = fn; },
			// The picture itself, for the stand-in on the video, and a word
			// when it changes hands — the fetch lands whenever the camera
			// answers, and whoever draws from it has to be told.
			logo: () => pict,
			onPicture: (fn) => { onPicture = fn; },
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
		const raw = el('div');
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

	// A section the Live leaf lifted a MINORITY of keeps its page, and says at
	// the top of it where the lifted part went. No section majestic ships today
	// is in that state — image, the one section with live knobs, is absorbed
	// whole (absorbed()) — so this is for the build that classes one exposure
	// control live. Only claims what is actually on the leaf: liveFields() is
	// the same list renderLive() mounts.
	//
	// Destination first. Led by the list of names, the note read as a
	// description of the page it was on — and a description naming six settings
	// the page did not have (#316).
	function liftedNote(sec) {
		const mine = liveFields().filter(f => f.section === sec);
		if (!mine.length) return null;
		const names = mine.map(f => liveLabel(f.key, f.sub).toLowerCase());
		const list = names.length > 1
			? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1]
			: names[0];
		const p = el('p', 'mj-lifted');
		p.innerHTML = 'On <a href="?tab=' + LIVE_ID + '">Live adjustments</a>, with the ' +
			'picture: ' + esc(list) + '. They apply as you drag them.';
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
			// The heartbeat's own sample, not a second one assembled here.
			// Which door is being watched (src) and the wait the camera is
			// currently applying (dwell) used to be read out of the raw metrics
			// on this page alone, so the Dashboard's copy of the same call had
			// neither and every finding that turns on them was decided from an
			// absence (#325). One place builds the sample now, and both pages
			// ask the same question of the same object.
			ircutSample = s;
			ircutStats = ircutTrack.push(ircutSample, performance.now() / 1000);
			paintNightInert(ircutSample.src);
			paintFindings();
			paintMonitor(s);
		});
	}

	// Automatic day/night's live view: one sentence about what the camera is
	// doing and, where there is something continuous to watch, a chart of the
	// value with the switching bands shaded. What to show is decided in
	// ircut-check.js (monitorView, tested); this only mounts it. The chart is
	// remade when the mode or the bands change, and the superseded instance is
	// dropped from the registry.
	//
	// The block is hidden only while the camera has not answered at all. Every
	// other state — the switch off, a wired photocell, a monitor that stood
	// down — gets the sentence without the chart, because a section that
	// appears only in the configuration it is describing cannot be found from
	// any of the others (#325).
	let monChart = null;
	let monKey = '';
	function dropMonChart(MC, host) {
		if (MC) MC.dropChart(monChart);
		monChart = null;
		monKey = '';
		if (host) {
			host.innerHTML = '';
			// makeChart reserved this before it had a sample to draw; left
			// behind it is 129px of empty card under a one-line sentence.
			host.style.minHeight = '';
			host.hidden = true;
		}
	}
	// The last metric sample and when it arrived, so the sentence can be
	// re-read a second at a time between polls. The camera advances its streak
	// counter on its own schedule and the heartbeat polls on another, so a
	// countdown printed only on arrival lurches by whatever the two cadences
	// beat out — five seconds at a time, unevenly, on the board in #325.
	let monSample = null;
	let monTick = null;
	// When to project and by how much is decided in ircut-check.js, where it is
	// tested against a fake clock; this only turns the handle.
	const monClock = IRCUT.projector ? IRCUT.projector() : null;
	function retellMonitor() {
		const line = document.getElementById('mj-ircut-mon-line');
		const age = monClock && monClock.age(performance.now() / 1000);
		if (!line || !monSample || age == null) {
			// The section is gone, or the camera has stopped answering and
			// there is nothing honest left to count. Freeze on the last thing
			// it actually said.
			clearInterval(monTick);
			monTick = null;
			return;
		}
		const view = IRCUT.monitorView(nightCfg(), monSample, age);
		// The sentence only. Re-dealing the chart every second would push a
		// duplicate sample into it and re-render the whole plot for nothing.
		if (view) line.textContent = view.line;
	}
	function paintMonitor(s) {
		const box = document.getElementById('mj-ircut-mon');
		if (!box) return;
		const MC = window.MjCharts;
		monSample = (s.m && s.m.v) || null;
		const age = monClock
			? monClock.push(monSample, performance.now() / 1000) : 0;
		const view = IRCUT.monitorView(nightCfg(), monSample, age);
		if (!view) {
			box.hidden = true;
			return;
		}
		box.hidden = false;
		const line = document.getElementById('mj-ircut-mon-line');
		if (line) line.textContent = view.line;
		// Re-anchored on every sample rather than left free-running, so the
		// retell falls BETWEEN two polls instead of wherever it happened to
		// start. Free-running against a 2 s heartbeat it landed a fraction of
		// a second after each sample and said the same number twice.
		clearInterval(monTick);
		monTick = setInterval(retellMonitor, 1000);
		const host = document.getElementById('mj-ircut-mon-chart');
		if (!host) return;
		if (!view.chart || !MC) {
			dropMonChart(MC, host);
			return;
		}
		host.hidden = false;
		const key = view.mode + '|' + JSON.stringify(view.marks);
		if (!monChart || monChart.host !== host || monKey !== key) {
			// The superseded instance is unregistered, not merely abandoned:
			// every remount of this section makes a new host, and the chart
			// registry would otherwise keep each one for the life of the tab.
			MC.dropChart(monChart);
			host.innerHTML = '';
			// The dashboard's ink, read the way the dashboard reads it. A
			// hardcoded series colour is the light theme's, and a hairline
			// left at the module default is the light theme's too — both were
			// drawn as-is on this card's dark surface.
			const css = getComputedStyle(document.documentElement);
			const tok = (n, d) => (css.getPropertyValue(n) || d).trim();
			monChart = MC.makeChart(host, {
				h: 110, lo: 0, hi: null,
				colors: [tok('--st-c1', '#4c60d8')],
				grid: tok('--st-grid', '#e9ebf2'),
				marks: view.marks,
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
		// The switch above is the CONFIGURATION, and it is not the encoder. A
		// camera can have snapshots turned on and still have no encoder to take
		// one with — measured on an hi3516ev300 whose main stream sits below
		// the sensor's resolution with a substream beside it, which leaves no
		// hardware scaler for the MJPEG channel: jpeg.enabled true, /image.jpg
		// 503. Nothing readable answers that question in advance (the metrics
		// count requests and responses, so a camera nobody has asked looks
		// exactly like one that works), so the first press is what finds out —
		// and after it this stands here rather than the button inviting the
		// identical failure again. Cleared on arriving at this section and by
		// refresh(), so a camera that was only briefly busy is one navigation
		// or one save away from being asked again.
		//
		// The status is printed and the body is QUOTED rather than asserted.
		// What came back is only probably majestic's: a proxy, a captive portal
		// or anything else in the way can answer a short error of its own, and
		// this panel must not dress that up as the camera's own diagnosis. The
		// status is the part we do know.
		if (state.ircutNoSnap) {
			const s = state.ircutNoSnap;
			return 'The test reads a still picture and this camera did not ' +
				'return one (HTTP ' + s.status + ').' +
				(s.reason ? ' The reply said: “' + s.reason + '”' : '');
		}
		// The monitor re-drives the filter on its own schedule, and a snapshot
		// taken after it had snapped the filter back would read as "it never
		// moved" — convicting a correctly wired camera. Refusing to run beats
		// running and possibly lying.
		if (toBool(nm.lightMonitor))
			return 'Automatic day/night would drive the filter back mid-test. Turn it off, ' +
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
			// A camera that cannot take a still cannot run this test at all, so
			// the refusal is remembered and the button says it instead of
			// standing ready to fail the same way on the next press. Both
			// halves are kept: the status, which is a fact about the exchange,
			// and the body, which is only probably the camera's. `reason` is
			// absent where refusal() could not reduce the body to one plain
			// sentence, and the wording above drops the quotation with it.
			if (e && e.snapshot) {
				state.ircutNoSnap = { status: e.status, reason: e.reason || null };
			}
			state.ircutTestedOn = testedOn;
			// Edited while the probe ran: the verdict describes wiring that is
			// no longer on screen, so it goes straight back out.
			syncVerdict();
		}).finally(() => {
			ircutBusy = false;
			// Re-asked rather than re-enabled. A run that has just found out the
			// camera cannot take a still has made the button unavailable, and a
			// bare `disabled = false` here would hand it straight back with the
			// reason printed underneath it — the one shape this panel is built
			// to avoid.
			status.textContent = '';
			syncTestBtn();
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

	// The polarity of a pad is a fact about how the board is wired, and the map
	// is where wiring lives — so these ride the pin-map pattern too: real
	// fields, rendered hidden, driven by a chip on the role they belong to.
	// Between them they carried 375 characters of hint explaining WHEN the
	// setting applies; the chip's presence says it instead (#325).
	const POLARITY = {
		irCutPin1: 'irCutSingleInvert',
		backlightPin: 'backlightInvert',
		lightSensorPin: 'lightSensorInvert',
	};
	// Derived from mj-tree's list rather than restated here, so the invariant
	// in tests/tree.test.js is checking the set this page actually hides.
	const MAP_DOTS = {};
	((TREE && TREE.mapDriven('nightMode')) || []).forEach((k) => {
		MAP_DOTS['nightMode.' + k] = 1;
	});

	function pinField(key) {
		return state.fields.filter((f) => f.dot === 'nightMode.' + key)[0];
	}

	// A two-state chip over one hidden boolean. It reads the field rather than
	// keeping a copy, so a save, a refresh or a per-row reset moves it without
	// anything having to remember to.
	// The caller resolves the field first and does not build a chip without
	// one, so this reads it straight: a chip that cannot write is worse than no
	// chip, because it still states a signal level.
	function polarityChip(pol, inert) {
		const f = pinField(pol.invert);
		const b = el('button', 'mj-pol' + (inert ? ' mj-pol-off' : ''));
		b.type = 'button';
		const paint = () => {
			const on = !toBool(f.getValue());
			b.textContent = on ? pol.on : pol.off;
			b.title = inert
				? 'Not in use while both coils are wired. Press to clear it.'
				: 'Press to flip: ' + (on ? pol.off : pol.on);
		};
		b.addEventListener('click', (e) => {
			// The row beneath selects the pad; flipping polarity is not that.
			e.stopPropagation();
			f.setValue(toBool(f.getValue()) ? 'false' : 'true');
			paint();
			updateDirty();
		});
		paint();
		return b;
	}

	// ── the Legacy switch ───────────────────────────────────────────────────
	//
	// Two mechanisms decide day/night and the camera runs exactly one of them:
	// a pair of raw sensor-gain thresholds, or the calibration-free automatic
	// mode. Both sets of controls used to sit on the page together, which is the
	// confusion #325 is about — the reporter filled in three automatic settings
	// their camera was ignoring, and nothing said so.
	//
	// The switch stores nothing of its own. Legacy IS in use when either
	// threshold holds a value, because that is what the camera decides on; a
	// flag beside it would be a second copy of a fact the daemon already keeps,
	// and a second copy needs an invalidation rule (#367).
	//
	// The thresholds, and only the thresholds. "Seconds between light checks"
	// is the tick period of ALL three monitors — majestic arms the automatic
	// one from it too — so hiding it with the switch took automatic mode's only
	// polling knob off the page, and left the operator reading the legacy
	// position as the one with a delay in it (#325).
	const LEGACY_KEYS = ['minThreshold', 'maxThreshold'];
	const AUTO_KEYS = ['autoNightGain', 'autoDayGain', 'autoNightDelay', 'autoDayDelay'];

	function legacyOn() {
		return ['minThreshold', 'maxThreshold']
			.some((k) => { const f = pinField(k); return f && String(f.getValue()) !== ''; });
	}

	// Rows are shown and hidden through `style.display`, the channel visibleWhen
	// uses, not the `hidden` attribute: paintStock skips a display:none row and
	// does not skip a hidden one, so the "N of M off stock" count stays true.
	// layoutCols is deliberately NOT re-run — the deal is decided at mount and
	// on resize, and re-dealing under a toggle used to move the control being
	// edited across the fold (#189).
	function showLegacy(on) {
		AUTO_KEYS.forEach((k) => { const f = pinField(k); if (f) f.p.style.display = on ? 'none' : ''; });
		LEGACY_KEYS.forEach((k) => { const f = pinField(k); if (f) f.p.style.display = on ? '' : 'none'; });
		paintStock();
	}

	// Turning legacy OFF empties BOTH thresholds — never one. A half-pair is
	// not a lighter version of the same thing: the camera installs no monitor at
	// all and reports the same source 0 a SoC with no exposure state reports
	// (#370). Emptying rather than deleting is what makes this an ordinary
	// staged edit: they are real fields, so clearsToNull sends null in the same
	// batch, stillSet checks the removal landed, and the save bar appears just
	// as it would for a typed number.
	function stageLegacy(on) {
		if (on) return;
		['minThreshold', 'maxThreshold'].forEach((k) => {
			const f = pinField(k);
			if (f && String(f.getValue()) !== '') f.setValue('');
		});
	}

	function mountLegacy(container) {
		const host = pinField('lightMonitor');
		if (!host) return;
		const id = 'mjf-nightMode-legacy';
		const p = el('p', 'boolean mj-row');
		// The same shape renderField gives a boolean once its reset wrap has run:
		// label above, then the switch and its lit word together inside
		// .mj-ctl > .mj-ctl-in. Built rather than borrowed because this row has
		// no config key of its own and so no ↺ to sit beside — but it has to
		// line up with the rows around it, and hand-rolling the inner markup
		// alone left the word wrapped under the switch.
		p.innerHTML =
			'<label for="' + id + '" class="form-label">Legacy settings</label>' +
			'<span class="mj-ctl"><span class="mj-ctl-in">' +
			'<span class="form-check form-switch">' +
			'<input type="checkbox" id="' + id + '" class="form-check-input">' +
			'</span>' +
			'<span class="mj-state" aria-hidden="true"></span>' +
			'</span></span>' +
			'<div class="hint text-secondary">Off: the camera decides from its own ' +
			'exposure. On: the older pair of raw sensor-gain thresholds.</div>';
		const box = p.querySelector('input');
		const word = p.querySelector('.mj-state');
		const paint = () => {
			word.textContent = box.checked ? 'On' : 'Off';
			word.classList.toggle('mj-state-on', box.checked);
		};
		box.addEventListener('change', () => {
			paint();
			stageLegacy(box.checked);
			showLegacy(box.checked);
			// setValue() writes a control without firing its events, so the
			// x-requires notes under the automatic rows — the ones saying a
			// threshold outranks them — would still be claiming a threshold
			// that this press has just emptied. They were painted while the
			// rows were hidden and turned up stale the moment the switch
			// revealed them (#325). runVisibility() is the repaint every other
			// programmatic write on this page already pairs with updateDirty();
			// nothing in nightMode carries a visibleWhen, so it cannot fight
			// the display writes showLegacy() has just made.
			runVisibility();
			updateDirty();
		});
		box.checked = legacyOn();
		paint();
		host.p.parentNode.insertBefore(p, host.p.nextSibling);
		state.legacyBox = box;
		showLegacy(box.checked);
	}

	// refresh() re-reads the config and pushes it into every control, so the
	// switch has to be re-derived from what came back — otherwise a save, or a
	// per-row reset of a threshold, leaves it stating the opposite of what the
	// camera now holds.
	function syncLegacy() {
		const box = state.legacyBox;
		if (!box || !document.body.contains(box)) return;
		// Re-derived, never re-fired: the change handler STAGES a clear, and a
		// refresh that replayed it would empty two thresholds the operator had
		// just saved.
		box.checked = legacyOn();
		const word = box.closest('.mj-row').querySelector('.mj-state');
		if (word) {
			word.textContent = box.checked ? 'On' : 'Off';
			word.classList.toggle('mj-state-on', box.checked);
		}
		showLegacy(box.checked);
	}

	// Day / Night has THREE mechanisms that decide the same thing, and the
	// camera picks between them by what is filled in: a daylight sensor pin
	// wins, then the pair of legacy raw thresholds, and only with neither of
	// those does the calibration-free automatic mode run. Every control for
	// all three sits on the page at once, all of them enabled, and nothing
	// said which set was live — so the reporter of #325 filled in a night gain
	// multiple and both automatic delays, watched the camera go on using a
	// threshold pair set earlier, and reported the countdown as broken. Four
	// controls were doing nothing and the page was silent about it.
	//
	// Which one is live is not inferred from the config here: the camera
	// publishes the answer and its answer is the one that matters. Fields of a
	// mechanism that is not deciding get the same note an x-requires field
	// gets, for the same reason, and deliberately NOT by hiding or disabling
	// them — the value is real, it is what is causing the surprise, and it has
	// to stay findable and clearable. Hiding it would only move the surprise.
	//
	// A daemon that declares the precedence itself (OpenIPC/majestic#314) puts
	// the note on these fields through the ordinary x-requires path, from its
	// own schema; this table then stands down for them, since two notes under
	// one control is the clutter #325 objected to. It stays for an older
	// daemon, whose schema says nothing about it.
	const NIGHT_MECH = {
		'nightMode.minThreshold': 'thresholds',
		'nightMode.maxThreshold': 'thresholds',
		'nightMode.autoNightGain': 'auto',
		'nightMode.autoDayGain': 'auto',
		'nightMode.autoNightDelay': 'auto',
		'nightMode.autoDayDelay': 'auto',
	};
	// night_mode_source, as the endpoint documents it: 0 manual, 1 GPIO
	// sensor, 2 gain thresholds, 3 ADC, 4 automatic. 0 is nothing deciding,
	// which is not a verdict about any of these, so it marks nothing.
	const MECH_OF_SRC = { 1: 'sensor', 2: 'thresholds', 3: 'adc', 4: 'auto' };
	// One line each. The finding at the top of the section carries the
	// explanation and the way out; repeating a paragraph under every ignored
	// control is the wall of text the reporter of #325 objected to in the same
	// breath, and four copies of it say nothing the first did not.
	const MECH_NAMED = {
		sensor: 'the daylight sensor is deciding.',
		adc: 'the sensor pad voltage is deciding.',
		thresholds: 'the day and night thresholds are deciding.',
		auto: 'automatic mode is deciding.',
	};
	function paintNightInert(src) {
		const decides = MECH_OF_SRC[src];
		state.fields.forEach((f) => {
			const mech = NIGHT_MECH[f.dot];
			if (!mech || !f.p) return;
			let note = f.p.querySelector('.mj-night-inert');
			if (f.schema && f.schema['x-requires']) {
				if (note) note.remove();
				return;
			}
			// An empty control misleads nobody; only a filled-in one that is
			// being ignored needs saying.
			const v = f.getValue();
			const set = decides && mech !== decides &&
				String(v === undefined || v === null ? '' : v) !== '';
			if (!set) {
				if (note) note.remove();
				return;
			}
			if (!note) {
				note = el('div', 'hint mj-requires mj-night-inert');
				f.p.appendChild(note);
			}
			note.textContent = 'Not in use — ' + MECH_NAMED[decides];
		});
	}

	// The map reports; this writes what it reports into the real fields, so the
	// save bar appears exactly as it would have for a typed number.
	function pushAssign(a) {
		PIN_KEYS.forEach((k) => {
			const f = pinField(k);
			if (f) f.setValue(a[k] === undefined ? '' : String(a[k]));
		});
		// A daylight sensor pin outranks both switching sets, so assigning or
		// clearing one on the map decides whether six other rows are inert —
		// and setValue() fires nothing that would repaint the notes saying so.
		runVisibility();
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
	// configuration file directly, behind majestic's back, and then waited out
	// a deferred SIGHUP.
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

	// What this field is called on screen. A Day / Night pin has a role on the
	// map — "IR-cut filter, closing coil" — which is what every sentence in
	// that panel calls it; anything else is named by the caption printed above
	// its own control, derived exactly as renderField derives it. Never the
	// dotted key: a name readable only by someone who already knows the answer
	// is not a name.
	function fieldName(f) {
		const key = f.dot.slice(f.dot.lastIndexOf('.') + 1);
		const role = f.dot.indexOf('nightMode.') === 0 ? roleName(key) : '';
		return role || (f.schema && f.schema.title) || titleCase(key);
	}

	// Which of the fields this save asked the camera to REMOVE are still
	// configured afterwards. Asked of the refreshed config, so it is the
	// camera answering and not the form: an older majestic accepts a null,
	// answers 202 and ignores it, and nothing else on the page would ever say
	// that a clear did not take.
	//
	// It used to look only under nightMode and only at pins, which was right
	// while pins were the only thing that could be cleared. Once any numeric
	// field with no default could be, that shape quietly stopped covering the
	// cases it was written for — a threshold or a speaker pad whose removal
	// was ignored would have been reported as a clean save, which is the exact
	// opposite of what this exists to guarantee.
	function stillSet(cleared) {
		return (cleared || [])
			.filter((f) => isNumish(getDotted(state.config, f.dot)))
			.map(fieldName);
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
		// A refused snapshot blanks the Test button until something says to ask
		// again, and arriving on this section is one of the two things that
		// does (refresh(), after a save, is the other). Without this the memory
		// outlived its cause: a camera that was merely busy for one request
		// kept the button greyed for the rest of the visit, with no way back to
		// it but saving something unrelated. Leaving and returning is a cheap,
		// obvious retry, so the blocker never has to guess which HTTP statuses
		// are transient and which are standing.
		state.ircutNoSnap = null;
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
			'<div class="small text-secondary mt-2" id="mj-ircut-find-why" hidden></div>' +
			'<div class="small text-secondary mt-2" id="mj-ircut-why" hidden></div>' +
			'<div class="small text-secondary mt-2" id="mj-ircut-status"></div>' +
			'<div id="mj-ircut-result" class="small" hidden></div>' +
			'</div></div>' +
			'<div id="mj-ircut-mon" hidden>' +
			'<div class="mj-live-grp-head mt-3"><span class="mj-cap">Automatic day/night</span>' +
			'<span class="mj-live-rule"></span></div>' +
			'<div class="small text-secondary mb-1" id="mj-ircut-mon-line"></div>' +
			'<div class="mj-chart" id="mj-ircut-mon-chart" hidden></div>' +
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
			const r = await apiFetch('/api/v1/gpio', { credentials: 'same-origin' });
			// apiFetch only intercepts 401. Everything else arrives as an
			// ordinary response, and a firmware without this endpoint answers
			// with a perfectly parseable JSON error — which, mounted as pad
			// data, has no banks and draws an empty chip instead of falling
			// back to the plain number fields.
			if (!r.ok) throw new Error('HTTP ' + r.status);
			info = await r.json();
		} catch (e) {
			// No pad list, no map. The hidden number fields are still there, so
			// nothing is unreachable — say which door is shut and unhide them.
			host.innerHTML = '<p class="small text-secondary mb-0">' +
				'Could not read this camera\'s GPIO list, so the pin map is not available. ' +
				'The pin numbers below can still be set by hand.</p>';
			// Every field the map drives comes back as an ordinary row, the
			// polarity switches included — otherwise the three inverts would be
			// unreachable on a camera whose pad list cannot be read.
			Object.keys(MAP_DOTS).forEach((d) => {
				const f = state.fields.filter((x) => x.dot === d)[0];
				if (f) f.p.hidden = false;
			});
			layoutCols();
			return;
		}

		state.ircutInfo = info;
		const map = window.MajesticIrcutMap.mount(host, {
			info: info,
			assign: currentAssign(),
			// Whether a channel is driving the lamp, which decides that its pad
			// is nobody's to pick. The map cannot work this out — it holds no
			// configuration — and the fact lives in one key, so it is passed
			// rather than inferred from the pad assignment.
			pwmLamp: !!pwmLamp(),
			soc: SOC + (info.banks ? (SOC ? ' · ' : '') + info.banks.length + ' banks' : ''),
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

		// The dimmable lamp, if one is configured, and the pad it took over
		// where the camera can name it.
		//
		// The CHANNEL alone decides. A lamp pin may be configured as well —
		// the camera ignores it while a channel is selected, and says so in
		// that field's own hint — so its presence proves nothing about how the
		// lamp is driven, and the first version of this used exactly that to
		// decide, which hid an active channel behind a pin nothing reads.
		//
		// The pad only where the camera reports exactly one for this role.
		// With a lamp pin also left configured the camera reports two, and
		// which of them the channel took is not something this page can tell
		// without guessing. The channel is the honest answer then, and it is
		// still an answer — unlike "not set", which was the bug.
		function pwmLamp() {
			const ch = getDotted(state.config, 'nightMode.backlightPwmChannel');
			if (!ch || ch === 'none') return null;
			const pads = [];
			((state.ircutInfo && state.ircutInfo.assigned) || []).forEach((x) => {
				// Deduplicated, because a lamp pin left set to the pad the
				// channel took is reported twice and is still one pad. Two
				// entries naming the same number are not an ambiguity.
				if (x.role === 'backlightPin' && pads.indexOf(x.pin) < 0) {
					pads.push(x.pin);
				}
			});
			return {
				channel: String(ch),
				pin: pads.length === 1 ? pads[0] : undefined,
			};
		}

		function paintRoles() {
			syncTestBtn();
			const a = map.get();
			list.innerHTML = '';
			map.roles.forEach((r) => {
				const row = el('button', 'mj-ircut-role');
				row.type = 'button';
				// A dimmable lamp is connected, and was reported as "not set"
				// because the field this row draws from holds a pad and the
				// lamp is on a channel. Nothing was wrong with the camera; the
				// row was reading the one place the answer could not be.
				//
				// Not gated on the field being empty: a lamp pin left over
				// beside a selected channel is ignored by the camera, so
				// letting it suppress this would show a dimmable lamp as an
				// ordinary switched one and name a pad nothing drives.
				const lamp = r.key === 'backlightPin' ? pwmLamp() : null;
				const set = a[r.key] !== undefined || !!lamp;
				if (!set) row.classList.add('mj-ircut-role-unset');
				const dot = el('span', 'mj-ircut-rdot');
				dot.style.background = set ? r.color : '';
				row.appendChild(dot);
				const t = el('span', 'mj-ircut-rtext');
				const l = el('b');
				l.textContent = r.label;
				t.appendChild(l);
				const h = el('em');
				h.textContent = lamp
					? 'dimmable, on ' + lamp.channel
					: r.hint;
				t.appendChild(h);
				row.appendChild(t);
				// The polarity chip: what this pad does in its active state, in
				// words, with a press to flip it. It replaces a boolean called
				// "inverted" and the paragraph that had to explain what
				// inverting meant — you read that the lamp lights on HIGH, see
				// it lit at noon, and press (#325).
				//
				// Only where a pad is actually assigned: polarity is a fact
				// about a wire, and there is no wire yet. The IR-cut chip is
				// further limited to single-coil mode, so the control's presence
				// carries the rule the daemon states in its own hint.
				const onChip = set && map.has(a[r.key]);
				// The chip is the only way to reach a polarity switch now, so
				// it appears wherever one is SET as well as wherever it
				// applies. Hiding a stored setting is how a camera ends up
				// holding an invert nobody can find: with both coils wired the
				// single-pin switch does nothing, diagnose() says so, and that
				// sentence would otherwise point at a control that is not on
				// the page at all.
				const pol = r.polarity;
				const polF = pol && pinField(pol.invert);
				const applies = !pol || !pol.single || a.irCutPin2 === undefined;
				const stored = polF && toBool(polF.getValue());
				// Deliberately `set` and not `onChip`: a pin this kernel does
				// not report is still a pin the config names, and its polarity
				// is still stored. Gating the chip on the pad being drawn left
				// a yaml carried from another board holding an invert with no
				// control anywhere on the page to see or clear it — the same
				// stranding the `stored` arm above exists to prevent, reached
				// by a different door.
				//
				// polF is required because the chip edits that field and
				// nothing else: without it the press would return silently
				// while the words went on naming a signal level, which is a
				// control that lies rather than one that is missing.
				// `set` now covers a lamp on a channel, which is what keeps the
				// active-low chip reachable for one: the invert is applied to
				// the duty just as it is to a switched pad, so a dimmable lamp
				// wired the other way round needs the same control.
				if (pol && polF && (set || stored) && (applies || stored)) {
					row.appendChild(polarityChip(pol, !applies));
				}
				const pin = el('span', 'mj-ircut-rpin');
				// The pad, where the camera could say which one the channel
				// took over; the channel alone otherwise. Never "not set",
				// which is the one thing that is certainly untrue here.
				pin.textContent = lamp
					? (lamp.pin === undefined ? lamp.channel : String(lamp.pin))
					: (set ? String(a[r.key]) : 'not set');
				row.appendChild(pin);
				// `!lamp`, because a dimmable lamp reaches here with no pad of
				// its own in the assignment and would otherwise be accused of
				// naming a pin this processor does not have. Its pad, where the
				// camera reports one, is the camera's own answer and is drawn
				// like any other.
				if (set && !onChip && !lamp) {
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
					// The lamp's own pad first, and it is not this row's to
					// edit — selecting it is only how the map says which pad
					// the channel took. It wins over a[r.key] because with a
					// channel selected that pin is the one the camera ignores.
					if (lamp && lamp.pin !== undefined && map.has(lamp.pin)) {
						map.select(lamp.pin);
					} else if (onChip) {
						map.select(a[r.key]);
					}
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
				const r = await apiFetch('/api/v1/gpio',
					{ credentials: 'same-origin' });
				if (!r.ok) throw new Error('HTTP ' + r.status);
				fresh = await r.json();
				state.ircutInfo = fresh;
			} catch (e) {
				// The cached list is stale, not wrong: every pad it names is
				// still a pad. Scanning with it beats refusing to scan.
			}
			openScan(box, map, fresh);
		});

		// A sweep drives pads, and the camera refuses to drive any pair while it
		// cannot say what the pads already are — no debugfs to name a line's
		// owner, or no boot loader environment to see the PTZ pads. Offering the
		// button anyway would spend a press to be told no, once per pad, so the
		// reason is said here instead. Picking a pin by hand still works: that
		// writes a number into a field and moves nothing.
		if (find && (info.ownersUnknown || info.ptzUnknown)) {
			const cant = [];
			if (info.ownersUnknown) cant.push('which pads the kernel already holds');
			if (info.ptzUnknown) cant.push('which pads the PTZ driver is on');
			find.disabled = true;
			// What is refused is the SWEEP, and only the sweep: it is the one
			// thing here that drives pads nobody has vouched for. Testing a
			// filter the camera already knows about still works, and still
			// moves it. "Nothing may be driven" said otherwise, and then the
			// same sentence sent the reader to a control that drives.
			//
			// It ends at Save because the pin map only STAGES: the map writes
			// into the hidden fields, while the test reads the configuration
			// the camera is running on. Skip the save and the verdict is about
			// the old wiring — which is the one answer this panel must never
			// give. The scan's own success path has always said it this way.
			const why = 'This camera cannot say ' + cant.join(' or ') +
				', so the sweep may not drive pads it has not been told about. ' +
				'Set the coils by hand on the pin map, Save, then Test the ' +
				'filter checks them.';
			find.title = why;
			// The reason goes on the page and not only in the title, for the
			// reason syncTestBtn() says two controls down: a tooltip is not an
			// explanation on a touchscreen, where there is no hover at all.
			// This button was the one place in the panel that broke that rule,
			// and the greyed-out control it left had to be asked about.
			const note = box.querySelector('#mj-ircut-find-why');
			if (note) {
				note.textContent = why;
				note.hidden = false;
			}
		}

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
		// What the wiki's table records about this part: the pairs to try first,
		// and the pads it names as a reset, a USB enable or an illuminator, to
		// try last. Absent for a part the table has never seen, which is the
		// behaviour the sweep had before the table was read at all.
		const PADS = window.MajesticIrcutPads;
		const part = PADS ? PADS.forSoc(SOC) : {};
		const list = SCAN.pairs(info, {
			exclude: state.ircutExclude || [],
			part: part,
		});
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
			// Said only where it is true. The table is per board, so this is an
			// order and not a promise — the pads are still driven if nothing
			// before them moved the filter, which is why the warning above
			// keeps its wording either way.
			(part.known
				? 'Pads that other boards with this SoC use for a reset, a USB enable ' +
					'or an illuminator are tried last, and the pairs recorded for it first. '
				: '') +
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
				// POST, not GET: driving a pad is a mutation, and a GET is what
				// a browser issues by itself — a prefetch, a restored tab, a
				// link from anywhere — carrying the session with it.
				drive: (a, b) => apiFetch('/api/v1/gpio?pair=' + a + ',' + b,
					{ method: 'POST', credentials: 'same-origin' })
					.then((r) => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))),
				release: (a, b) => apiFetch('/api/v1/gpio?park=' + a + ',' + b + '&mode=float',
					{ method: 'POST', credentials: 'same-origin' })
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
	//
	// Both hiding channels count, and they have to: a row goes off screen
	// either by inline display (visibleWhen) or by the hidden attribute (a
	// field some other control drives — the pin map's pads and their polarity
	// switches). Reading only the first put three defaulted booleans nobody
	// can see into the denominator of a sentence that promises to count the
	// rows on screen, and let a flipped polarity register as a row off stock
	// that the reader cannot find to reset.
	// Measured against the default rather than against the last save, so it goes
	// on saying "off stock" after Save — it is a fact about the camera.
	function paintStock() {
		const note = document.getElementById('mj-stock-note');
		if (!note) return;
		let shown = 0, known = 0, off = 0;
		for (const f of state.fields) {
			if (!f.p || f.p.style.display === 'none' || f.p.hidden) continue;
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

	// `skip` is a set of dots a caller has already mounted elsewhere on the same
	// leaf, so the ordinary rows do not draw them a second time.
	// The group head both an object subtree and a flat section's heading use:
	// micro-caps name and a hairline to the column edge, rather than a 20px
	// grey <h5> that outweighed every label under it.
	function head(container, label) {
		const h = el('div', 'mj-live-grp-head');
		const t = el('span', 'mj-cap');
		t.textContent = label;
		h.appendChild(t);
		h.appendChild(el('span', 'mj-live-rule'));
		container.appendChild(h);
	}

	// The named keys of `props`, in the order they were named.
	function pick(props, order) {
		const out = {};
		order.forEach((k) => { if (k in props) out[k] = props[k]; });
		return out;
	}

	// `flat` renders the given properties with no group walk. It is what the
	// group walk itself calls, so a section that has headings does not re-enter
	// them for every group and recurse forever.
	function renderProps(container, basePath, props, skip, flat) {
		// Scalars first, object subtrees after. An object renders as a labelled
		// group and everything below its heading reads as part of it, so a scalar
		// sibling that happens to come later in the schema is captured by it:
		// isp.blkCnt — memory blocks for the encoder — read as an iris setting,
		// which is where nobody would look for it.
		const keys = Object.keys(props);
		let ordered = keys.filter(k => !isGroup(props[k])).concat(keys.filter(k => isGroup(props[k])));

		// A flat section can still be grouped. nightMode has no object subtrees,
		// so every one of its nineteen controls arrived in one undifferentiated
		// deal; mj-tree.js names the headings and their order, and they are
		// drawn with the same micro-caps head an object group gets, so a reader
		// cannot tell the two apart. Anything the map does not name is rendered
		// after the last heading rather than dropped — a key the daemon adds
		// tomorrow appears, instead of silently not being there.
		const secGroups = flat ? null : sectionGroups(basePath);
		if (secGroups) {
			const named = new Set();
			secGroups.forEach(g => g.keys.forEach(k => named.add(k)));
			for (const g of secGroups) {
				const mine = g.keys.filter(k => keys.indexOf(k) >= 0);
				// A heading with nothing under it is furniture; a build without
				// these keys should not grow an empty rule.
				if (!mine.some(k => !EXCLUDE.has(basePath + '.' + k) && !MAP_DOTS[basePath + '.' + k])) continue;
				head(container, g.label);
				renderProps(container, basePath, pick(props, mine), skip, true);
			}
			ordered = ordered.filter(k => !named.has(k));
			if (!ordered.length) return;
		}

		for (const key of ordered) {
			const dot = basePath + '.' + key;
			if (EXCLUDE.has(dot)) continue;
			const sub = props[key];
			if (sub && sub['x-hidden']) continue; // superseded; see mj-tree.js
			if (lifted().has(dot)) continue;      // mounted on the Live leaf, beside the picture
			if (skip && skip.has(dot)) continue;
			if (isGroup(sub)) {
				head(container, sub.title || titleCase(key));
				renderProps(container, dot, sub.properties);
				continue;
			}
			const eff = getDotted(state.config, dot);
			// The four wiring pins render hidden rather than not at all: the pin
			// map above the form is what edits them, but they stay real fields
			// so dirty tracking, Save and the per-row reset keep working on them
			// without knowing a map exists.
			const field = renderField(container, dot, key, sub, eff,
				MAP_DOTS[dot] ? { hidden: true } : undefined);
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
		// A frame-rate bound that depends on the chosen resolution has to move
		// with it. Same shape as the visibleWhen pass above — find the sibling,
		// listen to it — but what it updates is the control's range rather than
		// whether the row is on screen.
		//
		// The value is clamped as the bound falls: leaving 60 in a control whose
		// maximum has just become 26 offers a number the daemon will refuse, and
		// a <input type="range"> silently reports the maximum anyway while the
		// number box keeps showing 60. Neither is a state to save from.
		for (const f of state.fields) {
			if (!f.schema || !f.schema['x-fps-caps'] || !window.MajesticFps)
				continue;
			const parent = f.dot.slice(0, f.dot.lastIndexOf('.'));
			const sizeCtrl = byDot[parent + '.size'];
			if (!sizeCtrl || !f.control) continue;

			const retune = () => {
				const size = siblingSize(f.dot, 'size');
				const bound = window.MajesticFps.boundFor(f.schema, size);
				if (!isNum(bound)) return;

				// The SEMANTIC value, before touching max, and not
				// f.control.value. Two reasons, and they are different traps.
				//
				// Lowering the max of an <input type="range"> runs the browser's
				// value-sanitisation algorithm and clamps .value on the spot, so
				// a "did it need clamping?" test asked afterwards always answers
				// no — that is how a 2560x1440 row came to show 64 with the
				// slider sitting at its 26 maximum.
				//
				// And a range input cannot hold "no value" at all: given
				// value="" the browser parks the thumb at the midpoint and reads
				// that back as if somebody had chosen it. The page keeps the
				// truth beside the control and getValue() answers with it.
				const before = f.getValue ? String(f.getValue()) : String(f.control.value);

				f.control.max = String(bound);
				f.control.setAttribute('max', String(bound));
				const num = f.p && f.p.querySelector('.mj-live-num');
				if (num) {
					num.max = String(bound);
					num.setAttribute('max', String(bound));
				}

				// Repaint through the control's own setter, never by dispatching
				// `input`. The range branch treats an input event as a human
				// moving the thumb and records the field as chosen, so a
				// synthetic one would turn an untouched frame rate into an
				// invented number and put it in the next save — on page load, on
				// every camera, without anyone touching the control.
				const repaint = (val) => {
					if (f.control._set) f.control._set(val);
					else f.control.value = val;
				};

				// Unset stays unset. The track's meaning changed under it, which
				// is exactly what the repaint is for, but nothing was chosen.
				if (before === '') {
					repaint('');
					return;
				}

				const after = String(Math.min(Number(before), bound));
				repaint(after);

				// Only when the number actually moved: `change` is what the dirty
				// count and the save set read, and firing it on every resolution
				// touch would mark the field edited when nothing about it was.
				if (after !== before)
					f.control.dispatchEvent(new Event('change', { bubbles: true }));
			};

			// On the resolution's ROW, not its select. "Custom…" puts the
			// effective value in a separate text input beside the dropdown, so a
			// listener on the select alone never hears an operator type one —
			// the bound stayed tied to whatever preset was chosen before, and
			// offered a rate belonging to a resolution no longer selected.
			// Both events bubble, and siblingSize() reads the field's value
			// rather than the select's, so one listener covers both controls.
			const sizeRow = sizeCtrl.p || sizeCtrl.control;
			sizeRow.addEventListener('change', retune);
			sizeRow.addEventListener('input', retune);
			retune();
		}

		// An x-requires condition names an absolute path, so its controlling
		// field is usually on another tab and the saved config answers for it.
		// Where it does happen to share the page, an unsaved edit to it has to
		// repaint the warning, exactly as it moves a visibleWhen row.
		for (const u of state.reqUpdaters || []) {
			// Every field the condition consults, since `any` and `all` name
			// more than one. Missing the second of them would leave the warning
			// correct on mount and stale under exactly the edit that clears it.
			const list = Array.isArray(u.req.any) ? u.req.any
				: Array.isArray(u.req.all) ? u.req.all : null;
			const fields = list
				? list.map(a => a && a.field).filter(Boolean)
				: [u.req.field];
			for (const dot of fields) {
				const ctrl = byDot[dot];
				if (!ctrl || ctrl.dot === u.dot) continue;
				ctrl.control.addEventListener('change', u.paint);
				ctrl.control.addEventListener('input', u.paint);
			}
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

		// A handful of rows does not want two columns. Two rows dealt in half are
		// one row beside one row across 966px of card — image was that section
		// while its six live knobs sat on the Live leaf and the rest did not, and
		// a two-row section will exist again. Under the cut they stay in one
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
		// A section with headings is cut BETWEEN groups wherever one will do.
		// Cutting inside a group strands its tail at the top of the second
		// column under no heading at all — Day / Night's four switching
		// settings split that way, and the last of them read as belonging to
		// whatever heading came next (#325). Balance is worth less than a row
		// sitting under the words that name it.
		const heads = items.filter(it => it.offsetHeight &&
			it.classList.contains('mj-live-grp-head')).length;
		const onlyHeads = heads > 1;

		const choose = (headsOnly) => {
			let best = Infinity, at = items.length;
			for (let i = 1; i <= items.length; i++) {
				// a group heading belongs to the rows under it, so it must not
				// be left as the last thing in a column
				if (i < items.length && items[i - 1].classList.contains('mj-live-grp-head')) continue;
				// ...and the second column should open with one, not with the
				// remains of the group the first column was in the middle of.
				if (headsOnly && i < items.length &&
					!items[i].classList.contains('mj-live-grp-head')) continue;
				const n = seen[i];
				const left = n ? y[n - 1] + rows[n - 1].h + rows[n - 1].mb : 0;
				const right = n < rows.length ? rows[n].mt + total - y[n] : 0;
				const taller = Math.max(left, right);
				if (taller < best) { best = taller; at = i; }
			}
			return { best, at };
		};

		// Falling back rather than insisting: a section whose every group is
		// enormous would otherwise pile the whole thing into one column, which
		// is worse than a straddled heading.
		let pick = onlyHeads ? choose(true) : choose(false);
		if (onlyHeads && (pick.at === items.length || pick.best > total * 0.75)) pick = choose(false);
		const cut = pick.at;
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

	// The resolution a channel will actually run at, for a sibling field that
	// has to reason about it.
	//
	// Empty is a VALUE here, not a missing one: the picker's first entry is
	// "Auto · sensor native", which stores nothing and lets the camera use the
	// sensor's own size. Reading that as "unset, go and look at the saved
	// config" is how choosing Auto left the frame rate bounded by the
	// resolution the operator had just navigated away from.
	//
	// So an on-page control answers for itself, empty included, and empty then
	// resolves through the schema: `default` is what the daemon says an unset
	// size comes up as, `x-native` the sensor's own geometry behind it.
	function siblingSize(dot, key) {
		const parent = dot.slice(0, dot.lastIndexOf('.'));
		const sibDot = parent + '.' + key;
		const f = (state.fields || []).find(x => x.dot === sibDot);

		let v;
		if (f && f.getValue) {
			v = f.getValue();
		} else {
			v = getDotted(state.config, sibDot);
		}
		if (v !== undefined && v !== null && String(v) !== '') return String(v);

		const sub = f && f.schema
			? f.schema
			: (((state.schema.properties || {})[parent] || {}).properties || {})[key];
		if (sub) {
			if (sub.default) return String(sub.default);
			if (sub['x-native']) return String(sub['x-native']);
		}
		return '';
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
		const isFontFile = isFontPath(dot) && FONTS.length > 0;
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

		// The bound the control is drawn with. For a field carrying x-fps-caps
		// this depends on a sibling — the resolution — so it is not sub.maximum,
		// and applyFpsCaps() below keeps it in step when that sibling changes.
		const fpsBound = (window.MajesticFps && sub && sub['x-fps-caps'])
			? window.MajesticFps.boundFor(sub, siblingSize(dot, 'size'))
			: null;
		if (isNum(fpsBound)) sub = Object.assign({}, sub, { maximum: fpsBound });

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
				'<span class="input-group-text show-value"></span>' +
				'</span>';
			control = p.querySelector('input');
			const show = p.querySelector('.show-value');
			// A range input cannot be empty. Given value="" the browser runs its
			// value-sanitisation algorithm and parks the thumb at the midpoint of
			// the track — min + (max − min) / 2, snapped up to a whole step — and
			// .value then reads that number back as if somebody had chosen it.
			// So a field with no value in the config draws a thumb halfway along
			// a track, which is what a chosen value looks like: the night gain
			// multiple (1–64, no default) sits at 33, and the reference
			// enhancement layers (0–3) sit at 2 of 3, two thirds of the way
			// across (#416).
			//
			// `chosen` is the page's own record of whether anything is set, kept
			// beside the control rather than read back out of the display, and it
			// is what getValue() answers with — so an untouched field stays clean
			// through dirty tracking, Save and the x-requires notes.
			//
			// The row then has to SAY so, because the thumb cannot. The readout
			// beside the track prints the word instead of standing empty, and
			// .mj-unset takes the thumb off the track until the pointer or the
			// keyboard reaches for it: a blank readout is an absence, and an
			// absence is what the reporter of #416 read as the number 33.
			let chosen = v !== '';
			const paint = () => {
				show.textContent = chosen ? String(control.value) : UNSET_WORD;
				p.classList.toggle('mj-unset', !chosen);
			};
			// Any input is a choice — a drag, a click on the track, an arrow key.
			// Registered before renderField's own updateDirty listener below, so
			// the value it reads is already a chosen one.
			control.addEventListener('input', () => { chosen = true; paint(); });
			control._get = () => (chosen ? String(control.value) : '');
			control._set = (val) => {
				const s = val !== undefined && val !== null ? String(val) : '';
				chosen = s !== '';
				control.value = s;
				paint();
			};
			paint();
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
		} else if (type === 'string' && isFontFile) {
			// The faces installed on this camera, by name. The value is still the
			// path — nothing about the setting changes — and the row is a select
			// rather than a text box because the answer is a file that either
			// exists or does not, and a mistyped one draws nothing and says so
			// only in the log.
			//
			// The rule is that whatever is configured is always selectable, so
			// that the row states what is in effect rather than the first face
			// the scan happened to find — the same reason the enum branch above
			// carries an unsupported value. Three ways it can be something the
			// scan did not list. An overlay above the first may leave it empty,
			// which means the camera's own font. Overlay 0 has nowhere to
			// inherit from, so empty there is a font that will not load, and
			// saying "not set" is the only honest way to show it. And either may
			// name a file that is not there.
			p = el('p', 'select mj-row mj-wide');
			const cur = eff === undefined || eff === null ? '' : String(eff);
			const inherits = dot !== 'osd.font';
			const missing = cur !== '' && FONTS.indexOf(cur) < 0;
			const opts =
				(inherits ? option('', cur === '', 'Camera default')
					: cur === '' ? option('', true, 'Not set') : '') +
				(missing ? option(cur, true, fontName(cur) + ' (not installed)') : '') +
				FONTS.map(f => option(f, cur === f, fontName(f))).join('');
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
		} else if (type === 'string' && (sub['x-secret'] || sub.writeOnly)) {
			// A secret the camera has asked not to be shown. It is not hidden
			// from anyone who can read this page — the value came down the same
			// authenticated request as everything else — so this is about
			// shoulders and screen shares, not about secrecy from the browser.
			// The markup is the shape p/common.cgi's field_password emits, but
			// the reveal toggle in main.js is wired once at page load and this
			// form is built long after — so the handler is attached here, to
			// the field that was just made, rather than relying on a scan that
			// has already run.
			p = el('p', 'string password mj-row');
			const v = eff !== undefined && eff !== null ? String(eff) : '';
			p.innerHTML =
				'<label for="' + id + '" class="form-label">' + labelHtml + '</label>' +
				'<div class="input-group">' +
				'<input type="password" id="' + id + '" class="form-control" value="' + esc(v) +
				'" autocomplete="off" spellcheck="false">' +
				'<div class="input-group-text"><input class="form-check-input mt-0" type="checkbox"' +
				' data-for="' + id + '" aria-label="Show"></div>' +
				'</div>';
			control = p.querySelector('input[type=password]');
			const eye = p.querySelector('input[type=checkbox]');
			if (eye) eye.addEventListener('change', () => {
				control.type = eye.checked ? 'text' : 'password';
			});
		} else if (type === 'string') {
			p = el('p', 'string mj-row');
			const v = eff !== undefined && eff !== null ? String(eff) : '';
			p.innerHTML =
				'<label for="' + id + '" class="form-label">' + labelHtml + '</label>' +
				'<input type="text" id="' + id + '" class="form-control" value="' + esc(v) + '">';
			control = p.querySelector('input');
		} else if (type === 'array' && sub.items && sub.items.type === 'object'
				&& sub.items.properties) {
			// A list whose items are objects: one editable row per element, with
			// a control per member drawn from what `items` declares. The camera
			// publishes to as many destinations as it is given, and until the
			// schema described the list there was no way to see them, let alone
			// add one.
			//
			// Everything about the row comes from the schema rather than from a
			// list here: which members exist, what each is called, which is an
			// enum and which is a secret. A member added on the camera appears
			// with no change to this page, which is the same bargain every other
			// field in this form is drawn under.
			//
			// The one thing NOT taken from the schema is which members a given
			// row shows. That is the address's business — a bearer token means
			// nothing on an RTMP destination — and it lives in mj-servers.js
			// beside the rest of the reading of an address.
			const SRV = (typeof window === 'object' && window.MajesticServers) || null;
			const props = sub.items.properties;
			// `url` first whatever order the schema lists them in: it is the one
			// that decides what the rest of the row means.
			const members = Object.keys(props).sort((a, b) =>
				(a === 'url' ? -1 : b === 'url' ? 1 : 0));

			// mj-wide: opt out of the 20rem cap .array carries for the
			// MultiRect fields, which is half an address.
			p = el('p', 'array objects mj-wide mj-row');
			p.innerHTML =
				'<label class="form-label">' + labelHtml + '</label>' +
				'<div class="mj-dests" id="' + id + '"></div>' +
				'<button type="button" class="btn btn-sm btn-outline-secondary mt-1 mj-dest-add">'
				+ '+ Add destination</button>';
			control = p.querySelector('.mj-dests');

			const rowsOf = () => Array.from(control.querySelectorAll('.mj-dest'))
				.map(r => {
					const o = {};
					members.forEach(m => {
						const f = r.querySelector('[data-member="' + m + '"]');
						if (f) o[m] = f.value;
					});
					return o;
				});

			// Redraw what depends on the address: the protocol badge, which
			// members this row uses, and anything the row is worth being told.
			const repaint = (row) => {
				const url = (row.querySelector('[data-member="url"]') || {}).value || '';
				const badge = row.querySelector('.mj-dest-proto');
				const proto = SRV ? SRV.protocolOf(url) : null;
				// An address nobody can read gets no badge rather than a wrong
				// one — an empty box is honest about not knowing yet.
				if (badge) badge.textContent = proto || '—';
				members.forEach(m => {
					const wrap = row.querySelector('.mj-dest-member[data-for="' + m + '"]');
					if (!wrap) return;
					const on = SRV ? SRV.applies(m, url) : true;
					wrap.hidden = !on;
				});
				const note = row.querySelector('.mj-dest-note');
				if (note && SRV) {
					const o = {};
					members.forEach(m => {
						const f = row.querySelector('[data-member="' + m + '"]');
						if (f) o[m] = f.value;
					});
					const said = SRV.says(o);
					note.textContent = said;
					note.hidden = said === '';
				}
			};

			const onChange = (row) => { repaint(row); updateDirty(); };

			const addRow = (values) => {
				const v = values || {};
				const row = el('div', 'mj-dest mb-2');

				const head = el('div', 'input-group input-group-sm');
				const badge = el('span', 'input-group-text mj-dest-proto');
				badge.textContent = '—';
				const url = el('input', 'form-control');
				url.type = 'text';
				url.setAttribute('data-member', 'url');
				url.value = v.url != null ? String(v.url) : '';
				const urlLabel = (props.url && props.url.title) || 'Address';
				url.setAttribute('aria-label', urlLabel);
				url.placeholder = urlLabel;
				const del = el('button', 'btn btn-outline-danger mj-dest-del');
				del.type = 'button';
				del.textContent = '\u00d7';
				del.setAttribute('aria-label', 'Remove this destination');
				del.addEventListener('click', () => { row.remove(); updateDirty(); });
				head.appendChild(badge);
				head.appendChild(url);
				head.appendChild(del);
				row.appendChild(head);

				members.filter(m => m !== 'url').forEach(m => {
					const prop = props[m] || {};
					const wrap = el('div', 'mj-dest-member input-group input-group-sm mt-1');
					wrap.setAttribute('data-for', m);
					const name = el('span', 'input-group-text');
					name.textContent = prop.title || m;
					// The column is narrow on purpose, so a name that does not
					// fit is readable on hover rather than only guessable.
					name.title = prop.title || m;
					wrap.appendChild(name);

					let f;
					if (Array.isArray(prop.enum)) {
						f = el('select', 'form-select');
						prop.enum.forEach(opt => {
							const o = document.createElement('option');
							o.value = opt;
							// The empty member of an enum is the "follow the
							// setting above" choice, and reads as nothing at all
							// unless it is given words.
							o.textContent = opt === '' ? 'Default' : opt;
							f.appendChild(o);
						});
					} else if (prop.type === 'integer') {
						// A number, typed with the keyboard a number wants and
						// with whatever bounds the camera declared. Left empty
						// it means the member is unset, which is a different
						// thing from zero — tidy() drops an empty string and
						// the camera then falls back to its own default.
						f = el('input', 'form-control');
						f.type = 'number';
						f.inputMode = 'numeric';
						if (isNum(prop.minimum)) f.min = prop.minimum;
						if (isNum(prop.maximum)) f.max = prop.maximum;
					} else {
						f = el('input', 'form-control');
						f.type = (prop['x-secret'] || prop.writeOnly) ? 'password' : 'text';
						if (f.type === 'password') {
							f.autocomplete = 'off';
							f.spellcheck = false;
						}
					}
					f.setAttribute('data-member', m);
					f.setAttribute('aria-label', prop.title || m);
					f.value = v[m] != null ? String(v[m]) : '';
					wrap.appendChild(f);
					row.appendChild(wrap);
				});

				const note = el('div', 'hint mj-dest-note');
				note.hidden = true;
				row.appendChild(note);

				row.querySelectorAll('[data-member]').forEach(f => {
					f.addEventListener('input', () => onChange(row));
					f.addEventListener('change', () => onChange(row));
				});

				control.appendChild(row);
				repaint(row);
				return row;
			};

			control._addRow = addRow;
			// One canonical string per field is what dirty-tracking compares,
			// the same bargain the string-array control makes with its
			// comma-join. onSubmit parses it back into the list it POSTs.
			control._get = () => SRV ? SRV.canon(rowsOf()) : JSON.stringify(rowsOf());
			control._set = (val) => {
				control.querySelectorAll('.mj-dest').forEach(r => r.remove());
				let arr = val;
				if (typeof arr === 'string') {
					try { arr = JSON.parse(arr); } catch (e) { arr = []; }
				}
				(Array.isArray(arr) ? arr : []).forEach(x => {
					// A camera upgraded from before destinations had a shape
					// still carries bare addresses, and majestic still reads
					// them. Drawing one as the row it means is what stops the
					// first save on such a camera from being a rewrite of a
					// list nobody touched.
					addRow(typeof x === 'string' ? { url: x } : x);
				});
			};
			control._set(eff);
			p.querySelector('.mj-dest-add').addEventListener('click', () => {
				addRow({});
				updateDirty();
			});

			// What the members mean, said once under the list rather than once
			// per row. A hint describes the member, not the destination that
			// happens to use it, so repeating it down a list of five is five
			// copies of one paragraph — and on a row whose protocol does not
			// use the member it was worse than noise: the RTMP rows carried a
			// paragraph about WHIP bearer tokens.
			const notes = members
				.filter(m => props[m] && props[m].hint)
				.map(m => (props[m].title || m) + ': ' + props[m].hint);
			if (notes.length) {
				const help = el('div', 'hint text-secondary');
				notes.forEach(t => {
					const line = document.createElement('div');
					line.textContent = t;
					help.appendChild(line);
				});
				p.appendChild(help);
			}
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
			// One button, two answers, because the camera's reset has two. A key
			// the schema declares a default for goes back to that value; a key it
			// declares none for is REMOVED, which is the unset state — and on a
			// slider that is the only way back to it, since a range input cannot
			// be emptied by hand.
			//
			// This used to be switched off wherever the schema had no default, on
			// the assumption that the camera would refuse. It does not: reset
			// answers 200 and removes the key, and 404 now means the camera has no
			// such setting at all. So the one control that could put the night
			// gain multiple back to "when the exposure runs out" — a different
			// day/night trigger, not a missing number — was the one control
			// disabled, and every value typed into it was permanent (#416). The
			// 404 is still handled, in onReset, where the camera's answer arrives.
			const clears = !hasDefault;
			reset.setAttribute('aria-label',
				clears ? 'Clear ' + desc : 'Reset ' + desc + ' to default');
			reset.title = clears
				? 'Clear this setting and leave it to the camera.'
				: 'Reset to default: ' + String(sub.default);
			reset.addEventListener('click', () => onReset(dot, reset, desc, clears));
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
		// `.field`, `.any` or `.all`: a requirement carries one controlling
		// field, a list of alternatives for a rule that only bites when two
		// settings coincide, or a list that must all hold for a setting that
		// several others outrank. Every shape is decided by mj-requires.js;
		// this only has to recognise that there is a requirement to paint.
		if (!live && sub['x-requires']
			&& (sub['x-requires'].field || Array.isArray(sub['x-requires'].any)
				|| Array.isArray(sub['x-requires'].all))) {
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

		// A live knob applies to the SDK as it moves, via POST /api/v1/image —
		// instant, no save, no reinit; the value still persists only on Save.
		// Two conditions, and the second is the one that matters: the schema's
		// x-live says the daemon CAN take the key live, and the leaf says this
		// page WIRES it. A live-classed key drawn on an ordinary section — the
		// bitrate, on Main stream — is applied by Save without a rebuild, which
		// is a different promise: pushing it here would send the endpoint a name
		// it ignores and then "revert" it to the same value on the way out.
		//
		// The lifted knobs are that set, and they are now the WHOLE of it. The
		// Overlay leaf used to be in it too, and cannot be any more: this
		// endpoint takes a query string and reads each key by its LAST dotted
		// segment, so osd.overlays.3.anchor arrives as `anchor=` and moves
		// overlay 0 — a control silently editing a different overlay from the
		// one it is drawn under. Placement pushes go through postLivePlace and
		// the document endpoint, which addresses overlays by their real path;
		// see revertOsdPlace() for the other half, the undo those pushes owe.
		const pushes = !!(sub && sub['x-live'] && lifted().has(dot));
		if (pushes) {
			control.addEventListener('input', pushLive);
			control.addEventListener('change', pushLive);
		}

		return { dot, key, schema: sub, type, control, p, getValue, setValue, pushes };
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
		// A sticky bar does not push anything; it sits on whatever is at the
		// bottom of the window. On a leaf whose picture is sized from the
		// viewport height that is the control row under the picture, so the
		// picture gives the bar its height back while it is there — except
		// on the Overlay leaf, which keeps that room at all times: see
		// --mj-pv-toolbar in the stylesheet.
		if (bar.parentNode) bar.parentNode.classList.toggle('mj-has-toolbar', show);

		const lbl = document.getElementById('mj-dirty-count');
		if (lbl && !state.toolbarMsg) {
			// mj-apply-note rather than Bootstrap's text-warning: that utility is
			// not in the PurgeCSS subset we ship (tools/purgecss.config.cjs)
			lbl.className = 'me-auto small ' + (apply && !n ? 'mj-apply-note' : 'text-secondary');
			// nothing pending: leave the hidden bar empty rather than parked on a
			// stale message
			lbl.textContent = n
				? (n + ' change' + (n === 1 ? '' : 's') + ' pending. ' + pendingCost() +
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

	// What Save will cost, said before it is pressed. The page used to say it
	// only afterwards — "the video streams will blink briefly" once the save had
	// gone through — and the reporter of #316, once the Quarter turn row said
	// "on Save", asked for every setting that restarts the streams to say so.
	// On a HiSilicon build that is most of them: 156 of 202 keys carry no
	// cheaper class, so a mark on each row would be a mark on nearly every row
	// and would say nothing. The bar is the one place every page shares, and it
	// already knows the answer for the set that is actually pending from the
	// daemon's own classification (changeCost), so that is where it is said.
	function pendingCost() {
		const dirty = state.fields.filter(f => f.getValue() !== state.initial[f.dot]);
		if (!dirty.length) return '';
		// Save itself never restarts anything: a pipeline-class change is saved
		// and then owed a reload, which is what Apply does and what the streams
		// notice. The sentence says so in that order.
		return needsPipelineReload(dirty)
			? 'After Save, a reload restarts the video streams.'
			: 'Save keeps the streams running.';
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

	// Does emptying this control mean "remove this key"?
	//
	// A NUMBER field has no way to say "empty" other than by being empty: an
	// empty string reaches the config walker and an integer key stores ZERO,
	// which is a real value and a different statement. The reporter of #325
	// found that the hard way — told by this very page to clear the day and
	// night thresholds to hand day/night back to automatic mode, they cleared
	// both, and the save wrote 0 and 0. Measured on an hi3516ev300: the
	// camera goes on reporting the threshold mechanism, so the advice could
	// not be followed at all. Sent as null instead, both keys are removed and
	// the camera returns to automatic on the same save.
	//
	// Only where the schema declares no `default`. A key with one has a
	// defined unconfigured state that is not absence — it is re-seeded on
	// every load — so removing it would read as absent now and as the default
	// after the next restart, which is what the reset control is for.
	//
	// Strings are deliberately left alone: an empty string is a value someone
	// can mean, and an overlay line cleared to nothing is not the same request
	// as an overlay key that does not exist.
	function clearsToNull(f) {
		if (String(f.getValue()) !== '') return false;
		if (PIN_DOTS[f.dot]) return true;
		const sch = f.schema || {};
		if (sch.type !== 'integer' && sch.type !== 'number') return false;
		return sch.default === undefined || sch.default === null;
	}

	async function onSubmit(ev) {
		ev.preventDefault();
		const all = state.fields.filter(f => f.getValue() !== state.initial[f.dot]);
		// A cleared field rides the same batch as everything else, as a null —
		// which majestic removes rather than stores. Withholding it and tidying
		// up afterwards was the older shape, and it left the two halves of one
		// save able to disagree.
		const cleared = all.filter(clearsToNull);
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
			// array-typed schema fields post as a list, not as the single
			// canonical string the control reduces to for dirty-tracking. Which
			// list depends on what the schema says an item is: objects for the
			// destination rows, strings for the MultiRect fields
			// (roi/crop/privacyMasks).
			if (f.schema && f.schema.type === 'array'
					&& f.schema.items && f.schema.items.type === 'object') {
				try { val = JSON.parse(val); } catch (e) { val = []; }
			} else if (f.schema && f.schema.type === 'array')
				val = String(val).split(',').map(s => s.trim()).filter(s => s.length);
			// null is "remove this key" — see clearsToNull for which emptied
			// controls mean it and which mean an empty string someone chose.
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
			// The drag's override has done its job: the config now says what it
			// was saying, so it can come off. Left installed it would go on
			// overriding the saved placement for the life of the daemon, and a
			// later change made anywhere else — the CLI, another browser — would
			// be written, reported saved, and not appear.
			revertOsdPlace();
			// The config no longer names them, so the files can go.
			flushLogoBin();
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
				showError('Saved, but these could not be cleared: ' +
					kept.join('; ') + '. The camera is still configured with ' +
					'them; its firmware may be too old to clear a setting.');
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

	// `desc` and `clears` are the field's on-screen name and which of the two
	// things this press does, both settled by renderField. The question names
	// the setting the way the row above it does rather than by its dotted key:
	// a key is a second vocabulary, readable only by someone who already knows
	// the answer, and this sentence is asked of someone deciding.
	async function onReset(dot, btn, desc, clears) {
		const name = desc || dot;
		if (!confirm(clears
			? 'Clear "' + name + '" and leave it to the camera?'
			: 'Reset "' + name + '" to its default?')) return;
		btn.disabled = true;
		// innerHTML, not textContent: the glyph is an inline SVG, so the button's
		// text is the empty string — saving that and putting it back at the end
		// left an empty 13px target where the arrow had been, on success and on
		// failure alike, for the rest of the leaf's life. It was invisible while
		// only defaulted keys could be pressed and one press is usually the last
		// thing anybody does to a row; a page where every no-default key can be
		// cleared is a page where the second press has to find the button.
		const orig = btn.innerHTML;
		btn.innerHTML = '…';
		clearError();
		// A 404 is the camera saying it has no such setting — the button stays
		// down afterwards, and nothing else may lift it. Tracked as a flag
		// rather than re-read off the title, which the finally clause used to
		// match by its opening words: the sentence and the state then had to be
		// kept in step by hand, and rewording one silently re-enabled the button.
		let gone = false;
		try {
			const res = await apiFetch('/api/v1/reset?key=' + encodeURIComponent(dot), { credentials: 'same-origin' });
			if (!res.ok) {
				if (res.status === 404) {
					btn.title = 'This camera has no such setting.';
					gone = true;
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
			btn.innerHTML = orig;
			btn.disabled = gone;
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
		// A refused snapshot is usually a fact about the encoder, and the
		// encoder is what a save can have just changed — turning a substream
		// off, or raising the main stream to the sensor's own size, is exactly
		// how the scaler that was missing comes back. Ask again rather than
		// hold the refusal over a camera that has since been fixed. Mounting
		// the section clears it too, which is what keeps a merely-busy moment
		// from greying the button for the rest of the visit.
		state.ircutNoSnap = null;
		syncLegacy();
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

	// The mark has to be rebuilt each time, since the message is written as
	// text into the notice and would otherwise take the drawn mark with it.
	// textContent for the message itself: it is majestic's own response body,
	// which on a rejected leaf is whatever the daemon chose to say.
	function showError(msg) {
		const e = document.querySelector('#mj-settings-form .mj-error');
		if (!e) return;
		e.innerHTML = mjNoticeIcon('danger') + '<div class="mj-notice-txt"></div>';
		e.querySelector('.mj-notice-txt').textContent = msg;
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
		a.className = 'mj-notice mj-notice-danger';
		a.setAttribute('role', 'alert');
		a.innerHTML = mjNoticeIcon('danger') + '<div class="mj-notice-txt"></div>';
		// textContent: msg carries an HTTP status the camera handed back.
		a.querySelector('.mj-notice-txt').textContent = msg;
		container.appendChild(a);
	}
})();
