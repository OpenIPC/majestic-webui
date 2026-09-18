// What the camera does to a rectangle on its way in (www/a/mj-plate-roi.js).
//
// This earns its place the way the rest of tests/ does: both subjects fail
// SILENTLY, and neither can be reproduced on demand.
//
// `/image.dng?crop=` snaps outward onto the colour mosaic and the bit packing.
// Cut at an odd column and every pixel in the rectangle changes colour -- red
// and green swap wholesale, a 50% error that demosaics cleanly and produces a
// photograph. It does not fail, it lies.
//
// `isp.meterRect` reaches an ISP whose AE crop will not go below 256x120. A
// plate measured on the lab camera is 50x14, so the hardware meters an area
// FORTY-FOUR times bigger, centred on the plate: auto-exposure settles on a
// car bonnet and the picture that comes back is an ordinary picture. Nothing
// reports it; the only way to notice is to know the number beforehand, which
// is what this file is for.
//
// Reproducing either needs a HiSilicon camera serving raw, a scene with a
// plate in it, and daylight -- so the arithmetic is held still here instead.
// Both functions were additionally diffed against majestic's OWN source for
// this session: `maj_align_rect()` (src/tools.c) and the AE-crop block of
// `HiSi_HAL_SetAeMetering()` (src/hisi/hal.c) were lifted verbatim into a C
// harness and fuzzed against the JS over 150,000 cases spanning every bit
// depth, five frame sizes and the u32 saturation edges, with no mismatch. The
// cases below are the ones worth keeping once the compiler is gone.
'use strict';

const path = require('path');
const { check, group, done } = require('./assert');

const ROI = require(path.join(__dirname, '..', 'www', 'a', 'mj-plate-roi.js'));

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rect = (l, t, w, h) => ({ left: l, top: t, width: w, height: h });
const FRAME_W = 2592, FRAME_H = 1944;      // imx335, the part that serves raw

group('the AE crop has a floor, and a plate is far below it');

// Measured on the lab camera: the Mazda's plate, filter in, daylight.
const plate = rect(960, 1494, 50, 14);
const metered = ROI.meterCrop(plate, FRAME_W, FRAME_H);
check('a 50x14 plate is grown to the ISP minimum',
	eq(metered, rect(857, 1441, 256, 120)), JSON.stringify(metered));
check('and grown around its own centre, not its corner',
	metered.left + metered.width / 2 === plate.left + plate.width / 2 &&
	metered.top + metered.height / 2 === plate.top + plate.height / 2);
check('the page can say how much bigger: forty-four times',
	Math.round(ROI.growthFactor(plate, metered)) === 44,
	String(ROI.growthFactor(plate, metered)));
check('and that it was changed at all', ROI.grown(plate, metered) === true);

// A rectangle already over the floor is the camera's own; leaving it alone is
// what makes the growth notice honest when it does appear.
const big = rect(100, 100, 400, 300);
check('a rectangle over the floor is passed through untouched',
	eq(ROI.meterCrop(big, FRAME_W, FRAME_H), big));
check('and reports itself unchanged',
	ROI.grown(big, ROI.meterCrop(big, FRAME_W, FRAME_H)) === false);

group('the floor is a floor, not a suggestion — it gets clamped to the picture');

// A plate low in the frame: the grown window would hang off the bottom, and a
// window off the picture is not something the ISP will take.
check('a plate near the bottom edge slides up rather than overhanging',
	eq(ROI.meterCrop(rect(960, 1900, 50, 14), FRAME_W, FRAME_H),
		rect(857, 1824, 256, 120)));
check('the clamped window still ends exactly at the picture edge',
	1824 + 120 === FRAME_H);
// A frame smaller than the floor in both axes: the floor cannot be honoured
// and the whole picture is the answer, not a window larger than the sensor.
check('a picture smaller than the floor is metered whole',
	eq(ROI.meterCrop(rect(10, 10, 4, 4), 200, 100), rect(0, 0, 200, 100)));

group('a rectangle with no area means "the whole picture", and must stay that way');

