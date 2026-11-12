/**
 * Scene & Night Shutter Presets Modal for Live Preview
 * One-tap switching between Day Auto, Night Anti-Glare (Fast Shutter),
 * Night Balanced, Night Max Light, and user-created custom shutter profiles.
 */
(function () {
	const fn = typeof $ === 'function' ? $('#mj-ptz-fn') : document.getElementById('mj-ptz-fn');
	const stage = typeof $ === 'function' ? $('#mj-stage') : document.getElementById('mj-stage');
	if (!fn || !stage || typeof apiFetch !== 'function') return;

	const style = document.createElement('style');
	style.textContent = [
		'.mj-sc-modal{position:fixed;inset:0;z-index:1060;background:rgba(8,10,14,.78);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:12px;color:#e9ecef;font-family:inherit}',
		'.mj-sc-modal[hidden]{display:none}',
		'.mj-sc-box{width:min(720px,100%);max-height:88vh;display:flex;flex-direction:column;background:rgba(18,21,28,.96);border:1px solid rgba(255,255,255,.14);border-radius:10px;box-shadow:0 20px 50px rgba(0,0,0,.6);overflow:hidden}',
		'.mj-sc-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.1)}',
		'.mj-sc-title{margin:0;font-size:1rem;font-weight:600;color:#fff}',
		'.mj-sc-sub{font-size:.78rem;color:#adb5bd;margin-top:2px}',
		'.mj-sc-body{padding:14px 16px;overflow-y:auto;display:flex;flex-direction:column;gap:14px}',
		'.mj-sc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}',
		'.mj-sc-card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:6px}',
		'.mj-sc-card.active{border-color:#198754;box-shadow:0 0 0 1px rgba(25,135,84,.5)}',
		'.mj-sc-name{font-weight:600;font-size:.88rem;color:#fff}',
		'.mj-sc-desc{font-size:.75rem;color:#adb5bd;line-height:1.3;flex:1}',
		'.mj-sc-meta{font-size:.72rem;color:#ced4da}',
		'.mj-sc-actions{display:flex;gap:6px;margin-top:4px}',
		'.mj-sc-btn{border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);color:#fff;border-radius:6px;padding:5px 10px;font-size:.78rem;font-weight:600;cursor:pointer}',
		'.mj-sc-btn:hover{background:rgba(255,255,255,.16)}',
		'.mj-sc-btn.primary{background:#0d6efd;border-color:#0d6efd}',
		'.mj-sc-btn.active{background:#198754;border-color:#198754}',
		'.mj-sc-btn.danger{background:rgba(220,53,69,.2);border-color:rgba(220,53,69,.45);color:#ff8787}',
		'.mj-sc-custom{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:12px;display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;align-items:end}',
		'.mj-sc-field{display:flex;flex-direction:column;gap:4px;font-size:.76rem;color:#ced4da}',
		'.mj-sc-input{background:rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.2);color:#fff;border-radius:6px;padding:5px 8px;font-size:.8rem}'
	].join('');
	document.head.appendChild(style);

	const scBtn = document.createElement('button');
	scBtn.type = 'button';
	scBtn.className = 'mj-ptz-fnbtn';
	scBtn.setAttribute('aria-label', 'Scene and night shutter presets');
	scBtn.title = 'Switch scene & night shutter presets (Anti-glare, Night, Day, Custom)';
	scBtn.innerHTML =
		'<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
		'<circle cx="10" cy="10" r="3.2"></circle>' +
		'<path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4"></path>' +
		'</svg><span>Scenes</span>';
	fn.appendChild(scBtn);

	const modal = document.createElement('div');
	modal.className = 'mj-sc-modal';
	modal.hidden = true;
	modal.innerHTML =
		'<div class="mj-sc-box" role="dialog" aria-modal="true" aria-label="Scene & Night Shutter Presets">' +
		'  <div class="mj-sc-head">' +
		'    <div>' +
		'      <div class="mj-sc-title">Scene & Night Shutter Modes</div>' +
		'      <div class="mj-sc-sub">Tune shutter speed & tone for streetlights, motion, or low light (Live: <span data-sc="liveinfo">…</span>)</div>' +
		'    </div>' +
		'    <button type="button" class="mj-sc-btn" data-sc="close">Close</button>' +
		'  </div>' +
		'  <div class="mj-sc-body">' +
		'    <div class="mj-sc-grid" data-sc="grid"></div>' +
		'    <div class="mj-sc-custom">' +
		'      <div class="mj-sc-field"><label>Preset Name</label><input type="text" class="mj-sc-input" data-sc="name" maxlength="28" placeholder="e.g. Streetlamp Night"></div>' +
		'      <div class="mj-sc-field"><label>Shutter / Exp (0=Auto, 5-500)</label><input type="number" class="mj-sc-input" data-sc="exp" min="0" max="500" value="40"></div>' +
		'      <div class="mj-sc-field"><label>Brightness (0-100)</label><input type="number" class="mj-sc-input" data-sc="lum" min="0" max="100" value="48"></div>' +
		'      <div class="mj-sc-field"><label>Contrast (0-100)</label><input type="number" class="mj-sc-input" data-sc="con" min="0" max="100" value="54"></div>' +
		'      <div class="mj-sc-field"><label>IR-Cut Filter</label>' +
		'        <select class="mj-sc-input" data-sc="irc"><option value="keep">Keep Current</option><option value="night">Night (IR On)</option><option value="day">Day (IR Cut)</option></select>' +
		'      </div>' +
		'      <div class="mj-sc-field"><label><input type="checkbox" data-sc="af"> Refocus after apply</label>' +
		'        <button type="button" class="mj-sc-btn primary" data-sc="save">Save & Apply Custom</button>' +
		'      </div>' +
		'    </div>' +
		'  </div>' +
		'</div>';
	document.body.appendChild(modal);

	['pointerdown', 'pointerup', 'click', 'dblclick', 'keydown'].forEach(ev => {
		scBtn.addEventListener(ev, e => e.stopPropagation());
		modal.addEventListener(ev, e => e.stopPropagation());
	});

	const BUILTIN = new Set(['day_auto', 'night_glare', 'night_bal', 'night_max']);
	let stateData = null;
	let busy = false;

	function renderModal() {
		const grid = modal.querySelector('[data-sc="grid"]');
		const info = modal.querySelector('[data-sc="liveinfo"]');
		grid.innerHTML = '';
		if (!stateData) return;

		const cur = stateData.current || {};
		if (info) {
			info.textContent = 'Exp ' + (cur.exposure === 0 ? 'Auto' : cur.exposure) +
				' · Bri ' + (cur.luminance ?? 50) + ' · Con ' + (cur.contrast ?? 50);
		}

		(stateData.scenes || []).forEach(s => {
			const isActive = stateData.active === s.id ||
				(!stateData.active && cur.exposure === s.exposure && cur.luminance === s.luminance && cur.contrast === s.contrast);
			const card = document.createElement('div');
			card.className = 'mj-sc-card' + (isActive ? ' active' : '');
			const expLabel = s.exposure === 0 ? 'Auto' : s.exposure;
			const canDel = !BUILTIN.has(s.id);

			card.innerHTML =
				'<div class="mj-sc-name"></div>' +
				'<div class="mj-sc-desc"></div>' +
				'<div class="mj-sc-meta">Shutter: <strong>' + expLabel + '</strong> · Bri: ' + s.luminance + ' · Con: ' + s.contrast +
				(s.ircut && s.ircut !== 'keep' ? ' · IR: ' + s.ircut : '') + '</div>' +
				'<div class="mj-sc-actions">' +
				'  <button type="button" class="mj-sc-btn ' + (isActive ? 'active' : 'primary') + '" style="flex:1" data-apply="' + s.id + '">' +
				(isActive ? 'Active Scene' : 'Apply Scene') + '</button>' +
				(canDel ? '  <button type="button" class="mj-sc-btn danger" data-del="' + s.id + '" title="Delete custom scene">✕</button>' : '') +
				'</div>';
			card.querySelector('.mj-sc-name').textContent = s.name;
			card.querySelector('.mj-sc-desc').textContent = s.desc || '';

			card.querySelector('[data-apply]').addEventListener('click', () => applyScene(s.id));
			const delBtn = card.querySelector('[data-del]');
			if (delBtn) delBtn.addEventListener('click', () => deleteScene(s.id));
			grid.appendChild(card);
		});
	}

	function fetchCurrentConfig() {
		return apiFetch('/api/v1/config.json', { credentials: 'same-origin', cache: 'no-store' })
			.then(r => r.ok ? r.json() : null)
			.then(cfg => {
				if (!cfg) return null;
				return {
					exposure: cfg.isp && typeof cfg.isp.exposure === 'number' ? cfg.isp.exposure : null,
					luminance: cfg.image && typeof cfg.image.luminance === 'number' ? cfg.image.luminance : null,
					contrast: cfg.image && typeof cfg.image.contrast === 'number' ? cfg.image.contrast : null
				};
			})
			.catch(() => null);
	}

	function applyDaemonScene(s) {
		if (!s) return Promise.resolve();
		const payload = JSON.stringify({
			isp: { exposure: Number(s.exposure) },
			image: { luminance: Number(s.luminance), contrast: Number(s.contrast) }
		});
		const headers = { 'Content-Type': 'application/json' };
		return Promise.all([
			apiFetch('/api/v1/image?luminance=' + encodeURIComponent(s.luminance) + '&contrast=' + encodeURIComponent(s.contrast), {
				method: 'POST', credentials: 'same-origin'
			}).catch(() => {}),
			apiFetch('/api/v1/live', { method: 'POST', credentials: 'same-origin', headers, body: payload }).catch(() => {}),
			apiFetch('/api/v1/config', { method: 'POST', credentials: 'same-origin', headers, body: payload }).catch(() => {})
		]).then(() => {
			if (s.run_af) {
				setTimeout(() => {
					apiFetch('/cgi-bin/j/ptz.cgi?act=af', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
				}, 2000);
			}
		});
	}

	function loadScenes(syncInputs) {
		return Promise.all([
			apiFetch('/cgi-bin/j/scene_presets.cgi', { credentials: 'same-origin', cache: 'no-store' })
				.then(r => r.ok ? r.json() : null),
			fetchCurrentConfig()
		])
			.then(([d, cur]) => {
				if (!d || !d.ok) return;
				if (cur) d.current = cur;
				stateData = d;
				if (syncInputs && d.current) {
					if (d.current.exposure != null) modal.querySelector('[data-sc="exp"]').value = String(d.current.exposure);
					if (d.current.luminance != null) modal.querySelector('[data-sc="lum"]').value = String(d.current.luminance);
					if (d.current.contrast != null) modal.querySelector('[data-sc="con"]').value = String(d.current.contrast);
				}
				if (!modal.hidden) renderModal();
			})
			.catch(() => {});
	}

	function applyScene(id) {
		if (busy) return;
		busy = true;
		const target = stateData && Array.isArray(stateData.scenes)
			? stateData.scenes.find(x => x.id === id)
			: null;
		Promise.all([
			applyDaemonScene(target),
			apiFetch('/cgi-bin/j/scene_presets.cgi?act=apply&id=' + encodeURIComponent(id), {
				method: 'POST',
				credentials: 'same-origin'
			}).then(r => r.ok ? r.json() : null)
		])
			.then(([, d]) => {
				if (d && d.ok) {
					if (target) d.current = { exposure: target.exposure, luminance: target.luminance, contrast: target.contrast };
					stateData = d;
					renderModal();
				}
			})
			.catch(() => {})
			.finally(() => { busy = false; });
	}

	function saveCustomScene() {
		if (busy) return;
		const nameEl = modal.querySelector('[data-sc="name"]');
		const name = nameEl.value.trim() || 'Custom Scene';
		const exp = modal.querySelector('[data-sc="exp"]').value;
		const lum = modal.querySelector('[data-sc="lum"]').value;
		const con = modal.querySelector('[data-sc="con"]').value;
		const irc = modal.querySelector('[data-sc="irc"]').value;
		const af = modal.querySelector('[data-sc="af"]').checked ? '1' : '0';
		busy = true;
		const customObj = { exposure: Number(exp), luminance: Number(lum), contrast: Number(con), run_af: af === '1' };
		const q = [
			'act=save',
			'name=' + encodeURIComponent(name),
			'exposure=' + encodeURIComponent(exp),
			'luminance=' + encodeURIComponent(lum),
			'contrast=' + encodeURIComponent(con),
			'ircut=' + encodeURIComponent(irc),
			'run_af=' + af
		].join('&');
		Promise.all([
			applyDaemonScene(customObj),
			apiFetch('/cgi-bin/j/scene_presets.cgi?' + q, { method: 'POST', credentials: 'same-origin' })
				.then(r => r.ok ? r.json() : null)
		])
			.then(([, d]) => {
				if (d && d.ok) {
					d.current = { exposure: customObj.exposure, luminance: customObj.luminance, contrast: customObj.contrast };
					stateData = d;
					nameEl.value = '';
					renderModal();
				}
			})
			.catch(() => {})
			.finally(() => { busy = false; });
	}

	function deleteScene(id) {
		if (busy) return;
		busy = true;
		apiFetch('/cgi-bin/j/scene_presets.cgi?act=delete&id=' + encodeURIComponent(id), {
			method: 'POST',
			credentials: 'same-origin'
		})
			.then(r => r.ok ? r.json() : null)
			.then(d => {
				if (d && d.ok) {
					stateData = d;
					renderModal();
				}
			})
			.catch(() => {})
			.finally(() => { busy = false; });
	}

	scBtn.addEventListener('click', e => {
		e.preventDefault();
		modal.hidden = false;
		renderModal();
		loadScenes(true);
	});
	modal.querySelector('[data-sc="close"]').addEventListener('click', () => { modal.hidden = true; });
	modal.querySelector('[data-sc="save"]').addEventListener('click', saveCustomScene);
	modal.addEventListener('click', e => { if (e.target === modal) modal.hidden = true; });

	loadScenes(false);
})();
