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
	//
	// Any other unit is a setting's own bound or value rather than a reading,
	// so it is printed as the camera declared it: a whole number as one, a
	// fraction to four significant figures (a lamp curve of 0.2, a heading of
	// 12.5°) rather than rounded to a number nobody set.
	function fmt(v, unit) {
		if (!isNum(v)) return '';
		if (unit === '×') return String(Number(v.toFixed(1)));
		if (unit === 'ms') return String(Number(v.toPrecision(3)));
		if (unit === 'levels' || unit === 'frames') return String(Math.round(v));
		if (Number.isInteger(v)) return String(v);
		return String(Number(v.toPrecision(4)));
	}

	// Units written against the figure rather than a space apart, as a
	// person writes them: 31.6×, 95%, 610‰, 45°. Everything else is a word or
	// an abbreviation and takes a space: 100 ms, 300 s, 1024 KiB.
	const TIGHT = { '×': true, '%': true, '‰': true, '°': true };

	// The unit beside a figure in running text: "31.6×" but "100 ms".
	function withUnit(v, unit) {
		const n = fmt(v, unit);
		if (!n || !unit) return n;
		return TIGHT[unit] ? n + unit : n + ' ' + unit;
	}

	// A declared range in running text, the unit said once: "1–300 s",
	// "0–100%", "-45–45°". Empty when either end is not a number.
	function rangeText(min, max, unit) {
		if (!isNum(min) || !isNum(max)) return '';
		return fmt(min, unit) + '–' + withUnit(max, unit || '');
	}

	// A value of a number field that names a mode rather than a quantity —
	// 0 on a de-jitter buffer is Passthrough, -1 on dehaze is the image
	// profile's — as the camera names it in x-special. '' for an ordinary
	// value, and for text that is not a number: an empty box is unset, not 0.
	function specialFor(sub, v) {
		const map = sub && sub['x-special'];
		if (!map || typeof map !== 'object') return '';
		if (v === '' || v === null || v === undefined) return '';
		const n = Number(v);
		if (!Number.isFinite(n)) return '';
		const t = map[String(n)];
		return typeof t === 'string' ? t : '';
	}

	// Every named value, for the line under the control: "0: Passthrough",
	// "-1: From the image profile · 0: Off". In value order, so a reader
	// scanning the range meets them where they sit on it. The bare number,
	// not the number in its unit: "0 s: 5 s, the default" reads as a sum.
	function specialsText(sub) {
		const map = sub && sub['x-special'];
		if (!map || typeof map !== 'object') return '';
		return Object.keys(map)
			.filter(k => Number.isFinite(Number(k)) && typeof map[k] === 'string')
			.sort((a, b) => Number(a) - Number(b))
			.map(k => String(Number(k)) + ': ' + map[k])
			.join(' · ');
	}

	// Whether a number field is a slider, and its track. A slider is the
	// control for a range someone can sweep a thumb across and land on the
	// value they meant: at most a hundred steps. Past that a box is kinder —
	// one pixel of drag would be several values. The step is the camera's
	// (x-step) for a decimal, 1 for a whole number, and a decimal with no
	// declared step is not a slider at all: any grain the page picked would
	// refuse values the camera accepts.
	const SLIDER_STEPS = 100;
	function sliderOf(sub) {
		if (!sub) return null;
		const int = sub.type === 'integer';
		if (!int && sub.type !== 'number') return null;
		if (!isNum(sub.maximum)) return null;
		const min = isNum(sub.minimum) ? sub.minimum : (int ? 0 : null);
		if (min === null) return null;
		const xs = sub['x-step'];
		const step = isNum(xs) && xs > 0 ? xs : (int ? 1 : null);
		if (step === null) return null;
		const steps = (sub.maximum - min) / step;
		if (!(steps > 0) || steps > SLIDER_STEPS + 1e-9) return null;
		return { min: min, max: sub.maximum, step: step };
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

	// What a delay in frames amounts to, for the figure beside the box. Zero is
	// "no delay": correct as "≈ 0 s at 25 fps", but that reads as a sum
	// somebody forgot to finish.
	function delayText(n, fps) {
		if (isNum(n) && n === 0) return 'no delay';
		return framesToSeconds(n, fps);
	}

	const api = { isAuto, delayText, matched, titleFor, reading, fmt, withUnit, rangeText, specialFor, specialsText, sliderOf, autoText, framesToSeconds };
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticExposure = api;
})();
