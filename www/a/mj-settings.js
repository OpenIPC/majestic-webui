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

	const state = {
		tab: boot.tab,
		schema: null,
		config: null,
		fields: [],
		initial: {},
	};

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}

	async function init() {
		try {
			state.schema = await fetchJson('/api/v1/config.schema.json');
		} catch (e) {
			const form = document.getElementById('mj-settings-form');
			if (form) showFatal(form, 'Failed to load schema: ' + e.message);
			return;
		}
		buildNav();
		window.addEventListener('popstate', onPopState);
		await load(state.tab, /*push*/ false);
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

	function groupForTab(tab) {
		const gs = groups();
		return gs.find(g => g.id === tab) ||           // group id
			gs.find(g => g.sections.includes(tab)) ||  // old ?tab=<section> bookmark
			gs[0];                                      // default: first group
	}

	function buildNav() {
		const nav = document.getElementById('mj-settings-nav');
		if (!nav) return;
		nav.innerHTML = '';
		for (const g of groups()) {
			const li = document.createElement('li');
			li.className = 'nav-item';
			const a = document.createElement('a');
			a.className = 'nav-link';
			a.href = 'mj-settings.cgi?tab=' + encodeURIComponent(g.id);
			a.textContent = g.label;
			li.appendChild(a);
			nav.appendChild(li);
		}
		wireNav();
	}

	function wireNav() {
		document.querySelectorAll('#mj-settings-nav .nav-link').forEach(link => {
			link.addEventListener('click', ev => {
				const u = new URL(link.href);
				const newTab = u.searchParams.get('tab');
				if (!newTab) return;
				ev.preventDefault();
				if (newTab === state.tab) return;
				if (hasDirty() && !confirm('You have unsaved changes. Discard and switch tabs?')) return;
				load(newTab, /*push*/ true);
			});
		});
	}

	function onPopState(ev) {
		const tabFromUrl = new URLSearchParams(location.search).get('tab');
		const g = groupForTab(tabFromUrl);
		if (g && g.id === state.tab) return;
		load(tabFromUrl, /*push*/ false);
	}

	function groupHasMotion(group) {
		return !!(group && group.sections && group.sections.includes('motionDetect'));
	}

	// A group has a live preview when any of its fields are x-live (the
	// HiSilicon image CSC knobs) — so the user can see the effect while dragging.
	function groupHasLive(group) {
		if (!group) return false;
		const props = (state.schema && state.schema.properties) || {};
		return group.sections.some(s => {
			const sp = (props[s] || {}).properties || {};
			return Object.keys(sp).some(k => sp[k] && sp[k]['x-live']);
		});
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
				fetch('/api/v1/image?' + parts.join('&'),
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

		const group = groupForTab(tab);
		if (!group) {
			showFatal(form, 'No settings groups in schema.');
			return;
		}
		state.tab = group.id;

		setActiveNav(group.id);
		setTitle(group.label);
		if (!groupHasMotion(group)) toggleRoi(group);
		if (push) {
			history.pushState({ tab: group.id }, '', 'mj-settings.cgi?tab=' + encodeURIComponent(group.id));
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

		// Each section renders as its own card; the cards flow in a responsive
		// 2-column grid that fills the page width.
		const grid = el('div', 'row g-4');
		grid.id = 'mj-settings-grid';
		form.appendChild(grid);

		// Plain section cards pack into a CSS-column masonry below the grid, so
		// unequal card heights don't leave chessboard gaps. The grid above keeps
		// the wide interactive panels (live preview, live-adjust, ROI editor) and
		// the lone full-width card, which want a flex row.
		const cards = el('div', 'mj-cards');
		form.appendChild(cards);

		state.fields = [];
		state.initial = {};

		// Live-tunable groups (image): the preview and a "Live adjustments" panel of
		// the x-live knobs sit side by side at the top, so dragging a knob shows its
		// effect without scrolling. The knobs are registered here and skipped in the
		// section cards below to avoid duplicate controls.
		const live = groupHasLive(group);
		if (live) {
			if (window.MajesticVideo) {
				const pv = el('div', 'col-12 col-lg-7');
				pv.id = 'mj-live-preview';
				pv.innerHTML =
					'<div class="card"><div class="card-body">' +
					'<div class="text-secondary small mb-1">Live preview</div>' +
					'<video id="mj-live-video" autoplay muted playsinline class="mj-live-video"></video>' +
					'</div></div>';
				grid.appendChild(pv);
				state.previewPlayer =
					window.MajesticVideo.attach(pv.querySelector('#mj-live-video'), { stream: 0 });
				renderLivePanel(grid, group, 'col-12 col-lg-5');
			} else {
				renderLivePanel(grid, group, 'col-12 col-lg-6');
			}
		}

		// One card per merged section; renderProps fills the card body (nested
		// object sub-properties still get an <h5> subheader inside the card).
		// Multi-card groups flow 2-up; a lone card (e.g. Recording — no preview,
		// no ROI mate) is centred so it reads as one panel, not a left-stranded half.
		const lone = group.sections.length === 1 && !groupHasMotion(group) && !live;
		// plain/live groups masonry their cards; the lone card and the motion group
		// (its card pairs with the ROI editor) stay in the flex grid as before.
		const useMasonry = !lone && !groupHasMotion(group);
		const colCls = lone ? 'col-12' : 'col-12 col-lg-6';
		for (const section of group.sections) {
			const props = ((state.schema.properties || {})[section] || {}).properties;
			if (!props) continue;
			const card = el('div', 'card');
			const body = el('div', 'card-body');
			const h = el('h3');
			h.textContent = label(section);
			body.appendChild(h);
			// a lone full-width card flows its fields in two columns so it fills the
			// width instead of stranding a half-card or stretching single-column inputs.
			const target = lone ? el('div', 'mj-cols') : body;
			if (lone) body.appendChild(target);
			card.appendChild(body);
			renderProps(target, section, props);
			// a section whose only fields were x-live (moved to the panel) is empty
			// apart from its heading — don't show an empty card.
			const filled = lone ? target.childElementCount > 0 : body.childElementCount > 1;
			if (!filled) continue;
			// the video channels (video0 = main, video1 = sub) stay a side-by-side
			// pair at the top, in the flex grid, so users can compare the two
			// channels; everything else flows into the masonry below.
			const pinned = /^video\d+$/.test(section);
			if (useMasonry && !pinned) {
				// bare card; .mj-cards > .card supplies break-inside + spacing
				cards.appendChild(card);
			} else {
				const col = el('div', colCls);
				col.appendChild(card);
				grid.appendChild(col);
			}
		}

		if (groupHasMotion(group)) toggleRoi(group);

		// Plain tabs route every card to the masonry, leaving the flex grid empty.
		// An empty Bootstrap `.row` keeps its negative top margin and would pull the
		// masonry up over the page heading — drop it when nothing used it.
		if (!grid.childElementCount) grid.remove();

		const toolbar = document.createElement('div');
		toolbar.className = 'mj-toolbar d-flex align-items-center gap-2';
		toolbar.innerHTML =
			'<span class="me-auto text-secondary small" id="mj-dirty-count">No changes.</span>' +
			'<button type="submit" class="btn btn-primary" id="mj-save" disabled>Save Changes</button>';
		form.appendChild(toolbar);

		applyVisibility();

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

	function setTitle(title) {
		const h = document.getElementById('mj-settings-title');
		if (h) h.textContent = title;
	}

	function toggleRoi(group) {
		const id = 'mj-roi-inset';
		const existing = document.getElementById(id);
		if (groupHasMotion(group)) {
			if (existing) return;
			const grid = document.getElementById('mj-settings-grid');
			if (!grid) return;
			const col = document.createElement('div');
			col.id = id;
			col.className = 'col-12 col-lg-6';
			col.innerHTML =
				'<div class="card"><div class="card-body">' +
				'<h3>Visual editor</h3>' +
				'<iframe id="mj-roi-iframe" src="/m/img.html" frameborder="0" class="mj-roi-iframe"></iframe>' +
				'<button type="button" class="btn btn-outline-secondary mt-2" id="mj-roi-clear">Clear all regions</button>' +
				'</div></div>';
			grid.appendChild(col);
			const clearBtn = document.getElementById('mj-roi-clear');
			if (clearBtn) {
				clearBtn.addEventListener('click', () => {
					const roiField = state.fields.find(f => f.dot === 'motionDetect.roi');
					if (roiField) {
						roiField.setValue('');
						updateDirty();
					}
				});
			}
		} else if (existing) {
			existing.remove();
		}
	}

	function hasDirty() {
		return state.fields.some(f => f.getValue() !== state.initial[f.dot]);
	}

	function titleCase(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

	// Render the x-live knobs of a live group into a "Live adjustments" card next to
	// the preview, with one "Reset all" (no per-knob resets). The knobs still register
	// in state.fields, so the page Save + dirty tracking cover them.
	function renderLivePanel(grid, group, colCls) {
		const col = el('div', colCls);
		col.id = 'mj-live-panel';
		const card = el('div', 'card');
		const body = el('div', 'card-body');
		const head = el('div', 'd-flex align-items-center mb-2');
		head.innerHTML =
			'<h3 class="mb-0 me-auto">Live adjustments</h3>' +
			'<button type="button" class="btn btn-sm btn-link p-0 mj-reset" id="mj-live-reset">↺ Reset all</button>';
		body.appendChild(head);

		const props = state.schema.properties || {};
		const found = [];
		for (const section of group.sections) {
			const sp = (props[section] || {}).properties || {};
			for (const key of Object.keys(sp)) {
				if (sp[key] && sp[key]['x-live']) found.push({ section, key, sub: sp[key] });
			}
		}
		found.sort((a, b) => {
			const ia = LIVE_ORDER.indexOf(a.key), ib = LIVE_ORDER.indexOf(b.key);
			return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
		});

		const dots = [];
		for (const f of found) {
			const dot = f.section + '.' + f.key;
			if (EXCLUDE.has(dot)) continue;
			const eff = getDotted(state.config, dot);
			const field = renderField(body, dot, f.key, f.sub, eff, { live: true });
			if (field) {
				state.fields.push(field);
				state.initial[dot] = field.getValue();
				dots.push(dot);
			}
		}

		card.appendChild(body);
		col.appendChild(card);
		grid.appendChild(col);

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
			const res = await fetch('/api/v1/reset?' + q, { credentials: 'same-origin' });
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
			const sub = props[key];
			if (sub && sub['x-live']) continue;   // live knobs render in the side panel
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

	function applyVisibility() {
		state.visUpdaters = [];
		const byDot = {};
		for (const f of state.fields) byDot[f.dot] = f;
		for (const f of state.fields) {
			const vw = f.schema && f.schema.visibleWhen;
			if (!vw || !vw.field) continue;
			const parent = f.dot.slice(0, f.dot.lastIndexOf('.'));
			const ctrl = byDot[parent + '.' + vw.field];
			if (!ctrl) continue;
			const update = () => { f.p.style.display = String(ctrl.getValue()) === String(vw.equals) ? '' : 'none'; };
			ctrl.control.addEventListener('change', update);
			ctrl.control.addEventListener('input', update);
			state.visUpdaters.push(update);
			update();
		}
	}

	function runVisibility() {
		(state.visUpdaters || []).forEach(u => u());
	}

	function renderField(container, dot, key, sub, eff, opts) {
		opts = opts || {};
		const live = !!opts.live;
		// the field's `title` is the short label; older schemas only had `description`
		const desc = sub.title || sub.description || key;
		const meta = LIVE_META[key];
		// live knobs show an emoji + short label; everything else uses the title
		const labelHtml = (live && meta)
			? '<span class="mj-live-ico">' + meta.icon + '</span> ' + esc(meta.label)
			: esc(desc);
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
				'<label for="' + id + '" class="form-label">' + esc(desc) + '</label>' +
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
				// aspect ratio; jpeg (no native, no main) is left unfiltered by AR
				const arSrc = arRef || extraMax;
				if (arSrc) { const a = resAR(arSrc.w, arSrc.h); list = list.filter(o => resAR(o.w, o.h) === a); }
				if (extraMax) list = list.filter(o => o.w <= extraMax.w && o.h <= extraMax.h);
				const c = parseWH(cur);   // always keep the current value selectable
				if (c && !list.some(o => o.w === c.w && o.h === c.h)) list.push(c);
				list.sort((a, b) => b.w * b.h - a.w * a.h);
				return list;
			};
			const optsHtml = (list, selVal) => list.map(o => {
				const val = o.w + 'x' + o.h;
				const lbl = resLabel(o.w, o.h) + (val === nativeKey ? ' · Native' : '');
				return '<option value="' + esc(val) + '"' + (val === selVal ? ' selected' : '') + '>' + esc(lbl) + '</option>';
			}).join('') + '<option value="' + RES_CUSTOM + '">Custom…</option>';
			p.innerHTML =
				'<label for="' + id + '" class="form-label">' + esc(desc) + '</label>' +
				'<select class="form-select" id="' + id + '">' + optsHtml(buildList(), cur) + '</select>' +
				'<input type="text" class="form-control mt-1 mj-res-custom" placeholder="custom, e.g. 1920x1080" value="' + esc(cur) + '" style="display:none">';
			control = p.querySelector('select');
			const txt = p.querySelector('.mj-res-custom');
			const inList = (v) => Array.from(control.options).some(o => o.value === v && o.value !== RES_CUSTOM);
			const syncCustom = () => {
				const custom = control.value === RES_CUSTOM;
				txt.style.display = custom ? '' : 'none';
				if (custom) txt.focus();
			};
			// an empty or off-list current value starts in Custom mode, so an
			// unset field (e.g. jpeg.size = "") round-trips as "" and stays clean
			if (!cur || !inList(cur)) { control.value = RES_CUSTOM; }
			syncCustom();
			control.addEventListener('change', syncCustom);
			txt.addEventListener('input', updateDirty);
			txt.addEventListener('change', updateDirty);
			// text box wins when Custom is active; otherwise the select value
			control._get = () => control.value === RES_CUSTOM ? String(txt.value).trim() : control.value;
			control._set = (v) => {
				const s = v == null ? '' : String(v);
				txt.value = s;
				control.value = (s && inList(s)) ? s : RES_CUSTOM;
				syncCustom();
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
			const opts = enumVals.map(o => option(o, String(eff) === String(o))).join('');
			p.innerHTML =
				'<label for="' + id + '" class="form-label">' + esc(desc) + '</label>' +
				'<select class="form-select" id="' + id + '">' + opts + '</select>';
			control = p.querySelector('select');
		} else if (type === 'string' && isSensorPath) {
			p = el('p', 'select mj-row mj-wide');
			const opts = '<option value=""></option>' + SENSORS.map(s => option(s, String(eff) === s)).join('');
			p.innerHTML =
				'<label for="' + id + '" class="form-label">' + esc(desc) + '</label>' +
				'<select class="form-select" id="' + id + '">' + opts + '</select>';
			control = p.querySelector('select');
		} else if (type === 'string') {
			p = el('p', 'string mj-row');
			const v = eff !== undefined && eff !== null ? String(eff) : '';
			p.innerHTML =
				'<label for="' + id + '" class="form-label">' + esc(desc) + '</label>' +
				'<input type="text" id="' + id + '" class="form-control" value="' + esc(v) + '">';
			control = p.querySelector('input');
		} else if (type === 'array') {
			// MultiRect fields (motionDetect.roi, crop, privacyMasks) are a list of
			// "AxBxCxD" regions: render one editable row per region, not a single
			// comma-joined string. The Visual editor (m/img.html) adds/reads rows
			// through the window.mjRoi* hooks exposed below.
			p = el('p', 'array mj-row');
			p.innerHTML =
				'<label class="form-label">' + esc(desc) + '</label>' +
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
			reset.className = 'btn btn-sm btn-link p-0 ms-2 mj-reset';
			reset.textContent = '↺ reset';
			if (!hasDefault) {
				reset.disabled = true;
				reset.title = 'Server has no recorded default for this key.';
			} else {
				reset.title = 'Reset to default: ' + String(sub.default);
				reset.addEventListener('click', () => onReset(dot, reset));
			}
			p.appendChild(reset);
		}

		// detailed help under the control (skipped on the compact live-panel rows):
		// the authored `hint` plus auto-context (value range for bounded integers).
		if (!live) {
			const hintParts = [];
			if (sub.hint) hintParts.push(esc(sub.hint));
			// only plain number inputs gain a range hint; sliders (max ≤ 100)
			// already show their bounds via the track and the live value box
			const isSlider = type === 'integer' && isNum(sub.maximum) && sub.maximum <= 100;
			if (type === 'integer' && !isSlider && isNum(sub.minimum) && isNum(sub.maximum))
				hintParts.push(esc(sub.minimum + '–' + sub.maximum));
			if (hintParts.length) {
				// block-level so it sits on its own line below the control and the
				// inline "↺ reset" link (a span would flow into it, e.g. "reset0–32")
				const hint = el('div', 'hint text-secondary');
				hint.innerHTML = hintParts.join(' · ');
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
		const lbl = document.getElementById('mj-dirty-count');
		const btn = document.getElementById('mj-save');
		if (lbl) lbl.textContent = n ? (n + ' change' + (n === 1 ? '' : 's') + ' pending.') : 'No changes.';
		if (btn) btn.disabled = n === 0;
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
		clearError();
		try {
			const res = await fetch('/api/v1/config', {
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
			// reloads its pipeline. Offer that as an explicit step.
			if (dirty.some(f => !(f.schema && f.schema['x-live'])))
				showApplyBanner();
		} catch (e) {
			showError('Save failed: ' + e.message);
		} finally {
			btn.textContent = 'Save Changes';
			updateDirty();
		}
	}

	// majestic is the HTTP server, so we don't restart the process — we SIGHUP
	// it (via j/mj-apply.cgi) for an in-process reload that rebuilds the encoder
	// pipeline while the web server stays up, then poll until it answers again.
	function showApplyBanner() {
		const form = document.getElementById('mj-settings-form');
		if (!form) return;
		let bar = document.getElementById('mj-apply-bar');
		if (!bar) {
			bar = el('div', 'alert alert-warning d-flex align-items-center gap-2 mb-3');
			bar.id = 'mj-apply-bar';
			form.insertBefore(bar, form.children[1] || null);
		} else {
			bar.className = 'alert alert-warning d-flex align-items-center gap-2 mb-3';
		}
		bar.innerHTML =
			'<span class="me-auto">Saved. Resolution, codec and frame-rate changes take effect after a pipeline reload (the video streams will blink briefly).</span>' +
			'<button type="button" class="btn btn-sm btn-warning flex-shrink-0" id="mj-apply-btn">Apply now</button>';
		document.getElementById('mj-apply-btn').addEventListener('click', applyReload);
	}

	async function pollUp(maxMs) {
		const deadline = Date.now() + maxMs;
		while (Date.now() < deadline) {
			try {
				const ctl = new AbortController();
				const t = setTimeout(() => ctl.abort(), 3000);
				const r = await fetch('/api/v1/config.json',
					{ cache: 'no-store', credentials: 'same-origin', signal: ctl.signal });
				clearTimeout(t);
				if (r.ok) return true;
			} catch (e) { /* loop is busy reloading / connection blipped */ }
			await new Promise(res => setTimeout(res, 1000));
		}
		return false;
	}

	async function applyReload() {
		const bar = document.getElementById('mj-apply-bar');
		const btn = document.getElementById('mj-apply-btn');
		if (btn) { btn.disabled = true; btn.textContent = 'Applying…'; }
		stopLivePreview();   // the stream drops while the pipeline rebuilds
		try {
			await fetch('j/mj-apply.cgi', { credentials: 'same-origin' });
		} catch (e) { /* the reload may sever this request — expected */ }
		const up = await pollUp(30000);
		if (up) {
			location.reload();   // clean re-fetch of schema/config + preview
			return;
		}
		if (bar) {
			bar.className = 'alert alert-danger d-flex align-items-center gap-2 mb-3';
			bar.querySelector('span').textContent =
				'The reload is taking longer than expected — the camera may still be applying changes.';
		}
		if (btn) { btn.disabled = false; btn.textContent = 'Retry'; }
	}

	async function onReset(dot, btn) {
		if (!confirm('Reset "' + dot + '" to its declared default?')) return;
		btn.disabled = true;
		const orig = btn.textContent;
		btn.textContent = '…';
		clearError();
		try {
			const res = await fetch('/api/v1/reset?key=' + encodeURIComponent(dot), { credentials: 'same-origin' });
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
		const r = await fetch(url, { credentials: 'same-origin' });
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

	function option(v, selected) {
		return '<option value="' + esc(v) + '"' + (selected ? ' selected' : '') + '>' + esc(v) + '</option>';
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
