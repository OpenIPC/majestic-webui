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
function load(withStorage, seed, refuseWrites) {
	const store = Object.assign({}, seed || {});
	// The three players the module dispatches between. Named objects rather
	// than stubs with behaviour: impl() is a lookup, and what is asserted is
	// which one comes back.
	const ctx = { window: {
		MajesticWebRTC: { name: 'webrtc' },
		MajesticVideo: { name: 'mse' },
		MajesticWasm: { name: 'wasm' },
	}, console: console };
	if (withStorage) {
		ctx.localStorage = {
			getItem: (k) => (k in store ? store[k] : null),
			setItem: (k, v) => {
				// A full quota throws on set while remove still works, which is
				// the sequence that can lose a value mid-migration.
				if (refuseWrites) throw new Error('QuotaExceededError');
				store[k] = String(v);
			},
			removeItem: (k) => { delete store[k]; },
		};
	}

	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx);
	const mod = ctx.window.MajesticTransport;
	mod.store = store;   // for asserting what survived
	mod.__ctx = ctx;     // for varying the globals the module reads
	return mod;
}

const iceServers = load(false).iceServers;

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// impl() had no coverage at all, and it is the one line that decides what BOTH
// pages can attach — the Live page has its own copy of the lookup, but the
// settings panel goes through this one.
// The gate that decides whether the software rung is worth a network round
// trip. It moved here from the two pages precisely so it could be tested once
// instead of drifting in two copies.
group('softwareRungFor() gates the software rung');
{
	const t = load(true);
	const setWasm = (w) => { t.__ctx.window.MajesticWasm = w; };
	const h265 = { available: true, handles: (c) => /^h265$|^hevc$/i.test(c || '') };

	setWasm(h265);
	check('a refused H.265 stream opens it',
		t.softwareRungFor('undecodable h265') === true);
	check('so does hevc spelled out',
		t.softwareRungFor('undecodable hevc') === true);
	// A browser refusing H.264 High 10 reports the same code; sending that to
	// an H.265 decoder would be a slower way to fail.
	check('a refused H.264 stream does not',
		t.softwareRungFor('undecodable h264') === false);
	// These are not decoding problems at all.
	check('an unreachable camera does not',
		t.softwareRungFor('unreachable') === false);
	check('a browser without MSE does not',
		t.softwareRungFor('no-mse') === false);
	check('a source-buffer failure does not',
		t.softwareRungFor('mse-error') === false);
	check('and neither does nothing at all',
		t.softwareRungFor() === false);

	// The common case: no decoder module in the page at all, which is every
	// camera whose browser never loaded one.
	setWasm(undefined);
	check('with no decoder present it is never worth trying',
		t.softwareRungFor('undecodable h265') === false);

	setWasm({ available: false, handles: () => true });
	check('nor when the browser cannot run one',
		t.softwareRungFor('undecodable h265') === false);
}

group('impl() maps a kind to a player');
{
	const t = load(true);
	check('webrtc', t.impl('webrtc').name === 'webrtc', t.impl('webrtc').name);
	check('mse', t.impl('mse').name === 'mse', t.impl('mse').name);
	check('wasm', t.impl('wasm').name === 'wasm', t.impl('wasm').name);
	// MSE is the floor on purpose: it plays whatever the browser can decode,
	// so an unrecognised kind lands somewhere that works rather than on
	// undefined.
	check('anything else falls to MSE', t.impl('nonsense').name === 'mse',
		t.impl('nonsense').name);
	check('and so does nothing at all', t.impl().name === 'mse');
}
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
check('nothing remembered to begin with', t.chosenStream('preview') === null);
t.chooseStream('preview', 0);
check('Main is remembered', t.chosenStream('preview') === 0);
t.chooseStream('preview', 1);
check('and so is Sub', t.chosenStream('preview') === 1);

// Separate per page: the two are looked at for different reasons, and someone
// can reasonably want Main on one and Sub on the other. Sharing one key would
// mean choosing on either page silently changed the other.
check('the live page starts with no preference of its own',
	t.chosenStream('live') === null);
t.chooseStream('live', 0);
check('the live page remembers its own answer', t.chosenStream('live') === 0);
check('and the preview page keeps its own', t.chosenStream('preview') === 1);

// A private window, or a browser set to block site data. The module must come
// back "no preference" rather than throw, or the preview does not start at all.
const noStore = load(false);
check('no storage reads as no preference',
	noStore.chosenStream('preview') === null);
let threw = false;
try { noStore.chooseStream('preview', 1); } catch (e) { threw = true; }
check('and writing without storage does not throw', !threw);

group('upgrading from the single shared key');
// A previous release wrote one key for both pages. Both inherit it — that is
// what the person was looking at — and it is then thrown away. Dropping it
// instead would return anyone who had chosen Main to the substream default,
// and the reason to choose Main is that the substream shows the wrong picture.
const up = load(true, { 'mj-preview-stream': '0' });
check('preview inherits the old choice', up.chosenStream('preview') === 0);
check('so does live', up.chosenStream('live') === 0);
// Read once: choosing on one page afterwards must not be undone by the old
// value coming back the next time the other page asks.
up.chooseStream('live', 1);
check('and the old key does not resurrect', up.chosenStream('live') === 1);
check('while preview keeps what it inherited', up.chosenStream('preview') === 0);

// A per-page answer already recorded wins over the legacy one.
const both = load(true, {
	'mj-preview-stream': '0', 'mj-preview-stream:preview': '1' });
check('an existing per-page choice is not overwritten',
	both.chosenStream('preview') === 1);
check('while the page without one still inherits', both.chosenStream('live') === 0);

// If the new keys cannot be written, the old one must survive to be tried
// again — deleting it first would lose the choice permanently, and write()
// swallows storage failures so nothing else would notice.
const stuck = load(true, { 'mj-preview-stream': '0' }, true);
check('a refused write leaves no preference rather than a wrong one',
	stuck.chosenStream('preview') === null);
check('and the legacy key is kept for the next attempt',
	stuck.store['mj-preview-stream'] === '0',
	JSON.stringify(stuck.store));

done();
