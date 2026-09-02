// Is the camera seeing anything?
//
// The Live page is where a newly claimed camera lands, so it is where a camera
// that came up wrong is first met. The obvious guess about what that looks like
// is wrong, and it was measured rather than assumed: booting a hi3516av300
// board on the wrong sensor driver (imx335 on an imx415 board) does NOT stop
// the camera. majestic stays up, serves the whole WebUI, and the Live page
// plays the stream perfectly -- readyState 4, time advancing, a real frame
// size. The picture is simply black.
//
// So every signal about the pipeline MOVING is useless here. venc0_rcvd_bytes
// goes on climbing, at about one per cent of the healthy rate, because a black
// frame compresses to almost nothing -- and a rate that low is not something
// this can convict on either, since a static dark scene at night is allowed to
// look like that. The fault is in what the sensor reports and in the picture:
//
//                     healthy          wrong driver
//   isp_avelum          40                  0
//   isp_again         1024               32381   (pinned at maximum)
//   isp_exposureismax    0                   1
//   /image.jpg       392 KB               62 KB, solid black
//
// Two independent signals, and they answer different halves. The camera's own
// gauges say it is straining -- exposure and gain wide open -- and reading
// nothing. The decoded picture says the frame that came out the far end is
// black. Either alone has an innocent explanation; together they do not.
//
// A separate file, and tested, for the same reason ircut-check.js is: this
// renders a confident sentence whichever branch it takes, a wrong branch reads
// exactly like a right one, and reaching half the branches needs a camera
// booted on the wrong sensor.
(function () {
	'use strict';

	// How long majestic must have been up before anything here convicts it. A
	// camera that is starting is not a camera that is broken: the ISP converges
	// over the first seconds and reads nothing at all while it does.
	const BOOT_GRACE_S = 30;
	// How long "seeing nothing" has to hold. Timed from when it started rather
	// than counted in samples, because the heartbeat backs off and skips ticks
	// on a busy camera and a sample count is then not a duration.
	const BLIND_S = 10;
	// A gap in the picture samples is not agreement continuing through it --
	// the sampler stops while the tab is hidden and while the player is between
	// elements. Longer than one sampling interval, short enough that a real
	// pause resets the run.
	const PIC_GAP_S = 4;

	// The picture, from an mj-luma histogram. `mean` is the frame's average
	// luma over 0..255 and `low` the fraction of pixels in the darkest of its
	// 64 buckets. Both, because either alone is reachable innocently: a very
	// dark scene has a low mean with a spread of tones, and a mostly-black
	// frame with one bright lamp in it has a high `low` and is a picture.
	const BLACK_MEAN = 2;
	const BLACK_LOW = 0.995;

	// 'black', 'lit', or null for a frame nothing could be measured from.
	// null is not 'lit': it is the absence of an answer, and the run-length
	// below has to treat it as a break rather than as disagreement.
	function look(h) {
		if (!h || !h.total) return null;
		return (h.mean <= BLACK_MEAN && h.low >= BLACK_LOW) ? 'black' : 'lit';
	}

	// The camera's own opinion: exposure at its ceiling and the metered scene
	// luminance at zero. true / false / null, and null is load-bearing --
	// isp_avelum is not published by every vendor (SigmaStar reports none), so
	// a camera that cannot answer must not be read as answering no.
	function ispBlind(v) {
		if (!v || !('isp_avelum' in v) || !('isp_exposureismax' in v)) return null;
		return v.isp_avelum === 0 && v.isp_exposureismax > 0;
	}

	// Dotted lookup, local rather than main.js's mjGet: this file is required
	// directly by its test, where no page globals exist.
	function get(cfg, dot) {
		return dot.split('.').reduce((o, k) => (o == null ? undefined : o[k]), cfg);
	}

	// Run lengths for both signals. Held here rather than recomputed per sample
	// because "how long has this been true" is the whole question -- one black
	// frame is a shutter, ten seconds of them is a fault.
	function tracker() {
		let ispAt = null, picAt = null, picSeen = null;
		return {
			// Consecutive seconds the decoded picture has looked black.
			// Anything that is not 'black' resets the run, null included: a
			// frame nothing could be measured from is not a frame that still
			// agrees a bit.
			picture: function (l, nowS) {
				// The sampler stops when the tab is hidden or the player is
				// between elements, and it says so by not calling. Without
				// this, the next frame after a gap bills the whole gap as
				// blackness nobody watched.
				if (picSeen !== null && nowS - picSeen > PIC_GAP_S) picAt = null;
				picSeen = nowS;
				if (l === 'black') { if (picAt === null) picAt = nowS; }
				else picAt = null;
				return picAt === null ? 0 : nowS - picAt;
			},
			push: function (s, nowS) {
				// An unreachable camera is not a camera reporting darkness.
				if (!s || !s.ok) {
					ispAt = null;
					return { blindS: 0, blind: null };
				}
				const b = ispBlind(s.m && s.m.v);
				if (b === true) { if (ispAt === null) ispAt = nowS; }
				else ispAt = null;
				return { blindS: ispAt === null ? 0 : nowS - ispAt, blind: b };
			},
		};
	}

	// Where a finding about the hardware sends somebody who cannot fix it
	// themselves. Everything in this file is what the WebUI can work out from
	// two gauges and a thumbnail; the log is where majestic says what actually
	// happened when it brought the sensor up, and it is the one thing an owner
	// can screenshot and hand to whoever sold them the camera. Named once so
	// the findings that carry it cannot drift apart.
	const HELP = { href: 'info-logs.cgi', label: 'View logs' };

	// What the camera cannot show, and why.
	//
	//   cfg   majestic's config, or {} when the fetch failed -- which is why
	//         every test below is `=== false` and never falsy: an absent key
	//         from a failed fetch must not read as a disabled channel.
	//   s     a heartbeat sample (main.js), carrying s.m.v and s.mjUptimeS.
	//   tr    the last tracker().push() result.
	//   pic   { blackS } from tracker().picture(), or null where no picture is
	//         being measured -- the Dashboard has no decoded frame to read.
	//
	// Returns a finding, or null for "nothing to say", which includes every
	// case where the answer is not knowable. Silence here is never a clean bill
	// of health; it is the absence of a claim.
	//
	// A finding about the hardware also carries `help` (above). The
	// configuration finding does not: nothing went wrong there, a switch is
	// off, and sending somebody to a log to read about it would be a wild goose
	// chase dressed up as support.
	function diagnose(cfg, s, tr, pic) {
		if (!s || !s.ok) return null;
		const v = (s.m && s.m.v) || {};

		// Nothing is being encoded at all. A fact about the configuration
		// rather than the hardware, true from the first sample, and the one
		// finding here that names a thing the owner can simply switch on.
		if (get(cfg, 'video0.enabled') === false &&
			get(cfg, 'video1.enabled') === false) {
			return {
				code: 'off', where: 'config', conclusive: true,
				title: 'No video channel is turned on',
				detail: 'Neither the main nor the sub stream is enabled, so the ' +
					'camera is not encoding a picture for anything to show.',
				act: { href: 'mj-settings.cgi?tab=video0', label: 'Open Video settings' },
			};
		}

		if (s.mjUptimeS != null && s.mjUptimeS < BOOT_GRACE_S) return null;

		// The encoder is awake and being handed nothing. Only SigmaStar
		// publishes this, and it is the one fault where the pipeline really has
		// stopped rather than gone dark.
		if (v.venc_empty_frames_run > 25) {
			return {
				code: 'stall', where: 'camera', conclusive: true,
				title: 'The encoder has stopped',
				detail: 'The camera is running, but the encoder has stopped ' +
					'producing frames while everything else looks alive.',
				act: { href: 'fw-restart.cgi', label: 'Restart camera' },
				help: HELP,
			};
		}

		const ispSays = tr ? tr.blind : null;
		const ispHeld = (tr ? tr.blindS : 0) >= BLIND_S;
		const picHeld = (pic ? pic.blackS : 0) >= BLIND_S;

		// The camera says it is metering light. Believe it over a dark-looking
		// frame: that is a night scene, a covered lens or a picture this code
		// has no business having an opinion about.
		if (ispSays === false) return null;
		if (!(ispSays === true && ispHeld) && !picHeld) return null;

		// Which evidence actually arrived decides the sentence. Naming the
		// wrong-driver case first is not a guess about probability in general
		// -- it is the case this page is reached in, minutes after somebody
		// flashed a camera and set its first password.
		const cause = ' On a newly flashed camera this is usually the wrong ' +
			'sensor driver for the board; it can also be a lens cap, or a ' +
			'scene with no light in it at all.';
		const both = ispSays === true && ispHeld && picHeld;
		const detail = both
			? 'The picture is completely black, and the sensor is at maximum ' +
				'exposure and gain while still reading no light.' + cause
			: ispSays === true
				? 'The sensor is at maximum exposure and gain and reporting no ' +
					'light at all.' + cause
				: 'Every frame is completely black. This camera does not report ' +
					'its own exposure, so the cause is not certain.' + cause;

		return {
			code: 'blind', where: 'camera',
			// The strongest action this feature takes is moving somebody off
			// the page they asked for, so it is spent only on the reading that
			// cannot be explained by the scene: the camera's own gauges saying
			// it is wide open and blind, in a camera that has decided it is
			// DAY. A night camera with no illuminator is genuinely dark and
			// genuinely fine, and it fixes itself at dawn. `s.night` is null on
			// a camera that does not publish it, and an unknown is not a day.
			conclusive: ispSays === true && ispHeld && s.night === 0,
			title: 'The camera is not seeing anything',
			detail: detail,
			act: { href: 'mj-settings.cgi?tab=isp', label: 'Open Image settings' },
			help: HELP,
		};
	}

	const api = {
		diagnose: diagnose, tracker: tracker, look: look, ispBlind: ispBlind,
		BOOT_GRACE_S: BOOT_GRACE_S, BLIND_S: BLIND_S, PIC_GAP_S: PIC_GAP_S,
		BLACK_MEAN: BLACK_MEAN, BLACK_LOW: BLACK_LOW,
	};
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticVideoCheck = api;
})();
