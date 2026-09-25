// The settings tree: which leaf of the Camera settings page each schema key
// is drawn on (www/a/mj-tree.js).
//
// This exists because the subject fails silently. A key the tree places on no
// leaf is a row that is not there, and a settings page missing a row looks
// exactly like a settings page: on 2 September 2026 majestic began flagging
// the stream bitrate `x-live` (a save applies it without a rebuild), the page
// read that flag as "the Live adjustments leaf draws this", and Bitrate
// vanished from Main stream and Sub stream. No error, no gap in the layout,
// nothing in the console — it was found three days later, by accident, while
// fixing #316 on the same leaf.
//
// It also cannot be reproduced on demand: it needs a camera whose daemon has
// just learnt to flag a key the page never expected, which is the one thing a
// fixture can hold still. tests/fixtures/schema-hisi.json is the schema a
// HiSilicon camera emitted with that bitrate flag in it (one hint reworded so
// the fixture names no build option); the other shapes below are edits of it,
// each one a schema majestic could plausibly emit next.
'use strict';

const fs = require('fs');
const path = require('path');
const { check, group, done } = require('./assert');

const TREE = require(path.join(__dirname, '..', 'www', 'a', 'mj-tree.js'));
const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'schema-hisi.json'), 'utf8'));

// The deck's order for the lifted knobs, as mj-settings.js passes it.
const ORDER = ['luminance', 'contrast', 'saturation', 'hue', 'mirror', 'flip'];

const clone = (o) => JSON.parse(JSON.stringify(o));
const build = (schema, exclude) => TREE.build(schema, { exclude: exclude || [], liveOrder: ORDER, liveId: 'live' });
const leaves = (t) => t.groups().reduce((acc, g) => acc.concat(t.leafIds(g)), []);
// Every leaf that draws a given key — the answer should always be one.
const leafOf = (t, dot) => leaves(t).filter(l => t.leafFields(l).some(f => f.dot === dot));

// Every key a group's sections would draw: the set the invariant runs over.
// Sections in no group are in no leaf by design (#176) and are not counted.
function allDots(t, schema, exclude) {
	const skip = new Set(exclude || []);
	const out = [];
	const walk = (base, props) => {
		for (const key of Object.keys(props)) {
			const dot = base + '.' + key, sub = props[key];
			if (skip.has(dot) || !sub) continue;
			// Mirrors mj-tree.js. This walker exists to say what SHOULD be
			// drawn, so it has to know the same exclusions the tree does, or
			// the invariant reports a key as drawn nowhere when nowhere is
			// exactly where it belongs.
			if (sub['x-hidden']) continue;
			if (sub.type === 'object' && sub.properties) walk(dot, sub.properties);
			else if (TREE.RENDERABLE.has(sub.type)) out.push(dot);
		}
	};
	for (const g of t.groups()) for (const s of g.sections) walk(s, schema.properties[s].properties);
	return out;
}

function everyKeyOnce(name, t, schema, exclude) {
	const stray = [], twice = [];
	for (const dot of allDots(t, schema, exclude)) {
		const on = leafOf(t, dot);
		if (!on.length) stray.push(dot);
		if (on.length > 1) twice.push(dot + ' on ' + on.join('+'));
	}
	check(name + ': no key is drawn nowhere', !stray.length, stray.join(', '));
	check(name + ': no key is drawn twice', !twice.length, twice.join(', '));
}

group('a live-flagged key outside the owner group is drawn on its own section');
{
	const t = build(SCHEMA);
	const br = SCHEMA.properties.video0.properties.bitrate;
	check('the fixture flags video0.bitrate live', br && br['x-live'] === true);
	check('Bitrate is on Main stream', leafOf(t, 'video0.bitrate').join() === 'video0');
	check('Bitrate is on Sub stream', leafOf(t, 'video1.bitrate').join() === 'video1');
	check('the bitrate is not lifted', !t.lifted().has('video0.bitrate'));
	check('the overlay placement keys stay on the OSD leaf',
		leafOf(t, 'osd.anchor').join() === 'osd' && leafOf(t, 'osd.offsetX').join() === 'osd');
	check('the Live leaf is owned by the image group', t.owner() && t.owner().id === 'image');
}

