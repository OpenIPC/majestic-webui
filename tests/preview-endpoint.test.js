// Where a video socket goes: this page's own camera, or another one with
// the session brokered for it in the URL (preview-signal.js:endpoint).
//
// Every player -- WebRTC and data-channel signalling, MSE, the software
// rung -- builds its socket URL through this one function, so what is
// checked here is what all of them send: the page's own host when no
// origin is named, the other camera's origin turned into a ws(s) base when
// one is, the session appended only when there is one, and a value given
// as a function read at the time of asking -- a session refreshed mid-life
// has to be the one the next reconnect carries, not the one captured at
// mount.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const ok = (cond, label) => check(label, !!cond);

function load(location) {
	const sandbox = {
		window: {}, location: location || { protocol: 'http:', host: 'cam.local' },
		WebSocket: function () {}, JSON: JSON, String: String,
		encodeURIComponent: encodeURIComponent,
	};
	vm.createContext(sandbox);
	vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'www', 'a', 'preview-signal.js'), 'utf8'),
		sandbox, { filename: 'preview-signal.js' });
	return sandbox.window.MajesticSignal;
}

group('this page\'s own camera');
{
	const S = load();
	const e = S.endpoint();
	ok(e.base === 'ws://cam.local', 'no endpoint: the page host over ws');
	ok(e.query === '', 'no endpoint: no session in the URL');
	ok(S.url(1) === 'ws://cam.local/ws/webrtc?stream=1', 'the signalling URL as before');
	ok(S.endpoint({}).base === 'ws://cam.local', 'an empty endpoint is the page host');
	ok(S.endpoint({ origin: '', session: '' }).query === '', 'empty strings are absence');
}

group('a secure page stays secure');
{
	const S = load({ protocol: 'https:', host: 'cam.example:8443' });
	ok(S.url(0) === 'wss://cam.example:8443/ws/webrtc?stream=0', 'wss on https');
}

group('another camera, with the session brokered for it');
{
	const S = load();
	const e = S.endpoint({ origin: 'http://192.0.2.7:80', session: 'abc123' });
	ok(e.base === 'ws://192.0.2.7:80', 'its http origin becomes a ws base');
	ok(e.query === '&session=abc123', 'the session rides the query');
	ok(S.url(0, { origin: 'http://192.0.2.7:80', session: 'abc123' }) === 'ws://192.0.2.7:80/ws/webrtc?stream=0&session=abc123',
		'the signalling URL carries both');
	ok(S.endpoint({ origin: 'https://cam.far/', session: 's' }).base === 'wss://cam.far',
		'https becomes wss, and a trailing slash goes');
	ok(S.endpoint({ origin: 'http://[2001:db8::7]:81', session: 's' }).base === 'ws://[2001:db8::7]:81',
		'an IPv6 origin keeps its brackets');
	ok(S.endpoint({ origin: 'http://192.0.2.7', session: 'a b&c' }).query === '&session=a%20b%26c',
		'the session is encoded for a URL');
	ok(S.endpoint({ origin: 'ftp://x', session: 's' }).base === 'ws://cam.local',
		'an origin that is not http(s) is ignored, not sent');
	ok(S.endpoint({ origin: 'http://192.0.2.7' }).query === '', 'an origin without a session: no query');
}

group('a value given as a function is read when asked');
{
	const S = load();
	let sess = 'first';
	const ep = { origin: () => 'http://192.0.2.7', session: () => sess };
	ok(S.url(0, ep).endsWith('&session=first'), 'the first open carries the first session');
	sess = 'second';
	ok(S.url(0, ep).endsWith('&session=second'), 'a reconnect carries the refreshed one');
	ok(S.endpoint({ origin: () => '', session: () => '' }).base === 'ws://cam.local',
		'functions returning nothing mean the page host');
}

done();
