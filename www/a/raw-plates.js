/*
 * What the raw editor is given so it can read a plate.
 *
 * The same shape as the `calibrate` object next door in raw.js, and for the
 * same reason: the editor is fetched from a CDN and knows nothing about this
 * camera, so everything that touches it — the endpoints, the status codes worth
 * explaining, and above all the settings that have to be put back — stays here,
 * in the copy that ships with the firmware.
 *
 * Three things live in this file and nowhere else.
 *
 * WHAT THE CAMERA WILL ACTUALLY DO. A rectangle drawn on a plate is not the
 * rectangle the camera cuts, nor the one auto-exposure meters. Both are worked
 * out up front by mj-plate-roi.js so the editor can show the answer before it
 * asks the question, rather than after.
 *
 * PUTTING THINGS BACK. Arming a camera for plates is five settings at once,
 * every one of them survives a reboot, and the worst of them ruins the very
 * picture you would use to notice. So this remembers what was there first,
 * restores on demand, CHECKS the restore landed, runs a countdown so an arming
 * nobody confirms undoes itself, and makes a best effort even if the tab goes
 * away mid-countdown.
 *
 * GRACEFUL ABSENCE. The reader is a separate, opt-in download (see
 * lpr-loader.js). `readerSupported` is false when nothing is configured, and
 * raw.js then passes no plate capability at all — so the editor builds no
 * Plates tab rather than one that cannot work.
 */
