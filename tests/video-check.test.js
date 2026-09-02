// "Is the camera seeing anything?" — the decision table.
//
// This exists for the reason ircut-check.test.js does: every branch renders a
// confident sentence, so a wrong branch reads exactly like a right one, and
// nothing here can be checked by looking at the page. Reaching the branches
// that matter needs a camera booted on the wrong sensor driver — which is how
// the numbers below were obtained, on a hi3516av300 flashed for an imx415 and
// booted on imx335: isp_avelum 0 against 40, isp_again 32381 against 1024,
// isp_exposureismax 1 against 0, and a stream that PLAYED, perfectly, in black.
//
// The stakes are not symmetric and the tests are weighted accordingly. A missed
// finding leaves somebody looking at a black rectangle, which is where they
// already were. A false one moves them off the page they asked for and tells
// them their camera is broken when it is working — so most of what follows is
// about the cases this must stay silent on.
'use strict';

const path = require('path');
const { check, group, done } = require('./assert');

const vc = require(path.join(__dirname, '..', 'www', 'a', 'video-check.js'));

// A heartbeat sample as main.js publishes it, with only the keys diagnose()
// reads. `up` defaults past the boot grace so a test has to opt into booting.
function sample(v, opts) {
	const o = opts || {};
	return {
		ok: o.ok === undefined ? true : o.ok,
		fails: o.fails || 0,
		mjUptimeS: o.up === undefined ? 600 : o.up,
		night: o.night === undefined ? 0 : o.night,
		m: { v: v || {} },
	};
}

const BLIND = { isp_avelum: 0, isp_exposureismax: 1, isp_again: 32381 };
const LIT = { isp_avelum: 40, isp_exposureismax: 0, isp_again: 1024 };
const BOTH_ON = { video0: { enabled: true }, video1: { enabled: false } };

// Drive the tracker for `secs` seconds of the same sample, one push a second,
// and return the last push result.
function hold(tr, s, secs, t0) {
	let r = null;
	for (let i = 0; i <= secs; i++) r = tr.push(s, (t0 || 0) + i);
	return r;
}
function holdPic(tr, look, secs, t0) {
	let r = 0;
	for (let i = 0; i <= secs; i++) r = tr.picture(look, (t0 || 0) + i);
	return r;
}

group('the picture statistic');
{
	check('a solid black frame reads black',
		vc.look({ total: 14400, mean: 0, low: 1 }) === 'black');
	check('an ordinary frame reads lit',
		vc.look({ total: 14400, mean: 61, low: 0.02 }) === 'lit');
	// Both halves are needed, and each rules out a different innocent frame.
	check('a very dark scene with a spread of tones is not black',
		vc.look({ total: 14400, mean: 1.4, low: 0.6 }) === 'lit',
		'a low mean alone is a night scene');
	check('a black frame with one bright lamp in it is not black',
		vc.look({ total: 14400, mean: 9, low: 0.997 }) === 'lit',
		'a high dark-bucket share alone is a lamp at night');
	// null is not "lit". Nothing was measured, and the run length has to break
	// rather than count it as disagreement.
	check('a frame nothing could be measured from reads null',
		vc.look({ total: 0, mean: 0, low: 0 }) === null);
	check('no histogram at all reads null', vc.look(null) === null);
}

group("the camera's own opinion");
{
	check('wide open and metering nothing is blind', vc.ispBlind(BLIND) === true);
	check('metering light is not blind', vc.ispBlind(LIT) === false);
	// The one that matters for cross-vendor honesty: SigmaStar publishes no
	// isp_avelum, and a camera that cannot answer must not be read as
	// answering no.
	check('a camera that does not publish isp_avelum answers null',
		vc.ispBlind({ isp_exposureismax: 1 }) === null);
	check('a camera that does not publish isp_exposureismax answers null',
		vc.ispBlind({ isp_avelum: 0 }) === null);
	check('no metrics at all answers null', vc.ispBlind({}) === null);
}