group('the image section is absorbed onto the Live leaf');
{
	const t = build(SCHEMA);
	check('image is absorbed', t.absorbed('image'));
	check('image has no leaf of its own', !leaves(t).includes('image'));
	check('the image group leads with the Live leaf', t.leafIds(t.groups()[0]).join() === 'live,isp,nightMode');
	check('Rotate is drawn on the Live leaf', leafOf(t, 'image.rotate').join() === 'live');
	check('Automatic tuning is drawn on the Live leaf', leafOf(t, 'image.tuning').join() === 'live');
	check('mirror and flip are lifted', t.lifted().has('image.mirror') && t.lifted().has('image.flip'));
	check('the Live leaf lists the knobs first, in deck order',
		t.leafFields('live').slice(0, 6).map(f => f.dot.split('.').pop()).join() === ORDER.join());
	check('then the leftovers', t.leafFields('live').slice(6).map(f => f.dot).join() === 'image.rotate,image.tuning');
	check('the leftovers alone are what image still has to draw',
		t.sectionFields('image').map(f => f.dot).join() === 'image.rotate,image.tuning');
	check('asked with the lifted keys in, image is all eight', t.sectionFields('image', true).length === 8);
	everyKeyOnce('shipped schema', t, SCHEMA);
}

// The flattened record is what the search reads, and a tier missing from it is
// a word the page shows and the search cannot find -- which reads as the
// setting not existing rather than as a broken index. No camera emits `help`
// yet, so this is planted rather than found.
group('the flattened record carries all three documentation tiers');
{
	const s = clone(SCHEMA);
	s.properties.video0.properties.bitrate.help = 'a long technical explanation';
	s.properties.image.properties.luminance.help = 'and one on a lifted knob';
	const t = build(s);
	const bitrate = t.sectionFields('video0').find(f => f.dot === 'video0.bitrate');
	check('a section record carries the daemon\'s help',
		bitrate && bitrate.help === 'a long technical explanation');
	check('it still carries the hint beside it',
		bitrate && typeof bitrate.hint === 'string');
	// The Live leaf draws neither hint nor help, but the search counts both --
	// see the comment at the lift in mj-tree.js. Pinned so the mirror is not
	// quietly broken on one side.
	const knob = t.leafFields('live').find(f => f.dot === 'image.luminance');
	check('a lifted knob carries it too',
		knob && knob.help === 'and one on a lifted knob');
	check('a field the daemon said nothing more about carries an empty string',
		t.sectionFields('video0').every(f => typeof f.help === 'string'));
}

group('a section the leaf lifts a minority of keeps its page');
{
	const s = clone(SCHEMA);
	const isp = s.properties.isp.properties;
	const key = Object.keys(isp).find(k => isp[k] && TREE.RENDERABLE.has(isp[k].type) && !isp[k]['x-live']);
	check('the fixture has a plain isp key to flag', !!key, 'none found');
	isp[key]['x-live'] = true;
	const t = build(s);
	check('isp keeps its leaf', leaves(t).includes('isp'));
	check('isp is not absorbed', !t.absorbed('isp'));
	check('its one live key is lifted onto the Live leaf', leafOf(t, 'isp.' + key).join() === 'live');
	const other = Object.keys(isp).find(k => k !== key && isp[k] && TREE.RENDERABLE.has(isp[k].type));
	check('the rest of isp is still on isp', leafOf(t, 'isp.' + other).join() === 'isp');
	check('image is still absorbed beside it', t.absorbed('image') && !leaves(t).includes('image'));
	everyKeyOnce('minority lift', t, s);
}

group('with nothing flagged live there is no Live leaf');
{
	const s = clone(SCHEMA);
	for (const sec of Object.values(s.properties)) {
		for (const sub of Object.values(sec.properties || {})) delete sub['x-live'];
	}
	const t = build(s);
	check('no Live leaf', !leaves(t).includes('live') && t.owner() === null);
	check('image is an ordinary leaf', leaves(t).includes('image'));
	check('image draws all eight of its keys', t.leafFields('image').length === 8);
	check('Bitrate is still on Main stream', leafOf(t, 'video0.bitrate').join() === 'video0');
	everyKeyOnce('nothing live', t, s);
}

