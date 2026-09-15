// Finding out what a pad is wired to, by holding it.
//
// The IR-cut sweep next door drives pairs and reads the answer off the
// picture, which finds a filter and can never find anything else. This one
// holds a single pad and asks the CAMERA what turned up, which is how a
// wireless module or a card slot or a second PHY gets found — none of them
// change anything a lens can see.
//
// The properties worth pinning are the ones whose failure is silent. A sweep
// that stopped excluding a pad still runs to the end and reports something; a
// sweep that carried on past a find still reports a find, just the wrong one;
// a sweep that swallowed a refusal still finishes. None of them look broken.
'use strict';

const path = require('path');
const { check, group, done } = require('./assert');

// check() takes a truth, not a pair, so equality is spelled out and the actual
// value rides along as the detail — a bare "FAIL" tells you nothing.
const eq = (name, got, want) =>
	check(name, got === want, 'got ' + JSON.stringify(got));

const sweep = require(path.join(__dirname, '..', 'www', 'a', 'pin-sweep.js'));

const banks = (n) => {
	const b = { banks: [], assigned: [], held: [] };
	for (let i = 0; i < n; i++) b.banks.push({ base: i * 8, n: 8 });
	return b;
};
const B10 = banks(10);

// A board with something soldered to one pad. `wired` says which pad, at which
// level, brings what — everything else is a pad with nothing on it.
function camera(wired, opts) {
	opts = opts || {};
	const log = [];
	let on = false;
	return {
		log: log,
		stopped: () => false,
		hold(pin, level) {
			log.push(pin + ':' + level);
			if (opts.refuse && opts.refuse[pin])
				return Promise.resolve({ error: opts.refuse[pin] });
			if (opts.lose && opts.lose[pin]) return Promise.reject(new Error('gone'));
			if (pin !== wired.pin || level !== wired.level)
				return Promise.resolve({ done: true, found: [] });
			// Held once, it stays on: that is what "switched on" means, and it
			// is the reason the sweep has to stop at the first find.
			const first = !on;
			on = true;
			return Promise.resolve({
				done: true, found: first ? wired.found : [],
			});
		},
	};
}

group('pin sweep: which pads may be held');

{
	// Everything the pair sweep leaves alone, this leaves alone too — and the
	// one thing it does not: an IR-cut coil is the single assigned pad a pair
	// sweep may drive, because finding the filter is what it is FOR. Holding
	// that same pad for a second leaves the bridge passing current through a
	// winding sized for a tenth of one, so here it is skipped like any other
	// assignment.
	const info = Object.assign({}, B10, {
		assigned: [
			{ pin: 30, role: 'irCutPin1' },
			{ pin: 31, role: 'irCutPin2' },
			{ pin: 12, role: 'backlightPin' },
		],
	});
	const list = sweep.pads(info);
	eq('an ir-cut coil is not a pad to hold', list.indexOf(30), -1);
	eq('and neither is the other one', list.indexOf(31), -1);
	eq('nor the illuminator', list.indexOf(12), -1);
	check('a free pad is', list.indexOf(41) >= 0);
}

{
	const info = Object.assign({}, B10, {
		avoid: [{ pin: 13, why: 'down' }, { pin: 45, why: 'asked' }],
		held: [{ pin: 22, owner: 'ir-led' }, { pin: 23, owner: 'sysfs' }],
	});
	const list = sweep.pads(info);
	eq('a pin the camera went down on is not held', list.indexOf(13), -1);
	eq('nor one the owner ruled out', list.indexOf(45), -1);
	eq('nor a line a driver holds', list.indexOf(22), -1);
	// An export is majestic's own, and refusing those would lock the hunt out
	// of pads it is the only thing that touches.
	check('a sysfs export is still a candidate', list.indexOf(23) >= 0);
}

{
	// The chip answering for itself, which is what stands in for a
	// hand-maintained list of pins never to touch. It is the only guard that
	// can save the serial console: the kernel does not claim a UART pad as a
	// GPIO, so nothing else here can see it.
	const info = Object.assign({}, B10, { padNow: { 1: 'a serial port', 2: 'a serial port' } });
	const list = sweep.pads(info);
	eq('a pad carrying a serial port is left alone', list.indexOf(1), -1);
	eq('and so is the other half of it', list.indexOf(2), -1);
	check('pad 0 beside them is not', list.indexOf(0) >= 0);
}

{
	const list = sweep.pads(B10, { only: { from: 40, to: 47 } });
	eq('a range narrows the pads', list.length, 8);
	eq('to exactly that range', list[0] + '-' + list[7], '40-47');
	eq('an empty range yields nothing, not everything',
		sweep.pads(B10, { only: { from: 900, to: 999 } }).length, 0);
}