group('what it refuses to say');
{
	const tr = vc.tracker();
	check('an unreachable camera produces no finding',
		vc.diagnose(BOTH_ON, sample(BLIND, { ok: false }), { blindS: 99, blind: true }, null) === null);

	const boot = vc.tracker();
	const bootTrack = hold(boot, sample(BLIND, { up: 5 }), 20);
	check('a camera that is still starting is never convicted',
		vc.diagnose(BOTH_ON, sample(BLIND, { up: 5 }), bootTrack, null) === null,
		'the ISP reads nothing while it converges');

	// The whole false-positive class, in one line: the camera says it is
	// metering light, so a dark-looking frame is a night scene and none of this
	// code's business.
	const lit = vc.tracker();
	check('a camera that is metering light is left alone, black picture or not',
		vc.diagnose(BOTH_ON, sample(LIT), hold(lit, sample(LIT), 60), { blackS: 999 }) === null);

	const brief = vc.tracker();
	check('a couple of seconds of darkness is not a finding',
		vc.diagnose(BOTH_ON, sample(BLIND), hold(brief, sample(BLIND), 3), null) === null,
		'BLIND_S is ' + vc.BLIND_S + 's');

	// mjConfig() resolves {} when the fetch failed. An absent key must decline
	// to answer, not read as a disabled channel.
	check('a config that never arrived does not report the channels off',
		vc.diagnose({}, sample(LIT), { blindS: 0, blind: false }, null) === null);
	check('one channel on is not both channels off',
		vc.diagnose({ video0: { enabled: false }, video1: { enabled: true } },
			sample(LIT), { blindS: 0, blind: false }, null) === null);
}

group('what it does say');
{
	const off = vc.diagnose({ video0: { enabled: false }, video1: { enabled: false } },
		sample(LIT), { blindS: 0, blind: false }, null);
	check('both channels off is a finding', !!off && off.code === 'off');
	check('and it is a configuration fault, not a hardware one',
		!!off && off.where === 'config');
	check('and it acts on the video settings',
		!!off && /tab=video0/.test(off.act.href));
	// A switch being off is not something to go and read a log about.
	check('and it does not send anybody to the logs',
		!!off && !off.help);
	// True from the first sample: nothing about it needs time to establish, and
	// it holds even on a camera that has only just booted.
	const offBooting = vc.diagnose({ video0: { enabled: false }, video1: { enabled: false } },
		sample(LIT, { up: 2 }), { blindS: 0, blind: false }, null);
	check('and the boot grace does not delay it', !!offBooting && offBooting.code === 'off');

	const st = vc.tracker();
	const stall = vc.diagnose(BOTH_ON, sample({ venc_empty_frames_run: 40 }),
		hold(st, sample({ venc_empty_frames_run: 40 }), 2), null);
	check('a stalled encoder is a finding', !!stall && stall.code === 'stall');
	check('and it offers a restart', !!stall && /fw-restart/.test(stall.act.href));
	// The banner this replaced carried .confirm + data-confirm, which main.js
	// wires at load — and the anchor it lands on now is written at runtime, so
	// that wiring would never see it. The prompt travels with the action
	// instead, or one click restarts the camera.
	check('and restarting asks first',
		!!stall && typeof stall.act.confirm === 'string' &&
		/Restart the camera/.test(stall.act.confirm));
	check('while a settings link does not ask',
		!!off && !off.act.confirm);

	const tr = vc.tracker();
	const blind = vc.diagnose(BOTH_ON, sample(BLIND), hold(tr, sample(BLIND), 12), null);
	check('a camera reading no light is a finding', !!blind && blind.code === 'blind');
	check('and it is a camera fault', !!blind && blind.where === 'camera');
	check('and it names the wrong sensor driver first',
		!!blind && /wrong sensor driver/.test(blind.detail),
		'this page is reached minutes after somebody flashed a camera');
	check('and it never states a cause it cannot prove',
		!!blind && /lens cap/.test(blind.detail) && /no light in it/.test(blind.detail));
	// The camera is not something its owner can repair from a settings page,
	// so the finding also points at the one artefact worth screenshotting for
	// whoever sold it to them.
	check('and a hardware fault offers the logs',
		!!blind && !!blind.help && /info-logs/.test(blind.help.href));
	check('the stalled encoder offers them too',
		!!stall && !!stall.help && /info-logs/.test(stall.help.href));

	// Both signals agreeing gets its own sentence, because it is a stronger
	// claim than either alone.
	const tr2 = vc.tracker();
	holdPic(tr2, 'black', 12);
	const both = vc.diagnose(BOTH_ON, sample(BLIND), hold(tr2, sample(BLIND), 12),
		{ blackS: 12 });
	check('with both signals the sentence says both',
		!!both && /picture is completely black/.test(both.detail) &&
		/longest\s+exposure/.test(both.detail));
	// The predicate never looks at isp_again — the gain scale is vendor
	// specific and has no portable ceiling — so no sentence may claim it.
	// Stating an observation the code did not make is the same failure as
	// convicting on a test that could not look.
	check('and neither sentence claims anything about gain',
		!!both && !/gain/.test(both.detail) && !!blind && !/gain/.test(blind.detail));
}

