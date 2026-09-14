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
	//
	// `-cam<N>` before the extension is how a second camera's clips are named,
	// so a card holds `12-04.mp4` and `12-04-cam1.mp4` side by side. Without it
	// here every clip a dual-camera board records went into the "clip(s) whose
	// name has no time" bucket — placed nowhere, drawn on no timeline, and
	// looking for all the world like a naming fault.
	const NAME_RE = /^(\d{2})-(\d{2})(?:-(\d{2}))?(?:-cam(\d+))?\./;

	function startOfName(name) {
		const m = NAME_RE.exec(name);
		if (!m) return null;
		const h = +m[1], mi = +m[2], s = m[3] ? +m[3] : 0;
		if (h > 23 || mi > 59 || s > 59) return null;
		return h * 3600 + mi * 60 + s;
	}

	// Which camera wrote a clip. 0 for the on-board one, which writes no suffix
	// at all, so an unsuffixed name is an answer rather than a missing one.
	function cameraOfName(name) {
		const m = NAME_RE.exec(name);
		return (m && m[4]) ? +m[4] : 0;
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
			const cam = cameraOfName(c.name);
			if (start === null) {
				unplaced.push(Object.assign({}, c, { start: null, camera: cam }));
			} else {
				placed.push(Object.assign({}, c, { start: start, camera: cam }));
			}
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

	// Replace a clip's guessed duration with a measured one. Does not move
	// anything else: clip starts come from filenames and are already exact.
	//
	// `exact` defaults to true but must be passed honestly. A recording with no
	// tfdt can only be guessed at, and a guess that arrives here unlabelled
	// silently loses the marker the clip list uses to say so — the number
	// changes and the "about" qualifier disappears with it.
	function applyExactDuration(day, name, seconds, exact) {
		const c = day.clips.filter(function (x) { return x.name === name; })[0];
		if (!c || !(seconds > 0)) return false;
		c.dur = seconds;
		c.end = Math.min(c.start + seconds, DAY);
		c.estimated = (exact === false);
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

	// ---- the motion lane -------------------------------------------------
	//
	// What the camera reports on /api/v1/analytics/day is presence: when it
	// saw movement, never where in frame. The geometry lives inside the clip,
	// sealed with the media when the recording is encrypted, and a lane that
	// showed it would hand back what that encryption withholds.
	//
	// Every function here is arithmetic over [from, to] seconds of the day.
	// The DOM half lives in recordings.js; what is here is what a test can
	// reach, which matters because the zoom behaviour is where this fails
	// invisibly — at the whole-day zoom a ten-second event is a ninth of a
	// pixel and simply is not drawn.

	// A blip must be wide enough to see and to hit. Three pixels at the
	// current scale: below that the lane shows movement it cannot be clicked
	// on, which is worse than showing none.
	const MIN_BLIP_PX = 3;
	// And two blips closer than this are one, or the lane draws a hairline
	// gap nobody can aim between.
	const MERGE_GAP_PX = 2;

	// Spans as the camera sends them — [from, to, events] — into the shape
	// the lane draws, clipped to `view` and widened for legibility.
	//
	// `members` keeps what a widened or merged blip stands for, so a click on
	// one resolves to a real event rather than to the middle of a rectangle
	// that was never a detection.
	function motionLane(spans, view, secPerPx) {
		if (!Array.isArray(spans) || !view || !(secPerPx > 0)) return [];
		const min = MIN_BLIP_PX * secPerPx;
		const gap = MERGE_GAP_PX * secPerPx;
		const out = [];

		for (const s of spans) {
			if (!Array.isArray(s) || s.length < 2) continue;
			const a = +s[0], b = +s[1];
			if (!isFinite(a) || !isFinite(b) || b < a) continue;
			if (b < view.from || a > view.from + view.width) continue;

			// Widened about its own centre, so a blip does not drift away
			// from the moment it reports.
			let from = a, to = b;
			if (to - from < min) {
				const mid = (from + to) / 2;
				from = mid - min / 2;
				to = mid + min / 2;
			}
			const member = { from: a, to: b, events: +s[2] || 1 };

			const last = out[out.length - 1];
			if (last && from - last.to <= gap) {
				last.to = Math.max(last.to, to);
				last.events += member.events;
				last.members.push(member);
				continue;
			}
			out.push({ from: from, to: to, events: member.events,
				members: [member] });
		}
		return out;
	}

	// The event nearest `sec`, out of a lane's members rather than its drawn
	// rectangles — clicking a merged blip at the whole-day zoom has to land
	// on one of the things it stands for.
	function motionAt(spans, sec, secPerPx) {
		if (!Array.isArray(spans)) return null;
		let best = null, bestD = Infinity;
		for (const s of spans) {
			if (!Array.isArray(s) || s.length < 2) continue;
			const a = +s[0], b = +s[1];
			const d = sec < a ? a - sec : (sec > b ? sec - b : 0);
			if (d < bestD) { bestD = d; best = { from: a, to: b, events: +s[2] || 1 }; }
		}
		// Nothing within a few pixels of the press is nothing the reader was
		// aiming at.
		if (!best || bestD > MIN_BLIP_PX * 4 * (secPerPx || 1)) return null;
		return best;
	}

	// The parts of `view` the camera was NOT watching, which the lane hatches.
	//
	// This is the difference between "nothing moved" and "nobody was looking",
	// and they are indistinguishable on a plain empty lane. A day recorded
	// before the camera kept an index at all is entirely unwatched; a day on
	// which the detector was switched on at noon is unwatched until noon.
	function motionCoverage(watched, view) {
		if (!view) return [];
		const from = view.from, to = view.from + view.width;
		const w = (Array.isArray(watched) ? watched : [])
			.filter((x) => Array.isArray(x) && x.length >= 2)
			.map((x) => ({ from: +x[0], to: +x[1] }))
			.filter((x) => isFinite(x.from) && isFinite(x.to) && x.to >= x.from)
			.sort((a, b) => a.from - b.from);

		const out = [];
		let at = from;
		for (const x of w) {
			if (x.to < at) continue;
			if (x.from > at) out.push({ from: at, to: Math.min(x.from, to) });
			at = Math.max(at, x.to);
			if (at >= to) break;
		}
		if (at < to) out.push({ from: at, to: to });
		return out.filter((r) => r.to > r.from);
	}

	return {
		DAY: DAY,
		MIN_BLIP_PX: MIN_BLIP_PX,
		MERGE_GAP_PX: MERGE_GAP_PX,
		motionLane: motionLane,
		motionAt: motionAt,
		motionCoverage: motionCoverage,
		JOIN_TOLERANCE: JOIN_TOLERANCE,
		startOfName: startOfName,
		cameraOfName: cameraOfName,
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
