// What a publishing destination is, kept away from the DOM so it can be tested.
//
// The camera has always been able to push to several places at once — the list
// is walked by three different subsystems, each claiming the addresses whose
// scheme it speaks — but nothing published it, so nothing could draw it and the
// only way to add a second destination was to edit the file on the camera. Now
// the schema describes it: an array whose items are objects, which is a shape
// this settings page has never had to render before.
//
// The decisions live here rather than in the row-drawing code because they are
// the parts worth testing: what protocol an address names, which fields that
// protocol actually uses, what the list reduces to for dirty-tracking, and
// whether a row says anything the person typing it should hear.
//
// THE PROTOCOL IS THE SCHEME, and is never stored separately. The camera
// dispatches on it, so a row carrying its own protocol field could disagree
// with its own address, and one of the two would be quietly ignored. Deriving
// it means the badge beside a row is a reading of what the camera will do,
// not a second place to get it wrong.
(function () {
	'use strict';

	// Scheme -> what to call it, and whether the credential applies.
	//
	// `token` is the WHIP bearer, and WHIP is the only one of these that has a
	// notion of one: RTMP carries its credentials in the URL's userinfo, and
	// neither RTP nor a Unix socket authenticates at all. Showing the field on
	// a row that cannot use it would be offering a setting that does nothing.
	const SCHEMES = {
		rtmp: { name: 'RTMP', token: false },
		rtmps: { name: 'RTMPS', token: false },
		udp: { name: 'RTP', token: false },
		unix: { name: 'UNIX', token: false },
		http: { name: 'WHIP', token: true },
		https: { name: 'WHIP', token: true },
	};

	// The scheme of an address, lowercased, or '' when it names none.
	//
	// Deliberately not a URL parse: `unix:/tmp/stream.sock` is a legal
	// destination and not a legal URL, and half-typed text is the normal state
	// of a field somebody is filling in.
	function schemeOf(url) {
		const s = String(url == null ? '' : url).trim();
		const i = s.indexOf(':');
		if (i <= 0) return '';
		return s.slice(0, i).toLowerCase();
	}

	// What the camera will treat this address as, or null if it will refuse it.
	function protocolOf(url) {
		const known = SCHEMES[schemeOf(url)];
		return known ? known.name : null;
	}

	// Whether an item property applies to a row with this address.
	//
	// Everything the schema declares is shown by default. A property this knows
	// to be protocol-specific is shown only where it means something — and on a
	// row with no address yet, where the answer is not knowable, it is shown
	// rather than hidden: a field that appears the moment you finish typing the
	// scheme reads as the form arguing with you.
	function applies(prop, url) {
		if (prop !== 'token') return true;
		const sch = schemeOf(url);
		if (!sch) return true;
		const known = SCHEMES[sch];
		return known ? known.token : true;
	}

	// One row, tidied: strings trimmed, empties dropped, nothing invented.
	//
	// An absent member and an empty one are the same thing to the camera — the
	// parser skips a member it cannot read — but they are not the same thing on
	// disk, and writing `token: ""` into every row of a file somebody reads is
	// noise. So an empty member is left out rather than sent blank.
	function tidy(row) {
		const out = {};
		if (!row || typeof row !== 'object') return out;
		Object.keys(row).forEach(function (k) {
			const v = row[k];
			if (v === undefined || v === null) return;
			if (typeof v === 'string') {
				const t = v.trim();
				if (t !== '') out[k] = t;
				return;
			}
			out[k] = v;
		});
		return out;
	}

	// The list as it should be saved: tidied, and without the rows that name no
	// address. A row with a token and no address describes no destination, and
	// the camera skips it on load — dropping it here means the file says what
	// the page shows.
	function normalise(rows) {
		if (!Array.isArray(rows)) return [];
		return rows.map(tidy).filter(function (r) {
			return typeof r.url === 'string' && r.url !== '';
		});
	}

	// What the list reduces to for change detection.
	//
	// The save machinery compares one string per field against the value the
	// field had on load, so a list of objects needs a single canonical form or
	// every edit inside a row is invisible to it. Key order is fixed rather
	// than left to insertion order, or re-typing a row's members in a different
	// sequence would read as a change.
	function canon(rows) {
		return JSON.stringify(normalise(rows).map(function (r) {
			const keys = Object.keys(r).sort();
			const o = {};
			keys.forEach(function (k) { o[k] = r[k]; });
			return o;
		}));
	}

	// What to say beside a row, or '' for one with nothing to say.
	//
	// Advisory, never a block on saving: the camera is the authority on what it
	// accepts, and a page that refuses to send something the camera would have
	// taken is a page arguing from a stale idea of the camera. These are the
	// two answers worth having before the save round-trips.
	function says(row) {
		const url = row && typeof row.url === 'string' ? row.url.trim() : '';
		if (url === '') return 'This destination has no address.';
		if (protocolOf(url) === null) {
			const sch = schemeOf(url);
			return sch
				? 'The camera does not publish to ' + sch + ' addresses.'
				: 'An address starts with a scheme, such as rtmp:// or https://.';
		}
		return '';
	}

	const api = {
		schemeOf: schemeOf, protocolOf: protocolOf, applies: applies,
		tidy: tidy, normalise: normalise, canon: canon, says: says,
	};
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticServers = api;
})();