group('the picture alone, where the camera cannot say');
{
	// A SigmaStar-shaped camera: no isp_avelum, so ispBlind() is null and only
	// the decoded frame is left.
	const tr = vc.tracker();
	const t = hold(tr, sample({ venc0_rcvd_bytes: 5 }), 12);
	const f = vc.diagnose(BOTH_ON, sample({ venc0_rcvd_bytes: 5 }), t, { blackS: 12 });
	check('a black picture alone is still a finding', !!f && f.code === 'blind');
	check('but the sentence admits the cause is not certain',
		!!f && /not certain/.test(f.detail));
	// The strongest action is not taken on the weaker evidence.
	check('and it is not conclusive, so nobody is moved off the page',
		!!f && f.conclusive === false);
}

group('what may move somebody off the Live page');
{
	const tr = vc.tracker();
	const day = vc.diagnose(BOTH_ON, sample(BLIND), hold(tr, sample(BLIND), 12), null);
	check('a blind camera in daylight is conclusive', !!day && day.conclusive === true);

	// A night camera with no illuminator is genuinely dark and genuinely fine,
	// and it fixes itself at dawn.
	const tn = vc.tracker();
	const night = vc.diagnose(BOTH_ON, sample(BLIND, { night: 1 }),
		hold(tn, sample(BLIND, { night: 1 }), 12), null);
	check('the same camera at night is reported but not acted on',
		!!night && night.code === 'blind' && night.conclusive === false);

	// "An absent reading is not a zero" — a camera that does not publish
	// night_enabled has not told us it is day.
	const tu = vc.tracker();
	const unknown = vc.diagnose(BOTH_ON, sample(BLIND, { night: null }),
		hold(tu, sample(BLIND, { night: null }), 12), null);
	check('a camera that does not report day or night is not acted on either',
		!!unknown && unknown.code === 'blind' && unknown.conclusive === false);
}

group('runs are broken by gaps, not carried across them');
{
	// The bug this shape exists to prevent: an unreachable camera billing the
	// whole offline stretch as darkness nobody was watching.
	const tr = vc.tracker();
	hold(tr, sample(BLIND), 8, 0);
	tr.push(sample(BLIND, { ok: false }), 9);
	const after = tr.push(sample(BLIND), 100);
	check('an unreachable sample restarts the blind run',
		after.blindS === 0, 'got ' + after.blindS);

	const lit = vc.tracker();
	hold(lit, sample(BLIND), 8, 0);
	lit.push(sample(LIT), 9);
	const back = lit.push(sample(BLIND), 10);
	check('a camera that meters light again restarts the run',
		back.blindS === 0, 'got ' + back.blindS);

	// The picture sampler stops while the tab is hidden and says so by not
	// calling. The next frame after that must not bill the gap.
	const pic = vc.tracker();
	holdPic(pic, 'black', 8, 0);
	const resumed = pic.picture('black', 8 + vc.PIC_GAP_S + 5);
	check('a gap in the picture samples restarts the black run',
		resumed === 0, 'got ' + resumed);
	const contiguous = pic.picture('black', 8 + vc.PIC_GAP_S + 6);
	check('and it starts counting again from the frame that resumed it',
		contiguous === 1, 'got ' + contiguous);

	const unk = vc.tracker();
	holdPic(unk, 'black', 8, 0);
	const broke = unk.picture(null, 9);
	check('a frame nothing could be measured from breaks the run',
		broke === 0, 'a picture that stopped agreeing is not one that still agrees a bit');
}

done();
