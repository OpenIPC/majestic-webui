// What a number field the camera can run by itself should say while nobody
// has set it, and what its name is in the mode the camera is in.
//
// The exposure ceilings and the metering knobs used to draw 0 or an empty
// box, and both meant "the camera decides" (#582). 0 reads as "off", an empty
// box as "not loaded", and neither says what the camera is actually doing. The
// daemon now publishes three things on such a field, and this turns them into
// words:
//
//   x-unit        what the number is in: "ms", "×", "levels", "frames".
//   x-title-when  the field's name in another mode, in visibleWhen's spelling.
//                 isp.aGain is "Highest analog gain" while auto-exposure
//                 spends it and "Analog gain" in manual, where it is the value.
//   x-metric      which /metrics gauges read it `now` and `inForce`, and the
//                 `scale` that turns either into the field's own unit.
//
// The scale is the daemon's on purpose. A gain gauge is Q10 on HiSilicon and
// something else elsewhere, and a page that guessed would print a confident
// wrong multiplier on the next part (docs/settings-page.md).
//
// Its own file, and pure, for the reason mj-fps.js is: this fails silently. A
// placeholder that says "Auto · 0.03×" is still a placeholder, and a name that
// stays "Highest analog gain" in manual mode still looks like a name.
// tests/exposure.test.js is what can ask it.
(() => {
	'use strict';

	function isNum(v) { return typeof v === 'number' && isFinite(v); }

	// Empty, absent and 0 are one request on these keys: every one of them
	// hands the setting back to the camera. The daemon says so in each hint,
	// and it is why a stored 0 draws as Auto rather than as a number.
	function isAuto(v) {
		if (v === undefined || v === null) return true;
		const s = String(v).trim();
		return s === '' || Number(s) === 0;
	}

	// The condition in force, or null. `valueOf(field)` answers with the
	// sibling's current value, so the page can pass the live control rather
	// than the config it loaded with: the name has to change as the mode
	// select does, not after a save.
	function matched(sub, valueOf) {
		const list = sub && Array.isArray(sub['x-title-when']) ? sub['x-title-when'] : [];
		for (const c of list) {
			if (!c || typeof c.field !== 'string') continue;
			const v = valueOf(c.field);
			if (v !== undefined && v !== null && String(v) === String(c.equals)) return c;
		}
		return null;
	}

	function titleFor(sub, valueOf, fallback) {
		const c = matched(sub, valueOf);
		if (c && c.title) return c.title;
		return (sub && (sub.title || sub.description)) || fallback || '';
	}

	// A gauge in the field's unit, or null when there is no reading. Never 0
	// for an absent gauge: a ceiling that read 0 would say "no gain allowed",
	// which is a fact about a camera and not what a missing metric means.
	function reading(values, name, scale) {
		if (!values || !name) return null;
		const v = values[name];
		if (!isNum(v)) return null;
		return v * (isNum(scale) && scale > 0 ? scale : 1);
	}

	// A number the way the row prints it. Gains to one decimal, because a
	// sensor's gain steps are finer than anyone reads and 31.6 is the figure
	// that matters; milliseconds to three significant figures, because a
	// daylight exposure lives below one and a night one near a hundred; counts
	// as whole numbers.
	function fmt(v, unit) {
		if (!isNum(v)) return '';
		if (unit === '×') return String(Number(v.toFixed(1)));
		if (unit === 'ms') return String(Number(v.toPrecision(3)));
		return String(Math.round(v));
	}

	// The unit beside a figure in running text: "31.6×" but "100 ms".
	function withUnit(v, unit) {
		const n = fmt(v, unit);
		if (!n || !unit) return n;
		return unit === '×' ? n + unit : n + ' ' + unit;
	}

	// The placeholder. The unit is not repeated: the row prints it beside the
	// box, so "Auto · 32" sits next to "×".
	function autoText(inForce, unit) {
		return isNum(inForce) ? 'Auto · ' + fmt(inForce, unit) : 'Auto';
	}

	// A frame count as time, at the rate the stream is set to. Approximate on
	// purpose, and it says the rate it assumed: slow shutter lowers the
	// sensor's rate at night, and a delay counted in frames gets longer with it.
	function framesToSeconds(n, fps) {
		if (!isNum(n) || n < 0 || !isNum(fps) || fps <= 0) return null;
		const s = n / fps;
		const txt = s === 0 ? '0' : s < 10 ? String(Number(s.toPrecision(2))) : String(Math.round(s));
		return '≈ ' + txt + ' s at ' + fps + ' fps';
	}

	const api = { isAuto, matched, titleFor, reading, fmt, withUnit, autoText, framesToSeconds };
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticExposure = api;
})();
