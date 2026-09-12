// What a publishing destination is, as mj-servers.js reads one.
//
// The subject is a list the camera acts on and nobody could see until the
// schema described it, and every branch here decides something that is silent
// when it is wrong: a token drawn on a row that cannot use it is a setting
// somebody fills in and the camera ignores; a canonical form that misses an
// edit inside a row means Save stays greyed out with the change still on
// screen; a normalise that keeps an address-less row writes a destination into
// majestic.yaml that the camera skips on load.
//
// None of it is reproducible by looking at the page, which is why it is a
// module rather than a handful of lines inside the row-drawing code.
'use strict';

const path = require('path');
const { check, group, done } = require('./assert');

const S = require(path.join(__dirname, '..', 'www', 'a', 'mj-servers.js'));

group('the protocol is read off the address');

check('rtmp is RTMP', S.protocolOf('rtmp://a.example/live/key') === 'RTMP');
check('rtmps is named separately', S.protocolOf('rtmps://a.example/l/k') === 'RTMPS');
check('udp is RTP', S.protocolOf('udp://192.168.1.10:5600') === 'RTP');
check('unix is the socket', S.protocolOf('unix:/tmp/rtpstream.sock') === 'UNIX');
check('http is WHIP', S.protocolOf('http://mtx.lan:8889/cam/whip') === 'WHIP');
check('https is WHIP too', S.protocolOf('https://mtx.lan:8889/cam/whip') === 'WHIP');

// The camera lowercases nothing on its side, but a person typing into a form
// does not know that, and a scheme is case-insensitive everywhere else.
check('the scheme is matched case-insensitively',
	S.protocolOf('RTMP://a.example/live/key') === 'RTMP');

check('a scheme the camera does not publish to is refused',
	S.protocolOf('srt://a.example:9000') === null);
check('text with no scheme is refused', S.protocolOf('a.example/live') === null);
check('an empty address is refused', S.protocolOf('') === null);
// Half-typed is the normal state of a field being filled in, and must not
// throw on the way through.
check('a bare colon is refused', S.protocolOf(':') === null);
check('undefined is refused', S.protocolOf(undefined) === null);

group('a member is shown where it means something');

// The whole reason this is not "draw every member the schema declares": a
// bearer token on an RTMP destination is a box that does nothing.
check('the token is for WHIP', S.applies('token', 'https://mtx.lan/cam/whip'));
check('and not for RTMP', !S.applies('token', 'rtmp://a.example/live/key'));
check('nor for RTP', !S.applies('token', 'udp://192.168.1.10:5600'));
check('nor for a unix socket', !S.applies('token', 'unix:/tmp/s.sock'));

// On a row with no address the answer is not knowable, and a field that
// appears the moment you finish typing "https:" reads as the form arguing.
check('an empty address shows it rather than guessing',
	S.applies('token', ''));
check('an unknown scheme shows it too', S.applies('token', 'srt://a:9000'));

check('a member this knows nothing about is always shown',
	S.applies('channel', 'rtmp://a.example/live/key')
	&& S.applies('channel', 'https://mtx.lan/cam/whip'));

// The RTP fragmentation size belongs to the protocols that fragment. RTMP
// frames its own and WHIP sizes itself from the WebRTC track, so offering it
// on either is a box that changes nothing — the same failure as a token on an
// RTMP row, which is why both go through one table.
check('the packet size is for RTP', S.applies('naluSize', 'udp://1.2.3.4:5600'));
check('and for a unix socket', S.applies('naluSize', 'unix:/tmp/s.sock'));
check('not for WHIP', !S.applies('naluSize', 'https://mtx.lan/cam/whip'));
check('not for RTMP', !S.applies('naluSize', 'rtmp://a.example/live/key'));
check('an empty address shows it rather than guessing',
	S.applies('naluSize', ''));

// A row can carry a number, and a number is not a string to be trimmed away.
check('a numeric member survives tidying',
	S.tidy({ url: 'udp://1.2.3.4:5600', naluSize: 1400 }).naluSize === 1400);