group('pin sweep: the order it tries them');

{
	const steps = sweep.steps([4, 5, 6], ['high', 'low']);
	eq('every pad at one level before the next', steps.length, 6);
	eq('high first', steps.slice(0, 3).map((s) => s.join(':')).join(','),
		'4:high,5:high,6:high');
	eq('then low', steps.slice(3).map((s) => s.join(':')).join(','),
		'4:low,5:low,6:low');
}

{
	const all = sweep.steps([4, 5, 6]);
	const left = sweep.remaining(all, ['4:high', '5:high']);
	eq('what is done is not tried again', left.length, 4);
	eq('and the rest keep their order',
		left.map((s) => s.join(':')).join(','), '6:high,4:low,5:low,6:low');
}

group('pin sweep: the run');

const WLAN = [
	{ kind: 'usb', id: '1-1', words: '802.11n WLAN Adapter' },
	{ kind: 'network', id: 'wlan0', words: 'a wireless adapter' },
];
const GONE = [
	{ kind: 'network', id: 'eth0', words: 'a network adapter', gone: true },
];

sweep.run(camera({ pin: 6, level: 'high', found: WLAN }),
	sweep.steps([4, 5, 6, 7], ['high']))
	.then((out) => {
		eq('the pad that switched something on is the find', out.hit.pin, 6);
		eq('at the level it was held', out.hit.level, 'high');
		// The whole reason this is not the picture: nobody looked.
		eq('and the camera said what it was', out.hit.found[0].words,
			'802.11n WLAN Adapter');
		// Stopping at the first find is not tidiness. The module is still on
		// when the next pad is held, so pad 7 would report it leaving, or
		// report nothing, and the true answer would be buried either way.
		eq('the sweep stops there', out.tried.join(','), '4:high,5:high,6:high');
	})

	.then(() => sweep.run(camera({ pin: 99, level: 'high', found: WLAN }),
		sweep.steps([4, 5], ['high', 'low'])))
	.then((out) => {
		eq('a board with nothing on it reports no find', out.hit, null);
		eq('having tried both levels of every pad', out.tried.length, 4);
	})

	.then(() => sweep.run(
		camera({ pin: 7, level: 'high', found: WLAN },
			{ refuse: { 5: 'pad 5 is carrying a serial port right now' } }),
		sweep.steps([4, 5, 6, 7], ['high'])))
	.then((out) => {
		// One console pad must not end the run. The camera names what it will
		// not drive and why, and the sweep carries on past it.
		eq('a refused pad is recorded', out.refused.length, 1);
		eq('with the camera\'s own sentence', out.refused[0].why,
			'pad 5 is carrying a serial port right now');
		eq('it is not counted as tried', out.tried.indexOf('5:high'), -1);
		eq('and the sweep goes on to find the pad', out.hit.pin, 7);
	})

	.then(() => sweep.run(
		camera({ pin: 9, level: 'high', found: WLAN }, { lose: { 6: 1 } }),
		sweep.steps([4, 5, 6, 7], ['high'])))
	.then((out) => {
		// The reported case: the pads around 45 on his board took ethernet
		// down without troubling the camera at all. The request never comes
		// back, and the pad that was in flight is the one thing the camera
		// cannot report about itself.
		eq('a pad that cut the connection is named', out.lost.pin, 6);
		eq('and the sweep ends there', out.hit, null);
	})

	.then(() => sweep.run(camera({ pin: 45, level: 'low', found: GONE }),
		sweep.steps([45], ['low'])))
	.then((out) => {
		// What LEAVES is a find too, and reads as one.
		eq('a pad that takes something away is a hit', out.hit.pin, 45);
		eq('and says so', sweep.sentence(out.hit),
			'Pin 45, held low, took away a network adapter (eth0).');
	})

	.then(() => {
		group('pin sweep: saying what was found');
		eq('the thing names itself where it can',
			sweep.sentence({ pin: 6, level: 'high', found: WLAN }),
			'Pin 6, held high, switched on 802.11n WLAN Adapter (1-1) and a '
				+ 'wireless adapter (wlan0).');
		eq('one thing needs no list',
			sweep.sentence({ pin: 6, level: 'low', found: [WLAN[1]] }),
			'Pin 6, held low, switched on a wireless adapter (wlan0).');
		eq('nothing found says nothing',
			sweep.sentence({ pin: 6, level: 'high', found: [] }), '');
		done();
	});
