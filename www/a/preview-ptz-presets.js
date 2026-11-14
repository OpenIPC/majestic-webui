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
	const ptzControl = fn.dataset.ptzControl || '';
	if (ptzControl !== 'motorsd' && ptzControl !== 'anjoy') return;

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
		'.mj-pr-card-top{display:flex;justify-content:space-between;align-items:flex-start;gap:6px}',
		'.mj-pr-icon-btn{width:22px;height:22px;padding:0;display:inline-flex;align-items:center;justify-content:center;border-radius:5px;flex-shrink:0}',
		'.mj-pr-icon-btn:disabled{opacity:.3;cursor:default;pointer-events:none}',
		'.mj-pr-name{font-weight:600;font-size:.88rem;color:#fff;line-height:22px}',
		'.mj-pr-meta{font-size:.73rem;color:#adb5bd;line-height:1.35}',
		'.mj-pr-card-actions{display:flex;flex-wrap:wrap;gap:4px;align-items:center}',
		'.mj-pr-card-actions .mj-pr-btn{padding:4px 6px;font-size:.71rem;line-height:1.2;white-space:nowrap}',
		'.mj-pr-card-actions .mj-pr-btn[data-go]{flex:1 1 auto;text-align:center}',
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

	const ICON_UP = '<svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 7.5L6 4l3.5 3.5"/></svg>';
	const ICON_DOWN = '<svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.5L6 8l3.5-3.5"/></svg>';
	const ICON_LEFT = '<svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 2.5L4 6l3.5 3.5"/></svg>';
	const ICON_RIGHT = '<svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 2.5L8 6l-3.5 3.5"/></svg>';
	const ICON_MINUS = '<svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 6h6"/></svg>';
	const ICON_PLUS = '<svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 3v6M3 6h6"/></svg>';
	const ICON_RESET = '<svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6a3.5 3.5 0 1 1 1 2.5M2.5 3.5v2.5H5"/></svg>';

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
		'    <div class="mj-pr-posbar" style="align-items:stretch;gap:12px">' +
		'      <div style="display:flex;flex-direction:column;gap:4px;width:196px;flex-shrink:0">' +
		'        <div data-pr="map" style="position:relative;width:100%;height:108px;background:rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.18);border-radius:6px;overflow:hidden;cursor:grab" title="Drag empty space to move preset dots over background. Click any preset dot to move there & select it."></div>' +
		'        <div style="display:flex;align-items:center;justify-content:space-between;gap:3px">' +
		'          <button type="button" class="mj-pr-btn" data-pr="popmap" style="height:22px;padding:0 6px;font-size:.67rem;flex:1;display:inline-flex;align-items:center;justify-content:center" title="Pop out a large floating map over the live camera view">⤢ Pop Out Map</button>' +
		'          <button type="button" class="mj-pr-btn mj-pr-icon-btn" data-mv="zoomout" title="Shrink preset dot spread on map">' + ICON_MINUS + '</button>' +
		'          <button type="button" class="mj-pr-btn mj-pr-icon-btn" data-mv="zoomin" title="Expand preset dot spread on map">' + ICON_PLUS + '</button>' +
		'          <button type="button" class="mj-pr-btn mj-pr-icon-btn" data-mv="reset" title="Reset map visual offset & scale">' + ICON_RESET + '</button>' +
		'        </div>' +
		'      </div>' +
		'      <div style="flex:1;min-width:230px;display:flex;flex-direction:column;justify-content:space-between;gap:5px">' +
		'        <div data-pr="homelabel" style="line-height:1.3"></div>' +
		'        <div data-pr="poslabel" style="line-height:1.3">Current Camera View: <strong>Pan 0 · Tilt 0 · Zoom 1.0×</strong></div>' +
		'        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:5px">' +
		'          <select class="mj-pr-select" data-pr="refpreset" style="padding:3px 6px;font-size:.74rem;max-width:150px" title="Select a preset (or click its dot on the map)"></select>' +
		'          <button type="button" class="mj-pr-btn primary" data-pr="goref" style="padding:4px 8px;font-size:.73rem" title="Move camera to the selected preset">Go to</button>' +
		'          <button type="button" class="mj-pr-btn active" data-pr="makerefhome" style="padding:4px 8px;font-size:.73rem" title="Set the selected preset as your ★ Home preset">★ Make Home</button>' +
		'          <button type="button" class="mj-pr-btn" data-pr="syncref" style="padding:4px 8px;font-size:.73rem;border-color:#0dcaf0;color:#9eeaf9" title="If camera drifted: point camera at the selected preset landmark, then click this to align all presets to it">Calibrate to Preset</button>' +
		'        </div>' +
		'        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:5px;padding-top:2px;border-top:1px solid rgba(255,255,255,.08)">' +
		'          <input type="text" class="mj-pr-input" data-pr="homename" maxlength="28" placeholder="Home title" style="width:96px;padding:3px 7px;font-size:.73rem">' +
		'          <button type="button" class="mj-pr-btn" data-pr="sethome" style="padding:3px 8px;font-size:.72rem" title="Save current camera view as the ★ Home preset">Save View as Home</button>' +
		'          <button type="button" class="mj-pr-btn" data-pr="capbg" style="padding:3px 8px;font-size:.72rem" title="Take a snapshot of the current camera view right where you placed it and use it as the map background">📷 Snap BG</button>' +
		'          <button type="button" class="mj-pr-btn" data-pr="zero" style="padding:3px 7px;font-size:.71rem;opacity:.8" title="Set current view as (0,0) and shift all saved presets by the same offset">Zero (0,0)</button>' +
		'        </div>' +
		'        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding-top:2px;border-top:1px solid rgba(255,255,255,.08);font-size:.72rem">' +
		'          <span style="opacity:.85">Shift All Presets:</span>' +
		'          <select class="mj-pr-select" data-pr="shiftstep" style="height:22px;padding:0 5px;font-size:.71rem">' +
		'            <option value="200">200ms</option><option value="500" selected>500ms</option><option value="1000">1000ms</option><option value="2000">2000ms</option>' +
		'          </select>' +
		'          <button type="button" class="mj-pr-btn mj-pr-icon-btn" data-shift="-1,0" title="Shift all saved presets Left">' + ICON_LEFT + '</button>' +
		'          <button type="button" class="mj-pr-btn mj-pr-icon-btn" data-shift="0,1" title="Shift all saved presets Up">' + ICON_UP + '</button>' +
		'          <button type="button" class="mj-pr-btn mj-pr-icon-btn" data-shift="0,-1" title="Shift all saved presets Down">' + ICON_DOWN + '</button>' +
		'          <button type="button" class="mj-pr-btn mj-pr-icon-btn" data-shift="1,0" title="Shift all saved presets Right">' + ICON_RIGHT + '</button>' +
		'        </div>' +
		'      </div>' +
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

	const popMap = document.createElement('div');
	popMap.hidden = true;
	popMap.style.cssText = 'position:fixed;bottom:16px;left:16px;z-index:1055;width:min(460px,95vw);background:rgba(16,19,26,.94);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.22);border-radius:10px;box-shadow:0 16px 40px rgba(0,0,0,.65);color:#e9ecef;font-family:inherit;overflow:hidden';
	popMap.innerHTML =
		'<div data-pm="hdr" style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 11px;background:rgba(255,255,255,.05);border-bottom:1px solid rgba(255,255,255,.1);cursor:move;user-select:none">' +
		'  <span style="font-size:.8rem;font-weight:600;color:#fff">Preset Map <span data-pm="status" style="font-weight:400;font-size:.72rem;color:#adb5bd;margin-left:4px"></span></span>' +
		'  <span style="display:inline-flex;gap:4px">' +
		'    <button type="button" class="mj-pr-btn" data-pm="capbg" style="padding:2px 7px;font-size:.7rem" title="Take a snapshot of the current camera view right where you placed it and use it as the map background">📷 Snap BG</button>' +
		'    <button type="button" class="mj-pr-btn" data-pm="modal" style="padding:2px 7px;font-size:.7rem" title="Return to full Presets modal">⤡ Presets List</button>' +
		'    <button type="button" class="mj-pr-btn" data-pm="close" style="padding:2px 7px;font-size:.7rem" title="Close floating map">✕</button>' +
		'  </span>' +
		'</div>' +
		'<div data-pm="canvas" style="position:relative;width:100%;height:265px;background:rgba(0,0,0,.55);cursor:grab" title="Drag empty space to move preset dots over background. Scroll wheel or use −/+ to scale."></div>' +
		'<div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:5px;padding:6px 10px;border-top:1px solid rgba(255,255,255,.1);font-size:.72rem">' +
		'  <span style="display:inline-flex;align-items:center;gap:3px">' +
		'    <span style="opacity:.8;margin-right:2px">Map:</span>' +
		'    <button type="button" class="mj-pr-btn mj-pr-icon-btn" data-mv="left" title="Move preset dots left on map">' + ICON_LEFT + '</button>' +
		'    <button type="button" class="mj-pr-btn mj-pr-icon-btn" data-mv="up" title="Move preset dots up on map">' + ICON_UP + '</button>' +
		'    <button type="button" class="mj-pr-btn mj-pr-icon-btn" data-mv="down" title="Move preset dots down on map">' + ICON_DOWN + '</button>' +
		'    <button type="button" class="mj-pr-btn mj-pr-icon-btn" data-mv="right" title="Move preset dots right on map">' + ICON_RIGHT + '</button>' +
		'    <button type="button" class="mj-pr-btn mj-pr-icon-btn" data-mv="zoomout" title="Shrink preset dot spread">' + ICON_MINUS + '</button>' +
		'    <button type="button" class="mj-pr-btn mj-pr-icon-btn" data-mv="zoomin" title="Expand preset dot spread">' + ICON_PLUS + '</button>' +
		'    <button type="button" class="mj-pr-btn mj-pr-icon-btn" data-mv="reset" title="Reset map visual position & scale">' + ICON_RESET + '</button>' +
		'  </span>' +
		'  <span style="display:inline-flex;align-items:center;gap:3px">' +
		'    <span style="opacity:.8;margin-right:2px">Shift All:</span>' +
		'    <button type="button" class="mj-pr-btn mj-pr-icon-btn" data-shift="-1,0" title="Shift all presets Left">' + ICON_LEFT + '</button>' +
		'    <button type="button" class="mj-pr-btn mj-pr-icon-btn" data-shift="0,1" title="Shift all presets Up">' + ICON_UP + '</button>' +
		'    <button type="button" class="mj-pr-btn mj-pr-icon-btn" data-shift="0,-1" title="Shift all presets Down">' + ICON_DOWN + '</button>' +
		'    <button type="button" class="mj-pr-btn mj-pr-icon-btn" data-shift="1,0" title="Shift all presets Right">' + ICON_RIGHT + '</button>' +
		'  </span>' +
		'</div>' +
		'<div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:5px;padding:6px 10px;border-top:1px solid rgba(255,255,255,.08);font-size:.73rem">' +
		'  <select class="mj-pr-select" data-pm="ref" style="padding:3px 6px;font-size:.73rem;max-width:145px"></select>' +
		'  <span style="display:inline-flex;gap:4px;flex-wrap:wrap">' +
		'    <button type="button" class="mj-pr-btn primary" data-pm="go" style="padding:3px 8px;font-size:.72rem">Go to</button>' +
		'    <button type="button" class="mj-pr-btn active" data-pm="home" style="padding:3px 8px;font-size:.72rem" title="Set selected preset as ★ Home">★ Make Home</button>' +
		'    <button type="button" class="mj-pr-btn" data-pm="sync" style="padding:3px 8px;font-size:.72rem;border-color:#0dcaf0;color:#9eeaf9" title="If camera drifted: point camera at the selected preset landmark, then click this to align all presets to it">Calibrate Here</button>' +
		'  </span>' +
		'</div>';
	document.body.appendChild(popMap);

	(function makeDraggable() {
		const hdr = popMap.querySelector('[data-pm="hdr"]');
		let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
		hdr.addEventListener('pointerdown', e => {
			if (e.target.closest('button')) return;
			dragging = true;
			const r = popMap.getBoundingClientRect();
			sx = e.clientX; sy = e.clientY;
			ox = r.left; oy = r.top;
			popMap.style.left = ox + 'px';
			popMap.style.top = oy + 'px';
			popMap.style.bottom = 'auto';
			popMap.style.right = 'auto';
			try { hdr.setPointerCapture(e.pointerId); } catch (err) {}
		});
		hdr.addEventListener('pointermove', e => {
			if (!dragging) return;
			const nx = Math.max(4, Math.min(window.innerWidth - 120, ox + (e.clientX - sx)));
			const ny = Math.max(4, Math.min(window.innerHeight - 80, oy + (e.clientY - sy)));
			popMap.style.left = nx + 'px';
			popMap.style.top = ny + 'px';
		});
		hdr.addEventListener('pointerup', () => { dragging = false; });
	})();

	['pointerdown', 'pointerup', 'click', 'dblclick', 'keydown'].forEach(ev => {
		prBtn.addEventListener(ev, e => e.stopPropagation());
		modal.addEventListener(ev, e => e.stopPropagation());
		popMap.addEventListener(ev, e => e.stopPropagation());
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

	let selectedMapPresetId = null;
	let hasMapBg = false;
	let bgPan = null;
	let bgTilt = null;
	let mapBgVer = Date.now();
	let mapView = { xPct: 0, yPct: 0, scale: 1 };
	try {
		const savedMv = JSON.parse(localStorage.getItem('openipc.ptz.mapView') || 'null');
		if (savedMv && typeof savedMv.xPct === 'number' && typeof savedMv.yPct === 'number') {
			mapView.xPct = Math.max(-45, Math.min(45, savedMv.xPct));
			mapView.yPct = Math.max(-45, Math.min(45, savedMv.yPct));
			if (typeof savedMv.scale === 'number' && savedMv.scale >= 0.35 && savedMv.scale <= 2.5) {
				mapView.scale = savedMv.scale;
			}
		}
	} catch (e) {}
	function saveMapView() {
		try { localStorage.setItem('openipc.ptz.mapView', JSON.stringify(mapView)); } catch (e) {}
	}

	function findHomePreset() {
		if (bootHomeId !== null) {
			const b = presets.find(p => Number(p.id) === Number(bootHomeId));
			if (b) return b;
		}
		return presets.find(p => /^home\b/i.test(p.name || '')) || null;
	}

	function populateMapCanvas(targetEl, isLarge, homePreset, magStr) {
		if (!targetEl) return;
		const ptsPan = [];
		const ptsTilt = [];
		presets.forEach(p => {
			if (typeof p.pan_ms === 'number') ptsPan.push(p.pan_ms);
			if (typeof p.tilt_ms === 'number') ptsTilt.push(p.tilt_ms);
		});
		if (!ptsPan.length) {
			ptsPan.push(currentPan || 0, 0);
			ptsTilt.push(currentTilt || 0, 0);
		}
		let minPan = Math.min.apply(null, ptsPan), maxPan = Math.max.apply(null, ptsPan);
		let minTilt = Math.min.apply(null, ptsTilt), maxTilt = Math.max.apply(null, ptsTilt);
		const spanPan = Math.max(3000, maxPan - minPan);
		const spanTilt = Math.max(2000, maxTilt - minTilt);
		minPan -= spanPan * 0.16; maxPan += spanPan * 0.16;
		minTilt -= spanTilt * 0.16; maxTilt += spanTilt * 0.16;
		const sc = mapView.scale || 1;
		const oxPct = mapView.xPct || 0;
		const oyPct = mapView.yPct || 0;
		const toX = pan => {
			const base = ((pan - minPan) / (maxPan - minPan)) * 84 + 8;
			return Math.max(4, Math.min(96, 50 + (base - 50) * sc + oxPct));
		};
		const toY = tilt => {
			const base = (1 - (tilt - minTilt) / (maxTilt - minTilt)) * 80 + 10;
			return Math.max(6, Math.min(94, 50 + (base - 50) * sc + oyPct));
		};

		const ox = toX(0), oy = toY(0);
		if (hasMapBg) {
			targetEl.style.background = 'linear-gradient(rgba(8,10,16,.52),rgba(8,10,16,.52)), url("/cgi-bin/j/ptz_presets.cgi?act=map_bg&v=' + mapBgVer + '") center/cover no-repeat';
		} else {
			targetEl.style.background = isLarge ? 'rgba(0,0,0,.58)' : 'rgba(0,0,0,.52)';
		}
		const W = targetEl.clientWidth || (isLarge ? 460 : 196);
		const H = targetEl.clientHeight || (isLarge ? 265 : 108);

		targetEl.innerHTML =
			'<div style="position:absolute;left:' + ox.toFixed(1) + '%;top:0;bottom:0;width:1px;background:rgba(255,255,255,.1)"></div>' +
			'<div style="position:absolute;top:' + oy.toFixed(1) + '%;left:0;right:0;height:1px;background:rgba(255,255,255,.1)"></div>';

		const svgNS = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(svgNS, 'svg');
		svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
		svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2';
		targetEl.appendChild(svg);

		const markers = [];
		presets.forEach(p => {
			const isHome = homePreset && Number(p.id) === Number(homePreset.id);
			const isSel = Number(p.id) === Number(selectedMapPresetId);
			if (isHome) return;
			const xPct = toX(p.pan_ms), yPct = toY(p.tilt_ms);
			markers.push({
				xPct, yPct,
				dx: (xPct / 100) * W,
				dy: (yPct / 100) * H,
				color: isSel ? '#51cf66' : '#f1f3f5',
				size: isSel ? (isLarge ? 11 : 9) : (isLarge ? 9 : 7),
				label: isLarge ? ('#' + p.id + ' ' + p.name) : (isSel ? ('#' + p.id + ' ' + p.name) : ('#' + p.id)),
				title: 'Click to go to & select: ' + p.name + ' (#' + p.id + ' · ' + fmtAxis('Pan', p.pan_ms) + ' · ' + fmtAxis('Tilt', p.tilt_ms) + ')',
				onClick: () => {
					selectedMapPresetId = Number(p.id);
					stopTour();
					callPreset(p, null, true);
					renderList('Moving to ' + p.name + ' (#' + p.id + ')...');
				},
				zIdx: isSel ? 14 : 11,
				ring: isSel ? 'rgba(81,207,102,.45)' : 'rgba(0,0,0,.5)',
				prio: isSel ? 3 : 1
			});
		});

		if (homePreset) {
			const isSel = Number(homePreset.id) === Number(selectedMapPresetId);
			const xPct = toX(homePreset.pan_ms), yPct = toY(homePreset.tilt_ms);
			markers.push({
				xPct, yPct,
				dx: (xPct / 100) * W,
				dy: (yPct / 100) * H,
				color: '#ffd43b',
				size: isLarge ? 12 : 9,
				label: isLarge ? ('★ ' + homePreset.name) : '★',
				title: 'Home: ' + homePreset.name + ' (#' + homePreset.id + ') — click to go Home & select',
				onClick: () => {
					selectedMapPresetId = Number(homePreset.id);
					stopTour();
					callPreset(homePreset, null, true);
					renderList('Moving to Home ' + homePreset.name + ' (#' + homePreset.id + ')...');
				},
				zIdx: 15,
				ring: isSel ? 'rgba(255,212,59,.5)' : 'rgba(0,0,0,.55)',
				prio: 4
			});
		}

		const nowXPct = toX(currentPan), nowYPct = toY(currentTilt);
		const nowDx = (nowXPct / 100) * W, nowDy = (nowYPct / 100) * H;
		const coincident = markers.find(m => Math.hypot(m.dx - nowDx, m.dy - nowDy) < 4);
		if (coincident) {
			coincident.ring = 'rgba(13,202,240,.85)';
			coincident.label = coincident.label + (isLarge ? ' · ◉' : '');
			coincident.title += ' (Current Camera Position · Zoom ' + magStr + ')';
		} else {
			markers.push({
				xPct: nowXPct, yPct: nowYPct,
				dx: nowDx, dy: nowDy,
				color: '#0dcaf0',
				size: isLarge ? 11 : 9,
				label: '◉ Now',
				title: 'Current Camera Position: ' + fmtAxis('Pan', currentPan) + ' · ' + fmtAxis('Tilt', currentTilt) + ' · Zoom ' + magStr,
				onClick: null,
				zIdx: 16,
				ring: 'rgba(13,202,240,.45)',
				prio: 5
			});
		}

		const placedBoxes = [];
		const order = markers.slice().sort((a, b) => (b.prio - a.prio) || (a.dy - b.dy) || (a.dx - b.dx));
		order.forEach(m => {
			if (!m.label) return;
			const maxChars = isLarge ? 16 : 10;
			const txt = m.label.length > maxChars ? (m.label.slice(0, maxChars - 1) + '…') : m.label;
			m.shortLabel = txt;
			const lh = isLarge ? 16 : 13;
			const lw = Math.min(isLarge ? 114 : 68, Math.round(txt.length * (isLarge ? 5.9 : 5.0)) + (isLarge ? 10 : 7));
			const r = m.size / 2 + 4;
			const cands = [
				[m.dx + r, m.dy - lh / 2],
				[m.dx - r - lw, m.dy - lh / 2],
				[m.dx - lw / 2, m.dy - r - lh],
				[m.dx - lw / 2, m.dy + r],
				[m.dx + r, m.dy - r - lh],
				[m.dx + r, m.dy + r],
				[m.dx - r - lw, m.dy - r - lh],
				[m.dx - r - lw, m.dy + r]
			];
			const stepY = isLarge ? 18 : 14;
			for (let k = 1; k <= 5; k++) {
				const dyOff = k * stepY;
				cands.push(
					[m.dx + r + 4, m.dy - lh / 2 - dyOff],
					[m.dx + r + 4, m.dy - lh / 2 + dyOff],
					[m.dx - r - 4 - lw, m.dy - lh / 2 - dyOff],
					[m.dx - r - 4 - lw, m.dy - lh / 2 + dyOff],
					[m.dx - lw / 2, m.dy - lh / 2 - dyOff - r],
					[m.dx - lw / 2, m.dy - lh / 2 + dyOff + r]
				);
			}
			let best = null, bestScore = Infinity;
			cands.forEach(c => {
				const x1 = Math.max(3, Math.min(W - lw - 3, c[0]));
				const y1 = Math.max(3, Math.min(H - lh - 3, c[1]));
				const x2 = x1 + lw, y2 = y1 + lh;
				let score = Math.hypot((x1 + x2) / 2 - m.dx, (y1 + y2) / 2 - m.dy) * 1.1;
				if (Math.abs(x1 - c[0]) > 2 || Math.abs(y1 - c[1]) > 2) score += 400;
				markers.forEach(other => {
					const dr = other.size / 2 + 2;
					if (x2 > other.dx - dr && x1 < other.dx + dr && y2 > other.dy - dr && y1 < other.dy + dr) {
						score += 25000;
					}
				});
				placedBoxes.forEach(b => {
					const ox = Math.max(0, Math.min(x2 + 2, b.x2 + 2) - Math.max(x1 - 2, b.x1 - 2));
					const oy = Math.max(0, Math.min(y2 + 2, b.y2 + 2) - Math.max(y1 - 2, b.y1 - 2));
					if (ox > 0 && oy > 0) score += 10000 + ox * oy * 25;
				});
				if (score < bestScore) {
					bestScore = score;
					best = { x1, y1, x2, y2, lw, lh };
				}
			});
			m.box = best;
			placedBoxes.push(best);
		});

		markers.forEach(m => {
			const dot = document.createElement('div');
			dot.style.cssText = 'position:absolute;left:' + m.xPct.toFixed(1) + '%;top:' + m.yPct.toFixed(1) + '%;transform:translate(-50%,-50%);width:' + m.size + 'px;height:' + m.size + 'px;border-radius:50%;background:' + m.color + ';border:1.5px solid #0b0e14;box-shadow:0 0 0 2.5px ' + m.ring + ';z-index:' + m.zIdx + (m.onClick ? ';cursor:pointer' : '');
			if (m.title) dot.title = m.title;
			if (m.onClick) dot.addEventListener('click', m.onClick);
			targetEl.appendChild(dot);

			if (m.box && m.shortLabel) {
				const nearX = Math.max(m.box.x1, Math.min(m.box.x2, m.dx));
				const nearY = Math.max(m.box.y1, Math.min(m.box.y2, m.dy));
				if (Math.hypot(nearX - m.dx, nearY - m.dy) > 6) {
					const line = document.createElementNS(svgNS, 'line');
					line.setAttribute('x1', m.dx.toFixed(1));
					line.setAttribute('y1', m.dy.toFixed(1));
					line.setAttribute('x2', nearX.toFixed(1));
					line.setAttribute('y2', nearY.toFixed(1));
					line.setAttribute('stroke', m.color);
					line.setAttribute('stroke-opacity', '0.55');
					line.setAttribute('stroke-width', '1.1');
					svg.appendChild(line);
				}
				const lbl = document.createElement('div');
				lbl.textContent = m.shortLabel;
				if (m.title) lbl.title = m.title;
				lbl.style.cssText = 'position:absolute;left:' + m.box.x1.toFixed(1) + 'px;top:' + m.box.y1.toFixed(1) + 'px;height:' + m.box.lh + 'px;line-height:' + (m.box.lh - 2) + 'px;font-size:' + (isLarge ? '10px' : '8.5px') + ';font-weight:600;color:' + m.color + ';background:rgba(10,13,18,.84);border:1px solid rgba(255,255,255,.16);padding:0 ' + (isLarge ? '4px' : '3px') + ';border-radius:4px;white-space:nowrap;z-index:' + (m.zIdx - 5) + (m.onClick ? ';cursor:pointer' : '');
				if (m.onClick) lbl.addEventListener('click', m.onClick);
				targetEl.appendChild(lbl);
			}
		});
	}

	function renderHomeAndMap(magStr) {
		const homeEl = modal.querySelector('[data-pr="homelabel"]');
		const homeNameInp = modal.querySelector('[data-pr="homename"]');
		const refSelect = modal.querySelector('[data-pr="refpreset"]');
		const pmRefSelect = popMap.querySelector('[data-pm="ref"]');
		const goRefBtn = modal.querySelector('[data-pr="goref"]');
		const makeRefHomeBtn = modal.querySelector('[data-pr="makerefhome"]');
		const syncRefBtn = modal.querySelector('[data-pr="syncref"]');
		const mapEl = modal.querySelector('[data-pr="map"]');
		const pmCanvasEl = popMap.querySelector('[data-pm="canvas"]');
		const homePreset = findHomePreset();

		if (selectedMapPresetId === null || !presets.some(p => Number(p.id) === Number(selectedMapPresetId))) {
			selectedMapPresetId = homePreset ? Number(homePreset.id) : (presets[0] ? Number(presets[0].id) : null);
		}

		const optsHtml = presets.length
			? presets.map(p => {
				const isH = homePreset && Number(p.id) === Number(homePreset.id);
				return '<option value="' + p.id + '"' + (Number(p.id) === Number(selectedMapPresetId) ? ' selected' : '') + '>' +
					(isH ? '★ ' : '') + '#' + p.id + ' ' + p.name.replace(/</g, '&lt;') + '</option>';
			}).join('')
			: '<option value="">No presets</option>';

		[refSelect, pmRefSelect].forEach(sel => {
			if (sel) {
				sel.innerHTML = optsHtml;
				sel.disabled = !presets.length;
			}
		});
		const hasRef = selectedMapPresetId !== null && presets.length > 0;
		[goRefBtn, makeRefHomeBtn, syncRefBtn].forEach(b => {
			if (b) {
				b.disabled = !hasRef;
				b.style.opacity = hasRef ? '1' : '0.45';
			}
		});

		if (homeEl) {
			if (homePreset) {
				const hMag = (typeof homePreset.mag === 'number' && Number.isFinite(homePreset.mag)) ? ' · Zoom ' + homePreset.mag.toFixed(1) + '×' : '';
				homeEl.innerHTML = 'Home: <strong style="color:#ffd43b">★ ' +
					homePreset.name.replace(/</g, '&lt;') + '</strong> <span style="opacity:.85">(#' + homePreset.id + ' · ' +
					fmtAxis('Pan', homePreset.pan_ms) + ' · ' + fmtAxis('Tilt', homePreset.tilt_ms) + hMag + ')</span>';
			} else {
				homeEl.innerHTML = 'Home: <strong style="color:#ffd43b">Origin (0, 0)</strong> <span style="opacity:.8">(select a preset or click <em>Save View as Home</em>)</span>';
			}
		}
		if (homeNameInp && document.activeElement !== homeNameInp) {
			homeNameInp.value = homePreset ? homePreset.name : 'Home';
		}

		populateMapCanvas(mapEl, false, homePreset, magStr);
		if (!popMap.hidden) {
			populateMapCanvas(pmCanvasEl, true, homePreset, magStr);
		}
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
			posLabel.innerHTML = 'Current Camera View: <strong>' +
				fmtAxis('Pan', currentPan) + ' · ' + fmtAxis('Tilt', currentTilt) + ' · ' + fmtAxis('Focus', currentFocus) + ' · Zoom ' + magStr + '</strong>';
		}
		renderHomeAndMap(magStr);
		if (subEl && msg) subEl.textContent = msg;
		list.innerHTML = '';

		if (!presets.length) {
			const empty = document.createElement('div');
			empty.className = 'mj-pr-empty';
			empty.textContent = 'No presets saved yet. Aim the camera, enter a name like "Gate" or "Fence" above, and click Save Current View.';
			list.appendChild(empty);
			return;
		}

		presets.forEach((p, idx) => {
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
				'  <span style="display:inline-flex;align-items:center;gap:3px;flex-shrink:0">' +
				'    <button type="button" class="mj-pr-btn mj-pr-icon-btn" data-ren="' + p.id + '" title="Rename preset"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2.5a1.4 1.4 0 0 1 2 2L5 13l-3 1 1-3 8.5-8.5z"/></svg></button>' +
				'    <button type="button" class="mj-pr-btn mj-pr-icon-btn" data-mvup="' + p.id + '" title="Move up"' + (idx === 0 ? ' disabled' : '') + '><svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 7.5L6 4l3.5 3.5"/></svg></button>' +
				'    <button type="button" class="mj-pr-btn mj-pr-icon-btn" data-mvdn="' + p.id + '" title="Move down"' + (idx === presets.length - 1 ? ' disabled' : '') + '><svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.5L6 8l3.5-3.5"/></svg></button>' +
				'    <span class="mj-pr-meta" style="line-height:22px;margin-left:2px">#' + p.id + '</span>' +
				'  </span>' +
				'</div>' +
				'<div class="mj-pr-meta">' + ptText + '<br>' + (badges.join(' · ') || 'Pan/Tilt only') + '</div>' +
				'<div class="mj-pr-card-actions">' +
				'  <button type="button" class="mj-pr-btn primary" data-go="' + p.id + '">Go to</button>' +
				'  <button type="button" class="mj-pr-btn' + (isBoot ? ' active' : '') + '" data-boot="' + p.id + '" title="Recall this preset automatically when motorsd boots">' + (isBoot ? '★ Home' : 'Boot') + '</button>' +
				'  <button type="button" class="mj-pr-btn" data-af="' + p.id + '" title="Toggle Autofocus on arrival">' + (p.run_af ? 'AF:On' : 'AF:Off') + '</button>' +
				'  <button type="button" class="mj-pr-btn" data-upd="' + p.id + '" title="Update this preset with current camera Pan/Tilt/Focus/Zoom">Set</button>' +
				'  <button type="button" class="mj-pr-btn danger" data-del="' + p.id + '" title="Delete preset" style="padding:4px 6px">✕</button>' +
				'</div>';
			const nameEl = card.querySelector('.mj-pr-name');
			nameEl.textContent = p.name;

			const startRename = () => {
				if (busy || nameEl.querySelector('input')) return;
				const inp = document.createElement('input');
				inp.type = 'text';
				inp.maxLength = 32;
				inp.value = p.name;
				inp.style.cssText = 'width:100%;max-width:160px;background:#111;color:#fff;border:1px solid #4ea1ff;border-radius:4px;padding:1px 6px;font-size:13px;';
				nameEl.textContent = '';
				nameEl.appendChild(inp);
				inp.focus();
				inp.select();
				let done = false;
				const finish = (commit) => {
					if (done) return;
					done = true;
					const next = inp.value.trim();
					if (commit && next && next !== p.name) {
						renamePreset(p.id, next);
					} else {
						nameEl.textContent = p.name;
					}
				};
				inp.addEventListener('keydown', (ev) => {
					if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
					else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
				});
				inp.addEventListener('blur', () => finish(true));
			};
			card.querySelector('[data-ren]').addEventListener('click', startRename);
			card.querySelector('[data-mvup]').addEventListener('click', () => movePreset(p.id, 'up'));
			card.querySelector('[data-mvdn]').addEventListener('click', () => movePreset(p.id, 'down'));

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
		if (typeof d.has_map_bg === 'boolean') {
			hasMapBg = d.has_map_bg;
			if (d.message && d.message.indexOf('background') >= 0) mapBgVer = Date.now();
		}
		bgPan = (typeof d.bg_pan === 'number' && Number.isFinite(d.bg_pan)) ? d.bg_pan : null;
		bgTilt = (typeof d.bg_tilt === 'number' && Number.isFinite(d.bg_tilt)) ? d.bg_tilt : null;
		updateBtnCount();
		if (pickNextSlot) {
			modal.querySelector('[data-pr="slot"]').value = String(nextFreeSlot());
		}
		if (!modal.hidden || !popMap.hidden) renderList(d.message);
		const pmStatus = popMap.querySelector('[data-pm="status"]');
		if (pmStatus && d.message) pmStatus.textContent = '· ' + d.message;
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

	function callPreset(p, onDone, keepOpen) {
		if (busy) {
			if (onDone) onDone();
			return;
		}
		busy = true;
		if (!keepOpen) modal.hidden = true;
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

	function renamePreset(id, name) {
		if (busy) return;
		busy = true;
		apiFetch('/cgi-bin/j/ptz_presets.cgi?act=rename&id=' + encodeURIComponent(id) + '&name=' + encodeURIComponent(name), {
			method: 'POST',
			credentials: 'same-origin'
		})
			.then(r => r.ok ? r.json() : null)
			.then(d => applyData(d, false))
			.catch(() => {})
			.finally(() => { busy = false; });
	}

	function movePreset(id, dir) {
		if (busy) return;
		busy = true;
		apiFetch('/cgi-bin/j/ptz_presets.cgi?act=move&id=' + encodeURIComponent(id) + '&dir=' + encodeURIComponent(dir), {
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
	let pmRefreshTimer = 0;
	window.addEventListener('mj:ptz-moved', () => {
		if (tourActive) stopTour('Tour stopped (manual PTZ move)');
		if (!popMap.hidden || !modal.hidden) {
			clearTimeout(pmRefreshTimer);
			pmRefreshTimer = setTimeout(() => loadPresets(false), 600);
		}
	});

	prBtn.addEventListener('click', e => {
		e.preventDefault();
		modal.hidden = true;
		popMap.hidden = false;
		renderList();
		loadPresets(true);
	});
	function setHomeHere() {
		if (busy) return;
		const homeNameInp = modal.querySelector('[data-pr="homename"]');
		const name = (homeNameInp ? homeNameInp.value.trim() : '') || 'Home';
		busy = true;
		apiFetch('/cgi-bin/j/ptz_presets.cgi?act=set_home_here&name=' + encodeURIComponent(name), {
			method: 'POST',
			credentials: 'same-origin'
		})
			.then(r => r.ok ? r.json() : null)
			.then(d => applyData(d, true))
			.catch(() => {})
			.finally(() => { busy = false; });
	}

	function syncPosToPreset(id) {
		if (busy || !id) return;
		busy = true;
		apiFetch('/cgi-bin/j/ptz_presets.cgi?act=sync_pos&id=' + encodeURIComponent(id), {
			method: 'POST',
			credentials: 'same-origin'
		})
			.then(r => r.ok ? r.json() : null)
			.then(d => applyData(d, false))
			.catch(() => {})
			.finally(() => { busy = false; });
	}

	function captureMapBg() {
		if (busy) return;
		busy = true;
		renderList('Capturing current view as map background...');
		const pmStatus = popMap.querySelector('[data-pm="status"]');
		if (pmStatus) pmStatus.textContent = '· Capturing current view...';
		apiFetch('/cgi-bin/j/ptz_presets.cgi?act=capture_map_bg', {
			method: 'POST',
			credentials: 'same-origin'
		})
			.then(r => r.ok ? r.json() : null)
			.then(d => {
				mapBgVer = Date.now();
				applyData(d, false);
			})
			.catch(() => {})
			.finally(() => { busy = false; });
	}

	modal.querySelector('[data-pr="capbg"]').addEventListener('click', captureMapBg);
	popMap.querySelector('[data-pm="capbg"]').addEventListener('click', captureMapBg);

	function adjustMapView(act) {
		if (act === 'left') mapView.xPct = Math.max(-45, mapView.xPct - 3);
		else if (act === 'right') mapView.xPct = Math.min(45, mapView.xPct + 3);
		else if (act === 'up') mapView.yPct = Math.max(-45, mapView.yPct - 3);
		else if (act === 'down') mapView.yPct = Math.min(45, mapView.yPct + 3);
		else if (act === 'zoomin') mapView.scale = Math.min(2.5, Math.round((mapView.scale + 0.12) * 100) / 100);
		else if (act === 'zoomout') mapView.scale = Math.max(0.35, Math.round((mapView.scale - 0.12) * 100) / 100);
		else if (act === 'reset') { mapView.xPct = 0; mapView.yPct = 0; mapView.scale = 1; }
		saveMapView();
		renderList();
	}

	[modal, popMap].forEach(root => {
		root.querySelectorAll('[data-mv]').forEach(btn => {
			btn.addEventListener('click', () => adjustMapView(btn.getAttribute('data-mv')));
		});
		root.querySelectorAll('[data-shift]').forEach(btn => {
			btn.addEventListener('click', () => {
				if (busy) return;
				const parts = (btn.getAttribute('data-shift') || '0,0').split(',');
				const stepEl = modal.querySelector('[data-pr="shiftstep"]');
				const step = parseInt(stepEl ? stepEl.value : '500', 10) || 500;
				const dpan = (parseInt(parts[0], 10) || 0) * step;
				const dtilt = (parseInt(parts[1], 10) || 0) * step;
				busy = true;
				apiFetch('/cgi-bin/j/ptz_presets.cgi?act=shift_all&pan_ms=' + encodeURIComponent(dpan) + '&tilt_ms=' + encodeURIComponent(dtilt), {
					method: 'POST',
					credentials: 'same-origin'
				})
					.then(r => r.ok ? r.json() : null)
					.then(d => applyData(d, false))
					.catch(() => {})
					.finally(() => { busy = false; });
			});
		});
	});

	[modal.querySelector('[data-pr="map"]'), popMap.querySelector('[data-pm="canvas"]')].forEach(canvas => {
		if (!canvas) return;
		let dragging = false, sx = 0, sy = 0, startX = 0, startY = 0;
		canvas.addEventListener('pointerdown', e => {
			if (e.target !== canvas && e.target.tagName !== 'svg') return;
			dragging = true;
			sx = e.clientX; sy = e.clientY;
			startX = mapView.xPct; startY = mapView.yPct;
			canvas.style.cursor = 'grabbing';
			try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
		});
		canvas.addEventListener('pointermove', e => {
			if (!dragging) return;
			const w = canvas.clientWidth || 200;
			const h = canvas.clientHeight || 120;
			mapView.xPct = Math.max(-45, Math.min(45, startX + ((e.clientX - sx) / w) * 100));
			mapView.yPct = Math.max(-45, Math.min(45, startY + ((e.clientY - sy) / h) * 100));
			renderList();
		});
		const endDrag = () => {
			if (!dragging) return;
			dragging = false;
			canvas.style.cursor = 'grab';
			saveMapView();
		};
		canvas.addEventListener('pointerup', endDrag);
		canvas.addEventListener('pointercancel', endDrag);
		canvas.addEventListener('wheel', e => {
			e.preventDefault();
			adjustMapView(e.deltaY < 0 ? 'zoomin' : 'zoomout');
		}, { passive: false });
	});
	modal.querySelector('[data-pr="popmap"]').addEventListener('click', () => {
		modal.hidden = true;
		popMap.hidden = false;
		renderList();
	});
	popMap.querySelector('[data-pm="modal"]').addEventListener('click', () => {
		popMap.hidden = true;
		modal.hidden = false;
		renderList();
	});
	popMap.querySelector('[data-pm="close"]').addEventListener('click', () => {
		popMap.hidden = true;
	});
	popMap.querySelector('[data-pm="ref"]').addEventListener('change', e => {
		selectedMapPresetId = Number(e.target.value) || null;
		renderList();
	});
	popMap.querySelector('[data-pm="go"]').addEventListener('click', () => {
		const p = presets.find(x => Number(x.id) === Number(selectedMapPresetId));
		if (p) {
			stopTour();
			callPreset(p, null, true);
			renderList('Moving to ' + p.name + ' (#' + p.id + ')...');
		}
	});
	popMap.querySelector('[data-pm="home"]').addEventListener('click', () => {
		if (selectedMapPresetId !== null) setBootHome(selectedMapPresetId);
	});
	popMap.querySelector('[data-pm="sync"]').addEventListener('click', () => {
		if (selectedMapPresetId !== null) syncPosToPreset(selectedMapPresetId);
	});
	modal.querySelector('[data-pr="close"]').addEventListener('click', () => { modal.hidden = true; });
	modal.querySelector('[data-pr="save"]').addEventListener('click', savePreset);
	modal.querySelector('[data-pr="sethome"]').addEventListener('click', setHomeHere);
	modal.querySelector('[data-pr="homename"]').addEventListener('keydown', e => {
		if (e.key === 'Enter') { e.preventDefault(); setHomeHere(); }
	});
	modal.querySelector('[data-pr="refpreset"]').addEventListener('change', e => {
		selectedMapPresetId = Number(e.target.value) || null;
		renderList();
	});
	modal.querySelector('[data-pr="goref"]').addEventListener('click', () => {
		const p = presets.find(x => Number(x.id) === Number(selectedMapPresetId));
		if (p) {
			stopTour();
			callPreset(p, null, true);
			renderList('Moving to ' + p.name + ' (#' + p.id + ')...');
		}
	});
	modal.querySelector('[data-pr="makerefhome"]').addEventListener('click', () => {
		if (selectedMapPresetId !== null) setBootHome(selectedMapPresetId);
	});
	modal.querySelector('[data-pr="syncref"]').addEventListener('click', () => {
		if (selectedMapPresetId !== null) syncPosToPreset(selectedMapPresetId);
	});
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