window.MajesticPlates = (function () {
	'use strict';

	const ROI = window.MajesticPlateRoi;

	/* The five keys one "set the camera up for plates" writes. They go in one
	 * batch because they only make sense together — a short shutter without the
	 * metering rectangle is a dark picture, and the metering rectangle without
	 * pinned gains is auto-exposure undoing the shutter. POST /api/v1/config
	 * walks every leaf, aborts on the first it rejects and only then reloads and
	 * saves, so five keys that must agree cannot be five requests. */
	const KEYS = ['meterRect', 'exposure', 'aGain', 'dGain', 'aeStrategy'];

	/* How long an arming lives if nobody confirms it. */
	const HOLD_SECONDS = 30;

	function dngErr(status) {
		if (status === 501)
			return new Error('Raw capture is switched off for this camera. ' +
				'Turn it on in Settings, under Live — the image settings are ' +
				'drawn there, not on a page of their own.');
		if (status === 404)
			return new Error('This firmware does not serve raw frames. Raw capture ' +
				'needs a HiSilicon or Goke part whose SDK exposes the sensor’s own data.');
		if (status === 503)
			return new Error('The camera is already busy with a raw frame. Most ' +
				'cameras take them one at a time — wait for that one to finish ' +
				'and ask again.');
		return new Error('The camera answered ' + status + '.');
	}

	function getDng(query, signal) {
		return apiFetch('/image.dng' + (query ? '?crop=' + query : ''),
			{ credentials: 'same-origin', signal: signal })
			.then(function (r) {
				if (!r.ok) throw dngErr(r.status);
				return r.arrayBuffer();
			})
			.then(function (buf) { return new Uint8Array(buf); });
	}

	/* As getDng, but reporting what the camera says it averaged. The header is
	 * the only way to tell a build that honoured `?frames=` from one that has
	 * never heard of it -- both answer 200 with a frame. */
	function getDngWithCount(query, signal) {
		return apiFetch('/image.dng?crop=' + query,
			{ credentials: 'same-origin', signal: signal })
			.then(function (r) {
				if (!r.ok) throw dngErr(r.status);
				const n = parseInt(r.headers && r.headers.get
					? r.headers.get('X-Frames-Averaged') : '', 10);
				return r.arrayBuffer().then(function (buf) {
					return { bytes: new Uint8Array(buf), averaged: n > 0 ? n : 1 };
				});
			});
	}

	/* One whole frame. Frames are never written to the camera: a raw frame is
	 * several megabytes and the flash it would land on holds the firmware. */
	function frame() { return getDng(null); }

	/* The most frames the camera will average in ONE request. Its accumulator
	 * is four bytes a pixel for the duration, which is why a burst without a
	 * crop is refused rather than attempted. Asking for more earns a 400.
	 *
	 * It is not a limit on how many frames a caller may have. Asking for them
	 * one at a time uses no accumulator at all — each is an ordinary capture —
	 * so that path keeps the ceiling it always had. They are two different
	 * numbers because they are two different constraints, and collapsing them
	 * would quietly cut a forty-frame rejection down to sixteen. */
	const BURST_MAX = 16;
	const SEPARATE_MAX = 64;

	/*
	 * A burst of one region, and there are two ways to get one.
	 *
	 * IN THE CAMERA, which is the default and is what you want. `?frames=N`
	 * averages N CONSECUTIVE sensor frames into a single file and hands back one
	 * frame with the noise already down by the square root of the count. It is
	 * ONE request and one capture: the camera keeps its raw dump running for the
	 * duration, so the frames are consecutive — 0.8 s of sensor time at 20 fps
	 * for the full sixteen — rather than the better part of a second apart.
	 *
	 * ONE AT A TIME, when the caller needs the frames themselves. Outlier
	 * rejection and a before-and-after comparison both need the individuals, and
	 * an average cannot be taken apart again. This costs about 0.79 s PER FRAME,
	 * because each request is a fresh capture rather than a read out of frames
	 * the sensor already took — sixteen of them is around thirteen seconds, over
	 * which a car can move and a cloud can pass. `onProgress` exists for this
	 * path, and `separate: true` is how a caller asks for it deliberately.
	 *
	 * Sequential, never parallel, on that path: most cameras take raw frames one
	 * at a time and answer 503 to a second in flight, so overlapping them turns
	 * a burst into a string of failures.
	 *
	 * A camera too old for `?frames=` ignores it and sends one frame. It says so
	 * in `X-Frames-Averaged`, so that is read rather than assumed, and the slow
	 * path picks up the rest.
	 *
	 * `asked` is what the caller wanted; `rect` is what the camera cut. They
	 * differ whenever the request was off the colour mosaic, and the difference
	 * is not cosmetic: every pixel in a misaligned rectangle changes colour.
	 */
	function burst(opts) {
		opts = opts || {};
		const want = opts.rect;
		const separate = opts.separate === true;
		const frames = Math.max(1, Math.min(opts.frames || BURST_MAX,
			separate ? SEPARATE_MAX : BURST_MAX));
		const cut = ROI.alignCrop(want, opts.frameW, opts.frameH, opts.bits || 12);
		if (!cut) {
			return Promise.reject(new Error(
				'That region is not one the camera can cut. It has to have some ' +
				'area and start inside the picture.'));
		}
		const query = ROI.cropQuery(cut);

		function cancelled() {
			return opts.signal && opts.signal.aborted;
		}

		function oneAtATime(n, already) {
			const out = already || [];
			// A frame already in hand still counts. Reporting it only once the
			// NEXT one lands would skip a step and make the first wait look
			// twice as long as the rest.
			if (out.length && opts.onProgress) opts.onProgress(out.length, n);
			let chain = Promise.resolve();
			for (let i = out.length; i < n; i++) {
				chain = chain.then(function () {
					if (cancelled()) throw new Error('cancelled');
					return getDng(query, opts.signal);
				}).then(function (bytes) {
					out.push(bytes);
					if (opts.onProgress) opts.onProgress(out.length, n);
				});
			}
			return chain.then(function () {
				return { rect: cut, asked: want, frames: out, averaged: 1, inCamera: false };
			});
		}

		if (separate || frames === 1) return oneAtATime(frames);

		/* The fast path. No `onProgress` on it at all: there is one request and
		 * one capture, so a frame counter would be a progress bar with a single
		 * step — and if this turns out to be an old camera the counter has to
		 * start again with a different total. The caller says what it is doing
		 * and the counter appears only if the slow path is reached. */
		if (cancelled()) return Promise.reject(new Error('cancelled'));
		return getDngWithCount(query + '&frames=' + frames, opts.signal)
			.then(function (got) {
				/* Anything above one frame was averaged BY THE CAMERA, and the
				 * count is the camera's own: it drops a frame whose geometry
				 * does not match the first, so a burst of sixteen can honestly
				 * come back as fourteen. That is a smaller stack, not a failed
				 * one, and it is reported as what it is.
				 *
				 * Exactly one frame is the other thing entirely: a build that
				 * has never heard of `?frames=` answers 200 with a single
				 * ordinary capture and no header. Mixing that averaged file
				 * back in with individual frames would put an average and its
				 * own constituents in one array and call them all single
				 * frames, which is why the two cases are told apart here and
				 * not by how many were asked for. */
				if (got.averaged > 1) {
					return { rect: cut, asked: want, frames: [got.bytes],
						averaged: got.averaged, inCamera: true };
				}
				// Too old for it. Keep the frame it did send and fetch the rest.
				return oneAtATime(frames, [got.bytes]);
			});
	}

	/* ---------------------------------------------------------------- camera */

	/*
	 * Which of the five this camera actually has.
	 *
	 * Found by deploying: a batch write is ALL-OR-NOTHING — majestic walks the
	 * leaves, aborts on the first it does not recognise and answers 404 — so
	 * arming a camera whose daemon predates `isp.meterRect` fails wholesale and
	 * tells the operator only "the camera answered 404". Worse, quietly dropping
	 * the unknown keys and sending the rest would pin a short shutter with NO
	 * metering rectangle, which is a dark picture and none of the benefit.
	 *
	 * The schema is the right question: it is what the daemon says it has, per
	 * SoC and per build, and `isp.meterRect` exists only on gen-4 HiSilicon
	 * parts even in a current majestic.
	 */
	let supported = null;
	function supports() {
		if (supported) return supported;
		supported = apiFetch('/api/v1/config.schema.json', { credentials: 'same-origin' })
			.then(function (r) {
				if (!r.ok) throw new Error('The camera would not describe its settings.');
				return r.json();
			})
			.then(function (sc) {
				const isp = (sc && sc.properties && sc.properties.isp &&
					sc.properties.isp.properties) || {};
				const out = {};
				KEYS.forEach(function (k) { out[k] = k in isp; });
				return out;
			})
			.catch(function (e) {
				supported = null;     // a transient failure must not be cached
				throw e;
			});
		return supported;
	}

	/* The keys a given request needs, which is not all five: a caller may
	 * legitimately pin only the shutter. */
	function needed(vals) {
		return KEYS.filter(function (k) { return vals[k] !== null; });
	}

	/*
	 * Only the keys this daemon has.
	 *
	 * A `null` leaf is a REMOVAL request, and a removal of a key the camera does
	 * not have is still an unknown key: the config endpoint answers 404 for it,
	 * exactly as it does for a write. So a revert built from all five fails on
	 * the very camera whose missing keys made the arming partial in the first
	 * place. Observed on a camera whose firmware predated one of these keys: it
	 * left the shutter pinned at 1 ms with no way back from the page.
	 */
	function only(vals, have) {
		const out = {};
		KEYS.forEach(function (k) { if (have[k]) out[k] = vals[k]; });
		return out;
	}

	function readKeys() {
		return apiFetch('/api/v1/config.json', { credentials: 'same-origin' })
			.then(function (r) {
				if (!r.ok) throw new Error('The camera would not say what it is set to now.');
				return r.json();
			})
			.then(function (cfg) {
				const isp = (cfg && cfg.isp) || {};
				const was = {};
				// null for a key that was not there, so restoring REMOVES it
				// again rather than leaving a value behind. Nothing else can say
				// it: "" reaches the setter, and an integer field stores 0.
				KEYS.forEach(function (k) { was[k] = k in isp ? isp[k] : null; });
				return was;
			});
	}

	function setKeys(vals) {
		return apiFetch('/api/v1/config', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'same-origin',
			body: JSON.stringify({ isp: vals }),
		}).then(function (r) {
			if (!r.ok) throw new Error('The camera answered ' + r.status + '.');
		});
	}

	function same(a, b) {
		return KEYS.every(function (k) {
			return JSON.stringify(a[k]) === JSON.stringify(b[k]);
		});
	}

	/* Older majestic answers 202 and ignores null leaves, so a revert that meant
	 * to remove a key has to be checked rather than assumed — the same reason
	 * mj-settings.js re-reads after a save. */
	function confirmRestored(was) {
		return readKeys().then(function (now) {
			if (same(now, was)) return;
			throw new Error('the camera did not take the old settings back; ' +
				'this firmware may be too old to remove a setting.');
		});
	}

	let previous = null;
	let previousHave = null;

	/*
	 * The dead man's handle.
	 *
	 * Arming pins the shutter at a millisecond with the gains held down. On a
	 * camera that is also somebody's live view, that is a picture so dark it
	 * reads as a broken sensor — and the settings survive a reboot, so it stays
	 * broken. The safety net only works if whoever called `apply` remembers to
	 * call `revert`, and a test harness of mine did not: three presses of an Arm
	 * button left a lab camera pinned until it was cleared by hand, twice
	 * without anyone noticing for minutes. `holdSeconds` was declared on the
	 * object and honoured by nobody.
	 *
	 * So the timer lives HERE rather than in the caller's UI. `apply` arms it,
	 * `keep` cancels it, `revert` cancels it, and a caller that simply walks
	 * away gets its camera back. A consumer that wants to run the countdown
	 * itself passes `hold: false` and takes the duty on deliberately.
	 */
	let holdTimer = null;
	function cancelHold() {
		if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
	}
	function startHold(secs, onExpire) {
		cancelHold();
		if (!(secs > 0)) return;
		holdTimer = setTimeout(function () {
			holdTimer = null;
			revert().then(function () {
				if (onExpire) onExpire(null);
			}, function (e) {
				if (onExpire) onExpire(e);
			});
		}, secs * 1000);
	}

	/* Best effort if the tab goes away mid-countdown. keepalive lets a request
	 * outlive the page; nothing guarantees it arrives, which is why the hold
	 * above is the safety net and this is only a courtesy.
	 *
	 * Registered once and kept, reading `previous` when it fires rather than
	 * closing over it — arming a fresh one per attempt would leave a handler per
	 * attempt, and clearing `previous` is then the single thing that disarms all
	 * of them. */
	let unloadArmed = false;
	function armUnloadRevert() {
		if (unloadArmed) return;
		unloadArmed = true;
		window.addEventListener('pagehide', function () {
			if (!previous) return;
			try {
				fetch('/api/v1/config', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					credentials: 'same-origin',
					keepalive: true,
					body: JSON.stringify({ isp: only(previous, previousHave) }),
				});
			} catch (e) { /* the page is going; nothing to report it to */ }
		});
	}

	/*
	 * What auto-exposure will really meter, given the region and the frame.
	 *
	 * Pure, and meant to be called while the operator is still looking at the
	 * rectangle. The ISP will not meter below 256x120, so a plate-sized request
	 * is grown around its own centre by a factor of forty-odd — which is still
	 * enormously more selective than the whole frame, and is the reason the
	 * feature works at all, but it is not what was drawn and saying so
	 * afterwards is too late.
	 */
	function plan(rect, frameW, frameH) {
		const got = ROI.meterCrop(rect, frameW, frameH);
		if (!got) return null;
		return {
			rect: got,
			grown: ROI.grown(rect, got),
			factor: ROI.growthFactor(rect, got),
			minW: ROI.AE_MIN_W,
			minH: ROI.AE_MIN_H,
		};
	}

	/*
	 * Arm the camera for plates.
	 *
	 * `meterRect` goes on the wire as an ARRAY of "XxYxWxH" strings, which is
	 * how majestic spells a MultiRect everywhere; only the first is metered,
	 * because the AE crop is one window. The rectangle sent is the one that was
	 * drawn, not the grown one — the daemon does the growing, and sending it
	 * back its own arithmetic would mean two places that have to agree about the
	 * ISP's minimum instead of one.
	 *
	 * `aeStrategy` is one of 'default', 'highlight' or 'lowlight' — the daemon's
	 * own three, spelled its way. 'default' is not a no-op: it is the value that
	 * puts the ISP back to whatever it booted with.
	 */
	function apply(o) {
		const rect = o.rect;
		const vals = {
			meterRect: rect ? [ROI.cropQuery(rect)] : null,
			exposure: typeof o.exposureMs === 'number' ? o.exposureMs : null,
			aGain: typeof o.aGain === 'number' ? o.aGain : null,
			dGain: typeof o.dGain === 'number' ? o.dGain : null,
			aeStrategy: o.aeStrategy || null,
		};
		return supports().then(function (have) {
			const missing = needed(vals).filter(function (k) { return !have[k]; });
			if (missing.length) {
				throw new Error('This camera’s firmware has no ' +
					missing.map(function (k) { return 'isp.' + k; }).join(' or ') +
					'. Arming needs a newer majestic — the settings are written ' +
					'together or not at all, so the rest are not applied either.');
			}
			/* Snapshot ONLY when not already armed.
			 *
			 * A second apply while the camera is still armed would otherwise
			 * record the ARMED configuration as the restore target, and every
			 * way back -- the countdown, the unload handler, an explicit revert
			 * -- would then put the camera back to armed and call it restored.
			 * Re-arming is ordinary: an operator nudges the shutter, or picks a
			 * different plate, without pressing Put it back first. */
			const snap = previous ? Promise.resolve(previous) : readKeys();
			return snap.then(function (was) {
				previous = was;
				previousHave = have;
				armUnloadRevert();
				return setKeys(only(vals, have));
			}).then(function () {
				if (o.hold !== false) startHold(o.holdSeconds || HOLD_SECONDS, o.onExpire);
			});
		});
	}

	function revert() {
		cancelHold();
		if (!previous) return Promise.resolve();
		const was = previous, have = previousHave;
		return setKeys(only(was, have))
			.then(function () { return confirmRestored(was); })
			.then(function () { previous = null; previousHave = null; });
	}

	/* Confirmed. Forgetting what was there before is what stands the unload
	 * handler and the countdown down — without this they would put the old
	 * settings back, undoing an arming that was kept on purpose. */
	function keep() { cancelHold(); previous = null; previousHave = null; return Promise.resolve(); }

	/* Whether the camera is armed right now, for a UI that has to say so. */
	function armed() { return previous !== null; }

	/* ---------------------------------------------------------------- reader */

	/* Whether a reader can be had at all: this browser can run one AND the
	 * operator has configured where it comes from. False here is why raw.js
	 * passes no plate capability, and why the editor then builds no tab. */
	const readerSupported = !!(window.MajesticLpr && window.MajesticLpr.available);
	function reader() {
		if (!window.MajesticLpr) return Promise.reject(new Error('unavailable'));
		return window.MajesticLpr.open();
	}

	return {
		frame: frame,
		burst: burst,
		exposure: {
			holdSeconds: HOLD_SECONDS,
			plan: plan, apply: apply, revert: revert, keep: keep,
			armed: armed, supports: supports,
			keys: KEYS.map(function (k) { return 'isp.' + k; }),
		},
		reader: reader,
		readerSupported: readerSupported,
	};
})();
