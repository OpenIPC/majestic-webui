// The pad's Follow toggle (www/a/ptz-follow.js).
//
// Shown where it does nothing, it is a switch the operator flips and then
// watches the head ignore. The two things it needs are a motor that counts
// steps and a camera that can detect something to follow, and the camera's
// capability line says both; a line that merely mentions "steps" or "follow"
// somewhere else must not count.
const { check, done } = require('./assert.js');
const eq = (name, got, want) => check(name, got === want, 'got ' + JSON.stringify(got));
const F = require('../www/a/ptz-follow.js');

const MOTOR = 'actuator=gpiostep pulse=500 state=ready verbs=stop,up,down,left,right speeds=1-100 steps=1';
const HEAD = MOTOR + ' frame=134x62 follow=human,vehicle,animal';

eq('a counting head on a camera that detects offers it', F.offered(HEAD), true);
eq('people only (a CPU camera): offered', F.offered(MOTOR + ' follow=human'), true);
eq('nothing to detect with (no follow=): not offered', F.offered(MOTOR), false);
eq('follow= with no class: not offered', F.offered(MOTOR + ' follow='), false);
eq('a word ending in follow= is not the token', F.offered(MOTOR + ' unfollow=human'), false);
eq('alerts off does not matter: the line decides',
	F.view(HEAD, { objectDetect: { enabled: false }, ptz: { track: true } }).show, true);
eq('an older plugin (no steps=): not offered',
	F.offered('actuator=gpiostep pulse=500 state=ready verbs=stop,up,down,left,right speeds=1-100 follow=human'), false);
eq('a serial lens: not offered',
	F.offered('actuator=pelco-xm port=/dev/ttyAMA0 speed=115200 pulse=500 state=ready verbs=stop,near,far,tele,wide speeds=1-100 follow=human'), false);
eq('a word ending in steps= is not the token', F.offered('actuator=x microsteps=16 follow=human'), false);
eq('no answer: not offered', F.offered(undefined), false);

eq('on when ptz.track is true', F.on({ ptz: { track: true } }), true);
eq('off when false', F.on({ ptz: { track: false } }), false);
eq('off when absent', F.on({}), false);
eq('a string "true" is not on', F.on({ ptz: { track: 'true' } }), false);

// A fresh read decides both, so a change made elsewhere shows: another
// operator's setting is what it shows.
const v1 = F.view(HEAD, { ptz: { track: true } });
eq('a fresh read: shown and on', v1.show && v1.on, true);
const v2 = F.view(MOTOR, { ptz: { track: true } });
eq('a camera that cannot detect: hidden', v2.show, false);
eq('and a hidden switch is never shown as on', v2.on, false);
const v3 = F.view(HEAD, { ptz: { track: false } });
eq('switched off by another operator: shown, off', v3.show && !v3.on, true);

eq('switching on writes the one key', F.body(true), '{"ptz":{"track":true}}');
eq('switching off writes false, not a removal', F.body(false), '{"ptz":{"track":false}}');

done();
