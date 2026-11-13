/**
 * Click-and-Drag "Box PTZ" (3D Optical Positioning) + 2-Click Calibration
 * Attaches "Box PTZ" and "Calibrate" inside #mj-ptz-fn:
 *  - Box PTZ: drag a box on #mj-stage, then pick the target optical zoom
 *    on a slider (or click Pan/Tilt Only) and confirm to move + zoom + AF.
 *  - Calibrate: 2-click landmark calibration:
 *      Step 1: Click an off-center object on the video -> camera moves there.
 *      Step 2: Click where that object actually landed -> computes exact
 *              pan/tilt scale ratio and saves it to localStorage.
 */
(function () {
	const fn = typeof $ === 'function' ? $('#mj-ptz-fn') : document.getElementById('mj-ptz-fn');
	const stage = typeof $ === 'function' ? $('#mj-stage') : document.getElementById('mj-stage');
	if (!fn || !stage || typeof apiFetch !== 'function') return;

	function stored(k, fallback) {
		try {
			const v = localStorage.getItem(k);
			return v != null ? v : fallback;
		} catch (e) {
			return fallback;
		}
	}

	// Migrate old uncalibrated defaults to 10600ms (pan) / 6400ms (tilt) unless user calibrated
	try {
		if (localStorage.getItem('openipc.motor.boxCalibrated') !== '1') {
			const curP = localStorage.getItem('openipc.motor.boxPanScaleMs');
			const curT = localStorage.getItem('openipc.motor.boxTiltScaleMs');
			if (!curP || curP === '1800' || curP === '6000' || curP === '18000' || curP === '15000' || curP === '12750') {
				localStorage.setItem('openipc.motor.boxPanScaleMs', '10600');
			}
			if (!curT || curT === '1200' || curT === '4000' || curT === '11000' || curT === '9200' || curT === '7800') {
				localStorage.setItem('openipc.motor.boxTiltScaleMs', '6400');
			}
		}
	} catch (e) {}

	const boxBtn = document.createElement('button');
	boxBtn.type = 'button';
	boxBtn.className = 'mj-ptz-fnbtn';
	boxBtn.setAttribute('aria-label', 'Box PTZ optical zoom');
	boxBtn.title = 'Drag a box on the video, then pick zoom level to Pan, Tilt & Optically Zoom';
	boxBtn.innerHTML =
		'<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
		'<rect x="3" y="4" width="14" height="12" rx="1.5" stroke-dasharray="2.5 2"></rect>' +
		'<path d="M10 7.5v5M7.5 10h5"></path>' +
		'</svg><span>Box PTZ</span>';
	fn.appendChild(boxBtn);

	const calBtn = document.createElement('button');
	calBtn.type = 'button';
	calBtn.className = 'mj-ptz-fnbtn';
	calBtn.setAttribute('aria-label', 'Calibrate Box PTZ');
	calBtn.title = '2-click Box PTZ calibration: click a target, then click where it landed';
	calBtn.innerHTML =
		'<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
		'<circle cx="10" cy="10" r="6"></circle>' +
		'<path d="M10 2v3M10 15v3M2 10h3M15 10h3"></path>' +
		'</svg><span>Calibrate</span>';
	fn.appendChild(calBtn);

	// Toast banner at top-center of stage for prompts & results
	const banner = document.createElement('div');
	banner.style.cssText = 'position:absolute;left:50%;top:12px;transform:translateX(-50%);z-index:38;background:rgba(13,15,20,.92);color:#e9ecef;border:1px solid rgba(255,255,255,.22);border-radius:8px;padding:7px 12px;font-size:.78rem;font-weight:600;display:none;align-items:center;gap:10px;backdrop-filter:blur(8px);box-shadow:0 8px 24px rgba(0,0,0,.5);max-width:92vw;flex-wrap:wrap';
	stage.appendChild(banner);

	let bannerTimer = null;
	function showBanner(msg, autoHideMs) {
		banner.textContent = msg;
		banner.style.display = 'flex';
		if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null; }
		if (autoHideMs) {
			bannerTimer = setTimeout(() => { banner.style.display = 'none'; }, autoHideMs);
		}
	}
	function hideBanner() {
		if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null; }
		banner.style.display = 'none';
	}

	['pointerdown', 'pointerup', 'click', 'dblclick', 'keydown'].forEach(ev => {
		boxBtn.addEventListener(ev, e => e.stopPropagation());
		calBtn.addEventListener(ev, e => e.stopPropagation());
		banner.addEventListener(ev, e => e.stopPropagation());
	});

	let activeCleanup = null;
	let currentMag = null;

	function refreshCurrentMag() {
		return apiFetch('/cgi-bin/j/box_ptz.cgi', { credentials: 'same-origin', cache: 'no-store' })
			.then(r => r.ok ? r.json() : null)
			.then(d => {
				if (d && typeof d.current_mag === 'number' && d.current_mag >= 1.0) {
					currentMag = d.current_mag;
				} else {
					currentMag = null;
				}
				return currentMag;
			})
			.catch(() => {
				currentMag = null;
				return null;
			});
	}

	function computeZoomFactor(spanW, spanH, centerOnly) {
		if (centerOnly) return 1.0;
		const boxSpan = Math.max(spanW, spanH, 0.03);
		if (boxSpan >= 0.90) return 1.0;
		const ratio = 1.0 / boxSpan;
		return Math.min(57.0, Math.max(1.0, ratio * Math.sqrt(ratio)));
	}

	function setBtnState(btn, bg, label) {
		const span = btn.querySelector('span');
		btn.style.background = bg || '';
		btn.style.borderColor = bg || '';
		if (span && label != null) span.textContent = label;
	}

	function getScales() {
		const panScale = parseInt(stored('openipc.motor.boxPanScaleMs', '10600'), 10) || 10600;
		const tiltScale = parseInt(stored('openipc.motor.boxTiltScaleMs', '6400'), 10) || 6400;
		const invPan = stored('openipc.motor.boxInvertPan', '0') === '1' ? '1' : '0';
		const invTilt = stored('openipc.motor.boxInvertTilt', '0') === '1' ? '1' : '0';
		return { panScale, tiltScale, invPan, invTilt };
	}

	function getMediaRect() {
		const ids = ['live-video', 'live-video-b', 'live-canvas', 'live-canvas-b', 'live-mjpeg', 'live-mjpeg-b'];
		for (const id of ids) {
			const el = document.getElementById(id);
			if (el && el.style.display !== 'none') {
				const r = el.getBoundingClientRect();
				if (r.width > 20 && r.height > 20) return r;
			}
		}
		return stage.getBoundingClientRect();
	}

	function executeMove(dx, dy, targetMag, doAf) {
		const sc = getScales();
		const params = [
			'dx=' + dx.toFixed(4),
			'dy=' + dy.toFixed(4),
			'pan_scale=' + sc.panScale,
			'tilt_scale=' + sc.tiltScale,
			'inv_pan=' + sc.invPan,
			'inv_tilt=' + sc.invTilt
		];
		if (typeof targetMag === 'number' && Number.isFinite(targetMag) && targetMag >= 1.0) {
			params.push('target_mag=' + targetMag.toFixed(1));
		}
		const q = params.join('&');

		setBtnState(boxBtn, '#198754', 'Moving…');
		document.dispatchEvent(new CustomEvent('mj-ptz-move', { detail: { durationMs: 14000 } }));
		return apiFetch('/cgi-bin/j/box_ptz.cgi?' + q, {
			method: 'POST',
			credentials: 'same-origin'
		})
			.then(res => res.ok ? res.json() : null)
			.then(d => {
				if (d && typeof d.target_mag === 'number') {
					currentMag = d.target_mag;
				}
				if (d && d.ok && doAf) {
					apiFetch('/autofocus', { credentials: 'same-origin' }).catch(() => {});
				}
				return d;
			})
			.catch(() => null)
			.finally(() => {
				setTimeout(() => setBtnState(boxBtn, '', 'Box PTZ'), 2000);
			});
	}

	// Post-selection zoom slider popup
	function showZoomConfirm(r, suggestedMag, onDone) {
		const cx = (r.x + r.w / 2) / r.frame.w;
		const cy = (r.y + r.h / 2) / r.frame.h;
		const dx = cx - 0.5;
		const dy = cy - 0.5;
		const dxPct = Math.round(dx * 100);
		const dyPct = Math.round(dy * 100);
		const pTxt = Math.abs(dxPct) < 2 ? 'Pan 0' : 'Pan ' + (dxPct > 0 ? 'R' : 'L') + Math.abs(dxPct) + '%';
		const tTxt = Math.abs(dyPct) < 2 ? 'Tilt 0' : 'Tilt ' + (dyPct > 0 ? 'D' : 'U') + Math.abs(dyPct) + '%';

		const sb = r.stageBox || r;
		const previewBox = document.createElement('div');
		previewBox.style.cssText = 'position:absolute;border:2px solid #20c997;background:rgba(32,201,151,.14);pointer-events:none;border-radius:3px;z-index:36;' +
			'left:' + sb.x + 'px;top:' + sb.y + 'px;width:' + sb.w + 'px;height:' + sb.h + 'px';
		stage.appendChild(previewBox);

		const pop = document.createElement('div');
		pop.style.cssText = 'position:absolute;left:50%;top:14px;transform:translateX(-50%);z-index:39;background:rgba(16,19,26,.95);color:#e9ecef;border:1px solid rgba(32,201,151,.55);border-radius:10px;padding:10px 14px;display:flex;flex-direction:column;gap:8px;min-width:260px;max-width:92vw;box-shadow:0 12px 32px rgba(0,0,0,.6);backdrop-filter:blur(8px);font-size:.8rem';
		pop.innerHTML =
			'<div style="display:flex;justify-content:space-between;align-items:center;gap:10px">' +
			'  <strong>' + pTxt + ' · ' + tTxt + '</strong>' +
			'  <span style="color:#20c997;font-weight:700" data-bp="zval">' + suggestedMag.toFixed(1) + '×</span>' +
			'</div>' +
			'<div style="display:flex;align-items:center;gap:8px">' +
			'  <span style="font-size:.72rem;color:#adb5bd">1×</span>' +
			'  <input type="range" min="1" max="57" step="0.5" value="' + suggestedMag.toFixed(1) + '" data-bp="slider" style="flex:1;accent-color:#20c997">' +
			'  <span style="font-size:.72rem;color:#adb5bd">57×</span>' +
			'</div>' +
			'<div style="display:flex;gap:6px;flex-wrap:wrap">' +
			'  <button type="button" class="btn btn-sm" style="flex:1;background:#198754;border-color:#198754;color:#fff" data-bp="go">Move &amp; Zoom</button>' +
			'  <button type="button" class="btn btn-sm btn-outline-secondary" style="border-color:#0dcaf0;color:#0dcaf0" data-bp="center" title="Center Pan/Tilt without changing zoom">Center Only</button>' +
			'  <button type="button" class="btn btn-sm btn-outline-secondary" data-bp="cancel">Cancel</button>' +
			'</div>';
		stage.appendChild(pop);

		['pointerdown', 'pointerup', 'click', 'dblclick', 'keydown'].forEach(ev => {
			pop.addEventListener(ev, e => e.stopPropagation());
		});

		const slider = pop.querySelector('[data-bp="slider"]');
		const zval = pop.querySelector('[data-bp="zval"]');
		slider.addEventListener('input', () => {
			zval.textContent = Number(slider.value).toFixed(1) + '×';
		});

		function closePop() {
			if (pop.parentNode) pop.parentNode.removeChild(pop);
			if (previewBox.parentNode) previewBox.parentNode.removeChild(previewBox);
			activeCleanup = null;
			setBtnState(boxBtn, '', 'Box PTZ');
		}
		activeCleanup = closePop;

		pop.querySelector('[data-bp="go"]').addEventListener('click', () => {
			const tgt = Number(slider.value);
			closePop();
			executeMove(dx, dy, tgt, true);
			if (onDone) onDone();
		});
		pop.querySelector('[data-bp="center"]').addEventListener('click', () => {
			closePop();
			executeMove(dx, dy, currentMag, true);
			if (onDone) onDone();
		});
		pop.querySelector('[data-bp="cancel"]').addEventListener('click', () => {
			closePop();
		});
	}

	function startBoxDrag() {
		const magReady = refreshCurrentMag();
		const overlay = document.createElement('div');
		overlay.style.cssText = 'position:absolute;inset:0;z-index:30;cursor:crosshair;touch-action:none';
		const band = document.createElement('div');
		band.style.cssText = 'position:absolute;border:2px dashed #20c997;background:rgba(32,201,151,.18);pointer-events:none;display:none;border-radius:3px';
		const badge = document.createElement('div');
		badge.style.cssText = 'position:absolute;left:0;top:-22px;background:rgba(15,81,50,.92);color:#fff;font-size:.7rem;font-weight:600;padding:1px 6px;border-radius:4px;white-space:nowrap';
		band.appendChild(badge);
		overlay.appendChild(band);
		stage.appendChild(overlay);

		let start = null;
		function cleanup() {
			if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
			activeCleanup = null;
			setBtnState(boxBtn, '', 'Box PTZ');
		}
		activeCleanup = cleanup;

		overlay.addEventListener('pointerdown', e => {
			e.stopPropagation();
			e.preventDefault();
			const rect = stage.getBoundingClientRect();
			start = { x: e.clientX - rect.left, y: e.clientY - rect.top, w: rect.width, h: rect.height };
			band.style.left = start.x + 'px';
			band.style.top = start.y + 'px';
			band.style.width = '0px';
			band.style.height = '0px';
			badge.textContent = 'Drag box or click to center';
			band.style.display = 'block';
			try { overlay.setPointerCapture(e.pointerId); } catch (err) {}
		});
		overlay.addEventListener('pointermove', e => {
			if (!start) return;
			const rect = stage.getBoundingClientRect();
			const cx = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
			const cy = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
			const x = Math.min(start.x, cx);
			const y = Math.min(start.y, cy);
			const w = Math.abs(cx - start.x);
			const h = Math.abs(cy - start.y);
			band.style.left = x + 'px';
			band.style.top = y + 'px';
			band.style.width = w + 'px';
			band.style.height = h + 'px';

			const mRect = getMediaRect();
			const midClientX = rect.left + x + w / 2;
			const midClientY = rect.top + y + h / 2;
			const dxPct = Math.round((((midClientX - mRect.left) / Math.max(1, mRect.width)) - 0.5) * 100);
			const dyPct = Math.round((((midClientY - mRect.top) / Math.max(1, mRect.height)) - 0.5) * 100);
			const pTxt = Math.abs(dxPct) < 2 ? 'Pan 0' : 'Pan ' + (dxPct > 0 ? 'R' : 'L') + Math.abs(dxPct) + '%';
			const tTxt = Math.abs(dyPct) < 2 ? 'Tilt 0' : 'Tilt ' + (dyPct > 0 ? 'D' : 'U') + Math.abs(dyPct) + '%';
			if (w < 14 && h < 14) {
				badge.textContent = pTxt + ' · ' + tTxt + ' (Center only)';
			} else if (currentMag != null) {
				const zf = computeZoomFactor(w / Math.max(1, mRect.width), h / Math.max(1, mRect.height), false);
				const tgtMag = Math.min(57.0, currentMag * zf);
				badge.textContent = pTxt + ' · ' + tTxt + ' · Est ' + tgtMag.toFixed(1) + '×';
			} else {
				badge.textContent = pTxt + ' · ' + tTxt;
			}
		});
		overlay.addEventListener('pointerup', e => {
			if (!start) return;
			const rect = stage.getBoundingClientRect();
			const mRect = getMediaRect();
			const cx = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
			const cy = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
			const x = Math.min(start.x, cx);
			const y = Math.min(start.y, cy);
			const w = Math.abs(cx - start.x);
			const h = Math.abs(cy - start.y);
			cleanup();

			const centerOnly = (w < 14 && h < 14);
			const zf = computeZoomFactor(w / Math.max(1, mRect.width), h / Math.max(1, mRect.height), centerOnly);
			const mx = (rect.left + x) - mRect.left;
			const my = (rect.top + y) - mRect.top;
			const boxSpec = {
				x: mx, y: my,
				w: Math.max(w, 12), h: Math.max(h, 12),
				stageBox: { x: x, y: y, w: Math.max(w, 12), h: Math.max(h, 12) },
				frame: { w: mRect.width, h: mRect.height }
			};
			magReady.then(mag => {
				if (mag == null) {
					showBanner('Current zoom magnification unavailable', 3000);
					return;
				}
				const suggestedMag = centerOnly ? mag : Math.min(57.0, mag * zf);
				showZoomConfirm(boxSpec, suggestedMag);
			});
		});
	}

	// 2-Click Calibration mode
	function startCalibration() {
		refreshCurrentMag();
		const overlay = document.createElement('div');
		overlay.style.cssText = 'position:absolute;inset:0;z-index:32;cursor:crosshair;touch-action:none';
		const reticle = document.createElement('div');
		reticle.style.cssText = 'position:absolute;left:50%;top:50%;width:24px;height:24px;margin:-12px 0 0 -12px;border:2px solid rgba(255,193,7,.85);border-radius:50%;pointer-events:none';
		overlay.appendChild(reticle);
		stage.appendChild(overlay);

		let step = 1;
		let dx1 = 0;
		let dy1 = 0;
		let calPanMs = 0;
		let calTiltMs = 0;
		let waiting = false;

		function cleanup() {
			if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
			activeCleanup = null;
			setBtnState(calBtn, '', 'Calibrate');
		}
		activeCleanup = cleanup;

		setBtnState(calBtn, '#d97706', 'Step 1/2');
		showBanner('Calibrate Step 1/2: Click an off-center object on the video (keep it >10% from center)');

		overlay.addEventListener('pointerdown', e => {
			e.stopPropagation();
			e.preventDefault();
			if (waiting) return;
			const rect = getMediaRect();
			const nx = (e.clientX - rect.left) / Math.max(1, rect.width);
			const ny = (e.clientY - rect.top) / Math.max(1, rect.height);

			if (step === 1) {
				dx1 = nx - 0.5;
				dy1 = ny - 0.5;
				if (Math.abs(dx1) < 0.04 && Math.abs(dy1) < 0.04) {
					showBanner('Too close to center — click an object further toward a corner');
					return;
				}
				step = 2;
				waiting = true;
				setBtnState(calBtn, '#d97706', 'Moving…');
				showBanner('Moving camera to clicked object… please wait');
				executeMove(dx1, dy1, currentMag, false).then(d => {
					const panMs = d && typeof d.pan_ms === 'number' ? d.pan_ms : 350;
					const tiltMs = d && typeof d.tilt_ms === 'number' ? d.tilt_ms : 350;
					calPanMs = panMs;
					calTiltMs = tiltMs;
					const waitMs = Math.max(1600, panMs + tiltMs + 900);
					setTimeout(() => {
						waiting = false;
						setBtnState(calBtn, '#0d6efd', 'Step 2/2');
						showBanner('Calibrate Step 2/2: Click where that SAME object landed now (or center circle if dead-on)');
					}, Math.min(waitMs, 8000));
				});
			} else if (step === 2) {
				const dx2 = nx - 0.5;
				const dy2 = ny - 0.5;
				const sc = getScales();
				let newP = sc.panScale;
				let newT = sc.tiltScale;
				let updated = [];

				if (Math.abs(dx1) >= 0.04) {
					const movedX = dx1 - dx2;
					if ((movedX * dx1) > 0 && Math.abs(movedX) >= 0.02) {
						const ratioP = calPanMs > 100
							? Math.max(0.2, ((calPanMs * (dx1 / movedX)) - 100) / Math.max(1, calPanMs - 100))
							: (dx1 / movedX);
						newP = Math.round(Math.min(30000, Math.max(1000, sc.panScale * ratioP)));
						localStorage.setItem('openipc.motor.boxPanScaleMs', String(newP));
						updated.push('Pan ' + sc.panScale + '→' + newP + 'ms');
					}
				}
				if (Math.abs(dy1) >= 0.04) {
					const movedY = dy1 - dy2;
					if ((movedY * dy1) > 0 && Math.abs(movedY) >= 0.02) {
						const ratioT = calTiltMs > 100
							? Math.max(0.2, ((calTiltMs * (dy1 / movedY)) - 100) / Math.max(1, calTiltMs - 100))
							: (dy1 / movedY);
						newT = Math.round(Math.min(20000, Math.max(1000, sc.tiltScale * ratioT)));
						localStorage.setItem('openipc.motor.boxTiltScaleMs', String(newT));
						updated.push('Tilt ' + sc.tiltScale + '→' + newT + 'ms');
					}
				}
				if (updated.length > 0) {
					localStorage.setItem('openipc.motor.boxCalibrated', '1');
					showBanner('Calibrated! ' + updated.join(' · '), 4500);
				} else {
					showBanner('Calibration canceled (movement too small to measure)', 3500);
				}
				cleanup();
			}
		});
	}

	boxBtn.addEventListener('click', e => {
		e.preventDefault();
		if (activeCleanup) {
			activeCleanup();
			hideBanner();
			return;
		}
		setBtnState(boxBtn, '#198754', 'Drag Box…');
		startBoxDrag();
	});

	calBtn.addEventListener('click', e => {
		e.preventDefault();
		if (activeCleanup) {
			activeCleanup();
			hideBanner();
			return;
		}
		startCalibration();
	});
})();
