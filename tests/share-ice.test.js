// Which ICE servers a peer connection gets (preview-signal.js iceOf), and
// where the player's story goes (shareTrace). Both fail silently: a guest of a
// share given the camera's list alone, off a direct path, sees the picture
// fall back to MSE through the tunnel and nothing says why; a
// trace that goes nowhere leaves the guest's diagnostics without the player.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

function load() {
	const sandbox = { window: {}, location: { protocol: 'http:', host: 'cam.local' }, WebSocket: function () {}, JSON, String };
	vm.createContext(sandbox);
	vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'www', 'a', 'preview-signal.js'), 'utf8'),
		sandbox, { filename: 'preview-signal.js' });
	return sandbox.window.MajesticSignal;
}

const S = load();
const camera = [{ urls: 'stun:stun.example:3478' }];
const turn = [{ urls: ['turn:openipc.kz:3478?transport=udp'], username: 'u', credential: 'c' }];
// A page in a share's frame: its parent is the share page, which announces
// itself; the page itself is its own window.
const framed = (share) => { const w = {}; w.parent = { __share: share }; return w; };
const top = () => { const w = {}; w.parent = w; return w; };

group('the ICE servers a peer connection gets');
{
	const got = S.iceOf({ iceServers: camera }, framed({ ice: turn }));
	check('inside a share: the share\'s TURN first', got[0] === turn[0]);
	check('and the camera\'s own after it', got.length === 2 && got[1] === camera[0]);
	check('inside a share with no list: the camera\'s alone', S.iceOf({ iceServers: camera }, framed({})).length === 1);
	check('inside a share with an empty list: the camera\'s alone', S.iceOf({ iceServers: camera }, framed({ ice: [] }))[0] === camera[0]);
	check('on the camera itself: the camera\'s alone', S.iceOf({ iceServers: camera }, top()).length === 1);
	const sealed = {};
	Object.defineProperty(sealed, 'parent', { get() { throw new Error('cross-origin'); } });
	check('a parent it may not read is no share', S.iceOf({ iceServers: camera }, sealed).length === 1);
	check('the camera\'s list read through its function', S.iceOf({ iceServers: () => camera }, framed({ ice: turn })).length === 2);
	check('a camera list that throws still gets the share\'s', S.iceOf({ iceServers: () => { throw new Error('x'); } }, framed({ ice: turn }))[0] === turn[0]);
	check('no window at all: the camera\'s alone', S.iceOf({ iceServers: camera }, null).length === 1);
}

group('the player\'s story, in the share\'s diagnostics');
{
	const lines = [];
	S.shareTrace('player ice', 'checking', framed({ trace: (w, d) => lines.push(w + ' ' + d) }));
	check('inside a share it is traced there', lines.length === 1 && lines[0] === 'player ice checking');
	S.shareTrace('player ice', 'checking', top());
	check('outside a share it goes nowhere', lines.length === 1);
	S.shareTrace('player ice', 'x', framed({ trace: () => { throw new Error('the share page\'s'); } }));
	check('a share page whose trace throws costs the player nothing', true);
}

done();
