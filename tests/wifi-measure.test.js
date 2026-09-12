// Which reading the Dashboard's Wi-Fi panel plots, and how it grades it.
//
// This earns a file because the failure is silent and needs hardware to
// reach. A chart fed from a metric the camera never publishes is not an error
// and not a gap: it is a panel that mounts, captions itself, fills in its fact
// line from the readings that DID arrive, and draws no line at all — which
// looks exactly like a camera with nothing to say. That is issue #435,
// reported from a camera whose Wi-Fi module publishes link quality and no
// signal level, and invisible to anyone whose module publishes both.
//
// Reproducing it needs a second Wi-Fi module with a different driver, an
// association to hold still, and somebody watching a plot for long enough to
// believe the line is never coming. The two fixtures are those two adapters
// held still: one that reports a level and one that reports only quality.
//
// What must hold:
//   * a camera with a level plots the level, one without plots the quality,
//     and one with neither is told so rather than shown an empty box;
//   * the choice upgrades to the level whenever one appears and never goes
//     back, so a link caught mid-association does not park the page on the
//     wrong measure for good;
//   * the grade words and the plot's bands are the same judgement — they are
//     read from one table here, and a second copy is how they would drift;
//   * a tile showing a level grades nothing while that level is missing,
//     rather than quietly grading the percentage under a dBm caption.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

// The three pieces live inside dashboard.js's IIFE. Rather than execute that
// whole file against a stub DOM, lift them out of the source and run them —
// so the test still breaks if the shipped file's judgement changes.
const SRC = fs.readFileSync(
	path.join(__dirname, '..', 'www', 'a', 'dashboard.js'), 'utf8');
function lift(re, what) {
	const m = SRC.match(re);
	if (!m) {
		console.log('  FAIL could not find ' + what + ' in www/a/dashboard.js');
		process.exit(1);
	}
	return m[0];
}
const src = lift(/\n\tconst WIFI_SCALE = \{[\s\S]*?\n\t\};\n/, 'WIFI_SCALE') +
	lift(/\n\tfunction wifiMeasure\(v, cur\) \{[\s\S]*?\n\t\}\n/, 'wifiMeasure()') +
	lift(/\n\tfunction wifiGrade\(v, unit\) \{[\s\S]*?\n\t\}\n/, 'wifiGrade()');
const lifted = vm.runInNewContext(
	'(function(){' + src +
	'return {S: WIFI_SCALE, measure: wifiMeasure, grade: wifiGrade}})()', {});
const S = lifted.S, measure = lifted.measure, grade = lifted.grade;

// The parser is main.js's; reuse it so the fixtures are read exactly as the
// browser reads them.
const MAIN = fs.readFileSync(
	path.join(__dirname, '..', 'www', 'a', 'main.js'), 'utf8');
const pm = MAIN.match(/\nfunction parseMetrics\(text\) \{[\s\S]*?\n\}\n/);
const parseMetrics = vm.runInNewContext(
	'(function(){' + pm[0] + 'return parseMetrics})()',
	{ Object: Object, isNaN: isNaN });

function fixture(name) {
	return parseMetrics(fs.readFileSync(
		path.join(__dirname, 'fixtures', name), 'utf8')).v;
}
const NO_LEVEL = fixture('metrics-wifi-8189fs.txt');   // as reported in #435
const LEVEL = fixture('metrics-wifi-with-level.txt'); // synthetic counterpart


// check() asks whether a condition holds and prints the third argument only
// when it does not, so every comparison below says what it actually got.
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const saw = (x) => 'got ' + JSON.stringify(x);

group('the fixtures are the two adapters they claim to be');
check('the reported adapter publishes no level',
	!('wifi_rssi_dbm' in NO_LEVEL),
	saw(NO_LEVEL.wifi_rssi_dbm));
check('it does publish a quality',
	NO_LEVEL.wifi_link_quality_ratio === 70,
	saw(NO_LEVEL.wifi_link_quality_ratio));
check('the counterpart publishes a level',
	LEVEL.wifi_rssi_dbm === -54, saw(LEVEL.wifi_rssi_dbm));
// Both report a bitrate and both counters, so the fact line under the plot
// fills in identically on the two — which is exactly why the empty plot read
// as a puzzle rather than as a missing reading.
check('both report a bitrate and both counters',
	['wifi_bitrate_mbps', 'wifi_retries_total', 'wifi_missed_beacons_total']
		.every(k => k in NO_LEVEL && k in LEVEL),
	'the two fact lines are meant to be indistinguishable');

group('the measure is chosen from what the camera actually publishes');
check('a level is plotted where there is one',
	measure(LEVEL, null) === 'dbm', saw(measure(LEVEL, null)));
check('quality is plotted where there is not',
	measure(NO_LEVEL, null) === 'pct', saw(measure(NO_LEVEL, null)));
check('neither reading means no plot at all',
	measure({ wifi_bitrate_mbps: 72.2 }, null) === null,
	saw(measure({ wifi_bitrate_mbps: 72.2 }, null)));

group('the choice upgrades to a level and never goes back');
// A level missing for one poll is the link re-associating, not a camera that
// has none: parking on percent for the life of the page is the bug this guards.
check('a level arriving later takes over from quality',
	measure(LEVEL, 'pct') === 'dbm', saw(measure(LEVEL, 'pct')));
