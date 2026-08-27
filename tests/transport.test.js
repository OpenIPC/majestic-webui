// MajesticTransport.iceServers() — the browser's half of the camera's
// STUN/TURN configuration.
//
// This exists because the camera used to build this list itself, for the debug
// page that has since been retired, and was tested where it was built. The
// rules moved here with the job — so the coverage had to move too, or the only
// thing standing between an operator's `iceServers` setting and an
// RTCPeerConnection that throws is someone remembering.
//
// The camera still applies the same rules on its own side. Change one, change
// both; these are the cases that say what "both" means.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const SRC = path.join(__dirname, '..', 'www', 'a', 'preview-transport.js');

// A browser's worth of storage, and no more. Two contexts: one with it, one
// without — every read and write in the module is wrapped, and a module that
// threw without storage would fail in a private window too, which is a real
// browser state and not a hypothetical one.
function load(withStorage) {
	const store = {};
	const ctx = { window: {}, console: console };
	if (withStorage) {
		ctx.localStorage = {
			getItem: (k) => (k in store ? store[k] : null),
			setItem: (k, v) => { store[k] = String(v); },
			removeItem: (k) => { delete store[k]; },
		};
	}
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx);
	return ctx.window.MajesticTransport;
}

const iceServers = load(false).iceServers;

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const is = (name, got, want) =>
	check(name, eq(got, want), 'got ' + JSON.stringify(got));

group('the default the camera falls back to');
is('unset means the camera default, not an empty list',
	iceServers('', '', ''), [{ urls: 'stun:stun.cloudflare.com:3478' }]);
is('null is unset too', iceServers(null, null, null),
	[{ urls: 'stun:stun.cloudflare.com:3478' }]);

group('every spelling of "none"');
// YAML 1.1 decides what these words mean before majestic ever sees them:
// `iceServers: off` reaches the config as the string "false", and so do `no`
// and `false`. Accepting only the tidy answer leaves an operator who wrote the
// natural one gathering host candidates and wondering why.
['none', 'NONE', 'off', 'no', 'false', 'disabled'].forEach((w) =>
	is('"' + w + '" disables STUN', iceServers(w, 'u', 'p'), []));
is('a server really called "nonesuch" is a server',
	iceServers('stun:nonesuch:3478', '', ''), [{ urls: 'stun:nonesuch:3478' }]);

group('list parsing');
is('commas separate', iceServers('stun:a:1,stun:b:2', '', ''),
	[{ urls: 'stun:a:1' }, { urls: 'stun:b:2' }]);
is('so do spaces and newlines — a YAML block scalar gives one per line',
	iceServers('stun:a:1 stun:b:2\nstun:c:3', '', ''),
	[{ urls: 'stun:a:1' }, { urls: 'stun:b:2' }, { urls: 'stun:c:3' }]);

group('relays and their credentials');
// A turn: entry missing either credential makes RTCPeerConnection throw
// InvalidAccessError — and it throws before the page opens its signalling
// socket, so the camera sees no attempt at all and the failure reads as
// "signalling never happened". Dropping the entry costs the relay; keeping it
// costs the whole session.
is('a relay with both credentials is kept',
	iceServers('turn:a:3478', 'u', 'p'),
	[{ urls: 'turn:a:3478', username: 'u', credential: 'p' }]);
is('turns: counts as a relay', iceServers('turns:a:5349', 'u', 'p'),
	[{ urls: 'turns:a:5349', username: 'u', credential: 'p' }]);
is('a relay with no credentials is dropped on its own, the rest kept',
	iceServers('stun:a:1,turn:b:2', '', ''), [{ urls: 'stun:a:1' }]);
is('half a credential is no credential',
	iceServers('turn:b:2', 'u', ''), []);
is('and the STUN entries beside it still survive that',
	iceServers('stun:a:1,turn:b:2,stun:c:3', 'u', ''),
	[{ urls: 'stun:a:1' }, { urls: 'stun:c:3' }]);

group('the remembered Main/Sub choice');
// Someone whose video0 is cropped, or whose substream is sized nothing like
// the preview box, wants Main. The default is still Sub — that is the common
// case — but the answer has to survive a page load or they re-pick it for ever.
const t = load(true);
check('nothing remembered to begin with', t.chosenStream() === null);
t.chooseStream(0);
check('Main is remembered', t.chosenStream() === 0);
t.chooseStream(1);
check('and so is Sub', t.chosenStream() === 1);

// A private window, or a browser set to block site data. The module must come
// back "no preference" rather than throw, or the preview does not start at all.
const noStore = load(false);
check('no storage reads as no preference', noStore.chosenStream() === null);
let threw = false;
try { noStore.chooseStream(1); } catch (e) { threw = true; }
check('and writing without storage does not throw', !threw);

done();
