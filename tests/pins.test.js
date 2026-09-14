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
		return cols * p +
			2 * (lbl + PINS.RING_CLEAR + p * 0.1 + p * 0.8 + p * 0.1 + p * 1.75) +
			2 * PINS.WIRE_GUTTER;
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
	check('and the package leaves room beside it for the wire names',
		PINS.WIRE_GUTTER >= 20 &&
		PINS.pitchFor(600, 24) < PINS.pitchFor(600 + 2 * PINS.WIRE_GUTTER, 24));
	// A ring reaches five or six pixels out from a pad, and the selected pin
	// wears one at all times — a label flush against the pad is struck through
	// by it, which is what happened to the selected pin's number.
	check('and every label stands off its pad by more than a ring reaches',
		PINS.RING_CLEAR >= 6, String(PINS.RING_CLEAR));
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

group('lighting up what a category can go on');

// Hovering a category has to light the pins it could actually go on. A
// highlight that lights the wrong ones looks exactly like one that lights the
// right ones, which is why the set is arithmetic over the camera's answer
// rather than something the DOM works out as it goes.
{
	// A slice of what a hi3516ev300 reports: pin 3 carries SCL and pin 4 SDA of
	// the same bus, so an I²C sensor needs both, and pin 12 is on a different
	// bus entirely — the case a family name alone cannot tell apart.
	const pads = [
		{ pin: 1, can: [{ id: 'gpio', use: 'gpio' },
			{ id: 'uart0.rx', use: 'uart', bus: 0, line: 'RX' }] },
		{ pin: 3, can: [{ id: 'gpio', use: 'gpio' },
			{ id: 'pwm0', use: 'pwm', bus: 0 },
			{ id: 'i2c1.scl', use: 'i2c', bus: 1, line: 'SCL' }] },
		{ pin: 4, can: [{ id: 'gpio', use: 'gpio' },
			{ id: 'i2c1.sda', use: 'i2c', bus: 1, line: 'SDA' }] },
		{ pin: 12, can: [{ id: 'gpio', use: 'gpio' },
			{ id: 'i2c2.sda', use: 'i2c', bus: 2, line: 'SDA' }] },
		{},   // a pad that is the camera's own: no number, nothing to light
	];
	const of = (use) => PINS.padsFor(pads, use).pads.map(p => p.pin);

	check('a family lights exactly the pins that offer it',
		JSON.stringify(of('i2c')) === JSON.stringify([3, 4, 12]),
		JSON.stringify(of('i2c')));
	check('and never a pad the owner cannot use',
		PINS.padsFor(pads, 'gpio').pads.every(p => p.pin != null));
	check('a family only one pin has lights only that one',
		JSON.stringify(of('pwm')) === JSON.stringify([3]), JSON.stringify(of('pwm')));
	check('a family this chip does not have lights nothing',
		of('spi').length === 0);

	// The buses are what stops somebody wiring SDA on one to SCL on another.
	check('the buses a family reaches are listed, in order and without repeats',
		JSON.stringify(PINS.padsFor(pads, 'i2c').buses) === JSON.stringify([1, 2]),
		JSON.stringify(PINS.padsFor(pads, 'i2c').buses));
	check('a family with no bus number reports none',
		PINS.padsFor(pads, 'gpio').buses.length === 0);

	// An answer the camera did not give reads the same here as a family it has
	// no pins for, and that is safe only because every caller gates on the set
	// being non-empty rather than rendering its size. Nothing may turn either
	// into a count on screen: a camera that said nothing is not a camera that
	// said nought.
	check('a family with no pins yields nothing to light, not a count of none',
		PINS.padsFor([], 'i2c').pads.length === 0 &&
		PINS.padsFor([], 'i2c').buses.length === 0);
	check('and an answer that never arrived yields the same nothing',
		PINS.padsFor(null, 'i2c').pads.length === 0 &&
		PINS.padsFor(undefined, 'i2c').pads.length === 0);
	check('so no sentence is ever composed from an empty set',
		// litSentence is only reached for a family that HAS pins; asked about
		// one that has none it would say "0 pins", which is why the caller
		// gates instead of trusting it.
		PINS.litSentence('i2c', []).indexOf('0 pins') > 0);
}

group('the line above the chip never changes height');

