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
	// 'warn' where the camera cannot do what the operator switched it on for.
	// HOLDING is deliberately NOT one of those: it is the controller having
	// found this scene's limit and stopped at it, which is the feature
	// working, not failing. Only low light and a sampler that never answers
	// are states where the answer is "it cannot help you here".
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
	//
	// Each verdict is written the way #581 asked: `head` says what the owner is
	// looking at, `tail` what to do about it -- "nothing" is an answer, and the
	// common one -- and `why` carries the reason in the camera's terms, which
	// the page keeps behind a "?" so the first line stays readable. A tail that
	// explained the mechanism ("the sensor is amplifying, so widening would
	// only add noise") was accurate and told nobody what to do next.
	function describe(s, saved, autoOn) {
		if (!s || s.state == null) {
			if (autoOn === false)
				return { on: false, known: true, measuring: false, tone: 'off',
					head: 'Off', tail: 'set the picture with the sliders',
					why: 'Automatic tuning is switched off, so contrast and haze ' +
						'correction stay where the sliders put them.',
					moved: [] };
			if (autoOn === true)
				return { on: true, known: false, measuring: false,
					tone: 'warn', head: 'No answer',
					tail: 'reload the page if this lasts',
					why: 'Automatic tuning is on, but the camera is not reporting ' +
						'what it is doing.',
					moved: [] };
			return { on: false, known: false, measuring: false, tone: 'off',
				head: '', tail: '', why: '', moved: [] };
		}

		const mv = moved(s, saved);

		switch (s.state) {
		case PAUSED:
			// Says nothing about the picture, and reports no knob as moved.
			// Every gauge to hand describes the scene as it was before the
			// operator started moving things -- including the four actuator
			// values, which would otherwise keep painting marks and
			// read-outs that claim to be where the camera is now.
			return { on: true, known: true, measuring: false, tone: 'off',
				head: 'Paused',
				tail: 'it resumes on its own',
				why: 'The camera stands aside while its picture settings are ' +
					'being changed, so it does not fight the change. Its ' +
					'readings are from before the pause, so none are shown.',
				moved: [] };
		case UNAVAILABLE:
			// On, and has nothing to go on. Said plainly rather than dressed
			// as calm: a camera whose sampling source never answers sits here
			// for ever, and "nothing to do" would hide that completely.
			return { on: true, known: true, measuring: true, tone: 'warn', head: 'No reading',
				tail: 'if this lasts, check that the video stream is running',
				why: 'Automatic tuning is on but has nothing measurable from the ' +
					'picture yet.',
				moved: mv };
		case IDLE:
			return { on: true, known: true, measuring: true, tone: 'ok', head: 'Picture is fine',
				tail: 'nothing to do',
				why: 'The picture already uses the brightness range it has, so the ' +
					'camera is changing nothing.',
				moved: mv };
		case WORKING:
			// The moved knobs, when there are any, because they are the one
			// thing here the figures below do NOT say: the figures describe
			// the picture, this describes what is being done to it.
			return { on: true, known: true, measuring: true, tone: 'work',
				head: 'Improving a flat picture',
				tail: 'nothing to do',
				why: 'The camera is widening contrast and haze correction so the ' +
					'picture uses more of its brightness range' +
					(mv.length ? ': ' + mv.map(m => m.label + ' ' + m.live).join(', ') +
						' now.' : '.'),
				moved: mv };
		case HOLDING:
			// Reached its limit, which is a GOOD outcome dressed as a bad one
			// by the old wording: "Holding back -- stretching further would
			// clip -- 2.1% crushed and 0.3% blown" reads as a fault report,
			// names a failure mode in jargon, and quotes two numbers that
			// mean nothing without the budgets they are measured against,
			// which this page does not have and should not learn. The picture
			// is as good as this scene allows; the two shares are on the
			// Shadows and Highlights figures, labelled, for anyone who wants
			// to see which end ran out first.
			return { on: true, known: true, measuring: true, tone: 'ok',
				head: 'As good as this scene gets',
				tail: 'nothing to do',
				why: 'Stretching the picture any further would lose detail in the ' +
					'shadows or the highlights; the figures below show which end ' +
					'ran out.',
				moved: mv };
		case LOWLIGHT:
			// The one verdict with something to DO, and the thing to do is
			// light: the picture has run out of it, and no setting on this
			// card makes more.
			return { on: true, known: true, measuring: true, tone: 'warn',
				head: 'Too dark to improve',
				tail: 'add light: switch to Night mode or turn on the lamp',
				why: 'The sensor is already amplifying the picture, so widening ' +
					'it would only add noise.',
				moved: mv };
		}
		// A verdict this build does not know. Not silence: the camera is
		// running something, and a panel that goes blank on an unrecognised
		// number looks identical to one whose camera stopped.
		return { on: true, known: true, measuring: false, tone: 'off',
			head: 'Tuning',
			tail: 'the camera reports a state this page does not know (' +
				s.state + ')', why: '', moved: mv };
	}

	// The measurement behind the sentence, as figures a person can read.
	//
	// The sentence is the verdict and these are the evidence under it, which
	// is why NO number appears in both: a figure repeated two lines below its
	// own label is furniture, and the sentence that has to carry it cannot
	// then be written in plain words. This is also where the two clipping
	// shares belong -- labelled Shadows and Highlights, beside the range they
	// are the price of -- rather than inside a sentence as "4.1% crushed".
	//
	// `measuring` is the describe() result's own flag and gates the whole
	// row, because PAUSED freezes every gauge here at its last value: four
	// numbers under a "standing aside" sentence, each real and none of them
	// true any more, is the exact failure this subsystem already has a state
	// for. Absent, not zero, per gauge for the same reason the sample keeps
	// them null -- a span of 0 is a black picture and a missing span is no
	// measurement.
	//
	// The fourth figure is the controller's HEADROOM, not a sensor gain.
	// isp_again / isp_dgain are raw vendor numbers -- Q10 on HiSilicon,
	// something else on Ingenic, and absent on most parts -- so a gain
	// printed here would be a unit guess that reads as fact on the vendors it
	// is wrong for. image_tune_headroom is the daemon's own vendor-neutral
	// answer to the same question, already derived from both gains, and it is
	// what the controller actually acts on.
	function figures(s, measuring) {
		if (!s || !measuring) return [];
		const out = [];
		// Named for what they mean to someone looking at the picture (#581):
		// "Range in use 84 of 255" was a luma span on a scale nobody reading
		// it has, and "Sensor headroom" a controller's term for how much light
		// is left before the sensor starts amplifying.
		if (s.span != null)
			out.push({ key: 'span', label: 'Brightness range used',
				value: Math.round(Math.max(0, Math.min(255, s.span)) / 255 * 100) + '%' });
		if (s.clipLo != null)
			out.push({ key: 'clipLo', label: 'Lost in shadows',
				value: pct(s.clipLo) });
		if (s.clipHi != null)
			out.push({ key: 'clipHi', label: 'Lost in highlights',
				value: pct(s.clipHi) });
		if (s.headroom != null)
			out.push({ key: 'headroom', label: 'Light to spare',
				value: s.headroom + '%' });
		return out;
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
		figures: figures,
		moved: moved,
		spanBand: spanBand,
		KNOBS: KNOBS,
		STATE: { UNAVAILABLE, IDLE, WORKING, HOLDING, LOWLIGHT, PAUSED },
	};
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticToneCheck = api;
})();
