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

	async function load(tab, push) {
		const form = document.getElementById('mj-settings-form');
		if (!form) return;

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

		state.fields = [];
		state.initial = {};
		// Render each merged section. Multi-section groups get a subheader per
		// section; a single-section group needs none (the tab title says it).
		const multi = group.sections.length > 1;
		for (const section of group.sections) {
			const props = ((state.schema.properties || {})[section] || {}).properties;
			if (!props) continue;
			if (multi) {
				const h = el('h5', 'mt-4 mb-2 text-secondary');
				h.textContent = label(section);
				form.appendChild(h);
			}
			renderProps(form, section, props);
		}

		const toolbar = document.createElement('div');
		toolbar.className = 'mj-toolbar d-flex align-items-center mt-3 gap-2';
		toolbar.innerHTML =
			'<span class="me-auto text-secondary small" id="mj-dirty-count">No changes.</span>' +
			'<button type="submit" class="btn btn-primary" id="mj-save" disabled>Save Changes</button>';
		form.appendChild(toolbar);

		if (groupHasMotion(group)) toggleRoi(group);

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
			const wrap = document.createElement('div');
			wrap.id = id;
			wrap.className = 'mt-4';
			wrap.innerHTML =
				'<h3>Visual editor</h3>' +
				'<iframe id="mj-roi-iframe" src="/m/img.html" frameborder="0" style="padding:0;margin:0;border:1px solid rgb(76,96,216);width:100%;aspect-ratio:16/9;"></iframe>' +
				'<div class="row mb-3 mt-2 align-items-center">' +
				'<div class="col"><input type="button" class="btn btn-primary" id="mj-roi-clear" value="Clear all regions"></div>' +
				'</div>';
			const col = document.getElementById('mj-settings-form-col');
			if (col) col.appendChild(wrap);
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

	function renderProps(form, basePath, props) {
		for (const key of Object.keys(props)) {
			const dot = basePath + '.' + key;
			if (EXCLUDE.has(dot)) continue;
			const sub = props[key];
			if (sub && sub.type === 'object' && sub.properties) {
				const h = el('h5', 'mt-4 mb-2 text-secondary');
				h.textContent = sub.title || titleCase(key);
				form.appendChild(h);
				renderProps(form, dot, sub.properties);
				continue;
			}
			const eff = getDotted(state.config, dot);
			const field = renderField(form, dot, key, sub, eff);
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

	function renderField(form, dot, key, sub, eff) {
		const desc = sub.description || key;
		const type = sub.type;
		const id = 'mjf-' + dot.replace(/\./g, '-');
		const hasDefault = Object.prototype.hasOwnProperty.call(sub, 'default');
		const isSensorPath = dot === 'isp.sensorConfig' && SENSORS.length > 0;
		const enumVals = Array.isArray(sub.enum) ? sub.enum : null;

		let p, control;

		if (type === 'boolean') {
			p = el('p', 'boolean mj-row');
			p.innerHTML =
				'<span class="form-check form-switch">' +
				'<input type="checkbox" id="' + id + '" class="form-check-input">' +
				'<label for="' + id + '" class="form-check-label">' + esc(desc) + '</label>' +
				'</span>';
			control = p.querySelector('input');
			control.checked = toBool(eff);
		} else if (type === 'integer' && isNum(sub.maximum) && sub.maximum <= 100) {
			p = el('p', 'range mj-row');
			const min = isNum(sub.minimum) ? sub.minimum : 0;
			const max = sub.maximum;
			const v = isNumish(eff) ? String(eff) : '';
			p.innerHTML =
				'<label for="' + id + '" class="form-label">' + esc(desc) + '</label>' +
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
		} else if (type === 'string' && enumVals && enumVals.length) {
			p = el('p', 'select mj-row');
			const opts = enumVals.map(o => option(o, String(eff) === String(o))).join('');
			p.innerHTML =
				'<label for="' + id + '" class="form-label">' + esc(desc) + '</label>' +
				'<select class="form-select" id="' + id + '">' + opts + '</select>';
			control = p.querySelector('select');
		} else if (type === 'string' && isSensorPath) {
			p = el('p', 'select mj-row');
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

		form.appendChild(p);

		control.addEventListener('input', updateDirty);
		control.addEventListener('change', updateDirty);

		// array fields canonicalise to a comma-joined string so dirty-tracking
		// (a plain !== against state.initial) keeps working; onSubmit splits it
		// back into a list before POSTing.
		const getValue = type === 'boolean'
			? () => control.checked ? 'true' : 'false'
			: type === 'array'
			? () => control._rows().join(', ')
			: () => String(control.value);

		const setValue = (v) => {
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
		} catch (e) {
			showError('Save failed: ' + e.message);
		} finally {
			btn.textContent = 'Save Changes';
			updateDirty();
		}
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
