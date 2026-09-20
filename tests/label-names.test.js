// Every control name quoted in a sentence is a control that still exists.
//
// The page explains a problem by naming the row that fixes it, in the words the
// page puts on screen rather than by the dotted key underneath — a key is a
// second vocabulary, readable only by someone who already knows the answer. So
// the prose quotes schema TITLES, and a title belongs to the daemon, which is
// free to rename or remove one.
//
// Nothing noticed when it did. The daemon folded each Day/Night actuator's two
// booleans into one three-state mode; two titles went away with them, and three
// sentences went on telling readers to turn on switches that were no longer on
// the page — one of them on the Dashboard, beside a button opening the very
// page the control had left (#551, #556).
//
// The suite did not merely miss it. THE ONE TEST THAT TOUCHED THOSE SENTENCES
// PINNED THE DEAD WORDING, in its assertion and in its own name, so it had to
// be rewritten before the fix could land. A test can defend a defect as easily
// as catch one, and the two sentences nobody had pinned are the two that rotted
// quietly. This file is the general answer: no sentence gets to name a control
// unless some real camera has one by that name.
//
// WHAT COUNTS AS A QUOTED LABEL. The house convention is a schema title in
// straight double quotes inside a sentence — 'Raise "Most compression allowed
// (QP)".' Everything else that carries double quotes in these files is markup
// being concatenated, and markup is mechanically distinguishable: an attribute
// value is preceded by `=`. That one rule drops every aria-label, title=,
// class= and SVG d= in the tree, which is 40 occurrences against the 15 that
// are prose. The remaining filters are just as blunt — a label is capitalised,
// has a space in it, and is not an ALL-CAPS token like a nodeName comparison.
//
// No per-string allow-list, deliberately. A list of strings to ignore is a
// place for a rotted label to hide, and needing one would mean a sentence is
// quoting something that is not a control — which is its own defect.
//
// WHAT THE FIXTURE IS. tests/fixtures/schema-titles.json is the union of the
// titles a current HiSilicon camera reports and those in the curated
// schema-hisi.json, because neither is a superset: the camera carries 66 the
// fixture lacks, the fixture 32 the camera lacks (other SoCs, other daemons).
// A title in neither is one no schema on file has ever had.
//
// It is deliberately NOT schema-hisi.json itself. That file is curated for
// tree.test.js — it holds one specific bitrate flag, and a hint was reworded so
// it names no build option — and regenerating it to widen coverage here would
// put both at risk for a reason that has nothing to do with the tree.
//
// THE LIMIT, SAID OUT LOUD. A label that is real on hardware nobody here has
// would fail this check. That is the known-absent case, and the answer is to
// add the title to the fixture — one reviewable line that records which camera
// said so — rather than to teach the check to look away from a string.
'use strict';

const fs = require('fs');
const path = require('path');
const { check, group, done } = require('./assert.js');

const DIR = path.join(__dirname, '..', 'www', 'a');
const TITLES = new Set(JSON.parse(fs.readFileSync(
	path.join(__dirname, 'fixtures', 'schema-titles.json'), 'utf8')));

// The modules whose job is sentences about settings. main.js and the page
// modules build markup and hold their own double-quoted literals; they name no
// schema title, so widening this to all of www/a/ would only add noise.
const FILES = ['ircut-check.js', 'rc-check.js', 'video-check.js',
	'audio-check.js', 'storage-check.js', 'update-check.js', 'mj-settings.js'];

