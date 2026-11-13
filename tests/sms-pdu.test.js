// SMS PDUs and USSD replies, decoded and encoded.
//
// Every failure here is silent: a wrongly unpacked septet is a plausible
// letter, a part joined in arrival order is a readable paragraph in the wrong
// order, and a USSD reply decoded as the wrong alphabet is a line of hex the
// page shows as if the operator had sent it. Reaching any of them on demand
// takes a SIM, an operator who sends that encoding, and a modem that prints it
// that way.
//
// The UCS2 fixtures are captured from an EC200A on T2 (Russia), the operator
// whose notices this page was first written to read. The subscriber's number
// inside them is replaced with a made-up one of the same length.
'use strict';

const path = require('path');
const { check, group, done } = require('./assert');

const S = require(path.join(__dirname, '..', 'www', 'a', 'sms-pdu.js'));

// A transcript as j/sms.cgi returns it, storage selection included.
const T2 = [
	'=> AT+CMGF=0', 'OK',
	'=> AT+CPMS="SM"', '+CPMS: 0,10,0,10,0,10', 'OK',
	'=> AT+CMGL=4', 'OK',
	'=> AT+CPMS="ME"', '+CPMS: 7,180,7,180,7,180', 'OK',
	'=> AT+CMGL=4',
	'+CMGL: 8,1,,62',
	'07919740430901F40409D074994B5E070008620150510023212C0412043D043504410435043D0430002004410443043C043C043000200034003500300020044004430431002E',
	'+CMGL: 9,1,,136',
	'07919740430901F44409D074994B5E0700086201504165722176050003F70202043E04360435043D04380438002004310430043D043A04300020043D043000200034003500300020044004430431002E0020043800200441043E0432043504400448043804420435002004370432043E043D043E043A0020043D04300020043D043E043C043504400020003600310030',
	'+CMGL: 10,1,,156',
	'07919740430901F44409D074994B5E070008620150416572218A050003F702010414043B044F00200430043A0442043804320430044604380438002000530049004D002D043A043004400442044B0020043F043E043F043E043B043D043804420435002004310430043B0430043D04410020043D043E043C043504400430002000370039003900390030003000300031003100320032002004320020043F04400438043B',
	'+CMGL: 13,0,,70',
	'07919740430901F44409D074994B5E0700086201507132232134050003D504040442043D0430044F0020043F04350440043504300434044004350441043004460438044F00200053004D0053002E',
	'+CMGL: 14,1,,156',
	'07919740430901F44409D074994B5E070008620150713223218A050003D5040127640020041F043E04370434044004300432043B044F0435043C002004410020043F043E0434043A043B044E04470435043D04380435043C0020043A00200054003200210020000A27050020041204300448002004420430044004380444003A002000220418043D044204350440043D0435044200200434043B044F0020043A0430043C',
	'+CMGL: 15,1,,156',
	'07919740430901F44409D074994B5E070008620150713223218A050003D50402043504400022002E000AD83DDCDE0020041D043E043C043504400020003700390039003900300030003000310031003200320020043E044104420430043504420441044F00200432043004480438043C0020043D0430043204410435043304340430002E000A0412002004420430044004380444002004320445043E043404380442003A',
	'+CMGL: 16,1,,156',
	'07919740430901F44409D074994B5E070008620150713223218A050003D50403000AD83CDF100020043F0430043A0435044200200413041100200434043B044F002004380441043F043E043B044C0437043E04320430043D0438044F002004320020043F04400438043B043E04360435043D04380438002000220423043C043D044B043900200434043E043C00220020002C000A27090020043104350441043F043B0430',
	'OK',
];

group('one UCS2 message, alphanumeric sender');
{
	const m = S.decodePdu(T2[T2.indexOf('+CMGL: 8,1,,62') + 1]);
	check('sender is the full alphanumeric name', m.addr === 't2.ru', m.addr);
	check('text', m.text === 'Внесена сумма 450 руб.', m.text);
	check('time carries the zone (+12 quarters)', m.time === '2026-10-05T15:00:32+03:00', m.time);
	check('not a part', m.total === undefined);
}

group('the transcript: storages and parts');
{
	const list = S.parseList(T2);
	check('seven PDUs listed', list.length === 7, list.length);
	check('each knows its storage', list.every(m => m.loc.mem === 'ME'));
	check('index from +CMGL', list[0].loc.idx === 8);
	check('unread status', list.find(m => m.loc.idx === 13).stat === 'unread');
}

group('joining: out of order, emoji across a part boundary');
{
	const msgs = S.joinParts(S.parseList(T2));
	check('three messages', msgs.length === 3, msgs.length);
	const welcome = msgs.find(m => m.ref === 0xD5);
	check('four parts kept for deleting', welcome.parts.map(p => p.idx).sort().join() === '13,14,15,16');
	check('nothing missing', welcome.missing === 0);
	check('parts in sequence, not arrival order',
		welcome.text.startsWith('❤ Поздравляем') && welcome.text.endsWith('переадресация SMS.'), welcome.text);
	check('surrogate pairs survive', welcome.text.includes('📞') && welcome.text.includes('🌐'));
	check('a part unread makes the message unread', welcome.stat === 'unread');
	check('newest first', msgs[0] === welcome);
	const two = msgs.find(m => m.ref === 0xF7);
	check('two-part message joined', two.text === 'Для активации SIM-карты пополните баланс номера 79990001122 в приложении банка на 450 руб. и совершите звонок на номер 610', two.text);
}

