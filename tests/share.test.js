// The Share dialog's small decisions. Two fail silently: a guest shown the
// owner's Share and Sign out items (nothing breaks -- the camera refuses them
// -- but the guest is offered what is not theirs), and a remaining time that
// reads "0 min" for a link that still has seconds to run, which looks ended.
'use strict';

const { check, group, done } = require('./assert');
const { shareRemaining, shareGuest, shareError, SHARE_DURATIONS, SHARE_DEFAULT_TTL } = require('../www/a/share.js');

group('remaining time');
const now = 1_000_000_000_000;
check('two hours', shareRemaining(now / 1000 + 7200, now) === '2 h 0 min');
check('days and hours', shareRemaining(now / 1000 + 3 * 86400 + 3600, now) === '3 d 1 h');
check('seconds left read as a minute, not zero', shareRemaining(now / 1000 + 30, now) === '1 min');
check('ended', shareRemaining(now / 1000 - 5, now) === '0 min');

group('who is looking');
const top = {};
top.parent = top;
check('the owner, on the camera itself', shareGuest(top) === false);
check('a guest inside the share page', shareGuest({ parent: { __share: {} } }) === true);
check('framed by something else', shareGuest({ parent: {} }) === false);
check('a parent it may not read', shareGuest({ get parent() { throw new Error('cross-origin'); } }) === false);

group('durations');
check('the default is offered', SHARE_DURATIONS.some(([s]) => s === SHARE_DEFAULT_TTL));
check('a week at most, the camera’s cap', Math.max(...SHARE_DURATIONS.map(([s]) => s)) === 7 * 86400);

group('errors');
check('an unset clock is named', /clock/.test(shareError(503)));
check('a full camera says what to do', /End one/.test(shareError(409)));

done();
