// "Is the encoder honouring its rate?" — the decision table.
//
// Every branch renders a confident sentence naming a setting to change, so a
// wrong branch reads exactly like a right one and nothing here can be checked
// by looking at the page. The numbers come from a lab hi3516ev300 + imx335 on a
// real outdoor scene at 1920x1080, H.264, 12 fps, CBR 1024 kbit, one setting
// apart: maxQp 42 held 758 kbit/s at quantiser 31, maxQp 30 delivered 4237 with
// every frame pinned at the ceiling.
//
// The stakes are asymmetric in the usual direction. A missed finding leaves an
// operator where they already were — puzzled by a bitrate. A false one tells
// somebody whose camera is fine to go and change its encoder settings, so most
// of what follows is about the cases this must stay silent on.
//
// The most load-bearing of those is the absent gauge. Every camera running a
// majestic older than this feature publishes no verdict at all, and a reading
// of "absent" must never be rounded to 0 — because 0 here means "within its
// configured rate", which is the one claim that would be a lie about a camera
// that never said anything.
'use strict';

const path = require('path');
const { check, group, done } = require('./assert');

const rc = require(path.join(__dirname, '..', 'www', 'a', 'rc-check.js'));

// A heartbeat sample as main.js publishes it, carrying only the keys this
// reads. `v` is the metrics map; absent keys are absent, not zero.
function sample(v, opts) {
	const o = opts || {};
	return {
		ok: o.ok === undefined ? true : o.ok,
		fails: o.fails || 0,
		m: { v: v || {} },
	};
}

const CFG = { bitrate: 1024, fps: 12 };

group('a camera with nothing to say is left alone');
{
	check('no verdict published at all is silence',
		rc.diagnose(sample({ venc0_rcvd_bytes: 500 }), CFG, 0) === null);
	check('and the tile note is empty, not the word undefined',
		rc.note(sample({ venc0_rcvd_bytes: 500 }), CFG, 0) === '');
	check('a verdict of OK is silence',
		rc.diagnose(sample({ venc0_rc_state: 0 }), CFG, 0) === null);
	check('an unreachable camera is not a camera with a verdict',
		rc.diagnose(sample({ venc0_rc_state: 2 }, { ok: false }), CFG, 0) === null);
}

group('absent is not zero');
{
	// The whole reason readState returns null rather than a number: every
	// camera older than this feature would otherwise read as healthy, which is
	// a claim about a measurement nobody took.
	check('a missing gauge reads null', rc.readState({}, 0) === null);
	check('a present zero reads zero', rc.readState({ venc0_rc_state: 0 }, 0) === 0);
	check('and null is not confused for a verdict',
		rc.readState({ venc0_rc_state: 0 }, 0) !== rc.readState({}, 0));
}

