// The pad's presets (www/a/ptz-presets.js).
//
// Offered where the head says how many it stores and nowhere else; listed from
// the camera's own rows, Home first; a new one never takes Home by default.
const { check, done } = require('./assert.js');
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got));
const P = require('../www/a/ptz-presets.js');

const LINE = 'actuator=ms41908 port=/dev/ttyAMA1 speed=9600 addr=1 pulse=500 state=ready verbs=stop,up,down,left,right speeds=1-100';

eq('a head that stores 32: 32', P.offered(LINE + ' presets=1-32 head=pelco-d headstate=ready'), 32);
eq('no token: none', P.offered(LINE), 0);
eq('a word ending in presets= is not the token', P.offered(LINE + ' xpresets=1-32'), 0);
eq('out of range: none', P.offered(LINE + ' presets=1-256'), 0);
eq('no answer: none', P.offered(undefined), 0);

const cfg = { ptz: { presets: [{ number: 5, name: 'Gate' }, { number: 2, name: '' }, { number: 40, name: 'Far' }, { number: 5, name: 'dup' }] } };
eq('listed by number, Home first, unnamed called by number, past the range dropped, duplicates once',
	P.list(cfg, 32), [{ number: 1, name: 'Home' }, { number: 2, name: 'Preset 2' }, { number: 5, name: 'Gate' }]);
eq('a named Home keeps its role in the name', P.list({ ptz: { presets: [{ number: 1, name: 'Drive' }] } }, 32),
	[{ number: 1, name: 'Home: Drive' }]);
eq('no rows: Home alone', P.list({}, 32), [{ number: 1, name: 'Home' }]);

eq('a new preset takes the lowest free number from 2', P.freeNumber(cfg, 32), 3);
eq('never 1', P.freeNumber({ ptz: { presets: [] } }, 32), 2);
eq('none free: 0', P.freeNumber({ ptz: { presets: [{ number: 2 }, { number: 3 }] } }, 3), 0);

eq('go', P.query('go', 5), '/ptz?preset=5&action=go');
eq('set with a name, encoded', P.query('set', 7, ' Gate & yard '), '/ptz?preset=7&action=set&name=Gate%20%26%20yard');
eq('set without a name keeps the camera\'s', P.query('set', 7, ''), '/ptz?preset=7&action=set');
eq('clear', P.query('clear', 7), '/ptz?preset=7&action=clear');

done();
