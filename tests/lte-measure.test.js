// How the cellular modem is graded and described (www/a/main.js MJ_LTE_SCALE,
// mjLteGrade, mjLteState), read from the gauges majestic publishes.
//
// This earns a file because each failure is silent and needs a modem, a SIM
// and a cell to reach. The fixture is the state actually met in the field on an
// EC200A: registered on band 7, the network's bearer holding an address, and
// usb0 carrying nothing because that bearer was never connected to it. Every
// one of those facts reached the camera's AT port and none reached a page.
//
// What must hold:
//   * "registered" and "data on usb0" are different sentences, and the one
//     for a registered modem with no data session says so in red — the
//     confident green "On t2" for that state is exactly the lie to prevent;
//   * the grade weighs SINR as well as RSRP: -100 dBm under SINR -5 dB is not
//     "fair", it is weak, and it says interference rather than coverage;
//   * a reading the modem did not give is not graded at all, and a modem that
//     has stopped answering is reported as such rather than as a silence;
//   * modem_info's labels survive parseMetrics, quoting included.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const MAIN = fs.readFileSync(
	path.join(__dirname, '..', 'www', 'a', 'main.js'), 'utf8');
function lift(re, what) {
	const m = MAIN.match(re);
	if (!m) {
		console.log('  FAIL could not find ' + what + ' in www/a/main.js');
		process.exit(1);
	}
	return m[0];
}
const src = lift(/\nconst MJ_LTE_SCALE = \{[\s\S]*?\n\};\n/, 'MJ_LTE_SCALE') +
	lift(/\nfunction mjLteGrade\(v\) \{[\s\S]*?\n\}\n/, 'mjLteGrade()') +
	lift(/\nfunction mjLteState\(v, info\) \{[\s\S]*?\n\}\n/, 'mjLteState()') +
	lift(/\nfunction parseMetrics\(text\) \{[\s\S]*?\n\}\n/, 'parseMetrics()');
const L = vm.runInNewContext('(function(){' + src +
	'return {S: MJ_LTE_SCALE, grade: mjLteGrade, state: mjLteState, parse: parseMetrics}})()',
	{ Object: Object, isNaN: isNaN, Math: Math });

const m = L.parse(fs.readFileSync(
	path.join(__dirname, 'fixtures', 'metrics-modem-ec200a.txt'), 'utf8'));
const v = m.v, info = m.info.modem_info;

group('modem_info labels come through parseMetrics', () => {
	check('the family is kept', !!info);
	check('model', info.model === 'EC200A');
	check('operator', info.operator === 't2');
	check('bearer address', info.bearer_ip === '10.54.165.165');
	check('usb0 bytes still count towards the Network chart', m.rx === 18234 && m.tx === 9120);
	const q = L.parse('modem_info{operator="Tele \\"2\\" \\\\ RU"} 1\n');
	check('escaped quotes and backslashes are undone', q.info.modem_info.operator === 'Tele "2" \\ RU');
});

group('a registered modem with no data session says so', () => {
	const st = L.state(v, info);
	check('it is a warning, not a success', st[1] === 'text-danger');
	check('it names the operator and band', /On t2 · LTE band 7/.test(st[0]));
	check('it says usb0 has no session', /no data session on usb0/.test(st[0]));
	check('it says the network did give an address', /10\.54\.165\.165/.test(st[0]));
	const ok = Object.assign({}, v, { modem_data_connected: 1 });
	const st2 = L.state(ok, info);
	check('connected reads as data on usb0', st2[1] === 'text-success' && /data on usb0$/.test(st2[0]));
});

group('the grade weighs interference as well as signal', () => {
	const g = L.grade(v);
	check('-100 dBm under SINR -5 is weak', g[0].startsWith('weak') && g[2] === 2);
	check('and it says why', /interference \(SINR -5 dB\)/.test(g[0]));
	const clean = Object.assign({}, v, { modem_sinr_db: 20 });
	check('the same RSRP with a clean channel is fair', L.grade(clean)[0] === 'fair');
	const strong = Object.assign({}, v, { modem_rsrp_dbm: -80, modem_sinr_db: 20 });
	check('a strong clean cell is good', L.grade(strong)[0] === 'good');
	const far = { modem_rsrp_dbm: -115 };
	check('far from the cell is weak coverage', /coverage/.test(L.grade(far)[0]));
	check('no RSRP grades nothing', L.grade({ modem_sinr_db: 3 }) === null);
	check('the bands span the grade edges',
		L.S.lo < L.S.fair && L.S.fair < L.S.good && L.S.good < L.S.hi);
});

group('absent, searching and silent modems', () => {
	check('no modem gauges: no sentence', L.state({}, undefined) === null);
	const silent = L.state({ modem_reading_age_seconds: 130 }, undefined);
	check('a modem that stopped answering says for how long',
		silent && /not answered for 130 s/.test(silent[0]));
	const searching = L.state({ modem_reading_age_seconds: 3, modem_registered: 0 },
		{ state: 'SEARCH', sim: 'READY' });
	check('not registered is red and says it is searching',
		searching[1] === 'text-danger' && /searching for a cell/.test(searching[0]));
	const nosim = L.state({ modem_reading_age_seconds: 3, modem_registered: 0 },
		{ sim: 'SIM PIN' });
	check('a locked SIM is named before registration', /SIM: sim pin/.test(nosim[0]));
});

done();
