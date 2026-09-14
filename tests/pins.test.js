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

group('a level belongs to a plain on/off pin and to nothing else');

// The narrowing is the rule, and it has two halves that fail differently: a
// bus offered a level is a control that could never do anything, and a camera
// that does not do levels offered one is a page claiming a capability it has
// no way to reach.
{
	const gpio = { id: 'gpio', use: 'gpio' };
	const uart = { id: 'uart3.rx', use: 'uart', bus: 3, line: 'RX' };
	const camera = { levels: ['float', 'low', 'high'] };

	check('a plain on/off pin is offered all three',
		PINS.levelsFor(camera, gpio).length === 3,
		String(PINS.levelsFor(camera, gpio).length));
	check('a serial pin is offered none, whatever the camera says',
		PINS.levelsFor(camera, uart).length === 0);
	check('and a camera that does not do levels offers none at all',
		PINS.levelsFor({}, gpio).length === 0 &&
		PINS.levelsFor({ levels: [] }, gpio).length === 0);
	check('a camera that only knows some of them offers only those',
		PINS.levelsFor({ levels: ['float', 'low'] }, gpio).length === 2);
	// One offer left is one the control must not draw: a segmented control
	// with a single option is a label pretending to be a choice.
	check('a pad narrowed to one is below the bar the control draws at',
		PINS.levelsFor({ levels: ['float'] }, gpio).length === 1);

	const three = PINS.levelsFor(camera, gpio);
	check('a level this page does not know clamps to the inert one',
		PINS.normLevel(three, 'floating') === 'float',
		String(PINS.normLevel(three, 'floating')));
	check('and so does a missing one',
		PINS.normLevel(three, undefined) === 'float');
	check('a level it does know survives',
		PINS.normLevel(three, 'high') === 'high');
	check('with nothing on offer there is no level to clamp to',
		PINS.normLevel([], 'high') === null);
}

group('the words for a level');

// The same vocabulary rule as the rest of the page, and one more: the page
// cannot know the rail, so it must never name a voltage.
{
	const manual = /(pull-?up|pull-?down|push-?pull|open.?drain|tri-?state|hi-?z|GPIO|muxctrl|0x)/i;
	const volts = /\d\s*(\.\d)?\s*V\b|volt/i;
	const gpio = { use: 'gpio' };

	const said = PINS.LEVELS.map((l) => l.label)
		.concat(['float', 'low', 'high'].map((k) => PINS.drivesSentence(gpio, k)))
		.concat([PINS.levelSentence('live', 'low'), PINS.levelSentence('live', 'high'),
			PINS.levelSentence('gone', null), PINS.LEVEL_RESTING]);

	check('nothing says a datasheet word',
		said.every((t) => !manual.test(t)), said.filter((t) => manual.test(t)).join(' | '));
	check('and nothing claims a voltage the page cannot know',
		said.every((t) => !volts.test(t)), said.filter((t) => volts.test(t)).join(' | '));

	// "Input" as the first option is the way this feature misleads: it makes a
	// control read as a readout, and somebody concludes the camera is ignoring
	// them.
	check('the inert choice is not called "Input"',
		!/^input$/i.test(PINS.LEVELS[0].label), PINS.LEVELS[0].label);
	check('the choices are imperative and the reading is not',
		PINS.LEVELS[1].label !== PINS.levelSentence('live', 'low'));

	// The pane must not change height as the three are clicked through.
	const longest = Math.max.apply(null,
		['float', 'low', 'high'].map((k) => PINS.drivesSentence(gpio, k).length));
	const shortest = Math.min.apply(null,
		['float', 'low', 'high'].map((k) => PINS.drivesSentence(gpio, k).length));
	check('the three consequences are close enough in length not to reflow',
		longest - shortest < 24, longest + ' vs ' + shortest);

	// The pre-existing bug this change had to fix on the way past: a plain
	// on/off pin the camera merely wires up is an INPUT, and the pane said the
	// camera drove it.
	check('a pin the camera is not holding is not described as driven',
		PINS.drivesSentence(gpio, 'float').indexOf('drives this pin itself') < 0,
		PINS.drivesSentence(gpio, 'float'));
	check('a dimmable output still is',
		PINS.drivesSentence({ use: 'pwm' }, null).indexOf('drives this pin itself') > 0);
	check('and a bus still says whatever is soldered to it takes over',
		PINS.drivesSentence({ use: 'i2c' }, null).indexOf('takes over') > 0);
}

group('a change is two facts now, and either one of them is a change');

// The function the Keep button hangs on. A level-only edit has the same signal
// as the row it replaces, so comparing signals alone left the bar grey over a
// real change — which reads as a page that has stopped responding.
{
	const g = (level) => ({ signal: 'gpio', level: level });

	check('the same signal and the same level is not a change',
		PINS.sameChoice(g('low'), g('low')));
	check('the same signal and a DIFFERENT level is a change',
		!PINS.sameChoice(g('low'), g('high')));
	check('nothing and nothing is not a change', PINS.sameChoice(null, null));
	check('nothing and something is', !PINS.sameChoice(null, g('float')));
	check('a level and no level are told apart',
		!PINS.sameChoice(g('low'), { signal: 'gpio' }));

	const saved = [{ pin: 12, signal: 'gpio', level: 'float' }];
	check('a level-only edit arms the bar',
		JSON.stringify(PINS.changedPins({ 12: g('high') }, saved)) === '[12]',
		JSON.stringify(PINS.changedPins({ 12: g('high') }, saved)));
	check('choosing what a pin already is still does not',
		PINS.changedPins({ 12: g('float') }, saved).length === 0);
	check('and clearing a saved pin does',
		JSON.stringify(PINS.changedPins({ 12: null }, saved)) === '[12]');
}

