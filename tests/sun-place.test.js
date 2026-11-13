// Where the camera is, read out of what an owner pastes (www/a/sun-place.js).
//
// Every way of getting this wrong is silent: a link read the wrong way round
// still yields a place, just somewhere else, and the camera then switches at
// another city's dusk with nothing on the page looking wrong. Yandex writes
// longitude first, a Google place link carries two places (the pin and the
// view), and a bare pair is ambiguous only to a parser that guesses. Each of
// those is one line here, and cannot be reproduced on demand anywhere else
// without the map open at the right place.
'use strict';

const path = require('path');
const { check, group, done } = require('./assert');

const P = require(path.join(__dirname, '..', 'www', 'a', 'sun-place.js'));
const PLACES = require(path.join(__dirname, '..', 'www', 'a', 'tz-places.js'));

const near = (p, lat, lon) => !!p && Math.abs(p.lat - lat) < 1e-3 && Math.abs(p.lon - lon) < 1e-3;
const show = (p) => JSON.stringify(p);

group('plain coordinates, latitude first');
[
	['55.7558, 37.6173', 55.7558, 37.6173],
	['55.7558 37.6173', 55.7558, 37.6173],
	['  -33.8688;151.2093 ', -33.8688, 151.2093],
	['21.31,-157.86', 21.31, -157.86],
].forEach(([s, lat, lon]) => {
	const p = P.parsePlace(s);
	check(JSON.stringify(s), near(p, lat, lon), show(p));
});

group('hemisphere letters and degrees, minutes, seconds');
[
	['55°45\'21"N 37°37\'02"E', 55.7558, 37.6172],
	['N55.7558 E37.6173', 55.7558, 37.6173],
	['33.8688 S, 151.2093 E', -33.8688, 151.2093],
	['37.6173E 55.7558N', 55.7558, 37.6173],
	['22°54′S 43°10′W', -22.9, -43.1667],
].forEach(([s, lat, lon]) => {
	const p = P.parsePlace(s);
	check(JSON.stringify(s), near(p, lat, lon), show(p));
});

group('map links, each read by its own convention');
[
	['Google pin beats the view',
		'https://www.google.com/maps/place/Red+Square/@55.7500,37.6000,15z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d55.7539!4d37.6208',
		55.7539, 37.6208],
	['Google view alone', 'https://www.google.com/maps/@55.7558,37.6173,15z', 55.7558, 37.6173],
	['Google q=', 'https://maps.google.com/?q=55.7558,37.6173', 55.7558, 37.6173],
	['Apple ll=', 'https://maps.apple.com/?ll=55.7558,37.6173&z=15', 55.7558, 37.6173],
	['Yandex ll= is longitude first', 'https://yandex.ru/maps/?ll=37.6173%2C55.7558&z=15', 55.7558, 37.6173],
	['Yandex pin pt= beats the view', 'https://yandex.com/maps/?ll=37.60,55.70&pt=37.6173,55.7558&z=12', 55.7558, 37.6173],
	['OSM view', 'https://www.openstreetmap.org/#map=15/55.7558/37.6173', 55.7558, 37.6173],
	['OSM marker beats the view', 'https://www.openstreetmap.org/?mlat=55.7558&mlon=37.6173#map=12/55.70/37.60', 55.7558, 37.6173],
	['Bing cp=', 'https://www.bing.com/maps?cp=55.7558~37.6173&lvl=15', 55.7558, 37.6173],
	['geo: URI', 'geo:55.7558,37.6173?z=15', 55.7558, 37.6173],
].forEach(([name, s, lat, lon]) => {
	const p = P.parsePlace(s);
	check(name, near(p, lat, lon), show(p));
});

group('nothing ambiguous becomes a place');
[
	'',
	'Moscow',
	'55.75',
	'0, 0',              // the configuration's own "not said"
	'95, 37',            // no latitude past a pole
	'55, 190',
	'55.75N 37.62N',     // two latitudes
	'55.75 37.62 E',     // one letter is not two
	'37 37 04 E 55 45 N', // minutes with no marks
	'https://example.com/somewhere',
	'https://yandex.ru/maps/?z=15',
	// A route's view is centred between its ends, a search's on its results:
	// neither is a place anybody chose.
	'https://www.google.com/maps/dir/Moscow/Tver/@56.30,36.50,9z/data=!4m2!4m1!3e0',
	'https://www.google.com/maps/search/cafe/@55.75,37.61,14z',
	// A search whose query leads with coordinates is still a search.
	'https://www.google.com/maps/search/cafe/?query=55.75%2C37.61%20cafe',
	// A Yandex route: two places and a view between them.
	'https://yandex.ru/maps/?ll=37.0000%2C56.3000&mode=routes&rtext=55.75%2C37.61~56.85%2C35.90',
	// Minutes or seconds of 60 or more are no place at all.
	"55°75'N 37°00'E",
	"55°45'60\"N 37°37'02\"E",
].forEach((s) => {
	const p = P.parsePlace(s);
	check(JSON.stringify(s) + ' is no place', p === null, show(p));
});

group('a stray percent sign does not stop the reading');
{
	const p = P.parsePlace('https://maps.google.com/?q=55.7558,37.6173&note=100%');
	check('read anyway', near(p, 55.7558, 37.6173), show(p));
}

group('the time zone as a first guess');
{
	const g = P.guessFromZone('Europe/Moscow', PLACES);
	check('Moscow', near(g, 55.76, 37.62) && g.city === 'Moscow', show(g));
	const ny = P.guessFromZone('America/New_York', PLACES);
	check('underscores and spaces are one name', near(ny, 40.71, -74.01), show(ny));
	const ny2 = P.guessFromZone('America/New York', PLACES);
	check('the spelling /etc/timezone uses', near(ny2, 40.71, -74.01), show(ny2));
	check('Etc/GMT names no city', P.guessFromZone('Etc/GMT', PLACES) === null);
	check('no zone, no guess', P.guessFromZone('', PLACES) === null);
}

group('shown to four decimals');
check('format', P.formatPlace({ lat: 55.75583, lon: -37.6 }) === '55.7558, -37.6000');

done();
