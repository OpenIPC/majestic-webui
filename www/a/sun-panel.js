// The sun on the Day / Night page: where the camera is, the angle of the sun
// that means night, and what that comes to tonight.
//
// The camera can switch day and night by the sun's height instead of by the
// picture, and light its white lamp by it. Both are set as an ANGLE, because a
// given depression of the sun is about the same light everywhere while "sunset
// plus half an hour" is nearly night in one place and broad daylight in
// another. An angle is a poor thing to ask anybody for as a bare number, so it
// is chosen on a strip drawn like the twilight diagram, with tonight's time
// under each named line.
//
// Everything about which controls these are comes from the schema, never from
// a key's name: the two angles say which line of twilight they are
// (`x-twilight`), the strip's range is their minimum and maximum, its named
// lines are their `x-special` values, they are shown by their own
// `visibleWhen`, and the place is the pair of fields that say which axis they
// are (`x-geo`). The page hands those fields in; this module does not know a
// single key.
//
// What this refuses to do:
//
// - Compute a time. Every time on it comes from the camera (GET /api/v1/sun),
//   in the camera's own time zone, which is not necessarily the browser's. A
//   place typed but not yet saved is asked about too, so the times move as it
//   is typed -- and while a new answer is on its way, the old one is not shown
//   as though it were about the new place.
// - Say anything about a night it cannot know. With no place, no clock, a
//   reply missing what it needs, or a night the sun does not reach the chosen
//   line, it says which, in words, or nothing -- most of all the white night: a
//   camera told "night at nautical dusk" in Moscow in June otherwise looks set
//   up and never goes to night, and the page is the only place that can warn
//   about it before it happens.
// - Save anything. It drives ordinary fields that are on the page but hidden,
//   through setValue, so Save, dirty tracking and the per-row reset work on
//   them exactly as on every other row (the nightMode pin map's pattern). A
//   guess at the place from the time zone is staged like any edit, never saved
//   by itself; text that does not read as a place stages nothing, and puts
//   back what was there.
(function () {
	'use strict';

	function angleWords(a) {
		if (a === 0) return 'the horizon';
		return Math.abs(a) + '° ' + (a < 0 ? 'below' : 'above') + ' the horizon';
	}

	// The strip's scale, from the night angle's schema entry: its range and
	// its named lines (x-special), highest first. Null when the schema does not
	// give a usable range -- then there is no strip to draw, and the rows stay
	// ordinary rows.
	function scale(schema) {
		const top = schema && Number(schema.maximum);
		const bottom = schema && Number(schema.minimum);
		if (!Number.isFinite(top) || !Number.isFinite(bottom) || top <= bottom) return null;
		const lines = Object.keys((schema && schema['x-special']) || {})
			.map(Number).filter((a) => Number.isFinite(a) && a < top && a >= bottom)
			.sort((a, b) => b - a);
		return { top: top, bottom: bottom, lines: lines };
	}

	// Where on the strip an angle sits, as a percentage from its left (day)
	// end to its right (night) end.
	function at(sc, angle) {
		return (sc.top - angle) / (sc.top - sc.bottom) * 100;
	}

	function lineAt(report, angle) {
		const lines = report && Array.isArray(report.lines) ? report.lines : [];
		for (let i = 0; i < lines.length; i++) {
			if (lines[i] && lines[i].angle === angle) return lines[i];
		}
		return null;
	}

	const isTime = (v) => typeof v === 'string' && /^\d\d:\d\d$/.test(v);

	// What tonight comes to, from the camera's report, for a night angle and
	// a day angle. Pure: it is the sentence the strip stands under, and a
	// sentence reads as confidently when it picks the wrong line as when it
	// picks the right one (tests/sun-panel.test.js).
	//
	// A reply is believed only as far as it goes. `place` and `clock` must be
	// booleans; a verdict that the sun does not reach a line needs the day's
	// lowest (or highest) reading to say so; and "night from" needs the times.
	// Anything short of that is state 'unknown' with no sentence, because a
	// failed or half-read reply is not a fact about the sky.
	//
	// `names` maps an angle to its name on each side ({night:{-6:'Civil
	// dusk'}, day:{-6:'Civil dawn'}}), and `lines` lists the named angles.
	function tonight(report, nightDeg, dayDeg, names, lines) {
		names = names || { night: {}, day: {} };
		const marks = (lines || []).map((a) => {
			const l = lineAt(report, a);
			return {
				angle: a,
				name: names.night[a] || angleWords(a),
				dusk: l && isTime(l.dusk) ? l.dusk : null,
				dawn: l && isTime(l.dawn) ? l.dawn : null,
			};
		});
		const unknown = { state: 'unknown', marks: marks, sentence: '' };
		if (!report || typeof report.place !== 'boolean' || typeof report.clock !== 'boolean') {
			return unknown;
		}
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
		if (lowest !== null && lowest >= nightDeg) {
			return {
				state: 'no-night', marks: marks,
				sentence: 'Tonight the sun here does not go down to ' + angleWords(+nightDeg) +
					' — it gets no lower than ' + angleWords(Math.round(lowest)) +
					' — so tonight the picture decides.',
			};
		}
		if (highest !== null && highest < day) {
			return {
				state: 'no-day', marks: marks,
				sentence: 'The sun here does not get up to ' + angleWords(day) +
					' today, so the picture decides when day comes.',
			};
		}
		if (!n || !d || !isTime(n.dusk) || !isTime(d.dawn)) return unknown;
		return {
			state: 'ok', marks: marks,
			dusk: n.dusk, dawn: d.dawn,
			sentence: 'Tonight: night from ' + n.dusk + ', day again from ' + d.dawn + '.',
		};
	}

	function el(tag, cls, text) {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text !== undefined) e.textContent = text;
		return e;
	}

	// The panel. `o` is what the settings page lends it:
	//   night, day   the two angle fields (x-twilight), day may be null
	//   lat, lon     the two place fields (x-geo), either may be null
	//   set(f, v)    stage a value on a field the way an edit would
	//   initial(f)   the value a field was saved with
	//   visible()    whether the angles' own visibleWhen holds just now
	//   onChange(fn) call fn after any edit on the page
	//   report(lat, lon) -> Promise of /api/v1/sun's answer, or null
	//   zone         the camera's time zone name, for the guess
	//   places()     -> Promise of the zone table, fetched only when asked for
	//   P            window.MajesticSunPlace
	function mount(o) {
		const P = o.P;
		const nightF = o.night, dayF = o.day, lat = o.lat, lon = o.lon;
		const sc = nightF && scale(nightF.schema);
		if (!sc || !nightF.p || !nightF.p.parentNode) return null;
		const names = {
			night: (nightF.schema && nightF.schema['x-special']) || {},
			day: (dayF && dayF.schema && dayF.schema['x-special']) || {},
		};

		const root = el('div', 'mj-sun');

		// Where the camera is. Shown whenever the place fields are there,
		// whatever is chosen: it is what the sun choices wait for, and an owner
		// who finds them held back has to be able to find this.
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

		// The strip: one band per stretch between named lines, banded the way
		// the twilight diagram is.
		const stripBox = el('div', 'mj-sun-strip-box');
		const strip = el('div', 'mj-sun-strip');
		strip.setAttribute('aria-hidden', 'true');
		const edges = [sc.top].concat(sc.lines).concat(sc.lines.indexOf(sc.bottom) >= 0 ? [] : [sc.bottom]);
		const bands = el('span', 'mj-sun-bands');
		for (let i = 0; i + 1 < edges.length; i++) {
			const band = el('span', 'mj-sun-band mj-sun-band-' + Math.min(i, 3));
			band.style.left = at(sc, edges[i]) + '%';
			band.style.width = (at(sc, edges[i + 1]) - at(sc, edges[i])) + '%';
			bands.appendChild(band);
		}
		strip.appendChild(bands);
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

		// Sliders on the strip's own scale: left is the sun high, right is the
		// sun low, so the value is the angle negated.
		function slider(label, id) {
			const p = el('p', 'range mj-row mj-sun-slider');
			p.innerHTML = '<label class="form-label" for="' + id + '">' + label + '</label>' +
				'<span class="mj-ctl"><span class="mj-ctl-in">' +
				'<input type="range" class="form-range" id="' + id + '" min="' + (-sc.top) +
				'" max="' + (-sc.bottom) + '" step="1">' +
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

		// Where the hidden angle rows are, so the panel sits where they would.
		nightF.p.parentNode.insertBefore(root, nightF.p);

		let report = null, asked = null, timer = null, reportSeq = 0, guessAsked = false;

		const num = (fld) => {
			const v = fld ? fld.getValue() : '';
			return v === '' || v === null || v === undefined ? null : +v;
		};
		const place = () => {
			const a = num(lat), b = num(lon);
			return a === null || b === null || (a === 0 && b === 0) ? null : { lat: a, lon: b };
		};
		const fallback = () => {
			const d = nightF.schema && Number(nightF.schema.default);
			return Number.isFinite(d) ? d : sc.lines[0] !== undefined ? sc.lines[0] : sc.bottom;
		};
		const nightDeg = () => {
			const v = num(nightF);
			return v === null ? fallback() : v;
		};
		const dayDeg = () => num(dayF);

		function readout(a, side) {
			const n = names[side] && names[side][a];
			return n ? n + ', ' + angleWords(a) : angleWords(a);
		}

		function showPlaceNote(text) {
			if (!placeNote) return;
			placeNote.hidden = !text;
			placeNote.textContent = text || '';
		}

		function paintPlace() {
			if (!placeBox) return;
			const p = place();
			if (document.activeElement !== placeBox) {
				placeBox.value = P.formatPlace(p);
				// The box now shows what is staged, so a complaint about what
				// was typed before no longer describes it.
				showPlaceNote('');
			}
			// The zone's table is wanted only while there is no place to show,
			// and is fetched at most once (the page keeps the promise).
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
			nightMark.style.left = at(sc, nd) + '%';
			if (dayS) {
				sameBox.checked = same;
				dayS.p.hidden = same;
				const d = same ? nd : Math.max(dd, nd);
				dayS.input.value = String(-d);
				dayS.out.textContent = readout(d, 'day');
				dayMark.style.left = at(sc, d) + '%';
				dayMark.hidden = same;
			}
			const t = tonight(report, nd, same ? null : dd, names, sc.lines);
			const known = t.state !== 'unknown' && t.state !== 'place' && t.state !== 'clock';
			marksRow.textContent = '';
			t.marks.forEach((m, i) => {
				const reached = !!(m.dusk || m.dawn);
				const box = el('span', 'mj-sun-mark' + (known && !reached ? ' mj-sun-mark-missing' : ''));
				// Right-aligned to its own line, over the band before it, so
				// each label has its band's width and none can run into the next
				// however narrow the column is.
				const from = i === 0 ? sc.top : sc.lines[i - 1];
				box.style.right = (100 - at(sc, m.angle)) + '%';
				box.style.width = (at(sc, m.angle) - at(sc, from)) + '%';
				box.appendChild(el('span', 'mj-sun-mark-name', m.name));
				box.appendChild(el('span', 'mj-sun-mark-time',
					!known ? '' : reached ? (m.dusk || '—') + ' · ' + (m.dawn || '—') : 'not tonight'));
				marksRow.appendChild(box);
			});
			const e = report && typeof report.elevation === 'number' ? report.elevation : null;
			const showNow = known && e !== null && e <= sc.top && e >= sc.bottom;
			nowMark.hidden = !showNow;
			if (showNow) nowMark.style.left = at(sc, e) + '%';
			sentence.textContent = t.sentence;
			sentence.classList.toggle('mj-requires', t.state !== 'ok' && t.state !== 'unknown');
		}

		function paint() {
			stripBox.hidden = !o.visible();
			paintPlace();
			paintStrip();
		}

		// Ask the camera about the place on the page -- saved or not. No place
		// on the page is asked about AS no place (0, 0 is the camera's own "not
		// said"), never as the saved one.
		function ask() {
			const p = place();
			const key = p ? p.lat + ',' + p.lon : '';
			if (key === asked && report) {
				paint();
				return;
			}
			asked = key;
			const mine = ++reportSeq;
			const none = !!(lat && lon);
			o.report(p ? p.lat : none ? 0 : null, p ? p.lon : none ? 0 : null).then((r) => {
				if (mine !== reportSeq) return; // a newer place was asked about
				report = r;
				paint();
			});
		}

		// A new place makes the answer in hand an answer about somewhere else:
		// it goes at once, and the strip says nothing until the new one lands.
		function forget() {
			report = null;
			asked = null;
			reportSeq++;
		}

		if (placeBox) {
			placeBox.addEventListener('input', () => {
				const s = placeBox.value.trim();
				const p = P.parsePlace(s);
				clearTimeout(timer);
				if (!s) {
					// Cleared: back to the camera's own "not said".
					o.set(lat, '0');
					o.set(lon, '0');
					showPlaceNote('');
				} else if (p) {
					o.set(lat, String(p.lat));
					o.set(lon, String(p.lon));
					showPlaceNote('');
				} else {
					// Not a place: nothing new is staged, and what was staged
					// before goes back to what is saved, so Save cannot carry
					// an earlier half-typed place the box no longer shows.
					o.set(lat, o.initial(lat));
					o.set(lon, o.initial(lon));
					forget();
					paintStrip();
					showPlaceNote('Not a place this can read: two numbers, latitude first, or a map link.');
					return;
				}
				forget();
				paintStrip();
				timer = setTimeout(ask, 400);
			});
			placeBox.addEventListener('blur', paintPlace);
		}
		if (guessBtn) {
			guessBtn.addEventListener('click', () => {
				const g = o.guess;
				if (!g) return;
				showPlaceNote('');
				o.set(lat, String(g.lat));
				o.set(lon, String(g.lon));
				placeBox.value = P.formatPlace(g);
				forget();
				ask();
			});
		}
		nightS.input.addEventListener('input', () => {
			const nd = -(+nightS.input.value);
			o.set(nightF, String(nd));
			// A day line under the new night line is not a band; it follows.
			const dd = dayDeg();
			if (dayF && dd !== null && dd < nd) o.set(dayF, String(nd));
			paint();
		});
		if (dayS) {
			sameBox.addEventListener('change', () => {
				o.set(dayF, sameBox.checked ? '' : String(nightDeg()));
				paint();
			});
			dayS.input.addEventListener('input', () => {
				const d = Math.max(-(+dayS.input.value), nightDeg());
				o.set(dayF, String(d));
				paint();
			});
		}
		const off = o.onChange(paint);

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
			asked = null;
			ask();
		}, 600000);

		return {
			// After a save or a reset the fields hold new values: draw them.
			sync: () => { asked = null; ask(); },
			destroy: () => {
				clearInterval(refresh);
				clearTimeout(timer);
				if (typeof off === 'function') off();
			},
		};
	}

	const api = { mount: mount, tonight: tonight, scale: scale, at: at, angleWords: angleWords };
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticSunPanel = api;
})();
