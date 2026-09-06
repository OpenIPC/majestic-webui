// What to do with the camera's /api/v1/sources answer.
//
// A camera is not always one camera. majestic can carry a second sensor
// (Rockchip) or publish a USB webcam as a second camera, and both address their
// streams as stream_id = 3*camera + subtype. Which of those a board has is not
// derivable here — usbcam.enabled says a source was asked for, not that it came
// up, and a second sensor has no config key at all — so the daemon answers and
// this decides what the answer means.
//
// Pure on purpose. Every page that shows video has to make the same three
// decisions — which sources can be watched, which stream of one of them, and
// what transport its codec implies — and a copy of those in each of
// preview-page.js, mj-preview.js and the Stream URLs panel would drift within a
// release. The DOM-heavy files keep their own judgement about what to DO with
// the answer; this is only the answer. Same division preview-transport.js draws
// against preview-swap.js, and testable for the same reason.
(function () {
	'use strict';

	// Canonical display order, and the fallback order behind pick(). Sub first
	// because it is the default everywhere else in this UI: the main channel
	// carries the recording, the substream exists to be watched over whatever
	// link is available. Then main, then the MJPEG stream — which for a USB
	// webcam in its usual mode is the only one there is.
	const FALLBACK = [1, 0, 2];
	const DISPLAY = [0, 1, 2];

	const NAL = { h264: true, h265: true };
	const MULTIPART = { mjpeg: true, jpeg: true };

	// The wire spells `subtype` as a NAME — "main" / "sub" / "mjpeg" — because
	// the payload is meant to be read by a person. Everything in here wants the
	// INDEX, because that is what the stream_id arithmetic is in. The two have
	// to be mapped in exactly one place or they drift, and they did: this module
	// compared the name against 0/1/2, matched nothing, and reported a camera
	// with three healthy streams as having none to watch.
	//
	// `id % 3` is the authority rather than the table, because
	// stream_id = 3*camera + subtype is the protocol's own definition — so it
	// stays right for a subtype name this UI has never been told about. The
	// table is only the fallback for a payload that carries no id.
	const SUBTYPE_INDEX = { main: 0, sub: 1, mjpeg: 2 };

	function subtypeOf(s) {
		if (!s) return -1;
		if (typeof s.id === 'number') return s.id % 3;
		if (typeof s.subtype === 'number') return s.subtype;
		const n = SUBTYPE_INDEX[s.subtype];
		return n === undefined ? -1 : n;
	}

	// A copy carrying the numeric subtype, so nothing downstream has to know
	// the wire spells it a name. Every stream this module hands out is one.
	function normalise(s) {
		return Object.assign({}, s, { subtype: subtypeOf(s) });
	}

	// A stream worth offering: the machinery behind it is up and the daemon
	// named a codec for it.
	//
	// Not gated on `flowing`. A stream that is present but has published no
	// keyframe yet is a stream that is about to, and refusing to offer it would
	// make a camera look sourceless for the first seconds after a restart.
	// `flowing` is a diagnostic, and absent entirely on an MJPEG stream, which
	// has no keyframes to report — treating a missing key as false would hide
	// every USB webcam.
	function watchable(stream) {
		return !!(stream && stream.present && family(stream));
	}

	// Which transport family a codec implies. null for a stream nothing here
	// can play, which is how an unknown codec from a future build behaves —
	// left out rather than handed to a player that will fail on it.
	function family(stream) {
		const c = stream && stream.codec;
		return NAL[c] ? 'nal' : MULTIPART[c] ? 'multipart' : null;
	}

	function streamsOf(source) {
		return (source && Array.isArray(source.streams)) ? source.streams : [];
	}

	// The streams of one source that can be watched, in display order.
	function streams(source) {
		const by = {};
		for (const s of streamsOf(source)) {
			if (watchable(s)) by[subtypeOf(s)] = normalise(s);
		}
		return DISPLAY.map(t => by[t]).filter(Boolean);
	}

	// Sources with something to watch. A source whose streams are all
	// configured-but-absent stays out of a picker: it is real, and the settings
	// page is where that is dealt with, but offering it as something to watch
	// would be offering a black rectangle.
	function watchableSources(sources) {
		return (Array.isArray(sources) ? sources : [])
			.filter(s => streams(s).length > 0);
	}

	// Whether a chooser is worth building at all. One source is the overwhelming
	// case and gets no picker — no dead markup, the cameras-switch.js
	// discipline.
	function multi(sources) {
		return watchableSources(sources).length > 1;
	}

	// The stream of `source` a caller asked for, or the nearest thing to it.
	//
	// A caller's remembered subtype is a preference, not a promise: a USB webcam
	// switched from H.264 to MJPEG moves from subtype 0 to subtype 2, and
	// someone who last watched Sub on the on-board sensor should not get a blank
	// panel because of it.
	// No preference is not a preference for subtype 0: `subtype | 0` would turn
	// null into main and quietly override the default below.
	function pick(source, subtype) {
		const avail = streams(source);
		if (!avail.length) return null;
		if (subtype != null) {
			const want = avail.find(s => s.subtype === (subtype | 0));
			if (want) return want;
		}
		for (const t of FALLBACK) {
			const s = avail.find(x => x.subtype === t);
			if (s) return s;
		}
		return avail[0];
	}

	// Resolve a remembered choice against what the camera actually has now.
	//
	// `want` is {camera, subtype} and may be null, stale, or name a source that
	// has been unplugged since. Falls back to the first watchable source rather
	// than to nothing: the page has a video panel either way, and showing the
	// on-board sensor is a better answer than showing an error about a webcam
	// that is no longer there.
	function resolve(sources, want) {
		const avail = watchableSources(sources);
		if (!avail.length) return null;

		const cam = want && want.camera != null ? want.camera | 0 : -1;
		const source = avail.find(s => s.camera === cam) || avail[0];
		const stream = pick(source, want ? want.subtype : null);
		return stream ? { source: source, stream: stream } : null;
	}

	// How to name a source, as a locale key plus an ordinal.
	//
	// The daemon reports a kind and refuses to name it, which is right — it has
	// no business deciding what language an operator reads. It is also not
	// enough on its own: a second-sensor board reports two sources of the same
	// kind, so "Sensor" twice would name neither. `ordinal` is 0 when the kind
	// is unique and 1-based otherwise, and the caller composes.
	function label(source, sources) {
		const kind = (source && source.kind) === 'external' ? 'usb' : 'sensor';
		const same = watchableSources(sources)
			.filter(s => ((s.kind === 'external') ? 'usb' : 'sensor') === kind);
		const at = same.indexOf(source);
		return {
			key: 'mj_source_' + kind,
			ordinal: same.length > 1 ? at + 1 : 0,
		};
	}

	// A stable, storable name for a choice. Camera and subtype rather than the
	// stream id, because the id is arithmetic over both and a reader of
	// localStorage should not have to do division to know what was remembered.
	function key(source, stream) {
		return (source ? source.camera | 0 : 0) + ':' +
			(stream ? subtypeOf(stream) : 0);
	}

	function parse(str) {
		const m = /^(\d+):(\d+)$/.exec(String(str || ''));
		return m ? { camera: +m[1], subtype: +m[2] } : null;
	}

	const api = {
		watchable, family, subtypeOf, streams, watchableSources, multi,
		pick, resolve, label, key, parse,
	};
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (typeof window === 'object') window.MajesticSources = api;
})();
