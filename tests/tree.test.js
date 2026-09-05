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
// HiSilicon camera emitted with that bitrate flag in it; the other shapes
// below are edits of it, each one a schema majestic could plausibly emit next.
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

done();
