// The pins page: the chip on the board, drawn, and what is soldered to each
// pin.
//
// This is for somebody who can solder to the SoC board — not for an embedded
// engineer. They have attached a thing, a lamp or a button or an I²C sensor,
// and they know what they attached. They do not know, and are never asked,
// which register holds the selector for that pad. Nothing on this page is a
// register address, a selector value or a name out of the chip's manual: the
// camera does that translation behind /api/v1/pinmux and hands back the words
// a person who solders already uses.
//
// It is deliberately NOT the Day / Night pin map. ircut-map.js draws the banks
// the kernel reports as rows of tiles, and says at the top why it is not a
// package drawing: "a package drawing would have to re-pitch itself per SoC,
// and on a BGA its pin numbers would be a fiction anyway." Both halves of that
// are still true and both are answered here rather than ignored. The pitch is
// one CSS custom property every other size derives from, so the package
// re-pitches itself for any pad count; and the positions ARE a drawing, which
// is why the page says so under the chip rather than implying a footprint.
// What this page has that the other one never did is the pad TABLE — which
// register, which selector, which alternatives — so it can draw the pads the
// part actually has, in the order the part has them, including the ones an
// owner must never touch.
//
// Those are drawn and left blank. The flash, the eMMC and the picture sensor's
// own lanes carry no number and nothing to press, because there is nothing an
// owner can do with them and showing them as options invites the one change
// that bricks a camera. A chip with pins missing is not a chip, so they are on
// the drawing; they are simply not offered.
(function () {
	'use strict';

	const API = '/api/v1/pinmux';

	// The six FAMILIES a pin can belong to, in the camera's own spelling, with
	// the words the page shows. A family is how the categories are grouped; it
	// is NOT what a person picks, because a family is not solderable — "Serial"
	// does not say TX or RX, and one pad routinely offers two different serial
	// ports. What they pick is a SIGNAL: the camera sends `uart3.rx` with the
	// family, the port number and the wire's own name, and the page composes
	// "Serial 3 · RX" out of them.
	const USES = [
		{ k: 'gpio', label: 'On / off signal', hint: 'a lamp, a relay, a switch', c: 'a' },
		{ k: 'pwm', label: 'Dimmable output', hint: 'brightness or speed control', c: 'b' },
		{ k: 'i2c', label: 'Sensor bus', hint: 'an I²C sensor or module', c: 'c' },
		{ k: 'spi', label: 'Add-on board', hint: 'an SPI display or module', c: 'd' },
		{ k: 'uart', label: 'Serial', hint: 'a console or serial device', c: 'e' },
		{ k: 'sd', label: 'SD card', hint: 'a memory card slot', c: 'f' },
	];
	const BY_KEY = {};
	USES.forEach((u) => { BY_KEY[u.k] = u; });

	// The camera drives these itself; the rest it only wires up and leaves
	// alone. The consequence differs, so the detail pane says which — never
	// leaving somebody to infer it from the word.
	//
	// `gpio` is NOT in here, and that is a correction rather than an omission.
	// A plain on/off pin the camera merely wires up is an INPUT: something
	// else drives it and the camera reads it. Saying "the camera drives this
	// pin itself" of one was wrong before levels existed and is visibly wrong
	// now that the owner can choose. drivesSentence() below says which,
	// because with a level the answer depends on the level.
	const DRIVEN = { pwm: true };

	// What the camera can be told to do with a plain on/off pin.
	//
	// Imperatives, all three, because this is a control and not a readout —
	// see levelSentence(), which is declarative for exactly that reason. The
	// first one is not called "Input": that single word is the whole
	// difference between "the camera reads this" and "this is what the pin
	// is", and it is the way this feature misleads.
	const LEVELS = [
		{ k: 'float', label: 'Don’t drive it' },
		{ k: 'low', label: 'Hold it low' },
		{ k: 'high', label: 'Hold it high' },
	];

	// Which levels are on offer here. Empty for anything but a plain on/off
	// pin — a bus drives its own wires — and empty for a camera that did not
	// send a `levels` list, which is how an older one says it does not do this
	// at all. The page then shows no control, reserves no space and claims
	// nothing.
	function levelsFor(doc, offer) {
		const known = (doc && doc.levels) || null;
		if (!known || !known.length) return [];
		if (!offer || offer.use !== 'gpio') return [];
		return LEVELS.filter((l) => known.indexOf(l.k) >= 0);
	}

	// Clamp a level to what is on offer. Everything that reaches the DOM or a
	// comparison goes through here, so a spelling this page does not know —
	// from a newer camera, or a hand-edited file — reads as "not driven"
	// rather than becoming an attribute nothing styles.
	function normLevel(levels, level) {
		if (!levels || !levels.length) return null;
		return levels.some((l) => l.k === level) ? level : levels[0].k;
	}

	// Two facts now, and either one of them is a change. This is the function
	// the Keep button hangs on: a level-only edit has the same signal as the
	// saved row, and comparing signals alone left the bar grey over a real
	// change.
	function sameChoice(a, b) {
		if (!a || !b) return !a && !b;
		return a.signal === b.signal && (a.level || null) === (b.level || null);
	}

	// The list the camera is sent, composed out of the edits on this page and
	// the rows it already had. Pure and exported because its bug is silent: a
	// pin dropped here is a pin the camera stops managing.
	function mergePins(pending, saved) {
		const out = [];
		const seen = {};
		Object.keys(pending || {}).forEach((k) => {
			const pin = Number(k);
			seen[pin] = true;
			const e = pending[k];
			if (!e) return;
			const row = { pin: pin, signal: e.signal };
			// Sent even when it is "float", so that "the owner chose not to
			// drive this one" and "a page that never knew about levels wrote
			// this row" are not the same bytes. The camera re-applies this at
			// every start, and the difference decides whether it lets go of a
			// pad it used to hold.
			if (e.signal === 'gpio' && e.level) row.level = e.level;
			out.push(row);
		});
		(saved || []).forEach((row) => {
			if (seen[row.pin]) return;
			const r = { pin: row.pin, signal: row.signal };
			if (row.signal === 'gpio' && row.level) r.level = row.level;
			out.push(r);
		});
		return out;
	}

	// Every edit that actually changes something. Choosing what a pin already
	// is is not a change, and must not arm the bar.
	function changedPins(pending, saved) {
		const rows = saved || [];
		return Object.keys(pending || {})
			.map(Number)
			.filter((p) => {
				const row = rows.find((r) => r.pin === p);
				const was = row
					? { signal: row.signal, level: row.level || null } : null;
				return !sameChoice(pending[p] || null, was);
			});
	}

	// How one choice reads: the family, the port or channel where the chip has
	// more than one, and the wire's own name. The wire names are the ones
	// printed on the module being soldered to — TX, SDA, MOSI, DATA2 — never
	// the chip manual's UART1_RXD or SPI0_SDI.
	function offerLabel(c) {
		const fam = BY_KEY[c.use];
		let out = fam ? fam.label : c.use;
		if (typeof c.bus === 'number') out += ' ' + c.bus;
		if (c.line) out += ' \u00b7 ' + c.line;
		if (c.variant) out += ' (' + c.variant + ')';
		return out;
	}

	// The line above the chip with nothing lit. It is also the SIZER: the box
	// holds this and the live sentence in one grid cell, so its height is this
	// sentence's at whatever width the column has, and the chip below it cannot
	// move as the pointer goes down the category list.
	const RESTING = 'Soldered something to the chip? Tell the camera which pin ' +
		'it went to. The blank pads are the camera\u2019s own \u2014 power, ground, ' +
		'the flash, the picture sensor.';

	// What the camera does with this pin, given what it has been told. One
	// line that changes in place, which is the idiom this pane already has —
	// a segmented control has no room for a hint under each option, and three
	// hints would say the same thing three ways.
	//
	// No volts anywhere: the page cannot know the rail. No "pull-up",
	// "open-drain", "tri-state" or "high-Z" either — those are the datasheet's
	// words, and "pulls it down" is what somebody says with an iron in their
	// hand.
	function drivesSentence(offer, level) {
		if (!offer) return '';
		if (offer.use !== 'gpio') {
			return DRIVEN[offer.use]
				? 'The camera drives this pin itself.'
				: 'The camera sets this pin up and leaves it alone — whatever you ' +
				'soldered to it takes over from there.';
		}
		if (level === 'low') return 'The camera pulls this pin down and holds it there.';
		if (level === 'high') return 'The camera pushes this pin up and holds it there.';
		return 'The camera reads this pin and drives nothing onto it.';
	}

	// The sizer for the live-level cell, and the honest answer when there is
	// nothing to say. Same double duty as RESTING above.
	const LEVEL_RESTING = 'The camera is not saying what this pin is doing right now.';

	// What the pin IS, as opposed to what it was told. Declarative, where the
	// control is imperative: "Hold it high" is a instruction that may not have
	// taken, "Right now it is high" is a reading. If both rendered the same
	// word with the same weight, people would read the control as a readout
	// and conclude the camera was not obeying them.
	function levelSentence(feed, level) {
		if (feed === 'live' && level === 'high') return 'Right now it is high.';
		if (feed === 'live' && level === 'low') return 'Right now it is low.';
		if (feed === 'opening') return 'Asking the camera what it is right now\u2026';
		return LEVEL_RESTING;
	}

	// Pin -> the attribute the drawing carries, and NOTHING unless the feed is
	// live. This is the rule the whole live readout hangs on: a pin shown as
	// low that is actually high is a wiring decision made on a lie, so the
	// moment the socket closes every mark comes off. Separated out so a test
	// can hold it without a DOM.
	function levelAttrs(feed, at, pads) {
		const out = {};
		if (feed !== 'live' || !at) return out;
		const known = {};
		(pads || []).forEach((p) => { if (p.pin != null) known[p.pin] = true; });
		Object.keys(at).forEach((k) => {
			const v = at[k];
			// A value off a websocket must not become a DOM attribute unvetted,
			// and a pin the camera reports that is not on this chip is not
			// ours to draw.
			if (!known[k]) return;
			if (v === 0 || v === 'low') out[k] = 'low';
			else if (v === 1 || v === 'high') out[k] = 'high';
		});
		return out;
	}

	// And the line while a family is lit. Pure, so tests/pins.test.js can check
	// the one thing the no-jump layout depends on — that none of these is
	// longer than RESTING.
	function litSentence(use, pads) {
		const fam = BY_KEY[use];
		const f = padsFor(pads, use);
		const words = INSTANCE[use];
		let out = (fam ? fam.label : use) + ' \u2014 ' + f.pads.length +
			(f.pads.length === 1 ? ' pin' : ' pins') + ' on this chip';
		if (words && f.buses.length) {
			out += ', ' + (f.buses.length === 1 ? words[0] : words[1]) + ' ' +
				f.buses.join(', ');
		}
		return out + '. They are the bright ones.';
	}

	// A colour per bus, so a family with more than one can be told apart on the
	// drawing at a glance: on this chip's I²C there are three, and SDA on one
	// wired to SCL on another is not a bus at all.
	//
	// The four the dashboard already uses, which are validated for
	// colour-vision separation against this card. Beyond four it cycles — the
	// legend names every bus, so a repeated colour is a hint that has run out
	// rather than a statement that is wrong.
	const BUS_COLOURS = ['var(--st-c1)', 'var(--st-c2)', 'var(--st-c3)',
		'var(--st-c4)'];

	function busColour(bus) {
		if (typeof bus !== 'number' || bus < 0) return 'var(--bs-primary)';
		return BUS_COLOURS[bus % BUS_COLOURS.length];
	}

	// The wires of one family, grouped by the bus, port, slot or channel they
	// belong to. This is the half the drawing cannot show: a lit pad can say it
	// is TX, but not that THIS TX goes with THAT RX, and wiring bus 0's SDA to
	// bus 1's SCL is not a bus at all.
	//
	// Pure, so the shape can be tested against what a camera actually sends.
	function wiresFor(pads, use) {
		const groups = [];
		const at = {};
		(pads || []).forEach((p) => {
			if (p.pin == null) return;
			(p.can || []).forEach((c) => {
				if (c.use !== use || !c.line) return;
				const key = typeof c.bus === 'number' ? c.bus : -1;
				if (!(key in at)) {
					at[key] = { bus: key, wires: [], byLine: {} };
					groups.push(at[key]);
				}
				const g = at[key];
				// One entry per wire, listing every pin that offers it. A port
				// whose TX is on either of two pads is a CHOICE of pad, not two
				// transmit wires — and read as two it looks like a port with
				// four wires where the chip has two.
				if (!(c.line in g.byLine)) {
					g.byLine[c.line] = { line: c.line, pins: [] };
					g.wires.push(g.byLine[c.line]);
				}
				if (g.byLine[c.line].pins.indexOf(p.pin) < 0)
					g.byLine[c.line].pins.push(p.pin);
			});
		});
		groups.sort((a, b) => a.bus - b.bus);
		// A pair reads best in the order it is wired: the outgoing wire first.
		const ORDER = ['TX', 'RX', 'CTS', 'RTS', 'SDA', 'SCL', 'MOSI', 'MISO',
			'SCK', 'CS', 'CLK', 'CMD'];
		groups.forEach((g) => {
			g.wires.sort((a, b) => {
				const ia = ORDER.indexOf(a.line), ib = ORDER.indexOf(b.line);
				if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
				return a.line < b.line ? -1 : a.line > b.line ? 1 : 0;
			});
			g.wires.forEach((w) => w.pins.sort((x, y) => x - y));
			delete g.byLine;
		});
		return groups;
	}

	// What ONE pad can say about a family, which is not always its wire.
	//
	// A pad routinely offers the same family more than once, and on this chip's
	// SD card the two are different wires: pad 34 is DATA0 on slot 0 and DATA3
	// on slot 1, pad 35 is DATA1 or DATA2, pad 36 the other way round. Writing
	// each offer over the last left the drawing claiming slot 1's name for
	// every one of them — so somebody wiring slot 0 would have joined their
	// card's DATA0 to the pad labelled DATA3 and got nothing, with no clue why.
	//
	// So the drawing claims only what is true of the pad WHATEVER choice is
	// made: the wire where every offer agrees on it, the bus where every offer
	// agrees on that. Where they do not agree it says nothing — the pad keeps
	// its number and a neutral ring, and the legend beside the chip is where
	// the choice is read.
	function padWire(pad, use) {
		const offers = ((pad && pad.can) || []).filter((c) => c.use === use);
		if (!offers.length) return { line: null, bus: null };
		const line = offers.every((c) => c.line && c.line === offers[0].line)
			? offers[0].line : null;
		const bus = offers.every((c) => c.bus === offers[0].bus)
			? offers[0].bus : null;
		return { line: line, bus: typeof bus === 'number' ? bus : null };
	}

	// Which pads a family could go on, and which buses, ports, slots or
	// channels those pads reach. Pure, and exported, because it is what the
	// highlight and the sentence above the chip both come from — and a
	// highlight that lights the wrong pins looks exactly like one that lights
	// the right ones.
	//
	// An answer the camera did not give reads the same here as a family it has
	// no pins for: an empty set. That is safe ONLY because every caller gates
	// on the set being non-empty rather than rendering its size — litNow()
	// refuses to light a family with no pins, so the sentence above the chip
	// can never say "0 pins on this chip", and paintWires() draws no legend.
	// Reading the count without that gate would state as a fact something the
	// camera never said.
	function padsFor(pads, use) {
		const mine = (pads || []).filter(
			(p) => (p.can || []).some((c) => c.use === use));
		const buses = [];
		mine.forEach((p) => (p.can || []).forEach((c) => {
			if (c.use === use && typeof c.bus === 'number' &&
				buses.indexOf(c.bus) < 0) buses.push(c.bus);
		}));
		buses.sort((x, y) => x - y);
		return { pads: mine, buses: buses };
	}

	// What a family's instances are called. A person wiring an I²C sensor has to
	// put SDA and SCL on the SAME bus, and a page that says only "Sensor bus,
	// 8 pins" does not tell them there are four of them to get wrong.
	const INSTANCE = {
		i2c: ['bus', 'buses'],
		spi: ['bus', 'buses'],
		uart: ['port', 'ports'],
		sd: ['slot', 'slots'],
		pwm: ['channel', 'channels'],
	};

	// And what it is for, which is the family's hint plus, where it matters,
	// what this particular wire does. Nothing here repeats the label.
	const LINE_HINT = {
		TX: 'the camera sends on this wire',
		RX: 'the camera listens on this wire',
		CTS: 'flow control, from the other end',
		RTS: 'flow control, to the other end',
		SDA: 'the data wire of the pair',
		SCL: 'the clock wire of the pair',
		MOSI: 'data out to the module',
		MISO: 'data back from the module',
		SCK: 'the clock',
		DATA: 'the one data wire, in and out',
		CS: 'pulled low while the module is being talked to',
		CLK: 'the clock',
		CMD: 'commands to the card',
		DETECT: 'goes low when a card is in the slot',
		POWER: 'switches power to the slot',
		WP: 'the card\u2019s write-protect tab',
	};

	function offerHint(c) {
		if (c.line) {
			const k = c.line.replace(/[0-9]+$/, '');
			if (k === 'DATA' && /[0-9]$/.test(c.line))
				return 'one of the card\u2019s four data wires';
			if (LINE_HINT[k]) return LINE_HINT[k];
		}
		const fam = BY_KEY[c.use];
		return fam ? fam.hint : '';
	}

	function el(tag, cls, text) {
		const n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text != null) n.textContent = text;
		return n;
	}

	// Which pads go on which side, walked anticlockwise from the corner mark —
	// the way a chip is numbered. The top takes the remainder so the four sides
	// differ by at most one, whatever the part's pad count is.
	function sides(n) {
		const base = Math.floor(n / 4);
		const left = base, bottom = base, right = base;
		return { left: left, bottom: bottom, right: right, top: n - left - bottom - right };
	}

	// Room kept beside the package for the wire names on its left and right
	// columns. The longest of them is five characters — DATA3, POWER — and the
	// ring around a lit pad reaches six pixels out from it, so without a gutter
	// the name sits under its own ring: CLK read as CL, DATA3 as TA3.
	//
	// Reserved always, not while lit, because a package that resized itself on
	// hover would move under the pointer. It is what makes the chip a little
	// smaller than the column it is drawn in.
	const WIRE_GUTTER = 20;

	// How far every label stands off its pad. A ring reaches five or six pixels
	// out — the selected pin wears one at all times, a lit one wears its bus's
	// colour — and a label flush against the pad is drawn over by it: the
	// selected pin's number was struck through by its own ring on every visit
	// to this page. The same clearance serves the number and the wire name, so
	// the two cannot drift apart. */
	const RING_CLEAR = 6;

	// The lead pitch that makes a package of `cols` leads a side fit in `width`
	// pixels. Every other size in the stylesheet derives from this one number,
	// so fitting the chip is solving for it.
	//
	// It is computed rather than keyed to a media query because the page's
	// content column is not the window: the settings rail insets it by some
	// hundreds of pixels, and a viewport breakpoint sized the chip for a width
	// it never had — at a 1680px window the package overflowed its column by
	// about 200px and had to be scrolled to. Measuring is the only thing that
	// is right on every screen AND on a column whose width the chip does not
	// choose.
	//
	// Two cases because the label stops shrinking at 9px, and its box at 13px,
	// so the numbers stay readable on a phone: above that the width is linear
	// in the pitch, below it there is a constant 13px of label either side.
	function pitchFor(width, cols) {
		const MIN = 9, MAX = 23, FLOOR_AT = 16.25;
		if (!(width > 0) || !(cols > 0)) return MAX;
		const room = width - 2 * WIRE_GUTTER;
		if (room <= 0) return MIN;
		let p = (room - 2 * RING_CLEAR) / (cols + 7.1);
		if (p < FLOOR_AT) p = (room - 2 * (13 + RING_CLEAR)) / (cols + 5.5);
		return Math.max(MIN, Math.min(MAX, p));
	}

	function mount(host, opts) {
		opts = opts || {};
		let doc = null;          // the last answer from the camera
		let sel = null;          // the pin whose detail is open
		let pending = {};        // pin -> use, changed here and not kept
		let trying = false;      // a window is open on the camera
		let left = 0;            // seconds of it remaining
		let tick = null, beat = null;
		let note = '';           // the line the change bar shows
		// Set by destroy(). Every callback that could start or keep a window
		// open checks it: a try whose reply lands after the section has gone
		// would otherwise begin a heartbeat on a detached page and hold the
		// pads open with nobody watching — which is the one state the window
		// exists to end.
		let dead = false;
		// Which family the chip is currently lighting up, and whether a click
		// pinned it there. Hover answers "where do I solder this?" at a glance;
		// the click is for reading the chip afterwards without the pointer
		// having to stay on the row, and it is the whole of the interaction on
		// a touch screen, which has no hover at all.
		let litPinned = null, litPointer = null, litFocus = null;
		let introEl = null, wiresEl = null;

		const root = el('div', 'mj-pins');
		host.appendChild(root);

		// Through the shared wrapper, like every other page: it turns a 401
		// into the login redirect rather than letting a signed-out session
		// parse an error body as pin data, and it carries the header the
		// camera's cross-site check looks for.
		//
		// A refusal now arrives as a status as well as a body, so this reads
		// the body either way and never resolves without one — a rejected
		// promise with no catch left the countdown running and the bar
		// claiming a trial that was not there.
		const FETCH = (typeof window === 'object' && window.apiFetch) || fetch;

		function post(action, pins) {
			const body = pins ? JSON.stringify({ pins: pins }) : null;
			return FETCH(API + '?do=' + action, {
				method: 'POST',
				headers: body ? { 'Content-Type': 'application/json' } : {},
				body: body,
				credentials: 'same-origin',
			}).then(
				(r) => r.json().catch(() => ({ error: 'the camera answered with '
					+ (r.status || 'nothing this page could read') })),
				(e) => ({ error: 'the camera could not be reached: ' + e.message }));
		}

		// What the camera has been told a pin is: the edit on this page if
		// there is one, otherwise the saved row. `null` in `pending` is the
		// deliberate "set it back to nothing" — distinct from having no edit,
		// which is what makes clearing a saved pin possible at all.
		//
		// An ENTRY is one object, {signal, level}, not a signal here and a
		// level in a second map beside it. Two maps would break the three
		// things this file depends on: a level-only edit would be absent from
		// `pending` entirely, so changed() would miss it and the Keep button
		// would stay grey over a real change; a pin taken from gpio to a bus
		// and back would leave a stale level behind, and Keep would start
		// driving a pad somebody has a relay on; and "set it back to nothing"
		// is one null here with no partner over there.
		function savedChoice(pin) {
			const row = ((doc && doc.saved) || []).find((r) => r.pin === pin);
			if (!row) return null;
			const offer = offerOfPin(pin, row.signal);
			const levels = levelsFor(doc, offer);
			return {
				signal: row.signal,
				level: levels.length ? normLevel(levels, row.level) : null,
			};
		}
		function currentChoice(pin) {
			return Object.prototype.hasOwnProperty.call(pending, pin)
				? pending[pin] : savedChoice(pin);
		}
		// The signal alone, for the callers that only want that.
		function savedUse(pin) {
			const c = savedChoice(pin);
			return c ? c.signal : null;
		}
		function currentUse(pin) {
			const c = currentChoice(pin);
			return c ? c.signal : null;
		}
		function offerOfPin(pin, id) {
			return offerOf(((doc && doc.pads) || []).find((p) => p.pin === pin), id);
		}

		// Every edit that actually changes something.
		function changed() {
			return Object.keys(pending)
				.map(Number)
				.filter((p) => !sameChoice(pending[p] || null, savedChoice(p)));
		}

		// The WHOLE list, because the camera replaces its list with what
		// arrives: a pin left out is one set back to nothing, which is exactly
		// what a cleared pin should be.
		function wholeList() {
			return mergePins(pending, (doc && doc.saved) || []);
		}

		// Lighting a family is one attribute and one sentence. Nothing is
		// rebuilt, so this is safe to call from a pointer moving across the
		// list.
		// What is lit: whatever the pointer or the keyboard is on, and the
		// pinned one when it is on neither. Hovering a second row while one is
		// pinned previews the second and goes back to the first on the way out
		// — a hover that did nothing because something was pinned reads as a
		// page that has stopped responding.
		// The pointer and the keyboard are tracked apart. Sharing one slot meant
		// a pointer entering and leaving a second row cleared the highlight off
		// a row that still had focus.
		function litNow() {
			const want = litPointer || litFocus || litPinned;
			// A family the camera reports no pins for is not lit at all: lighting
			// it would dim every lead and say "0 pins on this chip", which is a
			// sentence about nothing. Reachable when a refresh answers with less
			// than it did while a category is pinned.
			if (!want) return null;
			return padsFor((doc && doc.pads) || [], want).pads.length ? want : null;
		}

		// One row per bus: its name, then each wire and the pin it is on.
		function paintWires() {
			if (!wiresEl) return;
			wiresEl.textContent = '';
			const use = litNow();
			if (!use) return;
			const words = INSTANCE[use];
			const groups = wiresFor((doc && doc.pads) || [], use);
			if (!groups.length) return;
			wiresEl.appendChild(el('div', 'mj-pins-wires-head',
				groups.length === 1 ? 'The wires' : 'Which bus, and its wires'));
			groups.forEach((g) => {
				const row = el('p', 'mj-pins-wire-row');
				if (words && g.bus >= 0) {
					const name = el('b', null, words[0] + ' ' + g.bus);
					const dot = el('span', 'mj-pins-wire-dot');
					dot.style.background = busColour(g.bus);
					name.insertBefore(dot, name.firstChild);
					row.appendChild(name);
				}
				g.wires.forEach((w) => {
					const chip = el('span', 'mj-pins-wire');
					chip.appendChild(el('i', null, w.line));
					// Every pin that offers this wire: pick one of them.
					chip.appendChild(el('em', null, w.pins.join(' or ')));
					row.appendChild(chip);
				});
				wiresEl.appendChild(row);
			});
		}

		function applyLit() {
			if (!root) return;
			const now = litNow();
			if (now) root.setAttribute('data-lit', now);
			else root.removeAttribute('data-lit');

			root.querySelectorAll('.mj-pins-kind').forEach((b) => {
				const mine = b.getAttribute('data-use');
				b.classList.toggle('is-lit', mine === now);
				b.setAttribute('aria-pressed', String(mine === litPinned));
			});

			if (introEl) introEl.textContent = introText();
			paintWires();

		}

		// What the line above the chip says. It is the same element either way,
		// so the page does not jump as a pointer crosses the list.
		function restingText() { return RESTING; }

		function introText() {
			const lit = litNow();
			return lit ? litSentence(lit, (doc && doc.pads) || []) : RESTING;
		}

		// The camera's description of one signal on one pad.
		function offerOf(pad, id) {
			if (!pad || !id) return null;
			return (pad.can || []).find((c) => c.id === id) || null;
		}

		function stopClocks() {
			if (tick) { clearInterval(tick); tick = null; }
			if (beat) { clearInterval(beat); beat = null; }
		}

		// ── what the pins are doing, live ─────────────────────────────────────

		let ws = null, reopen = null, retry = 1000, everOpen = false;
		let queued = false;

		// Coalesced onto a frame. A pin toggling fast would otherwise call
		// applyLevels() at whatever rate the camera publishes. A background tab
		// stops firing rAF, so the flag stays set and one apply runs on return
		// with the latest state — which is the right behaviour, not a bug.
		function levelsArrived() {
			if (queued || dead) return;
			queued = true;
			const run = () => { queued = false; if (!dead) applyLevels(); };
			if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
			else setTimeout(run, 16);
		}

		function wsOpen() {
			// Only once the GET has succeeded. A handshake reaches JS as an
			// opaque onerror with no status, so a socket can never be the thing
			// that discovers the session has gone — refresh() goes through the
			// shared fetch, which is what turns a signed-out session into the
			// login redirect.
			if (dead || ws || reopen) return;
			if (!doc || !doc.have || !doc.levels || !doc.levels.length) return;
			feed = 'opening';
			applyLevels();
			const proto = location.protocol === 'https:' ? 'wss' : 'ws';
			try {
				ws = new WebSocket(proto + '://' + location.host + '/ws/pins');
			} catch (e) {
				// A blocked or mixed-content URL throws right here, and an
				// uncaught throw would take the rest of refresh() with it.
				ws = null;
				feed = 'gone';
				applyLevels();
				return;
			}
			ws.onopen = () => {
				if (dead) return;
				retry = 1000;
				// A reconnect has missed every change in between. The camera
				// sends a whole state on connect, so this is the belt rather
				// than the braces — but a page that has been away deserves the
				// saved list re-read too.
				if (everOpen) refresh();
				everOpen = true;
			};
			ws.onmessage = (ev) => {
				if (dead) return;
				let d = null;
				try { d = JSON.parse(ev.data); } catch (e) { return; }
				if (!d || !Array.isArray(d.pins)) return;
				if (d.full) at = {};
				d.pins.forEach((r) => {
					if (r == null || typeof r.pin !== 'number') return;
					if (r.gone) { delete at[r.pin]; return; }
					// null is "it would not answer", which is not a level and
					// must not be drawn as one.
					if (r.level === 0 || r.level === 1) at[r.pin] = r.level;
					else delete at[r.pin];
				});
				feed = 'live';
				levelsArrived();
			};
			ws.onerror = () => { /* onclose follows; nothing to do here */ };
			ws.onclose = () => {
				ws = null;
				if (dead) return;
				// Every mark comes off the moment the feed stops. A stale level
				// is worse than none: a pin shown as low that is actually high
				// is a wiring decision made on a lie.
				feed = 'gone';
				at = {};
				applyLevels();
				reopen = setTimeout(() => { reopen = null; wsOpen(); }, retry);
				retry = Math.min(retry * 2, 30000);
			};
		}

		function wsShut() {
			if (reopen) { clearTimeout(reopen); reopen = null; }
			if (ws) {
				// Nulled before closing, so a close landing after teardown
				// cannot schedule a reconnect onto a page that has gone.
				ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
				try { ws.close(); } catch (e) { /* already gone */ }
				ws = null;
			}
			feed = 'shut';
			at = {};
		}

		// While the page is open and healthy it tells the camera so, which is
		// why nobody watching ever sees the window expire. It fires only when
		// the thing that would have noticed is gone.
		function startClocks(seconds, beatSeconds) {
			if (dead) { post('undo').catch(() => {}); return; }
			stopClocks();
			trying = true;
			left = seconds;
			paint();
			tick = setInterval(() => {
				left = Math.max(0, left - 1);
				if (left === 0) { stopClocks(); trying = false; refresh(); }
				else paintBar();
			}, 1000);
			beat = setInterval(() => {
				post('beat').then((r) => {
					if (dead) return;
					if (!r || !r.alive) { stopClocks(); trying = false; refresh(); return; }
					left = r.seconds;
				});
			}, Math.max(1, beatSeconds || 10) * 1000);
		}

		function refresh() {
			return FETCH(API, { credentials: 'same-origin' })
				.then((r) => r.json())
				.then((d) => {
					if (dead) return;
					doc = d;
					if (sel == null) {
						const first = (d.pads || []).find((p) => p.pin != null);
						sel = first ? first.pin : null;
					}
					// The whole first state, so the first delta is already
					// complete — including pins that will never change and so
					// will never produce one. Seeded, not shown: nothing is
					// drawn until the socket says it is live.
					if (d.at && typeof d.at === 'object') {
						at = {};
						Object.keys(d.at).forEach((k) => {
							const v = d.at[k];
							if (v === 0 || v === 1) at[k] = v;
						});
					}
					paint();
					wsOpen();
				})
				.catch((e) => {
					if (dead) return;
					root.textContent = '';
					root.appendChild(el('p', 'mj-pins-empty',
						'The camera did not answer: ' + e.message));
				});
		}

		// ── the chip ──────────────────────────────────────────────────────────

		// Pin -> its lead button, so a level arriving does not have to query
		// the DOM. Cleared and refilled by chip().
		let leadByPin = {};

		// What the camera says the pins are doing, and whether it is still
		// saying it. `at` is NEVER merged into `pending`: `pending` is what the
		// owner asked for and `at` is what the pin is, and keeping them apart
		// is what makes "a pushed level armed the Keep button" impossible
		// rather than merely unlikely.
		let at = {};
		let feed = 'shut'; // 'shut' | 'opening' | 'live' | 'gone'

		function padTitle(pad, c, want) {
			let t = 'Pin ' + pad.pin + ' \u2014 ' +
				(pad.used || (c && c.use !== 'gpio' ? offerLabel(c) : 'free'));
			if (want && want.signal === 'gpio' && want.level === 'low') t += ', held low';
			else if (want && want.signal === 'gpio' && want.level === 'high') t += ', held high';
			const live = levelAttrs(feed, at, (doc && doc.pads) || [])[pad.pin];
			if (live) t += ' \u2014 right now it is ' + live;
			return t;
		}

		// One attribute per lead, and nothing else touched — the same shape as
		// applyLit(), and for the same reason: the hover highlight depends on
		// there being no repaint, so a level arriving must never rebuild.
		function applyLevels() {
			const marks = levelAttrs(feed, at, (doc && doc.pads) || []);
			Object.keys(leadByPin).forEach((k) => {
				const b = leadByPin[k];
				if (!b) return;
				if (marks[k]) b.setAttribute('data-level', marks[k]);
				else b.removeAttribute('data-level');
			});
			if (nowEl) {
				nowEl.textContent = levelSentence(feed,
					sel == null ? null : marks[sel]);
			}
		}

		// The live-level paragraph in the detail pane, when the pane has one,
		// and the two lines refreshChoice() rewrites in place.
		let nowEl = null, drivesEl = null, whatEl = null;

		function lead(pad) {
			const b = el('button', 'mj-pin-lead');
			b.type = 'button';
			const usable = pad.pin != null;
			const lbl = el('span', 'mj-pin-lbl', usable ? String(pad.pin) : '');
			const dot = el('span', 'mj-pin-pad');
			const trace = el('span', 'mj-pin-trace');
			b.appendChild(lbl);
			b.appendChild(dot);
			b.appendChild(trace);

			if (!usable) {
				// Power, ground, the flash, the picture sensor's own lanes.
				b.className += ' mj-pin-own';
				b.tabIndex = -1;
				b.setAttribute('aria-hidden', 'true');
				return b;
			}

			// Every family this pad can be, as a class, and the WIRE it would be
			// in each, as an attribute the stylesheet reads. Lighting a
			// category is then one attribute on the wrapper and no lead is
			// touched at all — a pointer crossing six rows would otherwise
			// rebuild ninety-three buttons six times, and the chip has to
			// answer at a glance.
			const fams = [];
			(pad.can || []).forEach((c) => {
				if (fams.indexOf(c.use) < 0) fams.push(c.use);
			});
			fams.forEach((use) => {
				b.className += ' has-' + use;
				// Once per FAMILY, not once per offer: a pad that offers one
				// twice would otherwise have each write over the last, and the
				// drawing would claim the final one as though it were the only
				// one.
				const w = padWire(pad, use);
				if (w.line) lbl.setAttribute('data-wire-' + use, w.line);
				// The bus this pad belongs to, as a colour the stylesheet reads
				// when that family is lit. One rule per family then covers
				// every bus. A pad that spans two buses takes neither colour:
				// it belongs to both until somebody chooses.
				b.style.setProperty('--bus-' + use,
					w.bus === null ? 'var(--bs-primary)' : busColour(w.bus));
			});

			const want = currentChoice(pad.pin);
			const shown = (want && want.signal) || pad.now;
			const c = offerOf(pad, shown);
			const u = c ? BY_KEY[c.use] : null;
			if (!sameChoice(want, savedChoice(pad.pin))) b.className += ' mj-pin-changed';
			else if (pad.used || want) b.className += ' mj-pin-taken mj-pin-c' + (u ? u.c : 'a');
			if (sel === pad.pin) b.className += ' mj-pin-sel';

			b.title = padTitle(pad, c, want);
			// Registered so applyLevels() can reach this lead without asking
			// the DOM for it. Rebuilt every paint(), because paint() throws
			// every button away.
			leadByPin[pad.pin] = b;
			b.addEventListener('click', () => { sel = pad.pin; paint(); });
			return b;
		}

		let pkgEl = null, chipPane = null, cols = 0;

		// The body is as wide as the side with the most leads, so a part with
		// more or fewer pads than another gets a package that still looks like
		// one rather than a rectangle with leads hanging off the ends.
		function fit() {
			if (!pkgEl || !chipPane) return;
			const w = chipPane.clientWidth;
			if (!w) return;
			const p = pitchFor(w, cols);
			pkgEl.style.setProperty('--mj-pitch', p.toFixed(2) + 'px');
			pkgEl.style.setProperty('--mj-body', 'calc(var(--mj-pitch) * ' + cols + ')');
			// Below about twelve pixels a two-digit number is wider than its own
			// slot and the row reads as one long number, so the top and bottom
			// go onto two rows the way a dense pinout drawing does. Keyed to the
			// pitch rather than to the viewport, because the pitch is what
			// actually decides it: a wide window with a narrow content column
			// hits this and a media query did not.
			pkgEl.classList.toggle('mj-pkg-stagger', p < 12);
		}

		function chip() {
			// Every lead is about to be thrown away and rebuilt, so the map
			// starts empty rather than holding buttons that are no longer in
			// the document.
			leadByPin = {};
			const pads = (doc && doc.pads) || [];
			const s = sides(pads.length);
			cols = Math.max(s.top, s.bottom, 1);
			const cut = {
				left: pads.slice(0, s.left),
				bottom: pads.slice(s.left, s.left + s.bottom),
				right: pads.slice(s.left + s.bottom, s.left + s.bottom + s.right).reverse(),
				top: pads.slice(s.left + s.bottom + s.right).reverse(),
			};

			const pkg = el('div', 'mj-pkg');
			const row = (name) => {
				const d = el('div', 'mj-pkg-' + name);
				cut[name].forEach((p) => d.appendChild(lead(p)));
				return d;
			};
			pkg.appendChild(row('top'));
			const mid = el('div', 'mj-pkg-mid');
			mid.appendChild(row('left'));
			const body = el('div', 'mj-pkg-body');
			// The only orientation mark a real package carries, and the thing
			// you actually look for with the board in front of you.
			body.appendChild(el('span', 'mj-pkg-key'));
			const die = el('span', 'mj-pkg-die');
			die.appendChild(el('span', 'mj-pkg-name', (doc && doc.chip) || ''));
			body.appendChild(die);
			mid.appendChild(body);
			mid.appendChild(row('right'));
			pkg.appendChild(mid);
			pkg.appendChild(row('bottom'));
			pkgEl = pkg;
			return pkg;
		}

		// ── the three panes ───────────────────────────────────────────────────

		function kindsPane() {
			const pane = el('div', 'mj-pins-kinds');
			pane.appendChild(head('What you can connect'));
			const pads = (doc && doc.pads) || [];
			USES.forEach((u) => {
				const f = padsFor(pads, u.k);
				const mine = f.pads;
				if (!mine.length) return; // not a family this chip has
				const b = el('button', 'mj-pins-kind');
				b.type = 'button';
				b.setAttribute('data-use', u.k);
				b.setAttribute('aria-pressed', 'false');

				// Hover and keyboard focus light the pins this could go on;
				// a click holds them lit so the chip can be read with the
				// pointer somewhere else — and a click is the whole of it on a
				// touch screen, which has no hover to offer.
				b.addEventListener('mouseenter', () => {
					litPointer = u.k;
					applyLit();
				});
				b.addEventListener('mouseleave', () => {
					if (litPointer === u.k) litPointer = null;
					applyLit();
				});
				b.addEventListener('focus', () => {
					litFocus = u.k;
					applyLit();
				});
				b.addEventListener('blur', () => {
					if (litFocus === u.k) litFocus = null;
					applyLit();
				});
				b.addEventListener('click', () => {
					litPinned = litPinned === u.k ? null : u.k;
					applyLit();
				});

				b.appendChild(el('span', 'mj-pins-dot mj-pins-c' + u.c));
				const txt = el('span', 'mj-pins-kind-txt');
				txt.appendChild(el('span', null, u.label));

				// Which buses, ports, slots or channels this chip has, because
				// the pins of one are not interchangeable with the pins of
				// another: SDA on bus 1 and SCL on bus 2 is not a bus.
				const buses = f.buses;
				const words = INSTANCE[u.k];
				if (words && buses.length) {
					txt.appendChild(el('em', null,
						(buses.length === 1 ? words[0] : words[1]) + ' ' +
						buses.join(', ')));
				}
				b.appendChild(txt);
				b.appendChild(el('span', 'mj-pins-n', String(mine.length)));
				pane.appendChild(b);
			});

			// The wire legend goes at the FOOT of this pane: beside the row the
			// pointer is on rather than below the drawing, and with nothing
			// underneath it, so it can appear and disappear without moving
			// anything. Under the chip it would have needed room reserved for
			// the widest family this chip has — four channels on this part,
			// eight buses on others — which is a stripe of empty space under
			// the drawing at all times.
			const used = pads.filter((p) => p.used);
			if (used.length) {
				const box = el('div', 'mj-pins-uses');
				box.appendChild(head('The camera is using'));
				used.forEach((p) => {
					const line = el('p', 'mj-pins-use');
					const b = el('b', null, 'Pin ' + p.pin);
					line.appendChild(b);
					line.appendChild(document.createTextNode(' — ' + p.used));
					box.appendChild(line);
				});
				pane.appendChild(box);
			}
			wiresEl = el('div', 'mj-pins-wires');
			pane.appendChild(wiresEl);
			return pane;
		}

		function head(text) {
			const h = el('div', 'mj-live-head');
			h.appendChild(el('h3', 'mj-cap', text));
			h.appendChild(el('span', 'mj-live-rule'));
			return h;
		}

		function detailPane() {
			const pane = el('div', 'mj-pins-detail');
			const pad = ((doc && doc.pads) || []).find((p) => p.pin === sel);
			const h = head(pad ? 'Pin ' + pad.pin : 'Pin');
			pane.appendChild(h);
			if (!pad) {
				pane.appendChild(el('p', 'mj-pins-empty', 'Pick a pin to see what it can be.'));
				return pane;
			}

			const want = currentChoice(pad.pin);
			const edited = !sameChoice(want, savedChoice(pad.pin));
			// Two different facts, and the pane says the same one twice rather
			// than one in the heading and the other underneath. What the pad IS
			// comes from the register; what the camera was TOLD comes from the
			// list, and a pad set by the boot rather than by anybody here has
			// the first without the second. `shown` is whichever of them the
			// pane is describing, so the heading and the ticked choice can
			// never disagree — the first draft headed a pin Serial and then
			// said nothing was connected to it, with Nothing ticked.
			const nowOffer = offerOf(pad, pad.now);
			// A pin the owner is holding is not free — the camera has hold of
			// it. Saying "Free" at the top of the pane about a pad that is
			// being driven is the first thing read and the wrongest.
			const heldWord = want && want.signal === 'gpio' && want.level === 'low'
				? 'Held low'
				: want && want.signal === 'gpio' && want.level === 'high'
					? 'Held high' : null;
			whatEl = el('p', 'mj-pins-what',
				pad.used ? pad.used
					: heldWord ? heldWord
						: nowOffer && nowOffer.use !== 'gpio'
							? offerLabel(nowOffer) : 'Free');
			pane.appendChild(whatEl);
			pane.appendChild(el('p', 'mj-pins-sub',
				edited ? 'Changed here. Not kept yet.'
					: pad.used ? 'The camera drives this pin itself.'
						: want ? 'You told the camera this, and it comes back after a reboot.'
							: nowOffer && nowOffer.use !== 'gpio'
								? 'The board came up this way. The camera did not set it, ' +
								'and leaves it alone.'
								: 'Nothing is connected to this pin yet.'));

			pane.appendChild(head('Use this pin for'));
			// One row per SIGNAL the pad offers, grouped by family so a pad with
			// eight of them still reads as a short list rather than a jumble.
			const offers = (pad.can || []).slice().sort((a, b2) => {
				const ia = USES.findIndex((u) => u.k === a.use);
				const ib = USES.findIndex((u) => u.k === b2.use);
				if (ia !== ib) return ia - ib;
				return (a.bus || 0) - (b2.bus || 0);
			});
			const rows = [{ id: null, label: 'Nothing',
				hint: 'the camera leaves this pin alone', c: 'z' }]
				.concat(offers.map((c) => ({
					id: c.id,
					label: offerLabel(c),
					hint: offerHint(c),
					c: (BY_KEY[c.use] || {}).c || 'z',
				})));
			rows.forEach((o) => {
				const b = el('button', 'mj-pins-choice');
				b.type = 'button';
				if (o.id === (want && want.signal)) b.className += ' mj-pins-choice-on';
				b.appendChild(el('span', 'mj-pins-dot mj-pins-c' + o.c));
				const txt = el('span', 'mj-pins-choice-txt');
				txt.appendChild(el('b', null, o.label));
				txt.appendChild(el('em', null, o.hint));
				b.appendChild(txt);
				b.addEventListener('click', () => {
					if (!o.id) { pending[pad.pin] = null; paint(); return; }
					// The level is carried across only when the pin stays a
					// plain on/off signal; anything else starts from the inert
					// one. THE DEFAULT MUST BE INERT: picking "On / off signal"
					// must never begin driving a pad, and this is the line
					// where that would go wrong.
					const levels = levelsFor(doc, offerOf(pad, o.id));
					const carried = want && want.signal === 'gpio' ? want.level : null;
					pending[pad.pin] = {
						signal: o.id,
						level: levels.length ? normLevel(levels, carried) : null,
					};
					paint();
				});
				pane.appendChild(b);
			});

			const wantOffer = offerOf(pad, want && want.signal);

			// The level control. Only where the chosen signal is a plain on/off
			// pin, and never on a pad the camera drives itself — that one is
			// not the owner's to hold, and the camera refuses it at the door
			// anyway. The `pad.used` belt is here as well as the gate falling
			// out of currentChoice() being null, because a saved row for a pin
			// the camera has since claimed would otherwise slip through.
			const levels = pad.used ? [] : levelsFor(doc, wantOffer);
			if (levels.length > 1) {
				pane.appendChild(head('What the camera does with it'));
				const seg = el('div', 'mj-seg mj-seg-stack');
				seg.setAttribute('role', 'group');
				seg.setAttribute('aria-label', 'What the camera does with pin ' + pad.pin);
				const name = 'mj-pin-level-' + pad.pin;
				levels.forEach((lv) => {
					const id = name + '-' + lv.k;
					const inp = el('input', 'mj-seg-in');
					inp.type = 'radio';
					inp.name = name;
					inp.id = id;
					inp.autocomplete = 'off';
					if (lv.k === want.level) inp.checked = true;
					const lbl = el('label', 'mj-seg-lbl', lv.label);
					lbl.setAttribute('for', id);
					inp.addEventListener('change', () => {
						if (!inp.checked) return;
						pending[pad.pin] = { signal: want.signal, level: lv.k };
						// NOT paint(). The choice rows above call it, which
						// destroys the clicked button and drops focus to the
						// body — survivable for a button, fatal for a control
						// you navigate with the arrow keys, where every press
						// would rebuild the radios and the keyboard user could
						// move exactly once.
						refreshChoice(pad);
					});
					seg.appendChild(inp);
					seg.appendChild(lbl);
				});
				pane.appendChild(seg);
			}

			if (wantOffer) {
				drivesEl = el('p', 'mj-pins-drives',
					drivesSentence(wantOffer, want && want.level));
				pane.appendChild(drivesEl);
			} else {
				drivesEl = null;
			}

			// What the pin IS right now, as opposed to what it was told. Shown
			// for a pad the camera drives itself too, even though that one gets
			// no control: "the IR-cut opening coil is high right now" is worth
			// knowing, and a readout is a fact rather than a permission.
			//
			// Two stacked in one grid cell, the same trick the intro box uses:
			// a hidden sizer holding the longest sentence, and the live one
			// over it, so text arriving cannot change the pane's height.
			nowEl = null;
			if ((doc && doc.levels && doc.levels.length) &&
				(wantOffer ? wantOffer.use === 'gpio' : !!pad.used)) {
				const box = el('div', 'mj-pins-now');
				box.appendChild(el('span', 'mj-pins-now-sizer', LEVEL_RESTING));
				nowEl = el('span', 'mj-pins-now-live');
				box.appendChild(nowEl);
				pane.appendChild(box);
			}
			return pane;
		}

		// Everything a level change alters, written in place. No node is
		// created or destroyed, so focus and the hover highlight both survive
		// — which is the whole reason it exists beside paint() rather than
		// being paint().
		function refreshChoice(pad) {
			const want = currentChoice(pad.pin);
			const wantOffer = offerOf(pad, want && want.signal);
			if (drivesEl) {
				drivesEl.textContent = drivesSentence(wantOffer, want && want.level);
			}
			if (whatEl) {
				whatEl.textContent = pad.used ? pad.used
					: want && want.signal === 'gpio' && want.level === 'low' ? 'Held low'
						: want && want.signal === 'gpio' && want.level === 'high' ? 'Held high'
							: (() => {
								const n = offerOf(pad, pad.now);
								return n && n.use !== 'gpio' ? offerLabel(n) : 'Free';
							})();
			}
			const b = leadByPin[pad.pin];
			if (b) {
				const c = offerOf(pad, (want && want.signal) || pad.now);
				b.title = padTitle(pad, c, want);
				const changedNow = !sameChoice(want, savedChoice(pad.pin));
				b.classList.toggle('mj-pin-changed', changedNow);
			}
			paintBar();
		}

		// ── the change bar ────────────────────────────────────────────────────

		let bar = null;

		function paintBar() {
			if (!bar) return;
			bar.textContent = '';
			const n = changed().length;
			const msg = el('span', 'mj-pins-msg', trying
				? 'Trying it. ' + left + (left === 1 ? ' second' : ' seconds') +
				' left before the camera puts it back.'
				: note || (n === 0 ? 'Nothing changed'
					: n === 1 ? '1 change not kept yet' : n + ' changes not kept yet'));
			bar.appendChild(msg);
			bar.appendChild(el('span', 'mj-pins-spacer'));

			const add = (label, cls, fn, disabled) => {
				const b = el('button', 'btn btn-sm ' + cls, label);
				b.type = 'button';
				b.disabled = !!disabled;
				b.addEventListener('click', fn);
				bar.appendChild(b);
				return b;
			};

			if (trying) {
				add('Put it back now', 'btn-outline-secondary', () => {
					stopClocks();
					trying = false;
					note = '';
					post('undo').then(() => { if (!dead) refresh(); });
				});
				add('Keep it', 'btn-primary', () => {
					const list = wholeList();
					stopClocks();
					trying = false;
					post('keep', list).then((r) => {
						if (dead) return;
						note = r && r.kept ? 'Saved. These pins come back this way after a reboot.'
							: 'Not saved: ' + ((r && r.error) || 'the camera refused');
						if (r && r.kept) pending = {};
						refresh();
					});
				});
				return;
			}

			add('Undo', 'btn-outline-secondary', () => {
				pending = {};
				note = '';
				paint();
			}, n === 0);
			// Nothing to try when the change is "nothing is soldered to
			// anything": there is no pad to hold open and nothing to watch
			// happen. Keeping it is still the way to record that.
			add('Try it', 'btn-outline-secondary', () => {
				note = '';
				post('try', wholeList()).then((r) => {
					if (dead) return;
					if (!r || !r.done) {
						note = 'Not tried: ' + ((r && r.error) || 'the camera refused');
						paintBar();
						return;
					}
					startClocks(r.seconds, r.beat);
				});
			}, n === 0 || wholeList().length === 0);
			add('Keep it', 'btn-primary', () => {
				post('keep', wholeList()).then((r) => {
					if (dead) return;
					note = r && r.kept ? 'Saved. These pins come back this way after a reboot.'
						: 'Not saved: ' + ((r && r.error) || 'the camera refused');
					if (r && r.kept) pending = {};
					refresh();
				});
			}, n === 0);
		}

		// ── the whole page ────────────────────────────────────────────────────

		function paint() {
			root.textContent = '';
			if (!doc) {
				root.appendChild(el('p', 'mj-pins-empty', 'Reading the chip…'));
				return;
			}
			if (!doc.have) {
				// Said plainly rather than drawn as an empty chip. Every vendor
				// but HiSilicon, and a HiSilicon part whose id is not known.
				root.appendChild(el('p', 'mj-pins-empty',
					'This camera cannot say what its pins can do, so there is nothing ' +
					'to draw. The Day / Night page can still find the IR-cut wiring.'));
				return;
			}

			// Two sentences in one grid cell: the resting one, always present
			// and hidden, and the live one on top of it. The box is therefore
			// as tall as the taller of the two AT THIS WIDTH and never changes
			// height as the pointer moves down the list.
			//
			// Setting the text of a single paragraph looked right and was not:
			// the resting sentence wraps to two lines where a lit one fits on
			// one, so every row the pointer crossed moved the chip — and the
			// chip is the thing being pointed at.
			const introBox = el('div', 'mj-pins-intro');
			introBox.appendChild(el('p', 'mj-pins-intro-rest', restingText()));
			introEl = el('p', 'mj-pins-intro-live', introText());
			introBox.appendChild(introEl);
			root.appendChild(introBox);

			const survived = doc.lastTry && doc.lastTry.started && doc.lastTry.survived === false;
			if (survived) {
				const warn = el('p', 'mj-pins-warn',
					'The camera restarted while a change was being tried, so the change ' +
					'was never kept. Whatever was on those pins took it down.');
				const b = el('button', 'btn btn-sm btn-outline-secondary', 'Dismiss');
				b.type = 'button';
				b.addEventListener('click', () =>
					post('forget').then(() => { if (!dead) refresh(); }));
				warn.appendChild(b);
				root.appendChild(warn);
			}

			const panes = el('div', 'mj-pins-panes');
			panes.appendChild(kindsPane());
			const mid = el('div', 'mj-pins-chip');
			chipPane = mid;
			mid.appendChild(chip());
			if (ro) { ro.disconnect(); ro.observe(mid); }
			const cap = el('p', 'mj-pins-cap',
				'Where each pin sits on this drawing is not the chip’s footprint — ' +
				'the numbers and what each one can be are the camera’s own.');
			mid.appendChild(cap);
			panes.appendChild(mid);
			panes.appendChild(detailPane());
			root.appendChild(panes);

			bar = el('div', 'mj-pins-bar');
			root.appendChild(bar);
			paintBar();
			// After the panes are in the document, so the column has a width.
			fit();
			// A repaint rebuilds every row and every lead, so whatever was lit
			// has to be put back or choosing a pin would drop the highlight
			// that led you to it. The level marks go back on for the same
			// reason and in the same breath.
			applyLit();
			applyLevels();
		}

		// The column changes width without the window doing so — the rail
		// collapses, a scrollbar appears — so this watches the element rather
		// than listening for a resize.
		let ro = null;
		if (typeof ResizeObserver === 'function') {
			ro = new ResizeObserver(() => fit());
		} else {
			window.addEventListener('resize', fit);
		}

		const onKey = (e) => {
			if (e.key !== 'Escape' || !litNow()) return;
			litPinned = null;
			litPointer = null;
			litFocus = null;
			applyLit();
		};
		document.addEventListener('keydown', onKey);

		paint();
		refresh();

		return {
			destroy: () => {
				dead = true;
				document.removeEventListener('keydown', onKey);
				stopClocks();
				wsShut();
				if (ro) ro.disconnect();
				else window.removeEventListener('resize', fit);
				// A window left open is one nothing is watching. Put the pads
				// back rather than leave the camera holding a change whose page
				// has gone. Sent unconditionally: a try still in flight would
				// not have set `trying` yet, and its reply lands on a page that
				// is already gone.
				post('undo');
			},
			refresh: refresh,
		};
	}

	const api = { mount: mount, sides: sides, pitchFor: pitchFor, USES: USES,
		offerLabel: offerLabel, offerHint: offerHint, padsFor: padsFor,
		wiresFor: wiresFor, busColour: busColour, padWire: padWire,
		WIRE_GUTTER: WIRE_GUTTER, RING_CLEAR: RING_CLEAR,
		RESTING: RESTING, litSentence: litSentence,
		LEVELS: LEVELS, levelsFor: levelsFor, normLevel: normLevel,
		sameChoice: sameChoice, mergePins: mergePins, changedPins: changedPins,
		drivesSentence: drivesSentence, levelSentence: levelSentence,
		levelAttrs: levelAttrs, LEVEL_RESTING: LEVEL_RESTING };
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticPins = api;
})();
