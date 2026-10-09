// The pad's Follow toggle (www/a/ptz-follow.js).
//
// Shown where it does nothing, it is a switch the operator flips and then
// watches the head ignore. The two things it needs are a motor that counts
// steps and the detector that finds the person; a line that merely mentions
// "steps" somewhere else must not count as the first.
const { check, done } = require('./assert.js');
const eq = (name, got, want) => check(name, got === want, 'got ' + JSON.stringify(got));
const F = require('../www/a/ptz-follow.js');

const HEAD = 'actuator=gpiostep pulse=500 state=ready verbs=stop,up,down,left,right speeds=1-100 steps=1';
const NPU = { npuDetect: { enabled: true } };

eq('a counting head with the detector on offers it', F.offered(HEAD, NPU), true);
eq('the detector off: not offered', F.offered(HEAD, { npuDetect: { enabled: false } }), false);
eq('no detector section: not offered', F.offered(HEAD, {}), false);
eq('no config at all: not offered', F.offered(HEAD, undefined), false);
eq('an older plugin (no steps=): not offered',
	F.offered('actuator=gpiostep pulse=500 state=ready verbs=stop,up,down,left,right speeds=1-100', NPU), false);
eq('a serial lens: not offered',
	F.offered('actuator=pelco-xm port=/dev/ttyAMA0 speed=115200 pulse=500 state=ready verbs=stop,near,far,tele,wide speeds=1-100', NPU), false);
eq('a word ending in steps= is not the token', F.offered('actuator=x microsteps=16', NPU), false);
eq('no answer: not offered', F.offered(undefined, NPU), false);

eq('on when ptz.track is true', F.on({ ptz: { track: true } }), true);
eq('off when false', F.on({ ptz: { track: false } }), false);
eq('off when absent', F.on({}), false);
eq('a string "true" is not on', F.on({ ptz: { track: 'true' } }), false);

eq('switching on writes the one key', F.body(true), '{"ptz":{"track":true}}');
eq('switching off writes false, not a removal', F.body(false), '{"ptz":{"track":false}}');

done();
