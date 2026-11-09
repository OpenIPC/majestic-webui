// The pin map's dimmable lamp (www/a/mj-settings.js: pwmLamp).
//
// A board may carry two lamps on PWM channels -- nightMode.irLightPwmChannel
// and whiteLightPwmChannel -- and the camera reports every lamp pad under the
// one backlightPin role. The first version read only the IR channel, so a
// white-only lamp showed as "not set" and its pad looked free to give the
// IR-cut filter.
//
// mj-settings.js is one IIFE, so the function is sliced out of its source, as
// live-doc.test.js does.
'use strict';

const fs = require('fs');
const path = require('path');
const { check, group, done } = require('./assert');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'www', 'a', 'mj-settings.js'), 'utf8');
const head = '\t\tfunction pwmLamp(only) {';
const from = SRC.indexOf(head);
if (from < 0) throw new Error('pwmLamp not found in mj-settings.js');
const code = SRC.slice(from, SRC.indexOf('\n\t\t}\n', from) + 4);

function getDotted(obj, dot) {
	return dot.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function lamp(nightMode, assigned, only) {
	const state = { config: { nightMode }, ircutInfo: { assigned: assigned || [] } };
	return new Function('state', 'getDotted', 'only',
		code + '\nreturn pwmLamp(only);')(state, getDotted, only);
}
const pad = (pin) => ({ role: 'backlightPin', pin });

group('one lamp');
{
	const ir = lamp({ irLightPwmChannel: 'pwm8' }, [pad(56)]);
	check('an IR lamp is a lamp', ir && ir.channel === 'pwm8', ir);
	check('...on the one pad the camera reports', ir && ir.pin === 56, ir);
	check('...named by its channel', ir && ir.hint === 'dimmable, on pwm8', ir);

	const white = lamp({ whiteLightPwmChannel: 'pwm9' }, [pad(55)]);
	check('a white-only lamp is a lamp too', white && white.channel === 'pwm9', white);
	check('...and its pad is taken', white && white.pin === 55, white);
}

group('two lamps');
{
	const both = lamp({ irLightPwmChannel: 'pwm8', whiteLightPwmChannel: 'pwm9' },
		[pad(56), pad(55)]);
	check('both are named', both && /IR on pwm8/.test(both.hint) &&
		/white on pwm9/.test(both.hint), both);
	check('...and no single pad is claimed for the two', both && both.pin === undefined, both);
}

// Each lamp's own row (the night illuminator's and the white light's) asks
// about its own channel. A white lamp on a channel is not the IR lamp, and a
// whiteLightPin left beside the white channel is ignored by the camera, so
// the white row is the channel, not that pin.
group('one lamp per row');
{
	const whiteOnly = { whiteLightPwmChannel: 'pwm9' };
	check('a white channel is not the IR lamp', lamp(whiteOnly, [pad(55)], 'IR') === null);
	const w = lamp(whiteOnly, [pad(55)], 'white');
	check('...it is the white light, on its pad', w && w.channel === 'pwm9' && w.pin === 55, w);

	const both = { irLightPwmChannel: 'pwm8', whiteLightPwmChannel: 'pwm9' };
	const ir = lamp(both, [pad(56), pad(55)], 'IR');
	check('with two, each row names its own channel', ir && ir.hint === 'dimmable, on pwm8', ir);
	check('...and claims no pad, since which is which is a guess', ir && ir.pin === undefined, ir);
	const wb = lamp(both, [pad(56), pad(55)], 'white');
	check('...the white row too', wb && wb.hint === 'dimmable, on pwm9' && wb.pin === undefined, wb);
}

group('no lamp');
{
	check('no channel is no lamp', lamp({}) === null);
	check('"none" is no lamp', lamp({ irLightPwmChannel: 'none',
		whiteLightPwmChannel: 'none' }) === null);
}

done();