group('the list the camera is sent');

{
	const saved = [
		{ pin: 3, signal: 'i2c1.scl' },
		{ pin: 12, signal: 'gpio', level: 'low' },
	];
	// What this camera says it knows. Passed on every call, because the list
	// the camera is sent has to be one the camera will take.
	const known = ['float', 'low', 'high'];

	const untouched = PINS.mergePins({}, saved, known);
	check('with no edits the camera gets back what it had',
		untouched.length === 2 && untouched[0].pin === 3 && untouched[1].level === 'low',
		JSON.stringify(untouched));

	const one = PINS.mergePins({ 12: { signal: 'gpio', level: 'high' } }, saved, known);
	check('a level-only edit still sends every other pin',
		one.length === 2 && one.some((r) => r.pin === 3),
		JSON.stringify(one));
	check('and carries the new level',
		one.find((r) => r.pin === 12).level === 'high');

	const cleared = PINS.mergePins({ 3: null }, saved, known);
	check('a pin set back to nothing is left out entirely',
		cleared.length === 1 && cleared[0].pin === 12,
		JSON.stringify(cleared));

	const pins = PINS.mergePins({ 3: { signal: 'i2c1.scl' } }, saved, known).map((r) => r.pin);
	check('no pin appears twice', pins.length === new Set(pins).size, pins.join(','));

	const bus = PINS.mergePins({ 3: { signal: 'i2c1.scl', level: 'low' } }, saved, known)
		.find((r) => r.pin === 3);
	check('a bus row carries no level, whatever is in the edit',
		!('level' in bus), JSON.stringify(bus));

	// The difference between "the owner chose not to drive this one" and "a
	// page that never knew about levels wrote this row". The camera re-applies
	// the stored list at every start, and this decides whether it lets go of a
	// pad it used to hold.
	const inert = PINS.mergePins({ 12: { signal: 'gpio', level: 'float' } }, saved, known)
		.find((r) => r.pin === 12);
	check('a plain on/off row carries its level even when it is the inert one',
		inert.level === 'float', JSON.stringify(inert));
}

// A camera refuses a level word it does not know, and the page sends the WHOLE
// list on every save — so one unrecognised value in an untouched row would have
// the entire save refused, and the owner could not change any pin at all.
{
	const known = ['float', 'low', 'high'];
	const saved = [
		{ pin: 12, signal: 'gpio', level: 'shorted' },
		{ pin: 13, signal: 'gpio' },
	];
	const out = PINS.mergePins({}, saved, known);
	check('a level word this page does not know is not passed back through',
		out.find((r) => r.pin === 12).level === 'float',
		JSON.stringify(out.find((r) => r.pin === 12)));
	check('and a row that never had one is made explicit',
		out.find((r) => r.pin === 13).level === 'float',
		JSON.stringify(out.find((r) => r.pin === 13)));
	check('a camera with no levels at all gets no level member',
		PINS.mergePins({}, saved, null).every((r) => !('level' in r)),
		JSON.stringify(PINS.mergePins({}, saved, null)));
}

group('the drawing never claims a level the socket is not carrying');

// The rule the whole live readout hangs on. A pin shown as low that is
// actually high is a wiring decision made on a lie, so the moment the feed
// stops every mark comes off.
{
	const pads = [{ pin: 12 }, { pin: 13 }, { pin: null }];
	const at = { 12: 1, 13: 0 };

	check('a closed socket claims nothing',
		Object.keys(PINS.levelAttrs('gone', at, pads)).length === 0);
	check('nor does one that has not answered yet',
		Object.keys(PINS.levelAttrs('opening', at, pads)).length === 0);
	check('nor one that was never opened',
		Object.keys(PINS.levelAttrs('shut', at, pads)).length === 0);

	const live = PINS.levelAttrs('live', at, pads);
	check('a live socket marks what it carries',
		live[12] === 'high' && live[13] === 'low', JSON.stringify(live));

	check('a pin the camera reports that is not on this chip is dropped',
		!('99' in PINS.levelAttrs('live', { 99: 1 }, pads)));
	check('a value outside the vocabulary never becomes an attribute',
		Object.keys(PINS.levelAttrs('live', { 12: 'yes', 13: null }, pads)).length === 0,
		JSON.stringify(PINS.levelAttrs('live', { 12: 'yes', 13: null }, pads)));

	// Silence is not a level, so the sentence for it must name neither.
	check('a page with no feed says so without naming a level',
		PINS.levelSentence('gone', 'high').indexOf('high') < 0 &&
		PINS.levelSentence('gone', 'low').indexOf('low') < 0,
		PINS.levelSentence('gone', 'high'));
	check('and the resting sentence is the longest, so it can size the cell',
		PINS.LEVEL_RESTING.length >= PINS.levelSentence('live', 'high').length &&
		PINS.LEVEL_RESTING.length >= PINS.levelSentence('opening', null).length);
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
