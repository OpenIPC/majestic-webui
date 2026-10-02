// The Share dialog's small decisions. All of them fail silently: a guest shown
// the owner's Share and Sign out items, or menu entries their access is
// refused (nothing breaks -- the camera refuses them -- but the guest is
// offered what is not theirs); a remaining time that reads "0 min" for a link
// that still has seconds to run, which looks ended; two links without a note
// that read the same, so the owner ends the wrong one; and a default access
// level that is the one able to change the camera.
'use strict';

const { check, group, done } = require('./assert');
const {
	shareRemaining, shareClock, shareNames, shareSummary, shareLive, shareGuest, shareGuestScope, shareRefused,
	shareError, shareReason, SHARE_DURATIONS, SHARE_DEFAULT_TTL, SHARE_SCOPES, SHARE_DEFAULT_SCOPE,
} = require('../www/a/share.js');

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

group('the clock');
// Local time on both sides, so the test holds in any time zone.
const at = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi).getTime();
const noon = at(2026, 9, 2, 12, 0);
check('today is the time alone', shareClock(at(2026, 9, 2, 16, 51) / 1000, noon) === '16:51');
check('minutes and hours are padded', shareClock(at(2026, 9, 2, 9, 5) / 1000, noon) === '09:05');
check('another day names it', shareClock(at(2026, 9, 5, 16, 51) / 1000, noon) === '5 Oct 16:51');
check('yesterday is another day', shareClock(at(2026, 9, 1, 23, 59) / 1000, noon) === '1 Oct 23:59');

group('naming a link');
const made = at(2026, 9, 2, 10, 2) / 1000;
const names = (list) => shareNames(list, noon);
check('a note is its name', names([{ label: 'Mum', created: made }])[0] === 'Mum');
check('no note: when it was made', names([{ label: '', created: made }])[0] === 'Link from 10:02');
const sameMinute = names([{ label: '', created: made + 20 }, { label: '', created: made }]);
check('two made in the same minute are told apart, in the order they were made',
	sameMinute[0] === 'Link from 10:02 (2)' && sameMinute[1] === 'Link from 10:02 (1)');
const sameNote = names([{ label: 'Mum', created: made }, { label: 'Mum', created: made + 3600 }, { label: 'Dad', created: made }]);
check('two with the same note are numbered, a third left alone',
	sameNote[0] === 'Mum (1)' && sameNote[1] === 'Mum (2)' && sameNote[2] === 'Dad');
check('the summary says when it ends, and how soon',
	shareSummary({ scope: 'view', expires: at(2026, 9, 2, 14, 0) / 1000 }, noon).replace(/\u00a0/g, ' ') === 'Watch only · ends 14:00 (in 2 h 0 min)');
check('the duration does not break across lines',
	shareSummary({ scope: 'view', expires: at(2026, 9, 3, 14, 0) / 1000 }, noon).endsWith('ends 3\u00a0Oct\u00a014:00 (in\u00a01\u00a0d\u00a02\u00a0h)'));
check('an unknown level is shown as the camera spells it',
	shareSummary({ scope: 'odd', expires: noon / 1000 + 60 }, noon).startsWith('odd · '));

group('the navbar count');
const nowS = noon / 1000;
check('an ended link is not counted', shareLive([{ expires: nowS - 1 }, { expires: nowS + 60 }], noon).count === 1);
check('it re-counts when the next one ends', shareLive([{ expires: nowS + 600 }, { expires: nowS + 60 }], noon).next === 60000);
check('nothing live: no count, nothing to wait for', (({ count, next }) => count === 0 && next === null)(shareLive([{ expires: nowS }], noon)));
check('an unread list counts nothing', shareLive(null, noon).count === 0);

group('the access offered first');
check('watch only is the default', SHARE_DEFAULT_SCOPE === 'view' && SHARE_SCOPES.view.label === 'Watch only');
check('every level says what it means', Object.values(SHARE_SCOPES).every((x) => x.label && x.hint));
check('settings changes are said to outlast the link', /after the link ends/.test(SHARE_SCOPES.admin.hint));

group('a guest\u2019s menu');
check('the level the camera welcomed', shareGuestScope({ parent: { __share: { welcome: { scope: 'admin' } } } }) === 'admin');
check('no welcome is no level', shareGuestScope({ parent: { __share: {} } }) === null);
check('an unreadable parent is no level', shareGuestScope({ get parent() { throw new Error('x'); } }) === null);
check('settings guest: the console is not offered', shareRefused('console.cgi', 'admin'));
check('settings guest: the password page is not offered', shareRefused('access.cgi', 'admin'));
check('settings guest: with a query string too', shareRefused('network.cgi?x=1', 'admin'));
check('settings guest: restarting the camera is not offered', shareRefused('restart.cgi', 'admin'));
check('settings guest: sending pictures out is not offered', shareRefused('openwall.cgi', 'admin'));
check('settings guest: the settings page is', !shareRefused('camera.cgi', 'admin'));
check('settings guest: the live page is', !shareRefused('live.cgi', 'admin'));
check('an unknown level is pruned like settings', shareRefused('console.cgi', null));
check('full control is offered everything', !shareRefused('console.cgi', 'full'));
check('a link with no address is left alone', !shareRefused(null, 'admin') && !shareRefused('#', 'admin'));

group('durations');
check('the default is offered', SHARE_DURATIONS.some(([s]) => s === SHARE_DEFAULT_TTL));
check('a week at most, the camera’s cap', Math.max(...SHARE_DURATIONS.map(([s]) => s)) === 7 * 86400);

group('errors');
check('an unset clock is named', /clock/.test(shareError(503)));
check('a full camera says what to do', /End one/.test(shareError(409)));

group('the camera\u2019s words');
const page = '<HTML><HEAD>\n<TITLE>500 ended now, but not saved</TITLE>\n</HEAD><BODY>\n<H1>ended now, but not saved</H1>\n</BODY></HTML>\n';
check('once, without the status code', shareReason(page) === 'ended now, but not saved');
check('plain text as it is', shareReason('refused') === 'refused');

done();