group('joining: a part that never arrived');
{
	const parsed = S.parseList(T2).filter(m => m.loc.idx !== 15);
	const welcome = S.joinParts(parsed).find(m => m.ref === 0xD5);
	check('gap is counted', welcome.missing === 1);
	check('gap is visible in the text', welcome.text.includes('[…]'));
}

group('joining: a part delivered twice');
{
	const lines = T2.concat(['+CMGL: 20,1,,70', T2[T2.indexOf('+CMGL: 13,0,,70') + 1]]);
	const welcome = S.joinParts(S.parseList(lines)).find(m => m.ref === 0xD5);
	check('text not doubled', welcome.text.split('переадресация').length === 2);
	check('both copies are deleted with it', welcome.parts.some(p => p.idx === 20) && welcome.parts.length === 5);
}

group('GSM 7-bit');
{
	check('alphabet is 128 septets', S.GSM7.length === 128);
	// 23.038's own example: "hellohello" packs to these nine octets.
	const packed = S.pack7('hellohello'.split('').map(c => S.GSM7.indexOf(c)));
	check('packs to the spec vector',
		Buffer.from(packed).toString('hex').toUpperCase() === 'E8329BFD4697D9EC37');
	const sub = S.encodeSubmit('+15550100', 'Price: 5€ [ok]', 7);
	const back = S.decodePdu(sub[0].pdu);
	check('extension table round-trips', back.text === 'Price: 5€ [ok]', back.text);
	check('international number', back.addr === '+15550100', back.addr);
	check('one part', sub.length === 1);
	check('length excludes the SMSC octet', sub[0].len * 2 + 2 === sub[0].pdu.length);
}

group('sending: split, then read back');
{
	const long = 'a'.repeat(200) + '€';
	const subs = S.encodeSubmit('5550100', long, 0x42);
	check('two parts of GSM 7-bit', subs.length === 2, subs.length);
	const msgs = S.joinParts(subs.map((s, i) => Object.assign(S.decodePdu(s.pdu), { loc: { mem: 'ME', idx: i } })));
	check('joined back whole', msgs.length === 1 && msgs[0].text === long, msgs[0] && msgs[0].text.length);
	check('national number stays national', msgs[0].addr === '5550100', msgs[0].addr);

	const ru = 'Привет '.repeat(15);
	const usub = S.encodeSubmit('+79990001122', ru, 9);
	check('Cyrillic goes UCS2, two parts', usub.length === 2 && S.measure(ru).encoding === 'ucs2');
	const ub = S.joinParts(usub.map((s, i) => Object.assign(S.decodePdu(s.pdu), { loc: { mem: 'ME', idx: i } })));
	check('UCS2 joined back whole', ub[0].text === ru);

	const emoji = 'x'.repeat(66) + '📞' + 'y';
	const es = S.encodeSubmit('+15550100', emoji, 1).map(s => S.decodePdu(s.pdu));
	check('a surrogate pair is not split across parts', es.every(p => !/[\uD800-\uDBFF]$/.test(p.text)));

	let threw = '';
	try { S.encodeSubmit('call me', 'x'); } catch (e) { threw = e.message; }
	check('a non-number is refused', threw === 'bad number');
	try { S.encodeSubmit('+15550100', 'x'.repeat(153 * 10 + 1)); } catch (e) { threw = e.message; }
	check('more than ten parts is refused', threw === 'too long');
}

group('USSD');
{
	const t2 = '+CUSD: 2,"04110430043b0430043d0441003a00200030002e003000300020007004430431002e0020041f04400438044f0442043d043e0433043e0020043e043104490435043d0438044f00200441002000540032002e",17';
	const u = S.parseUssd(['=> AT+CUSD=1,"*105#",15', 'OK', t2]);
	check('T2 UCS2 (DCS 17)', u.text === 'Баланс: 0.00 pуб. Приятного общения с T2.', u.text);
	check('status', u.status === 2);
	check('DCS 72 is UCS2 too', S.decodeUssd('0042', 72) === 'B');
	check('GSM text as text', S.decodeUssd('Balance 10.00 EUR', 15) === 'Balance 10.00 EUR');
	check('packed septets in hex', S.decodeUssd('E8329BFD4697D9EC37', 15) === 'hellohello', S.decodeUssd('E8329BFD4697D9EC37', 15));
	check('a modem left in UCS2 mode', S.decodeUssd('00420061006C0061006E00630065', 15) === 'Balance');
	check('digits are not mistaken for hex', S.decodeUssd('100', 15) === '100');
	check('menu status', S.parseUssd(['+CUSD: 1,"1>Balance",15']).status === 1);
	check('no reply', S.parseUssd(['OK']) === null);
	check('codes: digits * # only', S.validUssd('*105#') && !S.validUssd('*105#;AT') && !S.validUssd(''));
}

group('what cannot be read');
{
	check('not hex', S.decodePdu('hello') === null);
	check('truncated', S.decodePdu('0791') === null || S.decodePdu('0791').text !== undefined);
	const list = S.parseList(['=> AT+CPMS="SM"', '+CMGL: 0,1,,10', 'ZZ']);
	check('an unreadable PDU is listed, not dropped', list.length === 1 && list[0].unreadable);
	check('and can still be deleted', S.joinParts(list)[0].parts[0].mem === 'SM');
}

done();