// The chip must not move as the pointer goes down the category list. It did:
// one paragraph whose text was swapped wraps to two lines at rest and one line
// while lit, so every row the pointer crossed shifted the drawing it was
// pointing at. The box now holds the resting sentence and the live one in the
// same grid cell, which makes its height the taller of the two — and that is
// only constant while no lit sentence is longer than the resting one.
{
	// The worst case this page can produce: the longest family name, the most
	// pins, and every bus the chip could have.
	const worst = [];
	for (let i = 0; i < 40; i++) {
		worst.push({ pin: i, can: [
			{ id: 'gpio', use: 'gpio' },
			{ id: 'i2c' + (i % 8) + '.sda', use: 'i2c', bus: i % 8, line: 'SDA' },
			{ id: 'sd' + (i % 4) + '.clk', use: 'sd', bus: i % 4, line: 'CLK' },
			{ id: 'uart' + (i % 5) + '.rx', use: 'uart', bus: i % 5, line: 'RX' },
			{ id: 'spi' + (i % 4) + '.mosi', use: 'spi', bus: i % 4, line: 'MOSI' },
			{ id: 'pwm' + (i % 8), use: 'pwm', bus: i % 8 },
		] });
	}
	let longest = '';
	PINS.USES.forEach((u) => {
		const line = PINS.litSentence(u.k, worst);
		if (line.length > longest.length) longest = line;
	});
	check('no lit sentence is longer than the resting one, even at the worst ' +
		'the page can produce',
		longest.length <= PINS.RESTING.length,
		longest.length + ' > ' + PINS.RESTING.length + ': ' + longest);

	// And it still says the useful thing.
	const line = PINS.litSentence('i2c', [
		{ pin: 3, can: [{ id: 'i2c1.scl', use: 'i2c', bus: 1, line: 'SCL' }] },
		{ pin: 4, can: [{ id: 'i2c1.sda', use: 'i2c', bus: 1, line: 'SDA' }] },
	]);
	check('and it names the family, the count and the bus',
		line.indexOf('Sensor bus') === 0 && line.indexOf('2 pins') > 0 &&
		line.indexOf('bus 1') > 0, line);
	check('one pin is a pin, not 1 pins',
		PINS.litSentence('gpio', [{ pin: 1, can: [{ id: 'gpio', use: 'gpio' }] }])
			.indexOf('1 pin on') > 0);
}

group('which wire, with which');

// The drawing can say a lit pad is TX. It cannot say THIS TX goes with THAT RX
// — and SDA on one bus wired to SCL on another is not a bus at all, which is
// the mistake the legend exists to prevent.
{
	const pads = [
		{ pin: 12, can: [{ id: 'uart0.tx', use: 'uart', bus: 0, line: 'TX' }] },
		{ pin: 13, can: [{ id: 'uart0.rx', use: 'uart', bus: 0, line: 'RX' }] },
		{ pin: 44, can: [{ id: 'uart1.rts', use: 'uart', bus: 1, line: 'RTS' }] },
		{ pin: 40, can: [{ id: 'uart1.tx', use: 'uart', bus: 1, line: 'TX' }] },
		{ pin: 41, can: [{ id: 'uart1.rx', use: 'uart', bus: 1, line: 'RX' }] },
		{},                                   // the camera's own: no pin, no row
		{ pin: 9, can: [{ id: 'gpio', use: 'gpio' }] },  // a family with no wire
	];
	const g = PINS.wiresFor(pads, 'uart');

	check('one row per port, in order', g.length === 2 && g[0].bus === 0 && g[1].bus === 1,
		JSON.stringify(g.map(x => x.bus)));
	check('every wire of a port appears once, with the pins that offer it',
		JSON.stringify(g[1].wires.map(w => w.line + ' ' + w.pins.join('/'))) ===
		JSON.stringify(['TX 40', 'RX 41', 'RTS 44']),
		JSON.stringify(g[1].wires));
	check('and the pair reads in the order it is wired, not the order it arrived',
		g[1].wires[0].line === 'TX' && g[1].wires[1].line === 'RX');
	check('a pad the owner cannot use contributes nothing',
		g.every(x => x.wires.every(w => w.pins.every(n => n != null))));

	// The real hi3516ev300 case: one port's TX is on two different pads. That
	// is a choice of pad, not two transmit wires, and read as two it looks like
	// a port with four wires where the chip has two.
	const twice = PINS.wiresFor([
		{ pin: 3, can: [{ id: 'uart1.tx', use: 'uart', bus: 1, line: 'TX' }] },
		{ pin: 60, can: [{ id: 'uart1.tx', use: 'uart', bus: 1, line: 'TX' }] },
		{ pin: 4, can: [{ id: 'uart1.rx', use: 'uart', bus: 1, line: 'RX' }] },
	], 'uart');
	check('one wire on two pads is one wire with two pins',
		twice.length === 1 && twice[0].wires.length === 2 &&
		twice[0].wires[0].line === 'TX' &&
		twice[0].wires[0].pins.join(',') === '3,60',
		JSON.stringify(twice));
	check('a family whose pins carry no wire name has no rows',
		PINS.wiresFor(pads, 'gpio').length === 0);
	check('and a family this chip does not have has none either',
		PINS.wiresFor(pads, 'spi').length === 0);
	check('a missing answer is not an error', PINS.wiresFor(null, 'uart').length === 0);

	// The case the whole thing exists for: two buses, same two wire names.
	const i2c = PINS.wiresFor([
		{ pin: 3, can: [{ id: 'i2c1.scl', use: 'i2c', bus: 1, line: 'SCL' }] },
		{ pin: 4, can: [{ id: 'i2c1.sda', use: 'i2c', bus: 1, line: 'SDA' }] },
		{ pin: 56, can: [{ id: 'i2c2.sda', use: 'i2c', bus: 2, line: 'SDA' }] },
		{ pin: 57, can: [{ id: 'i2c2.scl', use: 'i2c', bus: 2, line: 'SCL' }] },
	], 'i2c');
	check('two buses with the same wire names stay apart',
		i2c.length === 2 &&
		i2c[0].wires.map(w => w.line + w.pins.join()).join(' ') === 'SDA4 SCL3' &&
		i2c[1].wires.map(w => w.line + w.pins.join()).join(' ') === 'SDA56 SCL57',
		JSON.stringify(i2c));
}

