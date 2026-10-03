// The heartbeat's pace (www/a/main.js mjHeartbeatMs). It fails silently and
// only at a distance: a share guest polling /metrics every 2 s looks exactly
// like one polling every 10 s, until a lossy link puts each reply in line ahead
// of the guest's console echoes.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const noop = () => {};
const ctx = { window: { addEventListener: noop }, document: { addEventListener: noop }, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'www', 'a', 'main.js'), 'utf8'), ctx);
const ms = ctx.mjHeartbeatMs;

group('who is polling');
const top = {}; top.parent = top;
check('the owner, on the camera itself: every 2 s', ms(top) === 2000);
check('a share guest, inside the share page: every 10 s', ms({ parent: { __share: {} } }) === 10000);
check('framed by something else: every 2 s', ms({ parent: {} }) === 2000);
check('a parent it may not read: every 2 s', ms({ get parent() { throw new Error('cross-origin'); } }) === 2000);
check('a guest is polled less often, never more', ms({ parent: { __share: {} } }) > ms(top));

done();
