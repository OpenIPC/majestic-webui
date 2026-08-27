// MajesticTransport.iceServers() — the browser's half of the camera's
// STUN/TURN configuration.
//
// This exists because the camera used to build this list in C and had tests
// for it there. The page that consumed it is gone, majestic_stun_ice_js() went
// with it, and the rules moved here — so the coverage has to move too, or the
// only thing standing between an operator's `iceServers` setting and a
// RTCPeerConnection that throws is someone remembering.
//
// The rules mirror include/majestic/stun_default.h in the majestic tree.
// Change one, change both; these are the cases that say what "both" means.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const SRC = path.join(__dirname, '..', 'www', 'a', 'preview-transport.js');

// The module only needs a window to hang itself off. localStorage is absent
// here on purpose: every read and write in it is wrapped, and a module that
// threw without storage would fail in a private window too.
const ctx = { window: {}, console: console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx);
const iceServers = ctx.window.MajesticTransport.iceServers;

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

done();
