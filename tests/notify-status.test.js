'use strict';

// The sentence at the top of the notification pages.
//
// It earns a test for the reason everything in tests/ does: it fails silently.
// Every branch produces a fluent, confident line — "Ready — a 10-second video
// when something moves" reads exactly as well when the detector is off and the
// camera will send nothing, and the page has no other way to be wrong out loud.
// The old pages had no such line at all, which is how "Send motion clips" came
// to sit there switched on, on cameras where nothing was watching, for as long
// as it did.
//
// What cannot be reproduced on demand is the third answer. `mjConfig()` resolves
// `{}` when the camera does not answer, so "we could not ask" and "motion
// detection is off" arrive at this function as almost the same thing, and only
// one of them may accuse the camera. Reproducing that by hand needs a camera
// mid-restart at the moment somebody opens the page.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

// The module is an IIFE that exports onto `window` and then reaches for the
// page's boot tag. With no such element it returns, leaving the pure half
// exported — which is exactly the half under test.
const src = fs.readFileSync(path.join(__dirname, '..', 'www', 'a', 'notify.js'), 'utf8');
const win = {};
const sandbox = {
	window: win,
	document: { getElementById: () => null, readyState: 'complete', addEventListener: () => {} },
	setTimeout: () => {},
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const verdict = win.NotifyStatus && win.NotifyStatus.verdict;

const base = {
	serviceName: 'Telegram',
	senderInstalled: true,
	enabled: true,
	addressed: true,
	missing: 'it needs a bot and a chat',
	payload: 'video',
	seconds: '10',
	interval: '15',
	triggers: { motion: true, schedule: false },
	camera: { known: false },
};

const ask = (over) => verdict(Object.assign({}, base, over));

group('it exports the part worth testing');
{
	check('verdict() is reachable without a page', typeof verdict === 'function');
}

group('what it will send');
{
	check('a video says how long', ask({}).what === '10-second video', ask({}).what);
	check('a picture is just a picture',
		ask({ payload: 'picture' }).what === 'Picture', ask({ payload: 'picture' }).what);
	check('the length follows the setting',
		ask({ seconds: '30' }).what === '30-second video', ask({ seconds: '30' }).what);
}

group('when it will send');
{
	// The two links are live whenever the service is on and addressed, so this
	// clause is always true and the page must not claim otherwise.
	const none = ask({ triggers: { motion: false, schedule: false } });
	check('with every switch off it still answers a request',
		none.when === 'when something asks', none.when);
	check('and that is not a failure', none.level === 'ok', none.level);

	check('movement alone',
		ask({}).when === 'when something moves and when something asks', ask({}).when);

	const both = ask({ triggers: { motion: true, schedule: true } });
	check('movement and a timer read as a list',
		both.when === 'when something moves, every 15 minutes and when something asks',
		both.when);

	check('an hour is an hour, not sixty minutes',
		ask({ triggers: { motion: false, schedule: true }, interval: '60' }).when ===
			'every hour and when something asks');
	check('and six hours is six hours',
		ask({ triggers: { motion: false, schedule: true }, interval: '360' }).when ===
			'every six hours and when something asks');
}

group('the states that are not "ready"');
{
	const gone = ask({ senderInstalled: false });
	check('no sender installed is named as such',
		gone.level === 'bad' && /cannot send to Telegram/.test(gone.head), gone.head);
	check('and it promises nothing', gone.what === '—', gone.what);

	const off = ask({ enabled: false });
	check('switched off says so', off.level === 'off' && off.head === 'Switched off', off.head);
	check('and says nothing will be sent', off.when === 'nothing will be sent', off.when);

	const blank = ask({ addressed: false });
	check('unaddressed is not the same as off',
		blank.level === 'off' && blank.head === 'Not set up yet', blank.head);
	check('and it names what is missing',
		blank.when === 'it needs a bot and a chat', blank.when);
}

group('a switch the camera cannot act on');
{
	const blocked = ask({ camera: { known: true, motionDetect: false } });
	check('is not counted among the reasons it will send',
		blocked.when === 'when something asks', blocked.when);
	check('drops the verdict to partly ready',
		blocked.level === 'warn' && blocked.head === 'Partly ready', blocked.head);
	check('and says why, in words about the camera',
		/not watching for movement/.test(blocked.why.motion || ''), blocked.why.motion);

	const fine = ask({ camera: { known: true, motionDetect: true } });
	check('a detector that IS on raises nothing',
		fine.level === 'ok' && !fine.why.motion, JSON.stringify(fine.why));

	// The switch is off, so the detector is nobody's business.
	const quiet = ask({
		triggers: { motion: false, schedule: true },
		camera: { known: true, motionDetect: false },
	});
	check('and neither does a detector nobody asked for',
		quiet.level === 'ok' && !quiet.why.motion, JSON.stringify(quiet.why));
}

group('a camera that has not answered is not a camera reporting off');
{
	// mjConfig() resolves {} on failure. If that read as "motion detection is
	// off", every page on a camera mid-restart would accuse it of a
	// misconfiguration it does not have.
	const unknown = ask({ camera: { known: false } });
	check('no accusation while nothing is known', !unknown.why.motion, unknown.why.motion);
	check('and movement is still counted',
		unknown.when === 'when something moves and when something asks', unknown.when);
	check('the verdict stays ready', unknown.level === 'ok', unknown.level);

	// The shape mjConfig() actually returns on a failure, one level up.
	const empty = ask({ camera: { known: true, motionDetect: undefined } });
	check('and an answer with the key missing accuses nobody either',
		!empty.why.motion, empty.why.motion);
}

done();
