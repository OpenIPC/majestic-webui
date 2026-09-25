// The settings tree: which leaf of the Camera settings page every key in
// majestic's schema is drawn on.
//
// Everything on that page hangs off this — the rail, the search counts, what
// each section renders, and what the Picture leaf lifts out of the
// sections to sit beside the picture. It is a module of its own, and tested,
// because its failures are silent: a key this places nowhere is a row that is
// simply not there, and a settings page with a row missing looks exactly like
// a settings page. That is how the stream bitrate went missing from Main
// stream and Sub stream in September 2026 — majestic began flagging it
// `x-live`, the page read the flag as "the Live leaf draws this", and the Live
// leaf did not. Nothing reported it; it was found while fixing something else.
//
// The rules, in the order they are asked:
//
//   1. Groups are the schema's x-groups manifest, kept to the sections the
//      schema actually carries. A section in no group is on no leaf (#176).
//   2. The first group with any `x-live` key OWNS the Live leaf, and those
//      keys — from every section of that group — are LIFTED onto it, beside
//      the picture. That set is the only thing the flag decides. The flag
//      itself is the daemon's word for "a save applies this without a
//      rebuild", and majestic puts it on every key it can apply that way; a
//      bitrate and the overlay's placement carry it and are drawn on their own
//      sections like any other key. Placement is this page's decision; the
//      flag only says what the camera can do.
//   3. A section the leaf lifts MORE of than it leaves is ABSORBED, and has no
//      leaf of its own — provided its leftovers have a HOME (LEFTOVER_HOME):
//      another section's leaf they are drawn on, under a heading. They are
//      never drawn on the Live leaf itself. Leftovers are by definition the
//      keys the camera cannot apply live, and the Live leaf holds only what
//      changes the picture as it is touched: a control there that waits for
//      Save and a pipeline reload reads as a control that does nothing. That
//      is what the quarter turn was — drawn beside the Orientation pad
//      (#316), its 90° cells staged a value the picture did not show until
//      Save and "Apply now" (#583). `image` — every key live but Rotate — is
//      the absorbed section, and Rotate lives on ISP / Exposure. A section
//      with leftovers and no home is not absorbed: it keeps its page, which
//      is the safe answer for a key a daemon adds tomorrow. A section the
//      leaf lifts LESS of keeps its page too, and says where the rest went:
//      thirty exposure controls do not move house because one went live.
//   4. A section with nothing left to draw has no leaf.
//
// Pure: it reads a schema and an exclusion list and never touches the DOM, so
// tests/tree.test.js can ask it, against the schema a camera actually
// emitted, where every key landed.
(() => {
	'use strict';

	// Where an absorbed section's leftovers are drawn (rule 3): the leaf of
	// `home`, under a heading called `label`. `image` leaves only Rotate, and
	// it goes with the picture-pipeline settings that already need Save and a
	// reload.
	const LEFTOVER_HOME = {
		image: { home: 'isp', label: 'Rotation' },
	};

	// The types the form's renderField actually draws — an object falls
	// through its dispatch and returns nothing, so it must not make a section
	// look non-empty. `number` is drawn (a box with step="any"); leaving it out
	// here kept every decimal field — the calibration angles, the lamp curve —
	// on the page but out of search and out of the rail's counts.
	const RENDERABLE = new Set(['boolean', 'integer', 'number', 'string', 'array']);

	// opts: exclude (dots never drawn), liveOrder (deck order of the lifted
	// keys, by key), liveId (the Live leaf's id), liveLabel(key, sub) (the
	// short label the deck prints, for the search), custom (section ids whose
	// leaf the page draws itself rather than from the section's fields).
	function build(schema, opts) {
		opts = opts || {};
		const exclude = opts.exclude instanceof Set ? opts.exclude : new Set(opts.exclude || []);
		const order = opts.liveOrder || [];
		const liveId = opts.liveId || 'live';
		const liveLabel = opts.liveLabel || ((key, sub) => sub.title || sub.description || key);
		// Rule 4 counts the fields a section would DRAW, and a section whose
		// page is not a form has none — `pins` carries one hidden key and
		// exists for the chip the page draws from /api/v1/pinmux. Listed here
		// rather than special-cased, because the rule that drops an empty
		// section is the right rule and this is the exception to it.
		const custom = opts.custom instanceof Set ? opts.custom : new Set(opts.custom || []);
		const props = (schema && schema.properties) || {};
		const cache = {};
		// The whole-tree answers share this cache with the per-section ones, so
		// they are prefixed with a NUL -- a byte no schema section id can
		// contain, which is what keeps `groups` from colliding with a section
		// somebody names `groups`.
		//
		// Spelled as an escape and not written as a literal byte. It was a
		// literal one until this file needed searching: four raw NULs make
		// file(1) call the source `data`, and grep then SKIPS it without a
		// word -- a search for a string plainly in here comes back empty
		// rather than saying "0 matches". git grep is unaffected, which is why
		// it survived review for so long.
		const memo = (k, fn) => (k in cache ? cache[k] : (cache[k] = fn()));

		function groups() {
			return memo('\0groups', () => {
				const out = [];
				for (const g of (schema && schema['x-groups']) || []) {
					const secs = (g.sections || []).filter(s => props[s] && props[s].properties);
					if (secs.length) out.push({ id: g.id, label: g.label, sections: secs });
				}
				return out;
			});
		}

		// A group's x-live keys, in the deck's display order.
		function groupLiveFields(group) {
			const out = [];
			if (!group) return out;
			for (const section of group.sections) {
				const sp = (props[section] || {}).properties || {};
				for (const key of Object.keys(sp)) {
					if (!sp[key] || !sp[key]['x-live']) continue;
					if (exclude.has(section + '.' + key)) continue;
					out.push({ section, key, sub: sp[key], dot: section + '.' + key });
				}
			}
			out.sort((a, b) => {
				const ia = order.indexOf(a.key), ib = order.indexOf(b.key);
				return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
			});
			return out;
		}

		// Only the first such group owns the leaf: the tree keys on section id,
		// and two "Picture" entries would collide.
		function owner() {
			return memo('\0owner', () => groups().find(g => groupLiveFields(g).length) || null);
		}

		function liveFields() {
			const o = owner();
			return o ? groupLiveFields(o) : [];
		}

		// The dots the Live leaf mounts — rule 2.
		function lifted() {
			return memo('\0lifted', () => new Set(liveFields().map(f => f.dot)));
		}

		// Every leaf a section can render, flattened: {key, dot, sub, title,
		// hint, help} for each field the form would draw, so the search matches
		// the same words the page shows -- all three tiers, because the long
		// one is where the most identifying words end up. Nested objects recurse; the lifted keys are
		// left out unless `withLifted` asks for them (a caller resolving a
		// controlling field that happens to be one).
		function sectionFields(section, withLifted) {
			return memo(section + (withLifted ? '\0all' : ''), () => {
				const out = [];
				const walk = (basePath, p) => {
					for (const key of Object.keys(p)) {
						const dot = basePath + '.' + key;
						if (exclude.has(dot)) continue;
						const sub = p[key];
						if (!sub) continue;
						// A key the camera declares but has superseded: still in
						// the schema so the API and a hand-written config reach
						// it, deliberately not offered to a person. Skipped here
						// as well as in the form, or it counts as a key the tree
						// says belongs to a section and nothing ever draws.
						if (sub['x-hidden']) continue;
						if (!withLifted && lifted().has(dot)) continue;
						if (sub.type === 'object' && sub.properties) {
							walk(dot, sub.properties);
							continue;
						}
						if (!RENDERABLE.has(sub.type)) continue;
						out.push({ key, dot, sub, title: sub.title || sub.description || key,
							hint: sub.hint || '', help: sub.help || '' });
					}
				};
				const p = (props[section] || {}).properties;
				if (p) walk(section, p);
				return out;
			});
		}

		// Rule 3. The home has to be a section this schema carries, or the
		// leftovers would be absorbed into a page that does not exist.
		function leftoverHome(sec) {
			const h = LEFTOVER_HOME[sec];
			return h && props[h.home] && props[h.home].properties ? h : null;
		}

		function absorbed(sec) {
			const taken = liveFields().filter(f => f.section === sec).length;
			const left = sectionFields(sec).length;
			return taken > 0 && taken > left && (left === 0 || !!leftoverHome(sec));
		}

		// The absorbed sections whose leftovers `id`'s leaf draws, after its own.
		function homedAt(id) {
			return absorbedSections().filter(s =>
				sectionFields(s).length && leftoverHome(s).home === id);
		}

		function absorbedSections() {
			const o = owner();
			return o ? o.sections.filter(absorbed) : [];
		}

		// What a leaf draws. The Live leaf has no schema section of its own: it
		// draws the lifted keys and nothing else. Every other leaf draws its
		// whole section, then the leftovers of any section homed on it.
		function leafFields(id) {
			if (id === liveId) {
				// `hint` and `help` are carried here even though the Live leaf
				// draws NEITHER -- renderField skips both on a live row, where
				// a knob is four cells of an instrument with no room for prose.
				// So the search already counts hint words this leaf never puts
				// on screen, and help follows it rather than inventing a second
				// rule. Mirroring is deliberate: making the count honest would
				// change what the rail reports today, and that belongs in its
				// own change with its own test.
				const live = liveFields().map(f =>
					({ sub: f.sub, dot: f.dot, title: liveLabel(f.key, f.sub),
						hint: f.sub.hint || '', help: f.sub.help || '' }));
				return live;
			}
			return homedAt(id).reduce((acc, s) => acc.concat(sectionFields(s)), sectionFields(id));
		}

		// The navigable leaves of one group, in rail order: the Live leaf first
		// where the group owns it, then each section that still has something to
		// draw — rule 4.
		function leafIds(group) {
			const out = [];
			const o = owner();
			if (o && group && o.id === group.id) out.push(liveId);
			for (const s of (group && group.sections) || []) {
				if (absorbed(s)) continue;
				if (!custom.has(s) && !leafFields(s).length) continue;
				out.push(s);
			}
			return out;
		}

		return {
			groups, groupLiveFields, owner, liveFields, lifted, sectionFields,
			absorbed, absorbedSections, leafFields, leafIds, liveId,
			leftoverHome, homedAt,
			custom: () => custom,
		};
	}

	// Which heading a key sits under INSIDE its own section, in the order the
	// headings appear. This is presentation and nothing else: the daemon owns
	// precedence, reload class and defaults and declares them in its schema,
	// while where a row is drawn on the page has always been this file's
	// business, as leaf placement is.
	//
	// A key named nowhere here still renders — after the last group, with no
	// heading — so a setting the daemon adds tomorrow appears rather than
	// vanishing. tests/tree.test.js fails the build if a nightMode key ends up
	// both ungrouped and visible, because a row that is not there looks exactly
	// like a page that never had one.
	//
	// nightMode is flat in the schema, so without this the whole of Day / Night
	// arrives as one undifferentiated deal of nineteen controls (#325).
	const SECTION_GROUPS = {
		nightMode: [
			// What day and night is, and what it moves: whether the camera
			// switches on its own, and then the filter and the lamp, each
			// saying whether day and night moves it, whether you do, or
			// whether nothing does.
			//
			// Those two had a heading of their own for one release, and the
			// reporter who asked for them here in the first place said why it
			// could not work: a heading states something, and "driven by
			// day/night" is contradicted by the row under it the moment that row
			// reads manual or off (#548). Next to "Automatic day/night" the
			// relationship is read off the rows, which can say either answer.
			{ id: 'switching', label: 'Switching', keys: ['lightMonitor', 'irCut', 'backlight'] },
			// Second, and the position is load-bearing rather than editorial.
			// The cut is taken at the best heading boundary there is, so the
			// ORDER of the groups decides which boundaries exist: with these two
			// rows last, the only usable cut leaves 458px of column beside
			// 1133, and between Switching and the numbers it leaves 666 beside
			// 925. Both are legal and one of them is a card with a column of
			// white down its left. Measured on a camera at 1280 and 2560, not
			// counted: the rows differ enough in height -- a switch against a
			// slider with a two-line hint -- that counting them predicts the cut
			// badly.
			//
			// It reads better here too: what night looks like is a plainer
			// question than what the thresholds are, and Colorless night mode is
			// asked for far more often than any number below it.
			{ id: 'picture', label: 'Night picture', keys: ['colorToGray', 'overrideDrc'] },
			// What is left to the lamp once its own control is above: the
			// channel, rate, duty, curve and highlight backoff of a dimmable
			// one, on a build that has them. On one that has not, the heading
			// is dropped rather than drawn empty, which is what it already did
			// for these same keys. Named for the dimming rather than for the
			// lamp, so that it does not repeat the words of the Camera light
			// row above it.
			//
			// The curve and the backoff were named nowhere here until a real
			// hi3516ev300 was asked what it declares. They rendered anyway --
			// an unplaced key falls in after the last group -- and this group
			// was last, so they landed under the right heading by luck and
			// looked entirely correct. That is the same fault as the pause
			// inside a switch (#550), minus the symptom. tests/tree.test.js
			// could not see it either: its fixture predated both keys, so the
			// assertion that every key is placed was reading a schema no
			// camera has had for a while.
			//
			// Before the numbers rather than after them, which costs a camera
			// without these keys nothing at all -- the group is not drawn, so
			// the order it would have had cannot matter -- and buys a camera
			// with them a cut that balances: 1441px beside 925 where putting
			// it last gave 1575 beside 791. It reads the same way round as
			// Night picture above: what the camera DOES first, the numbers
			// that time it last.
			{ id: 'lamp', label: 'Dimmable lamp', keys: [
				'backlightPwmChannel', 'backlightPwmFreq',
				'backlightPwmMin', 'backlightPwmMax',
				'backlightPwmGamma', 'backlightHighlightPct'] },
			// The numbers that decide when, kept as a heading of their own rather
			// than piled under Switching. Not taste: the section is dealt into two
			// columns and the cut is taken between headings wherever one will
			// serve, because a cut inside a group opens the second column on a row
			// with no heading over it (#325). A Switching that held all ten of
			// these rows leaves no between-heading cut that balances, and
			// layoutCols falls back to cutting anywhere.
			//
			// Both mechanisms' numbers are here and only one pair is ever on
			// screen. Which of them is the Legacy switch's business, and that
			// switch is drawn at the head of this group rather than among the
			// switches above: every row it reveals or hides is in here, and a
			// control a column away from everything it moves is one whose
			// effect nobody sees. It has no key of its own, so mj-settings.js
			// mounts it against the first of these rows instead of being named
			// here.
			//
			// The pause inside a switch is here as well — it is the gap between
			// the picture changing and the filter swinging, which is the switch
			// taking place and nothing the lamp does.
			{ id: 'levels', label: 'Levels and timing', keys: [
				'autoNightGain', 'autoDayGain', 'autoNightDelay', 'autoDayDelay',
				'minThreshold', 'maxThreshold', 'monitorDelay', 'transitionDelayMs'] },
		],
		// The isp rows lifted onto the Live leaf, in the order an owner needs
		// them: the two switches that decide everything below, then the
		// limits, then how auto-exposure moves, then picture processing, and
		// last the switch only an image-quality engineer with a tuning tool
		// attached should ever touch. It sat second, straight under Exposure
		// mode, because schema order put it there.
		//
		// Headings that stay true in both exposure modes, because the rows
		// under them change meaning with it and a heading does not (#548):
		// "Limits" would be false the moment the mode reads manual, where the
		// same numbers are the values themselves. The rows' own names carry
		// that -- the daemon renames them per mode (#582).
		//
		// The first group has no label: it orders the two switches ahead of
		// everything without a heading over them. Every lifted isp key is
		// named somewhere, because one left out would be drawn ahead of the
		// first heading -- and tests/tree.test.js says so if it is.
		//
		// `fold` puts a group behind one disclosure of that name, shared by
		// consecutive groups naming the same one. The Picture page is where an
		// owner comes for the picture, and eleven exposure rows under it read
		// as the page's subject (#585): the two switches and dehaze stay out,
		// the numbers fold. The page opens the fold by itself whenever a row
		// in it holds a value or an unsaved edit, so nothing in force is ever
		// out of sight. Folded groups go last, since a fold is one block.
		isp: [
			{ id: 'mode', label: '', keys: ['aeMode', 'slowShutter'] },
			// Not "Picture": that is the name of the page this card is on.
			{ id: 'picture', label: 'Clarity', keys: ['dehaze'] },
			{ id: 'exposure', label: 'Exposure and gain', fold: 'More exposure settings',
				keys: ['exposure', 'aGain', 'dGain', 'ispGain'] },
			// Ahead of How it reacts, not after it: the fold is dealt into two
			// columns and cut only between headings, and last it left four
			// rows beside seven -- 560px of column beside 1030. Here it closes
			// the first column under the gains.
			{ id: 'tuning', label: 'For tuning engineers', fold: 'More exposure settings',
				keys: ['externalTuner'] },
			// `activeWhen` is the note's claim as a condition: the page sets
			// these rows back while the mode says otherwise. They stay
			// editable -- the daemon writes them in manual too, so a value is
			// in place the moment automatic comes back.
			{ id: 'reacts', label: 'How it reacts', note: 'in automatic mode',
				fold: 'More exposure settings',
				activeWhen: { field: 'aeMode', equals: 'auto' },
				keys: ['meterRect', 'aeStrategy', 'aeSpeed', 'aeTolerance', 'aeBlackDelay', 'aeWhiteDelay'] },
		],
	};
	function sectionGroups(section) { return SECTION_GROUPS[section] || null; }

	// Keys a section draws through a control of its own rather than as a row:
	// Day / Night's four pads and the three polarity switches that belong to
	// them are edited on the pin map. They are still real fields — rendered
	// hidden, so Save, dirty tracking and the per-row reset never learn a map
	// exists — which is why they are named here rather than excluded. Naming
	// them beside the groups keeps one answer to "where is this key drawn".
	const SECTION_MAP_DRIVEN = {
		nightMode: ['irCutPin1', 'irCutPin2', 'backlightPin', 'lightSensorPin',
			'irCutSingleInvert', 'backlightInvert', 'lightSensorInvert'],
	};
	function mapDriven(section) { return SECTION_MAP_DRIVEN[section] || []; }

	const api = { build, RENDERABLE, sectionGroups, mapDriven };
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticTree = api;
})();
