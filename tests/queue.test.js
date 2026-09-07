// The live-write queue (www/a/mj-queue.js).
//
// Every failure here is silent. A queue that grows leaves the camera drawing a
// position nobody asked for while the page shows the one they did — the mask
// sitting apart from its own outline that #340 reports — and on a camera that
// answers quickly it never happens at all, so it cannot be reproduced on
// demand. A statement dropped for another that only looked like it is worse
// and quieter still: the page leaves, the undo is swallowed by the drag it was
// meant to undo, and the overlay stays where it was dragged with every control
// reading its saved value.
//
// Held here as plain promises, with a sender the test resolves by hand, so
// "one in flight" and "the last thing said always lands" are statements about
// the code rather than about how fast a camera happened to answer.
'use strict';

const path = require('path');
const { check, group, done } = require('./assert');

const Q = require(path.join(__dirname, '..', 'www', 'a', 'mj-queue.js'));

// A sender the test drives: it records what it was asked to send and hands
// back a promise the test resolves when it chooses.
function recorder() {
	const sent = [];
	const gates = [];
	const send = (payload) => {
		sent.push(payload);
		return new Promise((res) => { gates.push(res); });
	};
	return {
		sent: sent,
		send: send,
		// Let the request that is in flight finish.
		land: (v) => { const g = gates.shift(); if (g) g(v); },
		inFlight: () => gates.length,
	};
}

const tick = () => new Promise((res) => setTimeout(res, 0));

group('what makes two writes the same statement');
check('the same keys, different values',
	Q.docSig({ osd: { anchor: 'top-left' } }) ===
	Q.docSig({ osd: { anchor: 'bottom-right' } }));
check('key order does not make a difference',
	Q.docSig({ osd: { anchor: 'a', offsetX: '1' } }) ===
	Q.docSig({ osd: { offsetX: '2', anchor: 'b' } }));
check('another key does',
	Q.docSig({ osd: { anchor: 'a' } }) !==
	Q.docSig({ osd: { anchor: 'a', privacyMasks: '' } }));
check('a different overlay is a different statement',
	Q.docSig({ osd: { overlays: { 1: { anchor: 'a' } } } }) !==
	Q.docSig({ osd: { overlays: { 2: { anchor: 'a' } } } }));
// A privacy mask list is one statement whether it holds one rectangle or six:
// a drag that grows the list must still replace the push before it.
check('a list is a leaf, whatever its length',
	Q.docSig({ osd: { privacyMasks: ['1x1x1x1'] } }) ===
	Q.docSig({ osd: { privacyMasks: ['1x1x1x1', '2x2x2x2'] } }));
check('a query names its parameters, not its values',
	Q.querySig('anchor=top-left&offsetX=4%') ===
	Q.querySig('offsetX=9%&anchor=bottom'));
check('and a query with another parameter is another statement',
	Q.querySig('anchor=a') !== Q.querySig('anchor=a&posX=3'));

(async function () {
	group('one request in flight, and one waiting');
	{
		const r = recorder();
		const post = Q.coalesce(r.send, Q.docSig);
		const first = post({ osd: { anchor: 'a' } });
		await tick();
		check('the first goes straight out', r.sent.length === 1);

		// A drag: ten more moves while the first is still in flight.
		let last = null;
		for (let i = 0; i < 10; i++)
			last = post({ osd: { anchor: 'p' + i } });
		await tick();
		check('nothing else goes out while one is in flight',
			r.sent.length === 1, 'sent ' + r.sent.length);

		r.land(200);
		await first;
		await tick();
		check('when the flight lands, exactly one more goes out',
			r.sent.length === 2, 'sent ' + r.sent.length);
		check('and it is the LAST thing said, not the next in line',
			r.sent[1].osd.anchor === 'p9', 'sent ' + r.sent[1].osd.anchor);

		r.land(200);
		await last;
		await tick();
		// Eleven moves, two requests — and the camera is at the position the
		// pointer stopped on rather than working through nine it has left.
		check('nothing follows it', r.sent.length === 2,
			'sent ' + r.sent.length);
		check('and nothing is left in flight', r.inFlight() === 0);
	}

	group('a different statement is not swallowed');
	{
		const r = recorder();
		const post = Q.coalesce(r.send, Q.docSig);
		post({ osd: { anchor: 'a' } });                      // in flight
		await tick();
		post({ osd: { anchor: 'b' } });                      // waiting
		// The undo. It names other keys, so it must take its own place rather
		// than replace the drag's last position.
		const undo = post({ osd: { anchor: '', privacyMasks: '' } });
		await tick();
		check('the drag is still only one request in', r.sent.length === 1);

		r.land(200); await tick();
		check('the last position of the drag goes second',
			r.sent.length === 2 && r.sent[1].osd.anchor === 'b');
		r.land(200); await tick();
		check('and the undo goes after it, not instead of it',
			r.sent.length === 3 && r.sent[2].osd.privacyMasks === '');
		r.land(200);
		await undo;
	}

	group('order holds for two writes that say the same thing');
	{
		// Hold-to-compare: the defaults on press, the live values on release.
		// Whatever else coalesces, these two must land in that order or the
		// camera is left at stock — the state the control exists to undo.
		const r = recorder();
		const post = Q.coalesce(r.send, Q.querySig);
		post('luminance=50&contrast=50');
		await tick();
		const up = post('luminance=83&contrast=50');
		await tick();
		check('the press is out and the release is waiting', r.sent.length === 1);
		r.land(true); await tick();
		check('the release follows it', r.sent.length === 2 &&
			/luminance=83/.test(r.sent[1]));
		r.land(true);
		await up;
	}

	group('a caller is told what happened');
	{
		const r = recorder();
		const post = Q.coalesce(r.send, Q.docSig);
		const a = post({ osd: { anchor: 'a' } });
		r.land(404);
		// 404 is the one status the settings page acts on: it means the
		// endpoint is not there and the older query form has to be used from
		// then on. Anything else is this camera refusing this request, and a
		// queue that reported failure as a plain "no" could not tell them
		// apart.
		check('the answer is the status the camera gave', (await a) === 404);

		// A push that was replaced resolves with the answer to the one that
		// replaced it: what the caller wanted to know is whether the thing it
		// asked for is in force, and the later push says the same about the
		// same keys.
		const b = post({ osd: { anchor: 'b' } });     // in flight
		await tick();
		const c = post({ osd: { anchor: 'c' } });     // waiting
		const d = post({ osd: { anchor: 'd' } });     // replaces it
		await tick();
		check('a replaced push shares the promise of the one that replaced it',
			c === d);
		r.land(200);
		check('the one in flight keeps its own answer', (await b) === 200);
		await tick();
		check('and of the two waiting only the replacement was sent',
			r.sent.length === 3 && r.sent[2].osd.anchor === 'd',
			'sent ' + r.sent.length);
		r.land(500);
		check('which is what both of them are told', (await c) === 500);
	}

	group('a failure does not wedge the ones after it');
	{
		const r = recorder();
		const post = Q.coalesce(r.send, Q.docSig);
		const a = post({ osd: { anchor: 'a' } });
		r.land(0);                       // no answer at all
		await a;
		await tick();
		const b = post({ osd: { anchor: 'b' } });
		await tick();
		check('the next write still goes out', r.sent.length === 2);
		r.land(200);
		check('and lands', (await b) === 200);
	}

	done();
})();
