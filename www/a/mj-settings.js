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

	function buildNav() {
		const nav = document.getElementById('mj-settings-nav');
		if (!nav) return;
		nav.innerHTML = '';
		for (const key of Object.keys(state.schema.properties || {})) {
			const li = document.createElement('li');
			li.className = 'nav-item';
			const a = document.createElement('a');
			a.className = 'nav-link';
			a.href = 'mj-settings.cgi?tab=' + encodeURIComponent(key);
			a.textContent = label(key);
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
		const tabFromUrl = new URLSearchParams(location.search).get('tab') || 'system';
		if (tabFromUrl === state.tab) return;
		load(tabFromUrl, /*push*/ false);
	}

	async function load(tab, push) {
		state.tab = tab;

		setActiveNav(tab);
		setTitle(tab);
		if (tab !== 'motionDetect') toggleRoi(tab);
		if (push) {
			history.pushState({ tab }, '', 'mj-settings.cgi?tab=' + encodeURIComponent(tab));
		}

		const form = document.getElementById('mj-settings-form');
		if (!form) return;
		form.innerHTML = '';
		if (!form.dataset.bound) {
			form.addEventListener('submit', onSubmit);
			form.dataset.bound = '1';
		}

		const err = document.createElement('div');
		err.className = 'mj-error alert alert-danger d-none';
		err.role = 'alert';
		form.appendChild(err);

		try {
			if (!state.schema) state.schema = await fetchJson('/api/v1/config.schema.json');
			if (!state.config) state.config = await fetchJson('/api/v1/config.json');
		} catch (e) {
			showFatal(form, 'Failed to load schema or config: ' + e.message);
			return;
		}

		const props = ((state.schema.properties || {})[tab] || {}).properties;
		if (!props) {
			showFatal(form, 'Schema has no properties for tab "' + tab + '".');
			return;
		}

		state.fields = [];
		state.initial = {};
		renderProps(form, tab, props);

		const toolbar = document.createElement('div');
		toolbar.className = 'mj-toolbar d-flex align-items-center mt-3 gap-2';
		toolbar.innerHTML =
			'<span class="me-auto text-secondary small" id="mj-dirty-count">No changes.</span>' +
			'<button type="submit" class="btn btn-primary" id="mj-save" disabled>Save Changes</button>';
		form.appendChild(toolbar);

		if (tab === 'motionDetect') toggleRoi(tab);

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

	function setTitle(tab) {
		const h = document.getElementById('mj-settings-title');
		if (h) h.textContent = label(tab);
	}

	function toggleRoi(tab) {
		const id = 'mj-roi-inset';
		const existing = document.getElementById(id);
		if (tab === 'motionDetect') {
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
					const ifr = document.getElementById('mj-roi-iframe');
					if (ifr) ifr.contentWindow.location.reload();
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

		const getValue = type === 'boolean'
			? () => control.checked ? 'true' : 'false'
			: () => String(control.value);

		const setValue = (v) => {
			if (type === 'boolean') {
				control.checked = toBool(v);
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
		for (const f of dirty) setDotted(body, f.dot, f.getValue());

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