check('a level missing for a poll does not give the choice back',
	measure(NO_LEVEL, 'dbm') === 'dbm', saw(measure(NO_LEVEL, 'dbm')));
check('a quality arriving after nothing takes the empty slot',
	measure(NO_LEVEL, null) === 'pct', saw(measure(NO_LEVEL, null)));
check('a level arriving after nothing takes it too',
	measure(LEVEL, null) === 'dbm', saw(measure(LEVEL, null)));
// undefined is the real first call — nothing decided yet — and null is the
// settled "this adapter publishes neither". Both must fall through to the
// quality test, or an adapter that starts out reporting only a bitrate would
// never pick up a quality that arrives a poll later.
check('nothing decided yet reads the camera fresh',
	measure(NO_LEVEL, undefined) === 'pct' && measure(LEVEL, undefined) === 'dbm',
	saw([measure(NO_LEVEL, undefined), measure(LEVEL, undefined)]));
check('settled on neither still lets a quality arrive later',
	measure(NO_LEVEL, null) === 'pct', saw(measure(NO_LEVEL, null)));

group('the grade words and the plot bands are one judgement');
// Each scale's grade edges must lie inside its own plot, or a band is drawn
// off the end of the axis and a reading can be graded in a colour the picture
// never shows. The bands are built from exactly these four numbers.
Object.keys(S).forEach(u => {
	const sc = S[u];
	check(u + ': the plot runs low to high', sc.lo < sc.hi,
		saw([sc.lo, sc.hi]));
	check(u + ': both grade edges are inside the plot, in order',
		sc.lo < sc.fair && sc.fair < sc.good && sc.good < sc.hi,
		saw([sc.lo, sc.fair, sc.good, sc.hi]));
	check(u + ': the grade reads the key the plot reads',
		typeof sc.key === 'string' && sc.key.length > 0, saw(sc.key));
	check(u + ': the tile carries a caption and a unit',
		!!sc.cap && !!sc.unit, saw([sc.cap, sc.unit]));
});
// The edges themselves, pinned: -60/-75 dBm and 70/40 % are the numbers this
// panel has always graded on.
check('the level grades at -60 and -75 dBm',
	eq([S.dbm.good, S.dbm.fair], [-60, -75]),
	saw([S.dbm.good, S.dbm.fair]));
check('the quality grades at 70 and 40 %',
	eq([S.pct.good, S.pct.fair], [70, 40]),
	saw([S.pct.good, S.pct.fair]));
check('the two measures are read from different keys',
	S.dbm.key !== S.pct.key, saw([S.dbm.key, S.pct.key]));

group('a reading is graded on the measure being shown');
const g = (v, u) => { const r = grade(v, u); return r && r[0]; };
check('the reported adapter reads good on quality',
	g(NO_LEVEL, 'pct') === 'good', saw(g(NO_LEVEL, 'pct')));
check('the counterpart reads good on its level',
	g(LEVEL, 'dbm') === 'good', saw(g(LEVEL, 'dbm')));
check('a weak level is named and answered',
	g({ wifi_rssi_dbm: -80 }, 'dbm') === 'weak — move the camera or the AP',
	saw(g({ wifi_rssi_dbm: -80 }, 'dbm')));
check('a weak quality gets the same sentence',
	g({ wifi_link_quality_ratio: 20 }, 'pct') === 'weak — move the camera or the AP',
	saw(g({ wifi_link_quality_ratio: 20 }, 'pct')));
check('a fair quality is fair',
	g({ wifi_link_quality_ratio: 55 }, 'pct') === 'fair',
	saw(g({ wifi_link_quality_ratio: 55 }, 'pct')));
// The tile says dBm; grading the percentage under it would put a word on
// screen that describes a number the tile is not showing.
check('a missing level grades nothing rather than grading the percentage',
	grade(NO_LEVEL, 'dbm') === null, saw(grade(NO_LEVEL, 'dbm')));
check('no measure at all grades nothing',
	grade({ wifi_bitrate_mbps: 72.2 }, null) === null,
	saw(grade({ wifi_bitrate_mbps: 72.2 }, null)));
// The boundary belongs to the better grade on both scales.
check('the edges themselves are the better grade',
	eq([g({ wifi_rssi_dbm: -60 }, 'dbm'), g({ wifi_rssi_dbm: -75 }, 'dbm'),
		g({ wifi_link_quality_ratio: 70 }, 'pct'),
		g({ wifi_link_quality_ratio: 40 }, 'pct')],
	['good', 'fair', 'good', 'fair']),
	saw([g({ wifi_rssi_dbm: -60 }, 'dbm'), g({ wifi_rssi_dbm: -75 }, 'dbm'),
		g({ wifi_link_quality_ratio: 70 }, 'pct'),
		g({ wifi_link_quality_ratio: 40 }, 'pct')]));
// A quality of 0 is a real reading — the link is there and carrying nothing —
// and must not fall through the `in` test the way an absent key does.
check('a quality of zero is a reading, not an absence',
	measure({ wifi_link_quality_ratio: 0 }, null) === 'pct' &&
	g({ wifi_link_quality_ratio: 0 }, 'pct') === 'weak — move the camera or the AP',
	saw([measure({ wifi_link_quality_ratio: 0 }, null),
		g({ wifi_link_quality_ratio: 0 }, 'pct')]));

done();
