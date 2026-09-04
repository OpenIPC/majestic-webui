// parseMetrics (www/a/main.js) — the one reader of majestic's /metrics text
// that every page's topbar and the whole status dashboard now sit on.
//
// This exists because the parser's failure modes are silent and vendor-shaped:
// a kernel too old for MemAvailable reads as a camera at 100% memory (issue
// #116), and majestic on Ingenic emits isp_exptime twice, where picking the
// wrong occurrence changes the value shown before and after the daemon-side
// fix. The fixtures are real /metrics dumps from one camera per vendor family
// (HiSilicon hi3516ev300, Ingenic T31, SigmaStar SSC30KQ), scrubbed of
// identifying uname fields — so "parses all three vendors" is a fact, not a
// hope.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

const SRC = path.join(__dirname, '..', 'www', 'a', 'main.js');

// main.js expects a browser at top level only through these; nothing more is
// stubbed, so a new top-level dependency on real DOM breaks loudly here.
function load() {
	const noop = () => {};
	const ctx = {
		window: { addEventListener: noop },
		document: { addEventListener: noop },
		console: console,
	};
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx);
	return ctx;
}

const ctx = load();
const parse = ctx.parseMetrics;
const fixture = name =>
	fs.readFileSync(path.join(__dirname, 'fixtures', 'metrics-' + name + '.txt'), 'utf8');

const hisi = parse(fixture('hisi'));
const ingenic = parse(fixture('ingenic'));
const sstar = parse(fixture('sstar'));

group('every vendor yields the topbar basics');
for (const [name, m] of [['hisi', hisi], ['ingenic', ingenic], ['sstar', sstar]]) {
	check(name + ': cpu counters summed over labels', m.cpuTotal > 0 && m.cpuIdle > 0 && m.cpuIdle < m.cpuTotal,
		'total ' + m.cpuTotal + ' idle ' + m.cpuIdle);
	check(name + ': network bytes summed, loopback excluded', m.rx > 0 && m.tx > 0,
		'rx ' + m.rx + ' tx ' + m.tx);
	check(name + ': mem total and available present', m.v.node_memory_MemTotal_bytes > 0 &&
		m.v.node_memory_MemAvailable_bytes > 0, JSON.stringify([m.v.node_memory_MemTotal_bytes, m.v.node_memory_MemAvailable_bytes]));
	check(name + ': clock and boot time present', m.v.node_time_seconds > 1e9 && m.v.node_boot_time_seconds > 1e9, '');
	check(name + ': majestic boot time present', m.v.app_boot_time_seconds > 1e9, '');
	check(name + ': day/night gauges present', 'night_enabled' in m.v && 'ircut_enabled' in m.v && 'light_enabled' in m.v, '');
	check(name + ': main-stream byte counter present', m.v.venc0_rcvd_bytes > 0, '');
}

group('labelled families other than cpu/net are skipped, not flattened');
check('task_seconds does not leak into v', !('task_seconds' in ingenic.v) &&
	!Object.keys(ingenic.v).some(k => k.startsWith('task_seconds')), '');
check('node_uname_info does not leak into v', !Object.keys(ingenic.v).some(k => k.startsWith('node_uname')), '');

group('duplicated names: first write wins');
// The T31 fixture carries majestic's accidental second isp_exptime (39092)
// after the canonical ISP block's 78964. The daemon fix removes the second
// emission, so first-wins reads the same value on fixed and unfixed cameras.
check('T31 duplicate isp_exptime resolves to the first occurrence',
	ingenic.v.isp_exptime === 78964, 'got ' + ingenic.v.isp_exptime);

group('the vendor-shaped isp set survives as-is');
check('hisi: exposure flag and isp gain', 'isp_exposureismax' in hisi.v && 'isp_ispdgain' in hisi.v, '');
check('ingenic: WB gains and AF metric', 'isp_rgain' in ingenic.v && 'isp_bgain' in ingenic.v && 'isp_afmetrics' in ingenic.v, '');
check('sstar: sensor fps and encoder stall gauges', 'isp_fps' in sstar.v && 'venc_empty_frames_run' in sstar.v, '');
check('absent stays absent — no zero-filling across vendors',
	!('isp_fps' in hisi.v) && !('isp_exptime' in sstar.v) && !('node_hwmon_temp_celsius' in ingenic.v), '');

group('a current daemon in automatic day/night mode');
// metrics-sstar-auto.txt is a real dump from the same SSC30KQ running a
// daemon with the automatic light monitor active — the cross-vendor isp set
// plus the night_auto_* gauges the Day/Night panel charts.
{
	const auto = parse(fixture('sstar-auto'));
	check('portable isp set present',
		'isp_avelum' in auto.v && 'isp_exptime' in auto.v &&
		'isp_exposureismax' in auto.v, '');
	check('mode source names the automatic monitor',
		auto.v.night_mode_source === 4, 'got ' + auto.v.night_mode_source);
	check('auto gauges parse as numbers',
		auto.v.night_auto_gain_milli > 0 &&
		'night_auto_pending' in auto.v &&
		'night_auto_streak_seconds' in auto.v &&
		auto.v.night_auto_dwell_seconds > 0, '');
}

group('MemAvailable: pre-3.14 fallback and clamp');
// The T31 runs 3.10 — no MemAvailable line. The parser must rebuild the
// kernel's own estimate from the parts, exactly as pulse.cgi's awk used to.
{
	const want = ingenic.v.node_memory_MemFree_bytes +
		ingenic.v.node_memory_Active_file_bytes +
		ingenic.v.node_memory_Inactive_file_bytes +
		ingenic.v.node_memory_SReclaimable_bytes;
	check('T31 estimate is the sum of the reclaimable parts',
		ingenic.v.node_memory_MemAvailable_bytes === want,
		'got ' + ingenic.v.node_memory_MemAvailable_bytes + ' want ' + want);
	check('T31 fixture really lacks MemAvailable', !/^node_memory_MemAvailable_bytes /m.test(fixture('ingenic')), '');
}
check('a reported MemAvailable is taken verbatim, not recomputed',
	/^node_memory_MemAvailable_bytes /m.test(fixture('hisi')) &&
	hisi.v.node_memory_MemAvailable_bytes !==
		hisi.v.node_memory_MemFree_bytes + hisi.v.node_memory_Active_file_bytes +
		hisi.v.node_memory_Inactive_file_bytes + hisi.v.node_memory_SReclaimable_bytes, '');
{
	// The estimate has no watermark discount, so a big reclaimable slab can
	// push it past MemTotal; the clamp keeps memAvail <= memTotal an invariant.
	const m = parse('node_memory_MemTotal_bytes 1000\nnode_memory_MemFree_bytes 800\nnode_memory_SReclaimable_bytes 900\n');
	check('estimate above MemTotal clamps to MemTotal',
		m.v.node_memory_MemAvailable_bytes === 1000, 'got ' + m.v.node_memory_MemAvailable_bytes);
}

group('hostile lines do not derail the parse');
{
	const m = parse('# HELP x y\ngarbage\nnovalue \nnan_metric abc\nreal_metric 7\n');
	check('comments, bare words and NaN values are skipped', m.v.real_metric === 7 &&
		!('nan_metric' in m.v) && !('novalue' in m.v), JSON.stringify(m.v));
}

done();