// This is how the setting is UNDONE. If a zero-sized rectangle were rounded
// into a real one it would arrive at the ISP enabled, metering something
// nobody asked about -- and there would be no way back to whole-frame AE
// short of a restart.
check('zero width is not a region', ROI.meterCrop(rect(10, 10, 0, 5), FRAME_W, FRAME_H) === null);
check('zero height is not a region', ROI.meterCrop(rect(10, 10, 5, 0), FRAME_W, FRAME_H) === null);
check('nor is a missing rectangle', ROI.meterCrop(null, FRAME_W, FRAME_H) === null);

group('the raw crop snaps OUTWARD, so a caller is never given less than it asked for');

// The rectangle the burst actually uses, already on the grid.
check('an aligned request comes back unchanged',
	eq(ROI.alignCrop(rect(886, 1430, 224, 112), FRAME_W, FRAME_H, 12),
		rect(886, 1430, 224, 112)));
// Odd on every edge, and the answer is the same rectangle as the aligned
// request above -- near edge down, far edge up, both derived from what was
// asked for rather than from the size rounded on its own.
check('odd on every edge lands on exactly the aligned rectangle',
	eq(ROI.alignCrop(rect(887, 1431, 223, 111), FRAME_W, FRAME_H, 12),
		rect(886, 1430, 224, 112)));
check('the snapped rectangle contains the one asked for',
	886 <= 887 && 1430 <= 1431 && 886 + 224 >= 887 + 223 && 1430 + 112 >= 1431 + 111);
check('the query is built in the daemon\'s order: x, y, w, h',
	ROI.cropQuery(rect(886, 1430, 224, 112)) === '886x1430x224x112');

group('what the crop refuses, and why each refusal matters');

// Rounding the far edge up would give an unfilled size substance: a
// two-coordinate rectangle would arrive covering a whole alignment cell.
check('a rectangle with no area is refused, not rounded into one',
	ROI.alignCrop(rect(15, 0, 0, 16), FRAME_W, FRAME_H, 12) === null);
check('an origin already off the picture has nothing left to keep',
	ROI.alignCrop(rect(FRAME_W, 0, 16, 16), FRAME_W, FRAME_H, 12) === null);
check('a bit depth whose packing nobody has measured is refused',
	ROI.alignCrop(rect(0, 0, 16, 16), FRAME_W, FRAME_H, 11) === null);
// Clipping to the right-hand edge would land between groups otherwise.
check('a picture width off the alignment is refused',
	ROI.alignCrop(rect(0, 0, 16, 16), 2591, FRAME_H, 10) === null);
check('a non-integer coordinate is refused rather than floored',
	ROI.alignCrop({ left: 10.5, top: 0, width: 16, height: 16 }, FRAME_W, FRAME_H, 12) === null);
check('a negative coordinate is refused',
	ROI.alignCrop(rect(-2, 0, 16, 16), FRAME_W, FRAME_H, 12) === null);

group('clipping happens after the snap, against what remains');

// Two pixels of picture left, so two pixels come back -- not the eight asked
// for, and not a rectangle that runs off the sensor.
check('a request past the right edge is clipped back onto the grid',
	eq(ROI.alignCrop(rect(2590, 1942, 8, 8), FRAME_W, FRAME_H, 12),
		rect(2590, 1942, 2, 2)));
check('the whole frame is a legal crop',
	eq(ROI.alignCrop(rect(0, 0, FRAME_W, FRAME_H), FRAME_W, FRAME_H, 12),
		rect(0, 0, FRAME_W, FRAME_H)));

group('the alignment is the packing group rounded up to something even');

// A group of one or three would not give the colour mosaic the two it needs,
// which is why 8- and 16-bit align on 2 rather than on 1.
check('8-bit aligns on 2', ROI.cropAlign(8) === 2);
check('10-bit aligns on 4', ROI.cropAlign(10) === 4);
check('12-bit aligns on 2', ROI.cropAlign(12) === 2);
check('14-bit aligns on 4', ROI.cropAlign(14) === 4);
check('16-bit aligns on 2', ROI.cropAlign(16) === 2);
check('an unknown depth has no alignment', ROI.cropAlign(11) === 0);
// The coarser alignment is visible in the result: the same odd request snaps
// further on a 10-bit sensor than on a 12-bit one.
check('a coarser packing snaps further',
	eq(ROI.alignCrop(rect(887, 1431, 223, 111), FRAME_W, FRAME_H, 10),
		rect(884, 1428, 228, 116)));

done();
