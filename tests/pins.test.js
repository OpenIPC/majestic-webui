// The pins page's one piece of arithmetic: how a part's pads are dealt round
// the four sides of the package (www/a/mj-pins.js).
//
// It is here rather than left to the eye because the pad count is not this
// page's to choose. The camera reports what its pad table has — 93 on an
// hi3516ev300, 104 on a cv500, a different number on every family, and one day
// a number nobody here has seen. A deal that loses a pad shows up as a chip
// with a lead missing, which looks exactly like a chip; a deal that gives one
// side far more than the others shows up as a package that is not square,
// which looks like a rendering bug rather than a counting one.
'use strict';

const path = require('path');
const { check, group, done } = require('./assert');

const PINS = require(path.join(__dirname, '..', 'www', 'a', 'mj-pins.js'));

group('dealing the pads round the package');

// Every pad is on exactly one side, whatever the count.
{
	let lost = null, uneven = null;
	for (let n = 0; n <= 400 && !lost; n++) {
		const s = PINS.sides(n);
		const total = s.left + s.bottom + s.right + s.top;
		if (total !== n) lost = n + ' pads dealt as ' + total;
		const most = Math.max(s.left, s.bottom, s.right, s.top);
		const fewest = Math.min(s.left, s.bottom, s.right, s.top);
		if (most - fewest > 3 && !uneven) uneven = n + ' -> ' + JSON.stringify(s);
	}
	check('no pad is lost or dealt twice, for any count up to 400', !lost, lost);
	check('and no side takes more than three pads over the fewest', !uneven, uneven);
}

// The real parts, so the deal is checked against numbers a camera reports
// rather than only against round ones.
{
	const ev300 = PINS.sides(93);
	check('hi3516ev300: 93 pads deal 23/23/23/24',
		ev300.left === 23 && ev300.bottom === 23 && ev300.right === 23 && ev300.top === 24,
		JSON.stringify(ev300));
	check('the remainder goes on the top, where there is room for it',
		ev300.top >= ev300.left);

	const square = PINS.sides(80);
	check('a count that divides by four deals evenly',
		square.left === 20 && square.bottom === 20 && square.right === 20 && square.top === 20,
		JSON.stringify(square));
}

// A camera that reports nothing must not produce a package with negative
// sides: the page draws an empty chip rather than throwing, and the "this
// camera cannot say" line is what the owner sees instead.
{
	const none = PINS.sides(0);
	check('no pads deals four empty sides',
		none.left === 0 && none.bottom === 0 && none.right === 0 && none.top === 0,
		JSON.stringify(none));
	const three = PINS.sides(3);
	check('fewer pads than sides still loses none',
		three.left + three.bottom + three.right + three.top === 3,
		JSON.stringify(three));
}

group('fitting the package to the column it is drawn in');

// Keyed to the measured column rather than a media query, because the settings
// page insets its content behind a rail: at a 1680px window the content column
// is about a thousand, and a viewport breakpoint sized the package for the
// window. On the lab hi3516ev300 that overflowed by roughly 200px and had to be
// scrolled to.
{
	const width = (w, cols) => {
		const p = PINS.pitchFor(w, cols);
		// The stylesheet's own sum: body + two lead stacks. The pad on a side
		// is turned end-on, so it is 0.8 of a pitch across and not 0.55 — the
		// arithmetic this test exists to hold, because getting it wrong clipped
		// the right-hand numbers off the drawing and nothing reported it.
		const lbl = Math.max(13, p * 0.8);
		return cols * p + 2 * (lbl + p * 0.1 + p * 0.8 + p * 0.1 + p * 1.75);
	};

	let over = null;
	for (const cols of [12, 18, 24, 30]) {
		for (let w = 240; w <= 1400 && !over; w += 20) {
			// Only where the floor on the numbers does not force it wider: below
			// that the page scrolls the chip in its own container on purpose.
			if (PINS.pitchFor(w, cols) <= 9.001) continue;
			if (width(w, cols) > w + 1) over = cols + ' leads a side in ' + w + 'px -> ' + width(w, cols).toFixed(0);
		}
	}
	check('the package fits the width it is given', !over, over);

	check('a desktop column gets the biggest pitch the design allows',
		PINS.pitchFor(1000, 24) === 23, String(PINS.pitchFor(1000, 24)));
	check('a phone gets a pitch that keeps the numbers readable',
		PINS.pitchFor(342, 24) >= 9 && PINS.pitchFor(342, 24) < 12,
		String(PINS.pitchFor(342, 24)));
	check('and one that low staggers the numbers, which is what the page keys on',
		PINS.pitchFor(342, 24) < 12);
	check('and it never goes below the floor, however narrow',
		PINS.pitchFor(120, 24) === 9 && PINS.pitchFor(0, 24) > 0);
	check('a part with fewer leads a side gets a bigger pitch for the same width',
		PINS.pitchFor(600, 12) > PINS.pitchFor(600, 24));
}

