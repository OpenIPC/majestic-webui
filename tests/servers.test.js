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

// A row nobody has addressed yet is one box, not the union of every
// protocol's settings. Clicking Add used to open a token, a packet size,
// three audio controls and six paragraphs for a destination with no name —
// and all but two of them would turn out not to apply.
check('an unaddressed row offers nothing but the address',
	!S.applies('token', '') && !S.applies('naluSize', '')
	&& !S.applies('audioSource', '') && !S.applies('channel', ''));
check('nor does a scheme the camera cannot publish to',
	!S.applies('token', 'srt://a:9000')
	&& !S.applies('channel', 'srt://a:9000'));

// …and the moment the scheme says what the row is, its members arrive.
check('a member every protocol has appears with the scheme',
	S.applies('channel', 'rtmp://a.example/live/key')
	&& S.applies('channel', 'https://mtx.lan/cam/whip')
	&& S.applies('channel', 'udp://1.2.3.4:5600'));

// Every destination can be switched off, whatever it speaks. The switch used
// to be one control above the whole list, which meant turning off the one
// endpoint that had started refusing connections took the other two with it.
check('so does the switch', S.applies('enabled', 'rtmp://a.example/live/key')
	&& S.applies('enabled', 'https://mtx.lan/cam/whip')
	&& S.applies('enabled', 'unix:/tmp/s.sock'));
check('but not on a row with no address', !S.applies('enabled', ''));

// The RTP fragmentation size belongs to the protocols that fragment. RTMP
// frames its own and WHIP sizes itself from the WebRTC track, so offering it
// on either is a box that changes nothing — the same failure as a token on an
// RTMP row, which is why both go through one table.
check('the packet size is for RTP', S.applies('naluSize', 'udp://1.2.3.4:5600'));
check('and for a unix socket', S.applies('naluSize', 'unix:/tmp/s.sock'));
check('not for WHIP', !S.applies('naluSize', 'https://mtx.lan/cam/whip'));
check('not for RTMP', !S.applies('naluSize', 'rtmp://a.example/live/key'));
check('and not on a row with no address at all',
	!S.applies('naluSize', ''));

// Audio is RTMP's alone: only src/rtmp-stream.c reads these, WHIP publishes
// no audio at all, and an RTP destination follows the camera's own codec.
// They were section-wide settings describing the RTMP rows while sitting
// above a list that is mostly not RTMP.
check('audio belongs to RTMP',
	S.applies('audioSource', 'rtmp://a.example/live/key')
	&& S.applies('audioCodec', 'rtmps://a.example/live/key')
	&& S.applies('audioFile', 'rtmp://a.example/live/key'));
check('not to WHIP', !S.applies('audioSource', 'https://mtx.lan/cam/whip')
	&& !S.applies('audioCodec', 'https://mtx.lan/cam/whip'));
check('not to RTP', !S.applies('audioSource', 'udp://1.2.3.4:5600')
	&& !S.applies('audioCodec', 'udp://1.2.3.4:5600'));

// A row can carry a number, and a number is not a string to be trimmed away.
check('a numeric member survives tidying',
	S.tidy({ url: 'udp://1.2.3.4:5600', naluSize: 1400 }).naluSize === 1400);
check('an edited packet size is a change',
	S.canon([{ url: 'udp://a:1', naluSize: 1400 }])
	!== S.canon([{ url: 'udp://a:1', naluSize: 4000 }]));

group('a member leaves in the type the schema declared');

// Everything on the page answers in strings, and the camera type-checks each
// member of a stored element: a string where `items` said integer or boolean
// is a 400, so the whole save fails on one number box.
check('a checkbox becomes a real boolean',
	S.memberValue('boolean', true) === true
	&& S.memberValue('boolean', false) === false);
check('a number box becomes a real number',
	S.memberValue('integer', '4000') === 4000);
// Not 0, and not NaN: an empty box is a row saying it named no value, which
// tidy() drops so the camera answers from its own default.
check('an empty number box stays empty',
	S.memberValue('integer', '') === '');
check('a string member is left alone',
	S.memberValue('string', ' rtmp://a/k ') === ' rtmp://a/k ');
check('and so is a member of a type this knows nothing about',
	S.memberValue(undefined, 'x') === 'x');

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
// `false` is what a switched-off destination says, and dropping it as empty
// would leave the row saying nothing — which is how the camera spells on.
check('a switch that is off survives',
	S.tidy({ url: 'rtmp://a/k', enabled: false }).enabled === false);
check('and one that is on stays a boolean',
	S.tidy({ url: 'rtmp://a/k', enabled: true }).enabled === true);
// A number member arrives as a number, because the camera type-checks it.
check('a number survives as a number',
	S.tidy({ url: 'udp://a:1', naluSize: 4000 }).naluSize === 4000);

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
check('switching a destination off is a different list',
	S.canon([{ url: 'rtmp://a/k', enabled: true }])
	!== S.canon([{ url: 'rtmp://a/k', enabled: false }]));
// Every row the page reads carries one, so a saved list must carry it too:
// a file whose rows say nothing about the switch is what a file written
// before the switch moved onto the rows looks like, and the camera reads
// that as off.
check('and the saved list says so either way',
	JSON.parse(S.canon([{ url: 'rtmp://a/k', enabled: true }]))[0].enabled
		=== true);
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
// A row somebody just added has nothing to be told: it is empty because they
// have not typed yet, and the placeholder already says what goes there.
check('a freshly added row is not scolded', S.says({ url: '' }) === '');
// The switch is on every row and defaults to on, so a row that holds nothing
// still arrives here carrying one. Counting it would scold every new row.
check('nor is one carrying only its switch',
	S.says({ url: '', enabled: true }) === ''
	&& S.says({ url: '', enabled: false }) === '');
check('but one carrying settings and no address is',
	S.says({ url: '', token: 'x' }) !== '');
check('a typed number counts as settings too',
	S.says({ url: '', naluSize: 4000 }) !== '');
check('an address with no scheme is told what one looks like',
	/scheme/.test(S.says({ url: 'a.example/live' })));
check('a scheme the camera cannot use names itself',
	/srt/.test(S.says({ url: 'srt://a.example:9000' })));
// The verdict is advisory and rendered as text; it must never be the word
// "undefined" or an exception on a half-built row.
check('a row with no url member at all is handled',
	typeof S.says({}) === 'string');

done();
