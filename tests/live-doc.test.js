// The document the Live leaf pushes to /api/v1/live (www/a/mj-settings.js:
// liveDocOf, liveValue, liveIsSaved).
//
// It fails silently, which is how it was found. The page used to push every
// live row through /api/v1/image, a query string that names keys by their
// last segment and knows only the image knobs: the exposure rows went out as
// `aGain=4`, the camera answered 200 and dropped them, and the page believed a
// picture had moved that never did. Nothing on screen distinguishes a preview
// that landed from one that was thrown away; only the document's shape does.
//
// mj-settings.js is one IIFE, so the three functions and the helper they share
// are sliced out of its source, as enum-titles.test.js does.
'use strict';

const fs = require('fs');
const path = require('path');
const { check, group, done } = require('./assert');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'www', 'a', 'mj-settings.js'), 'utf8');
function slice(head) {
	const from = SRC.indexOf(head);
	if (from < 0) throw new Error('not found in mj-settings.js: ' + head);
	const to = SRC.indexOf('\n\t}\n', from);
	return SRC.slice(from, to + 3);
}
const code = [
	slice('\tfunction setDotted(obj, dot, val) {'),
	slice('\tfunction toBool(v) {'),
	slice('\tfunction liveValue(f) {'),
	slice('\tfunction liveSaved(f) {'),
	slice('\tfunction liveDocOf(want) {'),
	slice('\tfunction liveIsSaved(f, want) {'),
].join('\n');
// liveDocOf is preceded by the Set it keeps, which the slice starts after.
const make = new Function('state', 'isLive', 'const livePreviewed = new Set();\n' + code +
	'\nreturn { liveDocOf, liveValue, livePreviewed };');

// A leaf as the page holds it: two image knobs, and exposure rows -- one
// changed, one on Auto over a saved value, one untouched, the metering area,
// and dehaze, which the tone controller drives and must never be pinned.
function field(dot, type, value, initial) {
	const f = { dot, type, pushes: true, init: initial };
	if (type === 'boolean') f.control = { checked: value };
	else if (type === 'array') f.control = {};
	else f.control = { value };
	f.getValue = () => type === 'boolean' ? String(f.control.checked)
		: type === 'array' ? f.list : String(f.control.value);
	if (type === 'array') f.list = value;
	return f;
}
const F = {
	contrast: field('image.contrast', 'integer', '60', '50'),
	mirror: field('image.mirror', 'boolean', true, 'false'),
	aGain: field('isp.aGain', 'number', '4', ''),
	exposure: field('isp.exposure', 'number', '', '20'),
	aeSpeed: field('isp.aeSpeed', 'integer', '', ''),
	meter: field('isp.meterRect', 'array', '10x10x400x300', ''),
	dehaze: field('isp.dehaze', 'integer', '125', '125'),
};
const fields = Object.values(F).concat([{ dot: 'video0.bitrate', type: 'integer',
	pushes: false, control: { value: '4096' }, getValue: () => '4096' }]);
const state = { fields, initial: {} };
fields.forEach(f => { state.initial[f.dot] = f.init; });
const L = make(state, (f) => !!f.pushes);

group('a push names the rows by their real paths, and only the ones that changed');
{
	const d = L.liveDocOf(L.liveValue);
	check('the image knobs go in whole, by value', d.image.contrast === '60' && d.image.mirror === '1');
	check('a changed exposure row is under isp, not flattened to its last word',
		d.isp && d.isp.aGain === '4');
	check('emptied over a saved value is Auto, sent as 0 -- not as the drop',
		d.isp.exposure === '0');
	check('the metering area goes as its list, not as "undefined"',
		d.isp.meterRect === '10x10x400x300');
	check('an untouched row is not sent -- it would pin the key on the camera',
		!('aeSpeed' in d.isp));
	check('dehaze at its saved value is not sent, so the tone controller keeps it',
		!('dehaze' in d.isp));
	check('a row that is not wired live is not pushed', !d.video0);
	check('every value is a string, as the document wants',
		[d.image.contrast, d.image.mirror, d.isp.aGain].every(v => typeof v === 'string'));
}

group('a row brought back to its saved value is dropped, once');
{
	F.aGain.control.value = '';
	const d = L.liveDocOf(L.liveValue);
	check('the drop is sent', d.isp.aGain === '');
	const again = L.liveDocOf(L.liveValue);
	check('and not again on the next push', !('aGain' in again.isp));
}

group('a revert puts the image knobs back and drops what was previewed');
{
	const d = L.liveDocOf(null);
	check('an image knob goes back to what is saved', d.image.contrast === '50');
	check('a switch goes back as 1/0', d.image.mirror === '0');
	check('the previewed rows are dropped', d.isp.exposure === '' && d.isp.meterRect === '');
	check('a row never previewed is left alone', !('aeSpeed' in d.isp) && !('dehaze' in d.isp));
	check('and after the revert nothing is left to drop', L.livePreviewed.size === 0);
}

group('nothing live, nothing to send');
{
	const M = make({ fields: [fields[fields.length - 1]], initial: {} }, (f) => !!f.pushes);
	check('a leaf with no live rows builds no document', M.liveDocOf(M.liveValue) === null);
}

done();
