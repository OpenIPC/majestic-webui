// What an exposure or metering row says while nobody has set it, and what it
// is called in the mode the camera is in (www/a/mj-exposure.js).
//
// It fails silently in every direction. A placeholder quoting a gain in the
// wrong units still reads as a placeholder; a stored 0 drawn as "0" reads as
// "off" to an owner and was issue #582; a gauge the camera did not send turned
// into 0 says auto-exposure may spend no gain at all; and a row that keeps its
// automatic name in manual mode calls the value itself a limit. Seeing any of
// them on hardware needs a camera, a mode switch and a heartbeat in flight.
//
// The schema entries are the lab hi3516ev300 + imx335's own, as its daemon
// declares them, and the gauges are what it reported at night: 100 ms, 31.6x
// analog against a 32x ceiling, 4.2x ISP, profile speed 64.
'use strict';

const fs = require('fs');
const path = require('path');
const { check, group, done } = require('./assert');

const EXP = require(path.join(__dirname, '..', 'www', 'a', 'mj-exposure.js'));

const Q10 = 1 / 1024;
const ISP = JSON.parse(fs.readFileSync(
	path.join(__dirname, 'fixtures', 'schema-isp-exposure.json'), 'utf8'));
const AGAIN = ISP.aGain;
const EXPOSURE = ISP.exposure;
const SPEED = ISP.aeSpeed;
const GAUGES = {
	isp_exptime: 99956, isp_exptime_max: 100000,
	isp_again: 32381, isp_again_max: 32768,
	isp_ispdgain: 4320, isp_ispdgain_max: 4096,
	isp_ae_speed: 64, isp_ae_black_delay: 8,
};

group('the daemon declares what the page reads');
check('gains are fractional', AGAIN.type === 'number' && ISP.ispGain.type === 'number');
check('the gain scale is Q10', AGAIN['x-metric'] && AGAIN['x-metric'].scale === Q10);
check('exposure is read in microseconds', EXPOSURE['x-metric'].scale === 0.001);
check('the delays are in frames', ISP.aeBlackDelay['x-unit'] === 'frames');

group('0, empty and absent are all Auto');
check('a stored 0 is Auto, not a zero gain', EXP.isAuto(0) && EXP.isAuto('0'));
check('an empty box is Auto', EXP.isAuto(''));
check('an absent key is Auto', EXP.isAuto(undefined) && EXP.isAuto(null));
check('a fraction is a value', !EXP.isAuto(1.5) && !EXP.isAuto('0.5'));
check('1x is a value, not Auto', !EXP.isAuto(1));

group('gauges come out in the field\'s unit, by the daemon\'s scale');
check('Q10 analog gain reads as a multiplier',
	Math.abs(EXP.reading(GAUGES, 'isp_again', Q10) - 31.62) < 0.01);
check('microseconds read as milliseconds',
	EXP.reading(GAUGES, 'isp_exptime_max', 0.001) === 100);
check('an absent gauge is no reading, never 0',
	EXP.reading(GAUGES, 'isp_dgain_max', Q10) === null);
check('no sample at all is no reading', EXP.reading(null, 'isp_again', Q10) === null);
check('a gauge with no name is no reading', EXP.reading(GAUGES, undefined, 1) === null);
check('a missing scale leaves the figure as it came',
	EXP.reading(GAUGES, 'isp_ae_speed', undefined) === 64);

group('the placeholder says Auto, and what automatic currently is');
check('the analog ceiling in force', EXP.autoText(32, '×') === 'Auto · 32');
check('a fractional gain keeps its tenth', EXP.autoText(4096 * Q10 * 1.05, '×') === 'Auto · 4.2');
check('the exposure ceiling in ms', EXP.autoText(100, 'ms') === 'Auto · 100');
check('a daylight ceiling below a millisecond', EXP.autoText(0.1234, 'ms') === 'Auto · 0.123');
check('the profile speed', EXP.autoText(64, '') === 'Auto · 64');
check('nothing known says only Auto', EXP.autoText(null, '×') === 'Auto');

group('the running figure carries its unit');
check('a gain hugs its ×', EXP.withUnit(31.62, '×') === '31.6×');
check('a time is spaced', EXP.withUnit(99.956, 'ms') === '100 ms');
check('a count with no unit is a bare number', EXP.withUnit(64, '') === '64');

group('the name follows the mode');
const mode = (m) => (f) => (f === 'aeMode' ? m : undefined);
check('automatic: the row is a limit', EXP.titleFor(AGAIN, mode('auto')) === 'Highest analog gain');
check('manual: the row is the value', EXP.titleFor(AGAIN, mode('manual')) === 'Analog gain');
check('manual exposure is an exposure time', EXP.titleFor(EXPOSURE, mode('manual')) === 'Exposure time');
check('an unreadable mode keeps the declared name',
	EXP.titleFor(AGAIN, mode(undefined)) === 'Highest analog gain');