// A SENTENCE WRAPPED AT THE COLUMN LIMIT IS ONE STRING TO A READER AND TWO
// LITERALS TO THE PARSER, and this file wraps at 72 columns everywhere. Scanning
// physical lines therefore looked past every label that straddled a wrap —
// measured, 3 of 15 occurrences and one label outright, which is a blind spot
// exactly where the prose is longest and most likely to name something. The
// literals are joined back first, keeping the line the sentence STARTS on so a
// failure still points somewhere.
function logicalLines(src) {
	const lines = src.split('\n');
	const out = [];
	let i = 0;
	while (i < lines.length) {
		const head = lines[i].trim();
		if (head.startsWith('//') || head.startsWith('*')) { i++; continue; }
		let text = lines[i];
		const at = i + 1;
		while (/'\s*\+\s*$/.test(text) && i + 1 < lines.length) {
			const next = lines[i + 1].trim();
			// Only a literal continues a literal. A comment or an expression
			// between the two ends the join rather than being spliced into it.
			if (next.charAt(0) !== '\'') break;
			text = text.replace(/'\s*\+\s*$/, '') + next.slice(1);
			i++;
		}
		out.push({ text: text, line: at });
		i++;
	}
	return out;
}

// Pulled out so the rule itself can be tested rather than only its result.
function quotedLabels(src) {
	const out = [];
	logicalLines(src).forEach((ln) => {
		// No upper bound on the length. One shipped title runs to 109
		// characters, and a cap is a quiet way for the longest names — the ones
		// most in need of checking — to skip the check entirely.
		const re = /"([^"]{4,})"/g;
		let m;
		while ((m = re.exec(ln.text)) !== null) {
			const lab = m[1];
			if (m.index && ln.text[m.index - 1] === '=') continue;
			if (lab === lab.toUpperCase()) continue;
			if (lab.indexOf(' ') < 0) continue;
			if (!/^[A-Z]/.test(lab)) continue;
			out.push({ label: lab, line: ln.line });
		}
	});
	return out;
}

group('the extractor tells prose from markup');
{
	check('a label quoted in a sentence is found',
		quotedLabels('x = \'Raise "Most compression allowed (QP)".\';')
			.some(h => h.label === 'Most compression allowed (QP)'));
	check('an attribute value is not',
		quotedLabels('h += \'<button aria-label="Close the panel">\';').length === 0);
	check('SVG path data is not',
		quotedLabels('h += \'<path d="M10 4v12 and more"/>\';').length === 0);
	check('an ALL-CAPS nodeName is not',
		quotedLabels('if (el.nodeName === "FORM ELEMENT") return;').length === 0);
	check('a single word is not',
		quotedLabels('x = \'the "Dismiss" button\';').length === 0);
	check('a comment line is skipped',
		quotedLabels('\t// the "Drive the IR-cut filter" switch').length === 0);
	// The case the line-by-line version looked straight past.
	const wrapped = "\t\tdetail: 'and \"Single ' +\n\t\t\t'IRcut is inverted\" swaps it.',";
	check('a label split across a wrapped concatenation is found whole',
		quotedLabels(wrapped).some(h => h.label === 'Single IRcut is inverted'),
		JSON.stringify(quotedLabels(wrapped)));
	check('...and is reported against the line it starts on',
		(quotedLabels(wrapped)[0] || {}).line === 1);
	// Longer than any cap would have allowed. The longest shipped title is 109
	// characters, so a bound is a way for the biggest names to go unchecked.
	const longLab = 'A title that is deliberately far longer than seventy characters so that no cap can hide it';
	check('a title longer than seventy characters is still found',
		quotedLabels('x = \'Set "' + longLab + '" first.\';')
			.some(h => h.label === longLab));
}

group('every control a sentence names is a control some camera has');
{
	let checked = 0;
	const strays = [];
	FILES.forEach((f) => {
		const p = path.join(DIR, f);
		if (!fs.existsSync(p)) return;
		quotedLabels(fs.readFileSync(p, 'utf8')).forEach((h) => {
			checked++;
			if (!TITLES.has(h.label)) strays.push(f + ':' + h.line + ' "' + h.label + '"');
		});
	});
	// A rule that matched nothing would pass this file for ever while the prose
	// rotted behind it, which is the failure this test exists to end.
	check('the prose quotes some control names at all', checked >= 15,
		'found ' + checked);
	check('and every one of them is a title on a real schema',
		strays.length === 0, strays.join(' | '));
}

done();
