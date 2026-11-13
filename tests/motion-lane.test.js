// The motion lane: spans the camera reports, turned into blips a reader can
// see and click.
//
// This is where the feature fails invisibly. At the whole-day zoom a
// ten-second event is a ninth of a pixel: draw it honestly and the lane is
// blank for exactly the camera that has the most to report. Widen it wrongly
// and a click lands on a rectangle that was never a detection. Neither throws,
// and neither is visible in a screenshot.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, group, done } = require('./assert');

function load() {
	const ctx = { window: {}, console: console };
	vm.createContext(ctx);
	vm.runInContext(
		fs.readFileSync(path.join(__dirname, '..', 'www', 'a', 'timeline.js'), 'utf8'),
		ctx);
	return ctx.window.MajesticTimeline;
}
const T = load();

// The band is about 800 px wide on the page the harness measures.
const PX = 800;
const view = (from, width) => ({ from: from, width: width });
const secPerPx = (width) => width / PX;

// The six zoom levels recordings.js offers.
const ZOOMS = [15 * 60, 30 * 60, 3600, 3 * 3600, 6 * 3600, 86400];

group('a ten-second event is drawn at every zoom, or the lane lies');
{
	// The honest width at a whole-day zoom is 0.09 px. A lane that drew it
	// would show nothing at all, for a camera that saw something.
	const spans = [[32100, 32110, 1]];
	for (const z of ZOOMS) {
		const lane = T.motionLane(spans, view(32000, z), secPerPx(z));
		const widthPx = lane.length ? (lane[0].to - lane[0].from) / secPerPx(z) : 0;
		check(`zoom ${z}s: drawn at ${widthPx.toFixed(1)} px`,
			lane.length === 1 && widthPx >= T.MIN_BLIP_PX - 0.001);
	}
}

group('a widened blip stays centred on the moment it reports');
{
	// Otherwise the lane drifts away from the thing it is pointing at, which
	// on a day view is minutes.
	const z = 86400;
	const lane = T.motionLane([[43200, 43210, 1]], view(0, z), secPerPx(z));
	const mid = (lane[0].from + lane[0].to) / 2;
	check('centre preserved', Math.abs(mid - 43205) < 0.001);
}

group('blips too close to aim between become one');
{
	const z = 86400;
	const sp = secPerPx(z);
	const near = Math.floor(sp);            // about a pixel apart
	const lane = T.motionLane(
		[[1000, 1010, 1], [1000 + near, 1010 + near, 2]], view(0, z), sp);
	check('merged into one', lane.length === 1);
	check('and it counts both events', lane[0].events === 3);
	check('keeping what it stands for', lane[0].members.length === 2);
}

group('at a close zoom the same two are separate');
{
	const z = 15 * 60;
	const lane = T.motionLane(
		[[1000, 1010, 1], [1100, 1110, 2]], view(900, z), secPerPx(z));
	check('two blips', lane.length === 2);
}

group('clicking resolves to a real event, not to a drawn rectangle');
{
	const z = 86400;
	const spans = [[1000, 1010, 1], [1100, 1110, 2]];
	const hit = T.motionAt(spans, 1105, secPerPx(z));
	check('found', !!hit);
	check('and it is the second one', hit && hit.from === 1100);

	// A press nowhere near anything is not a press on something.
	check('a press in an empty stretch hits nothing',
		T.motionAt(spans, 50000, secPerPx(15 * 60)) === null);
}

group('unwatched stretches are known, and are not the same as quiet ones');
{
	// The distinction the whole lane rests on: a day recorded before the
	// camera kept an index is entirely unwatched, and a plain empty lane
	// would tell a reader it was quiet.
	const v = view(0, 86400);
	check('no watch windows at all: the whole day is unwatched',
		JSON.stringify(T.motionCoverage([], v)) ===
		JSON.stringify([{ from: 0, to: 86400 }]));

	check('watched all day: nothing hatched',
		T.motionCoverage([[0, 86400]], v).length === 0);

	const half = T.motionCoverage([[43200, 86400]], v);
	check('detector switched on at noon: the morning is hatched',
		half.length === 1 && half[0].from === 0 && half[0].to === 43200);
}

group('nonsense from the camera is ignored rather than drawn');
{
	const z = 3600;
	const lane = T.motionLane(
		[[100, 50, 1], ['x', 'y', 1], [200], [300, 310, 1]],
		view(0, z), secPerPx(z));
	check('only the usable one survives', lane.length === 1);
	check('and it is the right one', lane[0].members[0].from === 300);
}

group('spans outside the view are not drawn');
{
	const z = 900;
	const lane = T.motionLane(
		[[100, 110, 1], [5000, 5010, 1]], view(4800, z), secPerPx(z));
	check('one of the two', lane.length === 1);
}

done();