check('an edited packet size is a change',
	S.canon([{ url: 'udp://a:1', naluSize: 1400 }])
	!== S.canon([{ url: 'udp://a:1', naluSize: 4000 }]));

group('tidying a row');

check('strings are trimmed',
	S.tidy({ url: '  rtmp://a.example/k  ' }).url === 'rtmp://a.example/k');
// An absent member and an empty one mean the same thing to the camera, and
// writing `token: ""` into every row is noise in a file people read.
check('an empty member is left out',
	!('token' in S.tidy({ url: 'rtmp://a/k', token: '   ' })));
check('a member that is set survives',
	S.tidy({ url: 'https://m/whip', token: 's3cret' }).token === 's3cret');
check('nothing is invented',
	Object.keys(S.tidy({ url: 'rtmp://a/k' })).length === 1);
check('a non-object is an empty row',
	Object.keys(S.tidy(null)).length === 0);

group('normalising the list');

check('a row with no address is dropped',
	S.normalise([{ token: 'lonely' }, { url: 'rtmp://a/k' }]).length === 1);
check('a row whose address is only spaces is dropped',
	S.normalise([{ url: '   ' }]).length === 0);
check('the survivors keep their order',
	S.normalise([{ url: 'rtmp://one/k' }, { url: 'rtmp://two/k' }])
		.map(r => r.url).join(',') === 'rtmp://one/k,rtmp://two/k');
check('a non-array is an empty list', S.normalise('nope').length === 0);

group('the canonical form is what Save compares');

// If this misses an edit, the change is on screen and the save bar is grey.
check('an edited address is a different list',
	S.canon([{ url: 'rtmp://a/one' }]) !== S.canon([{ url: 'rtmp://a/two' }]));
check('an edited token is a different list',
	S.canon([{ url: 'https://m/whip', token: 'a' }])
	!== S.canon([{ url: 'https://m/whip', token: 'b' }]));
check('a member added is a different list',
	S.canon([{ url: 'rtmp://a/k' }])
	!== S.canon([{ url: 'rtmp://a/k', channel: 'sub' }]));
check('a row added is a different list',
	S.canon([{ url: 'rtmp://a/k' }])
	!== S.canon([{ url: 'rtmp://a/k' }, { url: 'rtmp://b/k' }]));
check('reordering the rows is a change',
	S.canon([{ url: 'rtmp://a/k' }, { url: 'rtmp://b/k' }])
	!== S.canon([{ url: 'rtmp://b/k' }, { url: 'rtmp://a/k' }]));

// And the other direction, which is the one that produces a save nobody asked
// for: anything that is not a change must not read as one.
check('member order within a row is not a change',
	S.canon([{ url: 'https://m/whip', token: 't' }])
	=== S.canon([{ token: 't', url: 'https://m/whip' }]));
check('whitespace around a value is not a change',
	S.canon([{ url: ' rtmp://a/k ' }]) === S.canon([{ url: 'rtmp://a/k' }]));
check('an emptied member is not a change against one that never existed',
	S.canon([{ url: 'rtmp://a/k', token: '' }])
	=== S.canon([{ url: 'rtmp://a/k' }]));
check('a blank row somebody added and left is not a change',
	S.canon([{ url: 'rtmp://a/k' }, { url: '' }])
	=== S.canon([{ url: 'rtmp://a/k' }]));

group('what a row is worth being told');

check('a good row says nothing', S.says({ url: 'rtmp://a.example/live/k' }) === '');
check('a WHIP row says nothing', S.says({ url: 'https://m.lan/cam/whip' }) === '');
check('an empty row is told so', S.says({ url: '' }) !== '');
check('an address with no scheme is told what one looks like',
	/scheme/.test(S.says({ url: 'a.example/live' })));
check('a scheme the camera cannot use names itself',
	/srt/.test(S.says({ url: 'srt://a.example:9000' })));
// The verdict is advisory and rendered as text; it must never be the word
// "undefined" or an exception on a half-built row.
check('a row with no url member at all is handled',
	typeof S.says({}) === 'string' && S.says({}) !== '');

done();
