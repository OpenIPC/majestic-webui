/**
 * Named PTZ & Focus Presets Modal for Live Preview
 * Attaches to #mj-ptz-fn (1 column alongside Scenes) and saves/recalls
 * named positions (e.g. "Gate", "Fence", "Lamp", "Window") with persistent
 * Pan/Tilt coordinates (/etc/ptz_pos.conf) + optical zoom + autofocus.
 */
(function () {
	const fn = typeof $ === 'function' ? $('#mj-ptz-fn') : document.getElementById('mj-ptz-fn');
	const stage = typeof $ === 'function' ? $('#mj-stage') : document.getElementById('mj-stage');
	if (!fn || !stage || typeof apiFetch !== 'function') return;

	const style = document.createElement('style');
	style.textContent = [
		'.mj-pr-modal{position:fixed;inset:0;z-index:1060;background:rgba(8,10,14,.78);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:12px;color:#e9ecef;font-family:inherit}',
		'.mj-pr-modal[hidden]{display:none}',
		'.mj-pr-box{width:min(700px,100%);max-height:88vh;display:flex;flex-direction:column;background:rgba(18,21,28,.96);border:1px solid rgba(255,255,255,.14);border-radius:10px;box-shadow:0 20px 50px rgba(0,0,0,.6);overflow:hidden}',
		'.mj-pr-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.1)}',
		'.mj-pr-title{margin:0;font-size:1rem;font-weight:600;color:#fff}',
		'.mj-pr-sub{font-size:.78rem;color:#adb5bd;margin-top:2px}',
		'.mj-pr-body{padding:14px 16px;overflow-y:auto;display:flex;flex-direction:column;gap:12px}',
		'.mj-pr-posbar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;background:rgba(13,110,253,.12);border:1px solid rgba(13,110,253,.3);border-radius:8px;padding:8px 12px;font-size:.78rem;color:#cfe2ff}',
		'.mj-pr-form{display:grid;grid-template-columns:82px 1fr auto;gap:8px;align-items:center;background:rgba(255,255,255,.04);padding:10px 12px;border-radius:8px;border:1px solid rgba(255,255,255,.1)}',
		'.mj-pr-opts{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:14px;font-size:.78rem;color:#ced4da}',
		'.mj-pr-input,.mj-pr-select{background:rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.2);color:#fff;border-radius:6px;padding:6px 9px;font-size:.82rem}',
		'.mj-pr-btn{border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);color:#fff;border-radius:6px;padding:6px 11px;font-size:.78rem;font-weight:600;cursor:pointer}',
		'.mj-pr-btn:hover{background:rgba(255,255,255,.16)}',
		'.mj-pr-btn.primary{background:#0d6efd;border-color:#0d6efd}',
		'.mj-pr-btn.active{background:rgba(25,135,84,.28);border-color:rgba(25,135,84,.7);color:#a3cfbb}',
		'.mj-pr-btn.danger{background:rgba(220,53,69,.2);border-color:rgba(220,53,69,.45);color:#ff8787}',
		'.mj-pr-tourbar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:7px 12px;font-size:.78rem;color:#ced4da}',
		'.mj-pr-tourbar-ctrl{display:flex;align-items:center;gap:6px}',
		'.mj-pr-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(195px,1fr));gap:10px}',
		'.mj-pr-card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}',
		'.mj-pr-card-top{display:flex;justify-content:space-between;align-items:center;gap:6px}',
		'.mj-pr-name{font-weight:600;font-size:.88rem;color:#fff}',
		'.mj-pr-meta{font-size:.73rem;color:#adb5bd;line-height:1.35}',
		'.mj-pr-card-actions{display:flex;flex-wrap:wrap;gap:5px}',
		'.mj-pr-card-actions .mj-pr-btn{padding:5px 8px;font-size:.74rem}',
		'.mj-pr-card-actions .mj-pr-btn[data-go]{flex:1 1 100%}',
		'.mj-pr-empty{font-size:.82rem;color:#adb5bd;text-align:center;padding:18px 8px;grid-column:1/-1}'
	].join('');
	document.head.appendChild(style);

	const prBtn = document.createElement('button');
	prBtn.type = 'button';
	prBtn.className = 'mj-ptz-fnbtn';
	prBtn.setAttribute('aria-label', 'Saved PTZ and focus presets');
	prBtn.title = 'Save & recall named PTZ + zoom + focus presets (Gate, Fence, etc.)';
	prBtn.innerHTML =
		'<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
		'<path d="M5 3.5h10a1 1 0 0 1 1 1v12l-6-3.5-6 3.5v-12a1 1 0 0 1 1-1z"></path>' +
		'</svg><span>Presets</span>';
	fn.appendChild(prBtn);

	const modal = document.createElement('div');
	modal.className = 'mj-pr-modal';
	modal.hidden = true;

	let slotOptions = '';
	for (let i = 1; i <= 32; i++) {
		slotOptions += '<option value="' + i + '">Slot #' + i + '</option>';
	}

	modal.innerHTML =
		'<div class="mj-pr-box" role="dialog" aria-modal="true" aria-label="PTZ & Focus Presets">' +
		'  <div class="mj-pr-head">' +
		'    <div>' +
		'      <div class="mj-pr-title">PTZ &amp; Focus Presets</div>' +
		'      <div class="mj-pr-sub" data-pr="sub">Save and recall named camera views (Pan/Tilt + Optical Zoom + Autofocus)</div>' +
		'    </div>' +
		'    <button type="button" class="mj-pr-btn" data-pr="close">Close</button>' +
		'  </div>' +
		'  <div class="mj-pr-body">' +
		'    <div class="mj-pr-posbar">' +
		'      <span data-pr="poslabel">Tracked Position (saved in /etc across reboots): <strong>Pan 0 · Tilt 0 · Zoom 1.0×</strong></span>' +
		'      <button type="button" class="mj-pr-btn" data-pr="zero" title="Set current camera direction as Pan=0, Tilt=0 reference origin">Set Current as Origin (0,0)</button>' +
		'    </div>' +
		'    <div class="mj-pr-tourbar">' +
		'      <span data-pr="tourstatus">Preset Tour / Patrol: idle (stops automatically on manual PTZ move)</span>' +
		'      <div class="mj-pr-tourbar-ctrl">' +
		'        <label style="display:flex;align-items:center;gap:4px">Dwell <select class="mj-pr-select" data-pr="dwell" style="padding:3px 6px">' +
		'          <option value="5">5s</option><option value="10" selected>10s</option><option value="15">15s</option><option value="30">30s</option><option value="60">60s</option>' +
		'        </select></label>' +
		'        <button type="button" class="mj-pr-btn" data-pr="tour">Start Tour</button>' +
		'      </div>' +
		'    </div>' +
		'    <div class="mj-pr-form">' +
		'      <select class="mj-pr-select" data-pr="slot">' + slotOptions + '</select>' +
		'      <input type="text" class="mj-pr-input" data-pr="name" maxlength="28" placeholder="Preset name (e.g. Gate, Fence, Lamp)">' +
		'      <button type="button" class="mj-pr-btn primary" data-pr="save">Save Current View</button>' +
		'      <div class="mj-pr-opts">' +
		'        <label><input type="checkbox" data-pr="zoom" checked> Restore optical zoom (<span data-pr="curmag">1.0×</span>)</label>' +
		'        <label><input type="checkbox" data-pr="af"> Autofocus on arrival</label>' +
		'      </div>' +
		'    </div>' +
		'    <div class="mj-pr-list" data-pr="list"></div>' +
		'  </div>' +
		'</div>';
	document.body.appendChild(modal);

	['pointerdown', 'pointerup', 'click', 'dblclick', 'keydown'].forEach(ev => {
		prBtn.addEventListener(ev, e => e.stopPropagation());
		modal.addEventListener(ev, e => e.stopPropagation());
	});

	let presets = [];
	let bootHomeId = null;
	let currentMag = 1.0;
	let currentPan = 0;
	let currentTilt = 0;
	let currentFocus = 0;
	let busy = false;
	let tourTimer = 0;
	let tourIdx = 0;
	let tourActive = false;

	function updateBtnCount() {
		const span = prBtn.querySelector('span');
		if (span) {
			if (tourActive && presets.length > 0) {
				span.textContent = 'Tour ' + ((tourIdx % presets.length) + 1) + '/' + presets.length;
			} else {
				span.textContent = presets.length > 0 ? 'Presets (' + presets.length + ')' : 'Presets';
			}
		}
		prBtn.classList.toggle('active', tourActive);
	}

	function fmtAxis(prefix, ms) {
		if (typeof ms !== 'number' || Number.isNaN(ms) || ms === 0) return prefix + ' 0';
		const dir = prefix === 'Pan' ? (ms > 0 ? 'R' : 'L')
			: prefix === 'Tilt' ? (ms > 0 ? 'U' : 'D')
			: (ms > 0 ? 'F' : 'N');
		return prefix + ' ' + dir + Math.abs(ms) + 'ms';
	}

	function nextFreeSlot() {
		const used = new Set(presets.map(p => Number(p.id)));
		for (let i = 1; i <= 32; i++) {
			if (!used.has(i)) return i;
		}
		return 1;
	}

	function renderList(msg) {
		const list = modal.querySelector('[data-pr="list"]');
		const magSpan = modal.querySelector('[data-pr="curmag"]');
		const posLabel = modal.querySelector('[data-pr="poslabel"]');
		const subEl = modal.querySelector('[data-pr="sub"]');
		const magStr = (typeof currentMag === 'number' && Number.isFinite(currentMag) && currentMag >= 1.0)
			? currentMag.toFixed(1) + '×'
			: '—';
		if (magSpan) magSpan.textContent = magStr;
		if (posLabel) {
			posLabel.innerHTML = 'Tracked Position: <strong>' +
				fmtAxis('Pan', currentPan) + ' · ' + fmtAxis('Tilt', currentTilt) + ' · ' + fmtAxis('Focus', currentFocus) + ' · Zoom ' + magStr + '</strong>';
		}
		if (subEl && msg) subEl.textContent = msg;
		list.innerHTML = '';

		if (!presets.length) {
			const empty = document.createElement('div');
			empty.className = 'mj-pr-empty';
			empty.textContent = 'No presets saved yet. Aim the camera, enter a name like "Gate" or "Fence" above, and click Save Current View.';
			list.appendChild(empty);
			return;
		}

		presets.forEach(p => {
			const card = document.createElement('div');
			card.className = 'mj-pr-card';
			const isBoot = bootHomeId !== null && Number(p.id) === Number(bootHomeId);
			const badges = [];
			if (isBoot) badges.push('Boot Home ★');
			if (p.zoom_restore && typeof p.mag === 'number' && Number.isFinite(p.mag)) badges.push('Zoom ' + p.mag.toFixed(1) + '×');
			if (p.run_af) badges.push('Auto-AF');
			const ptText = fmtAxis('Pan', p.pan_ms) + ' · ' + fmtAxis('Tilt', p.tilt_ms) +
				(typeof p.focus_ms === 'number' ? ' · ' + fmtAxis('Focus', p.focus_ms) : '');

			card.innerHTML =
				'<div class="mj-pr-card-top">' +
				'  <span class="mj-pr-name"></span>' +
				'  <span class="mj-pr-meta">#' + p.id + '</span>' +
				'</div>' +
				'<div class="mj-pr-meta">' + ptText + '<br>' + (badges.join(' · ') || 'Pan/Tilt only') + '</div>' +
				'<div class="mj-pr-card-actions">' +
				'  <button type="button" class="mj-pr-btn primary" data-go="' + p.id + '">Go to View</button>' +
				'  <button type="button" class="mj-pr-btn' + (isBoot ? ' active' : '') + '" data-boot="' + p.id + '" title="Recall this preset automatically when motorsd boots">' + (isBoot ? 'Home ★' : 'Boot') + '</button>' +
				'  <button type="button" class="mj-pr-btn" data-af="' + p.id + '" title="Toggle Autofocus on arrival">' + (p.run_af ? 'AF: On' : 'AF: Off') + '</button>' +
				'  <button type="button" class="mj-pr-btn" data-upd="' + p.id + '" title="Update this preset with current camera Pan/Tilt/Focus/Zoom">Set Here</button>' +
				'  <button type="button" class="mj-pr-btn danger" data-del="' + p.id + '" title="Delete preset">✕</button>' +
				'</div>';
			card.querySelector('.mj-pr-name').textContent = p.name;

			card.querySelector('[data-go]').addEventListener('click', () => {
				stopTour();
				callPreset(p);
			});
			card.querySelector('[data-boot]').addEventListener('click', () => {
				setBootHome(p.id);
			});
			card.querySelector('[data-af]').addEventListener('click', () => {
				togglePresetAf(p.id);
			});
			card.querySelector('[data-upd]').addEventListener('click', () => {
				updatePresetHere(p);
			});
			card.querySelector('[data-del]').addEventListener('click', () => {
				deletePreset(p.id);
			});
			list.appendChild(card);
		});
	}

	function applyData(d, pickNextSlot) {
		if (!d || !d.ok) return;
		presets = Array.isArray(d.presets) ? d.presets : [];
		bootHomeId = (typeof d.boot_home === 'number' && Number.isFinite(d.boot_home)) ? d.boot_home : null;
		if (typeof d.current_mag === 'number') currentMag = d.current_mag;
		if (typeof d.pan_ms === 'number') currentPan = d.pan_ms;
		if (typeof d.tilt_ms === 'number') currentTilt = d.tilt_ms;
		if (typeof d.focus_ms === 'number') currentFocus = d.focus_ms;
		updateBtnCount();
		if (pickNextSlot) {
			modal.querySelector('[data-pr="slot"]').value = String(nextFreeSlot());
		}
		if (!modal.hidden) renderList(d.message);
	}

	function loadPresets(pickNextSlot) {
		return apiFetch('/cgi-bin/j/ptz_presets.cgi?act=list', { credentials: 'same-origin', cache: 'no-store' })
			.then(r => r.ok ? r.json() : null)
			.then(d => applyData(d, pickNextSlot))
			.catch(() => {});
	}

	function savePreset() {
		if (busy) return;
		const slot = modal.querySelector('[data-pr="slot"]').value;
		const nameInput = modal.querySelector('[data-pr="name"]');
		const name = nameInput.value.trim() || ('Preset ' + slot);
		const zr = modal.querySelector('[data-pr="zoom"]').checked ? '1' : '0';
		const af = modal.querySelector('[data-pr="af"]').checked ? '1' : '0';
		busy = true;
		const q = 'act=save&id=' + encodeURIComponent(slot) +
			'&name=' + encodeURIComponent(name) +
			'&zoom_restore=' + zr + '&run_af=' + af;
		apiFetch('/cgi-bin/j/ptz_presets.cgi?' + q, { method: 'POST', credentials: 'same-origin' })
			.then(r => r.ok ? r.json() : null)
			.then(d => {
				nameInput.value = '';
				applyData(d, true);
			})
			.catch(() => {})
			.finally(() => { busy = false; });
	}

	function updatePresetHere(p) {
		if (busy) return;
		busy = true;
		const q = 'act=save&id=' + encodeURIComponent(p.id) +
			'&name=' + encodeURIComponent(p.name) +
			'&zoom_restore=' + (p.zoom_restore ? '1' : '0') +
			'&run_af=' + (p.run_af ? '1' : '0');
		apiFetch('/cgi-bin/j/ptz_presets.cgi?' + q, { method: 'POST', credentials: 'same-origin' })
			.then(r => r.ok ? r.json() : null)
			.then(d => applyData(d, false))
			.catch(() => {})
			.finally(() => { busy = false; });
	}

	function callPreset(p, onDone) {
		if (busy) {
			if (onDone) onDone();
			return;
		}
		busy = true;
		modal.hidden = true;
		if (p.run_af) {
			document.dispatchEvent(new CustomEvent('mj-ptz-move', { detail: { durationMs: 14000 } }));
		}
		apiFetch('/cgi-bin/j/ptz_presets.cgi?act=goto&id=' + encodeURIComponent(p.id), {
			method: 'POST',
			credentials: 'same-origin'
		})
			.then(r => r.ok ? r.json() : null)
			.then(d => {
				applyData(d, false);
				if (d && d.ok && p.run_af) {
					apiFetch('/autofocus', { credentials: 'same-origin' }).catch(() => {});
				}
			})
			.catch(() => {})
			.finally(() => {
				busy = false;
				if (onDone) onDone();
			});
	}

	function deletePreset(id) {
		if (busy) return;
		busy = true;
		apiFetch('/cgi-bin/j/ptz_presets.cgi?act=delete&id=' + encodeURIComponent(id), {
			method: 'POST',
			credentials: 'same-origin'
		})
			.then(r => r.ok ? r.json() : null)
			.then(d => applyData(d, true))
			.catch(() => {})
			.finally(() => { busy = false; });
	}

	function togglePresetAf(id) {
		if (busy) return;
		busy = true;
		apiFetch('/cgi-bin/j/ptz_presets.cgi?act=toggle_af&id=' + encodeURIComponent(id), {
			method: 'POST',
			credentials: 'same-origin'
		})
			.then(r => r.ok ? r.json() : null)
			.then(d => applyData(d, false))
			.catch(() => {})
			.finally(() => { busy = false; });
	}

	function setBootHome(id) {
		if (busy) return;
		busy = true;
		apiFetch('/cgi-bin/j/ptz_presets.cgi?act=set_boot_home&id=' + encodeURIComponent(id), { method: 'POST', credentials: 'same-origin' })
			.then(r => r.ok ? r.json() : null)
			.then(d => applyData(d, false))
			.catch(() => {})
			.finally(() => { busy = false; });
	}

	function updateTourUi(statusText) {
		const tourBtn = modal.querySelector('[data-pr="tour"]');
		const tourStatus = modal.querySelector('[data-pr="tourstatus"]');
		if (tourBtn) {
			tourBtn.textContent = tourActive ? 'Stop Tour' : 'Start Tour';
			tourBtn.classList.toggle('active', tourActive);
		}
		if (tourStatus) {
			tourStatus.textContent = statusText || (tourActive
				? 'Touring presets (' + presets.length + ' total)...'
				: 'Preset Tour / Patrol: idle (stops automatically on manual PTZ move)');
		}
		updateBtnCount();
	}

	function stopTour(reason) {
		if (tourTimer) {
			clearTimeout(tourTimer);
			tourTimer = 0;
		}
		if (!tourActive && !reason) return;
		tourActive = false;
		updateTourUi(reason || 'Preset Tour / Patrol: idle (stops automatically on manual PTZ move)');
	}

	function scheduleNextTourStep() {
		if (!tourActive || !presets.length) {
			stopTour();
			return;
		}
		const dwellEl = modal.querySelector('[data-pr="dwell"]');
		const dwellSec = Math.max(3, parseInt(dwellEl ? dwellEl.value : '10', 10) || 10);
		tourTimer = setTimeout(() => {
			if (!tourActive || !presets.length) {
				stopTour();
				return;
			}
			tourIdx = (tourIdx + 1) % presets.length;
			const p = presets[tourIdx];
			updateTourUi('Touring: #' + p.id + ' ' + p.name + ' (' + (tourIdx + 1) + '/' + presets.length + ')');
			callPreset(p, scheduleNextTourStep);
		}, dwellSec * 1000);
	}

	function startTour() {
		if (!presets.length) {
			updateTourUi('Save at least one preset before starting a tour.');
			return;
		}
		stopTour();
		tourActive = true;
		tourIdx = 0;
		const p = presets[0];
		updateTourUi('Touring: #' + p.id + ' ' + p.name + ' (1/' + presets.length + ')');
		callPreset(p, scheduleNextTourStep);
	}

	const dwellSelect = modal.querySelector('[data-pr="dwell"]');
	if (dwellSelect) {
		try {
			const savedDwell = localStorage.getItem('openipc.ptz.tourDwellSec');
			if (savedDwell && dwellSelect.querySelector('option[value="' + savedDwell + '"]')) {
				dwellSelect.value = savedDwell;
			}
		} catch (e) {}
		dwellSelect.addEventListener('change', () => {
			try { localStorage.setItem('openipc.ptz.tourDwellSec', dwellSelect.value); } catch (e) {}
		});
	}
	const tourBtn = modal.querySelector('[data-pr="tour"]');
	if (tourBtn) {
		tourBtn.addEventListener('click', () => {
			if (tourActive) stopTour();
			else startTour();
		});
	}
	window.addEventListener('mj:ptz-moved', () => {
		if (tourActive) stopTour('Tour stopped (manual PTZ move)');
	});

	prBtn.addEventListener('click', e => {
		e.preventDefault();
		modal.hidden = false;
		renderList();
		loadPresets(true);
	});
	modal.querySelector('[data-pr="close"]').addEventListener('click', () => { modal.hidden = true; });
	modal.querySelector('[data-pr="save"]').addEventListener('click', savePreset);
	modal.querySelector('[data-pr="zero"]').addEventListener('click', () => {
		apiFetch('/cgi-bin/j/ptz_presets.cgi?act=zero', { method: 'POST', credentials: 'same-origin' })
			.then(r => r.ok ? r.json() : null)
			.then(d => applyData(d, false))
			.catch(() => {});
	});
	modal.querySelector('[data-pr="name"]').addEventListener('keydown', e => {
		if (e.key === 'Enter') { e.preventDefault(); savePreset(); }
	});
	modal.addEventListener('click', e => { if (e.target === modal) modal.hidden = true; });

	loadPresets(true);
})();