check('a row with no alternatives keeps its title', EXP.titleFor(SPEED, mode('manual')) === 'Reaction speed');
// Manual pins it at 1x whatever it says, so a value's name there would
// present an inert control as the one in force.
check('the sensor digital gain keeps its ceiling name in manual',
	EXP.titleFor(ISP.dGain, mode('manual')) === 'Highest sensor digital gain');
check('matched() names the condition only in manual',
	EXP.matched(AGAIN, mode('manual')) !== null && EXP.matched(AGAIN, mode('auto')) === null);

group('frames are given in seconds at the rate assumed');
check('8 frames at 25 fps', EXP.framesToSeconds(8, 25) === '≈ 0.32 s at 25 fps');
check('25 frames is a second', EXP.framesToSeconds(25, 25) === '≈ 1 s at 25 fps');
check('no delay at all', EXP.framesToSeconds(0, 25) === '≈ 0 s at 25 fps');
check('no frame rate, no conversion', EXP.framesToSeconds(8, null) === null);
check('no frame count, no conversion', EXP.framesToSeconds(null, 25) === null);
check('a long delay is whole seconds', EXP.framesToSeconds(1000, 25) === '≈ 40 s at 25 fps');
check('a delay of nothing says so', EXP.delayText(0, 25) === 'no delay');
check('and says so without a frame rate too', EXP.delayText(0, null) === 'no delay');
check('any other delay is its time', EXP.delayText(8, 25) === '≈ 0.32 s at 25 fps');
check('an unknown delay is no text', EXP.delayText(null, 25) === null);

group('any unit the camera declares, beside a figure and a range');

// A setting's own bound is printed as declared: a lamp curve floor of 0.2
// rounded to 0 would say the box refuses what it accepts.
check('a fraction with a plain unit is not rounded away', EXP.fmt(0.2, '') === '0.2');
check('a whole number stays whole', EXP.fmt(300, 's') === '300');
check('counts still round', EXP.fmt(7.6, 'frames') === '8');
check('a percentage sits against its figure', EXP.withUnit(95, '%') === '95%');
check('so does a degree', EXP.withUnit(45, '°') === '45°');
check('and a per-mille', EXP.withUnit(610, '‰') === '610‰');
check('an abbreviation takes a space', EXP.withUnit(1024, 'KiB') === '1024 KiB');
check('a range says its unit once', EXP.rangeText(1, 300, 's') === '1–300 s');
check('a tight unit in a range', EXP.rangeText(0, 100, '%') === '0–100%');
check('a signed range', EXP.rangeText(-45, 45, '°') === '-45–45°');
check('a range with no unit is bare', EXP.rangeText(0.2, 4, '') === '0.2–4');
check('an unbounded end is no range', EXP.rangeText(0, undefined, 's') === '');

group('a value that names a mode is said by its name');

const JIT = { type: 'integer', minimum: 0, maximum: 500, 'x-unit': 'ms', 'x-special': { '0': 'Passthrough' } };
const DEH = { type: 'integer', minimum: -1, maximum: 255, 'x-special': { '0': 'Off', '-1': 'From the image profile' } };
check('0 on the buffer is Passthrough', EXP.specialFor(JIT, '0') === 'Passthrough');
check('a number compares as a number', EXP.specialFor(JIT, 0) === 'Passthrough');
check('-1 on dehaze is the profile', EXP.specialFor(DEH, '-1') === 'From the image profile');
check('an ordinary value has no name', EXP.specialFor(JIT, '60') === '');
// An empty box is unset, and Number('') is 0 — which would call it Passthrough.
check('an empty box is not the special 0', EXP.specialFor(JIT, '') === '');
check('a field with none says nothing', EXP.specialFor({ type: 'integer' }, 0) === '');
check('the list is in value order with units',
	EXP.specialsText(DEH) === '-1: From the image profile · 0: Off');
check('the value is bare, not in its unit', EXP.specialsText(JIT) === '0: Passthrough');

group('a slider is at most a hundred steps, on the camera\'s grain');

const sl = (o) => EXP.sliderOf(o);
check('0–100 whole numbers is a slider', !!sl({ type: 'integer', minimum: 0, maximum: 100 }));
check('no minimum on a whole number starts at 0',
	sl({ type: 'integer', maximum: 64 }).min === 0);
// The OSD position that took -51: bounded now, and a slider.
check('-16–16 is a slider', !!sl({ type: 'integer', minimum: -16, maximum: 16 }));
check('0–2000 ms is a box', sl({ type: 'integer', minimum: 0, maximum: 2000 }) === null);
check('dehaze -1–255 is a box', sl(DEH) === null);
const G = sl({ type: 'number', minimum: 0.2, maximum: 4, 'x-step': 0.1 });
check('a lamp curve on a 0.1 step is a slider', !!G && G.step === 0.1 && G.min === 0.2);
check('a decimal with no step is a box', sl({ type: 'number', minimum: 0, maximum: 90 }) === null);
check('a whole number with no maximum is a box', sl({ type: 'integer', minimum: 0 }) === null);
check('text is never a slider', sl({ type: 'string', maximum: 5 }) === null);

done();
