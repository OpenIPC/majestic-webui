// What the page claims about a destination nobody can see.
//
// Every branch here fails silently. A destination losing half its packets
// draws exactly like one that is fine; an absent loss figure painted as 0%
// is a green claim nobody made; a state this build does not recognise,
// guessed at, is a confident sentence about something the camera said and we
// could not read. None of it is reproducible without a camera whose receiver
// you can disconnect on demand, which is what earns this file its place.
//
// The wording is tested as much as the logic, because the wording IS the
// feature: the difference between "the connection cannot carry this" and
// "the camera is failing" is the difference between somebody checking their
// uplink and somebody returning the camera.

const path = require('path');
const { check, group, done } = require('./assert.js');

const O = require(path.join(__dirname, '..', 'www', 'a', 'mj-outgoing.js'));
const S = require(path.join(__dirname, '..', 'www', 'a', 'mj-servers.js'));

const one = (o) => O.read({ destinations: [Object.assign({ index: 0 }, o)] });
const st = (o) => one(o).byIndex[0];
const vd = (o, ctx) => O.verdict(st(o), ctx || {});

group('reading an answer nobody has checked');

check('a non-object is nothing', O.read(null) === null && O.read(7) === null);
check('so is a reply with no destinations array',
	O.read({}) === null && O.read({ destinations: 'nope' }) === null);
// Not the same as "we could not ask". A camera that publishes nowhere has
// told us something true.
check('an empty list is a fact, not an unknown',
	O.read({ destinations: [] }).known === true &&
	O.read({ destinations: [] }).count === 0);
check('an entry with no index is dropped',
	O.read({ destinations: [{ state: 'live' }] }).count === 0);
check('a duplicate index keeps the first',
	O.read({ destinations: [{ index: 1, state: 'live' }, { index: 1, state: 'off' }] })
		.byIndex[1].state === 'live');
check('a state this build does not know is dropped, not kept',
	st({ state: 'wobbly' }).state === undefined);
check('and then nothing is claimed about it',
	vd({ state: 'wobbly' }).short === '' && vd({ state: 'wobbly' }).sev === 'unknown');

// A string is not a number, and Number() on it would invent one.
check('a stringified count is dropped', st({ txBytes: '918273645' }).txBytes === undefined);
check('a negative count is dropped', st({ txBytes: -1 }).txBytes === undefined);
check('a measured zero is kept',
	st({ txBytes: 0 }).txBytes === 0 && st({ lossPermille: 0 }).lossPermille === 0);
check('a false verdict is kept', st({ bandwidthLimited: false }).bandwidthLimited === false);
check('a non-boolean verdict is dropped',
	st({ bandwidthLimited: 'yes' }).bandwidthLimited === undefined);

group('the camera speaks, the page does not interpret');

const nasty = '<img src=x onerror=alert(1)>"\\';
check('a reason survives verbatim',
	vd({ state: 'failed', lastError: nasty }).reason === nasty);
check('and nothing the module composes contains a tag',
	['badge', 'short', 'reasonLead'].every(k =>
		vd({ state: 'failed', lastError: nasty })[k].indexOf('<') < 0));
check('a very long reason is cut',
	vd({ state: 'failed', lastError: 'x'.repeat(4096) }).reason.length
		=== O.ERR_MAX + 1);

group('what a live destination is told');

check('a healthy one is not warned about',
	vd({ state: 'live', sinceMs: 7871000 }).sev === 'ok');
check('and says how long it has been up',
	/2 h 11 min/.test(vd({ state: 'live', sinceMs: 7871000 }).short));

// The sentence has to blame the connection, not the camera — this is the
// difference between checking an uplink and returning a camera.
const lim = vd({ state: 'live', bandwidthLimited: true, peerEstimateKbps: 3400 });
check('a limited link warns', lim.sev === 'warn');
check('and says the connection cannot carry it', /cannot carry/.test(lim.short));
check('and blames the network, not the camera',
	/not the camera itself/.test(lim.detail.join(' ')));

// A false must never read as a true.
const notlim = vd({ state: 'live', bandwidthLimited: false });
check('an unconstrained link is not warned about', notlim.sev === 'ok');
check('and nothing says it cannot carry the stream',
	(notlim.short + notlim.detail.join(' ')).indexOf('cannot carry') < 0);

// And an absent verdict must claim nothing in either direction.
const unk = vd({ state: 'live' });
check('an unmeasured link claims neither',
	(unk.short + unk.detail.join(' ')).indexOf('cannot carry') < 0 &&
	(unk.short + unk.detail.join(' ')).indexOf('keeping up') < 0);
check('but says so among the limits',
	/does not tell the camera/.test(unk.limits.join(' ')));

check('measured zero loss is not a warning',
	vd({ state: 'live', lossPermille: 0 }).sev === 'ok');
check('and noticeable loss is', vd({ state: 'live', lossPermille: 25 }).sev === 'warn');
check('with the figure in it', /2\.5%/.test(vd({ state: 'live', lossPermille: 25 }).short));

check('a flapping destination is warned about',
	vd({ state: 'live', sinceMs: 240000, reconnects: 6 }).sev === 'warn');
check('and the count is named',
	/6 reconnections/.test(vd({ state: 'live', sinceMs: 240000, reconnects: 6 }).short));

group('what a destination that is not up is told');

const retry = vd({ state: 'retrying', retryInMs: 5000, attempts: 14 }, { ageMs: 0 });
check('a retry counts down', /in 5 s/.test(retry.short));
check('and names the attempts', /14 attempts/.test(retry.short));
// The countdown ticks between polls, and must never go negative — "trying
// again in -4 s" reads as broken.
check('the countdown ages with the sample',
	/in 2 s/.test(vd({ state: 'retrying', retryInMs: 5000 }, { ageMs: 3000 }).short));
