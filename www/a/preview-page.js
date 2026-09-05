// Live View page glue: the player attach with its MJPEG/no-signal fallback.
// Nothing here changes the camera — the page is deliberately settings-free
// (it is the future multi-user system's read-only view), and the night/IR/
// light toggles that used to live here moved to mj-settings' Live section
// (mj-settings.js). `$`, mjConfig and mjGet are globals from main.js; this
// file loads after preview.js and preview-webrtc.js.
//
// TWO TRANSPORTS, ONE FAÇADE. MajesticVideo (MSE) and MajesticWebRTC return
// the same object, so everything below is written once and the choice is made
// in attachPlayer(). WebRTC is the default now: sub-second where MSE is about
// a second behind, audio in both directions, and a receiver whose reports let
// the camera match the encoder to the link. MSE is a tick away for the
// browsers and cameras where negotiation cannot be made to work.
//
// The chain is WebRTC -> MSE -> MJPEG -> note, and the middle step is
// load-bearing rather than tidy. WebRTC negotiates and can therefore fail
// where MSE cannot: Firefox's WebRTC stack offers only H.264 Baseline whatever
// its decoder can do, so a camera on `profile: main` has nothing to give it —
// the same browser plays that stream over MSE without complaint. A player
// reporting 'fallback' is asking for the other transport, not for MJPEG.
//
// Now that the chain runs by default rather than on request, what it remembers
// matters more than it did. A refusal is recorded with a timestamp and expires;
// a camera that is merely full ('busy') is not recorded at all; and an explicit
// choice beats both. Otherwise the first bad afternoon would quietly park a
// browser on the slower transport for good.
(function () {
	// --- Live player (WebRTC or MSE, with MJPEG / no-signal fallback) ---
	const initial = $('#live-video');
	if (!initial || !window.MajesticVideo) return;
	const badge = $('#mj-badge'), img = $('#live-mjpeg'), note = $('#mj-note');
	const noteWhy = $('#mj-note-why');
	const servedEl = $('#mj-served'), servedWhy = $('#mj-served-why');
	let jpegOn = false;
	mjConfig().then(cfg => {
		jpegOn = mjGet(cfg, 'jpeg.enabled') === true;
		// Read before the fallback is re-decided below: the codec is what says
		// whether a socket that gave up is worth handing to the software rung,
		// and that decision has to be made with the real answer.
		cfgCodec = [mjGet(cfg, 'video0.codec') || '', mjGet(cfg, 'video1.codec') || ''];
		// The first attach does not wait for this fetch past CONFIG_WAIT_MS,
		// and a player can refuse before it even starts — MSE reports 'no-mse'
		// from inside attach(). Until this line runs, jpegOn is false because
		// nothing is known, not because the channel is off, and a fallback
		// decided on it would offer "Enable JPEG" for a camera that has JPEG
		// enabled and would leave the picture it could have shown unshown.
		// Re-decided here against the real answer; harmless when it agrees.
		//
		// And if that fallback was a socket giving up ('unreachable') on what
		// the config now says is a software-decodable channel, the rescue in
		// nextRung could not have fired — cfgCodec was empty when the failure
		// arrived. Take it now rather than only re-rendering the MJPEG picture,
		// or a camera whose config lands slowly (the same flaky link that
		// caused the giving-up) would never reach the decoder (#288).
		if (fellBack && MajesticTransport.softwareRungForCodec(
			fellBack, cfgCodec[stream ? 1 : 0])) {
			retryFromFallback('wasm');
		} else if (fellBack) {
			showFallback(fellBack);
		}
		const subOk = mjGet(cfg, 'video1.enabled') === true;
		subAvailable = subOk;
		if (subOk) $('#mj-sub').hidden = false;
		// Auto only where there are two streams to choose between: with one
		// encoder configured there is nothing for it to decide.
		if (subOk && autoLbl) autoLbl.hidden = false;
		if (autoCtl) {
			autoCtl.disabled = !subOk;
			// A camera with one stream has nothing for Auto to decide, so a
			// choice made before that was known — or carried over from a camera
			// that did have two — has to be undone rather than left running
			// behind a control nobody can see or clear.
			if (!subOk && (autoOn || autoCtl.checked)) {
				autoOn = false;
				autoCtl.checked = false;
				if (s0) s0.checked = true;
				stream = 0;
			}
		}
		// "WxH" per channel. Auto compares areas, so parse once. The same
		// tolerant grammar as mj-settings' parseWH — that page accepts and
		// persists "1920 X 1080", and a size the preview refused to read
		// would silence both Auto and the served-channel note for it.
		sizeOf = [0, 1].map(n => {
			const v = mjGet(cfg, 'video' + n + '.size');
			const m = /^\s*(\d+)\s*x\s*(\d+)\s*$/i.exec(String(v || ''));
			return m ? { w: +m[1], h: +m[2] } : null;
		});
		autoApply();
		// Same reason as the settings panel: the label is what gets hidden, and
		// the radio behind it stays in the tab order, so without this the
		// keyboard can pick a stream the camera does not have.
		if (s1) s1.disabled = !subOk;
		// The configured frame rates, which are what the chip shows on MSE —
		// that player measures nothing.
		cfgFps = [+mjGet(cfg, 'video0.fps') || 0, +mjGet(cfg, 'video1.fps') || 0];
		// (cfgCodec is read earlier, before the fallback is re-decided.)
		// The configured bitrates, which are what the adaptation toast names
		// as the rate the encoder returns to when nothing is holding it down.
		cfgKbps = [+mjGet(cfg, 'video0.bitrate') || 0, +mjGet(cfg, 'video1.bitrate') || 0];
		setChip();
		ice = MajesticTransport.iceServers(
			mjGet(cfg, 'webrtc.iceServers'),
			mjGet(cfg, 'webrtc.turnUsername'),
			mjGet(cfg, 'webrtc.turnCredential'));
	});
	// The element the visible player owns. Swapped, not reassigned to a fixed
	// id, because both elements are real and either can be the live one.
	let liveEl = $('#live-video'), spareEl = $('#live-video-b');
	const cur = () => liveEl;

	const BARS = '#000 url(/a/preview.svg)';
	// Why the page is showing something other than a live player, or null while
	// one is on screen. Everything that used to assume a player exists reads
	// this: the chip must stop describing a session that ended, and the
	// controls that retargeted that player have to restart the chain instead.
	let fellBack = null;
	// What the fallback has put on the stage — 'mjpeg', 'note', or null — as
	// distinct from `fellBack`, which is cleared the moment a retry starts.
	// They part company for the length of that retry, and that gap is the
	// point: the picture stays until the replacement has one of its own.
	let holdingFallback = null;
	// A page-level reconnect ladder for the software-decode rung, and a belt to
	// the worker's own braces (hevc-wasm@v0.1.1). A pinned worker older than
	// that gives up on the FIRST dropped socket, and the chain reads that one
	// `unreachable` as "software decode is done" and falls to MJPEG with no way
	// back — the #288 dead-end, where a transient blip stranded a working H.265
	// preview until the tab was reloaded. So a wasm socket drop is retried here
	// a few times before MJPEG, reset by a picture reaching the stage
	// (showVideo). It cannot loop: only a socket drop reports `unreachable`; a
	// codec the decoder cannot take reports `codec-changed`, and a missing
	// decoder `decoder-unavailable`, both of which terminate the chain instead.
	const WASM_MAX_RETRIES = 5;
	const WASM_RETRY_MS = 1000;
	// Frames a software session must decode before it counts as recovered and
	// the retry budget resets — proof of sustained play, not the mere codec
	// announcement (~1s at 8fps).
	const WASM_HEALTHY_FRAMES = 8;
	let wasmRetries = 0;
	// A pending page-level retry and the generation it belongs to. Any fresh
	// attach, channel change or transport change bumps the generation, so a
	// retry scheduled by a superseded session cannot fire attachPlayer('wasm')
	// over the newer player and override the viewer's choice. The timer is held
	// so it can be cancelled outright.
	let wasmRetryTimer = null;
	let wasmGen = 0;
	function cancelWasmRetry() {
		if (wasmRetryTimer) { clearTimeout(wasmRetryTimer); wasmRetryTimer = null; }
	}
	function showVideo() {
		const v = cur();
		if (v) { v.style.display = ''; v.style.background = '#000'; }
		if (img) { img.style.display = 'none'; img.src = ''; }
		if (note) note.style.display = 'none';
		fellBack = null;
		holdingFallback = null;
		hideStageMsg('fallback');
	}
	function showNoSignal() {
		// 'no signal' is a stage of a retry, not its outcome. While the
		// fallback picture is being held, taking it away for one would cost
		// the viewer what they had in exchange for a session that may yet
		// fail — and MSE reaches 'unreachable' only after six of these.
		if (holdingFallback) return;
		const v = cur();
		if (v) { v.style.display = ''; v.style.background = BARS; }
		if (img) { img.style.display = 'none'; img.src = ''; }
		if (note) note.style.display = 'none';
		fellBack = null;
		hideStageMsg('fallback');
		if (badge) badge.textContent = 'no signal';
	}
	// The end of the chain: both transports are gone and what is left is the
	// camera's JPEG channel, or nothing at all. Saying so takes more than a
	// word on the chip, which is the whole of #274 — the page arrived here and
	// then went on describing the session it had lost:
	//
	//   - the reason was known and dropped. The player had just said why it
	//     stopped and this function took no argument at all.
	//   - the chip said MJPEG while `chipMedia` still held the failed stream's
	//     codec, so the next setChip() — pressing Main, say — put `H265
	//     3840x2160` back over the label, naming a stream nobody was watching.
	//   - the one explanation the page owns was gated on jpeg.enabled being
	//     OFF, i.e. shown only when there was no fallback to explain.
	//   - MSE stayed lit on the picker although MSE was not carrying the
	//     picture, and pressing it again fired no change event, so the
	//     obvious retry was the one control on the bar that did nothing.
	//   - the audio and talkback buttons stayed up for a player that had
	//     stopped, and `player` still held it: a stream click would have
	//     called setStream() on it and reopened its socket.
	function showFallback(why) {
		const v = cur();
		if (v) v.style.display = 'none';
		fellBack = why || 'unknown';
		// Destroyed, not merely retired. A refused MSE player has stopped its
		// socket but not closed itself — only destroy() sets its `closed`
		// flag, so the socket's own onclose starts the reconnect ladder again
		// and the session it has already declared unusable goes on reporting
		// 'connecting' from the grave. The swap still routes a retired live
		// player's states to the page (dead marks the picture stale, not the
		// handler), so those writes landed on the chip and replaced MJPEG with
		// 'connecting…' seconds after the fallback appeared.
		swap.stop();
		player = null;
		// The kind goes with the player. Left standing it names a session that
		// ended, and every `liveKind === …` test below is then answering about
		// something that is not on screen.
		liveKind = null;
		// And the software-decode disclosure's latch. hideStageMsg() above
		// takes the message down, but the latch is what stops it being raised
		// twice — so leaving it set means a later software session plays with
		// no disclosure at all, which is the one thing this rung must never do.
		swNoteKey = '';
		syncAudioCtl();
		syncTalkCtl();
		// Both describe the session that just ended.
		chipMedia = null;
		chipFps = 0;
		if (window.MajesticAdapt) window.MajesticAdapt.reset();
		if (window.MajesticStats) window.MajesticStats.reset();
		// The camera's served-channel answer belonged to the session that just
		// died, and settle() only clears it on a promotion to MSE — so a retry
		// that landed back on WebRTC used to inherit it, naming the wrong
		// channel on the chip and handing the adaptation toast the wrong
		// channel's configured bitrate, with no new `served` ever due on a
		// daemon that does not send one. The message goes with it, whoever
		// owns the slot: a mismatch toast standing over the fallback describes
		// a session that no longer exists.
		servedCh = null;
		servedShownKey = '';
		hideStageMsg();
		const sentence = fallbackSentence(fellBack);
		if (jpegOn && img) {
			img.src = '/mjpeg';
			img.style.display = '';
			if (note) note.style.display = 'none';
			if (badge) badge.textContent = 'MJPEG';
			holdingFallback = 'mjpeg';
			showStageMsg('fallback', sentence + ' Showing the MJPEG fallback.');
		} else {
			// No fallback to show, so the note carries the explanation and the
			// remedy together and the toast would only repeat it. Nothing is
			// playing, so the chip names no format either.
			if (noteWhy) noteWhy.textContent = sentence;
			if (note) note.style.display = '';
			if (badge) badge.textContent = 'unavailable';
			holdingFallback = 'note';
		}
		// Neither transport is carrying the picture, so neither is lit. It is
		// also what makes the retry work: with the group cleared, pressing the
		// transport that just failed is a real change event again.
		reflectTransport(null);
	}

	// Back to the top of the chain, from either picker: `webrtc` is the
	// transport group naming one, and undefined is the stream group leaving
	// the choice to the stored preference.
	//
	// What it does NOT do is clear the stage. showFallback() stops the swap,
	// so there is no live entry left for it to protect and the next attach is
	// promoted the instant it is made — which meant a press of a transport
	// button traded a working MJPEG picture for a black stage and a
	// negotiation that could still fail, inverting the one rule
	// preview-swap.js exists to enforce. The picture is the page's to hold
	// now, and it is handed over in onPromoted, on a promotion that was
	// earned by a picture rather than by there being nothing in the way.
	function retryFromFallback(kind) {
		// Guarded because one press can arrive twice: the click handler
		// retries, and the change event that follows a radio that did move
		// reaches goToStream(), which would otherwise restart the session
		// that the click has just opened.
		if (!fellBack) return;
		fellBack = null;
		hideStageMsg();
		if (badge) {
			badge.textContent = holdingFallback === 'mjpeg'
				? 'MJPEG · retrying…' : 'retrying…';
		}
		attachPlayer(kind === undefined ? wantWebRTC() : kind);
	}

	// The player names the cause in a code and the page words it — the same
	// division as the camera's `served` reply, including its rule for a code
	// this version has never heard of: say something true and general rather
	// than print an identifier at the viewer.
	function fallbackSentence(why) {
		const bits = String(why || '').split(' ');
		const ch = streamName(stream ? 1 : 0);
		if (bits[0] === 'undecodable') {
			const codec = bits[1] ? bits[1].toUpperCase() : '';
			return 'This browser can’t decode the ' + ch +
				(codec ? '’s ' + codec + ' video' : '') + '.';
		}
		if (bits[0] === 'no-mse') {
			return 'This browser has no Media Source Extensions, so it cannot ' +
				'play the ' + ch + '.';
		}
		if (bits[0] === 'unreachable') {
			return 'The camera stopped sending the ' + ch + '.';
		}
		// The software-decode rung could not fetch its decoder — no route out
		// of the network, most likely, which is an ordinary state for a camera
		// rather than a fault. Say what happened rather than blaming the
		// stream, which is fine and would play anywhere else.
		if (bits[0] === 'decoder-unavailable' || bits[0] === 'no-offscreen') {
			return 'This browser can’t decode the ' + ch + ', and the software ' +
				'decoder could not be loaded.';
		}
		return 'The ' + ch + ' could not be played in this browser.';
	}

	const mute = $('#mj-mute'), muteLbl = $('#mj-mute-lbl'), volCtl = $('#mj-vol');
	// The word only: the label also carries the LED and the speaker icon,
	// and the icon's muted/unmuted ending is a CSS rule off #mj-mute, not
	// something to rewrite here.
	const muteTxt = $('#mj-mute-t') || muteLbl;
	const audioCtl = $('#mj-audio-ctl');
	const talkCtl = $('#mj-talk-ctl'), talk = $('#mj-talk'), talkLbl = $('#mj-talk-lbl');
	const talkTxt = $('#mj-talk-t') || talkLbl;
	const statsCtl = $('#mj-stats-ctl'), statsBtn = $('#mj-stats-btn'), statsBox = $('#mj-stats');
	const TALK_TITLE = talkLbl ? talkLbl.title : '';
	// The transport is a two-radio segmented picker, not a checkbox: the
	// alternative deserves a name, and "unchecked" never said what it meant.
	// The failure tooltip still lands on the WebRTC label (#mj-transport-lbl),
	// which is where "why am I not on WebRTC?" gets asked.
	//
	// It has a third state, and it is the honest one at the end of the chain:
	// null, nothing lit, because neither transport is carrying the picture.
	const transportW = $('#mj-transport-w'), transportM = $('#mj-transport-m');
	const transportGrp = $('#mj-transport-ctl');
	const transportLbl = $('#mj-transport-lbl');
	function hideOtherKind(kind) {
		(kind === 'wasm'
			? ['#live-video', '#live-video-b']
			: ['#live-canvas', '#live-canvas-b']
		).forEach((sel) => { const e = $(sel); if (e) e.style.display = 'none'; });
	}

	function reflectTransport(kind) {
		if (transportW) transportW.checked = kind === 'webrtc';
		if (transportM) transportM.checked = kind === 'mse';
	}

	// What the toggle says when nothing has gone wrong. Kept because a failure
	// replaces it with the reason, and switching back has to put the explanation
	// there again rather than leave the tooltip stuck on a complaint about a
	// session that is long over.
	const TRANSPORT_TITLE = transportLbl ? transportLbl.title : '';

	const s0 = $('#mj-stream-0'), s1 = $('#mj-stream-1');
	const autoCtl = $('#mj-stream-auto'), autoLbl = $('#mj-auto');

	// Which transport to try, and the memory behind it, both live in
	// preview-transport.js — the settings page needs the same rules and two
	// copies would drift. See that file for why each of them is what it is.
	const webrtcAvailable = MajesticTransport.available();
	const wantWebRTC = () => MajesticTransport.preferred() === 'webrtc';
	const rememberTransport = t => MajesticTransport.choose(t);
	const rememberDemotion = () => MajesticTransport.demote();

	// The player on screen and which transport it is, both kept in step by the
	// swap's onPromoted. Read by the controls, which act on what is playing
	// rather than on what is being tried.
	// A KIND, not a boolean. There are three now, and every place that read
	// "not WebRTC" and meant "therefore MSE" is a place a third one would
	// inherit assumptions nobody checked. Each site below says which kind it
	// means; the three that are not mechanical are called out where they are.
	let player = null, liveKind = null;
	// Carried across a transport switch, because a new player starts from its
	// defaults and the user's choices should outlive the machinery.
	let stream = 0, audioOn = false, vol = 1;
	// The camera's STUN/TURN configuration, filled when the config lands. Read
	// through a getter at every open(), so an attach that beat the fetch is
	// corrected by the first reconnect rather than staying host-candidates-only
	// for the life of the page.
	let ice = [];
	// Auto: pick the stream closest to the size this player is drawn at, and
	// follow the window. Sizes come from the config; sizeOf[n] is null until it
	// lands, which is what stops Auto choosing on a guess.
	let autoOn = false;
	let subAvailable = false;
	// Per channel, { w, h } or null for "not set", which means sensor native.
	let sizeOf = [null, null];
	// At most one change a second, the reporter's own limit. A drag across a
	// boundary would otherwise cut the session on every frame of the resize.
	const AUTO_MIN_GAP_MS = 1000;
	let lastAutoAt = 0, autoTimer = null;
	// The chip: what is playing, in one line — "H264 3840×2160 · 25 fps". The
	// transport is not named here; the picker names it, once. fps has two
	// sources that cannot be merged: WebRTC measures it every second
	// (chipFps), MSE measures nothing, so the configured rate stands in
	// (cfgFps, per channel). chipMedia is whatever the live player last
	// reported about its own picture.
	let chipMedia = null, chipFps = 0;
	let cfgFps = [0, 0];
	// Filled from the config when it lands; '' until then, which the codec
	// helper treats as "not software-decodable", so nothing new happens before
	// the config is known.
	let cfgCodec = ['', ''];
	// The camera's own statement of which channel this WebRTC session serves,
	// from the `served` signalling reply — or null on an older majestic, over
	// MSE, and between sessions, in which case the size inference below stands
	// in. servedShownKey remembers which mismatch the message has already
	// announced: a reconnect or audio renegotiation re-delivers the same
	// `served`, and the second telling would just be noise.
	let servedCh = null;
	let servedShownKey = '';
	// The channel the viewer themselves asked for, distinct from `stream`:
	// after a fallback the page and player adopt the served channel, so every
	// internal reopen (audio, reconnect) requests it and is answered with a
	// match — but the viewer's own ask is still unmet, and the standing
	// explanation must not vanish on an audio toggle. null until a request is
	// betrayed or the viewer picks; goToStream() is what changes their mind.
	let wantedCh = null;
	// Per channel too: videoN.bitrate, for the toast's "back to configured".
	let cfgKbps = [0, 0];
	// WebRTC takes ?stream= as a preference, not an order: the camera can
	// serve the other channel — a codec its negotiation can give this
	// browser, or a daemon fault (majestic#299 arrived as "Main selected,
	// Sub displayed" with nothing on the page admitting it). The radios say
	// what was asked; when the picture is recognisably the other channel's,
	// the chip says what actually arrived. Only when both sizes are known
	// and the frame matches the other channel exactly — a camera with unset
	// (sensor-native) sizes claims nothing rather than guessing. MSE needs
	// none of this: /ws/video serves the number it is given or nothing.
	// Which channel the picture actually belongs to: the requested one, unless
	// the frame provably matches the other channel exactly. The adaptation
	// toast reads this too — enc= describes the encoder of the channel being
	// SERVED, so on a served-channel mismatch the requested channel's
	// configured bitrate would be the wrong endpoint for its steps.
	function servedStream() {
		const asked = stream ? 1 : 0;
		// The camera said outright — no inference needed. Older daemons never
		// say, and everything below is the fallback for them.
		if (liveKind === 'webrtc' && servedCh !== null) return servedCh;
		// Deliberately `!== 'webrtc'` and not a list. The frame-size inference
		// exists because WebRTC's ?stream= is a preference the camera may not
		// honour; /ws/video serves the number it is given or nothing, so both
		// the MSE and the software-decode rungs get the exact channel they
		// asked for and must NOT be guessed about.
		if (liveKind !== 'webrtc' || !chipMedia) return asked;
		const want = sizeOf[asked], other = sizeOf[asked ? 0 : 1];
		if (!want || !other) return asked;
		const is = d => d.w === chipMedia.w && d.h === chipMedia.h;
		if (is(want) || !is(other)) return asked;
		return asked ? 0 : 1;
	}

	function servedNote() {
		const served = servedStream();
		// Auto's radios never say which channel it picked, so the chip
		// always does (#184) — but only when it can say truthfully. Over MSE
		// the subscription is exact, so `stream` IS the served channel; over
		// WebRTC a new majestic states the channel in the signalling (#240),
		// and only on an older one is the identity inferred from frame size —
		// where a size unset or the two channels sized alike proves nothing,
		// so the chip claims nothing rather than guessing. A manual pick
		// speaks only on a mismatch — the radio already names the intent, so
		// the chip only reports betrayal.
		if (autoOn) {
			if (liveKind === 'webrtc' && servedCh === null &&
				(!sizeOf[0] || !sizeOf[1] ||
				(sizeOf[0].w === sizeOf[1].w && sizeOf[0].h === sizeOf[1].h))) {
				return '';
			}
			return served === 0 ? ' · Main stream' : ' · Sub stream';
		}
		if (served === (stream ? 1 : 0)) return '';
		return served === 0 ? ' · Main stream' : ' · Sub stream';
	}

	function setChip() {
		// The fallback owns the chip until a player takes the stage back.
		// chipMedia is cleared with it, so this is belt and braces — but the
		// bug it guards, a control repainting the chip with the codec of the
		// stream that failed, is exactly the one #274 photographed.
		if (!badge || !chipMedia || fellBack || holdingFallback) return;
		// WebRTC measures its own rate, MSE measures nothing so the configured
		// rate stands in — and software decode measures, which is the entire
		// point of that rung. Leaving it on the configured rate would make the
		// chip claim 25 fps while the client managed 9, in exactly the case
		// this exists to expose.
		const fps = liveKind === 'mse' ? cfgFps[stream ? 1 : 0] : chipFps;
		// The scale the picture is drawn at, because Fill covers the window by
		// enlarging a stream smaller than the screen — a 1080p main on a 1440p
		// monitor is 133%, the substream far more — and a soft picture with no
		// number beside it reads as a soft camera. 1:1 is the one that never
		// has to be explained. Absent where the module is (no zoom, no scale),
		// which is also the bare-vm case the tests run.
		const pct = window.MajesticZoom ? window.MajesticZoom.scalePct() : 0;
		badge.textContent = (chipMedia.codec || '').toUpperCase() + ' ' +
			chipMedia.w + '×' + chipMedia.h +
			(fps ? ' · ' + Math.round(fps) + ' fps' : '') +
			(pct ? ' · ' + pct + '%' : '') +
			servedNote();
		// Its height is what the toast stack hangs off, and a caption that wraps
		// to a second line has just changed it. Its WIDTH decides nothing about
		// placement any more (#302).
		if (window.MajesticZoom) window.MajesticZoom.refresh();
	}

	// The served-channel message: why the channel the viewer picked is not the
	// one playing. Unlike the adaptation toast it does not time out — the
	// mismatch is a standing condition, not a moment — so it stays until
	// dismissed, until the cause goes away, or until the viewer changes
	// something (stream, transport) that makes it stale.
	const streamName = (n) => n === 0 ? 'Main stream' : 'Sub stream';

	// One message slot, two authors. The served-channel mismatch and the
	// fallback are both standing conditions rather than moments, and they
	// cannot be true at once — a mismatch needs a session playing, the
	// fallback means there is none — so they share the element. Who wrote it
	// is tracked all the same, or "a player is back on screen" would wipe a
	// served message belonging to that very player.
	let msgOwner = null;
	function showStageMsg(owner, text) {
		if (!servedEl || !servedWhy) return;
		msgOwner = owner;
		servedWhy.textContent = text;
		servedEl.hidden = false;
	}
	function hideStageMsg(owner) {
		if (owner && msgOwner !== owner) return;
		msgOwner = null;
		if (servedEl) servedEl.hidden = true;
	}
	function hideServedMsg() { hideStageMsg('served'); }

	// Nobody asked for software decoding — the chain chose it after the browser
	// refused the stream — so the page owes the viewer the fact, in the slot
	// that already carries standing conditions. It is said once, and upgraded
	// in place if the client turns out not to keep up.
	//
	// The "cannot keep up" test is the DROP COUNT and how far behind the
	// camera we are, never achieved-versus-configured fps: a VBR encoder on a
	// quiet scene legitimately sends 12 frames where 30 were configured, and
	// grading on that would accuse the client of a fault the camera committed.
	let swNoteKey = '';
	function softwareNote(s) {
		// A PROPORTION, and a standing delay — not "has ever dropped a frame".
		// A drop or two while the first GOP is found is not a client that
		// cannot cope, and latching the accusation on one of them would be the
		// same unfairness as grading on configured fps.
		const seen = s.framesDecoded + s.framesDropped;
		const behind = s.queuedMs > 400 ||
			(seen > 60 && s.framesDropped / seen > 0.1);
		const key = behind ? 'behind' : 'plain';
		if (key === swNoteKey) return;
		// Never re-raise a message the viewer dismissed, unless the news
		// actually changed — going from coping to not coping is news.
		if (swNoteKey && key === 'plain') return;
		swNoteKey = key;
		showStageMsg('software',
			behind
				? 'This browser can’t decode H.265, so the page is decoding it in ' +
					'software — and cannot keep up at this size. Try the Sub stream.'
				: 'This browser can’t decode H.265, so the page is decoding it in ' +
					'software.');
	}

	function showServedMsg(info) {
		const req = streamName(info.requested), got = streamName(info.channel);
		// The page words the sentence; the camera only names the cause. An
		// unknown code from a future daemon still gets an honest generic line.
		showStageMsg('served',
			info.reason === 'unavailable'
				? req + ' isn’t available right now — showing ' +
					got + ' instead.'
			: info.reason === 'undecodable'
				? 'This browser’s WebRTC can’t decode the ' + req +
					'’s format — showing ' + got + ' instead.'
			: 'The camera couldn’t serve the ' + req +
				' — showing ' + got + ' instead.');
	}

	// What a `served` reply from the camera does to this page: the chip, the
	// adaptation baseline (through servedStream()), and — on a mismatch with
	// an explicit pick — the radios and the message. The radios are moved by
	// writing .checked, which fires no change event: goToStream() must not
	// re-enter (it would cut the session that just told us this), and the
	// remembered preference must stay the viewer's own — a daemon fallback is
	// not a choice, and next page load should ask for their channel again.
	function applyServed(info) {
		servedCh = (info.channel === 0 || info.channel === 1)
			? info.channel : null;
		const mismatch = servedCh !== null && info.requested !== null &&
			info.channel !== info.requested;
		if (!mismatch) {
			// A match the viewer never asked for is not good news: a reopen
			// inside a fallen-back session requests the adopted channel and
			// is answered with it, while the viewer's own ask stands unmet.
			// Leave the explanation exactly as it is — up if it was up,
			// dismissed if they dismissed it.
			if (wantedCh !== null && servedCh !== null &&
				servedCh !== wantedCh) {
				setChip();
				return;
			}
			// Served as the viewer asked (or nothing was asked): any
			// standing message describes a mismatch that no longer exists.
			servedShownKey = '';
			hideServedMsg();
			setChip();
			return;
		}
		// The betrayed ask, remembered past the adoption below — the daemon
		// echoes exactly what this page requested.
		wantedCh = info.requested;
		if (!autoOn) {
			// The controls tell the truth: the session — player included, it
			// adopted the channel itself — is on servedCh, so the page and
			// the radios follow. The viewer's original radio is now
			// genuinely unchecked, which is what makes re-picking it a real
			// change event and a real renegotiation.
			stream = servedCh;
			if (s0) s0.checked = servedCh === 0;
			if (s1) s1.checked = servedCh === 1;
			const key = info.requested + '>' + info.channel + ':' + info.reason;
			if (key !== servedShownKey) {
				servedShownKey = key;
				showServedMsg(info);
			}
		}
		// In Auto the radios stay Auto's and no message shows: no explicit
		// request was betrayed, and the chip (which in Auto always names the
		// channel) is the disclosure. Auto's own `stream` is left alone so
		// autoApply()'s want === stream comparison keeps meaning "nothing to
		// do" rather than oscillating against the camera's fallback.
		setChip();
	}
	// Talkback is deliberately NOT carried across a transport switch or a
	// reattach. Everything else here is a preference; this one holds a live
	// microphone, and silently reopening it because the page rebuilt a player
	// is not a thing to do on a user's behalf.
	let talkbackConfigured = false;
	// Set once the Main/Sub control has been touched, so a slow config answer
	// cannot undo it.
	let userPickedStream = false;
	let audioConfigured = false;

	// KNOWN GAP, not a guarded case. There is no generation stamp on an
	// attachment, so a callback from a player that has been superseded is
	// interpreted as if the current one had sent it. Two ways in, neither
	// hypothetical:
	//
	// A player can report 'fallback' from inside attach() — MajesticWebRTC does
	// exactly that when RTCPeerConnection or addTransceiver throws — so the
	// handler runs, attaches MSE, and then the outer `player = impl.attach(…)`
	// assignment completes and overwrites the working MSE player with the dead
	// WebRTC façade nobody can now destroy.
	//
	// And a destroyed player is not a silent one. WebRTC's createOffer and
	// getStats continuations settle after close, so a transport switched away
	// from can still call onState and, seeing a `usingWebRTC` that has since
	// flipped, hide a video that is playing perfectly well.
	//
	// A `let attachSeq = 0` sat here under a comment written as though the
	// guard existed; it was never incremented and never read. The variable is
	// gone rather than the note, because the hazards are real — but nothing
	// here should be read as covering them.

	// Whether to offer the audio control at all: the camera has to have audio
	// configured and this transport has to be able to carry it. MSE can only
	// when the browser decodes a codec majestic can produce, so the answer
	// changes with the transport and is asked again on every attach.
	function syncAudioCtl() {
		if (!audioCtl) return;
		audioCtl.hidden = !(audioConfigured && player && player.audioSupported());
	}

	// Talkback needs three things at once, and each of them can be absent on
	// its own: the camera configured to play received audio, a transport that
	// carries a direction MSE has no concept of, and a secure context — a
	// browser hands over no microphone on plain HTTP, so the button would ask
	// for something it can never get.
	function syncTalkCtl() {
		if (!talkCtl) return;
		const ok = talkbackConfigured && player && player.micSupported();
		talkCtl.hidden = !ok;
		// Put the control back to rest, every time. A player destroyed while
		// its permission prompt was still up never reports an ending — the
		// grant lands in a closed player, which releases it silently — so
		// anything left over from 'asking' has to be cleared here or the
		// button stays disabled on "Asking…" until the page is reloaded.
		if (talk) { talk.checked = false; talk.disabled = false; }
		if (talkTxt) talkTxt.textContent = 'Talk';
		if (talkLbl) talkLbl.title = TALK_TITLE;
	}

	// The stats panel follows the transport rather than the person: MSE has
	// none of these numbers, so the button would open an empty box. The
	// checkbox keeps the person's answer across a transport switch, so the
	// panel has to come back with it rather than needing a second click.
	// Both transports have a story to tell now — MSE measures its own shape
	// (buffer depth, stalls, delivered rate) and the camera-side sections
	// come off /metrics either way — so the control follows only the person.
	function syncStatsCtl() {
		if (statsCtl) statsCtl.hidden = false;
		if (statsBox) {
			statsBox.hidden = !(statsBtn && statsBtn.checked);
			// The panel module renders its charts only while someone can see
			// them, so it is told when that changes. Guarded like every
			// window.Majestic* module: its file is not loaded under the tests.
			if (window.MajesticStats) window.MajesticStats.setOpen(!statsBox.hidden);
		}
	}

	// Rebuilt rather than mutated when the transport changes: the two players
	// own different machinery, and the state worth carrying over is three
	// values.
	// Apply the preferences a fresh player does not know about, and put the
	// controls into the state it is actually in.
	function settle() {
		if (!player) return;
		// No setAudio() here: the player was opened with it. Calling it now
		// would be a no-op at best and a renegotiation at worst.
		// The measured fps belonged to the session that just ended; the next
		// stats tick refills it, and until then the chip claims nothing.
		chipFps = 0;
		player.setVolume(vol);
		// The toast's baseline belongs to a WebRTC session; MSE feeds it
		// nothing, so a stale baseline (and a toast still standing) would
		// describe a session that is gone. Back on WebRTC it re-adopts from
		// the first tick rather than announcing whatever moved while away.
		if (window.MajesticAdapt && liveKind !== 'webrtc') window.MajesticAdapt.reset();
		// The stats panel's deltas belong to the session that just ended —
		// differencing a new session's counters against them would print one
		// tick of nonsense rates.
		if (window.MajesticStats) window.MajesticStats.reset();
		// Same for the served-channel answer and its message: both belong to
		// a WebRTC session. MSE serves the number it is given or nothing.
		// The software-decode disclosure belongs to a software-decode session.
		if (liveKind !== 'wasm') { swNoteKey = ''; hideStageMsg('software'); }
		if (liveKind !== 'webrtc') {
			servedCh = null;
			servedShownKey = '';
			wantedCh = null;
			hideServedMsg();
		}
		syncAudioCtl();
		// The outgoing player's destroy() released the microphone, so talkback
		// comes back up off whatever the new one is doing.
		syncTalkCtl();
		syncStatsCtl();
		// Back on WebRTC, the toggle's tooltip goes back to the standing
		// explanation: a failure wrote its reason there, and leaving it would
		// keep complaining about a session that is long over.
		if (transportLbl && liveKind === 'webrtc') transportLbl.title = TRANSPORT_TITLE;
	}

	// The swap itself lives in preview-swap.js — two elements, a trial that
	// costs the viewer nothing until it works. Everything below is what this
	// page does about the outcome, which is the part the settings panel does
	// differently.
	const swap = MajesticSwap({
		// Resolved on every use, never stored: the MSE player replaces its
		// element on each reconnect, so a node captured here would be detached
		// within a session and every show/hide would write to nothing.
		// Four elements, two slots. The kind decides which pair, because
		// software decode paints a canvas and the other two drive a video.
		elements: [
			(kind) => $(kind === 'wasm' ? '#live-canvas' : '#live-video'),
			(kind) => $(kind === 'wasm' ? '#live-canvas-b' : '#live-video-b'),
		],
		// audio and volume go in at attach rather than after promotion.
		// Applying them later means renegotiating a session that has just
		// proved itself, which blanks the picture for anyone who was listening
		// — the flicker this whole change removes, reintroduced at the last
		// step.
		open: (kind, el, id, onState) => MajesticVideoImpl(kind).attach(
			el, Object.assign(
				{ stream: stream, iceServers: () => ice,
					audio: audioOn, volume: vol },
				handlersFor(id, onState))),
		onPromoted: (kind, proven) => {
			player = swap.player();
			liveKind = kind;
			liveEl = swap.element();
			// From what is playing rather than from what was clicked: a retry
			// out of the fallback starts the chain from the preferred
			// transport without anyone having touched this group, and it was
			// left with nothing lit.
			// Software decode rides the MSE transport's socket, so MSE is what
			// is carrying the picture and MSE is what stays lit. Leaving the
			// group dark would collide with the meaning #280 gave it — neither
			// transport carrying anything — and would make a press of either
			// radio tear down a working session.
			reflectTransport(kind === 'wasm' ? 'mse' : kind);
			// The idle pair belonging to the OTHER kind is hidden by nobody:
			// the swap only ever touches the slot it is using, so an empty
			// <video> sits visible underneath a canvas that is painting over
			// it. That is harmless only because the canvas is opaque and later
			// in DOM order, which is not a thing to rely on.
			hideOtherKind(kind);
			settle();
			// Only when this promotion means a picture. Holding the fallback,
			// an unproven one is just the swap saying it had nothing of its
			// own in the way — and showing the empty video element for it
			// would take away the picture the viewer still has.
			if (proven || !holdingFallback) showVideo();
		},
		// A trial was dropped and the screen is untouched. All that changes is
		// the toggle, which has to come back up carrying the reason.
		onFailed: (kind, why, permanent) => {
			// The trial is gone and the live player is whatever it was. The
			// toggle has to describe that, not the transport that just failed
			// — including when the failure was MSE and WebRTC is still playing,
			// where leaving it unchecked would report the opposite of the truth
			// and make the stored preference retry the failure next load.
			//
			// playing(), not kind(): the question is whether WebRTC is still
			// carrying the picture, and a retired player occupies the live
			// slot with a frozen frame while carrying nothing. Asked the wider
			// question, an MSE failure arriving after WebRTC had already given
			// up took this branch on the way to the end of the chain — and
			// wrote the viewer's PERMANENT choice from a failure path,
			// erasing the demotion the WebRTC refusal had recorded a moment
			// earlier. showFallback() unlights both radios straight after, so
			// nothing on screen said so; the storage was wrong for good (#269).
			if (kind !== 'webrtc') {
				if (swap.playing() === 'webrtc') {
					reflectTransport('webrtc');
					rememberTransport('webrtc');
				}
				return;
			}
			reflectTransport('mse');
			// The reason first, because it is the news, then the standing
			// explanation — the tooltip is the only place either of them lives.
			if (transportLbl) {
				transportLbl.title =
					'WebRTC: ' + (why || 'unavailable') + '\n\n' + TRANSPORT_TITLE;
			}
			// 'busy' says the camera is full, which will not be true for long.
			// Only a real refusal is worth remembering, and even that expires.
			if (permanent) rememberDemotion();
		},
		// Nothing left on screen worth keeping. Try the other transport — from
		// WebRTC that means MSE, which plays what this browser's decoder takes
		// rather than what its WebRTC stack will negotiate, a strictly larger
		// set — and MJPEG if that already was the other transport.
		onExhausted: (kind, detail) => {
			player = null;
			nextRung(kind, detail);
		},
		onLive: (s, d) => {
			if (s === 'playing') showVideo();
			else if (s === 'nosignal') showNoSignal();
			// Through the chain, not straight to the floor. This is the path a
			// first attach takes — it is promoted immediately, so its giving up
			// arrives here rather than as a dropped trial — and sending it
			// directly to showFallback() skipped every rung below the one that
			// failed.
			else if (s === 'mjpeg') { swap.retire(); nextRung(liveKind, d); }
			else if (s === 'fallback' || s === 'busy') {
				// The live player gave up mid-session. Staged like any other
				// switch, so its last frame stays until the replacement has one
				// of its own.
				// `=== 'webrtc'`, never `!== 'mse'`: a software-decode session
				// reporting `fallback` has already been reached THROUGH both
				// transports failing, so re-running them would loop.
				if (liveKind === 'webrtc') {
					reflectTransport('mse');
					if (transportLbl) {
						transportLbl.title = 'WebRTC: ' + (d || 'unavailable') +
							'\n\n' + TRANSPORT_TITLE;
					}
					if (s === 'fallback') rememberDemotion();
					swap.retire();
					attachPlayer('mse');
				} else {
					showFallback(d);
				}
			}
			// Not while the fallback picture is being held: these describe the
			// attempt, and the chip has to go on describing the stage.
			else if (badge && !holdingFallback) {
				badge.textContent = (s === 'error') ? 'reconnecting…' : s + '…';
			}
		},
	});

	const MajesticVideoImpl = (kind) =>
		kind === 'webrtc' ? MajesticWebRTC
		: kind === 'wasm' ? window.MajesticWasm
		: MajesticVideo;

	function attachPlayer(kind) {
		// Any fresh attach supersedes a pending software-rung retry: it belongs
		// to a session that is being replaced, and firing it now would stage a
		// wasm player over the new one.
		wasmGen++;
		cancelWasmRetry();
		swap.start(kind === true ? 'webrtc' : kind === false ? 'mse' : kind);
	}

	// The chain, as an ordered walk rather than the pair of `kind === 'webrtc'`
	// tests it used to be:
	//
	//     WebRTC -> MSE -> [software decode] -> MJPEG -> note
	//
	// The third rung is not a transport and gets no radio. It is the same
	// /ws/video bytes the MSE player just failed on, decoded in WebAssembly
	// instead of by the browser — so the picker goes on naming the transport
	// exactly once, and a codec problem never touches the viewer's remembered
	// preference.
	function nextRung(kind, detail) {
		// A channel change can change the CODEC, and the failure that put us on
		// this rung was about the channel we have just left. So this is not the
		// chain running out — it is a different question, asked again from the
		// top: an H.264 substream may well play over WebRTC or MSE natively,
		// and falling to MJPEG here would hand the viewer the worst option
		// available for a stream the browser can decode perfectly.
		//
		// It cannot loop: the rung only stands down for a codec it does not
		// handle, and if the new one is refused too the reason will name that
		// codec, which the gate below rejects.
		if (String(detail || '').split(' ')[0] === 'codec-changed') {
			attachPlayer(wantWebRTC());
			return;
		}
		if (kind === 'webrtc') { attachPlayer('mse'); return; }
		if (kind === 'mse' && MajesticTransport.softwareRungFor(detail)) {
			attachPlayer('wasm');
			return;
		}
		// MSE gave up without a codec verdict — the socket would not stay open
		// ('unreachable'), so the browser never saw what the stream is. If the
		// config says this channel is a codec the software decoder handles, let
		// its worker try its own socket before falling to MJPEG; on a flaky or
		// remote link that has kept the software decoder working moments before,
		// dropping to MJPEG here strands the viewer on the worst option (#288).
		if (kind === 'mse' &&
			MajesticTransport.softwareRungForCodec(detail, cfgCodec[stream ? 1 : 0])) {
			attachPlayer('wasm');
			return;
		}
		// The software rung itself dropped its socket. A current worker has
		// already retried six times before saying so; an older pinned one gave
		// up on the first drop. Either way, retry the rung a bounded few times
		// before MJPEG rather than ending a working H.265 preview on one blip
		// (#288). Reset by a picture (showVideo); terminates on anything but a
		// socket drop, so it cannot loop.
		if (kind === 'wasm' && String(detail || '').split(' ')[0] === 'unreachable' &&
			wasmRetries < WASM_MAX_RETRIES) {
			wasmRetries++;
			// The caller has already retired the live player (or it was a failed
			// trial), so its last frame stays on the stage through the wait
			// rather than blanking it — the same picture-holding rule as a
			// transport switch. Guarded by the generation captured now: a channel
			// or transport change in the meantime bumps it and this does nothing.
			cancelWasmRetry();
			const retryGen = wasmGen;
			wasmRetryTimer = setTimeout(function () {
				wasmRetryTimer = null;
				if (wasmGen === retryGen && fellBack === null) attachPlayer('wasm');
			}, WASM_RETRY_MS * wasmRetries);
			return;
		}
		showFallback(detail);
	}


	// The page's own callbacks, all of which belong to the player on screen: a
	// trial has no badge, no audio control and no talkback button to report to.
	// onState is the swap's, unchanged — it decides what a trial's states mean.
	//
	// What the codec callback reports, applied to the chip and to the view
	// rule. The stage no longer reserves the stream's shape — it is the window
	// under the navbar and its size is the page's, not the stream's — so the
	// only thing the frame size decides here is how preview-zoom.js lays the
	// picture out inside it. Guarded because this file is executed in a bare vm
	// by two of the tests, and because the module is one <script> the page can
	// be served without: with no module the media keep the stylesheet's
	// `inset: 0` and letterbox, which is Fit.
	function applyMedia(m) {
		chipMedia = m;
		if (window.MajesticZoom) window.MajesticZoom.setFrame(m.w, m.h);
		setChip();
	}

	function handlersFor(id, onState) {
		// "Is this attachment the one the page is showing" — which is not the
		// same question as "has the swap made it live". A retry out of the
		// fallback is promoted unproven, because the swap had nothing of its
		// own in the way, while the stage still holds the MJPEG picture from
		// the session before it. Everything below belongs to whatever is on
		// screen, so during that hold this attachment owns nothing yet: its
		// codec and its served-channel answer are held exactly as a trial's
		// are, and adopted by the onState handler at the moment showVideo()
		// hands the stage over.
		//
		// Without the second clause a retry that never produced a frame could
		// move the radios to the camera's served channel and replace the
		// fallback's explanation with a mismatch toast, announcing a switch to
		// a stream nobody was being shown — over an MJPEG picture belonging to
		// a session that had already died.
		const isLive = () => swap.isLive(id) && !holdingFallback;
		// The MSE player reports its codec once, from the init message — which
		// for a trial arrives BEFORE it is promoted, when isLive() is still
		// false, and it never reports again. Held here and adopted the moment
		// this attachment goes live, or a WebRTC→MSE switch would keep the
		// old transport's dimensions and fps on the chip for ever (WebRTC
		// self-heals through its per-second stats; MSE has no such path).
		let heldMedia = null;
		// The camera's served-channel answer arrives right after the SDP
		// answer — for a trial, well before promotion. Held for the same
		// reason heldMedia is: moving the radios for a session that may yet
		// be thrown away would announce a switch that never happened.
		let heldServed = null;
		return {
			onState: (s, d) => {
				onState(s, d);
				// After the swap has judged the state: 'playing' is what
				// promotes a trial, so this is the first moment isLive() can
				// have flipped.
				if (heldMedia && isLive()) {
					applyMedia(heldMedia);
					heldMedia = null;
				}
				if (heldServed && isLive()) {
					applyServed(heldServed);
					heldServed = null;
				}
			},
			onCodec: (codec, cs, w, h) => {
				const m = { codec: codec, w: w, h: h };
				if (!isLive()) { heldMedia = m; return; }
				applyMedia(m);
			},
			onServed: (info) => {
				if (!isLive()) { heldServed = info; return; }
				applyServed(info);
			},
			// null means we asked for audio and the camera had none to give (mic
			// off or not producing). Reflect that on the control rather than
			// leaving the user staring at an unmute button that does nothing.
			onAudio: (codec) => {
				if (!isLive() || !mute) return;
				if (mute.checked && !codec) {
					muteTxt.textContent = 'No audio';
					mute.checked = false;
					audioOn = false;
					if (volCtl) volCtl.disabled = true;
				}
			},
			// 'asking' while the browser's permission prompt is up, 'on' once
			// the camera has accepted the direction, 'off' for every way it
			// ends — refused, unplugged, revoked, or declined by a camera with
			// audio.outputEnabled off. The reason rides along and goes in the
			// tooltip, which is the only place it lives.
			// Four states, and the middle one earns its place: 'asking' while
			// the browser's prompt is up, 'live' once the microphone is
			// capturing but the camera has not answered yet, 'on' when it has
			// accepted, 'off' for every ending. Reporting 'on' at the moment
			// of capture would say "Talking" over a session that has not
			// offered the track yet, and might still be refused.
			//
			// 'live' leaves the button enabled, unlike 'asking': the
			// microphone is running by then, and a control that cannot stop a
			// running microphone is the wrong control.
			onMic: (state, why) => {
				if (!isLive() || !talk) return;
				talk.checked = state === 'on' || state === 'live';
				talk.disabled = state === 'asking';
				if (talkTxt) {
					talkTxt.textContent = state === 'asking' ? 'Asking…'
						: state === 'live' ? 'Connecting…'
						: state === 'on' ? 'Talking' : 'Talk';
				}
				if (talkLbl) talkLbl.title = why ? why + '\n\n' + TALK_TITLE : TALK_TITLE;
				// Only once the camera has accepted. Talking opens its audio
				// too — it refuses a one-way audio section — so the listen
				// control follows what was negotiated rather than what was
				// asked for.
				if (state === 'on' && mute && !mute.checked) {
					mute.checked = true;
					audioOn = true;
					muteTxt.textContent = 'Listening';
					if (volCtl) volCtl.disabled = false;
				}
			},
			onStats: (s) => {
				if (!isLive()) return;
				if (s.transport === 'wasm') {
					softwareNote(s);
					// Sustained software playback resets the retry budget so the
					// NEXT drop gets a fresh ladder — gated on frames actually
					// decoded, not the codec announcement, so a decoder that
					// announces its codec and immediately drops still exhausts to
					// MJPEG rather than resetting on every attempt.
					if ((s.framesDecoded | 0) >= WASM_HEALTHY_FRAMES) wasmRetries = 0;
				}
				// The chip rides every tick, not just when the panel is open —
				// this is where its fps comes from, and a fresh write also
				// heals it after a transient "reconnecting…" state. The panel
				// is filled only while someone is looking at it.
				if (s.width) {
					chipFps = s.fps || 0;
					chipMedia = { codec: s.codec || (chipMedia && chipMedia.codec) || '',
						w: s.width, h: s.height };
					setChip();
				}
				// The panel differences cumulative counters itself, so it is
				// fed every tick whether or not it is open — a panel opened
				// mid-session then starts from live history, not from zero.
				if (window.MajesticStats) {
					const ch = servedStream();
					window.MajesticStats.tick(Object.assign({}, s, {
						configuredKbps: cfgKbps[ch],
						configuredFps: cfgFps[ch],
						channel: ch,
						transport: s.transport || 'webrtc',
					}));
				}
				// The adaptation toast, fed the camera's own view of the
				// shared encoder. Guarded: preview-adapt.js is its own file,
				// and an older majestic sends no enc= at all — either way
				// nothing here should ever invent a rate change. The channel
				// is the SERVED one, not the requested one: enc= describes
				// the encoder actually feeding this picture, and the module
				// re-adopts its baseline whenever the channel changes under
				// it — a stream switch, or a reconnect that negotiated the
				// other channel.
				if (window.MajesticAdapt && s.cam && s.cam.enc !== undefined) {
					const ch = servedStream();
					window.MajesticAdapt.tick({
						enc: parseInt(s.cam.enc, 10) || 0,
						remb: parseInt(s.cam.remb, 10) || 0,
						configured: cfgKbps[ch],
						channel: ch,
					});
				}
			},
		};
	}

	// Start on the substream, which is the convention this equipment is built
	// around: the main channel carries the best picture the sensor can give and
	// is what an NVR or the SD card records, while the substream exists to be
	// watched over whatever link happens to be available. Previewing the
	// channel that is being recorded, and then adapting its bitrate down to
	// suit one browser, is the wrong way round.
	//
	// It also settles most of what a bitrate opt-out would have been for: the
	// adaptation now lands on the channel whose job is preview. Main is one
	// click away for anyone who wants to look closely, and the note under the
	// toggle says what that costs.
	//
	// Gated on video1.enabled rather than assumed, because the two transports
	// disagree about what a missing stream means. WebRTC treats ?stream=N as a
	// preference and falls back to a channel it can serve; /ws/video subscribes
	// to whatever number it is given and simply delivers nothing, which reads
	// as "no signal" rather than as a misconfiguration.
	// ...but not at the cost of starting at all. mjConfig() is memoised and the
	// night-mode controls asked for it before this ran, so in practice the
	// answer is already here. On the link this default exists for it might not
	// be, and /api/v1/config.json has no timeout of its own — a request that
	// hangs would leave the page blank for as long as the tab is open, which is
	// a worse failure than starting on the wrong channel.
	//
	// So: attach as soon as we know, or after this deadline regardless.
	const CONFIG_WAIT_MS = 1500;

	// Whether the deadline won and we picked a stream without being told.
	let attachedBlind = false;

	// Which stream best fits the box this player is drawn in.
	//
	// Measured on the CONTAINER'S WIDTH, and this is the part that is easy to
	// get wrong: the video element is `width: 100%` with no height constraint,
	// so its height is the playing stream's aspect ratio. Measuring the
	// element's area therefore feeds the decision its own result — at 800px
	// wide, 1280x720 renders 800x450 and points at the 704x576 substream, which
	// renders 800x655 and points back at the main stream, once per second, for
	// ever.
	//
	// With a width-constrained box the arithmetic collapses anyway: a stream is
	// large enough exactly when its own width is, because the rendered height
	// scales with the same factor as the rendered width. So width decides, and
	// area only breaks ties — which keeps the reporter's point, that one
	// dimension must not be trusted alone, where it still applies.
	//
	// CSS pixels rather than device pixels, deliberately. On a 2x display the
	// larger stream is sharper, but this exists for links that cannot carry the
	// larger stream at all, and doubling the demand on every phone is the wrong
	// side to err on.
	//
	// Nearest at or above the box, else the largest below it — the reporter's
	// rule, and the right way round: scaling a bigger picture down loses
	// nothing visible, scaling a smaller one up does.
	function autoPick() {
		// The stage, not the column: the viewport clamp can leave the stage
		// narrower than #mj-player, and the stage's width is what the picture
		// is actually drawn at.
		const box = $('#mj-stage') || $('#mj-player');
		const want = box ? box.clientWidth : 0;
		if (!want) return null;   // not laid out yet; ask again later
		const options = [];
		for (let n = 0; n < 2; n++) {
			if (n === 1 && !subAvailable) continue;
			// An unset size is not a missing channel — video0.size ships with no
			// default at all, and empty means "whatever the sensor gives",
			// which is the largest picture the camera has.
			const d = sizeOf[n];
			options.push({
				n: n,
				w: d ? d.w : Infinity,
				area: d ? d.w * d.h : Infinity,
			});
		}
		if (!options.length) return null;
		const atLeast = options.filter(o => o.w >= want);
		// Ties go to the later option, which is the substream: two channels the
		// same width cost the same to decode and the cheaper one to carry, and
		// area is what separates them when the widths match.
		if (atLeast.length) {
			return atLeast.reduce(
				(a, b) => (b.w < a.w || (b.w === a.w && b.area <= a.area) ? b : a)).n;
		}
		return options.reduce(
			(a, b) => (b.w > a.w || (b.w === a.w && b.area > a.area) ? b : a)).n;
	}

	// Act on it, subject to the rate limit. Called on resize and whenever the
	// numbers behind the decision change.
	function autoApply() {
		if (!autoOn) return;
		const want = autoPick();
		if (want === null || want === stream) return;
		const wait = AUTO_MIN_GAP_MS - (Date.now() - lastAutoAt);
		if (wait > 0) {
			// Not dropped, deferred: the size that triggered this is the size
			// it still is, and forgetting it would leave the wrong stream up
			// until the next time the window happened to move.
			clearTimeout(autoTimer);
			autoTimer = setTimeout(autoApply, wait);
			return;
		}
		lastAutoAt = Date.now();
		goToStream(want);
	}

	// Which channel to open on: what this browser last chose, or the substream.
	//
	// A remembered choice outranks the default but not reality — a browser that
	// picked Sub on a camera which has since lost video1 opens on Main rather
	// than on nothing. Returns true if the channel moved off Main.
	function chooseSub(cfg) {
		const remembered = MajesticTransport.chosenStream('preview');
		if (remembered === 'auto' && subAvailable) {
			autoOn = true;
			if (autoCtl) autoCtl.checked = true;
			const pick = autoPick();
			// A size the page cannot measure yet leaves Auto on the substream,
			// which is the default it would otherwise have had; the first
			// resize or the layout settling corrects it.
			stream = pick === null ? 1 : pick;
			return stream === 1;
		}
		const want = remembered === null ? 1 : remembered;
		if (want !== 1 || !subAvailable) {
			stream = 0;
			if (s0) s0.checked = true;
			return false;
		}
		stream = 1;
		if (s1) s1.checked = true;
		return true;
	}

	Promise.race([
		mjConfig(),
		new Promise(done => setTimeout(() => done(null), CONFIG_WAIT_MS)),
	]).then(cfg => {
		if (cfg) chooseSub(cfg); else attachedBlind = true;
		attachPlayer(wantWebRTC());
	});

	// If the deadline won, put it right when the answer turns up — but not if
	// the person watching has since chosen a stream themselves. Correcting a
	// default is helpful; overriding a decision is not.
	mjConfig().then(cfg => {
		if (!attachedBlind) return;
		// The stream, unless the person has since chosen one themselves:
		// correcting a default is helpful, overriding a decision is not.
		const moved = !userPickedStream && chooseSub(cfg);
		if (moved && player) player.setStream(stream);

		// The ICE list, unconditionally. A blind attach opened with an empty
		// one, and the getter is only read when a session opens — so without
		// this the first session runs on host candidates alone until something
		// else happens to reconnect it. Off-LAN that session cannot work: it
		// negotiates, carries nothing, and spends the full no-signal timeout
		// finding out, which is exactly the sequence that demotes a browser to
		// MSE. Skipped when setStream() has already reopened for the stream
		// change, and when there is nothing to apply.
		// Not while a trial is being judged: that trial is the viewer's own
		// choice in flight, and it was opened after `ice` was filled anyway, so
		// restarting WebRTC here would both undo their click and re-do work.
		if (!moved && player && !swap.trial() && liveKind === 'webrtc' && ice.length) {
			attachPlayer(true);
		}
	});

	if (transportW && transportM && transportGrp && webrtcAvailable) {
		transportGrp.hidden = false;
		// From the preference rather than from usingWebRTC, which the deferred
		// attach above has not set yet.
		reflectTransport(wantWebRTC() ? 'webrtc' : 'mse');
		// Out of a fallback these go through the retry, so the picture that is
		// on the stage is held for the attempt exactly as it is for a channel
		// press. Playing, they are an ordinary transport switch and the swap
		// protects the picture itself.
		transportW.addEventListener('change', () => {
			if (!transportW.checked) return;
			rememberTransport('webrtc');
			if (fellBack) { retryFromFallback(true); return; }
			attachPlayer(true);
		});
		transportM.addEventListener('change', () => {
			if (!transportM.checked) return;
			rememberTransport('mse');
			if (fellBack) { retryFromFallback(false); return; }
			attachPlayer(false);
		});
	}

	// Guarded because the first attach waits on the config fetch, and nothing
	// stops a fast set of fingers reaching these first.
	//
	// The flag is armed on click rather than on change, and that distinction is
	// the whole point of it: clicking the radio that is already selected fires
	// no change event, so someone who starts on Main and presses Main — because
	// that is the one they want — would otherwise look identical to someone who
	// pressed nothing, and a late config answer would move them to Sub. A click
	// is an expression of intent whether or not it alters anything.
	// Recorded on click for the same reason the flag is: pressing the radio that
	// is already selected is still an answer, and it is the one that has to be
	// remembered — someone whose camera crops video0, or whose substream is
	// sized nothing like the preview box, wants Main and should say so once
	// rather than on every page load.
	// Everything a channel change has to reach: the player on screen, any trial
	// being judged — a trial keeps the stream it was opened with, so otherwise
	// it would be promoted onto the channel the viewer had already left — and
	// the adaptation toast's baseline, which belongs to the channel being left.
	function goToStream(n) {
		// The viewer changed channel: a software-rung retry pending from the
		// channel being left must not fire onto the new one.
		wasmGen++;
		cancelWasmRetry();
		stream = n;
		// The two channels are two encoders; the baseline and any toast on
		// screen describe the one being left.
		if (window.MajesticAdapt) window.MajesticAdapt.reset();
		if (window.MajesticStats) window.MajesticStats.reset();
		// A deliberate change is the viewer changing their mind: it becomes
		// the new ask, invalidates the camera's last served answer, and
		// re-arms the message — the next session speaks for itself, and if
		// it falls back again that is news worth repeating.
		wantedCh = n;
		servedCh = null;
		servedShownKey = '';
		hideServedMsg();
		// Nothing is attached: the chain ran out and the stage is showing the
		// MJPEG fallback or the note. The pick is still a request worth
		// honouring — an H.264 substream plays in a browser that refused an
		// H.265 main, which is the camera in #274 — so it starts the chain
		// again rather than doing nothing at all. Before this it did nothing
		// visible and, on the fallback reached through onLive, called
		// setStream() on a stopped player, reopening its socket.
		if (fellBack) { retryFromFallback(); return; }
		if (player) player.setStream(n);
		const t = swap.trial();
		if (t) t.setStream(n);
		// On MSE the chip's fps is the configured rate, which is per channel.
		setChip();
	}
	if (s0) s0.addEventListener('change', () => { autoOn = false; goToStream(0); });
	if (s1) s1.addEventListener('change', () => { autoOn = false; goToStream(1); });
	if (autoCtl) autoCtl.addEventListener('change', () => {
		autoOn = autoCtl.checked;
		if (!autoOn) return;
		// Any standing mismatch message belonged to a manual pick; handing
		// the choice to Auto withdraws the request it was explaining.
		wantedCh = null;
		servedShownKey = '';
		hideServedMsg();
		// Acting immediately rather than waiting for a resize: the person just
		// asked for the best fit, and the window is already the size it is.
		lastAutoAt = 0;
		autoApply();
		// The chip's Auto label has to appear even when Auto's pick is the
		// stream already playing: that path changes nothing, so nothing else
		// would redraw the chip — and MSE gives it no later chance, since it
		// reports its codec only when a connection opens.
		setChip();
	});
	// Recorded on click rather than change: pressing the radio that is already
	// selected fires no change event and is still an answer — the one that has
	// to be remembered, for someone whose video0 is cropped or whose substream
	// is sized nothing like the preview box.
	//
	// That same silence is why the retry lives here too. Unlike the transport
	// group, these radios keep their selection through a fallback — they say
	// what was ASKED for, which is still true and is the channel the message
	// names ("can't decode the Main stream's H265 video"), where the transport
	// group says what is CARRYING the picture, which is nothing. So the
	// channel a viewer wants to retry is usually the one already lit, no
	// change event will ever come for it, and a retry that only hung off
	// goToStream() could be reached solely by picking a channel they did not
	// want. Auto has the same hole twice over: autoApply() returns before
	// goToStream() whenever its pick equals the current stream.
	//
	// Click runs before the activation behaviour fires change, so when the
	// radio does move the later goToStream() finds fellBack already cleared
	// and does the ordinary thing to the player this just attached.
	[s0, s1, autoCtl].forEach((el, n) => {
		if (el) el.addEventListener('click', () => {
			userPickedStream = true;
			MajesticTransport.chooseStream('preview', n === 2 ? 'auto' : n);
			if (!fellBack) return;
			if (n === 2) {
				autoOn = true;
				lastAutoAt = 0;
				const pick = autoPick();
				if (pick !== null) stream = pick;
				wantedCh = null;
			} else {
				autoOn = false;
				stream = n;
				wantedCh = n;
			}
			retryFromFallback();
		});
	});

	// Dismissing whatever is in the stage message slot. A click anywhere counts —
	// the × is a real button for the keyboard, but a toast small enough to
	// need aim is a toast that gets missed. stopPropagation for the same
	// reason preview-adapt.js does it: a tap on the stage toggles the control
	// bar, and dismissing a message should not also flip the chrome.
	if (servedEl) servedEl.addEventListener('click', (ev) => {
		if (ev && ev.stopPropagation) ev.stopPropagation();
		// Whatever is in the slot, not just a served message: the fallback
		// borrows the same element and a dismissal that checked the owner
		// would leave its sentence stuck on the picture for good.
		hideStageMsg();
	});

	// Follow the size, debounced — a drag fires continuously, and the rate limit
	// in autoApply() is what keeps the session from being cut more than once a
	// second even then.
	//
	// The element, not the window: this page is responsive, so a column
	// reflowing or something above it changing height resizes the player
	// without the viewport moving at all. Watching only the window would leave
	// Auto on the wrong stream until the viewer happened to drag the browser.
	// The window listener stays as the fallback where ResizeObserver does not.
	let resizeTimer = null;
	const onResize = () => {
		if (!autoOn) return;
		clearTimeout(resizeTimer);
		resizeTimer = setTimeout(autoApply, 250);
	};
	//
	// Watched on the stage, not on the video elements: the MSE player
	// replaces its element on every open and every reconnect, so an observer
	// attached to the nodes would be watching detached ones within a session —
	// the same trap the swap hit with stored element references. The stage is
	// never replaced, and it is also the element the viewport clamp resizes:
	// a height-only viewport change narrows the stage while #mj-player keeps
	// its width, so watching the parent would miss exactly those.
	const box = $('#mj-stage') || $('#mj-player');
	if (typeof ResizeObserver === 'function' && box) {
		try { new ResizeObserver(onResize).observe(box); } catch (e) {
			window.addEventListener('resize', onResize);
		}
	} else {
		window.addEventListener('resize', onResize);
	}

	// Audio: revealed only when the camera has it configured and the transport
	// in use can carry it — otherwise the button is a dead end.
	if (audioCtl && mute) {
		mjConfig().then(cfg => {
			audioConfigured = mjGet(cfg, 'audio.enabled') === true;
			syncAudioCtl();
		});
		mute.addEventListener('change', () => {
			const on = mute.checked;
			audioOn = on;
			if (!player) return;
			player.setAudio(on);
			muteTxt.textContent = on ? 'Listening' : 'Muted';
			if (volCtl) volCtl.disabled = !on;
		});
		if (volCtl) volCtl.addEventListener('input', () => {
			vol = volCtl.value / 100;
			// Kept even with no player yet: attachPlayer() applies it.
			if (player) player.setVolume(vol);
		});
	}

	// Talkback: the camera has to be configured to play what it receives.
	// audio.enabled alone is the microphone; outputEnabled is the speaker, and
	// this is the one that decides whether the far end has anywhere to put our
	// audio. A camera with it off answers the session without our direction and
	// the player reports that back through onMic.
	if (talkCtl && talk) {
		mjConfig().then(cfg => {
			talkbackConfigured = mjGet(cfg, 'audio.outputEnabled') === true;
			syncTalkCtl();
		});
		talk.addEventListener('change', () => {
			if (!player) { talk.checked = false; return; }
			// The player owns the answer, not the checkbox: a refused
			// permission or a camera that declines leaves this unchecked
			// again through onMic, and setting the label here would flash a
			// state that never happened.
			player.setMic(talk.checked);
		});
	}

	// The chip prints the scale, and the scale moves for reasons no player
	// event reports: a preset, a pinch, a window resize. Over MSE the codec is
	// reported once when the connection opens, so without this the percentage
	// would be the one the session started with for as long as it lasted.
	// (preview-zoom.js is loaded before this file so that it is here to ask.)
	if (window.MajesticZoom) window.MajesticZoom.onScale(setChip);

	if (statsBtn && statsBox) {
		// Through the same helper the transport switch uses, so "is the panel
		// showing" has one answer and not two that have to agree.
		statsBtn.addEventListener('change', syncStatsCtl);
	}
})();
