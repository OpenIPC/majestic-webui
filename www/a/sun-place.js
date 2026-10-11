// Where the camera is, read out of whatever the owner pastes.
//
// The sun needs a latitude and a longitude, and over plain HTTP the browser
// will not give the page one: navigator.geolocation is refused outside a
// secure context, which is every camera on a LAN. So the owner brings the
// place themselves -- typed, or pasted out of a map they already have open --
// and this turns it into the two numbers calibration.latitude and
// calibration.longitude hold.
//
// Pure, and tested (tests/sun-place.test.js), because every way of getting it
// wrong is silent. A pasted link whose two numbers are read the wrong way round
// still yields a place, just one in another hemisphere or another continent,
// and the camera then switches at somebody else's dusk with nothing on the page
// looking wrong. Yandex writes longitude FIRST in its links, which is exactly
// that trap; so does a Google place link's @ centre when the pin is elsewhere,
// which is why its !3d/!4d pair wins.
//
// What it refuses to do is guess between readings. A bare pair is read
// latitude first, as everyone writes one; a link is read by its host's own
// convention; anything else is no answer, never a best effort.
(function () {
	'use strict';

	const NUM = '([+-]?\\d+(?:\\.\\d+)?)';

	function valid(lat, lon) {
		return Number.isFinite(lat) && Number.isFinite(lon) &&
			lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 &&
			!(lat === 0 && lon === 0);
	}

	function pair(lat, lon) {
		const a = parseFloat(lat), b = parseFloat(lon);
		return valid(a, b) ? { lat: a, lon: b } : null;
	}

	// The first match of `re` in `s`, as numbers in the order given.
	function grab(s, re, lonFirst) {
		const m = re.exec(s);
		if (!m) return null;
		return lonFirst ? pair(m[2], m[1]) : pair(m[1], m[2]);
	}

	function fromLink(s) {
		let url;
		try {
			url = new URL(s);
		} catch (e) {
			return null;
		}
		const host = url.hostname.toLowerCase();
		const q = url.searchParams;
		let all;
		try {
			all = decodeURIComponent(url.href);
		} catch (e) {
			all = url.href; // a stray "%": read what is there as it stands
		}

		// geo:55.75,37.62 -- RFC 5870, latitude first.
		if (url.protocol === 'geo:') {
			return grab(url.pathname, new RegExp('^' + NUM + ',' + NUM));
		}

		// Yandex: ll, pt and whatshere[point] are all longitude,latitude. A
		// route (mode=routes, rtext) is two places and a view between them,
		// none of which anybody chose as where the camera is.
		if (/(^|\.)yandex\.[a-z.]+$/.test(host) || /(^|\.)ya\.ru$/.test(host)) {
			if (q.get('mode') === 'routes' || q.has('rtext')) return null;
			for (const k of ['pt', 'whatshere[point]', 'll']) {
				const v = q.get(k);
				if (v) {
					const p = grab(v, new RegExp('^' + NUM + ',' + NUM), true);
					if (p) return p;
				}
			}
			return null;
		}

		// OpenStreetMap: a marker (mlat/mlon) beats the view (#map=z/lat/lon).
		if (/(^|\.)openstreetmap\.org$/.test(host) || /(^|\.)osm\.org$/.test(host)) {
			const m = pair(q.get('mlat'), q.get('mlon'));
			if (m) return m;
			return grab(url.hash, new RegExp('map=\\d+/' + NUM + '/' + NUM));
		}

		// Bing: cp=lat~lon.
		if (/(^|\.)bing\.com$/.test(host)) {
			return grab(q.get('cp') || '', new RegExp('^' + NUM + '~' + NUM));
		}

		// Google, Apple and anything else that follows their spelling. The
		// place's own pin (!3d lat !4d lon) is the place; @lat,lon is only
		// where the view is centred, and the two differ whenever the map was
		// panned after the pin was dropped.
		const pin = grab(all, new RegExp('!3d' + NUM + '!4d' + NUM));
		if (pin) return pin;
		// A route or a search is not one place: its view is centred between
		// its ends, and its query is what was searched for, which can lead
		// with coordinates and still mean "cafes near here". Only a pin
		// dropped on it, above, is somebody's choice.
		if (/^\/maps\/(dir|search)\//.test(url.pathname)) return null;
		return ['q', 'query', 'll', 'sll', 'daddr', 'destination'].reduce((found, k) =>
			found || grab(q.get(k) || '', new RegExp('^' + NUM + ',\\s*' + NUM + '$')), null) ||
			grab(all, new RegExp('@' + NUM + ',' + NUM));
	}

	// 55°45'21"N 37°37'04"E, N55.75 E37.62, 33.87 S, 151.21 E. Each half
	// needs its letter: without both there is nothing here a plain pair does
	// not say better, and two of one axis are no place at all. Minutes and
	// seconds only behind the marks that say so -- "37 37 04 E" is too many
	// readings of too few marks.
	// Letters lead (N55.75 E37.62) or trail (55.75N 37.62E), never both in
	// one string: "N55.75 E37.62" read with both allowed would hand the E to
	// the first coordinate.
	const BODY = '(\\d+(?:\\.\\d+)?)\\s*' +
		'(?:[°º]\\s*(?:(\\d+(?:\\.\\d+)?)\\s*[\'′]\\s*(?:(\\d+(?:\\.\\d+)?)\\s*["″])?)?)?';
	const LEADING = new RegExp('([NSEW])\\s*' + BODY, 'gi');
	const TRAILING = new RegExp(BODY + '\\s*([NSEW])', 'gi');
	function fromHemispheres(s) {
		const lead = /^[NSEW]/i.test(s);
		const re = lead ? LEADING : TRAILING;
		const found = [];
		let m;
		re.lastIndex = 0;
		while ((m = re.exec(s)) !== null) {
			const h = (lead ? m[1] : m[4]).toUpperCase();
			const d = lead ? m.slice(2, 5) : m.slice(1, 4);
			const mi = parseFloat(d[1]) || 0, se = parseFloat(d[2]) || 0;
			// 75 minutes is not a typo to be carried into the next degree:
			// it is no place, and saying so beats a camera a degree away.
			if (mi >= 60 || se >= 60) return null;
			const v = parseFloat(d[0]) + mi / 60 + se / 3600;
			found.push({ h: h, v: h === 'S' || h === 'W' ? -v : v });
		}
		if (found.length !== 2) return null;
		// Nothing but the two coordinates and the separators between them.
		if (s.replace(re, '').replace(/[\s,;\/]/g, '') !== '') return null;
		const ns = (x) => x.h === 'N' || x.h === 'S';
		if (ns(found[0]) === ns(found[1])) return null;
		return ns(found[0]) ? pair(found[0].v, found[1].v) : pair(found[1].v, found[0].v);
	}

	// Coordinates or a map link, as an owner would paste either, into
	// {lat, lon} -- or null for anything that is not unambiguously a place.
	function parsePlace(text) {
		const s = String(text === undefined || text === null ? '' : text).trim();
		if (!s) return null;
		if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return fromLink(s);
		const plain = grab(s, new RegExp('^' + NUM + '\\s*[,;\\s]\\s*' + NUM + '$'));
		if (plain) return plain;
		return fromHemispheres(s);
	}

	// The city a time zone is named after, as a first guess at where the
	// camera is: hundreds of kilometres out at worst, which moves dusk by
	// minutes. Offered, never saved by itself. `places` is the generated
	// table (tz-places.js); names are matched with spaces and underscores
	// taken as the same, since /etc/timezone has held both spellings.
	function guessFromZone(zone, places) {
		if (!zone || !places) return null;
		const key = String(zone).trim().replace(/_/g, ' ');
		const hit = places[key];
		if (!hit) return null;
		const city = key.split('/').pop();
		return { lat: hit[0], lon: hit[1], city: city };
	}

	// For the box the place is shown in: four decimals is about eleven metres,
	// far finer than the sun needs and no finer than a pasted link carries.
	function formatPlace(p) {
		if (!p) return '';
		return p.lat.toFixed(4) + ', ' + p.lon.toFixed(4);
	}

	const api = { parsePlace: parsePlace, guessFromZone: guessFromZone, formatPlace: formatPlace };
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticSunPlace = api;
})();
