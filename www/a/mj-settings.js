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

	const TAB = boot.tab;
	const EXCLUDE = new Set(boot.exclude || []);
	const SENSORS = boot.sensors || [];

	const state = {
		schema: null,
		config: null,
		fields: [],
		initial: {},
	};

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', load);
	} else {
		load();
	}

	async function load() {
		const form = document.getElementById('mj-settings-form');
		if (!form) return;
		form.innerHTML = '';
		form.addEventListener('submit', onSubmit);

		const err = document.createElement('div');
		err.className = 'mj-error alert alert-danger d-none';
		err.role = 'alert';
		form.appendChild(err);

		let schema, config;
		try {
			[schema, config] = await Promise.all([
				fetchJson('/api/v1/config.schema.json'),
				fetchJson('/api/v1/config.json'),
			]);
		} catch (e) {
			showFatal(form, 'Failed to load schema or config: ' + e.message);
			return;
		}

		state.schema = schema;
		state.config = config;

		const props = ((schema.properties || {})[TAB] || {}).properties;
		if (!props) {
			showFatal(form, 'Schema has no properties for tab "' + TAB + '".');
			return;
		}

		state.fields = [];
		state.initial = {};
		for (const key of Object.keys(props)) {
			const dot = TAB + '.' + key;
			if (EXCLUDE.has(dot)) continue;

			const sub = props[key];
			const eff = getDotted(config, dot);
			const field = renderField(form, dot, key, sub, eff);
			if (field) {
				state.fields.push(field);
				state.initial[dot] = field.getValue();
			}
		}

		const toolbar = document.createElement('div');
		toolbar.className = 'mj-toolbar d-flex align-items-center mt-3 gap-2';
		toolbar.innerHTML =
			'<span class="me-auto text-secondary small" id="mj-dirty-count">No changes.</span>' +
			'<button type="submit" class="btn btn-primary" id="mj-save" disabled>Save Changes</button>';
		form.appendChild(toolbar);

		renderRelated();
		updateDirty();
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
		const config = await fetchJson('/api/v1/config.json');
		state.config = config;
		for (const f of state.fields) {
			const eff = getDotted(config, f.dot);
			f.setValue(eff);
			state.initial[f.dot] = f.getValue();
		}
		renderRelated();
		updateDirty();
	}

	function renderRelated() {
		const pre = document.querySelector('#mj-settings-related-col pre');
		if (!pre) return;
		const lines = [];
		for (const f of state.fields) {
			const def = f.schema.default;
			if (def === undefined) continue;
			const eff = getDotted(state.config, f.dot);
			if (eff === undefined) continue;
			if (String(eff) !== String(def)) {
				lines.push('.' + f.dot + ': ' + String(eff));
			}
		}
		pre.textContent = lines.length ? lines.join('\n') : '—';
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
