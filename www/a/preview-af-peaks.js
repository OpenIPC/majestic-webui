/**
 * ============================================================================
 * Autofocus Candidate Peak Gallery & Interactive Verification Modal
 * ============================================================================
 *
 * This component connects the WebUI to the multi-peak tournament system:
 *
 * 1. Background Polling & Detection:
 *    Periodically polls for /tmp/af_peaks.json.
 *    When candidate snapshots exist, dynamically injects a "Peaks (<count>)"
 *    action button into the PTZ controls panel (#mj-ptz-fn).
 *
 * 2. Visual Proof Modal & Gallery:
 *    Displays full-resolution snapshots (/tmp/peak_<id>.jpg) captured at each
 *    settled candidate focus peak encountered during the sweep.
 *    - Highlights the winning candidate selected by hardware edge sharpness.
 *    - Displays quantitative metrics: relative motor coordinate (pos), sensor
 *      contrast score (FV), and JPEG stream compressed payload size.
 *
 * 3. Interactive Focus Override:
 *    Allows operators to visually inspect each peak (with full-screen zoom),
 *    compare depth-of-field differences across foreground and background planes,
 *    and command the lens to override-park directly at any candidate peak.
 * ============================================================================
 */
(function () {
	const fn = typeof $ === 'function' ? $('#mj-ptz-fn') : document.getElementById('mj-ptz-fn');
	const stage = typeof $ === 'function' ? $('#mj-stage') : document.getElementById('mj-stage');
	if (!fn || !stage || typeof apiFetch !== 'function') return;

	const style = document.createElement('style');
	style.textContent = [
		'.mj-ptz-fn{grid-template-columns:repeat(2,calc((7.875rem + 2px)/2))!important}',
		'.mj-ptz-fnbtn{min-width:0!important;padding:.45rem .2rem .4rem!important;font-size:.58rem!important;letter-spacing:.04em!important;white-space:nowrap}',
		'.mj-afp-modal{position:fixed;inset:0;z-index:1060;background:rgba(8,10,14,.78);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:12px;color:#e9ecef;font-family:inherit}',
		'.mj-afp-modal[hidden]{display:none}',
		'.mj-afp-box{width:min(960px,100%);max-height:90vh;display:flex;flex-direction:column;background:rgba(18,21,28,.96);border:1px solid rgba(255,255,255,.14);border-radius:10px;box-shadow:0 20px 50px rgba(0,0,0,.6);overflow:hidden}',
		'.mj-afp-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.1)}',
		'.mj-afp-title{margin:0;font-size:1rem;font-weight:600;color:#fff}',
		'.mj-afp-sub{font-size:.78rem;color:#adb5bd;margin-top:2px}',
		'.mj-afp-actions{display:flex;gap:8px;align-items:center}',
		'.mj-afp-btn{border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);color:#fff;border-radius:6px;padding:5px 10px;font-size:.78rem;font-weight:600;cursor:pointer}',
		'.mj-afp-btn:hover{background:rgba(255,255,255,.16)}',
		'.mj-afp-btn:disabled{opacity:.45;cursor:not-allowed}',
		'.mj-afp-btn.primary{background:#0d6efd;border-color:#0d6efd}',
		'.mj-afp-btn.primary:hover{background:#0b5ed7}',
		'.mj-afp-btn.active{background:#198754;border-color:#198754}',
		'.mj-afp-warn{background:rgba(255,193,7,.15);color:#ffd166;border-bottom:1px solid rgba(255,193,7,.25);padding:8px 16px;font-size:.8rem}',
		'.mj-afp-grid{padding:14px 16px;overflow-y:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}',
		'.mj-afp-card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:8px;overflow:hidden;display:flex;flex-direction:column}',
		'.mj-afp-card.winner{border-color:#198754;box-shadow:0 0 0 1px rgba(25,135,84,.5)}',
		'.mj-afp-imgwrap{position:relative;aspect-ratio:16/9;background:#000;cursor:zoom-in;overflow:hidden}',
		'.mj-afp-imgwrap img{width:100%;height:100%;object-fit:cover;display:block}',
		'.mj-afp-badge{position:absolute;top:6px;left:6px;background:rgba(13,15,20,.82);color:#fff;padding:2px 7px;border-radius:4px;font-size:.7rem;font-weight:600;border:1px solid rgba(255,255,255,.15)}',
		'.mj-afp-badge.win{background:rgba(25,135,84,.9);border-color:rgba(255,255,255,.25)}',
		'.mj-afp-body{padding:10px 12px;display:flex;flex-direction:column;gap:6px;flex:1}',
		'.mj-afp-stats{display:flex;flex-wrap:wrap;gap:6px 10px;font-size:.75rem;color:#ced4da}',
		'.mj-afp-desc{font-size:.77rem;color:#adb5bd;line-height:1.35;flex:1}',
		'.mj-afp-zoom{position:fixed;inset:0;z-index:1070;background:rgba(0,0,0,.92);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px}',
		'.mj-afp-zoom[hidden]{display:none}',
		'.mj-afp-zoom img{max-width:100%;max-height:82vh;object-fit:contain;border-radius:6px}',
		'.mj-afp-zoombar{margin-top:10px;display:flex;flex-wrap:wrap;justify-content:center;gap:8px 10px;align-items:center;color:#fff;font-size:.85rem}'
	].join('');
	document.head.appendChild(style);

	const peaksBtn = document.createElement('button');
	peaksBtn.type = 'button';
	peaksBtn.className = 'mj-ptz-fnbtn';
	peaksBtn.setAttribute('aria-label', 'Autofocus peak gallery');
	peaksBtn.title = 'View & select autofocus candidate peaks';
	peaksBtn.innerHTML =
		'<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
		'<rect x="2.8" y="4.2" width="10.4" height="8.4" rx="1.3"></rect>' +
		'<path d="M6.8 15.8h9.2a1.2 1.2 0 0 0 1.2-1.2V7.8"></path>' +
		'</svg><span>AF Peaks</span>';

	const afBtn = fn.querySelector('[data-act="af"]');
	if (afBtn) afBtn.style.gridColumn = '';
	if (afBtn && afBtn.nextSibling) fn.insertBefore(peaksBtn, afBtn.nextSibling);
	else fn.appendChild(peaksBtn);

	const modal = document.createElement('div');
	modal.className = 'mj-afp-modal';
	modal.hidden = true;
	modal.innerHTML =
		'<div class="mj-afp-box" role="dialog" aria-modal="true" aria-label="Autofocus Peak Candidates">' +
		'  <div class="mj-afp-head">' +
		'    <div>' +
		'      <div class="mj-afp-title">Autofocus Peak Candidates</div>' +
		'      <div class="mj-afp-sub">Compare peak snapshots (tap an image to inspect full size, or select one to focus there).</div>' +
		'    </div>' +
		'    <div class="mj-afp-actions">' +
		'      <button type="button" class="mj-afp-btn" data-afp="refresh">Refresh</button>' +
		'      <button type="button" class="mj-afp-btn" data-afp="close">Close</button>' +
		'    </div>' +
		'  </div>' +
		'  <div class="mj-afp-warn" data-afp="warn" hidden></div>' +
		'  <div class="mj-afp-grid" data-afp="grid"></div>' +
		'</div>';
	document.body.appendChild(modal);

	const zoomBox = document.createElement('div');
	zoomBox.className = 'mj-afp-zoom';
	zoomBox.hidden = true;
	zoomBox.innerHTML =
		'<img alt="Candidate peak full preview">' +
		'<div class="mj-afp-zoombar">' +
		'  <button type="button" class="mj-afp-btn" data-afp="zprev">&#9664; Prev</button>' +
		'  <span data-afp="zcap"></span>' +
		'  <button type="button" class="mj-afp-btn" data-afp="znext">Next &#9654;</button>' +
		'  <button type="button" class="mj-afp-btn primary" data-afp="zuse">Use This Focus</button>' +
		'  <button type="button" class="mj-afp-btn" data-afp="zclose">Close Preview</button>' +
		'</div>';
	document.body.appendChild(zoomBox);

	['pointerdown', 'pointerup', 'click', 'dblclick', 'keydown'].forEach(ev => {
		peaksBtn.addEventListener(ev, e => e.stopPropagation());
		modal.addEventListener(ev, e => e.stopPropagation());
		zoomBox.addEventListener(ev, e => e.stopPropagation());
	});

	let lastData = null;
	let cacheBust = Date.now();
	let positionShifted = false;
	let afRunning = false;
	let userClickedAf = false;
	let busySelectId = null;
	let zoomItems = [];
	let zoomIndex = -1;
	let zoomPeakId = null;

	function updateBtnLabel(data) {
		const count = data && Array.isArray(data.candidates) ? data.candidates.length : 0;
		const span = peaksBtn.querySelector('span');
		if (span) span.textContent = count > 1 ? 'AF Peaks (' + count + ')' : 'AF Peaks';
	}

	function explainCandidate(c, byteRank, fvRank, minBytes, maxBytes, count) {
		const pct = minBytes > 0 ? (((c.bytes - minBytes) / minBytes) * 100) : 0;
		if (byteRank === 1 && fvRank === 1) {
			return 'Highest JPEG detail & highest ISP FV — strongest overall focus.';
		} else if (byteRank === 1) {
			return 'Highest real edge detail (+' + pct.toFixed(1) + '% vs softest). Higher-FV peaks are likely glare or noise.';
		} else if (c.bytes === minBytes) {
			return 'Softest frame (smallest JPEG size due to out-of-focus blur).';
		} else if (fvRank <= 2 && byteRank > Math.ceil(count / 2)) {
			return 'High ISP FV spike, but softer JPEG edges — typical of streetlight glare/halos.';
		}
		return 'Focus shoulder (#' + byteRank + ' in edge detail, +' + pct.toFixed(1) + '% vs softest).';
	}

	function renderZoom() {
		if (zoomItems.length === 0) {
			zoomBox.hidden = true;
			return;
		}
		if (zoomPeakId != null) {
			const found = zoomItems.findIndex(item => item.id === zoomPeakId);
			if (found >= 0) zoomIndex = found;
		}
		if (zoomIndex < 0 || zoomIndex >= zoomItems.length) zoomIndex = 0;
		const item = zoomItems[zoomIndex];
		zoomPeakId = item.id;

		const imgEl = zoomBox.querySelector('img');
		if (imgEl.getAttribute('data-src') !== item.imgUrl) {
			imgEl.src = item.imgUrl;
			imgEl.setAttribute('data-src', item.imgUrl);
		}
		zoomBox.querySelector('[data-afp="zcap"]').textContent =
			(zoomIndex + 1) + '/' + zoomItems.length + ' · Peak #' + item.byteRank +
			' · JPEG ' + item.kb + ' · FV ' + item.fv + ' · ' + item.offsetText;

		const prevBtn = zoomBox.querySelector('[data-afp="zprev"]');
		const nextBtn = zoomBox.querySelector('[data-afp="znext"]');
		prevBtn.disabled = zoomItems.length <= 1;
		nextBtn.disabled = zoomItems.length <= 1;

		const useBtn = zoomBox.querySelector('[data-afp="zuse"]');
		const isWinner = lastData && lastData.winner === item.id;
		const isMoving = busySelectId === item.id;
		const curPos = lastData && typeof lastData.current_pos === 'number' ? lastData.current_pos : null;
		useBtn.className = 'mj-afp-btn ' + (isWinner ? 'active' : 'primary');
		useBtn.textContent = isMoving ? 'Moving lens…' : (isWinner ? 'Focused Here' : 'Use This Focus');
		useBtn.disabled = positionShifted || busySelectId != null || curPos == null;
	}

	function openZoom(idx) {
		if (idx < 0 || idx >= zoomItems.length) return;
		zoomIndex = idx;
		zoomPeakId = zoomItems[idx].id;
		zoomBox.hidden = false;
		renderZoom();
	}

	function stepZoom(delta) {
		if (zoomItems.length <= 1) return;
		zoomIndex = (zoomIndex + delta + zoomItems.length) % zoomItems.length;
		zoomPeakId = zoomItems[zoomIndex].id;
		renderZoom();
	}

	function renderModal() {
		const grid = modal.querySelector('[data-afp="grid"]');
		const warn = modal.querySelector('[data-afp="warn"]');
		grid.innerHTML = '';
		zoomItems = [];

		if (!lastData || !Array.isArray(lastData.candidates) || lastData.candidates.length === 0) {
			warn.hidden = false;
			warn.textContent = 'No candidate peaks captured yet. Run Autofocus (AF) first.';
			if (!zoomBox.hidden) zoomBox.hidden = true;
			return;
		}
		if (positionShifted) {
			warn.hidden = false;
			warn.textContent = 'Lens moved manually after the last AF scan — re-run AF before jumping to a saved peak.';
		} else {
			warn.hidden = true;
		}

		const cands = lastData.candidates.slice();
		const numVal = v => (typeof v === 'number' && !Number.isNaN(v) ? v : -1);
		const byBytes = cands.slice().sort((a, b) => numVal(b.bytes) - numVal(a.bytes));
		const byFv = cands.slice().sort((a, b) => numVal(b.fv) - numVal(a.fv));
		const validBytes = cands.map(c => c.bytes).filter(v => typeof v === 'number' && v > 0);
		const minBytes = validBytes.length ? Math.min(...validBytes) : 0;
		const maxBytes = validBytes.length ? Math.max(...validBytes) : 0;
		const curPos = typeof lastData.current_pos === 'number' ? lastData.current_pos : null;

		byBytes.forEach((c, idx) => {
			const byteRank = idx + 1;
			const fvRank = byFv.findIndex(x => x.id === c.id) + 1;
			const isWinner = lastData.winner === c.id;
			const isMoving = busySelectId === c.id;
			const kb = c.bytes ? (c.bytes / 1024).toFixed(1) + ' KB' : 'n/a';
			const delta = curPos != null ? c.pos - curPos : null;
			const offsetText = delta == null ? (c.pos + ' ms') : (delta === 0 ? 'Current pos' : ((delta > 0 ? '+' : '') + delta + ' ms'));

			const card = document.createElement('div');
			card.className = 'mj-afp-card' + (isWinner ? ' winner' : '');

			const imgUrl = '/cgi-bin/j/af_candidates.cgi?img=' + c.id + '&v=' + cacheBust;
			const desc = explainCandidate(c, byteRank, fvRank, minBytes, maxBytes, cands.length);
			zoomItems.push({ id: c.id, byteRank: byteRank, kb: kb, fv: c.fv, imgUrl: imgUrl, offsetText: offsetText });

			card.innerHTML =
				'<div class="mj-afp-imgwrap" title="Click to inspect full size">' +
				'  <img src="' + imgUrl + '" loading="lazy" alt="Peak ' + c.id + '">' +
				'  <span class="mj-afp-badge' + (isWinner ? ' win' : '') + '">#' + byteRank + ' Sharpness' + (isWinner ? ' · Active' : '') + '</span>' +
				'</div>' +
				'<div class="mj-afp-body">' +
				'  <div class="mj-afp-stats">' +
				'    <span><strong>JPEG:</strong> ' + kb + '</span>' +
				'    <span><strong>FV:</strong> ' + c.fv + '</span>' +
				'    <span><strong>Pos:</strong> ' + offsetText + '</span>' +
				'  </div>' +
				'  <div class="mj-afp-desc"></div>' +
				'  <button type="button" class="mj-afp-btn ' + (isWinner ? 'active' : 'primary') + '" data-select="' + c.id + '">' +
				(isMoving ? 'Moving lens…' : (isWinner ? 'Focused Here' : 'Use This Focus')) +
				'  </button>' +
				'</div>';

			card.querySelector('.mj-afp-desc').textContent = desc;
			card.querySelector('.mj-afp-imgwrap').addEventListener('click', e => {
				e.stopPropagation();
				openZoom(idx);
			});

			const selBtn = card.querySelector('[data-select]');
			selBtn.disabled = positionShifted || busySelectId != null || curPos == null;
			selBtn.addEventListener('click', e => {
				e.stopPropagation();
				selectPeak(c.id);
			});

			grid.appendChild(card);
		});

		if (!zoomBox.hidden) renderZoom();
	}

	function selectPeak(id) {
		if (busySelectId != null || positionShifted) return;
		busySelectId = id;
		renderModal();
		apiFetch('/cgi-bin/j/af_candidates.cgi?select=' + encodeURIComponent(id), {
			method: 'POST',
			credentials: 'same-origin',
			cache: 'no-store'
		})
			.then(r => r.ok ? r.json() : Promise.reject())
			.then(res => {
				if (!res || !res.ok) throw new Error('select failed');
				return fetchCandidates(false);
			})
			.catch(() => {})
			.finally(() => {
				busySelectId = null;
				renderModal();
			});
	}

	function fetchCandidates(openAfter) {
		return apiFetch('/cgi-bin/j/af_candidates.cgi', {
			credentials: 'same-origin',
			cache: 'no-store'
		})
			.then(r => r.ok ? r.json() : null)
			.then(data => {
				if (data && Array.isArray(data.candidates)) {
					lastData = data;
					cacheBust = Date.now();
					updateBtnLabel(data);
					if (!modal.hidden) renderModal();
					if (openAfter && data.candidates.length > 1) {
						positionShifted = false;
						modal.hidden = false;
						renderModal();
					}
				}
			})
			.catch(() => {});
	}

	peaksBtn.addEventListener('click', e => {
		e.preventDefault();
		modal.hidden = false;
		renderModal();
		fetchCandidates(false);
	});
	modal.querySelector('[data-afp="close"]').addEventListener('click', () => { modal.hidden = true; });
	modal.querySelector('[data-afp="refresh"]').addEventListener('click', () => { fetchCandidates(false); });
	modal.addEventListener('click', e => { if (e.target === modal) modal.hidden = true; });

	zoomBox.querySelector('[data-afp="zprev"]').addEventListener('click', e => { e.stopPropagation(); stepZoom(-1); });
	zoomBox.querySelector('[data-afp="znext"]').addEventListener('click', e => { e.stopPropagation(); stepZoom(1); });
	zoomBox.querySelector('[data-afp="zuse"]').addEventListener('click', e => {
		e.stopPropagation();
		if (zoomPeakId != null) selectPeak(zoomPeakId);
	});
	zoomBox.querySelector('[data-afp="zclose"]').addEventListener('click', () => { zoomBox.hidden = true; });
	zoomBox.addEventListener('click', e => { if (e.target === zoomBox) zoomBox.hidden = true; });

	document.addEventListener('keydown', e => {
		if (zoomBox.hidden) return;
		if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); stepZoom(-1); }
		else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); stepZoom(1); }
		else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); zoomBox.hidden = true; }
	}, true);

	if (afBtn) {
		afBtn.addEventListener('click', () => {
			userClickedAf = true;
			positionShifted = false;
			modal.hidden = true;
			zoomBox.hidden = true;
		});
	}
	fn.querySelectorAll('[data-act="near"],[data-act="far"],[data-act="wide"],[data-act="tele"]').forEach(b => {
		b.addEventListener('pointerdown', () => {
			positionShifted = true;
			if (!modal.hidden) renderModal();
		});
	});

	function pollAfWatch() {
		apiFetch('/autofocus/status', { credentials: 'same-origin', cache: 'no-store' })
			.then(r => r.ok ? r.text() : '')
			.then(s => {
				const st = s.trim();
				if (st.startsWith('running')) {
					afRunning = true;
					setTimeout(pollAfWatch, 400);
					return;
				}
				if (afRunning && st.startsWith('done')) {
					afRunning = false;
					positionShifted = false;
					const shouldOpen = userClickedAf;
					userClickedAf = false;
					fetchCandidates(shouldOpen);
					return;
				}
				afRunning = false;
			})
			.catch(() => {});
	}

	fetchCandidates(false);
	setInterval(pollAfWatch, 2000);
})();
