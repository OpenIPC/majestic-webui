// The camera picture, as a thing a settings section can embed.
//
// mj-settings.cgi shows one section at a time, and more than one of them wants
// to look at the camera while you change it: the Live adjustments leaf does
// today, and the regions a Visual editor draws, the crop a resolution field
// implies and the masks a privacy section places are all judgements nobody can
// make against a form. What every one of them needs is the same three things —
// a picture that plays, a channel to pick, and an honest sentence when there is
// no picture to be had — and that was written once, inline, against a fixed set
// of element ids (`mj-live-video`, `mj-live-canvas`, `mj-live-alert`, …). Ids
// are what make a component single-use: two of them on one page are the same
// element, and `getElementById` hands both instances the first one.
//
// So this file owns the picture and nothing else. It resolves every node inside
// its own stage, generates its own control names, and returns a handle. What it
// deliberately does NOT own is anything a particular section means by looking:
// the Live leaf's night/IR/lamp switches are runtime state, its hold-to-compare
// is about x-live knobs, its luma histogram is about exposure. Those go in the
// bar and beside the stage from outside, through `barInsert` and `media()`, and
// this file never learns they exist.
//
// WHAT IS NOT HERE, and why. The transport ladder's *rules* — which transport to
// prefer, what to remember, when a failure is durable — stay in
// preview-transport.js, and the swap itself stays in preview-swap.js. Both are
// already shared with the Live View page (preview-page.js), which wants
// different things from an outcome: it has an MJPEG fallback, a badge, a stats
// panel and a zoom rule, none of which belong on a settings panel. This is the
// third consumer of those two modules, not a second copy of them.
//
// Requires: preview.js, preview-webrtc.js, preview-swap.js, preview-wasm.js,
// preview-transport.js, and (optionally) preview-hero.js for the two icon
// buttons. `apiFetch` is a global from main.js.
window.MajesticPreview = (function () {
	'use strict';

	// The stage's own two icons. They live here rather than in the caller's icon
	// map because the buttons they sit on are this component's: a caller that
	// asks for a snapshot button should not also have to supply its glyph, and
	// two copies of an SVG path are two things to keep in step for no reason.
	const ICON = {
		snap: '<svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M2.6 6.6h3.2l1.5-2.1h5.4l1.5 2.1h3.2v9H2.6z" stroke-linejoin="round"></path><circle cx="10" cy="10.6" r="3.1"></circle></svg>',
		fs: '<svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M3 7.4V3h4.4M16.9 7.4V3h-4.4M3 12.6V17h4.4M16.9 12.6V17h-4.4"></path></svg>',
	};

	// One counter per document, so two stages on one page cannot collide on a
	// radio group name or a label's `for`. This is the whole of what made the
	// old inline version single-use, and it is three lines.
	let uid = 0;

	// The whole player stack, not just the decoder. The old inline version
	// checked the same three names before building anything, because a page
	// served without them — an older install, a half-finished deploy — threw
	// midway and left a stage on screen with nothing behind it and no error
	// anywhere. A caller that cannot have a picture should find out by asking,
	// and still be able to render its controls.
	function available() {
		return !!(window.MajesticVideo && window.MajesticSwap &&
			window.MajesticTransport);
	}

	function el(tag, cls) {
		const n = document.createElement(tag);
		if (cls) n.className = cls;
		return n;
	}

	function dotted(obj, dot) {
		return String(dot).split('.').reduce(
			(o, k) => (o == null ? undefined : o[k]), obj);
	}

	// host   — the element to append the stage to.
	// opts:
	//   config     object, or a function returning one — majestic's config.json.
	//              Read for `video1.enabled` (is there a Sub channel) and the
	//              WebRTC ICE settings. A function because a caller that
	//              re-fetches its config after a save should not have to
	//              re-mount the picture to have this notice.
	//   where      which remembered channel this stage answers to, as
	//              preview-transport.js scopes them. Two panels looked at for
	//              different reasons can reasonably want different channels, so
	//              this is a caller's choice and not a constant. Default
	//              'preview'.
	//   picker     show the Main/Sub segmented control. Default true.
	//   snapshot   show the snapshot button (preview-hero.js gates it on
	//              jpeg.enabled itself). Default true.
	//   fullscreen show the fullscreen button. Default true.
	//   inline     size the stage to its container rather than to the window's
	//              height. The default geometry reserves room below the picture
	//              for the Live leaf's knob strip, which is exactly wrong for a
	//              picture sitting in an ordinary card.
	//   onPlaying  (kind) — a picture is on screen, on this transport.
	//   onLost     (detail) — every transport has been tried and none of them
	//              played. The stage says so itself; this is for a caller that
	//              wants to say more, or to stop measuring something.
	//   onFrame    (w, h, codec) — the picture's natural size, once known, and
	//              (null) when it stops being known: a channel change, or a
	//              chain that has run out. Anything positioned against the
	//              picture has to hear the second one too.
	//
	// Returns a handle, or null when `available()` is false — in which case
	// nothing has been appended to `host` and the caller renders the rest of its
	// section as usual.
	function mount(host, opts) {
		opts = opts || {};
		if (!available() || !host) return null;

		const id = 'mj-pv-' + (++uid);
		const config = () => (typeof opts.config === 'function'
			? opts.config() : opts.config) || {};
		const get = (dot) => dotted(config(), dot);

		// ── The stage ────────────────────────────────────────────────────────
		//
		// Two <video> and two <canvas>, because the swap stages a replacement on
		// the spare slot and only shows it once it has a picture — and the
		// software-decode rung paints a canvas rather than a video, so each
		// slot needs one of each. Without the canvases `impl()` knowing the kind
		// would be worse than useless: it would attach a canvas painter to a
		// <video> and paint nothing, with no error anywhere.
		//
		// `data-slot` / `data-kind` rather than ids, and that is the load-bearing
		// difference from what this replaces. Both players REPLACE their element
		// on every (re)connect — cloneNode(false) plus replaceChild — so a node
		// captured in a closure is detached within a session and every show or
		// hide afterwards writes to something nobody can see. The old code
		// resolved by document id to survive that; cloneNode copies attributes,
		// so a data-* identity survives it just as well, and does it per stage
		// instead of per document.
		const stage = el('div', 'mj-pv-stage' + (opts.inline ? ' mj-pv-inline' : ''));
		stage.innerHTML =
			'<video autoplay muted playsinline class="mj-pv-media" data-slot="0" data-kind="video"></video>' +
			'<video autoplay muted playsinline class="mj-pv-media" data-slot="1" data-kind="video" style="display:none"></video>' +
			'<canvas class="mj-pv-media" data-slot="0" data-kind="canvas" style="display:none"></canvas>' +
			'<canvas class="mj-pv-media" data-slot="1" data-kind="canvas" style="display:none"></canvas>' +
			// An empty layer over the picture and under the bar, for a caller
			// that draws on the frame — regions, masks, a crop rectangle. It is
			// here rather than left to the caller because "over the picture but
			// under the controls" is a z-order this file owns, and a caller that
			// had to guess it would guess it differently each time.
			'<div class="mj-pv-overlay"></div>' +
			'<p class="mj-pv-alert" hidden></p>' +
			'<div class="mj-pv-bar"></div>';

		const overlay = stage.querySelector('.mj-pv-overlay');
		const alertEl = stage.querySelector('.mj-pv-alert');
		const bar = stage.querySelector('.mj-pv-bar');

		// Everything the bar's right edge holds. Built now and appended last, so
		// `barInsert` has something stable to insert before and a caller's own
		// controls land to the left of the icons however many it adds.
		const end = el('span', 'mj-hud-end');

		function slotNode(slot, kind) {
			return stage.querySelector('[data-slot="' + slot + '"][data-kind="' +
				(kind === 'wasm' ? 'canvas' : 'video') + '"]');
		}
		function canvases() {
			return Array.prototype.slice.call(
				stage.querySelectorAll('[data-kind="canvas"]'));
		}

		// ── The channel ──────────────────────────────────────────────────────
		//
		// Sub by default where there is one: this picture exists to show what the
		// ISP is doing, which looks the same on either channel because both are
		// the same picture scaled, and the main channel is what an NVR or the SD
		// card is recording. Main where no substream is configured, because
		// /ws/video subscribes to whatever number it is handed and then quietly
		// delivers nothing — which reads as "no signal" rather than as a
		// misconfiguration.
		const where = opts.where || 'preview';
		// Not const: on a settings page, enabling the substream is a thing you
		// do on another section of the same page, so this can become true (or
		// false) while the stage is mounted. syncConfig() is how a caller says
		// the config has moved.
		let subAvailable = get('video1.enabled') === true;
		const remembered = window.MajesticTransport.chosenStream(where);
		let stream = (remembered === null ? 1 : remembered) === 1 && subAvailable
			? 1 : 0;

		// True once every transport has been tried and nothing is attached. The
		// picker reads it: with no player its clicks reach nothing at all, and a
		// channel is still a request worth honouring — an H.264 substream plays
		// in a browser that refused an H.265 main.
		let exhausted = false;
		let frame = null;

		// What the most recent attachment has reported about its picture, and
		// which attachment that was. It is held rather than published because a
		// TRIAL reports too: preview-swap.js deliberately keeps the current
		// player on screen while a replacement is judged, so a trial's codec
		// event describes something nobody can see — and if that trial then
		// fails, publishing it would leave frame() describing a player that
		// never appeared. One slot is enough: the swap runs at most one trial
		// and one live player, and a newer report supersedes an older one.
		let pending = null;

		// Which transport the caller was last told is playing, so onPlaying is
		// an event about a picture rather than about an attempt.
		let announced = null;

		// Forgetting the frame is news. Everything laid out against the picture —
		// an overlay's rectangles, a tool that needs to map a drag into it — is
		// wrong the moment the frame is unknown, and it had no way to hear about
		// it: onFrame fired only when a size ARRIVED, so a channel change or a
		// dead chain left consumers drawing over a picture that had gone, with
		// their controls still enabled and silently rejecting every gesture.
		//
		// So onFrame(null) means "no longer known", and every caller has to
		// handle it — the same null frame() already returns before the first
		// frame of a session, so it is a state they must handle anyway.
		function forgetFrame() {
			pending = null;
			if (!frame) return;
			frame = null;
			if (opts.onFrame) opts.onFrame(null);
		}

		function announcePlaying(kind) {
			if (announced === kind) return;
			announced = kind;
			if (opts.onPlaying) opts.onPlaying(kind);
		}

		// Publish what `pending` says, if the attachment that said it is the one
		// on screen. Both halves of that are about the same mistake: the
		// `__mjPainted` mark is resolved through swap.element() — it has to be,
		// because the software player replaces its canvas and the node handed to
		// open() is detached by the time a frame arrives — and swap.element() is
		// the LIVE element, so a trial calling this would mark a player that has
		// shown nothing.
		function adoptPending() {
			if (!pending || !swap.isLive(pending.id)) return;
			const live = swap.element();
			if (live) live.__mjPainted = true;
			const p = pending;
			pending = null;
			if (!p.w || !p.h) return;
			const same = frame && frame.w === p.w && frame.h === p.h &&
				frame.codec === p.codec;
			frame = { w: p.w, h: p.h, codec: p.codec };
			if (!same && opts.onFrame) opts.onFrame(p.w, p.h, p.codec);
		}

		// ── What it says when there is no picture ────────────────────────────
		//
		// This stage has no MJPEG fallback and there is not going to be one, so
		// the sentence is the whole of the account. The Live View page words the
		// same reason codes differently on purpose (preview-page.js): it has a
		// picture to explain rather than an empty box, so the two diverge past
		// the first clause. A code neither of them knows still gets an honest
		// general line. Keep this in step when a code is added to preview.js.
		function alertText(why) {
			const bits = String(why || '').split(' ');
			const ch = stream === 1 ? 'Sub' : 'Main';
			if (bits[0] === 'undecodable') {
				const codec = bits[1] ? bits[1].toUpperCase() : '';
				return 'This browser can’t decode the ' + ch + ' stream' +
					(codec ? '’s ' + codec + ' video' : '') +
					', so there is no preview here.';
			}
			if (bits[0] === 'no-mse') {
				return 'This browser has no Media Source Extensions, so it ' +
					'cannot play the ' + ch + ' stream.';
			}
			if (bits[0] === 'unreachable') {
				return 'The camera stopped sending the ' + ch + ' stream.';
			}
			if (bits[0] === 'decoder-unavailable' || bits[0] === 'no-offscreen') {
				return 'This browser can’t decode the ' + ch + ' stream, and ' +
					'the software decoder could not be loaded, so there is no ' +
					'preview here.';
			}
			return 'The ' + ch + ' stream could not be played in this browser.';
		}
		function showAlert(why) {
			alertEl.textContent = alertText(why);
			alertEl.hidden = false;
		}
		function hideAlert() { alertEl.hidden = true; }

		// The same walk the Live View page makes, for the same reasons — see
		// preview-page.js:nextRung. Kept as its own dozen lines rather than
		// shared, on the standing division above: what a page DOES about an
		// outcome differs, while the rules about which transport to prefer live
		// in preview-transport.js.
		function nextRung(kind, detail) {
			// A channel change can change the codec, and the failure that put us
			// on the software rung was about the channel we left. Ask the whole
			// chain again rather than giving up: an H.264 substream plays
			// natively, and this stage exists to be looked at.
			if (String(detail || '').split(' ')[0] === 'codec-changed') {
				swap.start(window.MajesticTransport.preferred());
				return;
			}
			if (kind === 'webrtc') { swap.start('mse'); return; }
			if (kind === 'mse' && window.MajesticTransport.softwareRungFor(detail)) {
				swap.start('wasm');
				return;
			}
			exhausted = true;
			// A canvas that has stopped being painted keeps its last frame and
			// nothing hides it, so anything sampling the picture — the Live
			// leaf's luma histogram, today — would go on reporting a frozen
			// frame as the current one. A stale measurement dressed as a live
			// one is worse than none, so the claim is withdrawn here and
			// `media()` stops offering it.
			canvases().forEach((c) => { c.__mjPainted = false; });
			// And the same withdrawal for what the picture WAS: with nothing on
			// screen, frame() describing the last thing that played would have
			// an overlay laid out over an empty stage.
			forgetFrame();
			announced = null;
			showAlert(detail);
			if (opts.onLost) opts.onLost(detail);
		}

		// ── The swap ─────────────────────────────────────────────────────────
		const swap = window.MajesticSwap({
			elements: [
				(kind) => slotNode(0, kind),
				(kind) => slotNode(1, kind),
			],
			open: (kind, node, attachId, onState) => {
				const impl = window.MajesticTransport.impl(kind);
				return impl.attach(node, {
					// A canvas is 300x150 the moment it exists and reports a
					// size before anything has been decoded into it, so its
					// dimensions prove nothing — sampling one would publish a
					// black measurement for a picture that is merely starting.
					// A frame is the only proof of a frame.
					//
					// The mark is an expando, not a data attribute, and resolved
					// through swap.element() rather than through `node`. Both
					// matter: the software player REPLACES its canvas on attach
					// (the handle from transferControlToOffscreen is spent once
					// posted), so `node` is detached by the time a frame
					// arrives — and cloneNode copies attributes, so a data-*
					// mark would be inherited by the fresh canvas and declare it
					// painted before it was. An expando is copied by neither,
					// which is also why the slot identity above can safely be an
					// attribute and this cannot.
					onCodec: (codec, cs, w, h) => {
						pending = { id: attachId, w: w, h: h, codec: codec };
						// Only if this attachment is the one on screen; a trial
						// is adopted by onPromoted instead, once it is.
						adoptPending();
					},
					stream: stream,
					// Opened with the volume it should have rather than given it
					// afterwards; see preview-swap.js on why applying
					// preferences post-promotion undoes the staging. This stage
					// is muted at the element, so 1 here is "do not attenuate".
					volume: 1,
					// Without this the browser offers host candidates only, and
					// a session opened from anywhere but the same LAN negotiates
					// cleanly and then never carries a packet.
					iceServers: () => window.MajesticTransport.iceServers(
						get('webrtc.iceServers'),
						get('webrtc.turnUsername'),
						get('webrtc.turnCredential')),
					onState: onState,
				});
			},
			// `proven` says whether this promotion was earned by a picture. A
			// trial is promoted because it reported 'playing', so yes; a first
			// attach is promoted because there was nothing to protect, which is
			// not the same claim — it is still connecting, and may yet fail.
			onPromoted: (kind, proven) => {
				exhausted = false;
				hideAlert();
				// The idle pair of the other kind is hidden by nobody — the swap
				// only touches the slot it is using — so an empty <video> would
				// sit visible under a painting canvas.
				const idle = kind === 'wasm' ? 'video' : 'canvas';
				stage.querySelectorAll('[data-kind="' + idle + '"]').forEach((n) => {
					n.style.display = 'none';
				});
				// A trial that reported its codec while it was still being
				// judged: now it is on screen, what it said is worth publishing.
				adoptPending();
				// Only on a promotion a picture earned. The unproven case is
				// announced by onLive('playing') below instead, which is where
				// a first attach reports the same news once it is true.
				if (proven) announcePlaying(kind);
			},
			onFailed: (kind, why, permanent) => {
				// 'fallback' is durable and worth remembering; 'busy' says the
				// camera is full, which it will not be for long.
				if (kind === 'webrtc' && permanent) window.MajesticTransport.demote();
			},
			// Nothing on screen left to protect. Past MSE this stage has no
			// preview at all, so what it owes the viewer is the reason — an
			// empty black box is indistinguishable from a camera that is off.
			onExhausted: (kind, detail) => { nextRung(kind, detail); },
			onLive: (st, d, kind) => {
				// The live player's own report that it is playing. This is the
				// only place a FIRST attach can say so — it was promoted before
				// it had anything, so its picture arrives here rather than as a
				// second promotion.
				if (st === 'playing') announcePlaying(kind);
				if (kind !== 'webrtc') {
					// MSE is the last thing to try, so its giving up ends the
					// chain — and it says so on the live player's own channel
					// rather than as a dropped trial, which is what happens
					// whenever it was the first thing attached (the ordinary
					// case here). Nothing read that state once, and the panel
					// sat black for ever with nothing said and no way back
					// (#274).
					if (st === 'mjpeg') {
						// stop(), not retire(): a refused MSE player has not
						// closed itself, and its socket's onclose restarts the
						// reconnect ladder for a session already given up on.
						swap.stop();
						nextRung(kind, d);
					}
					return;
				}
				if (st === 'fallback' || st === 'busy') {
					if (st === 'fallback') window.MajesticTransport.demote();
					// Its picture is frozen from here; the replacement is staged
					// over it rather than blanking the stage.
					swap.retire();
					swap.start('mse');
				}
			},
		});

		// ── The bar ──────────────────────────────────────────────────────────
		//
		// The channel picker leads it, as it does on the Live View page, and as
		// the same component rather than a second copy of it: `mj-hud mj-seg` is
		// the pair of classes that page's markup carries, so the glass, the
		// label colours and the focus ring are inherited rather than restated.
		//
		// Input-behind-a-label, because the picker drives `.checked` and
		// `.disabled` on those inputs and they are what keeps the group
		// keyboard-reachable. The names and ids carry `id` (this stage's) so a
		// second stage on the same page is a second radio group rather than a
		// continuation of the first one.
		let s0 = null, s1 = null;
		if (opts.picker !== false) {
			const seg = el('span', 'mj-hud mj-seg');
			seg.setAttribute('role', 'group');
			seg.setAttribute('aria-label', 'Stream');
			seg.innerHTML =
				'<input type="radio" class="mj-seg-in" name="' + id + '-stream" id="' + id + '-s0" autocomplete="off">' +
				'<label class="mj-seg-lbl" for="' + id + '-s0">Main</label>' +
				'<input type="radio" class="mj-seg-in" name="' + id + '-stream" id="' + id + '-s1" autocomplete="off">' +
				'<label class="mj-seg-lbl" for="' + id + '-s1"' + (subAvailable ? '' : ' hidden') + '>Sub</label>';
			bar.appendChild(seg);
			s0 = seg.querySelector('#' + id + '-s0');
			s1 = seg.querySelector('#' + id + '-s1');
			// Hiding the label leaves the input focusable — it keeps its place
			// in the tab order — so arrow-key navigation could otherwise select
			// a stream that does not exist and land the stage on "no signal".
			s1.disabled = !subAvailable;
			s0.checked = stream === 0;
			s1.checked = stream === 1;
			[s0, s1].forEach((input, n) => {
				// On click rather than change, for the reason the Live View page
				// records it that way: pressing the one already selected fires
				// no change event and is still an answer worth remembering.
				input.addEventListener('click', () => {
					window.MajesticTransport.chooseStream(where, n);
					// Not `if (n === stream) return` any more: with the chain
					// out there is nothing on screen, and pressing the channel
					// already selected is the only retry this stage offers.
					if (n === stream && !exhausted) return;
					goToStream(n);
				});
			});
		}

		bar.appendChild(end);

		if (opts.snapshot !== false) {
			const b = el('button', 'mj-hud-ico mj-glass');
			b.type = 'button';
			b.hidden = true;
			b.setAttribute('aria-label', 'Snapshot');
			b.title = 'Snapshot';
			b.innerHTML = ICON.snap;
			end.appendChild(b);
			// Shared with the Live View page rather than copied: the /image.jpg
			// naming, the jpeg.enabled gate and the delayed revokeObjectURL are
			// details a second copy would drift on. It unhides the button itself
			// once it knows the JPEG channel is on.
			if (window.MajesticHero) window.MajesticHero.wireSnapshot(b);
		}

		let offFullscreen = null;
		if (opts.fullscreen !== false) {
			const b = el('button', 'mj-hud-ico mj-glass');
			b.type = 'button';
			b.hidden = true;
			b.setAttribute('aria-label', 'Fullscreen');
			b.title = 'Fullscreen';
			b.innerHTML = ICON.fs;
			end.appendChild(b);
			// Fullscreen goes on the STAGE, so the bar and anything drawn on the
			// overlay come with it. The disposer matters here in a way it does
			// not on the Live View page: that page wires this once per load,
			// while a settings stage is rebuilt every time its section is
			// opened, so without taking the document listener back off each
			// visit would leave another callback behind holding a dead stage.
			if (window.MajesticHero) {
				offFullscreen = window.MajesticHero.wireFullscreen(stage, b);
			}
		}

		host.appendChild(stage);
		swap.start(window.MajesticTransport.preferred());

		// ── The handle ───────────────────────────────────────────────────────

		function goToStream(n) {
			// Only when it actually moves. The channels are different pictures —
			// different size, often a different codec — so what was true of the
			// old one is not a description of the new one, it is a wrong
			// description of it, and frame() should answer "not known yet" until
			// the new channel reports. But asking for the channel already
			// playing is a no-op the player has no reason to answer, so
			// discarding on that would leave frame() empty for as long as the
			// session lasted.
			const moved = n !== stream;
			stream = n;
			if (s0) s0.checked = n === 0;
			if (s1) s1.checked = n === 1;
			if (moved) {
				forgetFrame();
				announced = null;
			}
			if (exhausted) {
				exhausted = false;
				hideAlert();
				swap.start(window.MajesticTransport.preferred());
				return;
			}
			const p = swap.player();
			if (p) p.setStream(n);
			// And the trial, if one is being judged: it keeps the stream it was
			// opened with, so it would otherwise be promoted onto the channel
			// just moved away from.
			const t = swap.trial();
			if (t) t.setStream(n);
		}

		return {
			stage: stage,
			bar: bar,
			overlay: overlay,

			// Insert a caller's own control into the bar, to the left of the
			// icon group. The alternative — handing out `bar` and letting
			// callers append — puts everything after the icons, which is where
			// the icons stop being the right edge.
			barInsert: function (node) { bar.insertBefore(node, end); return node; },

			// Whichever element is on screen AND has actually shown a frame.
			//
			// This is what anything measuring the picture must ask, and it used
			// to be a hardcoded scan of four document ids in the caller. Videos
			// know their own readiness; a canvas does not, so the player marks
			// it when it has decoded a frame. Until then this returns a video
			// that will fail a sampler's own guard, which keeps a measurement
			// UNKNOWN rather than reporting black.
			media: function () {
				const ready = (e) => e && e.style.display !== 'none' &&
					(e.tagName === 'CANVAS' ? e.__mjPainted === true : e.readyState >= 2);
				const all = [slotNode(0, 'video'), slotNode(1, 'video'),
					slotNode(0, 'wasm'), slotNode(1, 'wasm')];
				return all.find(ready) || all[0] || all[1];
			},

			player: function () { return swap.player(); },
			// The transport on screen and still moving, or null. See
			// preview-swap.js on why there is no wider form of this question.
			transport: function () { return swap.playing(); },
			// The picture's natural size and codec, or null before the first
			// frame. Callers that align something to the picture need it,
			// because `object-fit: contain` letterboxes anything that is not
			// the stage's own aspect ratio.
			//
			// And they must take it from HERE rather than off media(): on the
			// software rung the element is a <canvas>, which is 300x150 from
			// the moment it exists and stays that way for a beat after the
			// player has marked it painted — measured on an hi3516av300 serving
			// H.265, where the first sample after the switch read a canvas of
			// 300x150 while this already said 3840x2160. An overlay laid out
			// from the element in that window is laid out from a default.
			frame: function () { return frame; },

			// The config has moved — re-read what it decides. Only the channel
			// picker, because it is the only thing here settled once at mount:
			// the ICE settings are read through the getter at attach time and
			// are therefore already current.
			//
			// A caller has to say so rather than this polling, because the
			// config object is theirs and only they know when it has been
			// replaced. mj-settings.js calls it from refresh(), which is the
			// one place state.config is swapped.
			syncConfig: function () {
				const now = get('video1.enabled') === true;
				if (now === subAvailable) return;
				subAvailable = now;
				if (!s1) return;
				s1.disabled = !subAvailable;
				const lbl = bar.querySelector('label[for="' + id + '-s1"]');
				if (lbl) lbl.hidden = !subAvailable;
				// A channel that has just gone away cannot stay selected: the
				// socket subscribes to whatever number it is handed and then
				// delivers nothing, which reads as a dead camera. The reverse is
				// deliberately not symmetric — a substream appearing is an offer,
				// not a reason to move the picture somebody is looking at.
				if (!subAvailable && stream === 1) goToStream(0);
			},

			stream: function () { return stream; },
			// Programmatic channel change. Writes `.checked` rather than firing
			// a click, so it cannot re-enter through the listener above, and it
			// deliberately does NOT call chooseStream(): what is remembered is
			// the viewer's own pick, and a caller moving the channel on their
			// behalf must not overwrite it.
			setStream: goToStream,

			destroy: function () {
				// Through the swap, which closes the trial as well as the player
				// on screen. Destroying only the live player would leave a
				// transport still being judged behind on every teardown — a live
				// socket nobody has a handle to.
				try { swap.stop(); } catch (e) {}
				if (offFullscreen) { try { offFullscreen(); } catch (e) {} }
				if (stage.parentNode) stage.parentNode.removeChild(stage);
			},
		};
	}

	return {
		available: available,
		mount: mount,
		ICON: ICON,
	};
})();
