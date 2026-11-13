// Which OSD template codes the camera reads (www/a/mj-osd-codes.js).
//
// A wrong verdict is silent either way. Pass a code the camera does not know
// and an older camera cuts the line there, a newer one prints the code on
// the picture; flag a code it does know and an owner deletes a working
// overlay. The schemas are the hints two firmwares declare: one with the
// %{...} readings, one from before them.
'use strict';

const fs = require('fs');
const path = require('path');
const { check, group, done } = require('./assert');

const C = require(path.join(__dirname, '..', 'www', 'a', 'mj-osd-codes.js'));

const HISI = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'schema-hisi.json'), 'utf8'));
function templateSchema(o) {
	if (!o || typeof o !== 'object') return null;
	if (o.template && typeof o.template === 'object' && 'hint' in o.template) return o.template;
	for (const k of Object.keys(o)) {
		const r = templateSchema(o[k]);
		if (r) return r;
	}
	return null;
}
const NEW = C.dialect(templateSchema(HISI));
const OLD = C.dialect({ hint: 'strftime date/time format, e.g. %d.%m.%Y %H:%M:%S. Extras: %f milliseconds, %@ lens zoom magnification (e.g. x3.2).' });
// the firmware before outside values: %{temp} and the readings, no more
const TEMP_ERA = C.dialect({ hint: 'strftime, e.g. %d.%m.%Y %H:%M:%S, plus readings: %{temp}, %{ms}, %{exposure}, %{zoom}, %{meter:name}, %{drums:name}.' });
const METER = C.dialect({ hint: 'strftime, e.g. %d.%m.%Y %H:%M:%S. Extras: %f ms, %@ zoom, %{meter:name} a meter\'s reading.' });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

group('the camera says which spelling it reads');
check('the fixture camera reads %{...}', NEW.tokens && NEW.meter);
check('an older camera reads letters', !OLD.tokens && !OLD.meter);
check('one with meters but no other tokens', !METER.tokens && METER.meter);
check('no schema at all is the older camera', !C.dialect(undefined).tokens);
check('the names come from the camera, hint and help together',
	['temp', 'ms', 'exposure', 'zoom', 'meter', 'drums', 'hostname', 'ip', 'uptime', 'file', 'text']
		.every(n => NEW.names.indexOf(n) >= 0));

group('a camera with the tokens');
check('the clock and every reading pass',
	same(C.unknownCodes('%d.%m.%Y %H:%M:%S.%{ms} %{temp} %{temp:F} %{exposure} %{zoom} %{meter} %{meter:power} %{drums:gas}', NEW), []));
check('a %% is text, so a token after it is not checked', same(C.unknownCodes('100%%{bogus}', NEW), []));
check('the retired letters are named', same(C.unknownCodes('%f %@ %$', NEW), ['%f', '%@', '%$']));
check('an unknown token and letter are named', same(C.unknownCodes('%{tmp} %q', NEW), ['%{tmp}', '%q']));
check('an unclosed token is named', same(C.unknownCodes('%{temp', NEW), ['%{']));
check('flags on a known letter pass', same(C.unknownCodes('%-d %_H %0M %4Y %Ey', NEW), []));
check('an unknown letter is named as typed', same(C.unknownCodes('%5q %-q %Eq', NEW), ['%5q', '%-q', '%Eq']));
check('it says the camera prints the code', /prints it as written/.test(C.unknownEffect(NEW)));
check('and the codes, for more than one', /prints them as written/.test(C.unknownEffect(NEW, true)));

check('outside values and system readings pass',
	same(C.unknownCodes('%{hostname} %{ip} up %{uptime} T=%{file:/tmp/osd/t} W=%{text:scale}', NEW), []));

group('a camera with %{temp} but not outside values');
check('its readings pass', same(C.unknownCodes('%{temp} %{ms} %{zoom}', TEMP_ERA), []));
check('the newer tokens are named', same(C.unknownCodes('%{hostname} %{file:/x}', TEMP_ERA),
	['%{hostname}', '%{file:/x}']));

group('a camera from before them');
check('its letters pass', same(C.unknownCodes('%H:%M:%S.%f %@ %$', OLD), []));
check('the tokens are named', same(C.unknownCodes('%{temp} %{meter}', OLD), ['%{temp}', '%{meter}']));
check('%{meter} passes where the camera has it', same(C.unknownCodes('%{meter} %{temp}', METER), ['%{temp}']));
check('it says the line is cut', /disappears/.test(C.unknownEffect(OLD)));

group('the template as pieces');
const KNOWN = [
	{ id: 'time', fmt: '%H:%M' }, { id: 'time', fmt: '%H:%M:%S' },
	{ id: 'temp', fmt: '%{temp}' }, { id: 'temp', fmt: '%{temp:F}' }, { id: 'gap', fmt: ' ' }, { id: 'gap', fmt: '   ' },
];
check('the longest format wins', same(C.parse('%H:%M:%S', KNOWN), [{ id: 'time', fmt: '%H:%M:%S' }]));
check('a reading is a piece', same(C.parse('CPU %{temp:F}', KNOWN),
	[{ id: 'text', text: 'CPU' }, { id: 'gap', fmt: ' ' }, { id: 'temp', fmt: '%{temp:F}' }]));
check('an escaped reading is words, not a piece', same(C.parse('100%%{temp}', KNOWN),
	[{ id: 'text', text: '100%%{temp}' }]));
check('a run of spaces is a gap', same(C.parse('%H:%M   %{temp}', KNOWN),
	[{ id: 'time', fmt: '%H:%M' }, { id: 'gap', fmt: '   ' }, { id: 'temp', fmt: '%{temp}' }]));

done();
