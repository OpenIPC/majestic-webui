// The Live page's answer to a camera that has nothing to show.
//
// This page is where a newly claimed camera now lands, which means it is where
// a camera that came up wrong is first met -- and the commonest way that
// happens is invisible to every part of the player: majestic runs, the stream
// negotiates, the picture plays, and the picture is black (video-check.js
// carries the measurements). Nothing in the fallback chain fires, because
// nothing failed. So the disclosure cannot come from the player; it has to come
// from looking at what the player is showing.
//
// Both signals are already on the wire. The camera's own exposure gauges ride
// the /metrics heartbeat main.js polls every 2s on every page, and the picture
// is decoded in the <video> element, where mj-luma.js reads a 160x90 thumbnail
// off a canvas -- the same trick the Live adjustments histogram uses, for the
// same reason: it costs the camera nothing and there is no endpoint to add.
// Nothing here polls anything of its own.
//
// A separate file from preview-page.js because that file is executed in a bare
// `vm` by tests/auto-source.test.js and tests/staging.test.js, and everything
// below touches `location`, `sessionStorage` and the heartbeat. It needs
// nothing from preview-page.js in return: the visible media element is found
// on the stage, so the two never speak.
(function () {
	'use strict';

	const stage = document.getElementById('mj-stage');
	const VC = window.MajesticVideoCheck;
	if (!stage || !VC) return;

	// Where a hand-off is remembered. Per tab, and the reason it exists is the
	// Back button: without it, Back from the Dashboard lands here, finds the
	// same fault, and bounces straight off again -- a viewer could never reach
	// the Live page of a camera with a dark picture. Spent once, this page
	// states the finding and stays put.
	const ONCE = 'mj-novideo';
	function seen() {
		try { return sessionStorage.getItem(ONCE) !== null; } catch (e) { return false; }
	}
	function mark(code) {
		try { sessionStorage.setItem(ONCE, code); } catch (e) {}
	}

	const alertEl = document.getElementById('mj-blind');
	const alertWhy = document.getElementById('mj-blind-why');
	const alertAct = document.getElementById('mj-blind-act');
	const alertHelp = document.getElementById('mj-blind-help');

	let cfg = {};
	if (typeof mjConfig === 'function') {
		mjConfig().then((c) => { cfg = c || {}; }).catch(() => {});
	}

	const track = VC.tracker();
	let trackNow = { blindS: 0, blind: null };
	let picNow = null;
	let shown = null;
	// Declared with everything else it is read beside, not next to the
	// subscription below: MajesticLuma.start() samples once synchronously, so
	// decide() can run before the bottom of this file has been evaluated, and a
	// `let` down there would still be in its dead zone when it did.
	let lastSample = null;

	function now() { return performance.now() / 1000; }

	// The media elements come and go -- the MSE player replaces its <video> on
	// every reconnect and the transport swap keeps two slots -- so the visible
	// one is re-queried rather than held, exactly as preview-zoom.js does. A
	// held reference is a detached node within a session, and a detached node
	// samples black for ever.
	function visibleMedia() {
		const els = stage.querySelectorAll('.mj-stage-media');
		for (let i = 0; i < els.length; i++) {
			const e = els[i];
			if (e.tagName === 'IMG') continue; // the MJPEG fallback is jpeg.size, not the stream
			if (getComputedStyle(e).display !== 'none') return e;
		}
		return null;
	}

	if (window.MajesticLuma) {
		// 1 Hz. The run this feeds is ten seconds long, so ten samples decide
		// it; four a second would buy nothing but readbacks.
		window.MajesticLuma.start({
			video: visibleMedia,
			hz: 1,
			onData: function (h) {
				picNow = { blackS: track.picture(VC.look(h), now()) };
				decide();
			},
		});
	}

	function render(f) {
		// Toggled rather than rebuilt: the sentence is long, and re-writing it
		// every two seconds would restart a screen reader part-way through
		// reading it out. Keyed on the WORDS and not on the finding's code,
		// because one code has several sentences — the exposure gauges reach a
		// verdict before the picture run does, so a `blind` finding that starts
		// as "the sensor reports no light" becomes "the picture is black AND
		// the sensor reports no light" a few seconds later. Keyed on the code
		// alone that upgrade never landed, and the page went on stating the
		// weaker half of what it knew.
		const key = f && (f.code + f.detail);
		if (shown === key) return;
		shown = key;
		if (!alertEl) return;
		if (!f) { alertEl.style.display = 'none'; return; }
		if (alertWhy) alertWhy.textContent = f.title + ' — ' + f.detail;
		if (alertAct) {
			alertAct.textContent = f.act.label + ' →';
			alertAct.href = f.act.href;
			// Assigned rather than added, so a repaint replaces the prompt
			// instead of stacking another one. See the same line in status.js:
			// main.js wires `.confirm` at load and this link is written later.
			alertAct.onclick = f.act.confirm
				? (ev) => { if (!confirm(f.act.confirm)) ev.preventDefault(); }
				: null;
		}
		if (alertHelp) {
			alertHelp.hidden = !f.help;
			if (f.help) {
				alertHelp.textContent = f.help.label + ' →';
				alertHelp.href = f.help.href;
			}
		}
		alertEl.style.display = '';
	}

	function decide() {
		const f = VC.diagnose(cfg, lastSample, trackNow, picNow);
		render(f);
		if (!f || !f.conclusive || seen()) return;
		// Not while nobody is looking. A background tab that navigates itself
		// is a tab whose Back history the viewer never agreed to, and the
		// finding will still be here -- and still true -- when they return.
		if (document.hidden) return;
		mark(f.code);
		// replace(), not assign(): this page would decide the same thing again
		// on the way back, and leaving it in history as an entry that
		// re-triggers is the trap the one-shot above exists to close.
		location.replace('status.cgi?novideo=' + encodeURIComponent(f.code));
	}

	if (typeof mjMetricsSubscribe === 'function') {
		mjMetricsSubscribe(function (s) {
			lastSample = s;
			trackNow = track.push(s, now());
			decide();
		});
	}
})();
