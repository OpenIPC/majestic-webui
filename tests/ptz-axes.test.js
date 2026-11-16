// mj_ptz_axes (p/majestic.sh): the axes a lens majestic drives lists on its
// capability line, the ptz_caps default for every majestic backend. Runs the
// real helper under sh, since the pad and j/ptz.cgi's whitelist both rest on
// what it prints.
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const { check, group, done } = require('./assert');

const MJ = path.join(__dirname, '..', 'www/cgi-bin/p/majestic.sh');
const axes = (line) => execFileSync('sh', ['-c', '. "$1"; mj_ptz_axes "$2"', 'sh', MJ, line]).toString();

group('mj_ptz_axes');

const is = (name, line, want) => {
	const got = axes(line);
	check(name, got === want, 'got "' + got + '", want "' + want + '"');
};

// The N51813L's VISCA block alone: zoom and focus, no pan or tilt buttons.
is('a visca lens without a head',
	'actuator=visca port=/dev/ttyAMA0 speed=9600 addr=1 pulse=500 state=ready verbs=stop,near,far,tele,wide',
	'zoom focus');
// The same block with a Pelco-D head beside it (ptz.head): all four.
is('a visca lens with a head',
	'actuator=visca port=/dev/ttyAMA0 speed=9600 addr=1 pulse=500 state=ready ' +
	'verbs=stop,near,far,tele,wide,up,down,left,right,upleft,upright,downleft,downright ' +
	'speeds=1-100 presets=1-32 head=pelco-d headstate=ready headport=tcp://10.0.0.2:4001 headaddr=1',
	'pan tilt zoom focus');
is('a gpiostep head',
	'actuator=gpiostep pulse=500 state=ready verbs=stop,up,down,left,right speeds=1-100 steps=1',
	'pan tilt');
// Neither a token outside verbs= nor a longer word that starts with a verb counts.
is('only whole verbs inside verbs=', 'actuator=x headport=left verbs=stop,telex', '');
is('no verbs at all', 'actuator=x state=closed', '');
is('nothing', '', '');

done();