group('a section that is entirely live is absorbed, not left as an empty leaf');
{
	const s = clone(SCHEMA);
	delete s.properties.image.properties.rotate;
	delete s.properties.image.properties.tuning;
	const t = build(s);
	check('image is absorbed', t.absorbed('image'));
	check('image has no leaf', !leaves(t).includes('image'));
	check('the Live leaf draws exactly the six knobs', t.leafFields('live').length === 6);
	everyKeyOnce('all live', t, s);
}

group('the Live leaf goes to the first group with a live key');
{
	const s = clone(SCHEMA);
	for (const sub of Object.values(s.properties.image.properties)) delete sub['x-live'];
	const t = build(s);
	check('the video group owns it now', t.owner() && t.owner().id === 'video');
	check('the bitrates are lifted', t.lifted().has('video0.bitrate') && t.lifted().has('video1.bitrate'));
	// Every live key of the owner group is lifted, the overlay's placement
	// included: the rule is the group's, not the key's. On a build shaped like
	// this the deck would draw a bitrate beside the picture, which is the case
	// for majestic to flag only what /api/v1/image previews as live.
	check('the overlay keys go with them', t.lifted().has('osd.anchor'));
	check('video0 keeps its page: one of many is a minority', leaves(t).includes('video0') && !t.absorbed('video0'));
	check('image is an ordinary leaf', leaves(t).includes('image') && t.leafFields('image').length === 8);
	everyKeyOnce('video owns live', t, s);
}

group('an excluded key is drawn nowhere, lifted or not');
{
	const ex = ['image.rotate', 'image.mirror', 'video0.bitrate'];
	const t = build(SCHEMA, ex);
	check('an excluded leftover is not drawn', leafOf(t, 'image.rotate').length === 0);
	check('an excluded live key is not lifted', !t.lifted().has('image.mirror'));
	check('an excluded ordinary key is not drawn', leafOf(t, 'video0.bitrate').length === 0);
	check('image is still absorbed on what remains', t.absorbed('image'));
	everyKeyOnce('exclusions', t, SCHEMA, ex);
}

group('a schema with no groups draws nothing and throws nothing');
{
	const t = build({ properties: SCHEMA.properties });
	check('no groups', t.groups().length === 0);
	check('no owner', t.owner() === null);
	check('no leaves', leaves(t).length === 0);
	check('a section can still be asked for its fields', t.sectionFields('image').length === 8);
}

group('a group whose sections this build does not have disappears');
{
	// The USB group is the live case for this. majestic emits it on every
	// camera, but the two sections it names are behind build flags that only a
	// couple of SoCs set (#176), so most cameras get a group listing sections
	// their schema does not contain. What they must not get is an empty tab
	// with nothing behind it — which is the shape a reader of x-groups alone
	// would produce, and the reason the filter in groups() is not decoration.
	const s = clone(SCHEMA);
	// This fixture came off a camera that HAS usbcam, so take it away: what is
	// being tested is the majority of cameras, which have neither.
	delete s.properties.usbcam;
	delete s.properties.uvcgadget;
	s['x-groups'] = s['x-groups'].concat([
		{ id: 'usb', label: 'USB', sections: ['usbcam', 'uvcgadget'] },
	]);
	const t = build(s);
	check('the group is not offered at all', t.groups().every(g => g.id !== 'usb'));
	check('and nothing else moved', t.groups().length === SCHEMA['x-groups'].length);
	everyKeyOnce('a group with no sections present', t, s);

	// A build with one of the two is not hypothetical either: usbcam and
	// uvcgadget have separate flags, and a camera that can read a webcam but
	// not pretend to be one is an ordinary configuration.
	const one = clone(s);
	one.properties.usbcam = {
		type: 'object',
		properties: {
			enabled: { type: 'boolean', title: 'Enable' },
			fps: { type: 'integer', title: 'Frame rate' },
		},
	};
	const t2 = build(one);
	const usb = t2.groups().find(g => g.id === 'usb');
	check('the group appears once a section exists', !!usb);
	check('naming only the section that exists', !!usb && usb.sections.join() === 'usbcam');
	check('and its keys are drawn', leafOf(t2, 'usbcam.fps').length === 1);
	everyKeyOnce('a group with one section present', t2, one);
}