check('and never runs past zero',
	!/-/.test(vd({ state: 'retrying', retryInMs: 5000 }, { ageMs: 9000 }).short));

check('a failure with no reason claims none',
	vd({ state: 'failed' }).reason === '' &&
	vd({ state: 'failed' }).reasonLead === '');
check('a slow connect is warned about',
	vd({ state: 'connecting', sinceMs: 40000 }).sev === 'warn');
check('a fresh one is not', vd({ state: 'connecting', sinceMs: 1000 }).sev === 'info');

check('a row switched off here says nothing',
	vd({ state: 'off' }, { rowEnabled: false }).short === '');
check('but one switched on and not running does',
	/not publishing/.test(vd({ state: 'off' }, { rowEnabled: true }).short));

check('no answer at all is not a clean bill of health',
	O.verdict(null, {}).known === false && O.verdict(null, {}).short === '');

group('what a destination cannot report');

check('a local socket is not asked about the network',
	/socket on the camera itself/.test(vd({ state: 'live', protocol: 'unix' }).limits.join(' ')));
check('and is not told the camera does not report loss',
	!/does not report how much/.test(
		vd({ state: 'live', protocol: 'unix' }).limits.join(' ')));
check('an rtp destination with no report says nobody has reported',
	/Nothing has reported back/.test(
		vd({ state: 'live', protocol: 'rtp' }).limits.join(' ')));
// What a protocol cannot measure is only worth saying about a destination
// that is carrying something. A row nobody is publishing to has an empty
// panel, and the button that would open it hides itself.
check('a destination that is not running is told none of it',
	vd({ state: 'off', protocol: 'rtp' }).limits.length === 0 &&
	vd({ state: 'connecting', protocol: 'rtp' }).limits.length === 0 &&
	vd({ state: 'failed', protocol: 'unix' }).limits.length === 0);

group('the vocabulary a person reads');

// Nothing here may name a setting, a scheme, or an internal. The page has its
// own words for all of it, and a sentence that leaks one is a sentence
// nobody outside this codebase can act on.
const BANNED = /\b(outgoing|servers|naluSize|substream|permille|whip|rtmp|rtmps|udp|unix|json|api)\b/i;
const DOTTED = /[a-z]+\.[a-zA-Z]+/;
let leaked = [];
let unpunctuated = [];
[
	{ state: 'live' }, { state: 'live', bandwidthLimited: true, peerEstimateKbps: 900 },
	{ state: 'live', lossPermille: 250 }, { state: 'live', reconnects: 9, sinceMs: 1000 },
	{ state: 'live', keyframeRequests: 4 },
	{ state: 'connecting' }, { state: 'connecting', sinceMs: 90000 },
	{ state: 'retrying', retryInMs: 1000, attempts: 3 },
	{ state: 'failed' }, { state: 'off' },
	{ state: 'live', protocol: 'unix' }, { state: 'live', protocol: 'rtp' },
	{ state: 'live', protocol: 'whip' },
].forEach((o) => {
	[true, false].forEach((on) => {
		const v = vd(o, { rowEnabled: on });
		const all = [v.badge, v.short, v.reasonLead]
			.concat(v.detail).concat(v.limits);
		all.forEach((s) => {
			if (BANNED.test(s) || DOTTED.test(s)) leaked.push(s);
		});
		if (v.short !== '' && !/^[A-Z]/.test(v.short)) unpunctuated.push(v.short);
		if (v.short !== '' && !/[.…]$/.test(v.short)) unpunctuated.push(v.short);
	});
});
check('no sentence names a setting or an internal', leaked.length === 0,
	'leaked: ' + leaked.join(' | '));
check('and every one is placed as a sentence', unpunctuated.length === 0,
	'not sentences: ' + unpunctuated.join(' | '));

group('the two modules agree about a scheme');

// The page corroborates a row's address against the protocol the camera
// reports. If these tables drift, that check starts rejecting good joins and
// the rows go quiet for a reason nobody can see.
[
	['rtmp', 'rtmp://a.example/live/k'],
	['rtmps', 'rtmps://a.example/live/k'],
	['rtp', 'udp://192.0.2.10:5600'],
	['unix', 'unix:/tmp/s.sock'],
	['whip', 'https://m.example/cam/whip'],
].forEach(([word, url]) => {
	check('the camera\'s "' + word + '" is the badge the address gets',
		O.PROTO_NAME[word] === S.protocolOf(url));
});
check('and every protocol the camera can name has a badge',
	O.PROTOCOLS.every(p => typeof O.PROTO_NAME[p] === 'string'));
check('a disagreement is refused',
	O.agrees(st({ protocol: 'whip' }), 'RTMP') === false);
check('but an unknown on either side is not',
	O.agrees(st({}), 'RTMP') === true && O.agrees(null, 'RTMP') === true);

group('rates and readings');

check('a rate needs two counts and a gap', O.rate(0, 1000, 1000) === 8000);
check('a counter that went backwards is unknown, not zero',
	O.rate(2000, 1000, 1000) === null);
check('so is a zero interval', O.rate(0, 1000, 0) === null);
check('and an absent count', O.rate(undefined, 1000, 1000) === null);
check('an unchanged counter is a real zero', O.rate(1000, 1000, 1000) === 0);

check('durations read the way people say them',
	O.since(12000) === '12 s' && O.since(240000) === '4 min' &&
	O.since(7871000) === '2 h 11 min' && O.since(259200000) === '3 days');
check('an absent duration is empty', O.since(undefined) === '');

check('facts list only what was measured',
	O.facts(st({ txBytes: 1000 }), null).length === 1);
check('and nothing at all for no answer', O.facts(null, null).length === 0);

done();