group('which wire, and which bus');

// The thing a category alone cannot say, and the reason this page was reworked:
// "Serial, 8 pins" is not something anybody can act on. TX and RX are different
// wires, SDA and SCL are different wires, and one pad routinely offers two
// different serial ports. Every choice has to name the wire, and the port where
// the chip has more than one.
{
	const label = PINS.offerLabel, hint = PINS.offerHint;

	check('a serial pin says which port and which wire',
		label({ use: 'uart', bus: 3, line: 'RX' }) === 'Serial 3 \u00b7 RX',
		label({ use: 'uart', bus: 3, line: 'RX' }));
	check('the two halves of a bus read differently',
		label({ use: 'i2c', bus: 1, line: 'SDA' }) !==
		label({ use: 'i2c', bus: 1, line: 'SCL' }));
	check('and the same wire on two buses reads differently',
		label({ use: 'i2c', bus: 1, line: 'SDA' }) !==
		label({ use: 'i2c', bus: 2, line: 'SDA' }));
	check('a three-wire module is told apart from a four-wire one',
		label({ use: 'spi', bus: 0, line: 'DATA', variant: '3-wire' })
			.indexOf('3-wire') > 0);
	check('a dimmable output names its channel and no wire',
		label({ use: 'pwm', bus: 1 }) === 'Dimmable output 1',
		label({ use: 'pwm', bus: 1 }));
	check('a plain pin needs neither', label({ use: 'gpio' }) === 'On / off signal',
		label({ use: 'gpio' }));

	check('every wire says what it does, in the words on the module',
		['TX', 'RX', 'SDA', 'SCL', 'MOSI', 'MISO', 'SCK', 'CS', 'CLK', 'CMD']
			.every(l => hint({ use: 'uart', line: l }).length > 8));
	check('a numbered card data wire is explained too',
		hint({ use: 'sd', bus: 0, line: 'DATA2' }).indexOf('data') > 0,
		hint({ use: 'sd', bus: 0, line: 'DATA2' }));

	// The rule that governs all of it: the words on the module, never the words
	// in the chip's manual.
	const manual = /(UART[0-9]|I2C[0-9]|SDIO|_SDO|_SDI|CCLK|CSN|muxctrl)/;
	const samples = [
		{ use: 'uart', bus: 1, line: 'TX' }, { use: 'i2c', bus: 0, line: 'SCL' },
		{ use: 'spi', bus: 2, line: 'MISO' }, { use: 'sd', bus: 1, line: 'DATA3' },
	];
	check('no composed label carries a datasheet spelling',
		samples.every(c => !manual.test(label(c)) && !manual.test(hint(c))));
}

group('the words on the page');

// The six things a person can pick, and the vocabulary rule that governs them:
// what you say while soldering, never what the chip's manual says. A name out
// of a datasheet appearing here is the defect this page exists to avoid, and
// it would arrive as a quiet edit to a label rather than as a failure.
{
	const keys = PINS.USES.map(u => u.k).sort();
	check('the camera and the page agree on the six words',
		JSON.stringify(keys) === JSON.stringify(['gpio', 'i2c', 'pwm', 'sd', 'spi', 'uart']),
		keys.join(','));

	const manual = /(SFC|EMMC|LCD_|VI_|VO_|MIPI|JTAG|muxctrl|0x[0-9A-Fa-f])/;
	const offenders = PINS.USES
		.filter(u => manual.test(u.label) || manual.test(u.hint))
		.map(u => u.k);
	check('no label or hint carries a name out of the chip manual',
		offenders.length === 0, offenders.join(','));

	check('every choice says what you would connect to it',
		PINS.USES.every(u => u.hint && u.hint.length > 6));
}

done();
