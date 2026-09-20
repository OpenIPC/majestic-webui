// What automatic tone tuning is doing, in a sentence — and which knobs the
// camera is currently holding away from the operator's own values.
//
// Separate from mj-settings.js, and tested, for the reason ircut-check.js is:
// this renders a confident sentence whichever branch it takes, so a wrong
// branch reads exactly like a right one. "Nothing to do — the picture already
// fills the range" is what a reader sees when the controller is in fact
// standing down for low light, and nothing on screen contradicts it. Reaching
// the interesting branches on a real camera needs fog, darkness, or a scene
// that clips — none of which can be produced on demand.
//
// The gauges come from majestic's /metrics, lifted by main.js. Every one of
// them is ABSENT rather than zero when the controller is not running or has
// not measured, which is the whole reason this file talks about null: a span
// of 0 is a black picture and a missing span is no measurement, and a panel
// that shows the first when it means the second is worse than a blank one.
//
// Absent is not the same as off, either. Whether the feature is ON is the
// image.tuning switch's answer and is passed in; the gauges only say what it
// is DOING. Every result carries `known` -- whether this page can say
// anything at all -- and `measuring` -- whether the numbers beside the
// sentence describe the picture at this moment rather than some earlier one.
(function () {
	'use strict';

	// image_tune_state, as the daemon defines it. Kept here as names because a
	// bare 2 in a branch is unreadable, and because the mapping is the thing
	// most likely to drift if the daemon grows a verdict.
	const UNAVAILABLE = 0, IDLE = 1, WORKING = 2, HOLDING = 3, LOWLIGHT = 4;
	// Not one of the policy's verdicts: the driver publishes it while it is
	// standing aside for somebody adjusting the picture by hand. It matters
	// here because in that state NOTHING is being measured, so every other
	// gauge is the last reading taken before the pause began — and a page
	// that reads them as current states a span minutes out of date as the
	// picture's own. Observed doing exactly that.
	const PAUSED = 5;

	// The four knobs the controller drives, paired with the config key whose
	// saved value is the baseline it works from and returns to. isp.dehaze is
	// not one of the Live strip's sliders — it lives on the Image page — but
	// it is the actuator that does the most here, so leaving it out would
	// under-report what the camera is doing.
	const KNOBS = [
		{ gauge: 'dehaze', dot: 'isp.dehaze', label: 'dehaze' },
		{ gauge: 'contrast', dot: 'image.contrast', label: 'contrast' },
		{ gauge: 'luminance', dot: 'image.luminance', label: 'brightness' },
		{ gauge: 'saturation', dot: 'image.saturation', label: 'saturation' },
	];

	// ppm -> a percentage a person reads. 15000 ppm is 1.5%, and the budgets
	// the controller applies are in that range, so one decimal is the
	// resolution worth printing: 0.1% steps are what "backing off" looks like.
	function pct(ppm) {
		return (ppm / 10000).toFixed(1) + '%';
	}

	// Which knobs the camera is holding away from the operator's saved value.
	//
	// `saved` answers a dotted key with the number the settings page holds, or
	// null/undefined when the page does not know it — an operator on a build
	// without isp.dehaze, or a form not mounted yet. An unknown baseline
	// cannot be compared, so the knob is simply not reported: claiming a knob
	// has moved when the comparison was against nothing is the one thing this
	// must not do.
	function moved(s, saved) {
		const out = [];
		for (let i = 0; i < KNOBS.length; i++) {
			const k = KNOBS[i];
			const live = s ? s[k.gauge] : null;
			if (live == null) continue;
			const base = saved ? saved(k.dot) : null;
			if (base == null || base === '') continue;
			if (Number(base) === Number(live)) continue;
			out.push({ key: k.gauge, dot: k.dot, label: k.label,
				live: Number(live), base: Number(base) });
		}
		return out;
	}

	// The sentence. Shaped like the Scene line beside it — a bold head, an em
	// dash, a tail — because they answer neighbouring questions about the same
	// four knobs and should not read as two different kinds of statement.
	//
	// `tone` is for the pip beside it: 'off' grey, 'ok' quiet, 'work' active,
	// 'warn' for the two standing-down states, which are the ones where the
	// camera is deliberately NOT doing what the operator switched it on for.
	// `autoOn` is what the settings page knows about the image.tuning switch:
	// true, false, or null where it cannot say. It is asked for because an
	// absent state gauge is NOT evidence that tuning is off — a camera whose
	// build predates these metrics can have the feature enabled and publish
	// none of them, and answering "Off" there is a confident lie printed
	// beside a lit Automatic chip. The switch is the only thing that actually
	// knows, so the two are separated: the gauge says what it is DOING, the
	// switch says whether it is ON.
	//
	// `measuring` tells the caller whether the numbers beside this sentence
	// describe the picture right now. False while paused and whenever the
	// state is unknown, because in both the gauges are a reading from some
	// earlier moment.
	function describe(s, saved, autoOn) {
		if (!s || s.state == null) {
			if (autoOn === false)
				return { on: false, known: true, measuring: false, tone: 'off',
					head: 'Off', tail: 'the camera is not tuning itself',
					moved: [] };
			if (autoOn === true)
				return { on: true, known: false, measuring: false,
					tone: 'warn', head: 'No answer',
					tail: 'the camera is not reporting what it is doing',
					moved: [] };
			return { on: false, known: false, measuring: false, tone: 'off',
				head: '', tail: '', moved: [] };
		}

		const mv = moved(s, saved);
		// Read once here rather than in four branches: every sentence below
		// that mentions a number has to survive that number being absent.
		const span = s.span, headroom = s.headroom;
		const clip = [];
		if (s.clipLo != null && s.clipLo > 0) clip.push(pct(s.clipLo) + ' crushed');
		if (s.clipHi != null && s.clipHi > 0) clip.push(pct(s.clipHi) + ' blown');

		switch (s.state) {
		case PAUSED:
			// Says nothing about the picture, and reports no knob as moved.
			// Every gauge to hand describes the scene as it was before the
			// operator started moving things -- including the four actuator
			// values, which would otherwise keep painting marks and
			// read-outs that claim to be where the camera is now.
			return { on: true, known: true, measuring: false, tone: 'off',
				head: 'Paused',
				tail: 'standing aside while you adjust the picture',
				moved: [] };
		case UNAVAILABLE:
			// On, and has nothing to go on. Said plainly rather than dressed
			// as calm: a camera whose sampling source never answers sits here
			// for ever, and "nothing to do" would hide that completely.
			return { on: true, known: true, measuring: true, tone: 'warn', head: 'No reading',
				tail: 'nothing measurable from the picture yet', moved: mv };
		case IDLE:
			return { on: true, known: true, measuring: true, tone: 'ok', head: 'Nothing to do',
				tail: span == null
					? 'the picture already fills the range'
					: 'the picture already spans ' + span + ' of 255',
				moved: mv };
		case WORKING:
			return { on: true, known: true, measuring: true, tone: 'work', head: 'Lifting the picture',
				tail: mv.length
					? mv.map(m => m.label + ' ' + m.live).join(', ')
					: (span == null ? 'reaching for more range'
						: 'span ' + span + ', reaching for more'),
				moved: mv };
		case HOLDING:
			return { on: true, known: true, measuring: true, tone: 'warn', head: 'Holding back',
				tail: clip.length
					? 'stretching further would clip — ' + clip.join(' and ')
					: 'stretching further would start clipping',
				moved: mv };
		case LOWLIGHT:
			return { on: true, known: true, measuring: true, tone: 'warn', head: 'Too dark to help',
				tail: headroom == null
					? 'the sensor gain is too high to stretch without amplifying noise'
					: 'the sensor gain leaves ' + headroom +
						'% of the range, so it has given the picture back',
				moved: mv };
		}
		// A verdict this build does not know. Not silence: the camera is
		// running something, and a panel that goes blank on an unrecognised
		// number looks identical to one whose camera stopped.
		return { on: true, known: true, measuring: false, tone: 'off',
			head: 'Tuning',
			tail: 'the camera reports a state this page does not know (' +
				s.state + ')', moved: mv };
	}

	// Where the controller's measurement sits on the 0..255 luma axis the
	// histogram draws, as fractions of the width, so the overlay can be laid
	// on the SVG without it knowing anything about spans or percentiles.
	//
	// The camera reports a span, not the two ends of it, so the bracket is
	// centred on the measured mean where there is one and on the middle
	// otherwise. It is an indication of WIDTH — that is the quantity the
	// controller is working on — and drawing it anywhere implies a position it
	// does not have, so the caller is told which of the two it got.
	function spanBand(s) {
		if (!s || s.span == null) return null;
		const w = Math.max(0, Math.min(255, s.span)) / 255;
		const mid = 0.5;
		let lo = mid - w / 2, hi = mid + w / 2;
		if (lo < 0) { hi -= lo; lo = 0; }
		if (hi > 1) { lo -= hi - 1; hi = 1; }
		return { lo: Math.max(0, lo), hi: Math.min(1, hi), span: s.span };
	}

	const api = {
		describe: describe,
		moved: moved,
		spanBand: spanBand,
		KNOBS: KNOBS,
		STATE: { UNAVAILABLE, IDLE, WORKING, HOLDING, LOWLIGHT, PAUSED },
	};
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticToneCheck = api;
})();
