// An IPv4 address as four boxes (www/a/ip-octets.js).
//
// What fails silently: the four boxes are not what is posted, the hidden text
// field behind them is, and join() is the only thing that writes it. A join
// that left a gap ("192.168..10"), kept a leading zero some parser reads as
// octal, or turned an untouched empty field into "..." would be saved, applied
// by the network page and found only when the camera went somewhere else
// (#695).
const { check, done } = require('./assert.js');
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got));
const O = require('../www/a/ip-octets.js');

eq('an address splits into its four parts', O.split('192.168.1.10'), ['192', '168', '1', '10']);
eq('spaces round it are not part of it', O.split(' 10.0.0.1 '), ['10', '0', '0', '1']);
eq('an empty field is four empty parts', O.split(''), ['', '', '', '']);
eq('nothing at all is an empty field', O.split(undefined), ['', '', '', '']);
eq('an IPv6 resolver is not four parts', O.split('2001:db8::1'), null);
eq('three parts are not an address', O.split('10.0.1'), null);
eq('a name is not an address', O.split('router.lan'), null);

eq('the parts join back', O.join(['192', '168', '1', '10']), '192.168.1.10');
eq('four empty parts are an empty field, not dots', O.join(['', '', '', '']), '');
eq('a leading zero is dropped, never read as octal', O.join(['010', '000', '01', '9']), '10.0.1.9');
eq('a part left empty stays visible as a gap', O.join(['10', '', '0', '1']), '10..0.1');

eq('a whole address has no problem', O.problem(['10', '0', '0', '1']), '');
eq('an empty field has no problem', O.problem(['', '', '', '']), '');
eq('a part left empty is one', O.problem(['10', '', '0', '1']), 'Fill in all four parts of the address.');
eq('a part over 255 is one', O.problem(['10', '0', '256', '1']), 'Each part of an address is a number from 0 to 255.');

eq('three digits move on', O.next('192'), true);
eq('a number one more digit would take past 255 moves on', O.next('26'), true);
eq('one that could still grow does not', O.next('25'), false);
eq('a single digit does not', O.next('1'), false);
eq('a number over 255 keeps the caret where the fault is', O.next('300'), false);
eq('nothing does not', O.next(''), false);

done();