// ── Day / Night's own headings ──────────────────────────────────────────────
//
// nightMode is flat in the schema, so the page groups it from a map here. The
// failure is the same silent one this file opens with, one level down: a key
// named in no group and drawn by no control is a row that is not there, and a
// section missing a row looks exactly like a section. Reaching it needs a
// daemon that has just added a setting — which is the one thing a fixture can
// hold still.
group('Day / Night: every setting is in a heading or on the pin map');
{
	const NM = SCHEMA.properties.nightMode.properties;
	const groups = TREE.sectionGroups('nightMode');
	const onMap = TREE.mapDriven('nightMode');

	check('the section has a group map at all', !!groups && groups.length > 0);
	check('and every group is named', groups.every(g => g.id && g.label && g.keys.length));

	const placed = groups.reduce((acc, g) => acc.concat(g.keys), []);
	const dupes = placed.filter((k, i) => placed.indexOf(k) !== i);
	check('no key is in two headings', !dupes.length, dupes.join(', '));
	const bothWays = placed.filter(k => onMap.indexOf(k) >= 0);
	check('and none is both a row and drawn by the map', !bothWays.length, bothWays.join(', '));

	const known = new Set(placed.concat(onMap));
	const orphans = Object.keys(NM).filter(k => !known.has(k));
	check('every key in the shipped schema is accounted for', !orphans.length,
		'unplaced: ' + orphans.join(', '));

	// The reverse is deliberately NOT "the map names only keys that exist".
	// The map has to stay free to name a key this build does not ship, and
	// naming one costs nothing: a key that is absent is simply not rendered.
	//
	// Every key named in the map happens to be in this fixture, so nothing
	// here demonstrates that — but the case is live on real hardware. The six
	// dimmable-lamp keys are offered by an hi3516ev300 and by no hi3516av300,
	// which answers 404 for the channel; this fixture is the shape of a camera
	// that has them. Do not read "no key here is missing" as licence to start
	// asserting the reverse.
	//
	// What would cost something is a HEADING left with nothing under it: a
	// micro-caps name and a rule across the column, introducing no settings.
	// That is what to assert, and it holds on any schema.
	const drawn = (g) => g.keys.filter(k => (k in NM) && onMap.indexOf(k) < 0);
	const empty = groups.filter(g => !drawn(g).length).map(g => g.id);
	check('no heading is left with nothing under it', !empty.length,
		'empty: ' + empty.join(', '));
}

// ── The exposure rows' headings on the Live leaf ───────────────────────────
//
// isp's groups are drawn only where their rows are lifted, and the isp page
// skips a heading whose rows all went to the Live leaf. So the two failures
// are: a group key the daemon does not lift, which would leave its heading on
// the isp page with the rest of the group gone; and a key in two groups, drawn
// under whichever heading came first. Every key here has to be in the shipped
// schema, too -- the headings were written against it (#582).
group('ISP: the Live leaf headings name lifted keys, once each');
{
	// The exposure keys as an hi3516ev300 declares them, merged into a copy
	// rather than into the shared fixture: every assertion above counts what
	// the image section puts on the Live leaf, and these would join it.
	const s = clone(SCHEMA);
	Object.assign(s.properties.isp.properties, JSON.parse(fs.readFileSync(
		path.join(__dirname, 'fixtures', 'schema-isp-exposure.json'), 'utf8')));
	const ISP = s.properties.isp.properties;
	const groups = TREE.sectionGroups('isp');
	const t = build(s);
	check('the section has a group map', !!groups && groups.length > 0);
	check('every group has an id and keys', groups.every(g => g.id && g.keys.length));
	check('only the first group goes without a heading',
		groups.slice(1).every(g => g.label));
	const placed = groups.reduce((acc, g) => acc.concat(g.keys), []);
	const dupes = placed.filter((k, i) => placed.indexOf(k) !== i);
	check('no key is in two headings', !dupes.length, dupes.join(', '));
	// A lifted isp key named in no group is drawn ahead of the first heading:
	// it would sit among the two mode switches, which is how the external
	// tuner switch came to be second on the card.
	const unnamed = Object.keys(ISP).filter(k => t.lifted().has('isp.' + k) && placed.indexOf(k) < 0);
	check('every lifted isp key is placed on purpose', !unnamed.length, unnamed.join(', '));
	const missing = placed.filter(k => !(k in ISP));
	check('every grouped key is in the shipped schema', !missing.length, missing.join(', '));
	const notLifted = placed.filter(k => !t.lifted().has('isp.' + k));
	check('every grouped key is lifted to the Live leaf', !notLifted.length, notLifted.join(', '));
	everyKeyOnce('exposure keys', t, s);
}

