// Recordings browser: a day of footage as one scrubbable timeline.
//
// The page it replaces was "SD Card -> Browse files", which drops you in a
// whole-device file manager holding a folder of 400 MB clips named 12-04.mp4.
// Everything here exists to answer the question people actually arrive with —
// what happened around half past twelve — rather than which file to open.
//
// Three modules, split by what can be silently wrong:
//   timeline.js   places clips on the day and works out coverage and gaps
//   mp4index.js   recovers byte<->time from clips that carry no seek index
//   this file     the DOM, the player and the export
//
// Nothing here streams media through a CGI. Clips are fetched from their own
// filesystem path, where majestic answers with sendfile and honours Range for
// the browser's authenticated session; j/download.cgi would cat a whole
// recording into the connection buffer and take the camera's RAM with it.
(function () {
	'use strict';

	const IDX = window.MajesticMp4Index;
	const TL = window.MajesticTimeline;
	const DAY = TL.DAY;

	// How much of the day the detail band shows, and the steps the zoom takes.
	const ZOOMS = [15 * 60, 30 * 60, 3600, 3 * 3600, 6 * 3600, DAY];
	let zoom = 2;                     // index into ZOOMS -> one hour

	const state = {
		cfg: {}, prefix: '', split: 1200, enabled: false, card: null,
		offsetMs: 0, offsetKnown: false, zone: null, nowSec: null, today: '',
		tzAt: 0, tzCamOff: 0, tzMyOff: 0, tzDiffers: false, tzOn: false,
		days: [], dayName: '', day: { clips: [], unplaced: [] },
		view: { from: 0, to: 3600, width: 3600 },
		playhead: 0, sel: null,
		clip: null, mime: null, init: null, hint: null,
	};


	// Bumped on every seek: a drag fires overlapping lookups and only the
	// newest may move the picture. dayToken does the same for day switches.
	let seekToken = 0;
	let dayToken = 0;
	let player = null;

	const $id = function (s) { return document.getElementById(s); };
	function esc(s) {
		return String(s).replace(/[&<>"]/g, function (c) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
		});
	}
	// Same reasoning as files.js: majestic serves the absolute path, so the
	// URL is the path with each component encoded.
	function fileUrl(p) { return p.split('/').map(encodeURIComponent).join('/'); }
	function clipPath(name) {
		const d = state.dayName === '.' ? state.prefix : state.prefix + '/' + state.dayName;
		return (d + '/' + name).replace(/\/{2,}/g, '/');
	}

	function note(html, kind) {
		const n = $id('rec-note');
		if (!n) return;
		n.className = html ? 'alert alert-' + (kind || 'secondary') : 'd-none';
		n.innerHTML = html || '';
	}

	// ---- which clock this page prints ------------------------------------
	//
	// Every second here is camera-local, and has to be: clips are named by the
	// camera's own strftime, so the day folders, the ribbon and the clip list
	// are all read out of filenames. That is the truth on the card, the reading
	// VLC and the file manager agree with, and the one an exported cut is named
	// after. It is also, on a camera whose timezone was never set, the time
	// somewhere the viewer is not — which is how you end up looking at footage
	// you shot at twenty to nine and being told it is quarter to six.
	//
	// So the model stays camera-local end to end and only the printing moves:
	// a camera-local second is resolved to the instant it happened, and that
	// instant is read on the viewer's clock. Per second, not per day — a single
	// offset for the whole day is wrong on the two days a year one of the two
	// zones changes, and states an hour that never existed.
	const TZ_KEY = 'mj-rec-tz';

	// Held here rather than read back out of storage on every call. Storage
	// throws outright in some privacy configurations, and a setter that failed
	// silently would leave the button snapping back to camera on every click:
	// storage is where the choice is remembered, not where it lives.
	let tzWanted = 'camera';
	try { if (localStorage.getItem(TZ_KEY) === 'local') tzWanted = 'local'; } catch (e) {}

	function setTzMode(m) {
		tzWanted = m === 'local' ? 'local' : 'camera';
		try { localStorage.setItem(TZ_KEY, tzWanted); } catch (e) { /* this visit only */ }
	}

	// A zone's offset at a given instant. Intl is the only timezone database in
	// reach and the only thing that can answer for a date that is not today —
	// the camera ships a POSIX TZ string ("EST5EDT,M3.2.0,M11.1.0") that nothing
	// in a browser will evaluate, and pulse.cgi's %z is one number for now.
	const dtfCache = {};
	function zoneFmt(zone) {
		if (!(zone in dtfCache)) {
			try {
				dtfCache[zone] = new Intl.DateTimeFormat('en-US', {
					timeZone: zone, hourCycle: 'h23',
					year: 'numeric', month: '2-digit', day: '2-digit',
					hour: '2-digit', minute: '2-digit', second: '2-digit',
				});
			} catch (e) { dtfCache[zone] = null; }   // not a name this browser knows
		}
		return dtfCache[zone];
	}
	function zoneOffsetMs(zone, ms) {
		const f = zoneFmt(zone);
		if (!f) return null;
		const p = {};
		f.formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
		// The wall clock read back as if it were UTC. Its distance from the
		// instant is the offset — the only way to get a number out of Intl
		// without parsing a localised "GMT+3".
		return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - ms;
	}

	// /etc/timezone as a name the browser's database will accept. fw-time.cgi
	// writes it de-underscored out of the bundled table ("America/New York"),
	// which Intl rejects; no zone name contains a space, so putting them back is
	// exact. Without it the camera side falls back to pulse.cgi's single number,
	// which is right except across a change in the camera's own zone.
	function ianaZone(s) {
		const z = String(s || '').trim().replace(/ /g, '_');
		return z && zoneFmt(z) ? z : null;
	}
	function camOffsetAt(ms) {
		if (state.zone) {
			const o = zoneOffsetMs(state.zone, ms);
			if (o !== null) return o;
		}
		return state.offsetMs;
	}
	function tzUsable() { return !!state.zone || state.offsetKnown; }

	function offsetLabel(ms) {
		const m = Math.round(ms / 60000), a = Math.abs(m);
		return 'UTC' + (m < 0 ? '-' : '+') + String(Math.floor(a / 60)).padStart(2, '0') +
			':' + String(a % 60).padStart(2, '0');
	}

	// The instant a camera-local second on the day being browsed happened.
	// Solved rather than computed: the offset depends on the instant and the
	// instant depends on the offset. One correction settles it everywhere except
	// inside the hour a spring-forward skips, which no wall clock names anyway.
	function dayBaseUtc() {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(state.dayName)) return null;
		const t = Date.parse(state.dayName + 'T00:00:00Z');
		return isNaN(t) ? null : t;
	}
	function instantOf(sec) {
		const base = dayBaseUtc();
		if (base === null) return null;
		const naive = base + sec * 1000;
		return naive - camOffsetAt(naive - camOffsetAt(naive));
	}
	// That instant read on the viewer's clock. Date's local getters are the
	// browser's own timezone database, so this is exact through a change in the
	// viewer's zone as well — including the two days a year it happens mid-day.
	function viewerAt(sec) {
		const ms = instantOf(sec);
		if (ms === null) return null;
		const d = new Date(ms);
		return { ms: ms, sec: d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() };
	}

	// Camera mode leaves timeline.js to print, exactly as before this existed.
	// Its clamp is what gives the last tick of the day "24" rather than "00".
	function clock(sec) {
		if (!state.tzOn) return TL.clock(sec);
		const v = viewerAt(sec);
		return TL.clock(v === null ? sec : v.sec);
	}
	function hhmm(sec) { return clock(sec).slice(0, 5); }

	// What the two clocks were doing in the middle of the day being read — the
	// only honest place to sample them for a label, since either may change
	// during it. Recomputed per day, not per timestamp, because it answers
	// "is there a choice here", not "what time is this".
	function refreshTz() {
		const at = instantOf(DAY / 2);
		state.tzAt = at === null ? Date.now() : at;
		state.tzCamOff = camOffsetAt(state.tzAt);
		state.tzMyOff = -new Date(state.tzAt).getTimezoneOffset() * 60000;
		// A camera we were never told the zone of cannot be compared. With pulse
		// unread or malformed, offsetMs is a default of zero, and treating that
		// as a verified UTC would have the page both claim a zone nobody reported
		// and offer a conversion computed from the claim. `at` being null is the
		// flat records.path with no %F: no date, so nothing to convert against.
		state.tzDiffers = tzUsable() && at !== null && state.tzCamOff !== state.tzMyOff;
		state.tzOn = tzWanted === 'local' && state.tzDiffers;
	}

	// The date an exported cut is stamped with. It follows what was on screen,
	// or the file would carry neither reading: a cut labelled 20:47 saved as
	// 2026-08-29_17-47 is the camera's date beside the viewer's time. Read off
	// the instant itself, so a selection the shift carries over midnight lands
	// on the date the viewer would call it.
	function stampDate(sec) {
		if (state.dayName === '.') return '';
		if (!/^\d{4}-\d{2}-\d{2}$/.test(state.dayName)) return state.dayName + '_';
		const v = state.tzOn ? viewerAt(sec) : null;
		if (!v) return state.dayName + '_';
		const d = new Date(v.ms), p = function (n) { return String(n).padStart(2, '0'); };
		return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '_';
	}

	// ---- loading ---------------------------------------------------------

	function loadPulse() {
		return apiFetch('/cgi-bin/j/pulse.cgi', { credentials: 'same-origin' })
			.then(function (r) { return r.json(); })
			.then(function (j) {
				const off = parseTzOffsetMs(j.utc_offset);   // main.js; null if unusable
				// Zero is the fallback the day arithmetic below has always used,
				// but it must not be mistaken for a camera that reported UTC:
				// everything the page says out loud about zones is gated on this.
				state.offsetKnown = off !== null;
				state.offsetMs = off === null ? 0 : off;
				state.zone = ianaZone(j.timezone);
				const nowMs = (+j.time_now || 0) * 1000 + state.offsetMs;
				const d = new Date(nowMs);
				// Read the shifted instant as if it were UTC — the camera's wall
				// clock, which is what records.path %F and %H-%M are stamped in.
				state.today = d.toISOString().slice(0, 10);
				state.nowSec = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
			})
			.catch(function () { /* the page still works without a clock */ });
	}

	function loadConfig() {
		return apiFetch('/api/v1/config.json', { credentials: 'same-origin' })
			.then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; })
			.then(function (c) {
				state.cfg = c;
				state.enabled = mjGet(c, 'records.enabled') === true;
				state.prefix = (mjGet(c, 'records.path') || '').split('%')[0].replace(/\/+$/, '');
				const sp = +mjGet(c, 'records.split');
				state.split = sp > 0 ? sp * 60 : 1200;
			});
	}

	function api(qs) {
		return apiFetch('/cgi-bin/j/recordings.cgi?' + qs, { credentials: 'same-origin' })
			.then(function (r) { return r.json(); });
	}

	function loadDays() {
		if (!state.prefix) return Promise.resolve();
		// The endpoint derives the recordings root itself; take its answer as
		// authoritative so the path this page builds media URLs from cannot
		// drift from the one the listing came out of.
		return api('days=1')
			.then(function (j) {
				state.days = (j && j.days) || [];
				if (j && j.prefix) state.prefix = j.prefix;
			})
			.catch(function () { state.days = []; });
	}

	function loadDay(name) {
		state.dayName = name;
		// Switching days fast enough leaves two requests in flight, and they can
		// land out of order: the slower one for the day nobody is looking at any
		// more would overwrite the newer model, while clip paths keep being built
		// from the newer dayName — a listing of one day fetched from another.
		const token = ++dayToken;
		return api('day=' + encodeURIComponent(name))
			.then(function (j) {
				if (token !== dayToken) return;
				const isToday = (name === state.today) ||
					(name === '.' && state.nowSec !== null);
				state.day = TL.buildDay((j && j.clips) || [], {
					splitSec: state.split,
					nowSec: isToday ? state.nowSec : null,
				});
			})
			.catch(function () {
				if (token !== dayToken) return;
				state.day = { clips: [], unplaced: [] };
			});
	}

	// ---- the player ------------------------------------------------------
	//
	// MSE fed from byte offsets the index works out, so a seek fetches the
	// fragment holding that second instead of asking the browser to find it.
	//
	// Every fragment states its own start in tfdt, and that is what makes this
	// simple rather than fiddly. SourceBuffer stays in its default 'segments'
	// mode, where an appended fragment lands at the time it claims: append the
	// fragments for 5s..9s and `buffered` reads 5.00-9.00, whatever was or was
	// not appended before them. So there is no timestampOffset to maintain, no
	// anchor to re-establish per seek, and the media timeline is clip time —
	// video.currentTime is just the second being watched.
	//
	// ('sequence' mode is the wrong tool here for exactly that reason: it
	// re-times each append to follow the last, so the same fragments land at
	// 0.00-4.00 and every position on the timeline means something else.)
	//
	// DEPRECATED PATH, REMOVE AFTER 2029-01: recordings written before majestic
	// emitted tfdt cannot be played this way at all — a SourceBuffer refuses a
	// media segment without one, leaving `buffered` empty and no error worth
	// reading. Cameras write tfdt now, so this only matters for clips already
	// sitting on cards when that shipped. Once those have rotated away (a card
	// fills and recycles in days; a few years is generous), delete plainFallback
	// and the watchdog below with it, and let a clip that will not append fail
	// honestly.
	function mkPlayer(video, onFallback) {
		let ms = null, sb = null, objUrl = null;
		let read = null, size = 0, headerLen = 0;
		let cursor = 0, dead = false, busy = false, reset = false;
		let want = null, watchdog = null;
		// A fragment is ~340 KB and at most ~730 KB on an av300 at 4K, so one
		// read usually swallows a whole one; when it does not, the remainder
		// costs one extra request rather than a wrong append.
		const WINDOW = 1024 * 1024, AHEAD = 12, BEHIND = 30;

		function bufferedAhead() {
			try {
				const t = video.currentTime;
				for (let i = 0; i < sb.buffered.length; i++) {
					if (t >= sb.buffered.start(i) - 0.25 && t <= sb.buffered.end(i))
						return sb.buffered.end(i) - t;
				}
			} catch (e) { /* not ready */ }
			return 0;
		}

		function covers(sec) {
			try {
				for (let i = 0; i < sb.buffered.length; i++)
					if (sec >= sb.buffered.start(i) && sec < sb.buffered.end(i)) return true;
			} catch (e) {}
			return false;
		}

		function evict() {
			try {
				if (!sb.buffered.length) return;
				const keep = video.currentTime - BEHIND;
				if (keep > sb.buffered.start(0)) sb.remove(sb.buffered.start(0), keep);
			} catch (e) { /* nothing to drop */ }
		}

		function fill() {
			if (dead || !sb || sb.updating || busy) return;
			if (reset) {
				reset = false;
				try { sb.remove(0, Infinity); return; } catch (e) { /* fall through */ }
			}
			if (want !== null && covers(want)) {
				try { video.currentTime = want; } catch (e) {}
				want = null;
			}
			if (cursor + 16 > size) {
				// Every fragment is in. Say so, or the element treats the
				// media as open-ended: currentTime runs on past the last
				// buffered second, the page follows it out of the clip
				// entirely, and a scrub back into the clip then looks like it
				// was ignored.
				try { if (ms && ms.readyState === 'open') ms.endOfStream(); } catch (e) {}
				return;
			}
			if (bufferedAhead() > AHEAD) return;

			busy = true;
			const at = cursor;
			read(at, Math.min(at + WINDOW, size) - 1).then(function (buf) {
				if (dead || !sb) { busy = false; return; }
				const f = IDX.parseFragment(buf);
				// The tail of a clip still being recorded: headers on the card,
				// payload not yet. Stop rather than append something partial.
				if (!f || f.short || !f.total || at + f.total > size) { busy = false; return; }
				const whole = f.total <= buf.length
					? Promise.resolve(buf.subarray(0, f.total))
					: read(at, at + f.total - 1);
				return whole.then(function (bytes) {
					if (dead || !sb) { busy = false; return; }
					cursor = at + f.total;
					try { sb.appendBuffer(bytes); } catch (e) { evict(); }
					busy = false;
				});
			}).catch(function () { busy = false; });
		}

		return {
			attach: function (url, initInfo, clipSize, mime) {
				read = IDX.reader(url); size = clipSize;
				headerLen = initInfo.headerLength; cursor = initInfo.firstMoof;
				dead = false; busy = false; reset = false; want = null;
				ms = new MediaSource();
				objUrl = URL.createObjectURL(ms);
				video.src = objUrl;
				ms.addEventListener('sourceopen', function () {
					try { sb = ms.addSourceBuffer(mime); } catch (e) { return onFallback(); }
					sb.addEventListener('updateend', function () { evict(); fill(); });
					read(0, headerLen - 1).then(function (head) {
						if (dead || !sb) return;
						try { sb.appendBuffer(head); } catch (e) { onFallback(); }
					});
				}, { once: true });

				// A pre-tfdt recording buffers nothing and says almost nothing
				// about why. What it does NOT do is fail the append: appendBuffer
				// returns fine and the parse gives up afterwards, so "did we
				// append" is not the question — "is there anything in the
				// buffer" is. Give it a moment, then hand the clip to a plain
				// element rather than leave a black frame and no explanation.
				watchdog = setTimeout(function () {
					if (dead) return;
					let has = 0;
					try { has = sb ? sb.buffered.length : 0; } catch (e) {}
					if (!has) onFallback();
				}, 5000);
			},
			// Whether the SourceBuffer ever accepted anything. The difference
			// between "this media is not appendable" and "something went wrong
			// just now" — only the first is worth abandoning MSE over.
			hasData: function () {
				try { return sb ? sb.buffered.length > 0 : false; } catch (e) { return false; }
			},
			seekTo: function (off, sec) {
				want = sec;
				if (covers(sec)) {
					try { video.currentTime = sec; } catch (e) {}
					want = null;
					return;
				}
				cursor = off;
				reset = true;
				fill();
			},
			destroy: function () {
				dead = true;
				clearTimeout(watchdog);
				try { if (sb && ms && ms.readyState === 'open') ms.removeSourceBuffer(sb); } catch (e) {}
				try { if (ms && ms.readyState === 'open') ms.endOfStream(); } catch (e) {}
				if (objUrl) { try { URL.revokeObjectURL(objUrl); } catch (e) {} }
				sb = null; ms = null; objUrl = null;
				// Let go of the revoked blob too, or the element raises an
				// error for a source that no longer exists — which the page
				// would otherwise read as the clip being unplayable.
				try { video.removeAttribute('src'); video.load(); } catch (e) {}
			},
		};
	}

	// ---- opening a clip --------------------------------------------------

	function openClip(clip, atSec) {
		const video = $id('rec-video');
		if (!video || !clip) return;
		state.clip = clip;
		state.init = null;
		state.hint = null;
		const url = fileUrl(clipPath(clip.name));

		if (player) { player.destroy(); player = null; }
		setStatus('Reading clip header…');

		const read = IDX.reader(url);
		// 64 KiB is generous for ftyp + moov, so the codec probe and the init
		// parse share one request.
		read(0, 65535).then(function (head) {
			if (state.clip !== clip) return;          // switched away mid-flight
			const init = IDX.parseInit(head);
			if (!init) throw new Error('not a fragmented MP4');
			state.init = init;

			const codec = codecFromHeader(head);
			const mime = 'video/mp4; codecs="' + (codec || 'avc1.42E01E') + '"';

			// An unplayable codec does not raise `error` on a <video>: H.265
			// parses, reports a duration and then sits at videoWidth 0 forever.
			// So ask before committing anything to the screen.
			if (codec && !video.canPlayType(mime)) {
				const family = /^(hvc1|hev1)/.test(codec) ? 'H.265 (HEVC)' : codec.split('.')[0];
				setStatus('');
				note('<strong>' + family + ' — this browser cannot decode it.</strong> ' +
					'Save the clip and play it in VLC, or record the main stream as H.264. ' +
					'<a href="mj-settings.cgi?tab=video0">Stream settings</a>', 'warning');
				return;
			}
			note('');
			state.mime = mime;
			setStatus('');

			if ('MediaSource' in window && MediaSource.isTypeSupported(mime)) {
				player = mkPlayer(video, function () { plainFallback(clip, url); });
				player.attach(url, init, clip.size, mime);
			} else {
				video.src = url;
			}
			positionAt(atSec || 0);
			video.play().catch(function () { /* autoplay policy; controls remain */ });

			// Two reads to turn the clip list's estimate into a real length.
			hintDuration(url, clip, init);
		}).catch(function (e) {
			setStatus('');
			note('Could not open <code>' + esc(clip.name) + '</code> — ' + esc(e.message || 'unreadable') +
				'. <a href="' + esc(url) + '" download>Save the clip</a> and play it locally.', 'danger');
		});
	}

	// Move to a moment inside the clip that is already open.
	//
	// With a player attached this is a lookup, not a request to search: locate()
	// reads tfdt to find the byte the fragment starts at, in about ten range
	// reads, and the player appends from there. Without one — no MSE, or a
	// pre-tfdt recording that fell back — the element seeks for itself.
	function positionAt(sec) {
		const video = $id('rec-video');
		if (!video) return;
		if (!player || !state.init) {
			try { video.currentTime = Math.max(0, sec); } catch (e) { /* not ready */ }
			return;
		}
		const clip = state.clip, init = state.init;
		const per = state.hint ? state.hint.perFragment : 1;
		const token = ++seekToken;
		IDX.locate(IDX.reader(fileUrl(clipPath(clip.name))), clip.size, init, sec, per)
			.then(function (hit) {
				// A drag fires many of these; only the newest may move the
				// picture, or it lands wherever the slowest lookup finished.
				if (token !== seekToken || state.clip !== clip || !player) return;
				player.seekTo(hit.off, Math.max(sec, hit.approxSec));
			}).catch(function () { /* stay where we are */ });
	}

	// DEPRECATED, REMOVE AFTER 2029-01 — see the note above mkPlayer.
	//
	// A recording with no tfdt cannot go through a SourceBuffer at all. Hand it
	// to the element instead of leaving a black frame: it plays these fine, it
	// just has to find its own way to a seek.
	function plainFallback(clip, url) {
		if (!player || state.clip !== clip) return;
		player.destroy();
		player = null;
		const video = $id('rec-video');
		if (!video) return;
		const at = video.currentTime || 0;
		video.src = url + (at > 0.5 ? '#t=' + at.toFixed(2) : '');
		video.play().catch(function () {});
	}

	// ---- storage ---------------------------------------------------------

	// The card behind the archive, fetched once. It answers two questions on
	// this page: how much room is left (the storage bar at the bottom), and
	// whether anything can still be written at all (the banner at the top).
	// The second is why this is loaded before the page decides it has nothing
	// to show: "nothing recorded yet" and "the card went read-only at 12:04"
	// look identical from the clip list alone.
	// `rec` asks the endpoint to du(1) the whole archive for the storage bar,
	// which is not free on a card holding a month of clips — so the periodic
	// refresh, which only needs the health verdict and df's numbers, leaves it
	// off and carries the measured recBytes forward.
	function loadCard(withRec) {
		if (!state.prefix) return Promise.resolve();
		const q = withRec === false ? '' : '?rec=' + encodeURIComponent(state.prefix);
		return apiFetch('/cgi-bin/j/sdcard.cgi' + q, { credentials: 'same-origin' })
			.then(function (r) { return r.json(); })
			.then(function (d) {
				// Asked without ?rec= the endpoint reports recBytes as 0 rather
				// than leaving it out, so the carry-forward has to key off the
				// question asked, not the answer given, or the storage bar's
				// Recordings segment collapses on the first refresh.
				if (d && withRec === false && state.card) d.recBytes = state.card.recBytes;
				state.card = d;
			})
			// The page still browses the archive without this, but it must not
			// go on claiming the camera is recording — see cardWritable().
			.catch(function () { state.card = null; });
	}

	// Positive claims need positive evidence. A card is only known writable
	// when the endpoint said so; a request that failed, or an answer this
	// release does not understand, is an unknown card, and an unknown card
	// must not be painted green — that false reassurance is the whole bug
	// this page is here to stop telling.
	function cardWritable() { return !!state.card && state.card.health === 'ok'; }

	// Why there is no new footage, said on the page people actually arrive at.
	// Returns '' while the card is fine — including while it is merely full,
	// which is normal operation: majestic deletes the oldest clips at
	// records.maxUsage and carries on.
	function cardTrouble() {
		const d = state.card;
		if (!d) return '';
		switch (d.health) {
		case 'readonly':
			return '<strong>The SD card is mounted read-only — nothing is being recorded.</strong> ' +
				'It reports free space and its older clips still play, but the camera cannot write to it. ' +
				'The kernel drops a card to read-only as soon as its filesystem stops making sense, ' +
				'so expect a damaged filesystem rather than a full one.';
		case 'unreadable':
			return '<strong>The SD card has no readable filesystem — nothing is being recorded.</strong> ' +
				'A partition is there but nothing on the camera can read it, so it is either damaged or was never formatted.';
		case 'unformatted':
			return '<strong>The SD card is not formatted — nothing is being recorded.</strong>';
		case 'unmounted':
			return '<strong>The SD card is not mounted — nothing is being recorded.</strong> ' +
				'The filesystem is intact; it just is not attached to <code>' + esc(d.mountpoint || '') + '</code>.';
		case 'absent':
			return '<strong>There is no SD card in the camera — nothing is being recorded.</strong>';
		default:
			return '';
		}
	}

	// Kernel complaints about the card, when the endpoint found any. Never
	// rendered as reassurance: the ring buffer is small, so an error that
	// stopped recording this morning has usually scrolled out of it by now.
	function cardKernelLines() {
		const d = state.card;
		if (!d || !d.fsErrors || !d.fsErrors.length) return '';
		return '<div class="mt-2"><div class="x-small text-secondary mb-1">Recent kernel messages about this card:</div>' +
			'<pre class="x-small mb-0" style="white-space:pre-wrap">' + esc(d.fsErrors.join('\n')) + '</pre></div>';
	}

	function renderHealth() {
		const el = $id('rec-health');
		if (!el) return;
		const msg = cardTrouble();
		if (!msg) { el.className = 'd-none'; el.innerHTML = ''; return; }
		el.className = 'alert alert-danger';
		el.innerHTML = msg + cardKernelLines() +
			'<div class="mt-2"><a class="btn btn-sm btn-danger" href="tool-sdcard.cgi">Open the SD card page</a></div>';
	}

	// Same numbers and the same bar as the SD card page, because it is the same
	// question asked from the other side: how much footage is there, and how
	// much room is left before the oldest of it is deleted.
	function renderStorage() {
		const d = state.card;
		const card = $id('rec-storage-card'), el = $id('rec-storage');
		if (!card || !el) return;
		// Hidden rather than left standing: a card unmounted while the page is
		// open would otherwise keep showing the space it had when it left.
		if (!d || !d.mounted || !d.totalKb) { card.hidden = true; return; }
		const total = d.totalKb * 1024, used = d.usedKb * 1024;
		const rec = Math.min(d.recBytes || 0, used);
		const other = Math.max(0, used - rec), free = Math.max(0, total - used);
		const seg = function (b, c) {
			return b > 0 ? '<div class="seg" style="width:' + (b / total * 100).toFixed(2) +
				'%;background:' + c + '"></div>' : '';
		};
		const dot = function (c) {
			return '<span class="dot" style="background:' + c + '"></span>';
		};
		// How much longer the card can record, from what this day's
		// footage actually costs per second.
		const day = state.day.clips.reduce(function (a, c) { return a + c.dur; }, 0);
		const bytes = state.day.clips.reduce(function (a, c) { return a + c.size; }, 0);
		// A projection of how long the card will last is a promise about future
		// writes, so it is only offered while future writes are possible.
		const left = (d.health === 'ok' && day > 0 && bytes > 0)
			? ' · about ' + TL.duration(free / (bytes / day)) + ' of footage left' : '';

		card.hidden = false;
		el.innerHTML =
			'<div class="d-flex justify-content-between x-small mb-1">' +
			'<span class="fw-semibold">Storage</span>' +
			'<span class="text-secondary">' + TL.bytes(used) + ' of ' + TL.bytes(total) + ' used' +
			esc(left) + '</span></div>' +
			'<div class="storage-bar mb-2">' + seg(rec, '#4c60d8') + seg(other, '#e08a3c') + '</div>' +
			'<div class="storage-legend x-small">' +
			'<span>' + dot('#4c60d8') + 'Recordings <span class="text-secondary">' + TL.bytes(rec) + '</span></span>' +
			'<span>' + dot('#e08a3c') + 'Other <span class="text-secondary">' + TL.bytes(other) + '</span></span>' +
			'<span><span class="dot dot-free"></span>Free <span class="text-secondary">' + TL.bytes(free) + '</span></span>' +
			(mjGet(state.cfg, 'records.maxUsage')
				? '<span class="text-secondary">oldest clips deleted at ' +
				esc(String(mjGet(state.cfg, 'records.maxUsage'))) + ' %</span>' : '') +
			'</div>';
	}

	// The card is the one thing on this page that changes underneath it. Days
	// and clips are history and a reload is the natural way to get more of
	// them, but a card goes read-only mid-session — which is exactly the
	// failure this page exists to report, and reporting it only to whoever
	// happens to load the page afterwards would miss the person already
	// watching. Slow on purpose: this is a viewer, sometimes left open on a
	// wall display, not a dashboard.
	const CARD_POLL_MS = 30000;

	function watchCard() {
		setInterval(function () {
			if (document.hidden) return;
			const before = state.card ? state.card.health : null;
			loadCard(false).then(function () {
				const after = state.card ? state.card.health : null;
				renderStorage();
				// Everything else only moves when the verdict itself moves —
				// no reason to rebuild the day picker and the clip list every
				// thirty seconds for numbers that did not change.
				if (after === before) return;
				renderHealth();
				renderDayNav();
				renderClips();
			});
		}, CARD_POLL_MS);
	}

	// Where a day should open: the freshest footage in it, not the oldest.
	// Landing on 06:00 when the camera has been running all day means watching
	// the wrong end of the archive.
	function freshest() {
		const list = state.day.clips;
		if (!list.length) return 0;
		const last = list[list.length - 1];
		return Math.max(last.start, last.end - 60);
	}

	// Turn the clip list's estimate into a measured length, in two reads.
	function hintDuration(url, clip, init) {
		IDX.durationHint(IDX.reader(url), clip.size, init).then(function (h) {
			if (!h || state.clip !== clip) return;
			state.hint = h;
			// h.approximate is the whole point of the flag: a pre-tfdt recording
			// can only be guessed at, and the clip list says so with "about"
			// rather than presenting the guess as a measurement.
			if (!TL.applyExactDuration(state.day, clip.name, h.seconds, !h.approximate)) return;
			renderClips();
			renderTimeline();

			// Until this landed the clip's length was a guess — the configured
			// split, or the gap to the next clip. A clip cut short by a reboot
			// is much shorter than that guess, so the playhead can be sitting
			// past the end of footage that does not exist. Pull it back to the
			// last moment there is, and re-aim the player at it.
			if (state.playhead > clip.end - 0.5) {
				state.playhead = Math.max(clip.start, clip.end - 0.5);
				centreView(state.playhead);
				positionAt(state.playhead - clip.start);
			}
		});
	}

	function setStatus(t) {
		const s = $id('rec-status');
		if (s) s.textContent = t || '';
	}

	// ---- codec probe (shared shape with files.js) ------------------------

	function fourcc(u8, i) { return String.fromCharCode(u8[i], u8[i + 1], u8[i + 2], u8[i + 3]); }
	function codecFromHeader(u8) {
		const moov = IDX.findBox(u8, 0, u8.length, 'moov');
		if (!moov) return null;
		const hex = function (n) { return n.toString(16).padStart(2, '0'); };
		for (let i = moov[0] + 8; i < moov[1] - 4; i++) {
			const t = fourcc(u8, i);
			if (t === 'hvc1' || t === 'hev1') return t + '.1.6.L93.B0';
			if (t === 'av01') return 'av01.0.05M.08';
			if (t === 'avc1' || t === 'avc3') {
				// the avcC that follows carries profile/compat/level verbatim
				for (let j = i; j < moov[1] - 8; j++) {
					if (fourcc(u8, j) === 'avcC') return t + '.' + hex(u8[j + 5]) + hex(u8[j + 6]) + hex(u8[j + 7]);
				}
				return t + '.42E01E';
			}
		}
		return null;
	}

	// ---- rendering -------------------------------------------------------

	function pct(sec, view) { return ((sec - view.from) / view.width * 100); }

	function renderTimeline() {
		const strip = $id('rec-strip'), band = $id('rec-band');
		if (!strip || !band) return;
		const cov = TL.coverage(state.day);
		const view = state.view;

		// whole day
		let h = '';
		cov.forEach(function (c) {
			h += '<div class="seg" style="left:' + (c.from / DAY * 100).toFixed(3) + '%;width:' +
				((c.to - c.from) / DAY * 100).toFixed(3) + '%"></div>';
		});
		h += '<div class="rec-win" style="left:' + (view.from / DAY * 100).toFixed(3) + '%;width:' +
			(view.width / DAY * 100).toFixed(3) + '%"></div>';
		strip.innerHTML = h;

		// detail band
		let b = '';
		cov.forEach(function (c) {
			if (c.to <= view.from || c.from >= view.to) return;
			const a = Math.max(c.from, view.from), z = Math.min(c.to, view.to);
			b += '<div class="seg" style="left:' + pct(a, view).toFixed(3) + '%;width:' +
				((z - a) / view.width * 100).toFixed(3) + '%"></div>';
		});
		// clip boundaries, so it is clear where one file ends and the next starts
		state.day.clips.forEach(function (c) {
			if (c.start <= view.from || c.start >= view.to) return;
			b += '<div class="rec-edge" style="left:' + pct(c.start, view).toFixed(3) + '%"></div>';
		});
		if (state.sel) {
			const a = Math.max(state.sel.from, view.from), z = Math.min(state.sel.to, view.to);
			if (z > a) {
				b += '<div class="rec-sel" style="left:' + pct(a, view).toFixed(3) + '%;width:' +
					((z - a) / view.width * 100).toFixed(3) + '%"></div>';
			}
		}
		if (state.playhead >= view.from && state.playhead <= view.to) {
			b += '<div class="rec-head" style="left:' + pct(state.playhead, view).toFixed(3) + '%">' +
				'<span class="rec-head-t">' + hhmm(state.playhead) + '</span></div>';
		}
		band.innerHTML = b;

		renderTicks();
		renderSelection();
		const lbl = $id('rec-view-label');
		if (lbl) lbl.textContent = hhmm(view.from) + ' – ' + hhmm(view.to);
	}

	function renderTicks() {
		const el = $id('rec-ticks');
		if (!el) return;
		const view = state.view, out = [];
		for (let i = 0; i <= 4; i++) out.push(hhmm(view.from + view.width * i / 4));
		el.innerHTML = out.map(function (t) { return '<span>' + t + '</span>'; }).join('');
	}

	// The whole-day axis under the ribbon. Unshifted it is the 00…24 the page
	// ships in its markup, and this reproduces it exactly rather than leaving
	// two spellings of the same axis to drift apart. Shifted, it wraps: a camera
	// day read on another clock begins and ends at the same hour, which is what
	// a 24-hour span looks like from a zone that is not the camera's.
	//
	// A zone offset by whole hours keeps the two-digit labels the strip was
	// designed for. One offset by minutes (+05:30, +05:45, and Nepal's +05:45)
	// cannot say anything true in two digits, so it gets hh:mm — and half as
	// many labels, because thirteen five-character labels do not fit the strip
	// on a phone.
	function renderHours() {
		const el = $id('rec-hours');
		if (!el) return;
		// Labelled first, thinned second: whether two digits can say anything
		// true is a property of the labels, not of a number this can assume.
		// In camera mode the last one is "24" by TL.clock's clamp, which reads
		// as the end of this day rather than the start of the next.
		const all = [];
		for (let i = 0; i <= 24; i++) all.push(hhmm(i * 3600));
		const fine = all.some(function (t) { return t.slice(3) !== '00'; });
		const out = [];
		for (let i = 0; i <= 24; i += (fine ? 4 : 2)) {
			out.push(fine ? all[i] : all[i].slice(0, 2));
		}
		el.innerHTML = out.map(function (t) { return '<span>' + t + '</span>'; }).join('');
	}

	// The part of a selection that can actually be saved. An export is whole
	// fragments out of ONE clip, so a drag running past the open clip saves
	// less than it covers — report the trimmed range, or the bar promises
	// footage the file does not contain.
	function selectionSpan() {
		if (!state.sel || !state.clip) return null;
		const clip = state.clip;
		const a = Math.max(state.sel.from, clip.start);
		const b = Math.min(state.sel.to, clip.end);
		if (b - a < 0.5) return null;                 // no overlap with this clip
		return {
			from: a, to: b, seconds: b - a,
			// Size is estimated from the clip's own average bitrate. Knowing it
			// exactly would mean indexing the span first, which is the work the
			// Save button is for — a number is more use here than a spinner.
			bytes: clip.dur > 0 ? Math.round(clip.size / clip.dur * (b - a)) : 0,
			clipped: state.sel.from < clip.start - 0.5 || state.sel.to > clip.end + 0.5,
		};
	}

	function renderSelection() {
		const bar = $id('rec-export');
		if (!bar) return;
		if (!state.sel || state.sel.to - state.sel.from < 1) { bar.className = 'd-none'; return; }
		const s = selectionSpan();
		bar.className = 'rec-export';
		if (!s) {
			bar.innerHTML = '<div class="x-small text-secondary">' +
				'Selection is outside the clip being played — pick a moment inside it first.</div>';
			return;
		}
		bar.innerHTML =
			'<div><div class="font-monospace fw-semibold">' + clock(s.from) + ' – ' + clock(s.to) + '</div>' +
			'<div class="x-small text-secondary" id="rec-sel-note">' + TL.duration(s.seconds) +
			' · about ' + TL.bytes(s.bytes) + ' · saved without re-encoding' +
			(s.clipped ? ' · trimmed to this clip' : '') + '</div></div>' +
			'<div class="mj-push-end d-flex gap-2">' +
			'<button class="btn btn-sm btn-outline-secondary" id="rec-sel-clear" type="button">Clear</button>' +
			'<button class="btn btn-sm btn-primary" id="rec-sel-save" type="button">Save clip</button></div>';
		$id('rec-sel-clear').addEventListener('click', function () { state.sel = null; renderTimeline(); });
		$id('rec-sel-save').addEventListener('click', saveSelection);
	}

	function renderClips() {
		const el = $id('rec-clips');
		if (!el) return;
		const list = state.day.clips;
		if (!list.length) {
			el.innerHTML = '<div class="text-secondary small">No clips in this day.</div>';
			return;
		}
		let h = '';
		// timeline.js calls the newest clip "recording" when it ends about now,
		// which is a statement about the clock and cannot know the card stopped
		// accepting writes. On a card that cannot be written the last clip is
		// not growing — it is the truncated one the failure interrupted.
		const writable = cardWritable();
		// newest first: that is the one people want
		list.slice().reverse().forEach(function (c, i, arr) {
			const prev = arr[i + 1];
			if (prev && c.start - prev.end > TL.JOIN_TOLERANCE) {
				h += '<div class="rec-gap"><span>not recording · ' +
					hhmm(prev.end) + ' – ' + hhmm(c.start) + '</span></div>';
			}
			const on = state.clip && state.clip.name === c.name;
			h += '<button type="button" class="rec-clip' + (on ? ' active' : '') + '" data-clip="' + esc(c.name) + '">' +
				'<span class="rec-poster"' + (c.recording && writable ? ' data-live="1"' : '') + '>' +
				'<span class="rec-poster-t">' + hhmm(c.start) + '</span></span>' +
				'<span class="rec-clip-m"><span class="font-monospace fw-semibold">' + hhmm(c.start) + '</span>' +
				'<span class="x-small text-secondary">' +
				(c.recording && writable ? 'recording'
					: (c.estimated ? '≈ ' : '') + TL.duration(c.dur)) +
				' · ' + TL.bytes(c.size) + '</span></span></button>';
		});
		if (state.day.unplaced.length) {
			h += '<div class="rec-gap"><span>' + state.day.unplaced.length +
				' clip(s) whose name has no time</span></div>';
			state.day.unplaced.forEach(function (c) {
				h += '<button type="button" class="rec-clip" data-clip="' + esc(c.name) + '">' +
					'<span class="rec-poster"><span class="rec-poster-t">?</span></span>' +
					'<span class="rec-clip-m"><span class="font-monospace fw-semibold">' + esc(c.name) + '</span>' +
					'<span class="x-small text-secondary">' + TL.bytes(c.size) + '</span></span></button>';
			});
		}
		el.innerHTML = h;
	}

	function renderDayNav() {
		const el = $id('rec-daynav');
		if (!el) return;
		refreshTz();
		const i = state.days.map(function (d) { return d.name; }).indexOf(state.dayName);
		const prev = i > 0 ? state.days[i - 1].name : '';
		const next = i >= 0 && i < state.days.length - 1 ? state.days[i + 1].name : '';
		const label = state.dayName === '.' ? 'All recordings' : state.dayName;
		const total = state.day.clips.reduce(function (a, c) { return a + c.dur; }, 0);

		// The choice only exists when there is something to choose: a camera set
		// to the viewer's own zone prints the same times either way, and offering
		// a switch between two identical readings would be inventing a question.
		const differs = state.tzDiffers;
		const local = state.tzOn;
		const camZone = offsetLabel(state.tzCamOff);
		const myZone = offsetLabel(state.tzMyOff);
		const tz = !differs ? '' :
			'<span class="btn-group" role="group" aria-label="Which clock times are shown in">' +
			'<button type="button" class="btn btn-sm ' +
			(local ? 'btn-outline-secondary' : 'btn-primary') + '" id="rec-tz-cam"' +
			' aria-pressed="' + (local ? 'false' : 'true') + '">camera</button>' +
			'<button type="button" class="btn btn-sm ' +
			(local ? 'btn-primary' : 'btn-outline-secondary') + '" id="rec-tz-loc"' +
			' aria-pressed="' + (local ? 'true' : 'false') + '">your zone</button></span>';

		// What the trailing note says. With the zones agreed it stays what it
		// always was. With them apart it is the one line that explains why the
		// ribbon reads the way it does — including, in the viewer's own clock,
		// that a camera day no longer starts at midnight.
		const deltaMs = state.tzMyOff - state.tzCamOff;
		const zoneNote = !differs ? esc(label)
			: local
				? 'your time (' + esc(myZone) + ') · camera day ' + esc(label) +
					' starts ' + hhmm(0) + ' here'
				: 'camera time (' + esc(camZone) + '), ' +
					(deltaMs > 0 ? 'behind' : 'ahead of') + ' yours by ' +
					TL.duration(Math.abs(deltaMs) / 1000);

		el.innerHTML =
			'<button class="btn btn-sm btn-outline-secondary" id="rec-prev" type="button"' +
			(prev ? '' : ' disabled') + ' aria-label="Previous day">&lsaquo;</button>' +
			'<select class="form-select form-select-sm rec-daypick" id="rec-daysel">' +
			state.days.map(function (d) {
				return '<option value="' + esc(d.name) + '"' + (d.name === state.dayName ? ' selected' : '') + '>' +
					esc(d.name === '.' ? 'All recordings' : d.name) + ' — ' + d.clips + ' clip' + (d.clips === 1 ? '' : 's') +
					'</option>';
			}).join('') + '</select>' +
			'<button class="btn btn-sm btn-outline-secondary" id="rec-next" type="button"' +
			(next ? '' : ' disabled') + ' aria-label="Next day">&rsaquo;</button>' +
			'<span class="small text-secondary">' + state.day.clips.length + ' clips · ' + TL.duration(total) + '</span>' +
			tz +
			// Four states, not two: the switch being on is a setting, and a card
			// that cannot be written to makes a green "Recording" badge the
			// loudest wrong thing on the page. The fourth is the card we could
			// not ask — still not green, because green is a claim.
			(!state.enabled
				? '<span class="mj-push-end badge text-bg-secondary">Recording off</span>'
				: cardTrouble()
					? '<span class="mj-push-end badge text-bg-danger">Cannot record</span>'
					: cardWritable()
						? '<span class="mj-push-end badge text-bg-success">Recording</span>'
						: '<span class="mj-push-end badge text-bg-secondary" ' +
							'title="Recording is switched on, but the SD card\'s state could not be read">' +
							'Recording — card unknown</span>') +
			'<span class="small text-secondary">' + zoneNote + '</span>';

		if (prev) $id('rec-prev').addEventListener('click', function () { goDay(prev); });
		if (next) $id('rec-next').addEventListener('click', function () { goDay(next); });
		$id('rec-daysel').addEventListener('change', function (e) { goDay(e.target.value); });
		if (differs) {
			$id('rec-tz-cam').addEventListener('click', function () { setTz('camera'); });
			$id('rec-tz-loc').addEventListener('click', function () { setTz('local'); });
		}
		renderHours();
	}

	// Only the printing changes, so nothing is reloaded and nothing is re-seeked
	// — the playhead, the selection and the clip that is playing are all held in
	// camera-local seconds and do not move. Every surface that prints a time is
	// redrawn, which is the whole list: the ribbon and its axis, the detail band
	// and its ticks, the clip list, and the export bar.
	function setTz(mode) {
		setTzMode(mode);
		renderDayNav();     // updates the shift, the buttons and the axis
		renderTimeline();   // band, ticks, playhead label, and the selection
		renderClips();
	}

	// ---- export ----------------------------------------------------------

	// A clip is the init segment followed by whole fragments, so an export is a
	// byte concatenation — no transcoding, and the camera only ever sendfiles
	// the ranges it is asked for.
	// Assemble the selection as a real file, without re-encoding it.
	//
	// Fragments are self-contained, so the clip is the init segment followed by
	// whole fragments — a byte concatenation. Only the selected span is indexed
	// (spanFrom), so a one-minute cut costs about sixty small reads instead of
	// the eleven hundred a whole-clip index would.
	function saveSelection() {
		const btn = $id('rec-sel-save'), noteEl = $id('rec-sel-note');
		const clip = state.clip, init = state.init;
		const s = selectionSpan();
		if (!s || !btn || !init) return;

		btn.disabled = true;
		btn.textContent = 'Saving…';
		const read = IDX.reader(fileUrl(clipPath(clip.name)));
		const per = state.hint ? state.hint.perFragment : 1;

		IDX.locate(read, clip.size, init, s.from - clip.start, per).then(function (hit) {
			// locate lands at or BEFORE the requested second, so the span has to
			// be measured from where it actually landed. Walking the selection's
			// own length from an earlier boundary would add lead-in at the front
			// and drop exactly as much off the end that was asked for.
			const need = (s.to - clip.start) - hit.approxSec;
			return IDX.spanFrom(read, clip.size, init, hit.off, need, function (got, want) {
				if (noteEl) noteEl.textContent = 'Collecting ' + TL.duration(got) + ' of ' + TL.duration(want) + '…';
			});
		}).then(function (span) {
			if (!span.fragments.length) throw new Error('no fragments in range');
			const r = IDX.exportRanges(span, 0, span.duration);
			if (noteEl) noteEl.textContent = 'Fetching ' + TL.bytes(r.bytes) + '…';
			return Promise.all([
				read(r.header.start, r.header.end - 1),
				read(r.body.start, r.body.end - 1),
			]).then(function (parts) { return { parts: parts, span: span, r: r }; });
		}).then(function (o) {
			const blob = new Blob(o.parts, { type: 'video/mp4' });
			const a = document.createElement('a');
			a.href = URL.createObjectURL(blob);
			a.download = stampDate(s.from) +
				hhmm(s.from).replace(':', '-') + '_' +
				hhmm(s.from + o.span.duration).replace(':', '-') + '.mp4';
			document.body.appendChild(a);
			a.click();
			a.remove();
			setTimeout(function () { URL.revokeObjectURL(a.href); }, 30000);
			btn.disabled = false;
			btn.textContent = 'Save clip';
			if (noteEl) {
				noteEl.textContent = 'Saved ' + TL.duration(o.span.duration) + ' · ' +
					TL.bytes(blob.size) + ' · ' + o.span.fragments.length + ' fragments, not re-encoded';
			}
		}).catch(function () {
			btn.disabled = false;
			btn.textContent = 'Save clip';
			note('Could not assemble the clip — the card may be busy. Try a shorter range.', 'danger');
		});
	}

	// ---- interaction -----------------------------------------------------

	function secAtEvent(el, e) {
		const r = el.getBoundingClientRect();
		const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
		return Math.max(0, Math.min(1, x / r.width));
	}

	function goTo(sec) {
		state.playhead = Math.max(0, Math.min(sec, DAY));
		let hit = TL.at(state.day, state.playhead);
		if (!hit) {
			// Scrubbing over a hole: skip to the next footage rather than
			// snapping to a neighbour, which would jump in time without saying
			// so. One hop only — nextCovered lands on a covered instant, so a
			// second miss means there is nothing to play and we just move the
			// playhead.
			const nxt = TL.nextCovered(state.day, state.playhead);
			if (nxt === null) { renderTimeline(); return; }
			state.playhead = nxt;
			hit = TL.at(state.day, nxt);
			if (!hit) { renderTimeline(); return; }
		}
		if (!state.clip || state.clip.name !== hit.clip.name) {
			openClip(hit.clip, hit.offset);
			renderClips();
		} else {
			positionAt(hit.offset);
		}
		renderTimeline();
	}

	function centreView(sec) {
		state.view = TL.window(sec, ZOOMS[zoom]);
		renderTimeline();
	}

	function wire() {
		const strip = $id('rec-strip'), band = $id('rec-band');

		// day strip: click or drag the window
		let stripDrag = false;
		const stripMove = function (e) {
			centreView(secAtEvent(strip, e) * DAY);
			e.preventDefault();
		};
		strip.addEventListener('mousedown', function (e) { stripDrag = true; stripMove(e); });
		strip.addEventListener('touchstart', function (e) { stripDrag = true; stripMove(e); }, { passive: false });
		document.addEventListener('mousemove', function (e) { if (stripDrag) stripMove(e); });
		document.addEventListener('touchmove', function (e) { if (stripDrag) stripMove(e); }, { passive: false });
		document.addEventListener('mouseup', function () { stripDrag = false; });
		document.addEventListener('touchend', function () { stripDrag = false; });

		// detail band: drag scrubs, shift-drag selects a range to export
		let mode = null, anchorSec = 0;
		const bandSec = function (e) { return state.view.from + secAtEvent(band, e) * state.view.width; };
		const bandDown = function (e) {
			const s = bandSec(e);
			if (e.shiftKey || e.altKey) { mode = 'sel'; anchorSec = s; state.sel = { from: s, to: s }; renderTimeline(); }
			else { mode = 'scrub'; goTo(s); }
			e.preventDefault();
		};
		const bandMove = function (e) {
			if (!mode) return;
			const s = bandSec(e);
			if (mode === 'sel') {
				state.sel = { from: Math.min(anchorSec, s), to: Math.max(anchorSec, s) };
				renderTimeline();
			} else { goTo(s); }
			e.preventDefault();
		};
		band.addEventListener('mousedown', bandDown);
		band.addEventListener('touchstart', bandDown, { passive: false });
		document.addEventListener('mousemove', bandMove);
		document.addEventListener('touchmove', bandMove, { passive: false });
		document.addEventListener('mouseup', function () { mode = null; });
		document.addEventListener('touchend', function () { mode = null; });

		// wheel zooms the detail band around the pointer
		band.addEventListener('wheel', function (e) {
			const at = bandSec(e);
			const was = zoom;
			zoom = Math.max(0, Math.min(ZOOMS.length - 1, zoom + (e.deltaY > 0 ? 1 : -1)));
			if (zoom !== was) { centreView(at); e.preventDefault(); }
		}, { passive: false });

		$id('rec-clips').addEventListener('click', function (e) {
			const b = e.target.closest('[data-clip]');
			if (!b) return;
			const name = b.dataset.clip;
			const c = state.day.clips.filter(function (x) { return x.name === name; })[0] ||
				state.day.unplaced.filter(function (x) { return x.name === name; })[0];
			if (!c) return;
			if (c.start !== null && c.start !== undefined) {
				state.playhead = c.start;
				centreView(c.start);
			}
			openClip(c, 0);
			renderClips();
		});

		const v = $id('rec-video');
		v.addEventListener('timeupdate', function () {
			if (!state.clip || state.clip.start === null) return;
			const t = state.clip.start + v.currentTime;
			// Only repaint when the playhead has actually moved a pixel's worth.
			if (Math.abs(t - state.playhead) < state.view.width / 800) return;
			state.playhead = t;
			renderTimeline();
		});
		v.addEventListener('error', function () {
			if (!state.clip) return;
			const url = fileUrl(clipPath(state.clip.name));
			// While MSE is driving and nothing has ever buffered, the
			// SourceBuffer could not make sense of the media — a pre-tfdt
			// recording, most likely — and the plain element has no such
			// trouble. If data HAS buffered, the error is something else and
			// throwing away a working player would only make it worse.
			if (player && !player.hasData()) { plainFallback(state.clip, url); return; }
			note('Playback stopped on <code>' + esc(state.clip.name) + '</code>. ' +
				'<a href="' + esc(url) + '" download>Save the clip</a> instead.', 'danger');
		});

		const dl = $id('rec-dl');
		if (dl) dl.addEventListener('click', function () {
			if (!state.clip) return;
			const a = document.createElement('a');
			a.href = fileUrl(clipPath(state.clip.name));
			a.download = state.clip.name;
			document.body.appendChild(a); a.click(); a.remove();
		});
	}

	function goDay(name) {
		if (!name || name === state.dayName) return;
		state.clip = null; state.init = null; state.hint = null; state.sel = null;
		const v = $id('rec-video');
		if (v) { try { v.removeAttribute('src'); v.load(); } catch (e) {} }
		history.replaceState(null, '', location.pathname + '?day=' + encodeURIComponent(name));
		loadDay(name).then(function () {
			renderDayNav(); renderClips();
			note('');
			centreView(freshest());
			goTo(freshest());
		});
	}

	// ---- boot ------------------------------------------------------------

	function empty(msg, cta, kind) {
		$id('rec-main').className = 'd-none';
		note(msg + (cta || ''), kind || 'secondary');
	}

	Promise.all([loadConfig(), loadPulse()]).then(function () {
		if (!state.prefix) {
			return empty('<strong>Recording is not configured.</strong> No recording path is set, so there is nothing to browse. ',
				'<a href="tool-sdcard.cgi">Set up the SD card</a>.');
		}
		return Promise.all([loadDays(), loadCard()]).then(function () {
			if (!state.days.length) {
				// The card gets the first word: "nothing recorded yet" is a
				// guess, and a read-only or unreadable card is the answer.
				// Only when the card is fine is an empty archive really about
				// whether recording is switched on.
				const bad = cardTrouble();
				return empty(bad ||
					(state.enabled
						? '<strong>Nothing recorded yet.</strong> Recording is on, but no clips have been written to <code>' + esc(state.prefix) + '</code> yet.'
						: '<strong>Recording is off.</strong> The camera is not writing to the card, so there is nothing to browse.'),
					' <a href="tool-sdcard.cgi">SD card</a>' + (bad ? cardKernelLines() : ''),
					bad ? 'danger' : 'secondary');
			}
			const want = (/[?&]day=([^&]*)/.exec(location.search) || [])[1];
			const asked = want ? decodeURIComponent(want) : '';
			const names = state.days.map(function (d) { return d.name; });
			const pick = names.indexOf(asked) >= 0 ? asked : names[names.length - 1];

			return loadDay(pick).then(function () {
				wire();
				renderDayNav();
				renderClips();
				renderHealth();
				renderStorage();
				watchCard();
				centreView(freshest());
				goTo(freshest());     // opens the clip, so the page is not a black box
			});
		});
	});
})();
