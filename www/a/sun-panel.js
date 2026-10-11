// The sun on the Day / Night page: where the camera is, the angle of the sun
// that means night, and what that comes to tonight.
//
// The camera can switch day and night by the sun's height instead of by the
// picture (nightMode.switchBy), and light its white lamp by it
// (nightMode.whiteLight: sun). Both are set as an ANGLE, because a given
// depression of the sun is about the same light everywhere while "sunset plus
// half an hour" is nearly night in one place and broad daylight in another.
// An angle is a poor thing to ask anybody for as a bare number, so it is
// chosen on a strip drawn like the twilight diagram -- day, civil, nautical --
// with tonight's time under each named line.
//
// What this refuses to do:
//
// - Compute a time. Every time on it comes from the camera (GET /api/v1/sun),
//   in the camera's own time zone, which is not necessarily the browser's. A
//   place typed but not yet saved is asked about too, so the times move as it
//   is typed.
// - Say anything about a night it cannot know. With no place, no clock, or a
//   night the sun does not reach the chosen line, it says which, in words --
//   most of all the white night: a camera told "night at nautical dusk" in
//   Moscow in June otherwise looks set up and never goes to night, and the
//   page is the only place that can warn about it before it happens.
// - Save anything. It drives four ordinary fields that are on the page but
//   hidden -- the two angles and calibration.latitude/longitude -- through
//   setValue, so Save, dirty tracking and the per-row reset work on them
//   exactly as on every other row (the nightMode pin map's pattern). A guess
//   at the place from the time zone is staged like any edit, never saved by
//   itself.
(function () {
	'use strict';

	const TOP = 6, BOTTOM = -12;          // the strip's range, as the schema's
	const NAMED = [0, -6, -12];           // the lines drawn and timed
	const SUN_MODES = ['sun', 'pictureNearSun'];

	// Where on the strip an angle sits, as a percentage from its left (day)
	// end to its right (night) end.
	function at(angle) {
		return (TOP - angle) / (TOP - BOTTOM) * 100;
	}

	function angleWords(a) {
		if (a === 0) return 'the horizon';
		return Math.abs(a) + '° ' + (a < 0 ? 'below' : 'above') + ' the horizon';
	}

	// Whether anything on this camera asks the sun.
	function sunUsed(switchBy, whiteLight) {
		return SUN_MODES.indexOf(switchBy) >= 0 || whiteLight === 'sun';
	}

	function lineAt(report, angle) {
		const lines = (report && report.lines) || [];
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].angle === angle) return lines[i];
		}
		return null;
	}

	// What tonight comes to, from the camera's report, for a night angle and
	// a day angle. Pure: it is the sentence the strip stands under, and a
	// sentence reads as confidently when it picks the wrong line as when it
	// picks the right one (tests/sun-panel.test.js).
	//
	// `names` maps an angle to its name on each side ({night:{-6:'Civil
	// dusk'}, day:{-6:'Civil dawn'}}), from the schema's x-special.
	function tonight(report, nightDeg, dayDeg, names) {
		names = names || { night: {}, day: {} };
		const marks = NAMED.map((a) => {
			const l = lineAt(report, a);
			return {
				angle: a,
				at: at(a),
				name: names.night[a] || angleWords(a),
				dusk: l ? l.dusk : null,
				dawn: l ? l.dawn : null,
			};
		});
		if (!report) return { state: 'unknown', marks: marks, sentence: '' };
		if (!report.place) {
			return {
				state: 'place', marks: marks,
				sentence: 'Say where the camera is, and the sun can be asked. Until then the picture decides.',
			};
		}
		if (!report.clock) {
			return {
				state: 'clock', marks: marks,
				sentence: 'The camera\'s clock has not been set yet, so where the sun is cannot be known. ' +
					'The picture decides until the clock is set.',
			};
		}
		const day = dayDeg === null || dayDeg === undefined || dayDeg === '' ? nightDeg : Math.max(+dayDeg, +nightDeg);
		const n = lineAt(report, Math.round(nightDeg));
		const d = lineAt(report, Math.round(day));
		const lowest = typeof report.lowest === 'number' ? report.lowest : null;
		const highest = typeof report.highest === 'number' ? report.highest : null;
		if (!n || (!n.dusk && !n.dawn && lowest !== null && lowest >= nightDeg)) {
			return {
				state: 'no-night', marks: marks,
				sentence: 'Tonight the sun here does not go down to ' + angleWords(+nightDeg) +
					(lowest !== null ? ' — it gets no lower than ' + angleWords(Math.round(lowest)) : '') +
					' — so tonight the picture decides.',
			};
		}
		if (!d || (!d.dawn && highest !== null && highest < day)) {
			return {
				state: 'no-day', marks: marks,
				sentence: 'The sun here does not get up to ' + angleWords(day) +
					' today, so the picture decides when day comes.',
			};
		}
		return {
			state: 'ok', marks: marks,
			dusk: n.dusk, dawn: d.dawn,
			sentence: 'Tonight: night from ' + (n.dusk || '—') + ', day again from ' + (d.dawn || '—') + '.',
		};
	}

	function el(tag, cls, text) {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text !== undefined) e.textContent = text;
		return e;
	}

	// The panel. `o` is what the settings page lends it:
	//   anchor     the row it is inserted after
	//   field(dot) the page's field object for a dotted key, or null
	//   set(dot,v) stage a value the way an edit would
	//   report(lat, lon) -> Promise of /api/v1/sun's answer, or null
	//   zone       the camera's time zone name, for the guess
	//   places()   -> Promise of the zone table, loaded only when asked for
	//   P          window.MajesticSunPlace
	//   names      {night:{angle:name}, day:{angle:name}}
	function mount(o) {
		const P = o.P;
		const f = (k) => o.field(k);
		const lat = f('calibration.latitude'), lon = f('calibration.longitude');
		const nightF = f('nightMode.sunNightAngle'), dayF = f('nightMode.sunDayAngle');
		const byF = f('nightMode.switchBy'), whiteF = f('nightMode.whiteLight');
		const monF = f('nightMode.lightMonitor');
		if (!nightF) return null;

		const root = el('div', 'mj-sun');

		// Where the camera is. Always shown: it is the first thing the sun
		// needs, and an owner choosing "The sun" must be able to find it.
		let placeBox = null, placeNote = null, guessBtn = null;
		if (lat && lon) {
			const row = el('p', 'string mj-row mj-sun-place');
			const id = 'mj-sun-place';
			row.innerHTML =
				'<label class="form-label" for="' + id + '">Where the camera is</label>' +
				'<span class="mj-ctl"><span class="mj-ctl-in">' +
				'<input type="text" class="form-control" id="' + id + '" autocomplete="off" spellcheck="false" ' +
				'placeholder="55.7558, 37.6173 — or paste a map link">' +
				'</span></span>' +
				'<span class="hint text-secondary">Latitude and longitude, or a link from a map.</span>';
			placeBox = row.querySelector('input');
			placeNote = el('div', 'hint mj-requires mj-sun-place-note');
			placeNote.hidden = true;
			row.appendChild(placeNote);
			guessBtn = el('button', 'btn btn-link btn-sm p-0 mj-sun-guess');
			guessBtn.type = 'button';
			guessBtn.hidden = true;
			row.appendChild(guessBtn);
			root.appendChild(row);
		}

		// A choice of what to switch by does nothing while nothing switches.
		// Said here, only while it is true: the schema cannot scope a note to
		// "any choice but the picture", and one under the row on every camera
		// with the monitor off would be a note nobody reads.
		const monNote = el('div', 'hint mj-requires mj-sun-monitor-note');
		monNote.hidden = true;
		monNote.textContent = 'Automatic day/night is off, so nothing switches yet — ' +
			'this choice takes effect once it is on.';
		root.appendChild(monNote);

		// The strip.
		const stripBox = el('div', 'mj-sun-strip-box');
		const strip = el('div', 'mj-sun-strip');
		strip.setAttribute('aria-hidden', 'true');
		['day', 'civil', 'nautical'].forEach((b) => strip.appendChild(el('span', 'mj-sun-band mj-sun-' + b)));
		const nowMark = el('span', 'mj-sun-now');
		nowMark.title = 'Where the sun is now';
		strip.appendChild(nowMark);
		const nightMark = el('span', 'mj-sun-pick mj-sun-pick-night');
		const dayMark = el('span', 'mj-sun-pick mj-sun-pick-day');
		strip.appendChild(dayMark);
		strip.appendChild(nightMark);
		stripBox.appendChild(strip);

		const marksRow = el('div', 'mj-sun-marks');
		stripBox.appendChild(marksRow);

		// Two sliders on the strip's own scale: left is the sun high, right
		// is the sun low, so the value is the angle negated.
		function slider(label, id) {
			const p = el('p', 'range mj-row mj-sun-slider');
			p.innerHTML = '<label class="form-label" for="' + id + '">' + label + '</label>' +
				'<span class="mj-ctl"><span class="mj-ctl-in">' +
				'<input type="range" class="form-range" id="' + id + '" min="' + (-TOP) + '" max="' + (-BOTTOM) + '" step="1">' +
				'<span class="show-value"></span></span></span>';
			stripBox.appendChild(p);
			return { p: p, input: p.querySelector('input'), out: p.querySelector('.show-value') };
		}
		const nightS = slider('Night once the sun is down to', 'mj-sun-night');
		let sameBox = null, dayS = null;
		if (dayF) {
			const same = el('p', 'boolean mj-row mj-sun-same');
			same.innerHTML = '<span class="form-check form-switch">' +
				'<input type="checkbox" class="form-check-input" id="mj-sun-same">' +
				'<label class="form-check-label" for="mj-sun-same">The same angle at dawn</label></span>';
			stripBox.appendChild(same);
			sameBox = same.querySelector('input');
			dayS = slider('Day again once the sun is up to', 'mj-sun-day');
		}
		const sentence = el('div', 'hint mj-sun-sentence');
		stripBox.appendChild(sentence);
		root.appendChild(stripBox);

		o.anchor.parentNode.insertBefore(root, o.anchor.nextSibling);

		let report = null, asked = '', timer = null, reportSeq = 0, guessAsked = false;

		const num = (fld) => {
			const v = fld ? fld.getValue() : '';
			return v === '' || v === null || v === undefined ? null : +v;
		};
		const place = () => {
			const a = num(lat), b = num(lon);
			return a === null || b === null || (a === 0 && b === 0) ? null : { lat: a, lon: b };
		};
		const nightDeg = () => {
			const v = num(nightF);
			return v === null ? -6 : v;
		};
		const dayDeg = () => num(dayF);
		const by = () => (byF ? byF.getValue() : 'picture');
		const white = () => (whiteF ? whiteF.getValue() : 'auto');

		function nameOf(a, side) {
			return (o.names[side] && o.names[side][a]) || angleWords(a);
		}
		// "Civil dusk, 6° below the horizon"; an unnamed line by its angle.
		function readout(a, side) {
			const n = o.names[side] && o.names[side][a];
			return n ? n + ', ' + angleWords(a) : angleWords(a);
		}

		// The sun choices need a place. Disabled, with the reason, while there
		// is none -- unless one of them is what the camera is set to now or
		// was saved with, which is taken away from nobody: moving off a saved
		// choice must not make it impossible to come back to.
		function gateChoices(hasPlace) {
			[[byF, SUN_MODES], [whiteF, ['sun']]].forEach(([fld, modes]) => {
				if (!fld || !fld.control || !fld.control.options) return;
				const saved = o.initial ? o.initial(fld.dot) : undefined;
				Array.prototype.forEach.call(fld.control.options, (op) => {
					if (modes.indexOf(op.value) < 0) return;
					op.disabled = !hasPlace && op.value !== fld.getValue() && op.value !== saved;
					op.title = op.disabled ? 'Say where the camera is first' : '';
				});
			});
		}

		function paintPlace() {
			if (!placeBox) return;
			const p = place();
			if (document.activeElement !== placeBox) {
				placeBox.value = P.formatPlace(p);
				// The box now shows what is staged, so a complaint about
				// what was typed before no longer describes it.
				if (placeNote.dataset.err) {
					placeNote.dataset.err = '';
					placeNote.hidden = true;
				}
			}
			// The zone's table is wanted only while there is no place to
			// show, and is fetched at most once (the page keeps the promise).
			if (!p && !o.guess && o.zone && o.places && !guessAsked) {
				guessAsked = true;
				o.places().then((table) => {
					o.guess = P.guessFromZone(o.zone, table);
					paintPlace();
				});
			}
			if (guessBtn) {
				const g = o.guess;
				guessBtn.hidden = !g || !!p;
				if (g) guessBtn.textContent = 'Use ' + g.city + ', the time zone\'s city, as a first guess';
			}
		}

		function paintStrip() {
			const nd = nightDeg(), dd = dayDeg();
			const same = dd === null;
			nightS.input.value = String(-nd);
			nightS.out.textContent = readout(nd, 'night');
			nightMark.style.left = at(nd) + '%';
			if (dayS) {
				sameBox.checked = same;
				dayS.p.hidden = same;
				const d = same ? nd : Math.max(dd, nd);
				dayS.input.value = String(-d);
				dayS.out.textContent = readout(d, 'day');
				dayMark.style.left = at(d) + '%';
				dayMark.hidden = same;
			}
			const t = tonight(report, nd, same ? null : dd, o.names);
			marksRow.textContent = '';
			t.marks.forEach((m) => {
				const reached = !!(m.dusk || m.dawn);
				const box = el('span', 'mj-sun-mark' + (report && report.place && report.clock && !reached ? ' mj-sun-mark-missing' : ''));
				// Right-aligned to its own line, over the band before it, so
				// each label has a third of the strip and none can run into
				// the next however narrow the column is.
				box.style.right = (100 - m.at) + '%';
				box.appendChild(el('span', 'mj-sun-mark-name', nameOf(m.angle, 'night')));
				box.appendChild(el('span', 'mj-sun-mark-time',
					!report || !report.place || !report.clock ? '' :
						reached ? (m.dusk || '—') + ' · ' + (m.dawn || '—') : 'not tonight'));
				marksRow.appendChild(box);
			});
			const showNow = report && typeof report.elevation === 'number' &&
				report.elevation <= TOP && report.elevation >= BOTTOM;
			nowMark.hidden = !showNow;
			if (showNow) nowMark.style.left = at(report.elevation) + '%';
			sentence.textContent = t.sentence;
			sentence.classList.toggle('mj-requires', t.state !== 'ok' && t.state !== 'unknown');
		}

		function paint() {
			const used = sunUsed(by(), white());
			if (monF) {
				const m = monF.getValue();
				monNote.hidden = by() === 'picture' || m === true || String(m) === 'true';
			}
			stripBox.hidden = !used;
			gateChoices(!!place());
			paintPlace();
			if (placeNote && !placeNote.dataset.err) {
				// The reason a sun choice is greyed out, said once, here.
				placeNote.hidden = !!place() || !used;
				placeNote.textContent = 'The sun choices need this.';
			}
			paintStrip();
		}

		// Ask the camera about the place on the page -- saved or not.
		function ask() {
			const p = place();
			const key = p ? p.lat + ',' + p.lon : '';
			if (key === asked && report) {
				paint();
				return;
			}
			asked = key;
			const mine = ++reportSeq;
			// No place on the page is asked about AS no place (0, 0 is the
			// camera's own "not said"), never as the saved one: an owner who
			// has just emptied the box must not see the times it had.
			const none = lat && lon;
			o.report(p ? p.lat : none ? 0 : null, p ? p.lon : none ? 0 : null).then((r) => {
				if (mine !== reportSeq) return; // a newer place was asked about
				report = r;
				paint();
			});
		}

		if (placeBox) {
			placeBox.addEventListener('input', () => {
				const s = placeBox.value.trim();
				const p = P.parsePlace(s);
				placeNote.dataset.err = '';
				if (!s) {
					o.set('calibration.latitude', '');
					o.set('calibration.longitude', '');
				} else if (p) {
					o.set('calibration.latitude', String(p.lat));
					o.set('calibration.longitude', String(p.lon));
				} else {
					placeNote.dataset.err = '1';
					placeNote.hidden = false;
					placeNote.textContent = 'Not a place this can read: two numbers, latitude first, or a map link.';
					return;
				}
				clearTimeout(timer);
				timer = setTimeout(ask, 400);
				paint();
			});
			placeBox.addEventListener('blur', paintPlace);
		}
		if (guessBtn) {
			guessBtn.addEventListener('click', () => {
				const g = o.guess;
				if (!g) return;
				placeNote.dataset.err = '';
				placeNote.hidden = true;
				o.set('calibration.latitude', String(g.lat));
				o.set('calibration.longitude', String(g.lon));
				placeBox.value = P.formatPlace(g);
				ask();
			});
		}
		nightS.input.addEventListener('input', () => {
			const nd = -(+nightS.input.value);
			o.set('nightMode.sunNightAngle', String(nd));
			// A day line under the new night line is not a band; it follows.
			const dd = dayDeg();
			if (dd !== null && dd < nd) o.set('nightMode.sunDayAngle', String(nd));
			paint();
		});
		if (dayS) {
			sameBox.addEventListener('change', () => {
				o.set('nightMode.sunDayAngle', sameBox.checked ? '' : String(nightDeg()));
				paint();
			});
			dayS.input.addEventListener('input', () => {
				const d = Math.max(-(+dayS.input.value), nightDeg());
				o.set('nightMode.sunDayAngle', String(d));
				paint();
			});
		}
		[byF, whiteF, monF].forEach((fld) => {
			if (fld && fld.control) fld.control.addEventListener('change', paint);
		});

		ask();
		// Tonight's times move; a page left open overnight should not keep
		// yesterday's. Ten minutes is finer than anyone reads them.
		const refresh = setInterval(() => {
			// The page draws one section at a time; once this one is gone, so
			// is the reason to ask.
			if (!root.isConnected) {
				clearInterval(refresh);
				return;
			}
			asked = '';
			ask();
		}, 600000);

		return {
			// After a save or a reset the fields hold new values: draw them.
			sync: () => { ask(); },
			destroy: () => { clearInterval(refresh); clearTimeout(timer); },
		};
	}

	const api = { mount: mount, tonight: tonight, sunUsed: sunUsed, at: at, angleWords: angleWords };
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticSunPanel = api;
})();