group('a list of objects is one leaf, not one per member');
{
	// The destination list is `{type:'array', items:{type:'object', ...}}`, and
	// the members of an item are drawn inside a row rather than as fields of
	// their own. A walker that recursed into `items.properties` the way it
	// recurses into a section's would put `url`, `token` and `channel` on the
	// page as three separate settings on the Outgoing tab, each editing a list
	// it has no row to belong to. Nothing about that looks wrong until someone
	// tries to add a second destination.
	const s = clone(SCHEMA);
	s.properties.outgoing.properties.servers = {
		type: 'array',
		title: 'Destinations',
		items: {
			type: 'object',
			properties: {
				url: { type: 'string', title: 'Address' },
				enabled: { type: 'boolean', title: 'Enabled', default: true },
				token: { type: 'string', title: 'Token', 'x-secret': true },
				channel: { type: 'string', title: 'Source', enum: ['', 'main', 'sub'] },
				legacy: { type: 'string', title: 'Superseded', 'x-hidden': true },
			},
			required: ['url'],
		},
	};
	// A key the camera declares but has superseded is offered to nobody: the
	// list replaced the single Address, so drawing both is a question about
	// which one wins. The tree has to be TOLD that, rather than left to infer
	// it from absence, because the key is still in the schema being sent.
	//
	// Current majestic no longer sends it at all -- the singular outgoing
	// settings are deprecated and converted onto the rows on load, so nothing
	// in that section is hidden any more. This stays exactly as it is: the
	// page talks to whatever daemon the camera is running, and one that
	// predates the conversion still marks the old Address hidden and still
	// expects a page not to draw it.
	s.properties.outgoing.properties.server['x-hidden'] = true;
	const t = TREE.build(s, {}, new Set());
	const dots = allDots(t, s, new Set());
	check('a hidden key is drawn nowhere',
		dots.indexOf('outgoing.server') < 0);
	const mine = dots.filter(d => d.indexOf('outgoing.servers') === 0);
	check('the list itself is drawn', mine.indexOf('outgoing.servers') >= 0);
	check('and nothing else under it is', mine.length === 1,
		'also drawn: ' + mine.join(', '));
	everyKeyOnce('with a destination list', t, s, new Set());
}

// A section whose leaf is not a form.
//
// Rule 4 drops a section with nothing to draw, and that is the right rule: it
// is what keeps an absorbed section, or one whose keys are all lifted, from
// leaving an empty tab behind. `pins` is the exception — one key, hidden,
// because the page draws the chip from /api/v1/pinmux rather than from the
// schema. The exception has to be NAMED, or the leaf silently disappears the
// moment the daemon stops sending a visible key, which is exactly the kind of
// silent loss this file exists for.
{
	group('a section whose leaf draws something other than its fields');
	const s = clone(SCHEMA);
	s.properties.pins = {
		type: 'object',
		properties: {
			assignments: { type: 'array', title: 'Pins', 'x-hidden': true },
		},
	};
	for (const g of s['x-groups']) {
		if (g.id === 'system') g.sections.push('pins');
	}

	const plain = TREE.build(s, { liveOrder: ORDER, liveId: 'live' });
	const sys = plain.groups().find(g => g.id === 'system');
	check('unnamed, a section with only hidden keys has no leaf',
		plain.leafIds(sys).indexOf('pins') < 0);

	const named = TREE.build(s, { liveOrder: ORDER, liveId: 'live', custom: ['pins'] });
	const sys2 = named.groups().find(g => g.id === 'system');
	check('named as custom, it keeps its leaf',
		named.leafIds(sys2).indexOf('pins') >= 0);
	check('and it still draws no fields of its own',
		named.leafFields('pins').length === 0);
	check('naming it changes nothing about any other leaf',
		JSON.stringify(named.leafIds(sys2).filter(l => l !== 'pins')) ===
		JSON.stringify(plain.leafIds(sys)));
}

done();
