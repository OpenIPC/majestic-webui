// The pad's move speed (www/a/ptz-speed.js).
//
// Four ways to get this wrong, and all fail silently. Showing the control for a
// lens that ignores it gives the operator a slider that does nothing. Sending
// speed= where it does not belong changes no move on the camera, but turns a
// zoom or focus request into one carrying a parameter it never had. And
// mistaking the serial lenses' "speed=<baud>" for this token would show the
// slider on every Pelco camera. And leaving the top rate out of the query
// hands the move to the motor's own rate, which a Pelco-D dome took as its
// slowest.
const { check, done } = require('./assert.js');
const eq = (name, got, want) => check(name, got === want, 'got ' + JSON.stringify(got));
const S = require('../www/a/ptz-speed.js');

eq('a gpiostep head offers speeds',
	S.offered('actuator=gpiostep pulse=500 state=ready verbs=stop,up,down,left,right speeds=1-100'), true);
eq('a serial lens line is not an offer (speed= is its baud)',
	S.offered('actuator=pelco-xm port=/dev/ttyAMA0 speed=115200 pulse=500 state=ready verbs=stop,near,far,tele,wide'), false);
eq('an older plugin offers none',
	S.offered('actuator=gpiostep pulse=500 state=ready verbs=stop,up,down,left,right'), false);
eq('no answer offers none', S.offered(undefined), false);
eq('an empty answer offers none', S.offered(''), false);

// Left out, a move runs at the motor's own rate, which on a Pelco-D dome was
// the speed byte 0: the stick's rim barely moved one (#691).
eq('full speed is said, not left out', S.query('left', 100), '&speed=100');
eq('past the top is the top', S.query('right', 140), '&speed=100');
eq('a slower pan sends its speed', S.query('left', 40), '&speed=40');
eq('tilt too', S.query('down', 10), '&speed=10');
eq('a diagonal too', S.query('upleft', 50), '&speed=50');
eq('rounded to a whole percent', S.query('up', 33.6), '&speed=34');
eq('never below 1', S.query('right', 0), '&speed=1');
eq('zoom carries no speed', S.query('tele', 40), '');
eq('focus carries no speed', S.query('near', 40), '');
eq('stop carries no speed', S.query('stop', 40), '');
eq('a value that is not a number sends nothing', S.query('left', 'fast'), '');

done();