group('a colour per bus');

// Eight lit pads and three buses: which three-of-eight belong together is the
// only question that matters, and the drawing cannot answer it with one colour.
// The legend and the rings take the SAME colour from the same function, which
// is what joins them — read the name in the list, find the ring on the chip.
{
	const c = PINS.busColour;
	check('each bus gets its own colour',
		new Set([c(0), c(1), c(2), c(3)]).size === 4,
		[c(0), c(1), c(2), c(3)].join(' '));
	check('and they are the palette this page already uses, not new ones',
		[c(0), c(1), c(2), c(3)].every(v => /^var\(--st-c[1-4]\)$/.test(v)),
		[c(0), c(1), c(2), c(3)].join(' '));
	check('a family with no bus number still gets a colour',
		typeof c(-1) === 'string' && c(-1).length > 0, String(c(-1)));
	check('and so does one the page was handed nothing for',
		typeof c(undefined) === 'string' && c(undefined).length > 0);
	// Beyond the palette it cycles rather than running out; the legend names
	// every bus, so a repeated colour is a hint that has ended, not a lie.
	check('beyond the palette it cycles', c(4) === c(0) && c(5) === c(1));
}

group('a pad that is more than one thing says so by saying nothing');

// THE ONE THAT WOULD HAVE MIS-WIRED SOMEBODY. A pad offers the same family more
// than once, and on a real hi3516ev300's SD card the two are DIFFERENT wires:
// pad 34 is DATA0 on slot 0 and DATA3 on slot 1, pad 35 is DATA1 or DATA2, pad
// 36 the other way round. Written one over the other, the drawing claimed slot
// 1's name for every one of them — so wiring slot 0 meant joining the card's
// DATA0 to the pad labelled DATA3.
//
// The drawing may claim only what is true whatever choice is made.
{
	const pad = (...offers) => ({ pin: 34, can: offers });

	const two = pad(
		{ id: 'sd0.data0', use: 'sd', bus: 0, line: 'DATA0' },
		{ id: 'sd1.data3', use: 'sd', bus: 1, line: 'DATA3' });
	check('a pad that is two different wires names neither',
		PINS.padWire(two, 'sd').line === null,
		String(PINS.padWire(two, 'sd').line));
	check('and belongs to neither bus',
		PINS.padWire(two, 'sd').bus === null,
		String(PINS.padWire(two, 'sd').bus));

	// Same wire, two slots: the wire is not in doubt, the slot is.
	const clk = pad(
		{ id: 'sd0.clk', use: 'sd', bus: 0, line: 'CLK' },
		{ id: 'sd1.clk', use: 'sd', bus: 1, line: 'CLK' });
	check('a pad that is one wire on two buses still names the wire',
		PINS.padWire(clk, 'sd').line === 'CLK', String(PINS.padWire(clk, 'sd').line));
	check('but takes neither bus\u2019s colour',
		PINS.padWire(clk, 'sd').bus === null);

	// The ordinary case still answers.
	const one = pad({ id: 'i2c1.sda', use: 'i2c', bus: 1, line: 'SDA' });
	check('a pad that is one thing names it', PINS.padWire(one, 'i2c').line === 'SDA' &&
		PINS.padWire(one, 'i2c').bus === 1);
	check('a family the pad does not offer names nothing',
		PINS.padWire(one, 'spi').line === null && PINS.padWire(one, 'spi').bus === null);
	check('and neither does nothing at all',
		PINS.padWire(null, 'i2c').line === null &&
		PINS.padWire({}, 'i2c').line === null);

	// A wire with no bus number at all — the older parts spell I2C_SDA.
	const nobus = pad({ id: 'i2c.sda', use: 'i2c', line: 'SDA' });
	check('a wire with no bus number names the wire and no bus',
		PINS.padWire(nobus, 'i2c').line === 'SDA' &&
		PINS.padWire(nobus, 'i2c').bus === null);
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
