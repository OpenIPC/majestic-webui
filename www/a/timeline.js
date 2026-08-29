// The day model behind the recordings timeline: turning a directory listing
// into placed clips, coverage segments and gaps.
//
// Kept apart from the DOM (recordings.js) because this is the part that can be
// quietly wrong. A clip placed a minute out still draws a perfectly convincing
// ribbon, and a gap that fails to appear looks exactly like a camera that was
// recording. tests/timeline.test.js pins the cases that bite: an unparseable
// filename, a clip still being written, a day that ends mid-recording, and the
// difference between "no footage" and "not looked yet".
window.MajesticTimeline = (function () {
	'use strict';

	const DAY = 86400;
	// Clips that abut within this much are one stretch of footage, not two.
	// Majestic closes one file and opens the next in the same second, but the
	// names only carry minutes, so anything under a minute is the same run.
	const JOIN_TOLERANCE = 61;

	// records.filename defaults to "%H-%M"; "%H-%M-%S" is the other spelling
	// people set. Anything else we decline to place rather than guess, because
	// a clip drawn at the wrong time is worse than a clip listed without one.
	function startOfName(name) {
		const m = /^(\d{2})-(\d{2})(?:-(\d{2}))?\./.exec(name);
		if (!m) return null;
		const h = +m[1], mi = +m[2], s = m[3] ? +m[3] : 0;
		if (h > 23 || mi > 59 || s > 59) return null;
		return h * 3600 + mi * 60 + s;
	}

	// Place a day's clips on a 0..86400 line.
	//
	// opts: { splitSec, nowSec }  — nowSec is seconds into THIS day, or null
	// when the day being shown is not today. The last clip of today is still
	// being written, so its end is now, not a full split.
	function buildDay(clips, opts) {
		const o = opts || {};
		const split = o.splitSec > 0 ? o.splitSec : 1200;
		const now = (typeof o.nowSec === 'number') ? o.nowSec : null;

		const placed = [];
		const unplaced = [];
		(clips || []).forEach(function (c) {
			const start = startOfName(c.name);
			if (start === null) unplaced.push(Object.assign({}, c, { start: null }));
			else placed.push(Object.assign({}, c, { start: start }));
		});
		placed.sort(function (a, b) { return a.start - b.start; });

		placed.forEach(function (c, i) {
			const next = placed[i + 1];
			let end;
			if (next && next.start - c.start <= split * 1.5) {
				// Back-to-back: the next file opening IS this one closing. This
				// is the only exact duration available before the clip is
				// indexed, so prefer it over the configured split.
				end = next.start;
				c.estimated = false;
			} else if (!next && now !== null) {
				// The newest clip of today is still growing.
				end = Math.min(c.start + split, Math.max(c.start, now));
				c.estimated = true;
				c.recording = end >= now - JOIN_TOLERANCE;
			} else {
				end = c.start + split;
				c.estimated = true;
			}
			// A recording that runs past midnight is split by majestic at the
			// date change, so nothing on this day may extend beyond it.
			c.end = Math.min(end, DAY);
			c.dur = Math.max(0, c.end - c.start);
		});

		return { clips: placed, unplaced: unplaced };
	}

	// Replace a clip's estimated duration with the exact one, once its index
	// has been walked. Does not move anything else: clip starts come from
	// filenames and are already exact.
	function applyExactDuration(day, name, seconds) {
		const c = day.clips.filter(function (x) { return x.name === name; })[0];
		if (!c || !(seconds > 0)) return false;
		c.dur = seconds;
		c.end = Math.min(c.start + seconds, DAY);
		c.estimated = false;
		return true;
	}

	// Merge placed clips into the stretches of footage the ribbon draws.
	function coverage(day) {
		const out = [];
		day.clips.forEach(function (c) {
			if (c.dur <= 0) return;
			const last = out[out.length - 1];
			if (last && c.start - last.to <= JOIN_TOLERANCE) {
				last.to = Math.max(last.to, c.end);
				last.clips.push(c.name);
			} else {
				out.push({ from: c.start, to: c.end, clips: [c.name] });
			}
		});
		return out;
	}

	// The holes between them — what the camera did not record. Only the holes
	// *between* footage: before the first clip and after the last is "not
	// recording yet", which is not the same thing and is not drawn as a gap.
	function gaps(day) {
		const cov = coverage(day);
		const out = [];
		for (let i = 1; i < cov.length; i++) {
			out.push({ from: cov[i - 1].to, to: cov[i].from });
		}
		return out;
	}

	// Which clip covers a moment, and how far into it. Null outside footage —
	// the caller shows that as a gap rather than snapping to a neighbour,
	// because snapping makes a scrub over a hole silently jump in time.
	function at(day, sec) {
		const list = day.clips;
		for (let i = 0; i < list.length; i++) {
			if (sec >= list[i].start && sec < list[i].end) {
				return { clip: list[i], offset: sec - list[i].start };
			}
		}
		return null;
	}

	// The next moment that has footage at or after `sec`, for skipping a gap.
	function nextCovered(day, sec) {
		const cov = coverage(day);
		for (let i = 0; i < cov.length; i++) {
			if (sec < cov[i].from) return cov[i].from;
			if (sec < cov[i].to) return sec;
		}
		return null;
	}

	// ---- the detail window ----------------------------------------------

	// The zoomed span, clamped so it can never leave the day. Returned as
	// [from, to] in seconds; `width` is its length.
	function window_(centerSec, widthSec) {
		const w = Math.max(60, Math.min(widthSec, DAY));
		let from = centerSec - w / 2;
		if (from < 0) from = 0;
		if (from + w > DAY) from = DAY - w;
		return { from: from, to: from + w, width: w };
	}

	// ---- formatting ------------------------------------------------------

	function clock(sec) {
		const s = Math.max(0, Math.min(Math.round(sec), DAY));
		const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
		return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') +
			':' + String(ss).padStart(2, '0');
	}
	function hhmm(sec) { return clock(sec).slice(0, 5); }

	function duration(sec) {
		const s = Math.max(0, Math.round(sec));
		if (s < 60) return s + ' s';
		const m = Math.floor(s / 60), ss = s % 60;
		if (m < 60) return ss ? m + ' min ' + ss + ' s' : m + ' min';
		const h = Math.floor(m / 60), mm = m % 60;
		return mm ? h + ' h ' + mm + ' min' : h + ' h';
	}

	function bytes(n) {
		n = +n || 0;
		if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB';
		if (n >= 1048576) return (n / 1048576).toFixed(0) + ' MB';
		if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
		return n + ' B';
	}

	return {
		DAY: DAY,
		JOIN_TOLERANCE: JOIN_TOLERANCE,
		startOfName: startOfName,
		buildDay: buildDay,
		applyExactDuration: applyExactDuration,
		coverage: coverage,
		gaps: gaps,
		at: at,
		nextCovered: nextCovered,
		window: window_,
		clock: clock,
		hhmm: hhmm,
		duration: duration,
		bytes: bytes,
	};
})();
