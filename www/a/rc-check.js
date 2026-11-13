// Is the encoder honouring the bitrate and frame rate it was given?
//
// The camera answers that itself, and this file deliberately does not
// second-guess it. venc0_rc_state is a verdict the daemon reaches over a thirty
// second window with its own hysteresis, and it is the same verdict that goes
// into the camera log. Re-deriving one here from the byte counter would smooth
// an already-smoothed number, disagree with the log the moment the two drifted,
// and give an operator two answers to the same question.
//
// So the work here is translation, not judgement: a small integer into a
// sentence somebody can act on, and silence when the camera has no opinion.
//
// The fault this exists for, measured on a lab hi3516ev300 + imx335 watching a
// real outdoor scene at 1920x1080, H.264, 12 fps, CBR 1024 kbit -- one setting
// apart:
//
//   maxQp 42   ->   758 kbit/s, mean QP 31
//   maxQp 30   ->  4237 kbit/s, every frame pinned at the ceiling
//
// A quantiser ceiling set too low is the only way a CBR channel sustains far
// past its target; healthy CBR came in at or under 118% of target across three
// very different scenes. The camera cannot compress harder than the ceiling
// allows, so it overshoots instead, and nothing in the picture says why.
//
// A separate file, and tested, for the reason ircut-check.js and video-check.js
// are: it renders a confident sentence whichever branch it takes, a wrong
// branch reads exactly like a right one, and reaching the interesting branches
// needs a camera that has been misconfigured on purpose.
(function () {
	'use strict';

	// The daemon's verdict, in the order it publishes. Absent means the camera
	// has no opinion -- the window has not filled, the channel is off, or the
	// mode is avbr, which is defined to drift and so cannot break a promise
	// about its rate. Absent is also what an older camera says about all of it.
	const OK = 0, MARGINAL = 1, OVER = 2, STARVED = 3;

	// Which channel a reading belongs to. Only the main stream is rendered on
	// the dashboard, but the keys are per channel and the sub stream reads the
	// same way, so the lookup takes one.
	function readState(v, chn) {
		if (!v) return null;
		const k = 'venc' + chn + '_rc_state';
		// A missing gauge is null, never 0: 0 is a real verdict here, and the
		// most flattering one. Conflating the two would report every camera too
		// old to publish this as healthy.
		return (k in v) ? v[k] : null;
	}

	function readNum(v, key) {
		return (v && (key in v)) ? v[key] : null;
	}

	// Settings are named the way the form names them, not by their dotted
	// keys. An operator reads a finding on the page that holds the control;
	// "video0.maxQp" is the daemon's word for it and the camera log's, and it
	// is not what the field beside the sentence is labelled. Matches how
	// ircut-check.js words its findings.
	const CEILING = '"Most compression allowed (QP)"';

	function stream(chn) {
		return chn === 0 ? 'main stream' : 'sub stream';
	}

	// One finding, or null when there is nothing to say.
	//
	// `s` is the heartbeat sample. `cfg` supplies what the camera was asked
	// for -- the bitrate and frame rate the sentences quote back, because a
	// verdict without the number it was measured against is not actionable.
	function diagnose(s, cfg, chn) {
		if (!s || !s.ok) return null;
		const c = (typeof chn === 'number') ? chn : 0;
		const v = s.m && s.m.v;
		const state = readState(v, c);
		// Only the verdicts this file knows how to explain. A newer camera
		// publishing a fourth state, or a malformed one, would otherwise fall
		// through to the rate branch and be given confident advice about a
		// diagnosis it never made.
		if (state !== MARGINAL && state !== OVER && state !== STARVED)
			return null;

		const setKbps = cfg ? cfg.bitrate : null;
		const setFps = cfg ? cfg.fps : null;
		const meanQp = readNum(v, 'venc' + c + '_mean_qp');
		const maxQp = readNum(v, 'venc' + c + '_max_qp');

		if (state === STARVED) {
			// Not a rate-control fault at all, and saying so matters: an
			// operator told "your encoder is over its bitrate" about a camera
			// being handed four frames a second will go and change the wrong
			// setting. The sensor is the limit here, not the encoder.
			return {
				code: 'starved', level: 'warning',
				title: 'The camera is not delivering the frame rate it was set to',
				detail: 'The encoder is receiving far fewer frames than the ' +
					stream(c) + ' asks for' +
					(setFps ? ' (' + setFps + ' fps)' : '') +
					'. In low light the sensor holds the shutter open longer ' +
					'than one frame period and slows down to suit, which is ' +
					'normal after dusk and fixes itself at dawn. If it happens ' +
					'in daylight, the exposure limit is what to look at.',
				act: { href: 'camera.cgi?tab=isp', label: 'Open Image settings' },
			};
		}

		// Over its rate, or drifting toward it.
		//
		// There is no "it still has compression in reserve" branch here, and
		// the first draft had one: it compared the mean quantiser against the
		// ceiling and, when the mean sat a few steps below, told the operator
		// the scene was simply too busy and to raise the bitrate. That advice
		// was measured wrong. On a gk7205v200 running 10 Mbit/s against a
		// configured 128, the MEAN read 27 against a ceiling of 30 while the
		// vendor's own rate-control counters showed the working quantiser
		// pinned at 30 for every frame. The mean is an average over a whole
		// picture, easy regions included, so it sits below a ceiling that is
		// nonetheless binding -- and a sentence drawn from it sent somebody to
		// the wrong setting with complete confidence.
		//
		// A constant-bitrate channel that sustains far past its target has run
		// out of quantiser; that is the only way it happens. So the ceiling is
		// named whenever there is one to raise, and the mean is reported as
		// evidence rather than used as a test.
		//
		// The one real exception is a ceiling already at the top of the range,
		// where there is nothing left to raise and the rate itself has to move.
		// That is a fact about the setting, not a threshold picked by eye.
		// Both readings or neither. They arrive from the same optional vendor
		// hook, but nothing here may ASSUME they are published together: a
		// camera offering the ceiling without the mean would otherwise have
		// "quantiser null" rendered at an operator as though it were measured.
		const haveQp = (meanQp !== null && maxQp !== null);
		const atLimit = (haveQp && maxQp >= 51);
		const over = state === OVER;

		let detail = 'The ' + stream(c) + ' is producing more than its ' +
			'bitrate allows' + (setKbps ? ' (' + setKbps + ' kbit/s)' : '') +
			'. ';
		if (atLimit) {
			detail += CEILING + ' is already at 51, the most compression the ' +
				'encoder allows, so there is no headroom left to give it. ' +
				'This scene needs a higher bitrate, a smaller frame, or fewer ' +
				'frames per second.';
		} else if (haveQp) {
			detail += 'It is averaging quantiser ' + meanQp + ' against a ' +
				'ceiling of ' + maxQp + ', and on a constant-bitrate channel ' +
				'running out of quantiser is what an overshoot means. Raising ' +
				CEILING + ' is what lets rate control reach the number.';
		} else {
			detail += 'A compression ceiling set too low is the usual cause -- ' +
				'the encoder cannot compress harder than ' + CEILING + ' ' +
				'permits, so it exceeds the bitrate instead. A scene too busy ' +
				'for the rate will do it too.';
		}

		return {
			code: over ? 'over-rate' : 'drifting',
			// Drifting is a heads-up, not a fault: the camera is over its
			// number but not by enough to have broken anything yet.
			level: over ? 'warning' : 'info',
			title: over
				? 'The encoder is over its configured bitrate'
				: 'The encoder is drifting past its configured bitrate',
			detail: detail,
			act: { href: 'camera.cgi?tab=video' + c, label: 'Open Video settings' },
		};
	}

	// The one-line form the dashboard tile carries, or '' for nothing. Kept
	// beside diagnose() so the short and long sentences cannot drift apart.
	function note(s, cfg, chn) {
		const f = diagnose(s, cfg, chn);
		if (!f) return '';
		const c = (typeof chn === 'number') ? chn : 0;
		const v = s.m && s.m.v;
		const meanQp = readNum(v, 'venc' + c + '_mean_qp');
		const maxQp = readNum(v, 'venc' + c + '_max_qp');

		if (f.code === 'starved') {
			return 'Far fewer frames than this stream asks for — the sensor ' +
				'is slowed by a long exposure, not the encoder.';
		}
		const lead = f.code === 'over-rate'
			? 'Over its set rate'
			: 'Drifting past its set rate';
		const haveQp = (meanQp !== null && maxQp !== null);
		if (haveQp && maxQp >= 51) {
			return lead + ' with the compression ceiling already at its ' +
				'maximum — the rate, the size or the frame rate has to move.';
		}
		if (haveQp) {
			return lead + ' — quantiser ' + meanQp + ' against a ' + maxQp +
				' ceiling. Raise ' + CEILING + '.';
		}
		return lead + '.';
	}

	const api = {
		diagnose: diagnose, note: note, readState: readState,
		OK: OK, MARGINAL: MARGINAL, OVER: OVER, STARVED: STARVED,
	};
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticRcCheck = api;
})();