group('over its rate, with the ceiling reported');
{
	const f = rc.diagnose(sample({
		venc0_rc_state: 2, venc0_mean_qp: 30, venc0_max_qp: 30,
	}), CFG, 0);
	check('it is a finding', !!f && f.code === 'over-rate');
	check('warned, not merely noted', f.level === 'warning');
	check('the ceiling is named, because it is the thing to change',
		/Raising "Most compression allowed \(QP\)"/.test(f.detail), f.detail);
	check('the configured rate is quoted back', /1024 kbit\/s/.test(f.detail));
	check('and it points at the settings that hold it',
		f.act.href === 'camera.cgi?tab=video0');

	const n = rc.note(sample({
		venc0_rc_state: 2, venc0_mean_qp: 30, venc0_max_qp: 30,
	}), CFG, 0);
	check('the tile says the same thing in one line',
		/30 ceiling/.test(n) && /Raise "Most compression allowed/.test(n), n);
}

group('a mean below the ceiling is still the ceiling binding');
{
	// The branch this replaced said the opposite, and it was measured wrong.
	// A gk7205v200 at 10 Mbit/s against a configured 128 published a MEAN of 27
	// against a ceiling of 30, while the vendor's own counters had the working
	// quantiser pinned at 30 on every frame -- the mean averages the easy parts
	// of the picture in. Advising "you have headroom, raise the bitrate" there
	// sends somebody to the wrong setting with total confidence.
	const v = { venc0_rc_state: 2, venc0_mean_qp: 27, venc0_max_qp: 30 };
	const f = rc.diagnose(sample(v), { bitrate: 128, fps: 12 }, 0);
	check('still a finding', !!f && f.code === 'over-rate');
	check('the ceiling is still the lever',
		/Raising "Most compression allowed \(QP\)"/.test(f.detail), f.detail);
	check('and nothing claims spare compression',
		!/in reserve|headroom/.test(f.detail), f.detail);
	check('the mean is reported as evidence, not used as a test',
		/quantiser 27 against a ceiling of 30/.test(f.detail), f.detail);
}

group('a ceiling already at the top has nothing left to give');
{
	// The one real exception, and it is a fact about the setting rather than a
	// threshold picked by eye: at 51 there is no ceiling left to raise.
	const f = rc.diagnose(sample({
		venc0_rc_state: 2, venc0_mean_qp: 50, venc0_max_qp: 51,
	}), CFG, 0);
	check('still a finding', !!f && f.code === 'over-rate');
	check('it does not ask for a ceiling that cannot move',
		!/Raising "Most compression allowed/.test(f.detail), f.detail);
	check('it names what can move instead',
		/higher bitrate/.test(f.detail), f.detail);
	check('the tile line agrees',
		/maximum/.test(rc.note(sample({
			venc0_rc_state: 2, venc0_mean_qp: 50, venc0_max_qp: 51,
		}), CFG, 0)));
}

group('a camera that reports no quantiser at all');
{
	// mean QP comes from a vendor hook HiSilicon fills in and the others do
	// not. The sentence must not state a reading this page never received.
	const f = rc.diagnose(sample({ venc0_rc_state: 2 }), CFG, 0);
	check('still a finding', !!f && f.code === 'over-rate');
	check('no quantiser is quoted', !/quantiser \d/.test(f.detail), f.detail);
	check('the usual cause is still named',
		/compression ceiling/.test(f.detail), f.detail);
}

group('drifting is a heads-up, not a fault');
{
	const f = rc.diagnose(sample({ venc0_rc_state: 1 }), CFG, 0);
	check('it is reported', !!f && f.code === 'drifting');
	check('at a lower severity than over-rate', f.level === 'info');
	check('and says drifting rather than over', /drifting/i.test(f.title));
}

group('starved names the sensor, not the encoder');
{
	// Measured on the imx335 at night: the encoder saw 0.35 fps against a
	// configured 12 while its bitrate sat comfortably inside budget. An
	// operator sent to the bitrate settings by this would change the wrong
	// thing entirely.
	const f = rc.diagnose(sample({ venc0_rc_state: 3 }), CFG, 0);
	check('it is a finding', !!f && f.code === 'starved');
	check('the title is about frames, not bitrate',
		/frame rate/i.test(f.title) && !/bitrate/i.test(f.title), f.title);
	check('it says the sensor is the limit',
		/sensor/i.test(f.detail), f.detail);
	check('it does not tell anybody to change the bitrate',
		!/compression|bitrate/i.test(f.detail), f.detail);
	check('and it points at Image, not Video',
		f.act.href === 'camera.cgi?tab=isp');
	check('the configured frame rate is quoted back',
		/12 fps/.test(f.detail), f.detail);
	check('the tile line agrees', /fewer frames/.test(
		rc.note(sample({ venc0_rc_state: 3 }), CFG, 0)));
}

group('the sub stream reads the same way');
{
	const v = { venc1_rc_state: 2, venc1_mean_qp: 30, venc1_max_qp: 30 };
	check('channel 1 is diagnosed from its own keys',
		!!rc.diagnose(sample(v), CFG, 1));
	check('and channel 0 is silent on the same sample',
		rc.diagnose(sample(v), CFG, 0) === null);
	check('the sentence names the stream it is about',
		/sub stream/.test(rc.diagnose(sample(v), CFG, 1).detail));
	check('and the link goes to that channel, not always video0',
		rc.diagnose(sample(v), CFG, 1).act.href === 'camera.cgi?tab=video1');
}

group('settings are named the way the form names them');
{
	// An operator reads a finding on the page that holds the control. The
	// dotted key is the daemon's word for it and the camera log's; the field
	// beside the sentence is labelled something else. ircut-check.js keeps raw
	// keys to its comments for the same reason.
	const over = rc.diagnose(sample({
		venc0_rc_state: 2, venc0_mean_qp: 30, venc0_max_qp: 30,
	}), CFG, 0);
	const starved = rc.diagnose(sample({ venc0_rc_state: 3 }), CFG, 0);
	const texts = [over.detail, over.title, starved.detail, starved.title,
		rc.note(sample({ venc0_rc_state: 3 }), CFG, 0)];
	texts.forEach((t, i) => {
		check('no dotted key in operator text #' + i,
			!/\bvideo[01]\.[a-zA-Z]/.test(t), t);
	});
}

group('a ceiling without a mean is not half a sentence');
{
	// The two gauges come from the same optional vendor hook, but nothing here
	// may assume they arrive together — a camera publishing one without the
	// other would render "quantiser null" at an operator as if it were read.
	const v = { venc0_rc_state: 2, venc0_max_qp: 30 };
	const f = rc.diagnose(sample(v), CFG, 0);
	check('still a finding', !!f);
	check('and it quotes no quantiser it never received',
		!/null/.test(f.detail) && !/quantiser \d/.test(f.detail), f.detail);
	check('the tile line is clean too',
		!/null/.test(rc.note(sample(v), CFG, 0)));

	const w = { venc0_rc_state: 2, venc0_mean_qp: 27 };
	check('and the mirror case, a mean with no ceiling',
		!/null/.test(rc.diagnose(sample(w), CFG, 0).detail));
}

group('a verdict this file does not know is not translated');
{
	// A newer camera publishing a fourth state, or a malformed one, must not
	// fall through to the rate branch and be given confident advice about a
	// diagnosis it never made.
	check('an unknown state says nothing',
		rc.diagnose(sample({ venc0_rc_state: 7 }), CFG, 0) === null);
	check('and neither does a negative one',
		rc.diagnose(sample({ venc0_rc_state: -1 }), CFG, 0) === null);
	check('the tile stays empty',
		rc.note(sample({ venc0_rc_state: 7 }), CFG, 0) === '');
}

group('a missing config is survivable');
{
	// renderStreams() fetches the config once and gives up after a while; the
	// verdict still arrives on the heartbeat. A finding with no number in it is
	// worth more than a crash.
	const f = rc.diagnose(sample({ venc0_rc_state: 2 }), null, 0);
	check('it still renders', !!f);
	check('without inventing a bitrate', !/null/.test(f.detail), f.detail);
	check('and without printing undefined',
		!/undefined/.test(f.detail + f.title), f.detail);
}

done();
